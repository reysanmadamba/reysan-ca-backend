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

    // Conversation transcript for a specific order — looks up the order's
    // session_id, then pulls every chat_logs turn from that same session.
    if (req.query.transcript_for) {
      const { data: order, error: orderErr } = await supabaseAdmin
        .from('orders')
        .select('session_id')
        .eq('id', req.query.transcript_for)
        .eq('tenant_id', resolved.tenantId)
        .single();
      if (orderErr) return res.status(500).json({ error: orderErr.message });
      if (!order.session_id) return res.status(200).json({ transcript: [], note: 'No session linked to this order (placed before transcript tracking was added).' });

      const { data: turns, error: turnsErr } = await supabaseAdmin
        .from('chat_logs')
        .select('question, answer, created_at')
        .eq('tenant_id', resolved.tenantId)
        .eq('session_id', order.session_id)
        .order('created_at', { ascending: true });
      if (turnsErr) return res.status(500).json({ error: turnsErr.message });

      return res.status(200).json({ transcript: turns });
    }

    // Live takeover messages — used while the dashboard's takeover chat
    // panel is open, polled to pick up new customer messages.
    if (req.query.live_messages_for) {
      const { data: order, error: orderErr } = await supabaseAdmin
        .from('orders')
        .select('session_id, takeover_active')
        .eq('id', req.query.live_messages_for)
        .eq('tenant_id', resolved.tenantId)
        .single();
      if (orderErr) return res.status(500).json({ error: orderErr.message });
      if (!order.session_id) return res.status(200).json({ messages: [], takeoverActive: false });

      const { data: msgs, error: msgsErr } = await supabaseAdmin
        .from('conversation_messages')
        .select('sender, message, created_at')
        .eq('tenant_id', resolved.tenantId)
        .eq('session_id', order.session_id)
        .order('created_at', { ascending: true });
      if (msgsErr) return res.status(500).json({ error: msgsErr.message });

      return res.status(200).json({ messages: msgs, takeoverActive: order.takeover_active });
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
    const { order_id, status, eta_minutes, needs_attention, attention_note, items, ban_customer_id, unban_customer_id, takeover_action, staff_message, tenant_id } = req.body;
    const resolved = resolveTenantId(auth, tenant_id);
    if (resolved.error) return res.status(resolved.status).json({ error: resolved.error });

    // Live takeover: staff pausing the AI, sending a manual message, or
    // handing control back (which triggers the AI to finalize the order
    // based on the full conversation, including what staff/customer agreed).
    if (takeover_action) {
      if (!order_id) return res.status(400).json({ error: 'order_id is required' });

      const { data: order, error: orderErr } = await supabaseAdmin
        .from('orders')
        .select('*, customers(id, phone_verified)')
        .eq('id', order_id)
        .eq('tenant_id', resolved.tenantId)
        .single();
      if (orderErr) return res.status(500).json({ error: orderErr.message });
      if (!order.session_id) return res.status(400).json({ error: 'No chat session linked to this order.' });

      if (takeover_action === 'start') {
        const { error } = await supabaseAdmin.from('orders').update({ takeover_active: true }).eq('id', order_id);
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
      }

      if (takeover_action === 'send') {
        if (!staff_message) return res.status(400).json({ error: 'staff_message is required' });
        const { error } = await supabaseAdmin.from('conversation_messages').insert({
          tenant_id: resolved.tenantId,
          session_id: order.session_id,
          order_id,
          sender: 'staff',
          message: staff_message
        });
        if (error) return res.status(500).json({ error: error.message });
        return res.status(200).json({ ok: true });
      }

      if (takeover_action === 'resume') {
        await supabaseAdmin.from('orders').update({ takeover_active: false }).eq('id', order_id);

        const { data: tenantRow } = await supabaseAdmin.from('tenants').select('ai_provider').eq('id', resolved.tenantId).single();
        const provider = tenantRow?.ai_provider || 'claude';

        const { data: msgs } = await supabaseAdmin
          .from('conversation_messages')
          .select('sender, message, created_at')
          .eq('tenant_id', resolved.tenantId)
          .eq('session_id', order.session_id)
          .order('created_at', { ascending: true });

        const transcriptText = (msgs || []).map((m) => `${m.sender.toUpperCase()}: ${m.message}`).join('\n');

        const FINALIZE_SYSTEM_PROMPT = `You are finalizing a food order after a staff member resolved a change with the customer during a live handoff. Read the conversation below and call confirm_order with the FULL final item list the customer and staff agreed on. Then write a short, friendly closing message confirming the order and its total, mentioning GST. Never invent menu items — only use ones already referenced in the conversation below.

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
            return confirmOrder(input, resolved.tenantId, order.customer_id, order.customers?.phone_verified || false, order.id, order.session_id);
          }
          return { error: 'Unknown tool' };
        }

        let finalReply;
        try {
          const messages = [{ role: 'user', content: 'Please finalize this order based on the conversation above.' }];
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
          session_id: order.session_id,
          order_id,
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