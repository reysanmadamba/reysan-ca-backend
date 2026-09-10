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
const MAX_OTP_REMINDERS = 2; // ask once, remind once, then end if still not provided
const MAX_GUEST_INFO_REMINDERS = 3; // ask 3 times for real contact info before giving up and directing them to call
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

// Security fix: the Turnstile session token (verifyToken, above import) only
// proves "this is a rate-limited browser session" — it says nothing about
// WHICH customer is talking. Previously customerId/phoneVerified/orderId
// were read directly off the request body, so anyone could claim to be any
// customer (skip OTP, edit another customer's info, tamper with another
// customer's order). This second, separately-typed signed token proves the
// caller actually holds the customerId it claims — issued once identity is
// established (request_otp / flag_wants_human) and echoed back by the client
// on every subsequent call instead of being trusted at face value. Kept
// separate from the Turnstile token (different maxAge, different `type`)
// so neither can be replayed as the other, and so a silent Turnstile
// re-verify mid-conversation (which rotates sessionId) can't invalidate an
// otherwise-still-valid customer identity.
const CUSTOMER_AUTH_MAX_AGE_MS = 3 * 60 * 60 * 1000; // covers ordering + pickup wait

function signCustomerToken(customerId, tenantId) {
  const payload = { type: 'jollibee_customer', customerId, tenantId, issuedAt: Date.now() };
  const b64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const hmac = crypto.createHmac('sha256', process.env.SESSION_HMAC_SECRET).update(b64).digest('base64url');
  return `${b64}.${hmac}`;
}

function verifyCustomerToken(token, expectedCustomerId, tenantId) {
  if (!token) return false;
  try {
    const [b64, hmac] = token.split('.');
    const expected = crypto.createHmac('sha256', process.env.SESSION_HMAC_SECRET).update(b64).digest('base64url');
    const a = Buffer.from(hmac);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return false;

    const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
    if (payload.type !== 'jollibee_customer') return false;
    if (Date.now() - payload.issuedAt > CUSTOMER_AUTH_MAX_AGE_MS) return false;
    return payload.customerId === expectedCustomerId && payload.tenantId === tenantId;
  } catch {
    return false;
  }
}

const SYSTEM_PROMPT = `You are the ordering assistant for a Jollibee Canada location, part of a demo ordering system.

Flow you must follow, in order:
1. If the customer hasn't given a name and phone number yet, ask for both before anything else.
2. Once you have both, call request_otp. This is a DEMO — tell the customer their verification code directly in your reply (it will not be texted). The code you state MUST be copied EXACTLY, digit for digit, from the demo_code field in request_otp's tool result — never write a code from memory or compose a plausible-looking one yourself, even if you think you remember it from a moment ago. Ask them to enter it back to you.
3. When they reply with a code, call verify_otp. If it fails, let them try again (max 3 attempts). Never announce "your phone is verified!" or similar unless YOU just called verify_otp yourself in this conversation and it succeeded — if the customer is already treated as verified for some other reason (e.g. a staff member already helped them), just proceed naturally without commenting on verification status at all. If instead they ignore the code request and talk about something else, remind them ONCE that you need the code to proceed with their order, and call note_otp_reminder_sent. If they still don't provide it after that reminder, the system will end the conversation automatically — just say a brief, polite goodbye if that happens, don't keep asking.
4. Only after verify_otp succeeds may you discuss the menu or take an order. If asked about the menu before verification, politely say you just need to verify their number first.
5. Use search_menu for any menu question — never invent items, prices, or availability. If search_menu comes back with no matching results, don't just say it's unavailable and stop there — apologize briefly, then either suggest something similar (search the same category and offer one or two options) or ask if they'd like something else. Never leave the conversation at a dead end. If the customer pushes back or asks again ("are you sure?", asking about the same item a second time), call search_menu again rather than repeating your earlier answer — the menu can change mid-conversation (staff may update it live), and your first search might have used the wrong search term.
6. When they're ready to order, use suggest_items to show a running summary, then confirm_order only after they explicitly say it's correct.
7. MANDATORY, every single first order in a conversation: before you say "should I go ahead with that?" for the FIRST TIME, you must first ask "would you like a bag for $0.25?" — this is not optional and not something to skip even if the order seems simple. Search_menu for "bag" and add it if they say yes. Do not proceed to the order-confirmation preview until you've asked this once. Never ask it again for later additions or later orders in the same conversation — just this one time, right before the very first confirmation preview.
8. Keep responses short and friendly, like a cashier taking an order — not a scripted bot.
9. If asked something unrelated to ordering from this restaurant, politely say you can only help with the menu and orders here, and call flag_off_topic in that same turn. Do this every time it happens, even if you already warned them once — the system tracks the count and ends the conversation automatically after a few, you don't need to count it yourself. If the tool result comes back with limit_reached: true, say a brief, polite goodbye (e.g. "Sorry, I need to wrap up this conversation since it's moved away from ordering — feel free to start a new chat anytime!") and don't continue answering further off-topic questions after that.
10. Talking to a human is ONLY for when the customer explicitly asks for it — words like "talk to a person/agent/human/staff", "real person", "can I speak to someone". Collecting name and phone is part of EVERY normal order and does not, by itself, mean they want a human — never call flag_wants_human just because you happen to have just gotten their name and phone for an order. If they HAVE explicitly asked: take it seriously right away, at ANY point, even before ordering, even before OTP verification. Check first: did they already give their name and phone earlier in this conversation? If so, don't ask again — just call flag_wants_human immediately. If you don't have it yet, ask ONCE — but if they refuse, say they can't, or insist on skipping it ("just connect me", "I can't"), don't ask again — call flag_wants_human anyway. It works without a name or phone; staff can decide from there. Once flagged, tell them warmly that a team member will join shortly.
11. A simple "can I add more?" or "can I change something?" is a NORMAL continuation — never a reason to offer a reset. Just use check_order_status to see what they currently have, then help with the add/change like any other request (e.g. a reduction on an accepted order still goes through flag_order_for_staff_review as usual). Only consider offering a reset when things have gotten genuinely tangled — several separate edits or cancellations have already happened in this same conversation (three or more back-and-forth changes), not just one prior edit. Even then, ask first: "would you like to reset and start fresh, or should I just recap what you currently have?" — don't assume they want a reset. If they say yes, call reset_orders and relay its result honestly (some orders may only get flagged for staff, not cancelled outright, if already accepted — don't claim everything is cancelled when it isn't). If they say no, or a reset was never warranted in the first place, just recap their current open orders and continue normally.

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

Checking an existing order: any question about an order's status, total, or contents — "what's the status of my order", "how much longer", "how much is my total", "what did I order" — always means call check_order_status, no matter where in the conversation it comes up. This includes an order you don't remember placing yourself (e.g. one a staff member finalized during a live handoff) — you may not have it in your own memory of this conversation, but it's real and check_order_status will find it. If you already know their phone number from earlier in this conversation, use it directly — don't ask again. If you don't have it yet, just ask for their phone number and call check_order_status. No verification needed for this, it's read-only, and it is never off-topic. Each order comes back with a status_message already written for you — use that instead of calculating your own "ready in X minutes," since it already accounts for orders running late. If they have more than one open order, mention each one's status_message and, if there's more than one, the combined_total — frame it as one running tab, not unrelated charges.

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

Reducing or removing from an order that's already accepted: you can't do this yourself — the kitchen may already be preparing it. Just call flag_order_for_staff_review with a plain description of what they asked for — you don't need to look up the order_id yourself first. If the customer has more than one open order, the tool will tell you and give you the list with items so you can immediately retry with the right one specified — you don't need a separate check_order_status call for this. Don't try workarounds like creating a new order for the same items — that would double-charge them.

After flagging, be explicit that this is NOT cancelled yet and isn't guaranteed — the order has already been started, so staff needs to confirm whether it can actually be changed. Tell them clearly they can either wait (staff will join the chat shortly) or call the store directly (use the store's phone number from the known facts below) if they'd rather sort it out that way. Never imply or say the cancellation/change has already happened just because you flagged it.

Always state the GST breakdown when confirming an order — never just say "your total is $X." Say something like "subtotal $A, plus GST $B, comes to $C total" so the customer isn't surprised by the number.`;

const tools = [
  {
    name: 'request_otp',
    description: 'Register the customer and issue a one-time verification code. The result includes demo_code — relay that value to the customer EXACTLY as returned, never a number you compose yourself.',
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
    description: 'Search the menu by category, keyword, or dietary filter. When the customer names a specific item (e.g. "Halo-Halo"), search by keyword — don\'t guess a category name, since category matching needs to be reasonably close to the real category and a wrong guess returns nothing even if the item exists. Always returns live, current data — call this fresh every time, even for an item you already searched earlier in this conversation, rather than repeating an earlier answer from memory.',
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
    description: 'Use this when a customer wants to reduce, remove, or change something on an order that has ALREADY been accepted by the store — this can never be automated safely since the kitchen may already be preparing it. If the customer has only one open order, you can omit order_id — it\'ll be used automatically. If they have more than one, you MUST specify which one — call check_order_status first to see all of them (with items) and pick the one matching what the customer described. Never guess between multiple open orders.',
    input_schema: {
      type: 'object',
      properties: {
        order_id: { type: 'string', description: 'Only needed if the customer has more than one open order — get this from check_order_status.' },
        request_description: { type: 'string', description: 'Plain description of what the customer wants changed, for staff to read.' }
      },
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
    description: 'ONLY call this when the customer has EXPLICITLY asked to talk to a real person, staff, an agent, or a human — words like "talk to a person/agent/human/staff/representative", "real person", "can I speak to someone". Do NOT call this just because you\'re collecting their name and phone for a normal order — that happens for every order and does not mean they asked for a human. If they haven\'t explicitly asked for a human, never call this tool, no matter what else is happening in the conversation. Once they HAVE explicitly asked, you can ask for their name and phone once so staff can reach them — but if they refuse or insist on skipping it, don\'t keep pushing; just call this tool anyway. It works without identity info too.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'reset_orders',
    description: 'RARE — only use after the customer explicitly agreed to a reset you offered, and only offer that in the first place when several edits/cancellations have already piled up in this conversation. A normal "can I add more?" is NOT a reason to reach for this. Cancels and clears the customer\'s open orders so they can start fresh. Orders still in "new" status are cancelled immediately. Any already-accepted order can\'t be cancelled automatically — those get flagged for staff instead, same as any other change to an accepted order.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'update_guest_info',
    description: 'Use this to give a real name and phone number to a customer who was previously anonymous (skipped identifying themselves to reach a human) but now has an actual order placed. This does NOT trigger OTP verification — it just records real contact info for staff.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        phone: { type: 'string' }
      },
      required: ['name', 'phone']
    }
  },
  {
    name: 'note_otp_reminder_sent',
    description: 'Call this every time you have to remind the customer they still need to provide their verification code, after already asking once. Tracks how many reminders have been sent — after the limit, the system ends the conversation automatically.',
    input_schema: { type: 'object', properties: {} }
  },
  {
    name: 'note_guest_info_reminder_sent',
    description: 'Call this every time you ask an anonymous guest (with an order already placed) for their real name/phone and they decline or don\'t answer. After 3 of these, the system ends the conversation automatically and directs them to call the store.',
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
  if (category) query = query.ilike('category', `%${category}%`);
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
      order_id: order.id,
      order_number: order.order_number,
      status: order.status,
      remaining_minutes: remaining,
      total: order.total,
      items: order.items,
      status_message
    };
  });

  const result = { orders: mapped };
  if (mapped.length > 1) {
    result.combined_total = mapped.reduce((sum, o) => sum + Number(o.total), 0).toFixed(2);
  }
  return result;
}

async function flagOrderForReview({ order_id, request_description }, tenantId, customerId) {
  let targetOrderId = order_id;

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
        error: 'This customer has more than one open order — order_id is required.',
        open_orders: openOrders.map((o) => ({ order_id: o.id, order_number: o.order_number, items: o.items })),
        note_for_ai: 'Pick the order_id that matches what the customer described, then call flag_order_for_staff_review again with it.'
      };
    }
  }

  const { data, error } = await supabase
    .from('orders')
    .update({ needs_attention: true, attention_note: request_description })
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
      // Already accepted — same rule as everywhere else: can't cancel
      // automatically, needs a human to confirm with the kitchen.
      const { error } = await supabase
        .from('orders')
        .update({ needs_attention: true, attention_note: 'Customer asked to reset/start over — please confirm cancellation with them.' })
        .eq('id', order.id);
      if (!error) flaggedForStaff.push(order.order_number);
    }
  }

  return { ok: true, cancelled, flagged_for_staff: flaggedForStaff };
}

async function updateGuestInfo({ name, phone }, tenantId, customerId) {
  if (!customerId) return { error: 'No customer to update.' };
  const digits = phone.replace(/\D/g, '');

  // Don't silently merge into or overwrite a DIFFERENT existing customer
  // that already owns this phone number — that's a real conflict a human
  // should sort out, not something to resolve automatically.
  const { data: conflict } = await supabase
    .from('customers')
    .select('id')
    .eq('tenant_id', tenantId)
    .eq('phone', digits)
    .neq('id', customerId)
    .maybeSingle();
  if (conflict) {
    return { error: 'That phone number is already associated with a different account — let the customer know staff will need to sort this out, and don\'t update it yourself.' };
  }

  const { error } = await supabase.from('customers').update({ name, phone: digits }).eq('id', customerId);
  if (error) return { error: error.message };
  return { ok: true };
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
  const {
    message, history = [], token,
    customerId: claimedCustomerId, customerAuth, orderId: claimedOrderId,
    offTopicCount, otpReminderCount, guestInfoReminderCount
  } = req.body;

  // verify the Turnstile-issued session token before anything else
  const session = verifyToken(token);
  if (!session) return res.status(401).json({ error: 'Session expired or invalid. Please refresh.' });

  const tenant = await getTenant();
  if (!tenant) return res.status(500).json({ error: 'Configuration error.' });
  const tenantId = tenant.id;
  const activeProvider = tenant.aiProvider; // per-tenant switch, no redeploy needed to change it

  // A client-claimed customerId is only trusted once its accompanying
  // customerAuth proves the caller was actually issued that identity by this
  // backend (see verifyCustomerToken above) — otherwise anyone could act as
  // or read any other customer just by sending their UUID. Falls back to
  // "no identity yet" (same as a brand-new visitor) if the check fails,
  // rather than erroring, so a stale/missing token just re-starts the flow.
  const customerId = (claimedCustomerId && verifyCustomerToken(customerAuth, claimedCustomerId, tenantId))
    ? claimedCustomerId
    : null;
  const orderId = customerId ? (claimedOrderId || null) : null;

  // Fetch the customer's current state once, up front — used to decide
  // whether they're mid-takeover AND whether the off-topic penalty should
  // apply at all. Someone who's asked for a human shouldn't get their chat
  // closed for "going off topic" while they wait — that's backwards.
  let customerState = null;
  if (customerId) {
    const { data } = await supabase.from('customers').select('takeover_active, wants_human, phone_verified, phone, name').eq('id', customerId).eq('tenant_id', tenantId).maybeSingle();
    customerState = data;
    supabase.from('customers').update({ last_active_at: new Date().toISOString() }).eq('id', customerId).then(() => { }); // fire-and-forget, not on the critical path
  }
  let humanRequested = customerState?.wants_human || false;

  // Conversation already ended for being off-topic too many times — don't
  // spend a single token on a reply the customer can't act on anyway.
  // Suspended entirely once a human has been requested — waiting for staff
  // isn't "going off topic."
  if (offTopicCount >= MAX_OFF_TOPIC_WARNINGS && !humanRequested) {
    return res.status(200).json({
      reply: "This conversation's been closed since it's moved away from ordering — feel free to refresh and start a new one anytime you'd like to order.",
      conversationEnded: true,
      offTopicCount
    });
  }

  // Same for a customer who was asked for their verification code and
  // never provided it, even after a reminder.
  if (otpReminderCount >= MAX_OTP_REMINDERS && !humanRequested) {
    return res.status(200).json({
      reply: "We weren't able to verify your number, so I have to close this chat for now — feel free to start a new one anytime and we can try again.",
      conversationEnded: true,
      otpReminderCount
    });
  }

  // Same for an anonymous guest who keeps declining to give real contact
  // info even after their order is placed — after enough reminders, end
  // the chat and point them to the store's real phone number.
  if (guestInfoReminderCount >= MAX_GUEST_INFO_REMINDERS && !humanRequested) {
    return res.status(200).json({
      reply: `I'm sorry, but we can't complete this order without a way to reach you — please call the store directly at ${tenant.contactPhone} if you'd like to order by phone instead.`,
      conversationEnded: true,
      guestInfoReminderCount
    });
  }

  // Lightweight polling path — the widget calls this every ~15s. Message
  // checking works from the moment a session exists (no order needed, so a
  // customer can be in an active takeover before ever placing an order);
  // order status only applies once orderId exists.
  if (req.body.checkStatus) {
    let statusPayload = {};

    if (orderId) {
      const { data: order } = await supabase
        .from('orders')
        .select('order_number, status, eta_minutes, accepted_at, total, items, cancellation_reason')
        .eq('id', orderId)
        .eq('tenant_id', tenantId)
        .eq('customer_id', customerId)
        .maybeSingle();
      if (order) {
        statusPayload = {
          status: order.status,
          eta_minutes: order.eta_minutes,
          remaining_minutes: computeRemainingMinutes(order),
          total: order.total,
          order_number: order.order_number,
          items: order.items,
          cancellation_reason: order.cancellation_reason
        };
      }
    }

    let takeoverActive = false;
    if (customerId) {
      const { data: cust } = await supabase.from('customers').select('takeover_active').eq('id', customerId).maybeSingle();
      takeoverActive = cust?.takeover_active || false;
    }

    let newMessages = [];
    if (req.body.messagesSince && customerId) {
      const { data: msgs } = await supabase
        .from('conversation_messages')
        .select('sender, message, created_at')
        .eq('tenant_id', tenantId)
        .eq('customer_id', customerId)
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
  if (customerState?.takeover_active) {
    await supabase.from('conversation_messages').insert({
      tenant_id: tenantId,
      session_id: session.sessionId,
      customer_id: customerId,
      order_id: orderId || null,
      sender: 'customer',
      message
    });
    return res.status(200).json({
      reply: null,
      takeoverActive: true,
      customerId,
      customerAuth: customerId ? signCustomerToken(customerId, tenantId) : null,
      phoneVerified: customerState?.phone_verified || false,
      orderId,
      offTopicCount
    });
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
  // Never trust the client's own phoneVerified claim — always re-derive it
  // fresh from the DB, which is what actually gets set by verify_otp.
  let currentPhoneVerified = customerState?.phone_verified || false;
  let currentOrderId = orderId || null;
  let currentOffTopicCount = offTopicCount || 0;
  let currentOtpReminderCount = otpReminderCount || 0;
  let currentGuestInfoReminderCount = guestInfoReminderCount || 0;

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
    if (name === 'flag_order_for_staff_review') return flagOrderForReview(input, tenantId, currentCustomerId);
    if (name === 'reset_orders') return resetOrders(tenantId, currentCustomerId);
    if (name === 'update_guest_info') return updateGuestInfo(input, tenantId, currentCustomerId);
    if (name === 'flag_off_topic') {
      currentOffTopicCount += 1;
      return { count: currentOffTopicCount, limit_reached: currentOffTopicCount >= MAX_OFF_TOPIC_WARNINGS && !humanRequested };
    }
    if (name === 'note_otp_reminder_sent') {
      currentOtpReminderCount += 1;
      return { count: currentOtpReminderCount, limit_reached: currentOtpReminderCount >= MAX_OTP_REMINDERS && !humanRequested };
    }
    if (name === 'note_guest_info_reminder_sent') {
      currentGuestInfoReminderCount += 1;
      return { count: currentGuestInfoReminderCount, limit_reached: currentGuestInfoReminderCount >= MAX_GUEST_INFO_REMINDERS && !humanRequested };
    }
    if (name === 'flag_wants_human') {
      let idToUse = currentCustomerId;

      if (!idToUse) {
        // They're insisting on a human but won't give name/phone — let them
        // through anyway rather than gatekeeping. Staff just won't be able
        // to ban this specific request later without a phone number, which
        // is a real limitation they can weigh themselves case by case.
        const { data: anon, error: createErr } = await supabase
          .from('customers')
          .insert({ tenant_id: tenantId, name: 'Guest (no info given)', phone: null, last_session_id: session.sessionId })
          .select()
          .single();
        if (createErr) return { error: createErr.message };
        idToUse = anon.id;
        currentCustomerId = idToUse;
      }

      const { error } = await supabase.from('customers').update({ wants_human: true, last_session_id: session.sessionId }).eq('id', idToUse);
      if (error) return { error: error.message };
      humanRequested = true;
      return { flagged: true };
    }
    if (name === 'confirm_order') {
      const result = await confirmOrder(input, tenantId, currentCustomerId, currentPhoneVerified, currentOrderId, session.sessionId);
      if (result.order_id) currentOrderId = result.order_id;
      return result;
    }
    return { error: 'Unknown tool' };
  }

  // Build the actual system prompt used for THIS call — the static prompt
  // plus fresh facts pulled straight from the database. This exists so the
  // AI never has to rely on its own (possibly incomplete) memory of the
  // conversation for things like "is this customer verified" — especially
  // important after a staff takeover, where verification can happen
  // through a path the AI never itself witnessed.
  let dynamicSystemPrompt = SYSTEM_PROMPT;
  if (customerId) {
    let factsNote = `\n\nKnown facts about this customer, pulled fresh from the database — trust this over your own memory of the conversation, since some of this may have happened outside what you can see (e.g. a staff member verifying them directly):\n- Store phone number (use this whenever you tell a customer to call the store): ${tenant.contactPhone}\n- Phone verified: ${customerState?.phone_verified ? 'YES — do not ask for or mention verification again' : 'not yet'}`;

    const { data: recentOrder } = await supabase
      .from('orders')
      .select('order_number, items, total, status')
      .eq('customer_id', customerId)
      .not('status', 'in', '(completed,cancelled)')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle();
    if (recentOrder) {
      const itemsSummary = recentOrder.items.map((i) => `${i.qty}x ${i.name}`).join(', ');
      factsNote += `\n- Most recent open order: #${recentOrder.order_number} (${recentOrder.status}) — ${itemsSummary}, total $${recentOrder.total}`;

      if (!customerState?.phone) {
        factsNote += `\n- This customer is ANONYMOUS (skipped giving name/phone to reach a human) but now has a real order placed. If you haven't already asked in this conversation, politely ask for their real name and phone now — explain it's so staff can contact them if there's any issue and identify them at pickup. Once they give it, call update_guest_info. If they decline or don't answer, call note_guest_info_reminder_sent — after a few of these the system will end the conversation and point them to call the store instead, so you don't need to track the count yourself.`;
      }
    } else {
      factsNote += `\n- No open orders currently.`;
    }
    dynamicSystemPrompt = SYSTEM_PROMPT + factsNote;
  }

  try {
    const { text: replyText, inputTokens, outputTokens } =
      activeProvider === 'openai' ? await runOpenAiLoop(messages, runTool, dynamicSystemPrompt) : await runClaudeLoop(messages, runTool, dynamicSystemPrompt);

    const pricing = PRICING[activeProvider] || PRICING[AI_PROVIDER_DEFAULT];
    const costUsd = inputTokens * pricing.input + outputTokens * pricing.output;

    await supabase.from('chat_logs').insert({
      tenant_id: tenantId,
      source: TENANT_SLUG,
      session_id: session.sessionId,
      customer_id: currentCustomerId || null,
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
      customerAuth: currentCustomerId ? signCustomerToken(currentCustomerId, tenantId) : null,
      phoneVerified: currentPhoneVerified,
      orderId: currentOrderId,
      offTopicCount: currentOffTopicCount,
      otpReminderCount: currentOtpReminderCount,
      guestInfoReminderCount: currentGuestInfoReminderCount,
      conversationEnded:
        (currentOffTopicCount >= MAX_OFF_TOPIC_WARNINGS ||
          currentOtpReminderCount >= MAX_OTP_REMINDERS ||
          currentGuestInfoReminderCount >= MAX_GUEST_INFO_REMINDERS) &&
        !humanRequested
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
async function runClaudeLoop(messages, runTool, systemPrompt) {
  let response = await callClaude(messages, systemPrompt);
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
    response = await callClaude(messages, systemPrompt);
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
async function runOpenAiLoop(messages, runTool, systemPrompt) {
  let data = await callOpenAI(messages, systemPrompt);
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

    data = await callOpenAI(messages, systemPrompt);
    message = data.choices[0].message;
    inputTokens += data.usage?.prompt_tokens || 0;
    outputTokens += data.usage?.completion_tokens || 0;
  }

  messages.push(message);
  return { text: message.content || '', inputTokens, outputTokens };
}

// Fix #7 + #8: timeout on the upstream call, and check response.ok before
// trusting the shape of the body (data.content might not exist on an error)
async function callClaude(messages, systemPrompt) {
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
      body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 1024, system: systemPrompt, tools, messages }),
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
async function callOpenAI(messages, systemPrompt) {
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
        messages: [{ role: 'system', content: systemPrompt }, ...messages],
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