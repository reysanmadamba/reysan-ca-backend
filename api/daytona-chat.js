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
// LISTINGS — Edmonton block pulled live from daytonahomes.ca's
// move-in-ready page on Sept 11, 2026 (146 of the ~151 listed at the
// time — a handful fell through due to the site's own live pagination
// re-sorting mid-crawl; treat this as a very close snapshot, not a
// guaranteed-exact one). Calgary/Winnipeg blocks are the earlier,
// smaller curated sample, untouched from before. NOT embedded directly
// in the prompt — see search_listings below, which filters this array
// in actual code rather than asking the model to "remember" it.
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
// nearSchool / nearGrocery / nearGym remain PLACEHOLDER flags —
// not real geo data, same caveat as the original dataset. There's no
// verified per-listing home-type (duplex/bungalow/townhome/etc.) data
// either — the site's Type filter exists but doesn't expose it per
// card, so search_listings can't filter on it; the prompt's fallback
// rule below handles that honestly instead of guessing.
// ============================================================
const LISTINGS = [
  // ---------- EDMONTON (real, live) ----------
  { city: 'Edmonton', address: '2409 189A Street NW', community: 'The Uplands at Riverview', beds: 4, baths: 3, sqft: 1956, priceGst: 629036, pricePreGst: 599082, possession: 'November 2026', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rvw-030-042', lat: 53.4601771, lng: -113.658071, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '8798 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1537, priceGst: null, pricePreGst: null, priceNote: 'Sale Pending', possession: 'Immediate', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/egnl-016-015', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '8686 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1707, priceGst: 499899, pricePreGst: 476095, possession: 'Immediate', features: ['Built Green Certified Gold'], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/dedgnl-010-086', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '5032 Cawsey Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1956, priceGst: null, pricePreGst: null, priceNote: 'Sale Pending', possession: 'October 2026', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/chp-044-016', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '7113 Rosenthal Drive NW', community: 'Rosemont', beds: 2, baths: 2.5, sqft: 1022, priceGst: 359900, pricePreGst: 342761, possession: 'November 2026', features: [], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rmth-011-022', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '5452 Hawthorn Run SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1707, priceGst: 497999, pricePreGst: 474284, possession: 'Immediate', features: ['Side Entry', 'Built Green Certified Gold'], nearSchool: true, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/orc-042-034', lat: 53.4021295, lng: -113.4614895, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '3248 Orchards Wynd SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1400, priceGst: 489300, pricePreGst: 466000, possession: 'November 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/orc-004-024', lat: 53.3999092, lng: -113.4595525, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2479 Alces Link SW', community: 'Alces', beds: 3, baths: 2.5, sqft: 1537, priceGst: 484899, pricePreGst: 461809, possession: 'Immediate', features: ['Side Entry', 'Rear Kitchen'], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrpl-007-039', lat: 53.4283106, lng: -113.3775223, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2018 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, priceGst: 459418, pricePreGst: 437541, possession: 'Immediate', features: [], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/chpdx-007-011', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '18844 28 Avenue NW', community: 'The Uplands at Riverview', beds: 3, baths: 2.5, sqft: 1537, priceGst: 472499, pricePreGst: 449999, possession: 'Immediate', features: ['Side Entry', 'Built Green Certified Gold'], nearSchool: true, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rvw-027-043', lat: 53.4601771, lng: -113.658071, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '728 157 Avenue NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 1956, priceGst: 589339, pricePreGst: 561275, possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/qvf-004-019', lat: 53.6176917, lng: -113.3409824, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2475 Alces Link SW', community: 'Alces', beds: 4, baths: 3, sqft: 1707, priceGst: 494899, pricePreGst: 471333, possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrpl-007-037', lat: 53.4283106, lng: -113.3775223, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2046 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, priceGst: 488864, pricePreGst: 465585, possession: 'November 2026', features: [], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/chpdx-007-025', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '8624 224 Street NW', community: 'Rosemont', beds: 3, baths: 2.5, sqft: 1856, priceGst: null, pricePreGst: null, priceNote: 'Sale Pending', possession: 'Immediate', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rmrsl-009-033', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2058 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, priceGst: null, pricePreGst: null, priceNote: 'Sale Pending', possession: 'November 2026', features: [], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/chpdx-007-030', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '22432  86 Avenue NW', community: 'Rosemont', beds: 3, baths: 2.5, sqft: 1815, priceGst: 584629, pricePreGst: 556790, possession: 'December 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/rmrsl-009-040', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2414 189A Street NW', community: 'The Uplands at Riverview', beds: 5, baths: 3, sqft: 2180, priceGst: 644981, pricePreGst: 614268, possession: 'November 2026', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rvw-030-032', lat: 53.4601771, lng: -113.658071, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '5034 Cawsey Link SW', community: 'Chappelle Gardens', beds: 4, baths: 3, sqft: 1815, priceGst: 587210, pricePreGst: 559248, possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry', 'Luxury Vinyl Plank', '9ft Foundation'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/chp-044-017', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '419 157 Avenue NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 1872, priceGst: null, pricePreGst: null, priceNote: 'Sale Pending', possession: 'Immediate', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/dqvf-006-010', lat: 53.6176713, lng: -113.3382215, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '227 157 Avenue NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 1783, priceGst: 489916, pricePreGst: 466587, possession: 'October 2026', features: ['Side Entry', 'Prep Kitchen'], nearSchool: true, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/qvl-007-007', lat: 53.6176917, lng: -113.3409824, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '7099 Rosenthal Drive NW', community: 'Rosemont', beds: 2, baths: 2.5, sqft: 1022, priceGst: 389900, pricePreGst: 371333, possession: 'Immediate', features: ['Side Entry'], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/rmth-011-015', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '8692 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1707, priceGst: 498899, pricePreGst: 475142, possession: 'Immediate', features: ['Built Green Certified Gold'], nearSchool: true, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/dedgnl-010-089', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '415 157 Avenue NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 2041, priceGst: 574899, pricePreGst: 547523, possession: 'Immediate', features: ['Side Entry'], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/dqvf-006-011', lat: 53.6176917, lng: -113.3409824, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '7111 Rosenthal Drive NW', community: 'Rosemont', beds: 2, baths: 2.5, sqft: 1022, priceGst: 359900, pricePreGst: 342761, possession: 'November 2026', features: [], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rmth-011-021', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '8822 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1537, priceGst: 485098, pricePreGst: 461999, possession: 'September 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/egnl-016-027', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '3210 Orchards Wynd SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1707, priceGst: 510413, pricePreGst: 486108, possession: 'December 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/orc-004-005', lat: 53.3999092, lng: -113.4595525, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '15656 3 Street NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 1537, priceGst: 473999, pricePreGst: 451427, possession: 'Immediate', features: ['Side Entry', 'Rear Kitchen'], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/dqvl-007-016', lat: 53.6181246, lng: -113.3423312, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '8802 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1638, priceGst: 515748, pricePreGst: 491188, possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/egnl-016-017', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2236 5 Avenue SW', community: 'Alces', beds: 4, baths: 2.5, sqft: 2602, priceGst: null, pricePreGst: null, priceNote: 'Sale Pending', possession: 'Immediate', features: ['City Spec', 'Built Green Certified Gold'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrsl-005-029', lat: 53.4285549, lng: -113.390804, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2762 Orchards Road SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1440, priceGst: 448586, pricePreGst: 427225, possession: 'Coming 2027', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/orcth-045-051', lat: 53.4041426, lng: -113.4522275, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2012 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, priceGst: 459086, pricePreGst: 437225, possession: 'Immediate', features: [], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/chpdx-007-008', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2774 Orchards Road SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1322, priceGst: 404049, pricePreGst: 384809, possession: 'Coming 2027', features: [], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/orcth-045-045', lat: 53.4041426, lng: -113.4522275, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '243 Chappelle Drive SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1707, priceGst: 504518, pricePreGst: 480494, possession: 'November 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/chp-010-026', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '9105 Elves Loop NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1707, priceGst: 499899, pricePreGst: 476095, possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry', '9\' Foundation'], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/dedgnl-012-039', lat: 53.4702015, lng: -113.676425, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2116 5 Avenue SW', community: 'Alces', beds: 5, baths: 3, sqft: 2375, priceGst: 714716, pricePreGst: 680682, possession: 'November 2026', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrsl-005-045', lat: 53.4285549, lng: -113.390804, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2776 Orchards Road SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1440, priceGst: 434706, pricePreGst: 414006, possession: 'Coming 2027', features: ['Side Entry', 'Corner Lot'], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/orcth-045-044', lat: 53.4041426, lng: -113.4522275, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '9303 Elves Crescent NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 2152, priceGst: 674588, pricePreGst: 642465, possession: 'November 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/egnf-013-002', lat: 53.4702015, lng: -113.676425, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '8628 224 Street NW', community: 'Rosemont', beds: 3, baths: 2.5, sqft: 1815, priceGst: 583804, pricePreGst: 556004, possession: 'Immediate', features: [], nearSchool: true, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rmrsl-009-032', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '15715 3 Street NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 2283, priceGst: null, pricePreGst: null, priceNote: 'Sale Pending', possession: 'December 2026', features: ['Side Entry', 'Prep Kitchen', 'Vaulted Ceiling'], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/qvf-003-004', lat: 53.6251133, lng: -113.3347207, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '5872 Raven Crescent NW', community: 'Kinglet by Big Lake', beds: 4, baths: 3, sqft: 2180, priceGst: 622999, pricePreGst: 593332, possession: 'Immediate', features: ['City Spec'], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/kng-008-056', lat: 53.5823539, lng: -113.6970759, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '9103 Elves Loop NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1707, priceGst: 499899, pricePreGst: 476095, possession: 'Immediate', features: [], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/dedgnl-012-040', lat: 53.4702015, lng: -113.676425, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '15724 3 Street NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 1815, priceGst: 544999, pricePreGst: 519046, possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry', 'Built Green Certified Gold'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/dqvf-002-036', lat: 53.6181246, lng: -113.3423312, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '9711 Elves Place NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 2152, priceGst: 640686, pricePreGst: 610177, possession: 'October 2026', features: ['Side Entry', 'Prep Kitchen'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/egnf-015-038', lat: 53.4702015, lng: -113.676425, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '7097 Rosenthal Drive NW', community: 'Rosemont', beds: 2, baths: 2.5, sqft: 1022, priceGst: 359900, pricePreGst: 342761, possession: 'Immediate', features: [], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/rmth-011-014', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '8776 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1638, priceGst: 509418, pricePreGst: 485160, possession: 'October 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/egnl-016-004', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '3208 Orchards Wynd SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1783, priceGst: 507970, pricePreGst: 483781, possession: 'November 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/orc-004-004', lat: 53.3999092, lng: -113.4595525, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '19356 29 Avenue NW', community: 'The Uplands at Riverview', beds: 3, baths: 2.5, sqft: 1872, priceGst: 549998, pricePreGst: 523808, possession: 'Immediate', features: ['Side Entry', 'Executive Kitchen Appliances'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rvw-004-096', lat: 53.4601771, lng: -113.658071, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '15648 3 Street NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 1783, priceGst: 492998, pricePreGst: 469522, possession: 'October 2026', features: ['Side Entry', 'Rear Kitchen'], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/qvl-007-018', lat: 53.6181246, lng: -113.3423312, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '5646 Hawthorn Way SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1707, priceGst: 504999, pricePreGst: 480951, possession: 'Immediate', features: ['Side Entry', 'Built Green Certified Gold'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/orc-026-036', lat: 53.4024256, lng: -113.4647296, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2758 Orchards Road SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1322, priceGst: 401024, pricePreGst: 381928, possession: 'Coming 2027', features: [], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/orcth-045-053', lat: 53.4041426, lng: -113.4522275, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '5038 Cawsey Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 2049, priceGst: 618739, pricePreGst: null, possession: 'October 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/chp-044-019', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '253 Chappelle Drive SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1707, priceGst: 505531, pricePreGst: 481459, possession: 'October 2026', features: [], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/chp-010-021', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '5036 Cawsey Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1956, priceGst: 639037, pricePreGst: 608607, possession: 'October 2026', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/chp-044-018', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '257 Chappelle Drive SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1638, priceGst: null, pricePreGst: null, priceNote: 'Sale Pending', possession: 'Immediate', features: [], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/chp-010-019', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '247 Chappelle Drive SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1783, priceGst: null, pricePreGst: 483956, possession: 'November 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/chp-010-024', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '22424 86 Avenue NW', community: 'Rosemont', beds: 3, baths: 2.5, sqft: 1815, priceGst: 569157, pricePreGst: 542055, possession: 'December 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/rmrsl-009-038', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2016 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, priceGst: 458993, pricePreGst: 440075, possession: 'Immediate', features: [], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/chpdx-007-010', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '5852 Raven Crescent NW', community: 'Kinglet by Big Lake', beds: 3, baths: 2.5, sqft: 1956, priceGst: 651250, pricePreGst: 620238, possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/kng-008-066', lat: 53.5823539, lng: -113.6970759, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2024 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, priceGst: 479322, pricePreGst: 456498, possession: 'October 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/chpdx-007-014', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '7109 Rosenthal Drive NW', community: 'Rosemont', beds: 2, baths: 2.5, sqft: 1022, priceGst: 389899, pricePreGst: 371333, possession: 'November 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rmth-011-020', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2042 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, priceGst: 482807, pricePreGst: 459817, possession: 'November 2026', features: [], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/chpdx-007-023', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2507 190 Street NW', community: 'The Uplands at Riverview', beds: 3, baths: 2.5, sqft: 1815, priceGst: 589160, pricePreGst: 561105, possession: 'October 2026', features: [], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rvw-030-024', lat: 53.4601771, lng: -113.658071, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '8688 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1707, priceGst: 498899, pricePreGst: 475142, possession: 'Immediate', features: [], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/dedgnl-010-087', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2704 190 ST NW', community: 'The Uplands at Riverview', beds: 5, baths: 3, sqft: 2180, priceGst: 699699, pricePreGst: 666380, possession: 'November 2026', features: ['Main Floor Bed & Bath', 'Side Entry', 'City Spec', '9\' Foundation'], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/rvw-018-044', lat: 53.4601771, lng: -113.658071, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '5884 Raven Crescent NW', community: 'Kinglet by Big Lake', beds: 3, baths: 2.5, sqft: 2152, priceGst: 613815, pricePreGst: 584586, possession: 'October 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/kngf-008-051', lat: 53.5823539, lng: -113.6970759, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '8616 224 Street NW', community: 'Rosemont', beds: 3, baths: 2.5, sqft: 1856, priceGst: 575249, pricePreGst: 547857, possession: 'December 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rmrsl-009-035', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2112 5 Avenue SW', community: 'Alces', beds: 3, baths: 2.5, sqft: 2283, priceGst: 698880, pricePreGst: 665600, possession: 'November 2026', features: ['Corner Lot', 'Side Entry', 'Main Floor Bed & Full Bathroom'], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrsl-005-046', lat: 53.4285549, lng: -113.390804, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '15720 3 Street NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 1856, priceGst: null, pricePreGst: 507910, possession: 'November 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/qvf-002-037', lat: 53.6181246, lng: -113.3423312, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '5040 Cawsey Link SW', community: 'Chappelle Gardens', beds: 4, baths: 3, sqft: 2152, priceGst: 669203, pricePreGst: 637337, possession: 'November 2026', features: ['Main Floor Bed & Bath', 'Side Entry', 'Prep Kitchen'], nearSchool: true, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/chp-044-020', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2760 Orchards Road SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1440, priceGst: 434784, pricePreGst: 414080, possession: 'Coming 2027', features: ['Side Entry'], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/orcth-045-052', lat: 53.4041426, lng: -113.4522275, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '8632 224 Street NW', community: 'Rosemont', beds: 3, baths: 2.5, sqft: 1815, priceGst: 565899, pricePreGst: 538952, possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rmrsl-009-031', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2768 Orchards Road SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1440, priceGst: 447112, pricePreGst: 425821, possession: 'Coming 2027', features: ['Side Entry'], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/orcth-045-048', lat: 53.4041426, lng: -113.4522275, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '5874 Raven Crescent NW', community: 'Kinglet by Big Lake', beds: 3, baths: 2.5, sqft: 1815, priceGst: 577165, pricePreGst: 549681, possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/kngf-008-055', lat: 53.5823539, lng: -113.6970759, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2040 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, priceGst: 484262, pricePreGst: 461202, possession: 'November 2026', features: [], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/chpdx-007-022', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '3204 Orchards Wynd SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1783, priceGst: 506629, pricePreGst: 482504, possession: 'November 2026', features: ['Side Entry', 'Luxury Vinyl Plank'], nearSchool: true, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/orc-004-002', lat: 53.3999092, lng: -113.4595525, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2491 Alces Link SW', community: 'Alces', beds: 4, baths: 3, sqft: 1707, priceGst: null, pricePreGst: null, priceNote: 'Sale Pending', possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrpl-007-045', lat: 53.4283106, lng: -113.3775223, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '5207 Schonsee Dr NW', community: 'Crystallina Nera', beds: 5, baths: 3, sqft: 2152, priceGst: 647784, pricePreGst: 616938, possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/crs-026-012', lat: 53.6359362, lng: -113.4624808, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '3206 Orchards Wynd SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1707, priceGst: 508523, pricePreGst: 484308, possession: 'November 2026', features: [], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/orc-004-003', lat: 53.3999092, lng: -113.4595525, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '8761 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1783, priceGst: 506827, pricePreGst: 482693, possession: 'November 2026', features: ['Side Entry', 'Rear Kitchen'], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/egnl-014-020', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2363 160 Street SW', community: 'Glenridding Ravine', beds: 3, baths: 2.5, sqft: 1783, priceGst: 514235, pricePreGst: 489748, possession: 'November 2026', features: ['Side Entry', 'Rear Kitchen'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/grrl-014-048', lat: 53.4145494, lng: -113.5999109, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2224 5 Avenue SW', community: 'Alces', beds: 4, baths: 3, sqft: 2283, priceGst: 674998, pricePreGst: 642856, possession: 'Immediate', features: ['Side Entry', 'Main Floor Bed & Bathroom', 'Built Green Certified Gold', 'City Spec'], nearSchool: true, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrsl-005-032', lat: 53.4285549, lng: -113.390804, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '8804 Edgemont Link NW', community: 'Edgemont', beds: 4, baths: 3, sqft: 1707, priceGst: 499194, pricePreGst: 475422, possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/egnl-016-018', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '255 Chappelle Drive SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1707, priceGst: 508028, pricePreGst: 483837, possession: 'Immediate', features: ['Side Entry', 'Prep Kitchen'], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/chp-010-020', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '18812 29 Avenue NW', community: 'The Uplands at Riverview', beds: 3, baths: 2.5, sqft: 1785, priceGst: 554899, pricePreGst: 528476, possession: 'Immediate', features: [], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rvw-026-063', lat: 53.4601771, lng: -113.658071, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '8684 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1638, priceGst: 513758, pricePreGst: 489294, possession: 'September 2026', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/egnl-010-085', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '259 Chappelle Drive SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1638, priceGst: null, pricePreGst: null, priceNote: 'Sale Pending', possession: 'Immediate', features: [], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/chp-010-018', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2036 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, priceGst: 478439, pricePreGst: 455657, possession: 'November 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/chpdx-007-020', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2026 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, priceGst: 477641, pricePreGst: 454897, possession: 'October 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/chpdx-007-015', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '8694  Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1707, priceGst: 513862, pricePreGst: 489392, possession: 'November 2026', features: ['Side Entry', 'Rear Kitchen'], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/egnl-010-090', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2756 Orchards Road SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1322, priceGst: 402576, pricePreGst: 383406, possession: 'Coming 2027', features: [], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/orcth-045-054', lat: 53.4041426, lng: -113.4522275, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '3254 Orchards Wynd SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1638, priceGst: 509536, pricePreGst: 485273, possession: 'November 2026', features: [], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/orc-004-027', lat: 53.3999092, lng: -113.4595525, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '3250 Orchards Wynd SW', community: 'The Orchards at Ellerslie', beds: 4, baths: 3, sqft: 1783, priceGst: 509139, pricePreGst: 484895, possession: 'November 2026', features: ['Main Floor Bed & Bath', 'Side Entry', 'Rear Kitchen'], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/orc-004-025', lat: 53.3999092, lng: -113.4595525, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2708 190 Street NW', community: 'The Uplands at Riverview', beds: 3, baths: 2.5, sqft: 2152, priceGst: 696217, pricePreGst: 663064, possession: 'November 2026', features: ['Side Entry', 'Prep Kitchen', 'City Specification'], nearSchool: true, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rvw-018-042', lat: 53.4601771, lng: -113.658071, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2355 160 Street SW', community: 'Glenridding Ravine', beds: 3, baths: 2.5, sqft: 1537, priceGst: 489918, pricePreGst: 466589, possession: 'October 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/grrl-014-050', lat: 53.4145494, lng: -113.5999109, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '544 22 Street SW', community: 'Alces', beds: 3, baths: 2.5, sqft: 2041, priceGst: 569899, pricePreGst: 542761, possession: 'Immediate', features: [], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrsl-007-022', lat: 53.4292368, lng: -113.3750112, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '8816 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1707, priceGst: 508999, pricePreGst: 484760, possession: 'Immediate', features: ['Side Entry', 'Prep Kitchen'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/dedgnl-016-024', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '3252 Orchards Wynd SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1537, priceGst: 498536, pricePreGst: 474797, possession: 'November 2026', features: ['Side Entry'], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/orc-004-026', lat: 53.3999092, lng: -113.4595525, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '245 Chappelle Drive SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1707, priceGst: 502200, pricePreGst: 478286, possession: 'November 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/chp-010-025', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '5213 Schonsee Dr NW', community: 'Crystallina Nera', beds: 4, baths: 3, sqft: 2180, priceGst: 632475, pricePreGst: 602358, possession: 'Immediate', features: ['Four Bedrooms'], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/crs-026-009', lat: 53.6359362, lng: -113.4624808, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '528 22 Street SW', community: 'Alces', beds: 4, baths: 3, sqft: 2180, priceGst: 604891, pricePreGst: 576087, possession: 'October 2026', features: [], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrsl-007-018', lat: 53.4292368, lng: -113.3750112, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '7115 Rosenthal Drive NW', community: 'Rosemont', beds: 3, baths: 2.5, sqft: 1537, priceGst: 433118, pricePreGst: 412494, possession: 'November 2026', features: ['Corner Lot', 'Custom Built', 'Side Entry'], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/rmth-011-023', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2038 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, priceGst: 478060, pricePreGst: 455296, possession: 'November 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/chpdx-007-021', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '15663 2 Street NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 1537, priceGst: 452999, pricePreGst: 431427, possession: 'October 2026', features: ['Side Entry', 'Rear Kitchen'], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/qvl-007-021', lat: 53.6162206, lng: -113.3444371, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '3708 Cross Landing SW', community: 'Chappelle Gardens', beds: 2, baths: 2, sqft: 1359, priceGst: 735708, pricePreGst: 700675, possession: 'October 2026', features: ['Prep Kitchen', 'Developed Basement', 'Built Green Certified Gold', 'Backs onto Green Space'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/chp-019-029', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '5880 Raven Crescent NW', community: 'Kinglet by Big Lake', beds: 3, baths: 2.5, sqft: 2152, priceGst: 625316, pricePreGst: 595539, possession: 'October 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/kngf-008-053', lat: 53.5823539, lng: -113.6970759, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '5131 Cawsey Bend SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1872, priceGst: 574899, pricePreGst: 547523, possession: 'Immediate', features: [], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/chp-044-009', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2477 Alces Link SW', community: 'Alces', beds: 3, baths: 2.5, sqft: 1638, priceGst: 493899, pricePreGst: 470380, possession: 'Immediate', features: ['Side Entry'], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrpl-007-038', lat: 53.4283106, lng: -113.3775223, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '5209 Schonsee Dr NW', community: 'Crystallina Nera', beds: 3, baths: 2.5, sqft: 2041, priceGst: 619374, pricePreGst: 589880, possession: 'October 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/crs-026-011', lat: 53.6359362, lng: -113.4624808, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2204 5 Avenue SW', community: 'Alces', beds: 4, baths: 2.5, sqft: 2602, priceGst: 684899, pricePreGst: 652285, possession: 'Immediate', features: ['Built Green Certified Gold', 'City Spec'], nearSchool: true, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrsl-005-037', lat: 53.4285549, lng: -113.390804, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2754 Orchards Road SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1440, priceGst: 433950, pricePreGst: 413286, possession: 'Coming 2027', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/orcth-045-055', lat: 53.4041426, lng: -113.4522275, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2060 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, priceGst: 491649, pricePreGst: 468238, possession: 'November 2026', features: [], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/chpdx-007-031', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2136 1 Avenue SW', community: 'Alces', beds: 4, baths: 3, sqft: 1815, priceGst: null, pricePreGst: null, priceNote: 'Sale Pending', possession: 'November 2026', features: ['Main Floor Bed & Bath'], nearSchool: true, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrsl-002-040', lat: 53.4317584, lng: -113.3866164, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '5882 Raven Crescent NW', community: 'Kinglet by Big Lake', beds: 3, baths: 2.5, sqft: 2041, priceGst: 614372, pricePreGst: null, possession: 'October 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/kngf-008-052', lat: 53.5823539, lng: -113.6970759, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '8774 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1783, priceGst: 509892, pricePreGst: 485611, possession: 'October 2026', features: ['Side Entry', 'Rear Kitchen'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/egnl-016-003', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2239 4 Avenue SW', community: 'Alces', beds: 4, baths: 3, sqft: 2283, priceGst: 674998, pricePreGst: 642856, possession: 'Immediate', features: ['Main Floor Bedroom & Bath', 'Built Green Certified Silver', 'City Spec'], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrsl-005-021', lat: 53.4288151, lng: -113.3762112, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2463 Alces Link SW', community: 'Alces', beds: 3, baths: 2.5, sqft: 1783, priceGst: 499899, pricePreGst: 476095, possession: 'Immediate', features: ['Built Green Certified Gold', 'Rear Kithen'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrpl-007-006', lat: 53.4283106, lng: -113.3775223, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '9707 Elves Place NW', community: 'Edgemont', beds: 4, baths: 3, sqft: 2152, priceGst: 648468, pricePreGst: 617589, possession: 'November 2026', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/egnf-015-040', lat: 53.4702015, lng: -113.676425, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '8814 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1783, priceGst: 508881, pricePreGst: 484649, possession: 'October 2026', features: ['Side Entry', 'Rear Kitchen'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/egnl-016-023', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2044 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, priceGst: 488419, pricePreGst: 465161, possession: 'November 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/chpdx-007-024', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2014 Callihoo Link SW', community: 'Chappelle Gardens', beds: 3, baths: 2.5, sqft: 1454, priceGst: 458993, pricePreGst: 437137, possession: 'Immediate', features: [], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/chpdx-007-009', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2320 160 Street SW', community: 'Glenridding Ravine', beds: 4, baths: 3, sqft: 2152, priceGst: 662245, pricePreGst: 630710, possession: 'November 2026', features: ['Main Floor Bed & Bath', 'Side Entry', 'Prep Kitchen'], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/grrf-013-019', lat: 53.4145494, lng: -113.5999109, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '22528 86 Avenue NW', community: 'Rosemont', beds: 4, baths: 3, sqft: 2152, priceGst: 645603, pricePreGst: 614860, possession: 'November 2026', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: true, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rmrsl-009-061', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2715 188 Street NW', community: 'The Uplands at Riverview', beds: 3, baths: 2.5, sqft: 2041, priceGst: 624899, pricePreGst: 595142, possession: 'Immediate', features: ['Side Entry', 'City Spec'], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/rvw-026-081', lat: 53.4601771, lng: -113.658071, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '8772 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1707, priceGst: 498469, pricePreGst: 474733, possession: 'November 2026', features: ['Side Entry', 'Rear Kitchen'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/egnl-016-002', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '5850 Raven Crescent NW', community: 'Kinglet by Big Lake', beds: 3, baths: 2.5, sqft: 2049, priceGst: 589085, pricePreGst: 561033, possession: 'Immediate', features: ['City Spec'], nearSchool: true, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/kng-008-067', lat: 53.5823539, lng: -113.6970759, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '15744 7 Street NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 1872, priceGst: 534899, pricePreGst: 509428, possession: 'Immediate', features: [], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/dqvf-002-019', lat: 53.6184879, lng: -113.3390145, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2224 7 Avenue SW', community: 'Alces', beds: 4, baths: 3, sqft: 1815, priceGst: 562299, pricePreGst: 535523, possession: 'October 2026', features: ['Main Floor Bed & Bath', 'Side Entry', 'Prep Kitchen'], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrsl-007-047', lat: 53.4267046, lng: -113.3906159, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '19348 29 Avenue NW', community: 'The Uplands at Riverview', beds: 3, baths: 2.5, sqft: 1785, priceGst: 557899, pricePreGst: 531333, possession: 'Immediate', features: ['Built Green Certified Silver'], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rvw-004-098', lat: 53.4601771, lng: -113.658071, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '15740 7 Street NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 1815, priceGst: 548563, pricePreGst: 522441, possession: 'October 2026', features: [], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/qvf-002-020', lat: 53.6184879, lng: -113.3390145, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '8620 224 Street NW', community: 'Rosemont', beds: 3, baths: 2.5, sqft: 1815, priceGst: null, pricePreGst: 559350, possession: 'November 2026', features: ['Main Floor Bed & Bath', 'Side Entry', '9\' Foundation'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rmrsl-009-034', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2770 Orchards Road SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1440, priceGst: 435240, pricePreGst: 414515, possession: 'Coming 2027', features: ['Side Entry'], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/orcth-045-047', lat: 53.4041426, lng: -113.4522275, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2136 5 Avenue SW', community: 'Alces', beds: 5, baths: 3, sqft: 2375, priceGst: 674899, pricePreGst: 642761, possession: 'Immediate', features: ['Main Floor Bed & Bath', 'Side Entry', 'Built Green Certified Gold'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrsl-005-040', lat: 53.4285271, lng: -113.3855868, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2211 4 Avenue SW', community: 'Alces', beds: 4, baths: 2.5, sqft: 2602, priceGst: 689899, pricePreGst: 657047, possession: 'Immediate', features: ['Four Bedrooms', 'Built Green Certified Gold'], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrsl-005-014', lat: 53.4288151, lng: -113.3762112, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '8778 Edgemont Link NW', community: 'Edgemont', beds: 3, baths: 2.5, sqft: 1707, priceGst: 496746, pricePreGst: 473092, possession: 'October 2026', features: ['Side Entry', 'Rear Kitchen'], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/egnl-016-005', lat: 53.4693948, lng: -113.6793346, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '724 157 Avenue NE', community: 'Quarry Vista', beds: 3, baths: 2.5, sqft: 2041, priceGst: 587213, pricePreGst: 559250, possession: 'Immediate', features: [], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/qvf-004-018', lat: 53.6176713, lng: -113.3382215, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '8632 226 Street NW', community: 'Rosemont', beds: 3, baths: 2.5, sqft: 1783, priceGst: null, pricePreGst: null, priceNote: 'Sale Pending', possession: 'Immediate', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rmrpl-011-028', lat: 53.5615152, lng: -113.4714311, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '3258 Orchards Wynd SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1537, priceGst: 484409, pricePreGst: 461342, possession: 'November 2026', features: [], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/orc-004-029', lat: 53.3999092, lng: -113.4595525, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '18808 29 Avenue NW', community: 'The Uplands at Riverview', beds: 3, baths: 2.5, sqft: 2041, priceGst: 584899, pricePreGst: 557047, possession: 'Immediate', features: ['Side Entry'], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/rvw-026-064', lat: 53.4601771, lng: -113.658071, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '5215 Schonsee Dr NW', community: 'Crystallina Nera', beds: 4, baths: 2.5, sqft: 2375, priceGst: null, pricePreGst: null, priceNote: 'Sale Pending', possession: 'November 2026', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/crs-026-008', lat: 53.6359362, lng: -113.4624808, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2144 1 Avenue SW', community: 'Alces', beds: 3, baths: 2.5, sqft: 1872, priceGst: null, pricePreGst: null, priceNote: 'Sale Pending', possession: 'October 2026', features: ['Side Entry'], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/alcrsl-002-038', lat: 53.4317584, lng: -113.3866164, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '5883 Raven Crescent NW', community: 'Kinglet by Big Lake', beds: 3, baths: 2.5, sqft: 2164, priceGst: 818532, pricePreGst: 779555, possession: 'Immediate', features: ['Backs on to ravine', 'Walkout basement'], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/kngf-002-080', lat: 53.5823539, lng: -113.6970759, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '5044 Cawsey Link SW', community: 'Chappelle Gardens', beds: 4, baths: 3, sqft: 2180, priceGst: 668686, pricePreGst: 636844, possession: 'November 2026', features: ['Main Floor Bed & Bath', 'Side Entry', 'Prep Kitchen'], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/chp-044-022', lat: 53.4078952, lng: -113.577073, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '15927 24 Avenue SW', community: 'Glenridding Ravine', beds: 5, baths: 3, sqft: 2152, priceGst: null, pricePreGst: null, priceNote: 'Sale Pending', possession: 'November 2026', features: ['Main Floor Bed & Bath', 'Side Entry'], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/grrf-013-035', lat: 53.4119048, lng: -113.602387, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '18804 29 Avenue NW', community: 'The Uplands at Riverview', beds: 3, baths: 2.5, sqft: 2212, priceGst: 614899, pricePreGst: 585619, possession: 'Immediate', features: ['Main Floor Bed & Bath'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-edmonton/homes/rvw-026-065', lat: 53.4601771, lng: -113.658071, geocodePrecision: 'community' },
  { city: 'Edmonton', address: '2772 Orchards Road SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1322, priceGst: 404960, pricePreGst: 385677, possession: 'Coming 2027', features: [], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/orcth-045-046', lat: 53.4041426, lng: -113.4522275, geocodePrecision: 'address' },
  { city: 'Edmonton', address: '2766 Orchards Road SW', community: 'The Orchards at Ellerslie', beds: 3, baths: 2.5, sqft: 1322, priceGst: 416905, pricePreGst: 397053, possession: 'Coming 2027', features: [], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-edmonton/homes/orcth-045-049', lat: 53.4041426, lng: -113.4522275, geocodePrecision: 'address' },

  // ---------- CALGARY (real, live — identified by model name, not street address, per Daytona's own Calgary site display) ----------
  { city: 'Calgary', address: 'The Valencia R', community: 'Harmony', beds: 3, baths: 2.5, sqft: 2465, price: 882900, priceNote: 'GST included', possession: 'Contact for date', features: ['Triple Car Detached Garage', 'Open to Below', 'Side Entry', 'Main Floor Den', 'Built Green Gold'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-calgary/homes/har-041-007', lat: 51.0489098, lng: -114.0635983, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Silverado MF', community: 'Rangeview', beds: 4, baths: 2.5, sqft: 2317, price: 749900, priceNote: 'GST included', possession: 'Contact for date', features: ["9' Foundation", 'Optional Side Entry', 'Tiled Ensuite Shower', 'Built Green Gold Certified'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-calgary/homes/ran-035-012', lat: 50.8732494, lng: -113.9176665, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Austyn-z P', community: 'Walden', beds: 3, baths: 2.5, sqft: 2259, price: 805900, priceNote: 'GST included', possession: 'Contact for date', features: ['Pie Lot', "9' Foundation", 'Legal Basement Suite', 'Fireplace', 'Main Floor Den'], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-calgary/homes/wald-033-032', lat: 50.8684925, lng: -114.0280852, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Monaco II R', community: 'Harmony', beds: 3, baths: 2.5, sqft: 2358, price: 849900, priceNote: 'GST included', possession: 'Contact for date', features: ['Rear Attached Garage', 'Rear Deck', 'Main Floor Den', 'Fireplace'], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-calgary/homes/har-043-004', lat: 51.0489098, lng: -114.0635983, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Alfa E', community: 'Heartland', beds: 3, baths: 2.5, sqft: 2013, price: 649900, priceNote: 'GST included', possession: 'Contact for date', features: ['Optional Side Entry', 'Fireplace', 'Main Floor Den'], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-calgary/homes/hea-046-068', lat: 51.0764214, lng: -113.9346372, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Austyn-z B', community: 'Creekstone', beds: 3, baths: 2.5, sqft: 2259, price: 704667, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: ["9' Foundation", 'Optional Side Entry', 'Main Floor Den', 'U-Shaped Kitchen'], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-calgary/homes/crsf-060-004', lat: 50.8596971, lng: -114.0621307, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Silverstone F', community: 'Harmony', beds: 3, baths: 2.5, sqft: 2521, price: 895143, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: ['Triple Car Detached Garage', 'Fireplace'], nearSchool: false, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/greater-calgary/homes/har-105-004', lat: 51.0489098, lng: -114.0635983, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Frontier HS', community: 'Heartland', beds: 3, baths: 2.5, sqft: 1433, price: null, priceNote: 'Sale Pending', possession: 'Contact for date', features: ["9' Foundation", 'Optional Side Entry', 'Built Green Gold Certified'], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-calgary/homes/head-054-016', lat: 51.0764214, lng: -113.9346372, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Silverado MF', community: 'Rangeview', beds: 4, baths: 2.5, sqft: 2317, price: 749900, priceNote: 'GST included', possession: 'Contact for date', features: ['Optional Side Entry', 'Fireplace', 'Main Floor Tech Space'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-calgary/homes/ran-020-032', lat: 50.8732494, lng: -113.9176665, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Austyn R', community: 'Southbow Landing', beds: 3, baths: 2.5, sqft: 2259, price: 689900, priceNote: 'GST included', possession: 'Contact for date', features: ["9' Foundation", 'Fireplace', 'Main Floor Den', 'Central Bonus Room'], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/greater-calgary/homes/sous-005-061', lat: 51.0456064, lng: -114.057541, geocodePrecision: 'city' },
  { city: 'Calgary', address: 'The Palisade-z II F', community: 'Walden', beds: 3, baths: 2.5, sqft: 1860, price: 728900, priceNote: 'GST included', possession: 'Contact for date', features: ['Backing onto Greenspace', 'Walkout Basement', 'Rear Deck', 'Fireplace'], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/greater-calgary/homes/wal-033-019', lat: 50.8684925, lng: -114.0280852, geocodePrecision: 'community' },
  { city: 'Calgary', address: 'The Breeze II F', community: 'Heartland', beds: 3, baths: 2.5, sqft: 2054, price: 694900, priceNote: 'GST included', possession: 'Contact for date', features: ["9' Foundation", 'Optional Side Entry'], nearSchool: false, nearGrocery: true, nearGym: false, url: 'https://daytonahomes.ca/greater-calgary/homes/her-13-015', lat: 51.0764214, lng: -113.9346372, geocodePrecision: 'community' },

  // ---------- WINNIPEG (real, live) ----------
  { city: 'Winnipeg', address: '129 Mill Rock Road', community: 'Highland Pointe', beds: 4, baths: 3, sqft: 1882, price: 701806, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/winnipeg/homes/hlp-004-018', lat: 49.8955367, lng: -97.1384584, geocodePrecision: 'city' },
  { city: 'Winnipeg', address: '53 Kite Bay', community: 'Highland Pointe', beds: 4, baths: 3, sqft: 1695, price: 584115, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/winnipeg/homes/hlp-005-008', lat: 49.8955367, lng: -97.1384584, geocodePrecision: 'city' },
  { city: 'Winnipeg', address: '103-1510 Waverly Street', community: 'Prairie Pointe', beds: 2, baths: 2.5, sqft: 1175, price: 357817, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/winnipeg/homes/solt-002-103', lat: 49.7768624, lng: -97.2007592, geocodePrecision: 'community' },
  { city: 'Winnipeg', address: '132 Mosaic Street', community: 'Summerlea', beds: 3, baths: 2.5, sqft: 1327, price: 398248, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/winnipeg/homes/sumth-013-012', lat: 49.912163, lng: -96.9781067, geocodePrecision: 'community' },
  { city: 'Winnipeg', address: '118 Kite Bay', community: 'Highland Pointe', beds: 3, baths: 2, sqft: 1579, price: 539940, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/winnipeg/homes/hlp-007-008', lat: 49.8955367, lng: -97.1384584, geocodePrecision: 'city' },
  { city: 'Winnipeg', address: '124 Mosaic Street', community: 'Summerlea', beds: 3, baths: 2.5, sqft: 1327, price: 398248, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/winnipeg/homes/sumth-013-014', lat: 49.912163, lng: -96.9781067, geocodePrecision: 'community' },
  { city: 'Winnipeg', address: '34 Bill Brierclliffe', community: 'Devonshire Park', beds: 3, baths: 2.5, sqft: 1488, price: 509180, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/winnipeg/homes/dev-005-007a', lat: 49.9068973, lng: -97.0186036, geocodePrecision: 'community' },
  { city: 'Winnipeg', address: '1201-1510 Waverly Street', community: 'Prairie Pointe', beds: 3, baths: 2.5, sqft: 1524, price: 444784, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: true, nearGym: true, url: 'https://daytonahomes.ca/winnipeg/homes/solt-002-1201', lat: 49.7768624, lng: -97.2007592, geocodePrecision: 'community' },
  { city: 'Winnipeg', address: '79 Pegasus Street', community: 'Aurora', beds: 3, baths: 2, sqft: 1579, price: 545287, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/winnipeg/homes/aura-001-005a', lat: 49.8007788, lng: -97.1369216, geocodePrecision: 'community' },
  { city: 'Winnipeg', address: '120 Mosaic Street', community: 'Summerlea', beds: 3, baths: 2.5, sqft: 1400, price: 411366, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: false, nearGym: true, url: 'https://daytonahomes.ca/winnipeg/homes/sumth-013-015', lat: 49.912163, lng: -96.9781067, geocodePrecision: 'community' },
  { city: 'Winnipeg', address: '185 Treetop Lane', community: 'Highland Pointe', beds: 3, baths: 2.5, sqft: 1400, price: 433378, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: false, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/winnipeg/homes/hlpd-007-004', lat: 49.8955367, lng: -97.1384584, geocodePrecision: 'city' },
  { city: 'Winnipeg', address: '128 Mosaic Street', community: 'Summerlea', beds: 3, baths: 2.5, sqft: 1327, price: 398248, priceNote: 'Pre-GST, includes home & lot', possession: 'Contact for date', features: [], nearSchool: true, nearGrocery: false, nearGym: false, url: 'https://daytonahomes.ca/winnipeg/homes/sumth-013-013', lat: 49.912163, lng: -96.9781067, geocodePrecision: 'community' }
];

// ============================================================
// TOOLS — search_listings filters the LISTINGS array directly (real code,
// not the model's memory), the same reason the Tim Hortons chat uses
// search_menu instead of pasting the whole menu into the prompt: with 146
// real Edmonton listings now in this dataset, embedding all of them in
// every single message would balloon per-message token cost for no
// benefit — the model only ever needs the handful that actually match
// what the visitor asked for.
// ============================================================
const tools = [
  {
    name: 'search_listings',
    description: 'Search Daytona Homes\' current move-in-ready listings. Always call this fresh whenever a visitor asks about specific homes, prices, or availability — never answer from memory or an earlier call in this conversation, since results can change. Always returns 5 at a time (closest/cheapest matches first) — never more, there is no way to fetch every match in one call. Use "offset" to page through further batches (0, 5, 10, ...) only once the visitor asks to see more; see the RESULT COUNT rule in your instructions for exactly how to offer and paginate this.',
    input_schema: {
      type: 'object',
      properties: {
        city: { type: 'string', description: 'Required — Edmonton, Calgary, or Winnipeg (Daytona\'s only three regions).' },
        exact_price: { type: 'number', description: 'Use this INSTEAD of min_price/max_price when the visitor gives one specific dollar figure rather than a range (e.g. they read a price off a listing, or off daytonahomes.ca directly) — matches that exact GST-included price (or pre-GST price, whichever they gave). Combined with community, this narrows to a single listing in the large majority of cases — see the EXACT PRICE rule in your instructions for when to ask for community too.' },
        min_price: { type: 'number', description: 'Minimum price in CAD, GST included. Do not combine with exact_price.' },
        max_price: { type: 'number', description: 'Maximum price in CAD, GST included. Do not combine with exact_price.' },
        min_beds: { type: 'number' },
        max_beds: { type: 'number' },
        community: { type: 'string', description: 'Optional community/neighbourhood name to filter by, e.g. "Chappelle Gardens".' },
        near_school: { type: 'boolean' },
        near_grocery: { type: 'boolean' },
        near_gym: { type: 'boolean' },
        possession: { type: 'string', description: 'Optional possession timing keyword, e.g. "immediate", "november", "2027".' },
        limit: { type: 'number', description: 'Max listings to return in this call, default 5, max 5 — always show results 5 at a time, never more; see the RESULT COUNT rule in your instructions.' },
        offset: { type: 'number', description: 'Skip this many of the sorted matches before taking "limit" — use this to fetch the NEXT batch of 5 after the visitor has already seen an earlier batch (e.g. offset 5 for results 6-10), never to re-fetch ones already shown.' }
      },
      required: ['city']
    }
  }
];

// OpenAI expects tools wrapped in { type: 'function', function: {...} } —
// same definitions, just reshaped, so the two schemas can't drift apart.
const openaiTools = tools.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema }
}));

const EXACT_PRICE_FALLBACK_RANGE = 50000; // ±$50k, only used when an exact_price search finds nothing

function filterListings({ city, exact_price, min_price, max_price, min_beds, max_beds, community, near_school, near_grocery, near_gym, possession }) {
  return LISTINGS.filter((l) => {
    if (l.city.toLowerCase() !== String(city).toLowerCase()) return false;
    if (community && !l.community.toLowerCase().includes(String(community).toLowerCase())) return false;
    const price = l.priceGst ?? l.price;
    const prePrice = l.pricePreGst ?? null;
    // Matches either price field — the visitor may have read the GST or
    // pre-GST figure off the site, and there's no way to know which.
    if (exact_price != null && price !== exact_price && prePrice !== exact_price) return false;
    if (min_price != null && (price == null || price < min_price)) return false;
    if (max_price != null && (price == null || price > max_price)) return false;
    if (min_beds != null && l.beds < min_beds) return false;
    if (max_beds != null && l.beds > max_beds) return false;
    if (near_school === true && !l.nearSchool) return false;
    if (near_grocery === true && !l.nearGrocery) return false;
    if (near_gym === true && !l.nearGym) return false;
    if (possession && !(l.possession || '').toLowerCase().includes(String(possession).toLowerCase())) return false;
    return true;
  });
}

function searchListings({ city, exact_price, min_price, max_price, min_beds, max_beds, community, near_school, near_grocery, near_gym, possession, limit, offset } = {}) {
  if (!city) return { error: 'city is required (Edmonton, Calgary, or Winnipeg)' };
  // Hard-capped at 5 — results are always shown in batches, never as one
  // big dump, regardless of what the model asks for.
  const cap = Math.min(Math.max(limit || 5, 1), 5);
  const skip = Math.max(offset || 0, 0);
  const args = { city, exact_price, min_price, max_price, min_beds, max_beds, community, near_school, near_grocery, near_gym, possession };

  let matches = filterListings(args);
  let exactPriceFallback = false;
  let nearestAlternative = null;

  // An exact_price search that finds nothing is a dead end for the
  // visitor — widen it automatically rather than making the AI decide to
  // retry (and possibly not bother). The flag below tells the prompt to
  // be upfront that these are nearby, not exact, matches.
  if (exact_price != null && matches.length === 0) {
    matches = filterListings({
      ...args,
      exact_price: undefined,
      min_price: exact_price - EXACT_PRICE_FALLBACK_RANGE,
      max_price: exact_price + EXACT_PRICE_FALLBACK_RANGE
    });
    exactPriceFallback = matches.length > 0;
  }

  const formatListing = (l) => ({
    city: l.city,
    community: l.community,
    address: l.address,
    beds: l.beds,
    baths: l.baths,
    sqft: l.sqft,
    priceGst: l.priceGst ?? l.price ?? null,
    pricePreGst: l.pricePreGst ?? null,
    salePending: (l.priceGst ?? l.price) == null,
    possession: l.possession,
    features: l.features,
    nearSchool: l.nearSchool,
    nearGrocery: l.nearGrocery,
    nearGym: l.nearGym,
    url: l.url,
    lat: l.lat,
    lng: l.lng,
    geocodePrecision: l.geocodePrecision
  });

  // Still nothing (even after the ±$50k widening, or the original search
  // had no price at all — e.g. a community/bed combo that just doesn't
  // exist) — rather than a dead end, drop every price constraint and find
  // what IS available in that city/community/beds scope, so the AI has
  // real numbers and real listings to build a concrete alternative
  // suggestion from instead of guessing or inventing one. Kept separate
  // from totalMatches/listings below — these are alternatives, not
  // matches to what was actually asked for, and shouldn't be presented
  // as if they were.
  if (matches.length === 0) {
    const broader = filterListings({ city, community, min_beds, max_beds, near_school, near_grocery, near_gym, possession });
    if (broader.length > 0) {
      const referencePrice = exact_price ?? (min_price != null && max_price != null ? (min_price + max_price) / 2 : max_price ?? min_price ?? null);
      const sorted = broader.slice().sort((a, b) => {
        const priceA = a.priceGst ?? a.price;
        const priceB = b.priceGst ?? b.price;
        if (referencePrice == null) return (priceA ?? Infinity) - (priceB ?? Infinity); // cheapest first if no price reference at all
        return Math.abs((priceA ?? Infinity) - referencePrice) - Math.abs((priceB ?? Infinity) - referencePrice);
      });
      const suggestedPrice = sorted[0].priceGst ?? sorted[0].price;
      nearestAlternative = {
        suggestedPrice,
        listingsAtSuggestedPrice: broader.filter((l) => (l.priceGst ?? l.price) === suggestedPrice).length,
        totalAvailableInScope: broader.length,
        immediatePossessionCount: broader.filter((l) => (l.possession || '').toLowerCase() === 'immediate').length,
        sampleListings: sorted.slice(0, 3).map(formatListing)
      };
    }
  }

  const totalMatches = matches.length;
  // exact_price means "closest to this dollar figure" — sorting by plain
  // ascending price would just surface the cheapest homes in the ±$50k
  // band, which skews toward the low end and can bury the actual nearest
  // match (e.g. a home $1 away could lose to ones $40k away). Any other
  // search (a real budget range, or no price at all) sorts cheapest-first
  // as before, since there's no single target price to measure against.
  const sortedMatches = matches.slice().sort(
    exact_price != null
      ? (a, b) => Math.abs((a.priceGst ?? a.price ?? Infinity) - exact_price) - Math.abs((b.priceGst ?? b.price ?? Infinity) - exact_price)
      : (a, b) => (a.priceGst ?? a.price ?? Infinity) - (b.priceGst ?? b.price ?? Infinity)
  );
  const shown = sortedMatches.slice(skip, skip + cap).map(formatListing);
  const hasMore = skip + shown.length < totalMatches;

  const result = { totalMatches, shown: shown.length, hasMore, listings: shown };
  if (nearestAlternative) result.nearestAlternative = nearestAlternative;
  if (exactPriceFallback) {
    result.exactPriceFallback = true;
    result.fallbackRangeMin = exact_price - EXACT_PRICE_FALLBACK_RANGE;
    result.fallbackRangeMax = exact_price + EXACT_PRICE_FALLBACK_RANGE;
  }
  return result;
}

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
- Listings are real, live data pulled directly from daytonahomes.ca — not fictional placeholders — searched through the search_listings tool rather than pasted here, since Edmonton alone currently has 146 of them. That said, real listings change (sale pending, sold, new ones posted) faster than this demo dataset refreshes, so mention that current availability should be confirmed directly on daytonahomes.ca or with Daytona.

LISTINGS TOOL — call search_listings whenever a visitor asks about specific homes, prices, or availability. Always call it fresh, even for something you already searched earlier in this conversation — never answer from memory or invent a listing. It requires "city" and takes optional exact_price, min_price/max_price (GST-included), min_beds/max_beds, community, near_school/near_grocery/near_gym, and possession. The near_school/near_grocery/near_gym flags are placeholder demo data, not verified proximity — if asked, say proximity search is a preview/demo feature and the flag is illustrative, not a guarantee. Each result includes priceGst and, when available, pricePreGst — mention the pre-GST figure too if a visitor asks about it. A result with salePending: true has no price yet — say it's currently sale pending rather than quoting a price.

EXACT PRICE — if a visitor gives ONE specific dollar figure instead of a range or ceiling (compare: "$479,899" vs. "under $500k" or "$400k-500k"), that's almost always them trying to find a specific home they already saw, not describing a budget. Use exact_price instead of min_price/max_price. Before searching, ask one quick follow-up: "Do you have a specific community in mind?" — community plus exact price narrows to a single listing in the large majority of cases; without a community it can still return two or three (Daytona reuses the same floor plan across different lots in a community, so identical price/beds/baths/sqft/possession can genuinely exist on more than one address — that's not a search error, just be upfront about it: "A couple of homes match that exact price in [community] — here they are" rather than picking one arbitrarily). There is no way to search by street address or listing name directly — if a visitor gives you an address instead of a price, tell them address lookup isn't supported in this demo and ask for a price or other detail (city, budget, beds, community) instead.
- If an exact_price search comes back with exactPriceFallback: true in the result, that means nothing matched that exact figure so the tool automatically widened to fallbackRangeMin-fallbackRangeMax and these ARE those wider results — say so plainly, stating the actual dollar range rather than "±$50k" (a visitor shouldn't have to do that math themselves): "Nothing at exactly $504,519, but I found [totalMatches] Edmonton homes between $[fallbackRangeMin] and $[fallbackRangeMax]." Never present a fallback result as if it matched the exact price, and never say "within $50,000 of that price" — always spell out the two actual dollar figures.
- If totalMatches is 0 (even after the ±$50k widening above), check the result for a nearestAlternative object before falling back to the generic "use the fallback line" rule — it means the tool found real, currently-available listings once every price constraint was dropped from your search (same city/community/beds, any price), which is enough to make a concrete, specific suggestion instead of a dead end. Use its numbers directly, something like: "Nothing at that price in [community], but there's [totalAvailableInScope] homes available there overall — the closest price point is $[suggestedPrice] ([listingsAtSuggestedPrice] at that price), and [immediatePossessionCount] have immediate possession if timing matters to you. Want me to show you those?" Only recommend specific addresses from nearestAlternative.sampleListings if the visitor says yes — don't dump them unprompted. If nearestAlternative is absent too (nothing at all exists in that city/community/bed combo), that's genuinely nothing to work with — use the fallback line and suggest they try a different community or contact Daytona directly.

RESULT COUNT — search_listings always returns results 5 at a time (the tool hard-caps "limit" at 5) — there is no way to fetch or show "everything" in one shot, and you should never offer to. After every call, state totalMatches, then show this batch (up to 5) as the top/most relevant matches — don't ask permission first, just show them, something like: "I found [totalMatches] listings — here are the top 5 most relevant:" followed by the numbered list.
- If hasMore is true in the result, end that reply by offering the next batch, not "everything": "Want to see 5 more?" If they say yes, call search_listings again with the same filters and offset increased by 5 (0 → 5 → 10 ...) to get the next batch — never re-show ones already shown, and never claim you can pull the full totalMatches count at once.
- If hasMore is false (this batch is the last of them), don't offer more — there isn't any.
- If totalMatches is 5 or fewer, this is just the one and only batch — no "want more" offer needed.
- Don't re-explain a search you already explained earlier in this conversation. If a visitor asks to see the same search again (e.g. "just show me the top 5" after you already said "nothing at exactly $X, here's the $A-$B range"), skip straight to the numbered list — no need to repeat the "nothing at exactly..." or exactPriceFallback preamble a second time for a search you already covered.

GUIDED INTAKE FLOW — if a visitor says they're looking for a home, wants a recommendation, or otherwise signals home-shopping intent (not just a general FAQ question), walk them through these four questions ONE AT A TIME, waiting for their answer before asking the next. Don't dump all four at once.
1. "Which city are you looking to build or buy in?" — Daytona operates in Greater Edmonton, Greater Calgary, and Winnipeg. If they name anywhere outside those three, respond with something like "We only build in Greater Edmonton, Greater Calgary, and Winnipeg — would one of those work?" and don't move to the next question until they confirm one.
2. "What's your budget?" — if they answer with a range or ceiling (e.g. "under $500k", "$400k-500k"), that's max_price/min_price as usual, move on to question 3. If they instead give ONE specific dollar figure, follow the EXACT PRICE rule above (ask about community) before continuing.
3. "How many bedrooms are you looking for?"
4. "Is there anything specific you'd like — for example, close to a school, grocery store, or gym?"
Once all four are answered, call search_listings with city, price info from their budget answer (exact_price+community, or max_price — whichever applies per question 2), min_beds from their bedroom count, and near_school/near_grocery/near_gym if their fourth answer matches one of those — then recommend 1-3 of the returned listings. If a visitor volunteers several of these in one message, don't re-ask what they already gave you — just fill in whichever are still missing, then search.
5. Whenever you suggest or recommend a specific listing to the user, share its direct listing page using the "url" field from that listing's data, in plain text like: "You can view the full listing here: [url]"

When you list TWO OR MORE homes in the same reply, number them (1. 2. 3. ...) in the order you list them — this is what lets the visitor refer back to "the 2nd one" or "#3" instead of retyping an address, and it's how you resolve the shadow-check question below without ambiguity.

Leave one blank line after the listing details, then ask the shadow-check question on its own line, phrased differently depending on how many homes you just listed:
- Exactly ONE listing: "Want to see how sunlight and shadows move across this property throughout the day?"
- TWO OR MORE listings: "Want to see how sunlight and shadows move across any of these? Tell me the number, or say 'all' to see all of them."

Resolving the answer:
- If they name one or more numbers (e.g. "2", "1 and 3", "the second one"), share the shadow-check link for only those specific listings — call search_listings again FIRST with the exact same parameters you used to produce that numbered list (same city/price/beds/community/etc.) so you have fresh lat/lng to work with, then match the number(s) to that position in the results (1st, 2nd, ...) in the same order, which will be the same homes since results are always returned in a consistent order for the same search.
- If they say "all" or otherwise agree without naming a number, share shadow-check links for the listings you actually showed them (not the full totalMatches count) — cap at 5 even if more were shown.
- If they say yes/sure without it being clear which one (this should mostly only happen when exactly one was shown), treat it as that one listing.

For each listing you share a shadow-check link for, use that listing's "lat" and "lng" fields to build this link:
https://reysan.ca/daytona/shadow-check.html?lat=[lat]&lng=[lng]
If a listing's "geocodePrecision" field is "community" or "city" rather than "address", you can still share the link, but mention that the sun/shadow view is centered on the general neighborhood rather than the exact lot, since exact address-level location data wasn't available for that one.
Do not fabricate shadow, sunlight, or coordinate claims yourself — only use the lat/lng values actually present in a search_listings result, and never guess or invent coordinates for a listing that's missing them.
If the visitor is just asking a general FAQ question and hasn't signaled they want a home recommendation, skip this flow and answer normally.

Rules:
- When a visitor describes what they want (city, budget, bed/bath count, community, size, move-in timing, near a school/grocery/gym), call search_listings with those parameters and recommend 1-3 matching homes from the results, citing address, community, price, beds/baths, sqft, and possession date plainly.
- If nothing matches well, say so honestly and mention the full listing inventory is on daytonahomes.ca for that region.
- Never invent listings, prices, square footage, or features — only ever state what a search_listings result actually returned. If a visitor asks about anything not covered in FACTS or a search_listings result — a specific policy, a detail about a listing not included there, anything you're unsure of — use the fallback line above rather than guessing or filling in a plausible-sounding answer.
- UNMATCHED PREFERENCE FALLBACK: if a visitor asks for something specific that isn't tracked in this data (for example "a duplex," "near a hospital," "quiet street," "school district rating," or anything beyond city, budget, beds/baths, sqft, possession, features, near_school, near_grocery, near_gym), be upfront about it rather than pretending to know. Say something like "I've only been fed a limited set of details for this demo, so I don't actually have home-type or hospital-proximity data." Then still be useful like a real agent would: call search_listings on whatever you DO know (city, budget, beds, community, the three proximity flags you have), recommend the closest reasonable match, and explain your reasoning honestly, for example "this one's in a walkable community and close to a grocery store, so it might work, but I'd confirm whether it's a duplex directly with Daytona." Never claim or imply you checked something you don't have data for.
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

// Both loops mutate their own local `messages` copy (the caller passes
// cleanMessages.slice() precisely so this never touches the caller's
// array) — pushing tool-call/tool-result turns in as they happen, same
// two-provider tool-loop pattern the Tim Hortons chat already uses for
// the same reason: a single visitor question can take more than one
// round trip when a tool is involved.
async function runOpenAiLoop(messages) {
  let data = await callOpenAI(messages);
  let message = data.choices[0].message;

  while (message.tool_calls && message.tool_calls.length > 0) {
    messages.push(message);
    for (const call of message.tool_calls) {
      const input = JSON.parse(call.function.arguments || '{}');
      const result = call.function.name === 'search_listings' ? searchListings(input) : { error: 'Unknown tool' };
      messages.push({ role: 'tool', tool_call_id: call.id, content: JSON.stringify(result) });
    }
    data = await callOpenAI(messages);
    message = data.choices[0].message;
  }

  return (message.content || '').trim();
}

async function callOpenAI(messages) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
    },
    body: JSON.stringify({
      model: 'gpt-5.6-luna',
      // gpt-5.6-luna hard-rejects (400) function tools on this endpoint
      // unless reasoning is off — OpenAI's own error: "Function tools with
      // reasoning_effort are not supported for gpt-5.6-luna in
      // /v1/chat/completions... set reasoning_effort to 'none'." This also
      // fixes the earlier empty-reply bug: with reasoning on, the model
      // could spend the whole completion budget on hidden reasoning
      // tokens before writing anything visible.
      reasoning_effort: 'none',
      max_completion_tokens: 1200,
      messages: [{ role: 'system', content: SYSTEM_PROMPT }, ...messages],
      tools: openaiTools,
      tool_choice: 'auto'
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('OpenAI API error:', response.status, errText);
    throw new Error('Upstream chat service error');
  }

  return response.json();
}

async function runClaudeLoop(messages) {
  let response = await callClaude(messages);

  while (response.stop_reason === 'tool_use') {
    const toolUseBlocks = response.content.filter((b) => b.type === 'tool_use');
    const toolResultBlocks = [];
    for (const block of toolUseBlocks) {
      const result = block.name === 'search_listings' ? searchListings(block.input) : { error: 'Unknown tool' };
      toolResultBlocks.push({ type: 'tool_result', tool_use_id: block.id, content: JSON.stringify(result) });
    }
    messages.push({ role: 'assistant', content: response.content });
    messages.push({ role: 'user', content: toolResultBlocks });
    response = await callClaude(messages);
  }

  const textBlock = response.content.find((b) => b.type === 'text');
  return textBlock ? textBlock.text.trim() : "Sorry, I couldn't generate a response just now.";
}

async function callClaude(messages) {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': process.env.ANTHROPIC_API_KEY,
      'anthropic-version': '2023-06-01'
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5',
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      tools,
      messages
    })
  });

  if (!response.ok) {
    const errText = await response.text();
    console.error('Anthropic API error:', response.status, errText);
    throw new Error('Upstream chat service error');
  }

  return response.json();
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
      reply = await runOpenAiLoop(cleanMessages.slice());
    } else {
      reply = await runClaudeLoop(cleanMessages.slice());
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