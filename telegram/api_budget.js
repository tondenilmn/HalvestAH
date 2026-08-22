'use strict';
// ── Shared daily call budget for api-football.com (100 req/day free plan) ────
// Tracked across both alert-time verification (apifootball.js) and
// settlement (track_record.js) so the two don't silently compete for the
// same shared quota. Split into two independent pools rather than one
// shared counter: notifications get their own fixed daily allowance, and
// settlement gets its own — one running out never lets the other borrow
// from it. A refused settlement call is caught by its own per-entry
// try/catch and just retries on the next 30-min cycle with nothing lost;
// a refused notification check just means that alert sends without price
// verification for good.
//
// In-memory only (resets on process restart) — matches the existing
// _fixtureCache pattern in apifootball.js. A restart mid-day just resets to
// a fresh budget; this is a soft safety margin, not a hard external
// rate-limiter, and doesn't need to survive restarts to do its job.

const NOTIFICATION_BUDGET = parseInt(process.env.APIFOOTBALL_NOTIFICATION_BUDGET || '80', 10);
const SETTLEMENT_BUDGET = parseInt(process.env.APIFOOTBALL_SETTLEMENT_BUDGET || '20', 10);
const DAILY_LIMIT = NOTIFICATION_BUDGET + SETTLEMENT_BUDGET;

let day = null;
let notificationSpent = 0;
let settlementSpent = 0;

function today() {
  return new Date().toISOString().slice(0, 10);
}

function _resetIfNewDay() {
  const d = today();
  if (d !== day) { day = d; notificationSpent = 0; settlementSpent = 0; }
}

// priority: 'alert' (notification/verification checks) or 'settlement'.
function canSpend(n, priority) {
  _resetIfNewDay();
  return priority === 'settlement'
    ? settlementSpent + n <= SETTLEMENT_BUDGET
    : notificationSpent + n <= NOTIFICATION_BUDGET;
}

function recordSpend(n, priority) {
  _resetIfNewDay();
  if (priority === 'settlement') settlementSpent += n;
  else notificationSpent += n;
}

function remaining(priority) {
  _resetIfNewDay();
  return priority === 'settlement'
    ? Math.max(0, SETTLEMENT_BUDGET - settlementSpent)
    : Math.max(0, NOTIFICATION_BUDGET - notificationSpent);
}

function spentToday(priority) {
  _resetIfNewDay();
  return priority === 'settlement' ? settlementSpent : notificationSpent;
}

module.exports = { canSpend, recordSpend, remaining, spentToday, DAILY_LIMIT, NOTIFICATION_BUDGET, SETTLEMENT_BUDGET };
