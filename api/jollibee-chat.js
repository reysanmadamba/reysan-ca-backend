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

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');
const { verifyToken } = require('./jollibee-captcha');

const TENANT_SLUG = 'jollibee'; // default demo tenant this chat serves

// Toggle which LLM provider handles the conversation — same pattern as
// your other demos, single constant, no other code changes needed.
const AI_PROVIDER = 'claude'; // 'claude' | 'openai'
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';
const OPENAI_MODEL = 'gpt-4o-mini';
const ALLOWED_ORIGINS = ['https://reysan.ca'];
const ALLOWED_AREA_CODES = ['587', '780']; // Edmonton — soft flag only, never blocks

const MAX_PER_SESSION_PER_HOUR = 20;
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
5. Use search_menu for any menu question — never invent items, prices, or availability.
6. When they're ready to order, use suggest_items to show a running summary, then confirm_order only after they explicitly say it's correct.
7. Keep responses short and friendly, like a cashier taking an order — not a scripted bot.
8. If asked something unrelated to ordering food, politely redirect back to the menu.

Be a good cashier, not a search box. Real cashiers make conversation and suggest things:
- If the customer seems unsure what to get, ask a light question first — "feeling like chicken today, or something else?" — instead of just listing the whole menu.
- Mention what's popular naturally when it fits, e.g. "the Chickenjoy's our best seller if you want something classic."
- When they've picked mains, suggest a natural add-on once — a side, a drink, or dessert — the way a cashier would ask "you want fries with that?" Don't push if they decline once.
- Occasionally reference a specific item conversationally — "have you tried the Halo-Halo? it's a customer favorite" — instead of always waiting to be asked.
- Keep all of this to short, casual asides. One suggestion at a time, never a list of five things back to back. If the customer just wants to order fast and says so, drop the suggestions and take the order.`;

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
        description: 'Place the order once the customer has explicitly confirmed. Only callable after verify_otp has succeeded.',
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
    }
];

// OpenAI expects tools wrapped in { type: 'function', function: {...} } —
// same definitions, just reshaped, so the two schemas can't drift apart.
const openaiTools = tools.map((t) => ({
    type: 'function',
    function: { name: t.name, description: t.description, parameters: t.input_schema }
}));

async function getTenant() {
    const { data } = await supabase.from('tenants').select('id').eq('slug', TENANT_SLUG).single();
    return data?.id;
}

async function requestOtp({ name, phone }, tenantId) {
    const digits = phone.replace(/\D/g, '');
    const areaCode = digits.slice(-10, -7); // last 10 digits, first 3 = area code
    const areaCodeFlag = !ALLOWED_AREA_CODES.includes(areaCode);

    let { data: customer } = await supabase
        .from('customers')
        .select('*')
        .eq('tenant_id', tenantId)
        .eq('phone', phone)
        .maybeSingle();

    if (!customer) {
        const { data: newCustomer, error } = await supabase
            .from('customers')
            .insert({ tenant_id: tenantId, name, phone, area_code_flag: areaCodeFlag })
            .select()
            .single();
        if (error) return { error: error.message };
        customer = newCustomer;
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

async function confirmOrder({ items, note }, tenantId, customerId, phoneVerified) {
    if (!phoneVerified) return { error: 'Phone number must be verified before placing an order.' };
    const subtotal = items.reduce((sum, i) => sum + i.qty * i.price, 0);
    const { data, error } = await supabase
        .from('orders')
        .insert({
            tenant_id: tenantId,
            customer_id: customerId,
            items,
            subtotal: subtotal.toFixed(2),
            note: note || null,
            status: 'new'
        })
        .select()
        .single();
    if (error) return { error: error.message };
    return { order_id: data.id, subtotal: data.subtotal, status: data.status };
}

module.exports = async (req, res) => {
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
    const { message, history = [], token, customerId, phoneVerified } = req.body;

    // verify the Turnstile-issued session token before anything else
    const session = verifyToken(token);
    if (!session) return res.status(401).json({ error: 'Session expired or invalid. Please refresh.' });

    const tenantId = await getTenant();
    if (!tenantId) return res.status(500).json({ error: 'Configuration error.' });

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
        return res.status(200).json({ reply: "We've hit the limit for this chat session. Please refresh to start a new order." });
    }

    const ipCount = await bumpRateLimit(`${TENANT_SLUG}:ip:${clientIp}:hour`, 3600);
    if (ipCount !== null && ipCount > MAX_PER_IP_PER_HOUR) {
        return res.status(429).json({ error: 'Too many requests. Please try again later.' });
    }

    const messages = [...history, { role: 'user', content: message }];
    let currentCustomerId = customerId || null;
    let currentPhoneVerified = phoneVerified || false;

    // Shared dispatcher — same tool execution regardless of which provider
    // asked for it, so behavior can't drift between the two.
    async function runTool(name, input) {
        if (name === 'request_otp') {
            const result = await requestOtp(input, tenantId);
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
        if (name === 'confirm_order') return confirmOrder(input, tenantId, currentCustomerId, currentPhoneVerified);
        return { error: 'Unknown tool' };
    }

    try {
        const replyText =
            AI_PROVIDER === 'openai' ? await runOpenAiLoop(messages, runTool) : await runClaudeLoop(messages, runTool);

        await supabase.from('chat_logs').insert({
            tenant_id: tenantId,
            source: TENANT_SLUG,
            session_id: session.sessionId,
            question: message,
            answer: replyText,
            ip: clientIp
        });

        return res.status(200).json({
            reply: replyText,
            history: messages, // mutated in place by whichever provider loop ran
            customerId: currentCustomerId,
            phoneVerified: currentPhoneVerified
        });
    } catch (err) {
        console.error('restaurant-chat error', err);
        return res.status(500).json({ error: 'Something went wrong, please try again.' });
    }
};

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
// so the caller can persist it as history for the next request.
async function runClaudeLoop(messages, runTool) {
    let response = await callClaude(messages);

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
    }

    messages.push({ role: 'assistant', content: response.content });
    const textBlock = response.content.find((b) => b.type === 'text');
    return textBlock ? textBlock.text : '';
}

// OpenAI loop — mutates `messages` in place too, but in OpenAI's flatter
// { role, content, tool_calls } shape, which is NOT interchangeable with
// Claude's block format above. Don't mix history between providers mid-session.
async function runOpenAiLoop(messages, runTool) {
    let message = await callOpenAI(messages);

    while (message.tool_calls && message.tool_calls.length > 0) {
        messages.push(message);

        for (const call of message.tool_calls) {
            const input = JSON.parse(call.function.arguments || '{}');
            const result = await runTool(call.function.name, input);
            messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
        }

        message = await callOpenAI(messages);
    }

    messages.push(message);
    return message.content || '';
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

        return data.choices[0].message;
    } finally {
        clearTimeout(timeout);
    }
}