'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// GOAL TIMING — standalone ingestion module for football-data/data/goals_time2/,
// a per-match, minute-level goal incident dataset (12 domestic leagues, seasons
// back to 2000 for the top 5). Ingests JSON files entirely in Node — never
// requires dumping raw file contents into a prompt/conversation; all further
// inspection of this data should happen by running this module (or
// league_analysis.js, which consumes it) and reading its small aggregated
// output, not by re-reading the source JSON files (they're 1.4MB+ each).
//
// Used by telegram/league_analysis.js for descriptive per-league goal-timing
// context (Section F). `buildTimingCurve` is also the future input for
// recalibrating static/app.js's computeLiveOdd intra-half timing curve —
// CLAUDE.md flags that curve as currently sourced from external published
// research because it "can't be validated against this dataset (no goal-minute
// data)". This folder closes that gap for the 5 domestic top leagues; wiring it
// into computeLiveOdd is a separate follow-up, not done here.
// ══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');

const GOAL_TIME_DIR = path.resolve(__dirname, '../football-data/data/goals_time2');

// Maps a canonical league name (engine.js's TOP_LEAGUE_GROUPS or
// league_analysis.js's/poisson_model.js's MINOR_LEAGUE_GROUPS) to its
// goals_time2 file-prefix. Covers all 12 domestic leagues the folder
// actually has — the 3 UEFA club competitions have no matching season files
// (cup competitions, not a single continuous domestic season), and the rest
// of MINOR_LEAGUE_GROUPS (England Championship/League 1/2, Serie B/C,
// Bundesliga 2, etc.) simply have no goals_time2 coverage at all.
const LEAGUE_FILE_PREFIX = {
  'England Premier League':  'england_premier-league',
  'Spain La Liga':           'spanien_la-liga',
  'Germany Bundesliga':      'deutschland_bundesliga',
  'Italy Serie A':           'italien_serie-a',
  'France Ligue 1':          'frankreich_ligue-1',
  'Belgium Pro League':      'belgien_jupiler-league',
  'Denmark Superliga':       'danemark_superliga',
  'Netherlands Eredivisie':  'niederlande_eredivisie',
  'Austria Bundesliga':      'osterreich_bundesliga',
  'Poland Ekstraklasa':      'polen_ekstraklasa',
  'Portugal Liga 1':         'portugal_liga-portugal',
  'Switzerland Super League': 'schweiz_super-league',
};

// "74'" -> {base:74, total:74} ; "45+2'" -> {base:45, total:47} ;
// "90+3'" -> {base:90, total:93}. Half attribution and bucketing MUST use
// `base`, not `total`: 45+2' is first-half stoppage — summing to 47 and
// bucketing/halving by that would silently misfile every 1H-stoppage goal
// as 2H (and every 90+N' goal past minute 90 doesn't need this care, but
// stays correct either way since both base and total are > 45).
function parseMinute(raw) {
  const parts = String(raw).replace("'", '').split('+').map(Number);
  const base = parts[0];
  return { base, total: parts.length === 2 ? base + parts[1] : base };
}

function loadSeasonFile(prefix, season) {
  const file = path.join(GOAL_TIME_DIR, `${prefix}-${season}.json`);
  if (!fs.existsSync(file)) return [];
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    console.warn(`[goal_timing] Failed to parse ${file}: ${e.message}`);
    return [];
  }
}

// Walks back N seasons from `latestSeason` (inclusive), e.g.
// lastNSeasons('2024-2025', 3) -> ['2022-2023','2023-2024','2024-2025'].
function lastNSeasons(latestSeason, n) {
  const startYear = parseInt(latestSeason.split('-')[0], 10);
  const seasons = [];
  for (let i = n - 1; i >= 0; i--) {
    const y = startYear - i;
    seasons.push(`${y}-${y + 1}`);
  }
  return seasons;
}

function goalEvents(matches) {
  const goals = [];
  for (const match of matches) {
    for (const inc of match?.incident?.incidents ?? []) {
      if (inc.incident_type !== 'Goal' || inc.minute == null) continue;
      goals.push(parseMinute(inc.minute));
    }
  }
  return goals;
}

// Returns { league, seasons, totalGoals, buckets: {'0-15':n,...}, half: {...} }
// or null if this league has no matching domestic season files.
function buildGoalTimingProfile(canonicalLeague, { seasons = 3, latestSeason = '2024-2025' } = {}) {
  const prefix = LEAGUE_FILE_PREFIX[canonicalLeague];
  if (!prefix) return null;

  const seasonList = lastNSeasons(latestSeason, seasons);
  const matches = seasonList.flatMap(s => loadSeasonFile(prefix, s));
  if (!matches.length) return null;

  const goals = goalEvents(matches);
  const buckets = { '0-15': 0, '16-30': 0, '31-45': 0, '46-60': 0, '61-75': 0, '76-90': 0 };
  let h1 = 0, h2 = 0;

  for (const { base } of goals) {
    if (base <= 45) h1++; else h2++;
    if (base <= 15) buckets['0-15']++;
    else if (base <= 30) buckets['16-30']++;
    else if (base <= 45) buckets['31-45']++;
    else if (base <= 60) buckets['46-60']++;
    else if (base <= 75) buckets['61-75']++;
    else buckets['76-90']++;
  }

  const total = goals.length;
  return {
    league: canonicalLeague,
    seasons: seasonList,
    matchCount: matches.length,
    totalGoals: total,
    buckets,
    bucketPct: Object.fromEntries(Object.entries(buckets).map(([k, v]) => [k, total ? v / total * 100 : 0])),
    half: { h1, h1Pct: total ? h1 / total * 100 : 0, h2, h2Pct: total ? h2 / total * 100 : 0 },
  };
}

// Per-minute cumulative share of goals within each half (minute 0-45 for 1H,
// 0-45 mapped from actual minute 46-90 for 2H) — the shape computeLiveOdd's
// time-decay model needs. Stoppage-time goals are folded into their half's
// final minute bucket (45 / 90) rather than extending the array, since a
// live-odds model only needs "how much of this half's goals have already
// happened by minute X", not exact stoppage timing.
function buildTimingCurve(canonicalLeague, { seasons = 3, latestSeason = '2024-2025' } = {}) {
  const prefix = LEAGUE_FILE_PREFIX[canonicalLeague];
  if (!prefix) return null;

  const seasonList = lastNSeasons(latestSeason, seasons);
  const matches = seasonList.flatMap(s => loadSeasonFile(prefix, s));
  if (!matches.length) return null;

  const goals = goalEvents(matches);
  const h1Counts = new Array(46).fill(0); // index = minute 0..45
  const h2Counts = new Array(46).fill(0); // index = minute-45, i.e. 0..45 for minute 46..90

  for (const { base } of goals) {
    if (base <= 45) h1Counts[Math.max(0, Math.min(base, 45))]++;
    else h2Counts[Math.max(0, Math.min(base - 45, 45))]++;
  }

  const cumulativeShare = (counts) => {
    const total = counts.reduce((s, c) => s + c, 0);
    let running = 0;
    return counts.map(c => { running += c; return total ? running / total : 0; });
  };

  return {
    league: canonicalLeague,
    seasons: seasonList,
    h1Total: h1Counts.reduce((s, c) => s + c, 0),
    h2Total: h2Counts.reduce((s, c) => s + c, 0),
    h1Cumulative: cumulativeShare(h1Counts), // h1Cumulative[m] = share of 1H goals scored by minute m
    h2Cumulative: cumulativeShare(h2Counts), // h2Cumulative[m] = share of 2H goals scored by minute 45+m
  };
}

module.exports = {
  GOAL_TIME_DIR,
  LEAGUE_FILE_PREFIX,
  parseMinute,
  lastNSeasons,
  buildGoalTimingProfile,
  buildTimingCurve,
};
