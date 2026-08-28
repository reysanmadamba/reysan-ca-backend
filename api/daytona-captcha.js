import crypto from 'crypto';

// EDIT HERE: swap in the demo site's real domain(s) once deployed
const allowedOrigins = ['https://reysan.ca', 'https://test.local'];

const SESSION_TOKEN_TTL_HOURS = 6;

function sign(payload) {
  const hmac = crypto.createHmac('sha256', process.env.CAPTCHA_SECRET).update(payload).digest('hex');
  return Buffer.from(payload).toString('base64') + '.' + hmac;
}

function verify(token) {
  if (!token || typeof token !== 'string' || !token.includes('.')) return null;
  const [b64, hmac] = token.split('.');
  let payload;
  try {
    payload = Buffer.from(b64, 'base64').toString('utf8');
  } catch {
    return null;
  }
  const expected = crypto.createHmac('sha256', process.env.CAPTCHA_SECRET).update(payload).digest('hex');
  if (expected !== hmac) return null;
  return payload;
}

export default async function handler(req, res) {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const sessionId = (req.body && req.body.sessionId) || '';
  if (!sessionId) {
    return res.status(400).json({ error: 'sessionId required' });
  }

  const hasAnswer = req.body && typeof req.body.answer !== 'undefined' && req.body.challengeToken;

  // MODE 1 — no answer submitted yet: generate a new challenge
  if (!hasAnswer) {
    const a = Math.floor(Math.random() * 8) + 1; // 1-8
    const b = Math.floor(Math.random() * 8) + 1; // 1-8
    const answer = a + b;

    const challengeToken = sign(`challenge:${a}:${b}:${answer}`);

    return res.status(200).json({
      question: `${a} + ${b} = ?`,
      challengeToken
    });
  }

  // MODE 2 — answer submitted: verify it, issue a session token
  const challengePayload = verify(req.body.challengeToken);
  if (!challengePayload) {
    return res.status(400).json({ error: 'Invalid or expired challenge, request a new one' });
  }

  const parts = challengePayload.split(':'); // "challenge:a:b:answer"
  const correctAnswer = Number(parts[3]);
  const submittedAnswer = Number(req.body.answer);

  if (submittedAnswer !== correctAnswer) {
    return res.status(400).json({ error: 'Incorrect answer', correct: false });
  }

  const expiresAtMs = Date.now() + SESSION_TOKEN_TTL_HOURS * 60 * 60 * 1000;
  const sessionToken = sign(`${sessionId}:${expiresAtMs}`);

  res.status(200).json({ correct: true, sessionToken });
}

// Exported so chat.js can validate session tokens issued here
export function verifySessionToken(token) {
  const payload = verify(token);
  if (!payload) return false;

  const parts = payload.split(':'); // "sessionId:expiresAtMs"
  const expiresAtMs = Number(parts[1]);
  if (!expiresAtMs || Date.now() > expiresAtMs) return false;

  return true;
}