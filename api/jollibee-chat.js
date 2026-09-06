// api/restaurant-chat.js
//
// Fixes applied from the security review, continuing from restaurant-captcha.js:
//   #1  correct IP extraction (shared logic with captcha endpoint)
//   #2  CORS is cosmetic only, not the security boundary
//   #3  global per-tenant spend cap, not just per-IP/per-session
//   #4  atomic rate limiting (increment_rate_limit), no TOCTOU race
//   #7  fetch to Claude wrapped in AbortController with a timeout
//   #8  check response.ok and log the error body before parsing content
//   #9  ban check uses the corrected IP, checked before any LLM call

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';
import { verifyToken } from './jollibee-captcha.js';
import { confirmOrder, computeRemainingMinutes } from '../lib/ordering.js';

const TENANT_SLUG = 'jollibee'; // default demo tenant this chat serves

// Toggle which LLM provider handles the conversation — same pattern as
// your other demos, single constant, no other code changes needed.
const AI_PROVIDER_DEFAULT = 'claude'; // fallback if a tenant somehow has no ai_provider set
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const OPENAI_MODEL = 'gpt-4o-mini';

// Per-token cost, verified against each provider's published pricing.
// Update these if pricing changes — this is what usage tracking bills against.
const PRICING = {
  claude: { input: 1 / 1e6, output: 5 / 1e6 },   // Haiku 4.5: $1 / $5 per million tokens
  openai: { input: 0.15 / 1e6, output: 0.6 / 1e6 } // gpt-4o-mini: $0.15 / $0.60 per million tokens
};
const ALLOWED_ORIGINS = ['https://reysan.ca'];
const ALLOWED_AREA_CODES = ['587', '780']; // Edmonton — soft flag only, never blocks

const MAX_PER_SESSION_PER_HOUR = 20;
const MAX_OFF_TOPIC_WARNINGS = 3; // after this many, the conversation ends
const MAX_PER_IP_PER_HOUR = 40;
const MAX_GLOBAL_PER_TENANT_PER_HOUR = 500; // fix #3 — the actual spend cap
const FETCH_TIMEOUT_MS = 10000;
const FLAG_BAN_THRESHOLD = 10;
const BAN_DURATION_DAYS = 3;

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Fix #1: same corrected extraction as restaurant-captcha.js — last hop of
// x-forwarded-for is the real client IP; anything before it is spoofable.
function getClientIp(req) {
  const xff = req.headers['x-forwarded-for'];
  if (xff) {
    const parts = xff.split(',').map((p) => p.trim());
    return parts[parts.length - 1];
  }
  return req.socket.remoteAddress || 'unknown';
}

const SYSTEM_PROMPT = `You are the ordering assistant for a Jollibee Canada location, part of a demo ordering system.

Flow you must follow, in order:
1. If the customer hasn't given a name and phone number yet, ask for both before anything else.
2. Once you have both, call request_otp. This is a DEMO — tell the customer their verification code directly in your reply (it will not be texted). Ask them to enter it back to you.
3. When they reply with a code, call verify_otp. If it fails, let them try again (max 3 attempts).
4. Only after verify_otp succeeds may you discuss the menu or take an order. If asked about the menu before verification, politely say you just need to verify their number first.
5. Use search_menu for any menu question — never invent items, prices, or availability. If search_menu comes back with no matching results, don't just say it's unavailable and stop there — apologize briefly, then either suggest something similar (search the same category and offer one or two options) or ask if they'd like something else. Never leave the conversation at a dead end.
6. When they're ready to order, use suggest_items to show a running summary, then confirm_order only after they explicitly say it's correct.
7. Keep responses short and friendly, like a cashier taking an order — not a scripted bot.
8. If asked something unrelated to ordering from this restaurant, politely say you can only help with the menu and orders here, and call flag_off_topic in that same turn. Do this every time it happens, even if you already warned them once — the system tracks the count and ends the conversation automatically after a few, you don't need to count it yourself. If the tool result comes back with limit_reached: true, say a brief, polite goodbye (e.g. "Sorry, I need to wrap up this conversation since it's moved away from ordering — feel free to start a new chat anytime!") and don't continue answering further off-topic questions after that.
9. If the customer explicitly asks to talk to a real person or staff member — at ANY point, even before ordering — take it seriously right away. If you don't have their name and phone yet, ask for it first ("Sure, can I get your name and number so our team can reach you?"), then call flag_wants_human once you have it. If it returns need_identity_first, that means you tried without their info yet — ask for it. Once flagged, tell them warmly that a team member will join the chat shortly.

Be a good cashier, not a search box. Real cashiers make conversation and suggest things:
- If the customer seems unsure what to get, ask a light question first — "feeling like chicken today, or something else?" — instead of just listing the whole menu.
- Mention what's popular naturally when it fits, e.g. "the Chickenjoy's our best seller if you want something classic."
- When they've picked mains, suggest a natural add-on once — a side, a drink, or dessert — the way a cashier would ask "you want fries with that?" Don't push if they decline once.
- Occasionally reference a specific item conversationally — "have you tried the Halo-Halo? it's a customer favorite" — instead of always waiting to be asked.
- Keep all of this to short, casual asides. One suggestion at a time, never a list of five things back to back. If the customer just wants to order fast and says so, drop the suggestions and take the order.

Handling vague or casual quantity language:
- Customers won't always name the exact menu item. "1 bucket of chicken" means they want one of whatever bucket-sized item exists — use search_menu with category "Buckets" and match it up, don't reject the phrase just because "bucket" isn't a literal item name.
- If more than one bucket size matches (e.g. 6pc vs 10pc vs the Family Meal), ask which one instead of guessing or telling them their request "doesn't exist." The customer describing what they want loosely is normal — your job is to map it to the real menu, not correct their phrasing.
- Same logic applies to any category name used casually ("a couple of drinks", "some rice") — search and clarify, never tell them something "isn't a thing" when a reasonable match exists.

If you're genuinely unsure about something (a menu detail search_menu doesn't resolve, a policy question, anything outside what you can look up) — say so plainly and suggest they call the store directly, rather than guessing.

Checking an existing order: if the customer's first message is about checking on an order rather than placing a new one (e.g. "what's the status of my order", "how much longer"), skip the full name/phone/OTP flow — just ask for their phone number and call check_order_status directly. No verification needed for this, it's read-only. Each order comes back with a status_message already written for you — use that instead of calculating your own "ready in X minutes," since it already accounts for orders running late. If they have more than one open order, mention each one's status_message and, if there's more than one, the combined_total — frame it as one running tab, not unrelated charges.

Order numbers: every confirmed order gets an order_number in the tool result. Tell the customer this number when you confirm their order ("you're order number 1042") — it's what they'd reference at pickup, not any internal id.

Do not call confirm_order speculatively. Only call it when the customer has given a clear, final "yes" / "that's right" / equivalent to the exact item list you're about to submit. If they're still thinking out loud ("could I maybe add one more?"), respond in plain text and wait for their actual confirmation before calling the tool. If they change their mind before confirming, just acknowledge it in text — don't call any tool.

Payment: if asked how to pay, tell them payment happens in-store at pickup — credit, debit, or cash. Nothing is charged online through this chat.

Formatting: this is a plain-text chat window, not a document. Never use markdown formatting — no **bold**, no bullet points with asterisks, no headers. Write like a normal text message.

Phone numbers: whenever YOU write a phone number back to the customer (confirming it, repeating it), format it with dashes in groups (e.g. 587-123-4321), never as one unbroken string of digits. This is about your own output only — never ask the customer to format their number a certain way, or to "confirm" it in a specific format. They can type it however they want; just verify it's a real phone number and move on.

Confirming an order — never skip the preview step:
1. Before calling confirm_order, always say back the FULL list you're about to submit and its total, then ask something like "should I go ahead with that?" — in plain text, no tool call.
2. Only call confirm_order after the customer's NEXT message is a clear yes to that exact preview. A bare "yes" that's just acknowledging information (not answering a "should I proceed?" question) is not a confirmation — if you're unsure what they meant, ask again rather than guessing.
3. Send the FULL order every time you call confirm_order — everything the customer wants in total, not just what's new. This is safe to repeat; calling it twice with the same list does not double anything.
4. If the customer wants to remove or reduce something: restate the updated full list first ("so that'd bring it down to just one Halo-Halo, total $X — want me to go ahead?") and wait for their yes, exactly like adding something. Never remove or change anything silently.
5. If confirm_order comes back with new_separate_order: true, the original was already accepted and being prepared — only the genuinely new items became a second order. Tell the customer this as one running tab using the combined_total from the result, and don't do that addition yourself.

Reducing or removing from an order that's already accepted: you can't do this yourself — the kitchen may already be preparing it. If confirm_order comes back with reduction_requested: true, tell the customer you'll flag it for staff to call and confirm, then call flag_order_for_staff_review with a plain description of what they asked for. Don't try workarounds like creating a new order for the same items — that would double-charge them.

Always state the GST breakdown when confirming an order — never just say "your total is $X." Say something like "subtotal $A, plus GST $B, comes to $C total" so the customer isn't surprised by the number.`;

const tools = [
  {
    name: 'request_otp',
    description: 'Register the customer and issue a one-time verification code.',
    input_schema: {
      type: 'object',
      properties: { name: { type: 'string' }, phone: { type: 'string' } },
      required: ['name', 'phone']
    }
  },
  {
    name: 'verify_otp',
    description: 'Check the code the customer provided against the one just issued.',
    input_schema: {
      type: 'object',
      properties: { code: { type: 'string' } },
      required: ['code']
    }
  },
  {
    name: 'search_menu',
    description: 'Search the menu by category, keyword, or dietary filter.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string' },
        keyword: { type: 'string' },
        veg_only: { type: 'boolean' },
        max_price: { type: 'number' }
      }
    }
  },
  {
    name: 'suggest_items',
    description: 'Show the customer a running order summary before confirming.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              menu_item_id: { type: 'string' },
              name: { type: 'string' },
              qty: { type: 'number' },
              price: { type: 'number' }
            },
            required: ['menu_item_id', 'name', 'qty', 'price']
          }
        }
      },
      required: ['items']
    }
  },
  {
    name: 'confirm_order',
    description: 'Confirm the customer\'s order. ALWAYS send the FULL list of everything they currently want — not just what changed. This is safe to call more than once with the same list (it won\'t double-add), so don\'t worry about tracking deltas yourself. The backend handles merging into an existing order, splitting into a new one if the store already accepted the original, or computing the combined total — you just report what comes back.',
    input_schema: {
      type: 'object',
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              menu_item_id: { type: 'string' },
              name: { type: 'string' },
              qty: { type: 'number' },
              price: { type: 'number' }
            },
            required: ['menu_item_id', 'name', 'qty', 'price']
          }
        },
        note: { type: 'string' }
      },
      required: ['items']
    }
  },
  {
    name: 'check_order_status',
    description: 'Look up ALL of a customer\'s currently open (not-yet-completed) orders by phone number. Each order includes a ready-to-use status_message — relay that (or something very close to it) rather than composing your own timing claim, since it already accounts for whether the order is overdue. Also returns combined_total when there\'s more than one open order. Read-only — does not require OTP verification.',
    input_schema: {
      type: 'object',
      properties: { phone: { type: 'string' } },
      required: ['phone']
    }
  },
  {
    name: 'flag_order_for_staff_review',
    description: 'Use this when a customer wants to reduce, remove, or change something on an order that has ALREADY been accepted by the store — this can never be automated safely since the kitchen may already be preparing it. Flags the current order so staff see it and can call the customer to resolve it manually.',
    input_schema: {
      type: 'object',
      properties: { request_description: { type: 'string', description: 'Plain description of what the customer wants changed, for staff to read.' } },
      required: ['request_description']
    }
  },
  {
    name: 'flag_off_topic',
    description: 'Call this every time the customer asks something unrelated to ordering food from this restaurant (general chit-chat, unrelated topics, anything not about the menu/order/store). Call it in the SAME turn as your warning reply. After a few of these in one conversation, the system will end the chat automatically.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'flag_wants_human',
    description: 'Call this the moment the customer explicitly asks to talk to a real person / staff member, in ANY part of the conversation — even before they\'ve ordered or given their name/phone. If you don\'t have their name and phone yet, ask for it first (framed as "so our team can reach you"), then call this once you have it.',
    input_schema: { type: 'object', properties: {} }
  }
];

// OpenAI expects tools wrapped in { type: 'function', function: {...} } —
// same definitions, just reshaped, so the two schemas can't drift apart.
const openaiTools = tools.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema }
}));

async function getTenant() {
  const { data } = await supabase.from('tenants').select('id, ai_provider, contact_phone').eq('slug', TENANT_SLUG).single();
  return data ? { id: data.id, aiProvider: data.ai_provider || 'claude', contactPhone: data.contact_phone || 'the store' } : null;
}

async function requestOtp({ name, phone }, tenantId, sessionId) {
  const digits = phone.replace(/\D/g, '');
  const areaCode = digits.slice(-10, -7); // last 10 digits, first 3 = area code
  const areaCodeFlag = !ALLOWED_AREA_CODES.includes(areaCode);

  // Match and store by normalized digits only — "587-123-4321" and
  // "5871234321" must resolve to the same customer, otherwise a ban (or
  // any history) on one string doesn't catch the other.
  let { data: customer } = await supabase
    .from('customers')
    .select('*')
    .eq('tenant_id', tenantId)
    .eq('phone', digits)
    .maybeSingle();

  if (customer?.banned) {
    return { error: "There seems to be an issue with this phone number — please call the store directly and they'll sort it out for you." };
  }

  if (!customer) {
    const { data: newCustomer, error } = await supabase
      .from('customers')
      .insert({ tenant_id: tenantId, name, phone: digits, area_code_flag: areaCodeFlag, last_session_id: sessionId })
      .select()
      .single();
    if (error) return { error: error.message };
    customer = newCustomer;
  } else {
    await supabase.from('customers').update({ last_session_id: sessionId }).eq('id', customer.id);
  }

  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + 5 * 60 * 1000).toISOString();

  const { error: otpError } = await supabase
    .from('otp_verifications')
    .insert({ customer_id: customer.id, code, expires_at: expiresAt });
  if (otpError) return { error: otpError.message };

  return { customer_id: customer.id, demo_code: code, note: 'DEMO ONLY — real deployment would text this instead' };
}

async function verifyOtp({ code }, customerId) {
  if (!customerId) return { error: 'No pending verification for this session.' };

  const { data: otp } = await supabase
    .from('otp_verifications')
    .select('*')
    .eq('customer_id', customerId)
    .is('verified_at', null)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (!otp) return { error: 'No pending code found. Please request a new one.' };
  if (new Date(otp.expires_at) < new Date()) return { error: 'Code expired. Please request a new one.' };
  if (otp.attempts >= 3) return { error: 'Too many attempts. Please request a new code.' };

  if (otp.code !== code) {
    await supabase.from('otp_verifications').update({ attempts: otp.attempts + 1 }).eq('id', otp.id);
    return { verified: false, error: 'Incorrect code.' };
  }

  await supabase.from('otp_verifications').update({ verified_at: new Date().toISOString() }).eq('id', otp.id);
  await supabase.from('customers').update({ phone_verified: true }).eq('id', customerId);

  return { verified: true };
}

async function searchMenu({ category, keyword, veg_only, max_price }, tenantId) {
  let query = supabase.from('menu_items').select('*').eq('tenant_id', tenantId).eq('active', true);
  if (category) query = query.ilike('category', category);
  if (veg_only) query = query.eq('veg', true);
  if (max_price) query = query.lte('price', max_price);
  const { data, error } = await query;
  if (error) return { error: error.message };
  let results = data || [];
  if (keyword) {
    const k = keyword.toLowerCase();
    results = results.filter(
      (i) => i.name.toLowerCase().includes(k) || (i.description || '').toLowerCase().includes(k)
    );
  }
  return { results };
}



async function checkOrderStatus({ phone }, tenantId, contactPhone) {
  const digits = phone.replace(/\D/g, '');

  const { data: customer } = await supabase
    .from('customers')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('phone', digits)
    .maybeSingle();
  if (!customer) return { error: "Couldn't find an order for that phone number." };

  // Return every order that isn't fully completed yet — a customer can have
  // more than one open ticket (e.g. added items after the first was already
  // accepted), and the AI needs to see all of them, not just the latest.
  const { data: orders } = await supabase
    .from('orders')
    .select('*')
    .eq('customer_id', customer.id)
    .not('status', 'in', '(completed,cancelled)')
    .order('created_at', { ascending: true });

  if (!orders || orders.length === 0) return { error: 'No open orders found for that phone number.' };

  const mapped = orders.map((order) => {
    const remaining = computeRemainingMinutes(order);
    // Compose the actual status line here — don't leave "how much longer"
    // to the AI's own math, since it's shown a habit of citing the original
    // eta_minutes instead of the current remaining time.
    let status_message;
    if (order.status === 'ready') {
      status_message = `Order #${order.order_number} is ready for pickup — please come get it! Call ${contactPhone} if you have any questions.`;
    } else if (order.status === 'accepted' && remaining === 0) {
      status_message = `Order #${order.order_number} has been ready for a little while now — please come pick it up! Call ${contactPhone} if you have any questions.`;
    } else if (order.status === 'accepted') {
      status_message = `Order #${order.order_number} is accepted and should be ready in about ${remaining} more minutes.`;
    } else {
      status_message = `Order #${order.order_number} hasn't been accepted by the store yet.`;
    }
    return {
      order_number: order.order_number,
      status: order.status,
      remaining_minutes: remaining,
      total: order.total,
      status_message
    };
  });

  const result = { orders: mapped };
  if (mapped.length > 1) {
    result.combined_total = mapped.reduce((sum, o) => sum + Number(o.total), 0).toFixed(2);
  }
  return result;
}

async function flagOrderForReview({ request_description }, existingOrderId, tenantId) {
  if (!existingOrderId) return { error: 'No current order to flag.' };

  const { data, error } = await supabase
    .from('orders')
    .update({ needs_attention: true, attention_note: request_description })
    .eq('id', existingOrderId)
    .eq('tenant_id', tenantId)
    .select()
    .single();
  if (error) return { error: error.message };
  return { flagged: true, order_number: data.order_number };
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  // Fix #2: cosmetic only, not the actual gate
  if (ALLOWED_ORIGINS.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin);

  if (req.method === 'OPTIONS') {
    res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    return res.status(204).end();
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const clientIp = getClientIp(req);
  const { message, history = [], token, customerId, phoneVerified, orderId, offTopicCount } = req.body;

  // verify the Turnstile-issued session token before anything else
  const session = verifyToken(token);
  if (!session) return res.status(401).json({ error: 'Session expired or invalid. Please refresh.' });

  // Conversation already ended for being off-topic too many times — don't
  // spend a single token on a reply the customer can't act on anyway.
  if (offTopicCount >= MAX_OFF_TOPIC_WARNINGS) {
    return res.status(200).json({
      reply: "This conversation's been closed since it's moved away from ordering — feel free to refresh and start a new one anytime you'd like to order.",
      conversationEnded: true,
      offTopicCount
    });
  }

  const tenant = await getTenant();
  if (!tenant) return res.status(500).json({ error: 'Configuration error.' });
  const tenantId = tenant.id;
  const activeProvider = tenant.aiProvider; // per-tenant switch, no redeploy needed to change it

  // Lightweight polling path — the widget calls this every ~15s. Message
  // checking works from the moment a session exists (no order needed, so a
  // customer can be in an active takeover before ever placing an order);
  // order status only applies once orderId exists.
  if (req.body.checkStatus) {
    let statusPayload = {};

    if (orderId) {
      const { data: order } = await supabase
        .from('orders')
        .select('status, eta_minutes, accepted_at')
        .eq('id', orderId)
        .eq('tenant_id', tenantId)
        .maybeSingle();
      if (order) {
        statusPayload = { status: order.status, eta_minutes: order.eta_minutes, remaining_minutes: computeRemainingMinutes(order) };
      }
    }

    let takeoverActive = false;
    if (customerId) {
      const { data: cust } = await supabase.from('customers').select('takeover_active').eq('id', customerId).maybeSingle();
      takeoverActive = cust?.takeover_active || false;
    }

    let newMessages = [];
    if (req.body.messagesSince) {
      const { data: msgs } = await supabase
        .from('conversation_messages')
        .select('sender, message, created_at')
        .eq('tenant_id', tenantId)
        .eq('session_id', session.sessionId)
        .in('sender', ['staff', 'ai'])
        .gt('created_at', req.body.messagesSince)
        .order('created_at', { ascending: true });
      newMessages = msgs || [];
    }

    return res.status(200).json({ ...statusPayload, takeoverActive, newMessages });
  }

  // If staff has taken over THIS CUSTOMER's conversation (not tied to any
  // specific order — a customer can ask for a human before ever ordering),
  // log their message for staff to see and skip the AI entirely.
  if (customerId) {
    const { data: activeCustomer } = await supabase
      .from('customers')
      .select('takeover_active')
      .eq('id', customerId)
      .maybeSingle();

    if (activeCustomer?.takeover_active) {
      await supabase.from('conversation_messages').insert({
        tenant_id: tenantId,
        session_id: session.sessionId,
        order_id: orderId || null,
        sender: 'customer',
        message
      });
      return res.status(200).json({ reply: null, takeoverActive: true, customerId, phoneVerified, orderId, offTopicCount });
    }
  }

  // Fix #9: ban check uses the corrected IP from fix #1
  const { data: ban } = await supabase
    .from('banned_ips')
    .select('*')
    .eq('ip', clientIp)
    .gte('banned_until', new Date().toISOString())
    .maybeSingle();
  if (ban) return res.status(403).json({ error: 'Access temporarily restricted.' });

  // Fix #3 + #4: check the GLOBAL tenant cap first, atomically, before any
  // per-session/per-IP check — this is the actual spend-control gate.
  const globalCount = await bumpRateLimit(`${TENANT_SLUG}:global:hour`, 3600);
  if (globalCount === null) return res.status(500).json({ error: 'Something went wrong.' });
  if (globalCount > MAX_GLOBAL_PER_TENANT_PER_HOUR) {
    return res.status(429).json({ error: 'This demo is experiencing high traffic. Please try again later.' });
  }

  const sessionCount = await bumpRateLimit(`${TENANT_SLUG}:session:${session.sessionId}:hour`, 3600);
  if (sessionCount !== null && sessionCount > MAX_PER_SESSION_PER_HOUR) {
    return res.status(200).json({ reply: "We've hit the limit for this chat session. Please refresh to start a new order.", conversationEnded: true });
  }

  const ipCount = await bumpRateLimit(`${TENANT_SLUG}:ip:${clientIp}:hour`, 3600);
  if (ipCount !== null && ipCount > MAX_PER_IP_PER_HOUR) {
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  const messages = [...history, { role: 'user', content: message }];
  let currentCustomerId = customerId || null;
  let currentPhoneVerified = phoneVerified || false;
  let currentOrderId = orderId || null;
  let currentOffTopicCount = offTopicCount || 0;

  // Shared dispatcher — same tool execution regardless of which provider
  // asked for it, so behavior can't drift between the two.
  async function runTool(name, input) {
    if (name === 'request_otp') {
      const result = await requestOtp(input, tenantId, session.sessionId);
      if (result.customer_id) currentCustomerId = result.customer_id;
      return result;
    }
    if (name === 'verify_otp') {
      const result = await verifyOtp(input, currentCustomerId);
      if (result.verified) currentPhoneVerified = true;
      return result;
    }
    if (name === 'search_menu') return searchMenu(input, tenantId);
    if (name === 'suggest_items') return { ok: true, items: input.items };
    if (name === 'check_order_status') return checkOrderStatus(input, tenantId, tenant.contactPhone);
    if (name === 'flag_order_for_staff_review') return flagOrderForReview(input, currentOrderId, tenantId);
    if (name === 'flag_off_topic') {
      currentOffTopicCount += 1;
      return { count: currentOffTopicCount, limit_reached: currentOffTopicCount >= MAX_OFF_TOPIC_WARNINGS };
    }
    if (name === 'flag_wants_human') {
      if (!currentCustomerId) return { error: 'need_identity_first' };
      const { error } = await supabase.from('customers').update({ wants_human: true, last_session_id: session.sessionId }).eq('id', currentCustomerId);
      if (error) return { error: error.message };
      return { flagged: true };
    }
    if (name === 'confirm_order') {
      const result = await confirmOrder(input, tenantId, currentCustomerId, currentPhoneVerified, currentOrderId, session.sessionId);
      if (result.order_id) currentOrderId = result.order_id;
      return result;
    }
    return { error: 'Unknown tool' };
  }

  try {
    const { text: replyText, inputTokens, outputTokens } =
      activeProvider === 'openai' ? await runOpenAiLoop(messages, runTool) : await runClaudeLoop(messages, runTool);

    const pricing = PRICING[activeProvider] || PRICING[AI_PROVIDER_DEFAULT];
    const costUsd = inputTokens * pricing.input + outputTokens * pricing.output;

    await supabase.from('chat_logs').insert({
      tenant_id: tenantId,
      source: TENANT_SLUG,
      session_id: session.sessionId,
      question: message,
      answer: replyText,
      ip: clientIp,
      input_tokens: inputTokens,
      output_tokens: outputTokens,
      cost_usd: costUsd,
      model: activeProvider === 'openai' ? OPENAI_MODEL : CLAUDE_MODEL
    });

    return res.status(200).json({
      reply: replyText,
      history: messages, // mutated in place by whichever provider loop ran
      customerId: currentCustomerId,
      phoneVerified: currentPhoneVerified,
      orderId: currentOrderId,
      offTopicCount: currentOffTopicCount,
      conversationEnded: currentOffTopicCount >= MAX_OFF_TOPIC_WARNINGS
    });
  } catch (err) {
    console.error('jollibee-chat error', err);
    return res.status(500).json({ error: 'Something went wrong, please try again.' });
  }
}

// Fix #4: single atomic DB call, no separate count-then-insert
async function bumpRateLimit(key, windowSeconds) {
  const { data, error } = await supabase.rpc('increment_rate_limit', { p_key: key, p_window_seconds: windowSeconds });
  if (error) {
    console.error('rate limit error', error);
    return null;
  }
  return data;
}

// Claude loop — mutates `messages` in place (Anthropic's native block format)
// so the caller can persist it as history for the next request. Also
// accumulates usage across every API call in the loop (a single user
// message can trigger several round trips if tools are chained).
async function runClaudeLoop(messages, runTool) {
  let response = await callClaude(messages);
  let inputTokens = response.usage?.input_tokens || 0;
  let outputTokens = response.usage?.output_tokens || 0;

  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    const toolResultBlocks = [];

    for (const block of toolUseBlocks) {
      const result = await runTool(block.name, block.input);
      toolResultBlocks.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }

    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResultBlocks });
    response = await callClaude(messages);
    inputTokens += response.usage?.input_tokens || 0;
    outputTokens += response.usage?.output_tokens || 0;
  }

  messages.push({ role: 'assistant', content: response.content });
  const textBlock = response.content.find((b) => b.type === 'text');
  return { text: textBlock ? textBlock.text : '', inputTokens, outputTokens };
}

// OpenAI loop — mutates `messages` in place too, but in OpenAI's flatter
// { role, content, tool_calls } shape, which is NOT interchangeable with
// Claude's block format above. Don't mix history between providers mid-session.
async function runOpenAiLoop(messages, runTool) {
  let data = await callOpenAI(messages);
  let message = data.choices[0].message;
  let inputTokens = data.usage?.prompt_tokens || 0;
  let outputTokens = data.usage?.completion_tokens || 0;

  while (message.tool_calls && message.tool_calls.length > 0) {
    messages.push(message);

    for (const call of message.tool_calls) {
      const input = JSON.parse(call.function.arguments || '{}');
      const result = await runTool(call.function.name, input);
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }

    data = await callOpenAI(messages);
    message = data.choices[0].message;
    inputTokens += data.usage?.prompt_tokens || 0;
    outputTokens += data.usage?.completion_tokens || 0;
  }

  messages.push(message);
  return { text: message.content || '', inputTokens, outputTokens };
}

// Fix #7 + #8: timeout on the upstream call, and check response.ok before
// trusting the shape of the body (data.content might not exist on an error)
async function callClaude(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1024, system: SYSTEM_PROMPT, tools, messages }),
      signal: controller.signal
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('Claude API error', resp.status, data.error);
      throw new Error(data.error?.message || 'Upstream API error');
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}

// Same fixes (#7 timeout, #8 safe error parsing) applied to the OpenAI branch.
async function callOpenAI(messages) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
        tools: openaiTools,
        tool_choice: 'auto'
      }),
      signal: controller.signal
    });

    const data = await resp.json();

    if (!resp.ok) {
      console.error('OpenAI API error', resp.status, data.error);
      throw new Error(data.error?.message || 'Upstream API error');
    }

    return data;
  } finally {
    clearTimeout(timeout);
  }
}