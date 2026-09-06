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
// LISTINGS — pulled live from daytonahomes.ca on Sept 5, 2026.
// All entries below are REAL, currently posted move-in-ready homes
// (replacing the earlier fictional placeholder set).
//
// IMPORTANT: real listings change constantly (sale pending, sold,
// new ones posted, prices adjusted). This snapshot WILL go stale —
// re-pull periodically, or build a real sync step into the pgvector
// migration instead of manually copy-pasting like this each time.
//
// `url` = direct link to that home's page on daytonahomes.ca. Offer
// this alongside the shadow-check link so the AI can give both:
// "see the full listing" AND "see the sun/shadow view."
//
// `lat` / `lng` = geocoded via Nominatim (OpenStreetMap), free tier,
// no API key. `geocodePrecision` shows how exact the match is:
//   - "address"   -> matched the real street address, lot-accurate
//   - "street"    -> matched the street, not the exact house number
//   - "community" -> matched the neighborhood only (many Calgary/
//                    Winnipeg entries land here — Calgary listings
//                    are identified by model name with no street
//                    address at all, and several Winnipeg streets
//                    aren't in OSM yet since they're newer builds)
//   - "city"      -> matched only the city center (least precise —
//                    happens when even the community name didn't
//                    resolve)
// Multiple listings in the same community will share identical
// lat/lng at "community" or "city" precision — that's expected,
// not a bug. Shadow-check still works, it just centers on the
// neighborhood rather than the exact lot for those entries.
//
// When this gets rebuilt with Google Geocoding API + pgvector post-
// demo, re-run all of these — address-level accuracy should improve
// significantly, especially for Winnipeg.
//
// nearSchool / nearGrocery / nearPark remain PLACEHOLDER flags —
// not real geo data, same caveat as the original dataset.
// ============================================================
const LISTINGS = [
  // ---------- EDMONTON (real, live) ----------
  { city: 'Edmonton', address: '8798 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1537, price: null, priceNote: 'Sale Pending', possession: 'Immediate', features: ['Side Entry'], nearSchool: true, nearGrocery: false, nearPark: false, url: 'https://www.daytonahomes.ca/greater-edmonton/homes/egnl-016-015', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '8686 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1707, price: 513506, priceNote: 'GST included', possession: 'Immediate', features: ['Built Green Certified Gold'], nearSchool: true, nearGrocery: false, nearPark: false, url: 'https://www.daytonahomes.ca/greater-edmonton/homes/dedgnl-010-086', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '5032 Cawsey Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1956, price: 636350, priceNote: 'GST included', possession: 'October 2026', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: true, nearPark: true, url: 'https://www.daytonahomes.ca/greater-edmonton/homes/chp-044-016', lat: 53.4025164, lng: -113.5911037, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '7113 Rosenthal Drive NW', community: 'Rosemont', beds: 2, baths: 2.5, sqft: 1022, price: 359900, priceNote: 'GST included', possession: 'November 2026', features: [], nearSchool: true, nearGrocery: false, nearPark: false, url: 'https://www.daytonahomes.ca/greater-edmonton/homes/rmth-011-022', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '5452 Hawthorn Run SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1707, price: 497999, priceNote: 'GST included', possession: 'Immediate', features: ['Side Entry', 'Built Green Certified Gold'], nearSchool: false, nearGrocery: true, nearPark: true, url: 'https://www.daytonahomes.ca/greater-edmonton/homes/orc-042-034', lat: 53.4021295, lng: -113.4614895, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '3248 Orchards Wynd SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1400, price: 489300, priceNote: 'GST included', possession: 'November 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: true, nearPark: true, url: 'https://www.daytonahomes.ca/greater-edmonton/homes/orc-004-024', lat: 53.3999092, lng: -113.4595525, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2479 Alces Link SW', community: 'Alces', beds: 3, baths: 2.5, sqft: 1537, price: 489998, priceNote: 'GST included', possession: 'Immediate', features: ['Side Entry', 'Rear Kitchen'], nearSchool: true, nearGrocery: false, nearPark: true, url: 'https://www.daytonahomes.ca/greater-edmonton/homes/alcrpl-007-039', lat: 53.4283106, lng: -113.3775223, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2018 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, price: 480158, priceNote: 'GST included', possession: 'Immediate', features: [], nearSchool: false, nearGrocery: true, nearPark: true, url: 'https://www.daytonahomes.ca/greater-edmonton/homes/chpdx-007-011', lat: 53.4071766, lng: -113.554081, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '18844 28 Avenue NW', community: 'The Uplands at Riverview', beds: 3, baths: 2.5, sqft: 1537, price: 472499, priceNote: 'GST included', possession: 'Immediate', features: ['Side Entry', 'Built Green Certified Gold'], nearSchool: true, nearGrocery: false, nearPark: false, url: 'https://www.daytonahomes.ca/greater-edmonton/homes/rvw-027-043', lat: 53.4595327, lng: -113.4245983, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '728 157 Avenue NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 1956, price: 589339, priceNote: 'GST included', possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: false, nearPark: true, url: 'https://www.daytonahomes.ca/greater-edmonton/homes/qvf-004-019', lat: 53.6176917, lng: -113.3409824, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2475 Alces Link SW', community: 'Alces', beds: 4, baths: 3, sqft: 1707, price: 512616, priceNote: 'GST included', possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: true, nearGrocery: false, nearPark: true, url: 'https://www.daytonahomes.ca/greater-edmonton/homes/alcrpl-007-037', lat: 53.4283106, lng: -113.3775223, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2046 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, price: 498864, priceNote: 'GST included', possession: 'November 2026', features: [], nearSchool: false, nearGrocery: true, nearPark: true, url: 'https://www.daytonahomes.ca/greater-edmonton/homes/chpdx-007-025', lat: 53.4071766, lng: -113.554081, geocodePrecision: 'address' },

  // ---------- CALGARY (real, live — identified by model name, not street address, per Daytona's own Calgary site display) ----------
  { city: 'Calgary', address: 'The Valencia R', community: 'Harmony', beds: 3, baths: 2.5, sqft: 2465, price: 882900, priceNote: 'GST included', possession: 'Contact for date', features: ['Triple Car Detached Garage', 'Open to Below', 'Side Entry', 'Main Floor Den', 'Built Green Gold'], nearSchool: false, nearGrocery: true, nearPark: false, url: 'https://daytonahomes.ca/greater-calgary/homes/har-041-007', lat: 51.0489098, lng: -114.0635983, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Silverado MF', community: 'Rangeview', beds: 4, baths: 2.5, sqft: 2317, price: 749900, priceNote: 'GST included', possession: 'Contact for date', features: ["9' Foundation", 'Optional Side Entry', 'Tiled Ensuite Shower', 'Built Green Gold Certified'], nearSchool: false, nearGrocery: true, nearPark: true, url: 'https://daytonahomes.ca/greater-calgary/homes/ran-035-012', lat: 50.8732494, lng: -113.9176665, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Austyn-z P', community: 'Walden', beds: 3, baths: 2.5, sqft: 2259, price: 805900, priceNote: 'GST included', possession: 'Contact for date', features: ['Pie Lot', "9' Foundation", 'Legal Basement Suite', 'Fireplace', 'Main Floor Den'], nearSchool: true, nearGrocery: false, nearPark: true, url: 'https://daytonahomes.ca/greater-calgary/homes/wald-033-032', lat: 50.8684925, lng: -114.0280852, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Monaco II R', community: 'Harmony', beds: 3, baths: 2.5, sqft: 2358, price: 849900, priceNote: 'GST included', possession: 'Contact for date', features: ['Rear Attached Garage', 'Rear Deck', 'Main Floor Den', 'Fireplace'], nearSchool: false, nearGrocery: false, nearPark: true, url: 'https://daytonahomes.ca/greater-calgary/homes/har-043-004', lat: 51.0489098, lng: -114.0635983, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Alfa E', community: 'Heartland', beds: 3, baths: 2.5, sqft: 2013, price: 649900, priceNote: 'GST included', possession: 'Contact for date', features: ['Optional Side Entry', 'Fireplace', 'Main Floor Den'], nearSchool: true, nearGrocery: true, nearPark: false, url: 'https://daytonahomes.ca/greater-calgary/homes/hea-046-068', lat: 51.0764214, lng: -113.9346372, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Austyn-z B', community: 'Creekstone', beds: 3, baths: 2.5, sqft: 2259, price: 704667, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: ["9' Foundation", 'Optional Side Entry', 'Main Floor Den', 'U-Shaped Kitchen'], nearSchool: false, nearGrocery: true, nearPark: false, url: 'https://daytonahomes.ca/greater-calgary/homes/crsf-060-004', lat: 50.8596971, lng: -114.0621307, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Silverstone F', community: 'Harmony', beds: 3, baths: 2.5, sqft: 2521, price: 895143, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: ['Triple Car Detached Garage', 'Fireplace'], nearSchool: false, nearGrocery: false, nearPark: true, url: 'https://daytonahomes.ca/greater-calgary/homes/har-105-004', lat: 51.0489098, lng: -114.0635983, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Frontier HS', community: 'Heartland', beds: 3, baths: 2.5, sqft: 1433, price: null, priceNote: 'Sale Pending', possession: 'Contact for date', features: ["9' Foundation", 'Optional Side Entry', 'Built Green Gold Certified'], nearSchool: true, nearGrocery: false, nearPark: false, url: 'https://daytonahomes.ca/greater-calgary/homes/head-054-016', lat: 51.0764214, lng: -113.9346372, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Silverado MF', community: 'Rangeview', beds: 4, baths: 2.5, sqft: 2317, price: 749900, priceNote: 'GST included', possession: 'Contact for date', features: ['Optional Side Entry', 'Fireplace', 'Main Floor Tech Space'], nearSchool: false, nearGrocery: true, nearPark: true, url: 'https://daytonahomes.ca/greater-calgary/homes/ran-020-032', lat: 50.8732494, lng: -113.9176665, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Austyn R', community: 'Southbow Landing', beds: 3, baths: 2.5, sqft: 2259, price: 689900, priceNote: 'GST included', possession: 'Contact for date', features: ["9' Foundation", 'Fireplace', 'Main Floor Den', 'Central Bonus Room'], nearSchool: true, nearGrocery: false, nearPark: false, url: 'https://daytonahomes.ca/greater-calgary/homes/sous-005-061', lat: 51.0456064, lng: -114.057541, geocodePrecision: 'city' },
  { city: 'Calgary', address: 'The Palisade-z II F', community: 'Walden', beds: 3, baths: 2.5, sqft: 1860, price: 728900, priceNote: 'GST included', possession: 'Contact for date', features: ['Backing onto Greenspace', 'Walkout Basement', 'Rear Deck', 'Fireplace'], nearSchool: false, nearGrocery: true, nearPark: true, url: 'https://daytonahomes.ca/greater-calgary/homes/wal-033-019', lat: 50.8684925, lng: -114.0280852, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Breeze II F', community: 'Heartland', beds: 3, baths: 2.5, sqft: 2054, price: 694900, priceNote: 'GST included', possession: 'Contact for date', features: ["9' Foundation", 'Optional Side Entry'], nearSchool: false, nearGrocery: true, nearPark: false, url: 'https://daytonahomes.ca/greater-calgary/homes/her-13-015', lat: 51.0764214, lng: -113.9346372, geocodePrecision: 'community' },

  // ---------- WINNIPEG (real, live) ----------
  { city: 'Winnipeg', address: '129 Mill Rock Road', community: 'Highland Pointe', beds: 4, baths: 3, sqft: 1882, price: 701806, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: false, nearPark: false, url: 'https://daytonahomes.ca/winnipeg/homes/hlp-004-018', lat: 49.8955367, lng: -97.1384584, geocodePrecision: 'city' },
  { city: 'Winnipeg', address: '53 Kite Bay', community: 'Highland Pointe', beds: 4, baths: 3, sqft: 1695, price: 584115, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: false, nearPark: true, url: 'https://daytonahomes.ca/winnipeg/homes/hlp-005-008', lat: 49.8955367, lng: -97.1384584, geocodePrecision: 'city' },
  { city: 'Winnipeg', address: '103-1510 Waverly Street', community: 'Prairie Pointe', beds: 2, baths: 2.5, sqft: 1175, price: 357817, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: true, nearPark: false, url: 'https://daytonahomes.ca/winnipeg/homes/solt-002-103', lat: 49.7768624, lng: -97.2007592, geocodePrecision: 'community' },
  { city: 'Winnipeg', address: '132 Mosaic Street', community: 'Summerlea', beds: 3, baths: 2.5, sqft: 1327, price: 398248, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: false, nearPark: false, url: 'https://daytonahomes.ca/winnipeg/homes/sumth-013-012', lat: 49.912163, lng: -96.9781067, geocodePrecision: 'community' },
  { city: 'Winnipeg', address: '118 Kite Bay', community: 'Highland Pointe', beds: 3, baths: 2, sqft: 1579, price: 539940, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: true, nearPark: false, url: 'https://daytonahomes.ca/winnipeg/homes/hlp-007-008', lat: 49.8955367, lng: -97.1384584, geocodePrecision: 'city' },
  { city: 'Winnipeg', address: '124 Mosaic Street', community: 'Summerlea', beds: 3, baths: 2.5, sqft: 1327, price: 398248, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: false, nearPark: false, url: 'https://daytonahomes.ca/winnipeg/homes/sumth-013-014', lat: 49.912163, lng: -96.9781067, geocodePrecision: 'community' },
  { city: 'Winnipeg', address: '34 Bill Brierclliffe', community: 'Devonshire Park', beds: 3, baths: 2.5, sqft: 1488, price: 509180, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: true, nearPark: true, url: 'https://daytonahomes.ca/winnipeg/homes/dev-005-007a', lat: 49.9068973, lng: -97.0186036, geocodePrecision: 'community' },
  { city: 'Winnipeg', address: '1201-1510 Waverly Street', community: 'Prairie Pointe', beds: 3, baths: 2.5, sqft: 1524, price: 444784, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: true, nearPark: false, url: 'https://daytonahomes.ca/winnipeg/homes/solt-002-1201', lat: 49.7768624, lng: -97.2007592, geocodePrecision: 'community' },
  { city: 'Winnipeg', address: '79 Pegasus Street', community: 'Aurora', beds: 3, baths: 2, sqft: 1579, price: 545287, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: false, nearPark: true, url: 'https://daytonahomes.ca/winnipeg/homes/aura-001-005a', lat: 49.8007788, lng: -97.1369216, geocodePrecision: 'community' },
  { city: 'Winnipeg', address: '120 Mosaic Street', community: 'Summerlea', beds: 3, baths: 2.5, sqft: 1400, price: 411366, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: false, nearPark: false, url: 'https://daytonahomes.ca/winnipeg/homes/sumth-013-015', lat: 49.912163, lng: -96.9781067, geocodePrecision: 'community' },
  { city: 'Winnipeg', address: '185 Treetop Lane', community: 'Highland Pointe', beds: 3, baths: 2.5, sqft: 1400, price: 433378, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: false, nearPark: true, url: 'https://daytonahomes.ca/winnipeg/homes/hlpd-007-004', lat: 49.8955367, lng: -97.1384584, geocodePrecision: 'city' },
  { city: 'Winnipeg', address: '128 Mosaic Street', community: 'Summerlea', beds: 3, baths: 2.5, sqft: 1327, price: 398248, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: false, nearPark: false, url: 'https://daytonahomes.ca/winnipeg/homes/sumth-013-013', lat: 49.912163, lng: -96.9781067, geocodePrecision: 'community' }
];

// ============================================================
// System prompt — real company facts, sourced from daytonahomes.ca
// ============================================================
const SYSTEM_PROMPT = `You are an AI assistant your name is Dakota answering questions on daytonahomes.ca's behalf, embedded as a chat widget on a demo page (reysan.ca/daytona) built to show Daytona Homes what an AI FAQ + home-recommendation assistant could look like on their site.

Do NOT introduce yourself, disclose that you're an AI, or greet the visitor again in your first reply — the chat widget already shows that disclaimer as a static message before the conversation starts. Just respond directly and naturally to whatever the visitor's first message actually says.

FACTS YOU KNOW (do not go beyond these; if asked something not covered, say something like "This is just a demo — I've only been fed a few pieces of knowledge by Rey, so I don't have that detail. If I ever seem to be making something up, let Rey know so he can tighten up the rules." — then point them to daytonahomes.ca or the phone number below if relevant):
- Daytona Homes has 30+ years of homebuilding experience, operating in Greater Edmonton, Greater Calgary, and Winnipeg.
- Greater Edmonton contact: 780.452.2288, 11504 170 Street, Edmonton, AB T5S 1J7.
- Greater Calgary contact: 587.291.2288, 106, 7326-10th St. NE, Calgary, AB T2E 8W1.
- Winnipeg contact: 204.257.7117, 106 Terracon Place, Winnipeg, MB R2J 4G7.
- The home-building process has three steps: (1) choose a community, (2) find a floorplan/model, (3) meet a consultant at a showhome to customize finishings.
- They also sell move-in-ready "quick possession" homes (30-90 days typical, some immediate) in addition to custom builds.
- Home types include single-family front-attached garage, detached garage, duplex, townhome, bungalow, and condo (Ambrea at the Orchards in Edmonton, The Bowbank at Rockland Park in Calgary, Solara in Winnipeg).
- Edmonton-area communities include Chappelle Gardens, Rosemont, Edgemont, Quarry Vista, Alces, The Orchards at Ellerslie, The Uplands at Riverview.
- Calgary-area communities include Southbow Landing, Rangeview, Walden, Harmony, Heartland, and Creekstone (North/Southeast Calgary, Cochrane, and Springbank Area).
- Winnipeg communities include Aurora, Highland Pointe, Summerlea, Devonshire Park, and Prairie Pointe.
- Warranty (Greater Edmonton): handled by Tacada Customer Care (Daytona Homes is a Tacada company) — 1-877-788-7689, Customercare@tacada.ca, Mon-Thurs 8am-5pm, Fri 8am-4pm. Warranty contacts for Calgary and Winnipeg are not loaded in this demo — if asked, say you don't have that detail and point them to daytonahomes.ca/warranty.

DEMO CUSTOMER SERVICE CONTACT — if a visitor wants to speak to a real person, has a question this demo can't answer, or you're using the fallback line above, offer this in addition: this demo's support contact is contact@reysan.ca, monitored weekdays 8am-5pm. If it's currently outside those hours, say so honestly (something like "it's outside our demo support hours right now, so a reply might take a bit, but you're welcome to email anyway") — don't pretend someone will respond instantly outside business hours, but don't discourage them from trying either. For real Daytona warranty or sales questions specifically, still give the real regional phone number/email from FACTS above as the primary contact — contact@reysan.ca is only for questions about this AI demo itself, not a substitute for Daytona's actual customer service.
- Listings shown in this demo are a real, live snapshot pulled directly from daytonahomes.ca — not fictional placeholders. That said, real listings change (sale pending, sold, new ones posted) faster than this demo dataset refreshes, so mention that current availability should be confirmed directly on daytonahomes.ca or with Daytona.

CURRENT LISTINGS (JSON — use ONLY these for specific home recommendations, and filter by the "city" field to match what the visitor said). The nearSchool/nearGrocery/nearPark flags are placeholder demo data, not verified proximity — if asked, say proximity search is a preview/demo feature and the flag is illustrative, not a guarantee. Note priceNote: Edmonton and Calgary prices are GST-included; Winnipeg prices are pre-GST (home & lot) — mention this if a visitor asks about final price. Some entries have price: null with priceNote "Sale Pending" — if a visitor asks about one of these, say it's currently sale pending rather than quoting a price:
${JSON.stringify(LISTINGS, null, 2)}

GUIDED INTAKE FLOW — if a visitor says they're looking for a home, wants a recommendation, or otherwise signals home-shopping intent (not just a general FAQ question), walk them through these four questions ONE AT A TIME, waiting for their answer before asking the next. Don't dump all four at once.
1. "Which city are you looking to build or buy in?" — Daytona operates in Greater Edmonton, Greater Calgary, and Winnipeg. If they name anywhere outside those three, respond with something like "We only build in Greater Edmonton, Greater Calgary, and Winnipeg — would one of those work?" and don't move to the next question until they confirm one.
2. "What's your budget?"
3. "How many bedrooms are you looking for?"
4. "Is there anything specific you'd like — for example, close to a school, grocery store, or park?"
Once all four are answered, filter LISTINGS to the chosen city and recommend 1-3 matching homes using their other answers. If a visitor volunteers several of these in one message, don't re-ask what they already gave you — just fill in whichever are still missing, then recommend.
5. Whenever you suggest or recommend a specific listing to the user, share its direct listing page using the "url" field from that listing's data, in plain text like: "You can view the full listing here: [url]"

Leave one blank line after the listing details, then ask on its own line: "Want to see how sunlight and shadows move across this property throughout the day?"

If they say yes, use that listing's "lat" and "lng" fields to build this link:
https://reysan.ca/daytona/shadow-check.html?lat=[lat]&lng=[lng]
If a listing's "geocodePrecision" field is "community" or "city" rather than "address", you can still share the link, but mention that the sun/shadow view is centered on the general neighborhood rather than the exact lot, since exact address-level location data wasn't available for that one.
Do not fabricate shadow, sunlight, or coordinate claims yourself — only use the lat/lng values actually present in the listing data, and never guess or invent coordinates for a listing that's missing them.
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