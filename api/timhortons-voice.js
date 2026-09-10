// api/timhortons-voice.js
//
// Webhook Vapi calls for every tool the voice assistant invokes during a
// phone call. Unlike timhortons-chat.js, Vapi runs its own LLM loop — this
// endpoint never talks to Claude/OpenAI itself, it just executes whatever
// tool Vapi says was called and returns the result in Vapi's expected shape.
//
// Identity model: no OTP. The caller's own phone number (from Twilio/Vapi's
// call metadata, NOT anything the "conversation" could spoof) IS the
// verified identity — the same trust model a real phone call already has.
// Orders/customers live in the exact same tables the text chat uses, so a
// customer's voice order shows up in the same staff dashboard seamlessly.

import { createClient } from '@supabase/supabase-js';
import { confirmOrder, computeRemainingMinutes } from '../lib/ordering.js';

const TENANT_SLUG = 'timhortons';
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

async function getTenant() {
  const { data } = await supabase.from('tenants').select('id, contact_phone').eq('slug', TENANT_SLUG).single();
  return data ? { id: data.id, contactPhone: data.contact_phone || 'the store' } : null;
}

// Every tool call needs the caller's own customer row. Created once per
// phone number per tenant, same as the chat flow's requestOtp — except
// phone_verified is true immediately, since the call itself is the proof.
async function getOrCreateCustomer(phoneDigits, tenantId, callId) {
  let { data: customer } = await supabase
    .from('customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('phone', phoneDigits)
    .maybeSingle();

  if (customer?.banned) return { banned: true };

  if (!customer) {
    const { data: newCustomer, error } = await supabase
      .from('customers')
      .insert({ tenant_id: tenantId, name: 'Voice caller', phone: phoneDigits, phone_verified: true, last_session_id: callId })
      .select()
      .single();
    if (error) throw new Error(error.message);
    customer = newCustomer;
  } else if (!customer.phone_verified) {
    await supabase.from('customers').update({ phone_verified: true, last_session_id: callId }).eq('id', customer.id);
    customer.phone_verified = true;
  }

  return { customer };
}

async function searchMenu({ category, keyword, veg_only, max_price }, tenantId) {
  let query = supabase.from('menu_items').select('*').eq('tenant_id', tenantId).eq('active', true);
  if (category) query = query.ilike('category', `%${category}%`);
  if (veg_only) query = query.eq('veg', true);
  if (max_price) query = query.lte('price', max_price);
  const { data, error } = await query;
  if (error) return { error: error.message };
  let results = data || [];
  if (keyword) {
    const words = keyword.toLowerCase().split(/\s+/).filter(Boolean);
    results = results
      .map((i) => {
        const haystack = `${i.name} ${i.description || ''} ${i.category}`.toLowerCase();
        const matchCount = words.filter((w) => haystack.includes(w)).length;
        return { item: i, matchCount };
      })
      .filter((r) => r.matchCount > 0)
      .sort((a, b) => b.matchCount - a.matchCount)
      .map((r) => r.item);
  }
  return { results };
}

async function checkOrderStatus(customerId, tenantId, contactPhone) {
  const { data: orders } = await supabase
    .from('orders')
    .select('*')
    .eq('customer_id', customerId)
    .not('status', 'in', '(completed,cancelled)')
    .order('created_at', { ascending: true });

  if (!orders || orders.length === 0) return { error: 'No open orders found.' };

  const mapped = orders.map((order) => {
    const remaining = computeRemainingMinutes(order);
    let status_message;
    if (order.status === 'ready') {
      status_message = `Order number ${order.order_number} is ready for pickup.`;
    } else if (order.status === 'accepted' && remaining === 0) {
      status_message = `Order number ${order.order_number} has been ready for a little while now — come on by.`;
    } else if (order.status === 'accepted') {
      status_message = `Order number ${order.order_number} is accepted and should be ready in about ${remaining} more minutes.`;
    } else {
      status_message = `Order number ${order.order_number} hasn't been accepted by the store yet.`;
    }
    return { order_id: order.id, order_number: order.order_number, status: order.status, remaining_minutes: remaining, total: order.total, items: order.items, status_message };
  });

  const result = { orders: mapped };
  if (mapped.length > 1) result.combined_total = mapped.reduce((sum, o) => sum + Number(o.total), 0).toFixed(2);
  return result;
}

async function flagOrderForReview(orderId, requestDescription, tenantId, customerId) {
  let targetOrderId = orderId;
  if (!targetOrderId) {
    const { data: openOrders } = await supabase
      .from('orders')
      .select('id, order_number, items')
      .eq('customer_id', customerId)
      .not('status', 'in', '(completed,cancelled)');
    if (!openOrders || openOrders.length === 0) return { error: 'No open order found for this customer.' };
    if (openOrders.length === 1) {
      targetOrderId = openOrders[0].id;
    } else {
      return {
        error: 'More than one open order — order_id is required.',
        open_orders: openOrders.map((o) => ({ order_id: o.id, order_number: o.order_number, items: o.items }))
      };
    }
  }
  const { data, error } = await supabase
    .from('orders')
    .update({ needs_attention: true, attention_note: requestDescription })
    .eq('id', targetOrderId)
    .eq('tenant_id', tenantId)
    .select()
    .single();
  if (error) return { error: error.message };
  return { flagged: true, order_number: data.order_number };
}

async function resetOrders(tenantId, customerId) {
  const { data: openOrders } = await supabase
    .from('orders')
    .select('id, order_number, status')
    .eq('customer_id', customerId)
    .eq('tenant_id', tenantId)
    .not('status', 'in', '(completed,cancelled)');
  if (!openOrders || openOrders.length === 0) return { ok: true, cancelled: [], flagged_for_staff: [] };

  const cancelled = [];
  const flaggedForStaff = [];
  for (const order of openOrders) {
    if (order.status === 'new') {
      const { error } = await supabase.from('orders').update({ status: 'cancelled' }).eq('id', order.id);
      if (!error) cancelled.push(order.order_number);
    } else {
      const { error } = await supabase
        .from('orders')
        .update({ needs_attention: true, attention_note: 'Customer asked to reset/start over — please confirm cancellation with them.' })
        .eq('id', order.id);
      if (!error) flaggedForStaff.push(order.order_number);
    }
  }
  return { ok: true, cancelled, flagged_for_staff: flaggedForStaff };
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  // Shared secret so only Vapi (which we configure with this same header
  // value) can trigger tool execution — otherwise anyone who found this URL
  // could call confirm_order, ban checks aside, as if they were a live call.
  const expected = process.env.VAPI_WEBHOOK_SECRET;
  if (expected && req.headers['x-vapi-secret'] !== expected) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  // Log the raw shape once while we're still verifying Vapi's exact field
  // names against the docs — safe to remove once confirmed against a real
  // test call.
  console.log('vapi webhook body', JSON.stringify(req.body).slice(0, 2000));

  const message = req.body.message || req.body;
  const toolCalls = message.toolCallList || message.toolCalls || [];
  const rawNumber = message.call?.customer?.number || req.body.call?.customer?.number || '';
  const phoneDigits = rawNumber.replace(/\D/g, '');
  const callId = message.call?.id || req.body.call?.id || 'unknown-call';

  const tenant = await getTenant();
  if (!tenant) return res.status(500).json({ results: toolCalls.map((tc) => ({ toolCallId: tc.id, result: 'Configuration error.' })) });

  let customerId = null;
  if (phoneDigits) {
    try {
      const { customer, banned } = await getOrCreateCustomer(phoneDigits, tenant.id, callId);
      if (banned) {
        return res.status(200).json({
          results: toolCalls.map((tc) => ({ toolCallId: tc.id, result: 'This number is not able to order right now. Please call the store directly.' }))
        });
      }
      customerId = customer.id;
    } catch (err) {
      return res.status(200).json({ results: toolCalls.map((tc) => ({ toolCallId: tc.id, result: `Error: ${err.message}` })) });
    }
  }

  const results = [];
  for (const tc of toolCalls) {
    const name = tc.name;
    const input = tc.arguments || tc.parameters || {};
    let result;
    try {
      if (!customerId) {
        result = { error: 'Could not identify caller phone number.' };
      } else if (name === 'search_menu') {
        result = await searchMenu(input, tenant.id);
      } else if (name === 'check_order_status') {
        result = await checkOrderStatus(customerId, tenant.id, tenant.contactPhone);
      } else if (name === 'confirm_order') {
        result = await confirmOrder(input, tenant.id, customerId, true, input.order_id || null, callId);
      } else if (name === 'flag_order_for_staff_review') {
        result = await flagOrderForReview(input.order_id, input.request_description, tenant.id, customerId);
      } else if (name === 'reset_orders') {
        result = await resetOrders(tenant.id, customerId);
      } else {
        result = { error: `Unknown tool: ${name}` };
      }
    } catch (err) {
      result = { error: err.message };
    }
    results.push({ toolCallId: tc.id, result: JSON.stringify(result) });
  }

  return res.status(200).json({ results });
}
