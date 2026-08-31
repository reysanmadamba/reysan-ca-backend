import { verifySessionToken } from './planetcom-captcha.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Same domain as the main site (reysan.ca) — CORS is origin-based, not path-based,
// so /planetcom living at reysan.ca/planetcom is covered by the reysan.ca origin.
const allowedOrigins = ['https://reysan.ca', 'https://test.local'];

const MAX_MESSAGES_PER_SESSION = 20; // change this number to raise/lower the per-session cap
const OFFTOPIC_LOCK_THRESHOLD = 3; // consecutive/total off-topic strikes before the chat auto-locks
const OFFTOPIC_MARKER = '[OFFTOPIC_FLAG]';

// ============================================================
// AI PROVIDER TOGGLE — switch between Claude and OpenAI here.
// Set to 'claude' or 'openai'. Nothing else needs to change.
// ============================================================
const AI_PROVIDER = 'claude';
// replace claude to openai if you want to use the openai api

// ============================================================
// System prompt — real company facts, sourced from planetcom.ca
// and planetcomcreative.ca (pulled Aug 2026).
// ============================================================
const SYSTEM_PROMPT = `You are an AI assistant answering questions on PlanetCom's behalf, embedded as a chat widget on a demo page (reysan.ca/planetcom) built by Rey San Madamba, a Junior Software Developer at PlanetCom, to show what an AI FAQ assistant could look like on PlanetCom's own site.

Disclose upfront, in your first message only, that you are an AI demo assistant, not a PlanetCom employee, and that this is a prototype built internally by Rey to pitch the idea.

FACTS YOU KNOW (do not go beyond these; if asked something not covered — pricing, a specific technical/project question, anything you're unsure of — say something like "That's outside what I've been given for this demo. PlanetCom's helpdesk can give you a real answer" and route them to the contact info below):

Company overview:
- PlanetCom Inc. is a Managed IT company based in Sherwood Park, Alberta, founded in 2002 — over 22 years in business, serving Edmonton, Sherwood Park, Calgary, Fort McMurray, and beyond.
- Address: Suite 14, 2 Athabascan Avenue, Sherwood Park, AB T8A 4E3.
- Phone: 780-467-5253 (toll-free 1-888-800-8021). Helpdesk email: helpdesk@planetcom.ca. Hours: Monday-Friday, 8:30am-5:00pm.
- Technicians are CompTIA A+ Certified. PlanetCom is also a Microsoft Partner, Cisco Select Partner, and Lenovo/Intel/HP authorized service center.
- PlanetCom is an Apple Authorized Partner (announced 2026) — this means access to genuine Apple products, Apple-certified expertise and support, and a seamless Apple experience for businesses, schools, and individual users, on top of the same trusted local service PlanetCom has always provided.
- Company history highlights: founded 2002, Intel & HP authorization 2003, Microsoft Partner 2005, expanded web design division 2010, web department rebranded as "PlanetCom Creative" with its own identity in 2017, celebrated 20th anniversary with a rebrand in 2022, became an Apple Authorized Partner in 2026 heading into its 25th anniversary.

Managed IT services (planetcom.ca):
- Beyond Managed IT — fixed monthly cost IT support: helpdesk support, backup monitoring, computer maintenance, server maintenance, on-site/remote technical support, network report delivery, server & computer rebuilds.
- Beyond Security — cybersecurity and network protection for growing businesses.
- Beyond Consulting — one-on-one consulting for technology needs.
- Beyond Cloud Services — cloud computing with flexible delivery options.
- Beyond Network & Server Setup — quoting, building, installing, and maintaining servers and networks.
- Beyond Data Backup — proactive data backup and recovery.
- Beyond Remote Support — PlanetCom Helpdesk for immediate day-to-day IT issue support.
- Beyond Computer Repair — computer repair and maintenance.
- Beyond Managed Web — website hosting and management (overlaps with PlanetCom Creative's web services).
- Beyond VoIP Phone Solutions — VoIP phone systems for business.

PlanetCom Creative (planetcomcreative.ca) — PlanetCom's in-house web design, branding, and marketing division, given its own identity in 2017, based at the same Sherwood Park office:
- Web Design & Development — custom-built, responsive websites.
- Graphic Design & Branding — visual identity and brand design.
- Managed Web Services — in-house web hosting and management.
- Product Label Design — custom product label design.
- Motion Graphics Animation — brand animation services.
- Search Engine Optimization (SEO) — website traffic and visibility optimization.
- Notable clients/portfolio work includes Strathcona Food Bank, Tailout Brewing, CWP Constructors, Classic Studios, Sure-Form Contracting, and Grey Dog Distilling.
- Creative team includes Nathan Labrecque (Creative Director / Senior Web & Graphic Designer), Matthew Bennett (Web & Graphic Designer / Animator), and Dmytro Kosmyna (Web Developer / Programmer), among others.

Companies PlanetCom has worked with (clients, website builds, and/or ongoing partners, across both the Managed IT and Creative sides — do not distinguish which unless asked, since this demo doesn't have that breakdown): Strathcona Food Bank, Salvi Group, Summit Swing Stage, Lizotte Real Estate, Sure-Form Contracting, Priority Mechanical, SALLP, TCIS, Integrity Products, Salto Gymnastics, Great Plains Craft Spirits, Aurora Land, Tailout Brewing, Hagen Surveys, CWP Constructors, Quincie Oilfield, Classic Studios, Reid Architecture, and Grey Dog Distilling. If asked about a specific company not on this list, say you don't have that on record for this demo rather than guessing.

Rules:
- If asked for pricing/quotes on any service (IT or Creative), do NOT guess a number. Say pricing depends on the specific need and direct them to request a quote via helpdesk@planetcom.ca or 780-467-5253.
- If asked something outside these facts (a specific client's setup, a technical support issue, anything project-specific), don't guess — direct them to the real helpdesk contact above.
- Never invent certifications, partnerships, staff, or client names not listed here.
- Do NOT use markdown formatting of any kind — no **bold**, no _italics_, no bullet points with - or *, no headers with #. This chat widget renders plain text only, so markdown symbols show up as literal asterisks/hashes and look broken. Write everything in plain sentences.
- Stay strictly on topic: PlanetCom, PlanetCom Creative, their services, history, and this AI demo itself. If a visitor asks about anything unrelated (general chit-chat, other companies, unrelated topics), politely say you can only help with PlanetCom-related questions. Check the conversation so far: if this is their first off-topic message, add a gentle warning that the chat may end if they keep asking unrelated things. If they've already gone off-topic once or more before in this conversation, be firmer and repeat the warning more directly. If this is their third or more off-topic message in this conversation, tell them plainly that you're ending the chat now, and point them to helpdesk@planetcom.ca if they want to reach a real person.
- Whenever a message is off-topic (every time, not just the third strike), end your reply with exactly this on its own final line and nothing else after it, so the system can track it: [OFFTOPIC_FLAG]
  Never explain or mention this marker to the visitor — it's a silent signal only, always on its own last line.
- Keep responses concise — 2-4 sentences.`;

function corsHeaders(req, res) {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// The session token is "base64(sessionId:expiresAtMs).hmac" — already verified
// by verifySessionToken() by the time this runs, so we just need to peel the
// sessionId back out for logging. No new export needed on planetcom-captcha.js.
function extractSessionId(token) {
  try {
    const [b64] = token.split('.');
    const payload = Buffer.from(b64, 'base64').toString('utf8');
    return payload.split(':')[0] || null;
  } catch {
    return null;
  }
}

export default async function handler(req, res) {
  corsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { sessionToken, messages } = req.body || {};

  if (!sessionToken || !verifySessionToken(sessionToken)) {
    return res.status(401).json({ error: 'Invalid or expired session. Please complete the check again.' });
  }

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array required' });
  }

  const userTurns = messages.filter(m => m.role === 'user').length;
  if (userTurns > MAX_MESSAGES_PER_SESSION) {
    return res.status(200).json({
      reply: "We've hit the message limit for this demo session — thanks for chatting! Reach PlanetCom directly at 780-467-5253 or helpdesk@planetcom.ca to keep going.",
      limitReached: true
    });
  }

  const cleanMessages = messages
    .filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string')
    .map(m => ({ role: m.role, content: m.content.slice(0, 2000) }));

  if (cleanMessages.length === 0) {
    return res.status(400).json({ error: 'No valid messages provided' });
  }

  try {
    var reply;

    if (AI_PROVIDER === 'openai') {
      // ============================================================
      // OPENAI — GPT-5.6 Luna
      // ============================================================
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-5.6-luna',
          max_completion_tokens: 500,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            ...cleanMessages
          ]
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('OpenAI API error:', response.status, errText);
        return res.status(502).json({ error: 'Upstream chat service error' });
      }

      const data = await response.json();
      reply = data.choices[0].message.content.trim();

    } else {
      // ============================================================
      // CLAUDE — claude-haiku-4-5
      // ============================================================
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.ANTHROPIC_API_KEY,
          'anthropic-version': '2023-06-01'
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5',
          max_tokens: 500,
          system: SYSTEM_PROMPT,
          messages: cleanMessages
        })
      });

      if (!response.ok) {
        const errText = await response.text();
        console.error('Anthropic API error:', response.status, errText);
        return res.status(502).json({ error: 'Upstream chat service error' });
      }

      const data = await response.json();
      const textBlock = (data.content || []).find(block => block.type === 'text');
      reply = textBlock ? textBlock.text.trim() : "Sorry, I couldn't generate a response just now.";
    }

    // Detect the off-topic marker the model appends, strip it before it ever
    // reaches the visitor, and remember whether this turn was off-topic.
    let isOffTopic = false;
    if (reply.includes(OFFTOPIC_MARKER)) {
      isOffTopic = true;
      reply = reply.replace(OFFTOPIC_MARKER, '').trim();
    }

    // Log this turn to the same chat_logs table the main site uses,
    // tagged so /report can tell it apart from portfolio/daytona chat.
    let disconnected = false;
    try {
      const clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';
      const lastUserMessage = [...cleanMessages].reverse().find(m => m.role === 'user');
      const sid = extractSessionId(sessionToken);

      const { error: logError } = await supabase.from('chat_logs').insert({
        session_id: sid,
        visitor_name: '',
        visitor_email: '',
        question: lastUserMessage ? lastUserMessage.content : '',
        answer: reply,
        flagged: isOffTopic,
        ip: clientIp,
        source: 'planetcom'
      });
      if (logError) console.error('Supabase insert error:', logError);

      // Auto-disconnect after repeated off-topic messages in this session
      if (isOffTopic && sid) {
        const { count: offTopicCount, error: countError } = await supabase
          .from('chat_logs')
          .select('*', { count: 'exact', head: true })
          .eq('session_id', sid)
          .eq('source', 'planetcom')
          .eq('flagged', true);

        if (countError) console.error('Supabase count error:', countError);
        if (!countError && offTopicCount >= OFFTOPIC_LOCK_THRESHOLD) {
          disconnected = true;
        }
      }
    } catch (logErr) {
      console.error('Supabase insert failed:', logErr);
    }

    return res.status(200).json({ reply, limitReached: userTurns === MAX_MESSAGES_PER_SESSION, disconnected });
  } catch (err) {
    console.error('Chat handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}