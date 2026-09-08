// api/orders.js
//
// GET  -> list orders for the caller's tenant (tenant_admin) or a specified
//         tenant (super_admin, via ?tenant_id=)
// PATCH -> update an order's status/eta; on accept, logs a mock SMS

import { supabaseAdmin, verifyAuth, resolveTenantId } from '../lib/auth-check.js';
import { confirmOrder } from '../lib/ordering.js';
import { runClaudeLoop, runOpenAiLoop } from '../lib/llm.js';

const ALLOWED_ORIGINS = ['https://reysan.ca'];
const GST_RATE = 0.05; // Alberta: 5% federal GST, no provincial sales tax

// Resolves a customer + their current session, given either an order_id or
// a customer_id directly — a customer can be in takeover before ever
// placing an order, so this can't always start from an order.
async function resolveCustomerContext({ order_id, customer_id }, tenantId) {
  if (customer_id) {
    const { data: customer, error } = await supabaseAdmin
      .from('customers')
      .select('id, name, phone, phone_verified, takeover_active, last_session_id')
      .eq('id', customer_id)
      .eq('tenant_id', tenantId)
      .single();
    if (error) throw new Error(error.message);
    return { customer, orderId: order_id || null, sessionId: customer.last_session_id };
  }

  const { data: order, error } = await supabaseAdmin
    .from('orders')
    .select('id, session_id, customer_id, customers(id, name, phone, phone_verified, takeover_active, last_session_id)')
    .eq('id', order_id)
    .eq('tenant_id', tenantId)
    .single();
  if (error) throw new Error(error.message);
  return { customer: order.customers, orderId: order.id, sessionId: order.session_id || order.customers.last_session_id };
}

// Merges chat_logs (the normal pre-takeover AI conversation, stored as
// question/answer pairs) with conversation_messages (takeover-era, one row
// per sender) into a single chronological view — staff shouldn't have to
// check two different places to see the whole conversation.
async function fetchMergedConversation(tenantId, sessionId, customerId) {
  if (!sessionId && !customerId) return [];

  let chatLogsQuery = supabaseAdmin.from('chat_logs').select('question, answer, created_at').eq('tenant_id', tenantId);
  chatLogsQuery = customerId ? chatLogsQuery.or(`customer_id.eq.${customerId},session_id.eq.${sessionId}`) : chatLogsQuery.eq('session_id', sessionId);
  const { data: turns } = await chatLogsQuery.order('created_at', { ascending: true });

  const fromChatLogs = (turns || []).flatMap((t) => [
    { sender: 'customer', message: t.question, created_at: t.created_at },
    { sender: 'ai', message: t.answer, created_at: t.created_at }
  ]);

  let liveQuery = supabaseAdmin.from('conversation_messages').select('sender, message, created_at').eq('tenant_id', tenantId);
  liveQuery = customerId ? liveQuery.or(`customer_id.eq.${customerId},session_id.eq.${sessionId}`) : liveQuery.eq('session_id', sessionId);
  const { data: liveMsgs } = await liveQuery.order('created_at', { ascending: true });

  return [...fromChatLogs, ...(liveMsgs || [])].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'GET, PATCH, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    return res.status(204).end();
  }

  const auth = await verifyAuth(req);
  if (auth.error) return res.status(auth.status).json({ error: auth.error });

  if (req.method === 'GET') {
    const resolved = resolveTenantId(auth, req.query.tenant_id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    // Full merged conversation for an order OR a bare customer (pre-order
    // takeover) — one call, one chronological view, no separate buttons.
    if (req.query.live_messages_for || req.query.live_messages_for_customer) {
      try {
        const ctx = await resolveCustomerContext(
          { order_id: req.query.live_messages_for, customer_id: req.query.live_messages_for_customer },
          resolved.tenantId
        );
        const messages = await fetchMergedConversation(resolved.tenantId, ctx.sessionId, ctx.customer.id);
        return res.status(200).json({
          messages,
          takeoverActive: ctx.customer?.takeover_active || false,
          customerId: ctx.customer?.id || null,
          customerName: ctx.customer?.name || null
        });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // Customers who explicitly asked for a real person — shown as an
    // urgent, always-visible alert regardless of whether they've ordered.
    if (req.query.wants_human === 'true') {
      const { data, error } = await supabaseAdmin
        .from('customers')
        .select('id, name, phone, takeover_active')
        .eq('tenant_id', resolved.tenantId)
        .eq('wants_human', true);
      if (error) return res.status(500).json({ error: error.message });
      return res.status(200).json({ customers: data });
    }

    // Summary report — completed/cancelled/no-show counts, revenue, and
    // top-selling items, for a given date range (from the person's own
    // local midnight-to-midnight, so it never has to guess a timezone).
    if (req.query.report === 'true') {
      const { date_from, date_to } = req.query;
      if (!date_from || !date_to) return res.status(400).json({ error: 'date_from and date_to are required' });

      const { data: rangeOrders, error: rangeErr } = await supabaseAdmin
        .from('orders')
        .select('status, items, total, created_at')
        .eq('tenant_id', resolved.tenantId)
        .gte('created_at', date_from)
        .lt('created_at', date_to);
      if (rangeErr) return res.status(500).json({ error: rangeErr.message });

      const completed = (rangeOrders || []).filter((o) => o.status === 'completed');
      const cancelled = (rangeOrders || []).filter((o) => o.status === 'cancelled');
      const noShow = (rangeOrders || []).filter((o) => o.status === 'no_show');
      const totalRevenue = completed.reduce((sum, o) => sum + Number(o.total || 0), 0);

      const itemCounts = {};
      completed.forEach((o) => {
        (o.items || []).forEach((i) => {
          itemCounts[i.name] = (itemCounts[i.name] || 0) + i.qty;
        });
      });
      const bestSellers = Object.entries(itemCounts)
        .map(([name, qty]) => ({ name, qty }))
        .sort((a, b) => b.qty - a.qty);

      return res.status(200).json({
        completed_count: completed.length,
        cancelled_count: cancelled.length,
        no_show_count: noShow.length,
        total_revenue: totalRevenue.toFixed(2),
        best_sellers: bestSellers
      });
    }

    // Per-item sales over time, bucketed by day/week/month/quarter/year —
    // only counts completed orders (actual finished sales).
    if (req.query.item_report === 'true') {
      const { item_name, date_from, date_to, granularity } = req.query;
      if (!item_name || !date_from || !date_to) return res.status(400).json({ error: 'item_name, date_from, and date_to are required' });

      const { data: rangeOrders, error: rangeErr } = await supabaseAdmin
        .from('orders')
        .select('items, created_at')
        .eq('tenant_id', resolved.tenantId)
        .eq('status', 'completed')
        .gte('created_at', date_from)
        .lt('created_at', date_to);
      if (rangeErr) return res.status(500).json({ error: rangeErr.message });

      const bucketKey = (dateStr) => {
        const d = new Date(dateStr);
        const g = granularity || 'day';
        if (g === 'week') {
          const jan1 = new Date(d.getFullYear(), 0, 1);
          const week = Math.ceil(((d - jan1) / 86400000 + jan1.getDay() + 1) / 7);
          return `${d.getFullYear()}-W${String(week).padStart(2, '0')}`;
        }
        if (g === 'month') return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        if (g === 'quarter') return `${d.getFullYear()}-Q${Math.floor(d.getMonth() / 3) + 1}`;
        if (g === 'year') return String(d.getFullYear());
        return d.toISOString().slice(0, 10);
      };

      const buckets = {};
      (rangeOrders || []).forEach((o) => {
        const match = (o.items || []).find((i) => i.name === item_name);
        if (!match) return;
        const key = bucketKey(o.created_at);
        buckets[key] = (buckets[key] || 0) + match.qty;
      });

      const series = Object.entries(buckets)
        .map(([period, qty]) => ({ period, qty }))
        .sort((a, b) => a.period.localeCompare(b.period));

      return res.status(200).json({ series, total: series.reduce((sum, s) => sum + s.qty, 0) });
    }

    // Optional day filter for reporting — date_from/date_to are ISO
    // timestamps computed client-side from the staff member's own local
    // midnight-to-midnight, so this never has to guess a timezone.
    let ordersQuery = supabaseAdmin
      .from('orders')
      .select('*, customers(id, name, phone, area_code_flag, phone_verified, banned)')
      .eq('tenant_id', resolved.tenantId)
      .order('created_at', { ascending: false });

    if (req.query.date_from && req.query.date_to) {
      ordersQuery = ordersQuery.gte('created_at', req.query.date_from).lt('created_at', req.query.date_to).limit(500);
    } else {
      ordersQuery = ordersQuery.limit(50);
    }

    const { data, error } = await ordersQuery;
    if (error) return res.status(500).json({ error: error.message });

    const { data: banned, error: bannedErr } = await supabaseAdmin
      .from('customers')
      .select('id, name, phone')
      .eq('tenant_id', resolved.tenantId)
      .eq('banned', true);
    if (bannedErr) return res.status(500).json({ error: bannedErr.message });

    return res.status(200).json({ orders: data, banned_customers: banned });
  }

  if (req.method === 'PATCH') {
    const {
      order_id, status, eta_minutes, needs_attention, attention_note, items,
      ban_customer_id, unban_customer_id, takeover_action, staff_message,
      takeover_customer_id, tenant_id
    } = req.body;
    const resolved = resolveTenantId(auth, tenant_id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    // Live takeover: staff pausing the AI, sending a manual message, or
    // handing control back (which triggers the AI to finalize the order
    // based on the full conversation, including what staff/customer agreed).
    // Keyed on the CUSTOMER, not the order — a customer can ask for a human
    // before ever placing one.
    if (takeover_action) {
      let ctx;
      try {
        ctx = await resolveCustomerContext({ order_id, customer_id: takeover_customer_id }, resolved.tenantId);
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
      if (!ctx.sessionId) return res.status(400).json({ error: 'No chat session found for this customer yet.' });

      if (takeover_action === 'start') {
        const { error } = await supabaseAdmin.from('customers').update({ takeover_active: true }).eq('id', ctx.customer.id);
        if (error) return res.status(500).json({ error: error.message });

        // Auto-notify the customer a real person has joined — staff
        // shouldn't have to remember to say this themselves every time.
        await supabaseAdmin.from('conversation_messages').insert({
          tenant_id: resolved.tenantId,
          session_id: ctx.sessionId,
          customer_id: ctx.customer.id,
          order_id: ctx.orderId,
          sender: 'staff',
          message: "👋 A team member has joined this chat to help you directly."
        });

        return res.status(200).json({ ok: true });
      }

      if (takeover_action === 'send') {
        if (!staff_message) return res.status(400).json({ error: 'staff_message is required' });
        const { error } = await supabaseAdmin.from('conversation_messages').insert({
          tenant_id: resolved.tenantId,
          session_id: ctx.sessionId,
          customer_id: ctx.customer.id,
          order_id: ctx.orderId,
          sender: 'staff',
          message: staff_message
        });
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
      }

      if (takeover_action === 'resume') {
        // A staff member directly chatting with this person IS the
        // verification — the OTP gate exists to protect the automated path
        // when no human is watching, not conversations staff are actively
        // supervising. Mark them verified so confirm_order doesn't block.
        await supabaseAdmin.from('customers').update({ takeover_active: false, wants_human: false, phone_verified: true }).eq('id', ctx.customer.id);

        const { data: tenantRow } = await supabaseAdmin.from('tenants').select('ai_provider').eq('id', resolved.tenantId).single();
        const provider = tenantRow?.ai_provider || 'claude';

        const fullConversation = await fetchMergedConversation(resolved.tenantId, ctx.sessionId, ctx.customer.id);
        const transcriptText = fullConversation.map((m) => `${m.sender.toUpperCase()}: ${m.message}`).join('\n');

        // A takeover doesn't always start from a specific order card (e.g.
        // "any real person here?" starts from the customer directly, no
        // order attached) — so never assume there's at most one order.
        // Fetch every open order and show the AI all of them with their
        // real ids, so it can correctly target whichever one the
        // conversation was actually about.
        const { data: openOrders } = await supabaseAdmin
          .from('orders')
          .select('id, order_number, items, total, status')
          .eq('customer_id', ctx.customer.id)
          .not('status', 'in', '(completed,cancelled)');

        let currentOrderText = 'No open orders exist yet for this customer.';
        if (openOrders && openOrders.length > 0) {
          currentOrderText = openOrders
            .map((o) => {
              const itemLines = o.items.map((i) => `  - ${i.qty}x ${i.name} ($${i.price} each)`).join('\n');
              return `Order #${o.order_number} (order_id: ${o.id}, status: ${o.status}) currently contains:\n${itemLines}\n  Current total: $${o.total}`;
            })
            .join('\n\n');
        }

        const FINALIZE_SYSTEM_PROMPT = `You are finalizing a food order after a staff member helped the customer during a live handoff.

Current order state (this is FACT, not something to guess from the conversation):
${currentOrderText}

Read the conversation below and figure out what the customer's order should be now.

CRITICAL: an item being MENTIONED — by you listing it as one of several options, or a menu lookup surfacing it — is NOT the same as the customer CHOOSING it. Only finalize items the customer explicitly selected in their own words ("I'll take the 10pc", "give me the 6-piece", "yes" in direct response to a single specific item you asked about). If you presented multiple options and the customer never picked one — went silent, said "idk", asked for a human before answering, or the conversation just moved on — that is NOT a decision, no matter which option was listed first or mentioned most. In that case, don't call confirm_order at all, even if it feels like "something" should be placed. When genuinely unsure whether a choice was actually made, treat it as not made.

If there's more than one open order listed above, figure out from the conversation WHICH one is being discussed and pass its order_id to confirm_order — never guess if it's ambiguous, and never assume it's the only one. If staff and customer agreed to ADD something, use find_menu_items to resolve it to a real item and price, then call confirm_order with that order's items PLUS the new one. If they agreed to REMOVE or REDUCE something FROM AN EXISTING ORDER, call confirm_order with that order's items minus that change — compute the new full list yourself starting from the current order state above, don't just guess a final quantity. If removing everything from an EXISTING order leaves zero items, call confirm_order with an empty items list — this correctly cancels that order. If there are NO open orders and the conversation clearly shows the customer choosing specific items, call confirm_order without an order_id to create one. If there are NO open orders AND nothing was actually, explicitly chosen — do NOT call confirm_order at all. Just write a short, friendly closing message instead, and if it's unclear what they wanted, ask rather than guess.

Never invent menu items or prices — always verify with find_menu_items first if an item is mentioned by name in the conversation and you don't already have its real id/price from the current order state above.

After calling confirm_order, your closing message MUST state the exact total from confirm_order's returned result — never compute or restate a total from your own reading of the conversation, since that's how mismatches between what you say and what actually got placed happen. If no change was agreed on at all (e.g. the customer only asked a question), don't call confirm_order — just write a short, friendly reply instead.

Conversation:
${transcriptText}`;

        const claudeTools = [
          {
            name: 'find_menu_items',
            description: 'Search the menu by name or category keyword to resolve an item mentioned in conversation to its real id and price.',
            input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] }
          },
          {
            name: 'confirm_order',
            description: 'Finalize an order with its FULL current item list — not just what changed. If there is more than one open order, you must specify order_id — see the current order state above for the correct one. Omit order_id only if there\'s exactly one open order, or none at all (creates a new one).',
            input_schema: {
              type: 'object',
              properties: {
                order_id: { type: 'string', description: 'Required if more than one order is open. Get this from the current order state above.' },
                items: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: { menu_item_id: { type: 'string' }, name: { type: 'string' }, qty: { type: 'number' }, price: { type: 'number' } },
                    required: ['menu_item_id', 'name', 'qty', 'price']
                  }
                },
                note: { type: 'string' }
              },
              required: ['items']
            }
          }
        ];
        const openaiTools = claudeTools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.input_schema } }));

        async function runTool(name, input) {
          if (name === 'find_menu_items') {
            const safeQuery = (input.query || '').replace(/[,()]/g, '').trim();
            let q = supabaseAdmin.from('menu_items').select('id, name, category, price').eq('tenant_id', resolved.tenantId).eq('active', true);
            if (safeQuery) q = q.or(`name.ilike.%${safeQuery}%,category.ilike.%${safeQuery}%`);
            const { data, error } = await q.limit(50);
            if (error) return { error: error.message };
            return { items: data };
          }
          if (name === 'confirm_order') {
            let targetOrderId = input.order_id || null;
            if (!targetOrderId && openOrders && openOrders.length === 1) {
              targetOrderId = openOrders[0].id;
            } else if (!targetOrderId && openOrders && openOrders.length > 1) {
              return {
                error: 'More than one order is open — order_id is required.',
                open_orders: openOrders.map((o) => ({ order_id: o.id, order_number: o.order_number, items: o.items }))
              };
            }
            const { order_id: _drop, ...orderInput } = input;
            return confirmOrder(orderInput, resolved.tenantId, ctx.customer.id, true, targetOrderId, ctx.sessionId, true);
          }
          return { error: 'Unknown tool' };
        }

        let finalReply;
        try {
          const messages = [{ role: 'user', content: 'Please finalize this based on the conversation and current order state above.' }];
          const result =
            provider === 'openai'
              ? await runOpenAiLoop(messages, runTool, { model: 'gpt-4o-mini', systemPrompt: FINALIZE_SYSTEM_PROMPT, tools: openaiTools, maxTokens: 2048 })
              : await runClaudeLoop(messages, runTool, { model: 'claude-haiku-4-5-20251001', systemPrompt: FINALIZE_SYSTEM_PROMPT, tools: claudeTools, maxTokens: 2048 });
          finalReply = result.text;
        } catch (err) {
          return res.status(500).json({ error: 'AI finalize failed: ' + err.message });
        }

        await supabaseAdmin.from('conversation_messages').insert({
          tenant_id: resolved.tenantId,
          session_id: ctx.sessionId,
          customer_id: ctx.customer.id,
          order_id: ctx.orderId,
          sender: 'ai',
          message: finalReply
        });

        return res.status(200).json({ ok: true, reply: finalReply });
      }

      return res.status(400).json({ error: 'Unknown takeover_action' });
    }

    // Ban/unban a customer — doesn't touch the orders table at all, so
    // handle it before the order_id requirement below applies.
    if (ban_customer_id || unban_customer_id) {
      const customerId = ban_customer_id || unban_customer_id;
      const { error: banErr } = await supabaseAdmin
        .from('customers')
        .update({ banned: !!ban_customer_id })
        .eq('id', customerId)
        .eq('tenant_id', resolved.tenantId);
      if (banErr) return res.status(500).json({ error: banErr.message });
      return res.status(200).json({ ok: true });
    }

    if (!order_id) return res.status(400).json({ error: 'order_id is required' });
    if (status === undefined && needs_attention === undefined && items === undefined) {
      return res.status(400).json({ error: 'status, needs_attention, or items is required' });
    }

    const update = { updated_at: new Date().toISOString() };
    if (status !== undefined) update.status = status;
    if (eta_minutes !== undefined) update.eta_minutes = eta_minutes;
    if (needs_attention !== undefined) update.needs_attention = needs_attention;
    if (attention_note !== undefined) update.attention_note = attention_note;
    if (status === 'accepted') update.accepted_at = new Date().toISOString();

    // Staff editing an order's items directly (e.g. after confirming a
    // change with the customer by phone). Never trust the price/name sent
    // from the browser for anything that gets charged — re-look-up each
    // item from menu_items, same principle as the chat's confirm_order.
    if (items !== undefined) {
      const ids = items.map((i) => i.menu_item_id);
      const { data: menuRows, error: menuErr } = await supabaseAdmin
        .from('menu_items')
        .select('id, name, price')
        .eq('tenant_id', resolved.tenantId)
        .in('id', ids);
      if (menuErr) return res.status(500).json({ error: menuErr.message });

      const byId = new Map(menuRows.map((m) => [m.id, m]));
      let resolvedItems;
      try {
        resolvedItems = items
          .filter((i) => i.qty > 0) // qty 0 = staff removed this line
          .map((i) => {
            const menuItem = byId.get(i.menu_item_id);
            if (!menuItem) throw new Error(`Item ${i.name || i.menu_item_id} not found in menu.`);
            return { menu_item_id: menuItem.id, name: menuItem.name, qty: i.qty, price: Number(menuItem.price) };
          });
      } catch (err) {
        return res.status(400).json({ error: err.message });
      }

      const subtotal = resolvedItems.reduce((sum, i) => sum + i.qty * i.price, 0);
      const tax = subtotal * GST_RATE;
      update.items = resolvedItems;
      update.subtotal = subtotal.toFixed(2);
      update.tax = tax.toFixed(2);
      update.total = (subtotal + tax).toFixed(2);
    }

    const { data: order, error } = await supabaseAdmin
      .from('orders')
      .update(update)
      .eq('id', order_id)
      .eq('tenant_id', resolved.tenantId) // can't touch another tenant's order even by guessing an id
      .select('*, customers(id, name, phone, area_code_flag, phone_verified, banned)')
      .single();
    if (error) return res.status(500).json({ error: error.message });

    if (status === 'accepted' && eta_minutes) {
      const message = `Hi ${order.customers.name}, your order has been received! It'll be ready for pickup in about ${eta_minutes} minutes. Our crew may call you if we have any questions about your order.`;
      await supabaseAdmin.from('notifications').insert({
        tenant_id: resolved.tenantId,
        customer_id: order.customer_id,
        order_id: order.id,
        channel: 'sms',
        message,
        status: 'mock_sent'
      });
    }

    let noShowCount;
    if (status === 'no_show') {
      const { count } = await supabaseAdmin
        .from('orders')
        .select('id', { count: 'exact', head: true })
        .eq('customer_id', order.customer_id)
        .eq('status', 'no_show');
      noShowCount = count;
    }

    return res.status(200).json({ order, no_show_count: noShowCount });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}