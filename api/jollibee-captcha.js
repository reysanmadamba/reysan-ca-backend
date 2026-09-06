// api/jollibee-captcha.js
//
// Verifies a Cloudflare Turnstile token, then issues a signed session
// token the chat endpoint will require on every message. Fixes applied
// from the security review (see reysan.ca Chatbot Security TODO):
//
//   #1  correct IP extraction (last hop of x-forwarded-for, not first)
//   #2  CORS is not treated as a security boundary, only browser-JS convenience
//   #4  rate limiting uses the atomic increment_rate_limit() DB function,
//       no count-then-insert race
//   #6  the challenge/verify endpoint itself is rate limited, not just chat
//   #10 constant-time comparison for the session token HMAC

import crypto from 'crypto';
import { createClient } from '@supabase/supabase-js';

const TENANT = 'jollibee';
const SESSION_SECRET = process.env.SESSION_HMAC_SECRET;
const TURNSTILE_SECRET = process.env.TURNSTILE_SECRET_KEY;
const ALLOWED_ORIGINS = ['https://reysan.ca'];

const MAX_CHALLENGES_PER_IP_PER_HOUR = 30; // fix #6 — throttle the endpoint itself

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

// Fix #1: Vercel appends the real client IP as the LAST entry in
// x-forwarded-for. Anything before that is client-supplied and can be
// spoofed. Taking the first entry (a common mistake) trusts attacker input.
function getClientIp(req) {
    const xff = req.headers['x-forwarded-for'];
    if (xff) {
        const parts = xff.split(',').map((p) => p.trim());
        return parts[parts.length - 1];
    }
    return req.socket.remoteAddress || 'unknown';
}

function signToken(payload) {
    const body = JSON.stringify(payload);
    const b64 = Buffer.from(body).toString('base64url');
    const hmac = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');
    return `${b64}.${hmac}`;
}

// Exported so jollibee-chat.js can verify tokens issued here with the
// same constant-time comparison (fix #10 — no string !== comparison on
// secret-derived values, which leaks timing information).
export function verifyToken(token) {
    try {
        const [b64, hmac] = token.split('.');
        const expected = crypto.createHmac('sha256', SESSION_SECRET).update(b64).digest('base64url');

        const a = Buffer.from(hmac);
        const b = Buffer.from(expected);
        if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

        const payload = JSON.parse(Buffer.from(b64, 'base64url').toString());
        const MAX_AGE_MS = 30 * 60 * 1000; // 30 min session validity
        if (Date.now() - payload.issuedAt > MAX_AGE_MS) return null;

        return payload;
    } catch {
        return null;
    }
}

export default async function handler(req, res) {
    const origin = req.headers.origin;
    if (ALLOWED_ORIGINS.includes(origin)) {
        res.setHeader('Access-Control-Allow-Origin', origin);
    }

    // Handle the browser's CORS preflight before anything else. A JSON POST
    // triggers this automatically — without a clean response here, the real
    // request never even gets sent.
    if (req.method === 'OPTIONS') {
        res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
        res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
        return res.status(204).end();
    }

    if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

    const clientIp = getClientIp(req);

    // Fix #6: throttle challenge/verify calls themselves, using the same
    // atomic counter as the chat endpoint (fix #4) — no count-then-insert race.
    const { data: rateData, error: rateErr } = await supabase.rpc('increment_rate_limit', {
        p_key: `${TENANT}:captcha:${clientIp}:hour`,
        p_window_seconds: 3600
    });
    if (rateErr) {
        console.error('rate limit check failed', rateErr);
        return res.status(500).json({ error: 'Something went wrong, please try again.' });
    }
    if (rateData > MAX_CHALLENGES_PER_IP_PER_HOUR) {
        return res.status(429).json({ error: 'Too many attempts. Please try again later.' });
    }

    const { turnstileToken } = req.body;
    if (!turnstileToken) return res.status(400).json({ error: 'Missing verification token' });

    try {
        const verifyResp = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                secret: TURNSTILE_SECRET,
                response: turnstileToken,
                remoteip: clientIp
            })
        });
        const verifyData = await verifyResp.json();

        if (!verifyData.success) {
            return res.status(403).json({ error: 'Verification failed. Please try again.' });
        }

        // issue a short-lived signed session token for the chat endpoint to trust
        const sessionId = crypto.randomUUID();
        const issuedAt = Date.now();
        const token = signToken({ sessionId, tenant: TENANT, issuedAt });

        return res.status(200).json({ sessionId, token });
    } catch (err) {
        console.error('jollibee-captcha error', err);
        return res.status(500).json({ error: 'Something went wrong, please try again.' });
    }
}