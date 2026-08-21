'use strict';
// ── api-football.com — Bet365 AH odds fetcher ─────────────────────────────────
// Used to verify Bet365 dog AH odds >= Pinnacle before firing a steam alert.
//
// Bet365 bookmaker id = 8
// Asian Handicap bet id = 7 (fallback: match by name)
//
// Rate limit (free plan): 100 req/day.
// Fixture IDs are cached per matchId to reduce requests.

const BASE = 'https://v3.football.api-sports.io';

// ── Fixture ID cache ──────────────────────────────────────────────────────────
// matchId → fixtureId  (persists for process lifetime, ~one session)
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
  const res = await fetch(`${BASE}${path}`, {
    headers: { 'x-apisports-key': key },
  });
  if (!res.ok) throw new Error(`api-football ${path} → HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) {
    throw new Error(`api-football error: ${JSON.stringify(json.errors)}`);
  }
  return json;
}

// ── Fixture lookup ────────────────────────────────────────────────────────────
// Searches live fixtures first, then today's scheduled fixtures.
async function findFixtureId(homeTeam, awayTeam, key) {
  // 1. Live fixtures
  const liveData = await apiGet('/fixtures?live=all', key);
  for (const f of (liveData.response || [])) {
    if (namesMatch(f.teams?.home?.name, homeTeam) &&
        namesMatch(f.teams?.away?.name, awayTeam)) {
      return f.fixture.id;
    }
  }

  // 2. Today's fixtures (for pre-kick matches)
  const today = new Date().toISOString().slice(0, 10);
  const dayData = await apiGet(`/fixtures?date=${today}`, key);
  for (const f of (dayData.response || [])) {
    if (namesMatch(f.teams?.home?.name, homeTeam) &&
        namesMatch(f.teams?.away?.name, awayTeam)) {
      return f.fixture.id;
    }
  }

  return null;
}

// ── AH value parser ───────────────────────────────────────────────────────────
// Handles formats: "Home -1.25", "Away +0.75", "Home 0", "-1.25" (bare)
function parseAHValue(str) {
  // With side label
  let m = String(str).match(/^(Home|Away)\s+([+-]?\d+(?:[.,]\d+)?)$/i);
  if (m) return { side: m[1].toLowerCase(), hc: parseFloat(m[2].replace(',', '.')) };
  // Bare handicap (no side)
  m = String(str).match(/^([+-]?\d+(?:[.,]\d+)?)$/);
  if (m) return { side: null, hc: parseFloat(m[1].replace(',', '.')) };
  return null;
}

// ── Bet365 AH dog odds ────────────────────────────────────────────────────────
// favSide: 'HOME' | 'AWAY'
// favLc:   fav handicap (always positive, e.g. 1.00)
// Returns the dog's AH decimal odds from Bet365, or null if not found.
async function getBet365DogAHOdds(fixtureId, favSide, favLc, key) {
  const data = await apiGet(
    `/odds?fixture=${fixtureId}&bookmaker=8&bet=7`, key
  );

  // Find Bet365 (id=8) in the response
  const bookie = (data.response?.[0]?.bookmakers || []).find(b => b.id === 8);
  if (!bookie) return null;

  // Find Asian Handicap bet (id=7 or by name)
  const ahBet = (bookie.bets || []).find(
    b => b.id === 7 || /asian.?handicap/i.test(b.name)
  );
  if (!ahBet) return null;

  // Dog is on the opposite side from fav
  const dogSide = favSide === 'HOME' ? 'away' : 'home';

  // favLc is always positive (e.g. 1.00 = fav gives 1.00).
  // Dog gets +favLc, so dog's handicap is +favLc (positive).
  for (const v of (ahBet.values || [])) {
    const parsed = parseAHValue(v.value);
    if (!parsed) continue;

    // Match dog side (if side info present)
    if (parsed.side && parsed.side !== dogSide) continue;

    // Match handicap: dog's value should be +favLc (positive)
    // Allow ±0.13 tolerance (one quarter-step rounding)
    if (Math.abs(Math.abs(parsed.hc) - favLc) < 0.13) {
      const odd = parseFloat(v.odd);
      return isNaN(odd) ? null : odd;
    }
  }

  return null;
}

// ── Public API ────────────────────────────────────────────────────────────────
// matchId:   unique key used for fixture cache (e.g. match.id or home:away)
// homeTeam, awayTeam: team names from Pinnacle feed
// favSide:   'HOME' | 'AWAY'
// favLc:     fav AH line (positive)
// key:       api-football API key
//
// Returns { dogOdds: number, fixtureId: number } or null if not found.
async function fetchBet365DogAH(matchId, homeTeam, awayTeam, favSide, favLc, key) {
  // Use cached fixture ID if available
  let fixtureId = _fixtureCache.get(matchId);

  if (!fixtureId) {
    fixtureId = await findFixtureId(homeTeam, awayTeam, key);
    if (!fixtureId) return null;
    _fixtureCache.set(matchId, fixtureId);
  }

  const dogOdds = await getBet365DogAHOdds(fixtureId, favSide, favLc, key);
  if (dogOdds == null) return null;

  return { dogOdds, fixtureId };
}

module.exports = { fetchBet365DogAH };
