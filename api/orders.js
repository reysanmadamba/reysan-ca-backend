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

    const { data, error } = await supabaseAdmin
      .from('orders')
      .select('*, customers(id, name, phone, area_code_flag, phone_verified, banned)')
      .eq('tenant_id', resolved.tenantId)
      .order('created_at', { ascending: false })
      .limit(50);
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

        const FINALIZE_SYSTEM_PROMPT = `You are finalizing a food order after a staff member helped the customer during a live handoff. Read the conversation below and call confirm_order with the FULL final item list the customer and staff agreed on. Then write a short, friendly closing message confirming the order and its total, mentioning GST. Never invent menu items — only use ones already referenced in the conversation below. If no order was actually agreed on (e.g. the customer only asked a question), don't call confirm_order — just write a short, friendly closing message instead.

Conversation:
${transcriptText}`;

        const claudeTools = [
          {
            name: 'confirm_order',
            description: 'Finalize the order with the agreed item list.',
            input_schema: {
              type: 'object',
              properties: {
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
          if (name === 'confirm_order') {
            return confirmOrder(input, resolved.tenantId, ctx.customer.id, true, ctx.orderId, ctx.sessionId);
          }
          return { error: 'Unknown tool' };
        }

        let finalReply;
        try {
          const messages = [{ role: 'user', content: 'Please finalize this based on the conversation above.' }];
          const result =
            provider === 'openai'
              ? await runOpenAiLoop(messages, runTool, { model: 'gpt-4o-mini', systemPrompt: FINALIZE_SYSTEM_PROMPT, tools: openaiTools })
              : await runClaudeLoop(messages, runTool, { model: 'claude-haiku-4-5-20251001', systemPrompt: FINALIZE_SYSTEM_PROMPT, tools: claudeTools });
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

    return res.status(200).json({ order });
  }

  return res.status(405).json({ error: 'Method not allowed' });
}