'use strict';
// ── Shared daily call budget for api-football.com (100 req/day free plan) ────
// Tracked across both alert-time verification (apifootball.js) and
// settlement (track_record.js) so the two don't silently compete for the
// same shared quota. Live alert-time checks are treated as higher priority
// than settlement: a missed settlement check just retries on the next
// 30-min cycle with nothing lost, but a missed alert-time check means that
// alert fires without price verification for good. So settlement is capped
// below the full daily limit, reserving a slice of the quota exclusively
// for notifications — settlement backs off gracefully (throws, caught by
// its own per-entry try/catch, retried later) once it would eat into that
// reserve, rather than racing notifications for the same budget.
//
// In-memory only (resets on process restart) — matches the existing
// _fixtureCache pattern in apifootball.js. A restart mid-day just resets to
// a fresh budget; this is a soft safety margin, not a hard external
// rate-limiter, and doesn't need to survive restarts to do its job.

const DAILY_LIMIT = parseInt(process.env.APIFOOTBALL_DAILY_LIMIT || '100', 10);
// Calls reserved exclusively for alert-time (notification) checks —
// settlement can never push total spend past (DAILY_LIMIT - this).
const NOTIFICATION_RESERVE = parseInt(process.env.APIFOOTBALL_NOTIFICATION_RESERVE || '20', 10);

let day = null;
let spent = 0;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function _resetIfNewDay() {
  const d = today();
  if (d !== day) { day = d; spent = 0; }
}

// priority: 'alert' (notification/verification checks) or 'settlement'.
function canSpend(n, priority) {
  _resetIfNewDay();
  const cap = priority === 'settlement' ? DAILY_LIMIT - NOTIFICATION_RESERVE : DAILY_LIMIT;
  return spent + n <= cap;
}

function recordSpend(n) {
  _resetIfNewDay();
  spent += n;
}

function remaining() {
  _resetIfNewDay();
  return Math.max(0, DAILY_LIMIT - spent);
}

function spentToday() {
  _resetIfNewDay();
  return spent;
}

module.exports = { canSpend, recordSpend, remaining, spentToday, DAILY_LIMIT, NOTIFICATION_RESERVE };
