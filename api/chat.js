import { createClient } from '@supabase/supabase-js';
import crypto from 'crypto';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

const allowedOrigins = ['https://reysan.ca', 'https://test.local'];

// ============================================================
// AI PROVIDER TOGGLE — switch between Claude and OpenAI here.
// Set to 'claude' or 'openai'. Nothing else needs to change.
// ============================================================
const AI_PROVIDER = 'openai';

// ============================================================
// TUNABLE THRESHOLDS
// ============================================================
const MAX_PER_SESSION = 20;
const MAX_PER_IP_PER_HOUR = 40;
const FLAG_BAN_THRESHOLD = 10;
const BAN_DURATION_DAYS = 3;
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

  var clientIp = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || 'unknown';

  // BAN CHECK
  const { data: banRow } = await supabase
    .from('banned_ips')
    .select('banned_until')
    .eq('ip', clientIp)
    .maybeSingle();

  if (banRow && new Date(banRow.banned_until) > new Date()) {
    return res.status(403).json({ error: 'This IP is temporarily blocked. Try again later.' });
  }

  // CAPTCHA GATE
  var sessionToken = req.body && req.body.sessionToken;
  var payload = verify(sessionToken);

  if (!payload) {
    return res.status(401).json({ error: 'Captcha required', needsCaptcha: true });
  }

  var parts = payload.split(':');
  var tokenSessionId = parts[0];
  var expiresAtMs = Number(parts[1]);

  if (Date.now() > expiresAtMs) {
    return res.status(401).json({ error: 'Captcha expired', needsCaptcha: true });
  }

  if (!req.body || !req.body.message || req.body.message.length > 500) {
    return res.status(400).json({ error: 'Invalid or missing message' });
  }

  var visitorName = req.body.name || '';
  var visitorEmail = req.body.email || '';
  var sessionId = req.body.sessionId || tokenSessionId || '';

  if (sessionId !== tokenSessionId) {
    return res.status(401).json({ error: 'Session mismatch', needsCaptcha: true });
  }

  // RATE LIMITING
  const { count: sessionCount, error: sessionErr } = await supabase
    .from('chat_logs')
    .select('*', { count: 'exact', head: true })
    .eq('session_id', sessionId);

  if (!sessionErr && sessionCount >= MAX_PER_SESSION) {
    return res.status(429).json({ error: 'Message limit reached for this conversation.' });
  }

  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const { count: ipCount, error: ipErr } = await supabase
    .from('chat_logs')
    .select('*', { count: 'exact', head: true })
    .eq('ip', clientIp)
    .gte('created_at', oneHourAgo);

  if (!ipErr && ipCount >= MAX_PER_IP_PER_HOUR) {
    return res.status(429).json({ error: 'Too many messages from this network. Try again later.' });
  }

  const FAQ_CONTEXT = `
Q: Who is Rey San Madamba?
A: A full-stack developer based in Edmonton, AB, and a NAIT Computer Software Development grad. Background in digital marketing and social media management before switching to development.

Q: What technologies does he work with?
A: Languages: C#, JavaScript, HTML, CSS, Java, SQL, Dart. Frameworks: Blazor Server, MudBlazor, React, Node.js, Flutter, Jakarta EE, EF Core. Cloud/tools: Azure, Firebase, Git, GitHub, SQL Server, PostgreSQL, MongoDB.

Q: Is he available for hire?
A: Yes — open to full-stack developer roles in Edmonton and remote. Best reached via email at madambareysan@gmail.com, LinkedIn, or GitHub (linked in the contact section).

Q: What's his biggest project?
A: The OOKs Substitution Solution — a NAIT capstone project with a 10-person team, built with C#, Blazor Server, MudBlazor, EF Core, SQL Server, and Azure. It replaced NAIT's manual instructor substitution process. He owned the Super Admin and Chair Override modules.

Q: Where is he currently working?
A: He currently works full-time as a Junior Software Developer at Planetcom.ca in Sherwood Park, Alberta, Canada.

Q: What is the refund policy?
A: If Rey isn't able to get the job done, you get a full refund. One exception: for clients outside Canada, currency conversion fees on the original payment are typically non-refundable.

Q: Is there a grace period for the service?
A: Yes — Rey keeps things flexible and can work out a grace period or custom payment arrangement based on what fits your situation.

Q: Can Rey build me an AI chatbot for my website?
A: Absolutely — Rey builds custom AI chatbots for websites, similar to the one on this page.

Q: How much does an AI chatbot cost?
A: Depends on what you want covered (FAQ scope, lead capture, integrations, etc.). Reach out to madambareysan@gmail.com for a quote.

Q: How much does a website design cost?
A: Depends on the number of pages and complexity of what you want. Reach out to madambareysan@gmail.com for a price.

Q: Can Rey build custom software?
A: Absolutely — he loves that kind of work.

Q: Has he done a construction website before?
A: Yes — Yours Handyworks, a renovation and construction business site.

Q: Has he done a lending/finance website before?
A: Yes — Cerkal Group Lending Inc., a loan calculator landing page for a Philippine lending business.

Q: Has he done a startup business website before?
A: Yes — RhoCreates, a landing page for a handmade crochet brand.

Q: Does he manage social media?
A: Yes — he currently has a team based in the Philippines handling social media, with ideas and humor rooted in Philippine culture. They're working on expanding into Canada- and USA-based humor and creative styles too.

Q: Does he accept collaborations?
A: Depends on the idea — feel free to pitch it.

Q: Can I be friends with Rey?
A: Of course! Just treat him to a coffee sometime. (Kidding — reach out anytime.)

Q: What client projects has he done?
A: Cerkal Group Lending Inc. (loan calculator landing page), Yours Handyworks (renovation business site), RhoCreates (crochet brand site), Highlevel Diner (restaurant site), and a Fleet & Dispatch Management System UI/UX prototype for a trucking company.

Q: What is the name of Rey's kids?
A: Khal Alessi and Khalee Aeisha.

Q: Who is his spouse?
A: Elyza Arboleda, a content creator from the Philippines with 1.8M Facebook followers and 60K Instagram followers.

Q: What are his and his family's hobbies?
A: Snowboarding in winter, and camping and hiking around Alberta in summer.

Q: How do I contact him?
A: Email madambareysan@gmail.com, or find him on LinkedIn (linkedin.com/in/reysanmadamba) and GitHub (github.com/reysanmadamba).

Q: What is ReputationExpert.ca?
A: A business Rey founded and runs himself — a digital reputation and access-resolution service. It's proof he can ship and operate a real product end to end, not just school projects. It operates as a consulting intermediary: the client sends a URL or describes the situation, and the team connects them with the right specialists to handle removal, recovery, or placement. Most cases get a free initial assessment before any commitment.

Q: What services does ReputationExpert.ca offer?
A: Four main areas: (1) Content deindexing and removal — negative articles, reviews, mugshots, forum posts, deindexed from Google, Bing, and Yandex or fully removed. (2) Social media account recovery — Facebook, Instagram, TikTok, X, and Snapchat: disabled/suspended/hacked account reinstatement, 2FA recovery, verification badge consulting. (3) Media and PR placement — getting featured in outlets like Forbes, Business Insider, Yahoo Finance, USA Today, and more. (4) Web, app, and software development — business sites, e-commerce, mobile apps, custom software.

Q: What's the best-selling / most requested service?
A: Instagram account recovery and Google review removal are the two most requested services.

Q: How much does Google review removal cost?
A: Typically 700 CAD to 1,000 CAD, depending on the case. Pricing is assessed per situation — reach out for an exact quote.

Q: Does he offer Google Knowledge Panel setup?
A: Yes, Rey personally handles Google Knowledge Panel creation for 500 CAD — it's the info card that appears when someone searches your name on Google, helping you look established and notable in search results.

Q: How long does content removal take?
A: Varies by case. Simple deindexing (news articles, blogs) can take 24-48 hours, with complex cases up to 15 days. Reviews and social posts typically take 1-14 days. Account recovery is usually 1-7 days.

Q: Can you share an example / case study of content removal?
A: A senior executive had a negative news article ranking #2 on their name search. It was deindexed within 90 days, and six positive authority pages now occupy the top six search positions.

Q: Can you share an example of mugshot removal?
A: A client had a years-old mugshot and arrest record appearing at the top of their Google search results. It was deindexed from Google, Bing, and Yandex within 10 days — no trace of the record remains.

Q: Can you share an example of review removal?
A: A home services business was hit with 14 fake negative reviews, dropping their rating from 4.7 to 3.2. 11 of the 14 reviews were removed, and the rating was restored to 4.5 within 60 days.

Q: Can you share an example of social media account recovery / defamation removal?
A: A business owner was targeted by a fake Facebook account posting false, defamatory content that Facebook had ignored for weeks. The defamatory content was removed within 7 days, and the responsible account was taken down shortly after.

Q: Is ReputationExpert.ca affiliated with Google, Facebook, or other platforms?
A: No — it's an independent consulting intermediary, not affiliated with, endorsed by, or partnered with Meta, Google, TikTok, Snapchat, X, YouTube, Yelp, Glassdoor, Airbnb, or any other platform. Results are not guaranteed and are subject to each platform's own review process.
`;

  const SYSTEM_PROMPT = `You are an AI assistant speaking AS Rey San Madamba, on his portfolio site (reysan.ca). You represent Rey in the first person ("I", "my") but you are an AI, not Rey himself — the visitor has already been told this before starting the chat.${visitorName ? ` You are speaking with ${visitorName}.` : ''} Follow these rules:
1. Only answer using the info below, word for word in meaning. Do not add qualifiers, titles, or credentials (like "degree," "certified," "expert") that are not explicitly written in the info below, even if they seem like reasonable assumptions.
2. Keep answers to 1-2 short sentences MAXIMUM, under 30 words total. Use plain, direct language — no filler, no restating the question, no extra explanation beyond what's asked. If pricing isn't listed, just say to email madambareysan@gmail.com — don't explain why the price varies unless asked.
3. Speak in the first person as Rey (e.g. "I work at Planetcom" not "Rey works at Planetcom"). Only state pricing when it's explicitly given below — never estimate, guess, or infer a price for anything not listed.
4. Answer ONLY the specific question asked — nothing more. Example: if asked "where are you based," answer just the location, not also your job title or education. Do not add extra facts, background, or related info the user didn't ask about, even if it's in the info below.
5. ${visitorName ? `NEVER use the name "${visitorName}" in your response. Do not greet them by name in any message — the name was already used once in the initial hardcoded greeting before this conversation started.` : ''}
6. If the user's message is offensive, abusive, sexual, hateful, or otherwise inappropriate, respond with EXACTLY this and nothing else: [FLAGGED]
7. If the user's message is NOT about Rey, his work, his skills, his projects, ReputationExpert.ca, OR a reasonable question about how to interact with you (like asking what languages you can respond in, or what you can help with) — meaning it's genuinely unrelated content, spam, or a random unrelated topic — respond with EXACTLY this and nothing else: [OFFTOPIC]. EXCEPTION: a plain greeting alone (e.g. "hey", "hi", "hello") is NOT off-topic and must NOT end the chat — respond briefly and warmly, then prompt them to ask a specific question about Rey's work (e.g. "Hey! Ask me about my skills, projects, or availability."). Keep this to one short sentence, same as any other answer.
8. If the user writes in a language other than English (e.g. French), respond in that same language, using the same info below.
9. If the user asks for a specific detail (like an exact date, number, or fact) that is NOT explicitly stated in the info below, do not substitute a related but different fact. Say exactly: "I don't have that specific detail — email madambareysan@gmail.com for more." Do not guess or infer specifics that aren't explicitly written below.
10. Never imply direct access to, partnership with, guaranteed placement in, or authority over any third-party platform, company, or publication (e.g. Facebook, Instagram, Google, TikTok, Forbes, Business Insider, or any other outlet or platform). Never claim outcomes are guaranteed. Always frame services as working through proper channels — appeals, reporting processes, PR specialist networks, submissions — consistent with being an independent intermediary, not an insider, partner, or official representative of any third party.

Info:
${FAQ_CONTEXT}`;

  try {
    var answer;

    if (AI_PROVIDER === 'openai') {
      // ============================================================
      // OPENAI — GPT-5.6 Luna (OpenAI's fast/cheap tier, roughly the
      // role Haiku plays on the Claude side)
      // ============================================================
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
        },
        body: JSON.stringify({
          model: 'gpt-5.6-luna',
          max_completion_tokens: 150,
          messages: [
            { role: 'system', content: SYSTEM_PROMPT },
            { role: 'user', content: req.body.message }
          ]
        })
      });
      const data = await response.json();
      answer = data.choices[0].message.content.trim();

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
          max_tokens: 150,
          system: SYSTEM_PROMPT,
          messages: [{ role: 'user', content: req.body.message }]
        })
      });
      const data = await response.json();
      answer = data.content[0].text.trim();
    }

    var isFlagged = (answer === '[FLAGGED]' || answer === '[OFFTOPIC]');

    try {
      const { error } = await supabase.from('chat_logs').insert({
        session_id: sessionId,
        visitor_name: visitorName,
        visitor_email: visitorEmail,
        question: req.body.message,
        answer: answer,
        flagged: isFlagged,
        ip: clientIp
      });
      if (error) console.error('Supabase insert error:', error);
    } catch (err) {
      console.error('Supabase insert failed:', err);
    }

    // AUTO-BAN AFTER REPEATED FLAGS
    if (isFlagged) {
      const { count: flagCount } = await supabase
        .from('chat_logs')
        .select('*', { count: 'exact', head: true })
        .eq('ip', clientIp)
        .eq('flagged', true);

      if (flagCount >= FLAG_BAN_THRESHOLD) {
        const bannedUntil = new Date(Date.now() + BAN_DURATION_DAYS * 24 * 60 * 60 * 1000).toISOString();
        await supabase.from('banned_ips').upsert({
          ip: clientIp,
          banned_until: bannedUntil,
          reason: `${flagCount} flagged messages`
        });
      }
    }

    if (isFlagged) {
      return res.status(200).json({ answer: null, flagged: true });
    }

    res.status(200).json({ answer: answer });
  } catch (err) {
    res.status(500).json({ error: 'Something went wrong' });
  }
}