import { verifySessionToken } from './daytona-captcha.js';
import { createClient } from '@supabase/supabase-js';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_KEY
);

// Same domain as the main site (reysan.ca) — CORS is origin-based, not path-based,
// so /daytona living at reysan.ca/daytona is covered by the reysan.ca origin.
const allowedOrigins = ['https://reysan.ca', 'https://test.local'];

const MAX_MESSAGES_PER_SESSION = 20; // change this number to raise/lower the per-session cap
const OFFTOPIC_LOCK_THRESHOLD = 3; // consecutive/total off-topic strikes before the chat auto-locks
const OFFTOPIC_MARKER = '[OFFTOPIC_FLAG]';

// ============================================================
// AI PROVIDER TOGGLE — switch between Claude and OpenAI here.
// Set to 'claude' or 'openai'. Nothing else needs to change.
// ============================================================
const AI_PROVIDER = 'openai';
// replace openai to claude if you want to use claude api

// ============================================================
// Demo listings — Edmonton (20), Calgary (10), Winnipeg (10).
// Edmonton: first 10 are real current listings (street addresses, as
// shown on daytonahomes.ca/greater-edmonton/move-in-ready); the next
// 10 are placeholder entries (fictional address, real community names).
// Calgary & Winnipeg: all 10 each are real current listings pulled from
// daytonahomes.ca/greater-calgary/move-in-ready and
// winnipeg.daytonahomes.ca/quick-possessions. Calgary/Winnipeg listings
// are identified by model name, not street address — that's how Daytona
// displays them on those regional sites (Edmonton's site shows street
// addresses instead). Winnipeg prices are pre-GST (home & lot); Edmonton
// and Calgary prices shown are GST-included, per each region's listing
// display — flagged with priceNote below.
//
// nearSchool / nearGrocery / nearPark are PLACEHOLDER flags, not real
// geo data — just here so the bot can demo "near a school" / "near
// groceries" style queries. Swap this whole block for a real
// nearby_places lookup (vector search / Google Places) later.
// ============================================================
const LISTINGS = [
  // ---------- EDMONTON (real) ----------
  { city: 'Edmonton', address: '227 157 Avenue NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 1783, price: 489916, priceNote: 'GST included', possession: 'October 2026', features: ['Side Entry', 'Prep Kitchen'], nearSchool: true, nearGrocery: false, nearPark: true },
  { city: 'Edmonton', address: '9105 Elves Loop NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1707, price: 514498, priceNote: 'GST included', possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry', "9' Foundation"], nearSchool: true, nearGrocery: true, nearPark: false },
  { city: 'Edmonton', address: '265 Chappelle Drive SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1638, price: 509514, priceNote: 'GST included', possession: 'Immediate', features: ['Side Entry'], nearSchool: false, nearGrocery: true, nearPark: true },
  { city: 'Edmonton', address: '8822 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1537, price: 485098, priceNote: 'GST included', possession: 'September 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: false, nearPark: false },
  { city: 'Edmonton', address: '5141 Cawsey Bend SW', community: 'Chappelle Gardens', beds: 4, baths: 3, sqft: 1956, price: 642085, priceNote: 'GST included', possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: true, nearPark: false },
  { city: 'Edmonton', address: '22432 86 Avenue NW', community: 'Rosemont', beds: 3, baths: 2.5, sqft: 1815, price: 584629, priceNote: 'GST included', possession: 'December 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: true, nearPark: true },
  { city: 'Edmonton', address: '15715 3 Street NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 2283, price: 679625, priceNote: 'GST included', possession: 'December 2026', features: ['Side Entry', 'Prep Kitchen', 'Vaulted Ceiling'], nearSchool: false, nearGrocery: false, nearPark: true },
  { city: 'Edmonton', address: '7099 Rosenthal Drive NW', community: 'Rosemont', beds: 2, baths: 2.5, sqft: 1022, price: 389900, priceNote: 'GST included', possession: 'September 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: false, nearPark: false },
  { city: 'Edmonton', address: '137 Mustang Close', community: 'Ardrossan', beds: 3, baths: 2.5, sqft: 1783, price: 512135, priceNote: 'GST included', possession: 'Coming 2027', features: ['Side Entry'], nearSchool: false, nearGrocery: true, nearPark: false },
  { city: 'Edmonton', address: '8628 224 Street NW', community: 'Rosemont', beds: 3, baths: 2.5, sqft: 1815, price: 583804, priceNote: 'GST included', possession: 'September 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: true, nearPark: false },

  // ---------- EDMONTON (placeholder additions, fictional address, real community names) ----------
  { city: 'Edmonton', address: '4210 Alces Way SW', community: 'Alces', beds: 4, baths: 2.5, sqft: 2040, price: 598900, priceNote: 'GST included', possession: 'November 2026', features: ['Side Entry', 'Walk-Through Pantry'], nearSchool: true, nearGrocery: false, nearPark: true },
  { city: 'Edmonton', address: '1187 Orchards Boulevard SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1690, price: 521450, priceNote: 'GST included', possession: 'Immediate', features: ['Side Entry', 'Fireplace'], nearSchool: false, nearGrocery: true, nearPark: true },
  { city: 'Edmonton', address: '9944 Glenridding Ravine Terrace SW', community: 'Glenridding Ravine', beds: 4, baths: 3, sqft: 2210, price: 668300, priceNote: 'GST included', possession: 'January 2027', features: ['Walk-Out Basement', 'Vaulted Ceiling'], nearSchool: true, nearGrocery: false, nearPark: true },
  { city: 'Edmonton', address: '3312 Crystallina Nera Way NW', community: 'Crystallina Nera', beds: 3, baths: 2.5, sqft: 1595, price: 476200, priceNote: 'GST included', possession: 'October 2026', features: ['Side Entry', 'Corner Lot'], nearSchool: false, nearGrocery: true, nearPark: false },
  { city: 'Edmonton', address: '212 Kinglet Landing NW', community: 'Kinglet by Big Lake', beds: 3, baths: 2.5, sqft: 1730, price: 534700, priceNote: 'GST included', possession: 'December 2026', features: ['Side Entry', 'Rear Deck'], nearSchool: true, nearGrocery: true, nearPark: false },
  { city: 'Edmonton', address: '2278 Chappelle Way SW', community: 'Chappelle Gardens', beds: 5, baths: 3, sqft: 2450, price: 712500, priceNote: 'GST included', possession: 'February 2027', features: ['Main Floor Den', 'Executive Kitchen Appliances'], nearSchool: true, nearGrocery: false, nearPark: false },
  { city: 'Edmonton', address: '8560 Rosenthal Link NW', community: 'Rosemont', beds: 2, baths: 2, sqft: 980, price: 372900, priceNote: 'GST included', possession: 'Immediate', features: ['Luxury Vinyl Plank'], nearSchool: false, nearGrocery: true, nearPark: false },
  { city: 'Edmonton', address: '9231 Edgemont Bend NW', community: 'Edgemont', beds: 4, baths: 3, sqft: 2115, price: 619400, priceNote: 'GST included', possession: 'March 2027', features: ['Side Entry', 'Prep Kitchen'], nearSchool: true, nearGrocery: true, nearPark: true },
  { city: 'Edmonton', address: '150 Mustang Terrace', community: 'Ardrossan', beds: 4, baths: 2.5, sqft: 1940, price: 556800, priceNote: 'GST included', possession: 'Coming 2027', features: ['Side Entry', 'Rear Kitchen'], nearSchool: false, nearGrocery: false, nearPark: true },
  { city: 'Edmonton', address: '15840 3 Street NE', community: 'Quarry Vista', beds: 2, baths: 2, sqft: 1150, price: 418500, priceNote: 'GST included', possession: 'August 2026', features: ["9' Foundation"], nearSchool: true, nearGrocery: true, nearPark: false },

  // ---------- CALGARY (real, identified by model name — Daytona's Calgary site doesn't list street addresses) ----------
  { city: 'Calgary', address: 'The Romeo CT (Southbow Landing)', community: 'Southbow Landing', beds: 3, baths: 2.5, sqft: 1824, price: 649900, priceNote: 'GST included', possession: 'Contact for date', features: ["9' Foundation", 'Optional Side Entry'], nearSchool: true, nearGrocery: false, nearPark: false },
  { city: 'Calgary', address: 'The Silverado MF (Rangeview)', community: 'Rangeview', beds: 4, baths: 2.5, sqft: 2317, price: 749900, priceNote: 'GST included', possession: 'Contact for date', features: ["9' Foundation", 'Optional Side Entry', 'Built Green Gold Certified'], nearSchool: false, nearGrocery: true, nearPark: true },
  { city: 'Calgary', address: 'The Austyn-Z P (Walden)', community: 'Walden', beds: 3, baths: 2.5, sqft: 2259, price: 805900, priceNote: 'GST included', possession: 'Contact for date', features: ['Pie Lot', 'Legal Basement Suite', 'Fireplace', 'Main Floor Den'], nearSchool: true, nearGrocery: false, nearPark: true },
  { city: 'Calgary', address: 'The Monaco II R (Harmony)', community: 'Harmony', beds: 3, baths: 2.5, sqft: 2358, price: 849900, priceNote: 'GST included', possession: 'Contact for date', features: ['Rear Attached Garage', 'Rear Deck', 'Main Floor Den', 'Fireplace'], nearSchool: false, nearGrocery: false, nearPark: true },
  { city: 'Calgary', address: 'The Alfa E (Heartland)', community: 'Heartland', beds: 3, baths: 2.5, sqft: 2013, price: 649900, priceNote: 'GST included', possession: 'Contact for date', features: ['Optional Side Entry', 'Fireplace', 'Main Floor Den'], nearSchool: true, nearGrocery: true, nearPark: false },
  { city: 'Calgary', address: 'The Frontier HS (Heartland)', community: 'Heartland', beds: 3, baths: 2.5, sqft: 1433, price: 469900, priceNote: 'GST included', possession: 'Contact for date', features: ["9' Foundation", 'Optional Side Entry', 'Built Green Gold Certified'], nearSchool: true, nearGrocery: false, nearPark: false },
  { city: 'Calgary', address: 'The Valencia R (Harmony)', community: 'Harmony', beds: 3, baths: 2.5, sqft: 2465, price: 882900, priceNote: 'GST included', possession: 'Contact for date', features: ['Triple Car Detached Garage', 'Side Entry', 'Main Floor Den', 'Built Green Gold'], nearSchool: false, nearGrocery: true, nearPark: false },
  { city: 'Calgary', address: 'The Breeze II F (Heartland)', community: 'Heartland', beds: 3, baths: 2.5, sqft: 2054, price: 694900, priceNote: 'GST included', possession: 'Contact for date', features: ["9' Foundation", 'Optional Side Entry'], nearSchool: false, nearGrocery: true, nearPark: true },
  { city: 'Calgary', address: 'The Austyn R (Southbow Landing)', community: 'Southbow Landing', beds: 3, baths: 2.5, sqft: 2259, price: 689900, priceNote: 'GST included', possession: 'Contact for date', features: ["9' Foundation", 'Fireplace', 'Main Floor Den', 'Central Bonus Room'], nearSchool: true, nearGrocery: false, nearPark: false },
  { city: 'Calgary', address: 'The Palisade II R (Southbow Landing)', community: 'Southbow Landing', beds: 3, baths: 2.5, sqft: 1860, price: 639900, priceNote: 'GST included', possession: 'Contact for date', features: ['Sunshine Basement', 'Optional Side Entry', 'Built Green Gold Certified'], nearSchool: false, nearGrocery: true, nearPark: false },

  // ---------- WINNIPEG (real) ----------
  { city: 'Winnipeg', address: '35 Perseus Way', community: 'Aurora', beds: 3, baths: 2.5, sqft: 1520, price: 572884, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: true, nearPark: false },
  { city: 'Winnipeg', address: '53 Kite Bay', community: 'Highland Pointe', beds: 4, baths: 3, sqft: 1695, price: 584115, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: false, nearPark: true },
  { city: 'Winnipeg', address: '132 Mosaic Street', community: 'Summerlea', beds: 3, baths: 2.5, sqft: 1327, price: 398248, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: false, nearPark: false },
  { city: 'Winnipeg', address: '118 Kite Bay', community: 'Highland Pointe', beds: 3, baths: 2, sqft: 1579, price: 539940, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: true, nearPark: false },
  { city: 'Winnipeg', address: '34 Bill Brierclliffe', community: 'Devonshire Park', beds: 3, baths: 2.5, sqft: 1488, price: 509180, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: true, nearPark: true },
  { city: 'Winnipeg', address: '129 Mill Rock Road', community: 'Highland Pointe', beds: 4, baths: 3, sqft: 1882, price: 701806, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: false, nearPark: false },
  { city: 'Winnipeg', address: '295 Avior Drive', community: 'Aurora', beds: 3, baths: 2.5, sqft: 1488, price: 490381, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: false, nearPark: true },
  { city: 'Winnipeg', address: '79 Pegasus Street', community: 'Aurora', beds: 3, baths: 2, sqft: 1579, price: 545287, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: true, nearPark: false },
  { city: 'Winnipeg', address: '83 Pegasus Street', community: 'Aurora', beds: 4, baths: 3, sqft: 1695, price: 580412, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: true, nearPark: false },
  { city: 'Winnipeg', address: '128 Mosaic Street', community: 'Summerlea', beds: 3, baths: 2.5, sqft: 1327, price: 398248, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: false, nearPark: true }
];

// ============================================================
// System prompt — real company facts, sourced from daytonahomes.ca
// ============================================================
const SYSTEM_PROMPT = `You are an AI assistant answering questions on daytonahomes.ca's behalf, embedded as a chat widget on a demo page (reysan.ca/daytona) built to show Daytona Homes what an AI FAQ + home-recommendation assistant could look like on their site.

Do NOT introduce yourself, disclose that you're an AI, or greet the visitor again in your first reply — the chat widget already shows that disclaimer as a static message before the conversation starts. Just respond directly and naturally to whatever the visitor's first message actually says.

FACTS YOU KNOW (do not go beyond these; if asked something not covered, say something like "This is just a demo — I've only been fed a few pieces of knowledge by Rey, so I don't have that detail. If I ever seem to be making something up, let Rey know so he can tighten up the rules." — then point them to daytonahomes.ca or the phone number below if relevant):
- Daytona Homes has 30+ years of homebuilding experience, operating in Greater Edmonton, Greater Calgary, and Winnipeg.
- Greater Edmonton contact: 780.452.2288, 11504 170 Street, Edmonton, AB T5S 1J7.
- Greater Calgary contact: 587.291.2288, 106, 7326-10th St. NE, Calgary, AB T2E 8W1.
- Winnipeg contact: 204.257.7117, 106 Terracon Place, Winnipeg, MB R2J 4G7.
- The home-building process has three steps: (1) choose a community, (2) find a floorplan/model, (3) meet a consultant at a showhome to customize finishings.
- They also sell move-in-ready "quick possession" homes (30-90 days typical, some immediate) in addition to custom builds.
- Home types include single-family front-attached garage, detached garage, duplex, townhome, bungalow, and condo (Ambrea at the Orchards in Edmonton, The Bowbank at Rockland Park in Calgary, Solara in Winnipeg).
- Edmonton-area communities include Chappelle Gardens, Rosemont, Edgemont, Quarry Vista, Ardrossan, Alces, The Orchards at Ellerslie, Glenridding Ravine, Crystallina Nera, and Kinglet by Big Lake.
- Calgary-area communities include Southbow Landing, Rangeview, Walden, Harmony, and Heartland (North/Southeast Calgary, Cochrane, and Springbank Area).
- Winnipeg communities include Aurora, Highland Pointe, Summerlea, Devonshire Park, and Prairie Pointe.
- Warranty (Greater Edmonton): handled by Tacada Customer Care (Daytona Homes is a Tacada company) — 1-877-788-7689, Customercare@tacada.ca, Mon-Thurs 8am-5pm, Fri 8am-4pm. Warranty contacts for Calgary and Winnipeg are not loaded in this demo — if asked, say you don't have that detail and point them to daytonahomes.ca/warranty.

DEMO CUSTOMER SERVICE CONTACT — if a visitor wants to speak to a real person, has a question this demo can't answer, or you're using the fallback line above, offer this in addition: this demo's support contact is contact@reysan.ca, monitored weekdays 8am-5pm. If it's currently outside those hours, say so honestly (something like "it's outside our demo support hours right now, so a reply might take a bit, but you're welcome to email anyway") — don't pretend someone will respond instantly outside business hours, but don't discourage them from trying either. For real Daytona warranty or sales questions specifically, still give the real regional phone number/email from FACTS above as the primary contact — contact@reysan.ca is only for questions about this AI demo itself, not a substitute for Daytona's actual customer service.
- There are currently 143 move-in-ready listings in Edmonton, 63 in Calgary, and 30 in Winnipeg (this demo only has a sample of 40 total for illustration — 20 Edmonton, 10 Calgary, 10 Winnipeg).

CURRENT LISTINGS (JSON — use ONLY these for specific home recommendations, and filter by the "city" field to match what the visitor said). The nearSchool/nearGrocery/nearPark flags are placeholder demo data, not verified proximity — if asked, say proximity search is a preview/demo feature and the flag is illustrative, not a guarantee. Note priceNote: Edmonton and Calgary prices are GST-included; Winnipeg prices are pre-GST (home & lot) — mention this if a visitor asks about final price:
${JSON.stringify(LISTINGS, null, 2)}

GUIDED INTAKE FLOW — if a visitor says they're looking for a home, wants a recommendation, or otherwise signals home-shopping intent (not just a general FAQ question), walk them through these four questions ONE AT A TIME, waiting for their answer before asking the next. Don't dump all four at once.
1. "Which city are you looking to build or buy in?" — Daytona operates in Greater Edmonton, Greater Calgary, and Winnipeg. If they name anywhere outside those three, respond with something like "We only build in Greater Edmonton, Greater Calgary, and Winnipeg — would one of those work?" and don't move to the next question until they confirm one.
2. "What's your budget?"
3. "How many bedrooms are you looking for?"
4. "Is there anything specific you'd like — for example, close to a school, grocery store, or park?"
Once all four are answered, filter LISTINGS to the chosen city and recommend 1-3 matching homes using their other answers. If a visitor volunteers several of these in one message, don't re-ask what they already gave you — just fill in whichever are still missing, then recommend.
If the visitor is just asking a general FAQ question and hasn't signaled they want a home recommendation, skip this flow and answer normally.

Rules:
- When a visitor describes what they want (city, budget, bed/bath count, community, size, move-in timing, near a school/grocery/park), recommend 1-3 matching homes from the LISTINGS data above (filtered to their city), citing address, community, price, beds/baths, sqft, and possession date plainly.
- If nothing in the sample matches well, say so honestly and mention the full listing inventory is on daytonahomes.ca for that region.
- Never invent listings, prices, square footage, or features not in the data above. If a visitor asks about anything not covered in FACTS or LISTINGS — a specific policy, a detail about a listing not included here, anything you're unsure of — use the fallback line above rather than guessing or filling in a plausible-sounding answer.
- UNMATCHED PREFERENCE FALLBACK: if a visitor asks for something specific that isn't tracked in this data (for example "near a gym," "near a hospital," "quiet street," "school district rating," or anything beyond city, budget, beds/baths, sqft, possession, features, nearSchool, nearGrocery, nearPark), be upfront about it rather than pretending to know. Say something like "I've only been fed a small sample of listings for this demo, so my options are limited here, and I don't actually have gym proximity data." Then still be useful like a real agent would: look through LISTINGS for the closest reasonable match on whatever you DO know (city, budget, beds, community, the three proximity flags you have), recommend it, and explain your reasoning honestly, for example "this one's in a walkable community and close to a park, so it might work, but I'd confirm gym distance directly with Daytona." Never claim or imply you checked something you don't have data for.
- Do NOT use markdown formatting of any kind — no **bold**, no _italics_, no bullet points with - or *, no headers with #. This chat widget renders plain text only, so markdown symbols show up as literal asterisks/hashes and look broken. Write everything in plain sentences.
- Never invent warranty terms, legal terms, or financing details beyond what's given here — offer the phone number instead.
- Stay strictly on topic: Daytona Homes, its building process, communities, listings, warranty, and this AI demo itself. If a visitor asks about anything unrelated (general chit-chat, other companies, unrelated topics), politely say you can only help with Daytona Homes-related questions. Check the conversation so far: if this is their first off-topic message, add a gentle warning that the chat may end if they keep asking unrelated things. If they've already gone off-topic once or more before in this conversation, be firmer and repeat the warning more directly. If this is their third or more off-topic message in this conversation, tell them plainly that you're ending the chat now, and point them to contact@reysan.ca if they want to reach the demo team.
- Whenever a message is off-topic (every time, not just the third strike), end your reply with exactly this on its own final line and nothing else after it, so the system can track it: [OFFTOPIC_FLAG]
  Never explain or mention this marker to the visitor — it's a silent signal only, always on its own last line.
- Keep responses concise — 2-4 sentences, plus a short listing rundown when recommending homes.`;

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
// sessionId back out for logging. No new export needed on daytona-captcha.js.
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

    // Detect the off-topic marker the model appends, strip it before it ever
    // reaches the visitor, and remember whether this turn was off-topic.
    let isOffTopic = false;
    if (reply.includes(OFFTOPIC_MARKER)) {
      isOffTopic = true;
      reply = reply.replace(OFFTOPIC_MARKER, '').trim();
    }

    // Log this turn to the same chat_logs table the main site uses,
    // tagged so /report can tell it apart from portfolio chat.
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
        source: 'daytona'
      });
      if (logError) console.error('Supabase insert error:', logError);

      // Auto-disconnect after repeated off-topic messages in this session
      if (isOffTopic && sid) {
        const { count: offTopicCount, error: countError } = await supabase
          .from('chat_logs')
          .select('*', { count: 'exact', head: true })
          .eq('session_id', sid)
          .eq('source', 'daytona')
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