'use strict';
// ── api-football.com — Bet365 price verification for whatever bet L123 fires on ──
// Independent second source to confirm the live Bet365 price the bot used to
// decide "fire" (scraped for free via telegram/livescore.js) is actually real,
// and to report a live Bet365 price for the ~24 bet types that DON'T have a
// live-price gate at all today (only ahCover/dogCover/overTL/underTL have a
// `marketOddsKey` in engine.js's BETS and get checked against match.bet365_odds
// in notify.js's runStrategyL123 — everything else currently fires on
// historical data alone, with zero live verification).
//
// Rate limit (free plan): 100 req/day — NOT viable as a continuous scanning
// gate (that's why the original dog-AH-only version of this file was dropped
// from notify.js). Call this ONLY once, right before sending an alert, never
// on every scan cycle — see wireup in notify.js's runStrategyL123.
//
// Bet365 bookmaker id = 8.
// Fixture IDs are cached per matchId to reduce requests.
//
// Market coverage: Asian Handicap, Match Winner (1X2), Goals Over/Under, and
// Both Teams Score. These are standard markets essentially every bookmaker
// odds provider carries. The other ~24 L123 bet types (favWins2H, homeScored2H,
// over05_1H, etc.) are half-specific/derived stats that aren't reliably listed
// as a single matchable market by generic odds providers — `verifyBet365Price`
// returns `{ supported: false }` for those immediately, without spending an
// API call, so the caller can show "odds check unavailable" instead of
// silently guessing.

const BASE = 'https://v3.football.api-sports.io';
const budget = require('./api_budget');

// ── Fixture ID cache ──────────────────────────────────────────────────────────
const _fixtureCache = new Map();

// ── Helpers ───────────────────────────────────────────────────────────────────
function normName(s) {
  return String(s)
    .toLowerCase()
    .replace(/\b(fc|afc|cf|sc|fk|ac|bfc|bc|utd|united)\b/g, '')
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
function namesMatch(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

async function apiGet(path, key) {
  // Notification (alert-time) priority — see api_budget.js's header comment
  // for why settlement is the one that backs off, not this.
  if (!budget.canSpend(1, 'alert')) {
    throw new Error(`api-football daily budget guard: notification pool ${budget.spentToday('alert')}/${budget.NOTIFICATION_BUDGET} already spent — skipping ${path}`);
  }
  budget.recordSpend(1, 'alert');
  const res = await fetch(`${BASE}${path}`, { headers: { 'x-apisports-key': key } });
  if (!res.ok) throw new Error(`api-football ${path} → HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) {
    throw new Error(`api-football error: ${JSON.stringify(json.errors)}`);
  }
  return json;
}

// ── Fixture lookup ────────────────────────────────────────────────────────────
async function findFixtureId(homeTeam, awayTeam, key) {
  const liveData = await apiGet('/fixtures?live=all', key);
  for (const f of (liveData.response || [])) {
    if (namesMatch(f.teams?.home?.name, homeTeam) && namesMatch(f.teams?.away?.name, awayTeam)) {
      return f.fixture.id;
    }
  }
  const today = new Date().toISOString().slice(0, 10);
  const dayData = await apiGet(`/fixtures?date=${today}`, key);
  for (const f of (dayData.response || [])) {
    if (namesMatch(f.teams?.home?.name, homeTeam) && namesMatch(f.teams?.away?.name, awayTeam)) {
      return f.fixture.id;
    }
  }
  return null;
}

async function getFixtureId(matchId, homeTeam, awayTeam, key) {
  let fixtureId = _fixtureCache.get(matchId);
  if (!fixtureId) {
    fixtureId = await findFixtureId(homeTeam, awayTeam, key);
    if (fixtureId) _fixtureCache.set(matchId, fixtureId);
  }
  return fixtureId;
}

async function getBet365Bookie(fixtureId, key) {
  const data = await apiGet(`/odds?fixture=${fixtureId}&bookmaker=8`, key);
  return (data.response?.[0]?.bookmakers || []).find(b => b.id === 8) || null;
}

function findMarket(bookie, nameRegex) {
  return (bookie.bets || []).find(b => nameRegex.test(b.name)) || null;
}

// "Home -1.25", "Away +0.75", "Home 0", "-1.25" (bare)
function parseAHValue(str) {
  let m = String(str).match(/^(Home|Away)\s+([+-]?\d+(?:[.,]\d+)?)$/i);
  if (m) return { side: m[1].toLowerCase(), hc: parseFloat(m[2].replace(',', '.')) };
  m = String(str).match(/^([+-]?\d+(?:[.,]\d+)?)$/);
  if (m) return { side: null, hc: parseFloat(m[1].replace(',', '.')) };
  return null;
}
// "Over 2.5" / "Under 2.5"
function parseOUValue(str) {
  const m = String(str).match(/^(Over|Under)\s+(\d+(?:[.,]\d+)?)$/i);
  if (!m) return null;
  return { side: m[1].toLowerCase(), line: parseFloat(m[2].replace(',', '.')) };
}

// ── Per-market extractors — each returns a decimal odd or null ───────────────
function extractAH(bookie, side, line) {
  const market = findMarket(bookie, /asian.?handicap/i);
  if (!market) return null;
  for (const v of (market.values || [])) {
    const parsed = parseAHValue(v.value);
    if (!parsed) continue;
    if (parsed.side && parsed.side !== side) continue;
    // side's own line is signed opposite to the fav's positive magnitude
    // depending on who's favoured — caller passes the exact signed line this
    // side should show (e.g. dog is always positive, fav is always negative
    // unless fav is actually the underdog on a 0.00/level line).
    if (Math.abs(parsed.hc - line) < 0.13) {
      const odd = parseFloat(v.odd);
      return isNaN(odd) ? null : odd;
    }
  }
  return null;
}

function extractOU(bookie, side, line) {
  const market = findMarket(bookie, /goals.*over.?under|over.?under.*goals|^over\/under$/i);
  if (!market) return null;
  for (const v of (market.values || [])) {
    const parsed = parseOUValue(v.value);
    if (!parsed) continue;
    if (parsed.side !== side) continue;
    if (Math.abs(parsed.line - line) < 0.13) {
      const odd = parseFloat(v.odd);
      return isNaN(odd) ? null : odd;
    }
  }
  return null;
}

function extractMatchWinner(bookie, outcome) {
  // outcome: 'Home' | 'Draw' | 'Away'
  const market = findMarket(bookie, /match winner|^1x2$/i);
  if (!market) return null;
  const v = (market.values || []).find(x => String(x.value).toLowerCase() === outcome.toLowerCase());
  if (!v) return null;
  const odd = parseFloat(v.odd);
  return isNaN(odd) ? null : odd;
}

function extractBtts(bookie, wanted) {
  // wanted: 'Yes' | 'No'
  const market = findMarket(bookie, /both teams.*score/i);
  if (!market) return null;
  const v = (market.values || []).find(x => String(x.value).toLowerCase() === wanted.toLowerCase());
  if (!v) return null;
  const odd = parseFloat(v.odd);
  return isNaN(odd) ? null : odd;
}

// ── Public API ────────────────────────────────────────────────────────────────
// Given an L123 bet key + the context needed to identify the specific
// selection, returns { supported: true, odds: number|null, fixtureId } or
// { supported: false } for bet types this module doesn't attempt (no API
// call spent in that case).
//
// ctx: { matchId, homeTeam, awayTeam, favSide, favLine, avgTl }
//   favSide:  'HOME' | 'AWAY' — which side is the pre-match favourite
//   favLine:  fav's AH line magnitude, always positive (e.g. 1.00)
//   avgTl:    the bet's avgTl field (only present on overTL/underTL bets) —
//             used as the total-line value to look up, rounded to the
//             nearest standard 0.5 increment since that's what books quote.
async function verifyBet365Price(betKey, ctx, key) {
  const SUPPORTED = new Set(['ahCover', 'dogCover', 'overTL', 'underTL', 'homeWinsFT', 'awayWinsFT', 'drawFT', 'btts']);
  if (!SUPPORTED.has(betKey)) return { supported: false };

  const fixtureId = await getFixtureId(ctx.matchId, ctx.homeTeam, ctx.awayTeam, key);
  if (!fixtureId) return { supported: true, odds: null, fixtureId: null };

  const bookie = await getBet365Bookie(fixtureId, key);
  if (!bookie) return { supported: true, odds: null, fixtureId };

  let odds = null;
  if (betKey === 'ahCover' || betKey === 'dogCover') {
    const favSideForAH = ctx.favSide === 'HOME' ? 'home' : 'away';
    const dogSideForAH = ctx.favSide === 'HOME' ? 'away' : 'home';
    if (betKey === 'ahCover') odds = extractAH(bookie, favSideForAH, -ctx.favLine);
    else                      odds = extractAH(bookie, dogSideForAH, ctx.favLine);
  } else if (betKey === 'overTL' || betKey === 'underTL') {
    const line = ctx.avgTl != null ? Math.round(ctx.avgTl * 2) / 2 : null;
    if (line != null) odds = extractOU(bookie, betKey === 'overTL' ? 'over' : 'under', line);
  } else if (betKey === 'homeWinsFT') {
    odds = extractMatchWinner(bookie, 'Home');
  } else if (betKey === 'awayWinsFT') {
    odds = extractMatchWinner(bookie, 'Away');
  } else if (betKey === 'drawFT') {
    odds = extractMatchWinner(bookie, 'Draw');
  } else if (betKey === 'btts') {
    odds = extractBtts(bookie, 'Yes');
  }

  return { supported: true, odds, fixtureId };
}

module.exports = { verifyBet365Price };
