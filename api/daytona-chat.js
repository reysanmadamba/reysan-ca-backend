import { verifySessionToken } from './daytona-captcha.js';

// Same domain as the main site (reysan.ca) — CORS is origin-based, not path-based,
// so /daytona living at reysan.ca/daytona is covered by the reysan.ca origin.
const allowedOrigins = ['https://reysan.ca', 'https://test.local'];

const MAX_MESSAGES_PER_SESSION = 10;

// ============================================================
// AI PROVIDER TOGGLE — switch between Claude and OpenAI here.
// Set to 'claude' or 'openai'. Nothing else needs to change.
// ============================================================
const AI_PROVIDER = 'openai';
// replace openai to claude if you want to use claude api

// ============================================================
// Demo listings — first 10 are real, current Daytona Homes Edmonton
// listings (pulled from daytonahomes.ca/greater-edmonton/move-in-ready).
// The remaining 10 are placeholder entries (fictional addresses, real
// community names) added to round out the demo set.
//
// nearSchool / nearGrocery / nearPark are PLACEHOLDER flags, not real
// geo data — just here so the bot can demo "near a school" / "near
// groceries" style queries. Swap this whole block for a real
// nearby_places lookup (vector search / Google Places) later.
// Prices are "GST included" per Daytona's listing display.
// ============================================================
const LISTINGS = [
  { address: '227 157 Avenue NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 1783, price: 489916, possession: 'October 2026', features: ['Side Entry', 'Prep Kitchen'], nearSchool: true, nearGrocery: false, nearPark: true },
  { address: '9105 Elves Loop NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1707, price: 514498, possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry', "9' Foundation"], nearSchool: true, nearGrocery: true, nearPark: false },
  { address: '265 Chappelle Drive SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1638, price: 509514, possession: 'Immediate', features: ['Side Entry'], nearSchool: false, nearGrocery: true, nearPark: true },
  { address: '8822 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1537, price: 485098, possession: 'September 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: false, nearPark: false },
  { address: '5141 Cawsey Bend SW', community: 'Chappelle Gardens', beds: 4, baths: 3, sqft: 1956, price: 642085, possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: true, nearPark: false },
  { address: '22432 86 Avenue NW', community: 'Rosemont', beds: 3, baths: 2.5, sqft: 1815, price: 584629, possession: 'December 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: true, nearPark: true },
  { address: '15715 3 Street NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 2283, price: 679625, possession: 'December 2026', features: ['Side Entry', 'Prep Kitchen', 'Vaulted Ceiling'], nearSchool: false, nearGrocery: false, nearPark: true },
  { address: '7099 Rosenthal Drive NW', community: 'Rosemont', beds: 2, baths: 2.5, sqft: 1022, price: 389900, possession: 'September 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: false, nearPark: false },
  { address: '137 Mustang Close', community: 'Ardrossan', beds: 3, baths: 2.5, sqft: 1783, price: 512135, possession: 'Coming 2027', features: ['Side Entry'], nearSchool: false, nearGrocery: true, nearPark: false },
  { address: '8628 224 Street NW', community: 'Rosemont', beds: 3, baths: 2.5, sqft: 1815, price: 583804, possession: 'September 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: true, nearPark: false },

  // Placeholder additions (fictional address, real community names) — for demo variety only
  { address: '4210 Alces Way SW', community: 'Alces', beds: 4, baths: 2.5, sqft: 2040, price: 598900, possession: 'November 2026', features: ['Side Entry', 'Walk-Through Pantry'], nearSchool: true, nearGrocery: false, nearPark: true },
  { address: '1187 Orchards Boulevard SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1690, price: 521450, possession: 'Immediate', features: ['Side Entry', 'Fireplace'], nearSchool: false, nearGrocery: true, nearPark: true },
  { address: '9944 Glenridding Ravine Terrace SW', community: 'Glenridding Ravine', beds: 4, baths: 3, sqft: 2210, price: 668300, possession: 'January 2027', features: ['Walk-Out Basement', 'Vaulted Ceiling'], nearSchool: true, nearGrocery: false, nearPark: true },
  { address: '3312 Crystallina Nera Way NW', community: 'Crystallina Nera', beds: 3, baths: 2.5, sqft: 1595, price: 476200, possession: 'October 2026', features: ['Side Entry', 'Corner Lot'], nearSchool: false, nearGrocery: true, nearPark: false },
  { address: '212 Kinglet Landing NW', community: 'Kinglet by Big Lake', beds: 3, baths: 2.5, sqft: 1730, price: 534700, possession: 'December 2026', features: ['Side Entry', 'Rear Deck'], nearSchool: true, nearGrocery: true, nearPark: false },
  { address: '2278 Chappelle Way SW', community: 'Chappelle Gardens', beds: 5, baths: 3, sqft: 2450, price: 712500, possession: 'February 2027', features: ['Main Floor Den', 'Executive Kitchen Appliances'], nearSchool: true, nearGrocery: false, nearPark: false },
  { address: '8560 Rosenthal Link NW', community: 'Rosemont', beds: 2, baths: 2, sqft: 980, price: 372900, possession: 'Immediate', features: ['Luxury Vinyl Plank'], nearSchool: false, nearGrocery: true, nearPark: false },
  { address: '9231 Edgemont Bend NW', community: 'Edgemont', beds: 4, baths: 3, sqft: 2115, price: 619400, possession: 'March 2027', features: ['Side Entry', 'Prep Kitchen'], nearSchool: true, nearGrocery: true, nearPark: true },
  { address: '150 Mustang Terrace', community: 'Ardrossan', beds: 4, baths: 2.5, sqft: 1940, price: 556800, possession: 'Coming 2027', features: ['Side Entry', 'Rear Kitchen'], nearSchool: false, nearGrocery: false, nearPark: true },
  { address: '15840 3 Street NE', community: 'Quarry Vista', beds: 2, baths: 2, sqft: 1150, price: 418500, possession: 'August 2026', features: ['9\' Foundation'], nearSchool: true, nearGrocery: true, nearPark: false }
];

// ============================================================
// System prompt — real company facts, sourced from daytonahomes.ca
// ============================================================
const SYSTEM_PROMPT = `You are an AI assistant answering questions on daytonahomes.ca's behalf, embedded as a chat widget on a demo page (reysan.ca/daytona) built to show Daytona Homes what an AI FAQ + home-recommendation assistant could look like on their site.

Disclose upfront, in your first message only, that you are an AI demo assistant, not a Daytona Homes employee, and that this is a prototype.

FACTS YOU KNOW (do not go beyond these; if asked something not covered, say you don't have that detail and point them to daytonahomes.ca or the phone number below):
- Daytona Homes has 30+ years of homebuilding experience, operating in Greater Edmonton, Greater Calgary, and Winnipeg.
- Greater Edmonton contact: 780.452.2288, 11504 170 Street, Edmonton, AB T5S 1J7.
- The home-building process has three steps: (1) choose a community, (2) find a floorplan/model, (3) meet a consultant at a showhome to customize finishings.
- They also sell move-in-ready "quick possession" homes (30-90 days typical, some immediate) in addition to custom builds.
- Home types include single-family front-attached garage, detached garage, duplex, townhome, bungalow, and condo (Ambrea at the Orchards).
- Edmonton-area communities include Chappelle Gardens, Rosemont, Edgemont, Quarry Vista, Ardrossan, Alces, The Orchards at Ellerslie, Glenridding Ravine, Crystallina Nera, and Kinglet by Big Lake.
- Warranty (Greater Edmonton): handled by Tacada Customer Care (Daytona Homes is a Tacada company) — 1-877-788-7689, Customercare@tacada.ca, Mon-Thurs 8am-5pm, Fri 8am-4pm.
- There are currently 143 move-in-ready listings across the Edmonton area (this demo only has a sample of 20 for illustration).

CURRENT LISTINGS (JSON — use ONLY these for specific home recommendations; prices are GST-included). The nearSchool/nearGrocery/nearPark flags are placeholder demo data, not verified proximity — if asked, say proximity search is a preview/demo feature and the flag is illustrative, not a guarantee:
${JSON.stringify(LISTINGS, null, 2)}

GUIDED INTAKE FLOW — if a visitor says they're looking for a home, wants a recommendation, or otherwise signals home-shopping intent (not just a general FAQ question), walk them through these four questions ONE AT A TIME, waiting for their answer before asking the next. Don't dump all four at once.
1. "Which city are you looking to build or buy in?" — Daytona operates in Greater Edmonton, Greater Calgary, and Winnipeg. If they name anywhere outside those three, respond with something like "We only build in Greater Edmonton, Greater Calgary, and Winnipeg — would one of those work?" and don't move to the next question until they confirm one. If they pick Calgary or Winnipeg, let them know this demo's sample listings are Edmonton-area only, but ask the rest of the questions anyway so they can see how the recommendation would work.
2. "What's your budget?"
3. "How many bedrooms are you looking for?"
4. "Is there anything specific you'd like — for example, close to a school, grocery store, or park?"
Once all four are answered, recommend 1-3 matching homes from LISTINGS using their answers to filter. If a visitor volunteers several of these in one message, don't re-ask what they already gave you — just fill in whichever are still missing, then recommend.
If the visitor is just asking a general FAQ question and hasn't signaled they want a home recommendation, skip this flow and answer normally.

Rules:
- When a visitor describes what they want (budget, bed/bath count, community, size, move-in timing, near a school/grocery/park), recommend 1-3 matching homes from the LISTINGS data above, citing address, community, price, beds/baths, sqft, and possession date plainly.
- If nothing in the sample matches well, say so honestly and mention the full 143-listing inventory is on daytonahomes.ca/greater-edmonton/move-in-ready.
- Never invent listings, prices, square footage, or features not in the data above.
- Never invent warranty terms, legal terms, or financing details beyond what's given here — offer the phone number instead.
- Stay on topic: Daytona Homes, their process, communities, and these listings. Redirect politely for anything unrelated.
- Keep responses concise — 2-4 sentences, plus a short listing rundown when recommending homes.`;

function corsHeaders(req, res) {
  const origin = req.headers.origin;
  if (allowedOrigins.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
  }
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
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
      reply: "We've hit the message limit for this demo session — thanks for chatting! Reach Daytona Homes directly at 780.452.2288 to keep going.",
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

    return res.status(200).json({ reply, limitReached: userTurns === MAX_MESSAGES_PER_SESSION });
  } catch (err) {
    console.error('Chat handler error:', err);
    return res.status(500).json({ error: 'Internal server error' });
  }
}