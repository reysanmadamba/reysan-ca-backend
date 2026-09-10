// lib/store-hours.js
//
// Shared by both timhortons-chat.js and timhortons-voice.js — an order
// placed while the kitchen is closed doesn't make sense regardless of which
// channel it came through, so both channels check the exact same hours the
// exact same way rather than risking two copies drifting out of sync.

const DEFAULT_HOURS = { open: 0, close: 24 }; // open all day, used if a day is missing from the tenant's JSON
const DAY_KEYS = { Mon: 'mon', Tue: 'tue', Wed: 'wed', Thu: 'thu', Fri: 'fri', Sat: 'sat', Sun: 'sun' };

// tenant needs { timezone, hours } — hours is the store_hours JSON object,
// e.g. { mon: { open: 8, close: 22 }, ... }.
export function isWithinStoreHours(tenant) {
  // Which day it is has to be checked in the tenant's own timezone, not the
  // server's — a call/message at 11pm Pacific on a Friday could already be
  // Saturday morning UTC, so this has to use the local day, not the
  // server's day.
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: tenant.timezone, hour: 'numeric', hour12: false, weekday: 'short' }).formatToParts(new Date());
  const hour = parseInt(parts.find((p) => p.type === 'hour').value, 10) % 24;
  const weekdayShort = parts.find((p) => p.type === 'weekday').value; // "Mon", "Tue", etc.
  const dayKey = DAY_KEYS[weekdayShort];

  const todayHours = (dayKey && tenant.hours?.[dayKey]) || DEFAULT_HOURS;
  const { open: openHour, close: closeHour } = todayHours;
  if (openHour === closeHour) return false; // closed all day
  if (closeHour >= 24 && openHour <= 0) return true; // open all day
  return hour >= openHour && hour < closeHour;
}
