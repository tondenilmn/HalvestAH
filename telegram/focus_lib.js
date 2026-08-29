'use strict';
// ── Focus-bets shared library (PLAN_FOCUS_BETS.md Phase 1) ────────────────────
// One place for everything the focus-bet scripts (focus_config_search.js,
// focus_crossbook.js, focus_live_price.js, focus_select.js, ...) need:
// loading + merging the CrossBooks Bet365/Sbobet datasets, the 7 in-scope
// bet keys, a market-implied price for each (since the CSVs carry no direct
// historical price for half-time O/U lines — see header note below), and a
// walk-forward harness so every backtest in this feature follows the same
// train/test discipline.
//
// Run `node focus_lib.js --selftest` for a smoke test (row counts, merged
// pairs, base rates, sanity-checked implied prices).

const fs   = require('fs');
const path = require('path');
const Papa = require('papaparse');
const {
  processRow, classifyLeague, wilsonCI, minOdds, TL_CLUSTERS,
} = require('./engine');
const LambdaSolver = require('./live_lambda_solver');

const DATA_DIR = path.resolve(__dirname, '../CrossBooks');
const OUT_DIR  = path.join(__dirname, 'data');

// ── The 7 in-scope bets (PLAN_FOCUS_BETS.md "Scope") ──────────────────────────
const FOCUS_KEYS = [
  'over05_1H', 'over15_1H', 'under05_1H',
  'over05_2H', 'over15_2H', 'under05_2H', 'under15_2H',
];

const FOCUS_LABELS = {
  over05_1H:  'Over 0.5 1H',
  over15_1H:  'Over 1.5 1H',
  under05_1H: 'Under 0.5 1H',
  over05_2H:  'Over 0.5 2H',
  over15_2H:  'Over 1.5 2H',
  under05_2H: 'Under 0.5 2H',
  under15_2H: 'Under 1.5 2H',
};

// Half a bet belongs to + goal-threshold shape, used by the implied-price model.
const FOCUS_HALF = {
  over05_1H: '1H', over15_1H: '1H', under05_1H: '1H',
  over05_2H: '2H', over15_2H: '2H', under05_2H: '2H', under15_2H: '2H',
};
const FOCUS_IS_UNDER = {
  under05_1H: true, under05_2H: true, under15_2H: true,
};
const FOCUS_THRESHOLD = { // "at least N goals" (over) or "at most N-1" (under)
  over05_1H: 1, over15_1H: 2, under05_1H: 1,
  over05_2H: 1, over15_2H: 2, under05_2H: 1, under15_2H: 2,
};

// Default per-book overround assumption for half-time O/U markets — see
// PLAN_FOCUS_BETS.md Phase 1 note 4 (Bet365 half markets run wider than
// Sbobet's). Applied multiplicatively (proportional overround) to the fair
// over/under pair derived from the Poisson split below.
const BOOK_MARGIN = { Bet365: 0.06, Sbobet: 0.04 };

// ── 1H goal-share, weighted from goal_timing_summary.json ────────────────────
// (12 leagues x 3 seasons, real goal-minute data — see CLAUDE.md's "Live 2H
// Time-Decay Odds" section). Weighted by each league's totalGoals so bigger
// samples count more; NOT a flat average of the 12 percentages.
//
// Hand-mirrored copy of static/data/goal_timing_summary.json, NOT a
// require('../static/...') reach-out — Railway's Docker build context is
// scoped to telegram/ only, so a path outside it throws ENOENT in production
// (confirmed 2026-08-29: this crashed notify.js's Railway deploy at require
// time, since loadH1Share() runs eagerly at module load). Same hand-mirroring
// convention telegram/live_model.js/live_lambda_solver.js already use — see
// their header comments. Keep this file in sync by hand if
// static/data/goal_timing_summary.json is ever regenerated
// (telegram/generate_goal_timing_summary.js).
function loadH1Share() {
  const p = path.resolve(__dirname, 'goal_timing_summary.json');
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  let h1 = 0, total = 0;
  for (const lg of Object.values(j.leagues)) {
    h1 += (lg.half.h1Pct / 100) * lg.totalGoals;
    total += lg.totalGoals;
  }
  return total > 0 ? h1 / total : 0.447; // fallback ~pooled average if file missing/empty
}
const H1_SHARE = loadH1Share();

// ── CSV loading ────────────────────────────────────────────────────────────
function monthOf(dateStr) {
  const m = /^(\d{4})-(\d{2})/.exec(String(dateStr || ''));
  return m ? `${m[1]}-${m[2]}` : null;
}

function loadBook(book) {
  const dir = path.join(DATA_DIR, `${book}_Data_months`);
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.toLowerCase().endsWith('.csv')) continue;
    const csv = fs.readFileSync(path.join(dir, f), 'utf8');
    const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true });
    const label = path.basename(f, '.csv');
    for (const row of data) {
      const p = processRow(row, label);
      if (!p) continue;
      p.book = book;
      p.month = monthOf(p.date);
      rows.push(p);
    }
  }
  return rows;
}

// ── Team-name normalisation + match key (same approach as backtest_crossbook.js) ─
function normTeam(s) {
  return (s || '').toLowerCase()
    .replace(/\bfc\b|\bafc\b|\bsc\b|\bfk\b|\bsk\b|\bbk\b|\bac\b|\bas\b/g, '')
    .replace(/\bunited\b/g, 'utd')
    .replace(/[^a-z0-9]/g, '')
    .trim();
}
function matchKey(r) {
  return `${r.date}|${normTeam(r.home_team)}|${normTeam(r.away_team)}`;
}

// Merges two book row-sets by (date, home, away). Returns [{ b365, sbo }],
// keeping every Bet365 row (sbo: null when unmatched — Sbobet covers fewer
// fixtures per CLAUDE.md/the CrossBooks survey).
function mergeBooks(b365Rows, sboRows) {
  const sboMap = new Map();
  for (const r of sboRows) sboMap.set(matchKey(r), r);
  return b365Rows.map(b365 => ({ b365, sbo: sboMap.get(matchKey(b365)) || null }));
}

// ── Outcome lookup ────────────────────────────────────────────────────────
// processRow already computes every FOCUS_KEYS outcome as a boolean field
// (over05_1H, under05_2H, ...) straight from HT/FT scores — no separate
// derivation needed.
function outcome(row, key) {
  return !!row[key];
}

// ── Market-implied price for a focus key ─────────────────────────────────
// The CrossBooks CSVs have no direct historical price for 1H/2H 0.5/1.5
// lines (only FT Over/Under at the closing Total Line) — see
// PLAN_FOCUS_BETS.md Phase 1 note 4. We derive one:
//   1. Fit a bivariate-Poisson (lambda_h, lambda_a) from the row's own
//      closing AH + Over/Under odds via live_lambda_solver (already used
//      elsewhere in this codebase for the same underdetermined-market
//      problem — see that file's header for the rho-by-tier rationale).
//   2. Split total lambda into 1H/2H shares using H1_SHARE (real
//      goal-minute data, not assumed).
//   3. Convert the resulting half-lambda into a fair Over/Under 0.5 or 1.5
//      probability (simple Poisson CDF — home/away split doesn't matter
//      for a pure total-goals threshold).
//   4. Apply a per-book overround (BOOK_MARGIN) to get a priced probability.
// Returns null if the row is missing what solveLambdaFromOdds needs (i.e.
// distinguishable from "priced but at a degenerate probability").
// Cached on the row object itself (key-independent — same total FT lambda
// feeds every focus key's half-split) since the same row objects are reused
// across walk-forward train/test slices and across all 7 keys; the Newton
// solve behind this is the dominant cost of a config-search pass.
function lambdaFromRow(row) {
  if (row.__totalLambda !== undefined) return row.__totalLambda;
  const ahLine = row.fav_side === 'HOME' ? -row.fav_line : row.fav_line;
  const ahHomeOdds = row.fav_side === 'HOME' ? row.fav_oc : row.dog_oc;
  const ahAwayOdds = row.fav_side === 'HOME' ? row.dog_oc : row.fav_oc;
  const res = LambdaSolver.solveLambdaFromOdds({
    ahLine, ahHomeOdds, ahAwayOdds,
    tl: row.tl_c, overOdds: row.ov_c, underOdds: row.un_c,
    tier: row.league_tier,
  });
  row.__totalLambda = res.ok ? (res.lambda_h + res.lambda_a) : null;
  return row.__totalLambda;
}

function poissonAtLeast(lam, k) {
  if (lam <= 0) return k <= 0 ? 1 : 0;
  let cum = 0, fact = 1;
  for (let i = 0; i < k; i++) { if (i > 0) fact *= i; cum += Math.exp(-lam) * Math.pow(lam, i) / fact; }
  return Math.max(0, Math.min(1, 1 - cum));
}

// `correctionPct` (percentage points, e.g. -3.96) is an additive bias
// correction applied to the raw Poisson-split fair probability BEFORE the
// book margin — see computeCalibration()'s header comment for why this
// exists and how it must be derived (walk-forward, from train rows only).
// Defaults to 0 (uncorrected) so existing callers keep working; every
// caller that reports ROI/hit-rate numbers should pass a real value.
function impliedPrice(row, key, correctionPct = 0) {
  const totalLam = lambdaFromRow(row);
  if (totalLam == null) return null;
  const halfLam = FOCUS_HALF[key] === '1H' ? totalLam * H1_SHARE : totalLam * (1 - H1_SHARE);
  const threshold = FOCUS_THRESHOLD[key];
  const pOver = poissonAtLeast(halfLam, threshold);
  const rawFair = FOCUS_IS_UNDER[key] ? 1 - pOver : pOver;
  const fair = rawFair + correctionPct / 100;
  const margin = BOOK_MARGIN[row.book] ?? 0.05;
  // Proportional overround: scale the fair complementary pair (which sums to
  // 1) up so the implied pair sums to (1 + margin) — the standard way a book
  // adds vig evenly across a two-way market.
  const pricedFair = Math.min(0.999, Math.max(0.001, fair));
  const impliedProb = Math.min(0.999, pricedFair * (1 + margin));
  return {
    fairImplied: pricedFair,
    rawFairImplied: rawFair,
    priced: impliedProb,
    price: parseFloat((1 / impliedProb).toFixed(3)),
    totalLambda: totalLam,
    halfLambda: halfLam,
  };
}

// ── Calibration correction ─────────────────────────────────────────────────
// The Poisson-split-of-a-Dixon-Coles-fitted-lambda approach in impliedPrice()
// systematically overstates Over probabilities and understates Under ones —
// confirmed pooled across all 152k Bet365 rows (2026-08-29): every Over-family
// key's model-implied mean was 2.6-4.5pp ABOVE its realized rate, every
// Under-family key's was 2.6-4.0pp BELOW. Plausible cause: splitting a single
// combined FT lambda into independent per-half Poisson processes discards the
// Dixon-Coles tau correction (which specifically adjusts the low-score cells
// P[0][0]/P[1][0]/P[0][1]/P[1][1] — exactly the boundary that 0.5/1.5 markets
// sit on) that the original full-match fit had. Rather than let this bias
// silently inflate every "Under edge" finding, every script that reports
// ROI must compute this correction from TRAIN rows only (never the test
// month — that would leak test-set information into the price) and pass it
// into impliedPrice(). See focus_config_search.js / focus_crossbook.js for
// the walk-forward wiring.
function computeCalibration(rows, key) {
  let sumFair = 0, hits = 0, n = 0;
  for (const r of rows) {
    const ip = impliedPrice(r, key); // correction=0 — raw model estimate
    if (!ip) continue;
    n++;
    sumFair += ip.rawFairImplied;
    if (outcome(r, key)) hits++;
  }
  if (!n) return 0;
  const modelFairPct = sumFair / n * 100;
  const realizedPct = hits / n * 100;
  return realizedPct - modelFairPct; // pp to add to the raw fair probability
}

// ── Shared config-cell bucketing (used by focus_config_search.js AND by
// notify.js's live FOCUS strategy — kept in exactly one place so a live
// match's composite key is built by the identical function that built the
// historical cellKeys in focus_configs.json; string-equality between the two
// is how the live strategy matches a match to a validated config). ─────────
function tlBandOf(tlC) {
  if (tlC == null) return 'UNK';
  for (const [band, [lo, hi]] of Object.entries(TL_CLUSTERS)) {
    if ((lo == null || tlC >= lo) && (hi == null || tlC < hi)) return band;
  }
  return 'UNK';
}
function tierBucket(tier) { return tier === 'OTHER' ? 'OTHER' : 'TOP_MAJOR'; }
function htStateOf(favHt, dogHt) {
  if (favHt === 0 && dogHt === 0) return '0-0';
  if (favHt === 1 && dogHt === 0) return '1-0fav';
  if (favHt === 0 && dogHt === 1) return '0-1dog';
  if (favHt === 1 && dogHt === 1) return '1-1';
  return '2+';
}
// row: anything with fav_line/fav_side/tl_c/league_tier/tl_move/over_move
// (a processRow-shaped object) OR the equivalent live-derived fields.
function compositeKey(row, isHalf2) {
  const base = `${row.fav_line}|${row.fav_side}|${tlBandOf(row.tl_c)}|${tierBucket(row.league_tier)}|${row.tl_move}|${row.over_move}`;
  return isHalf2 ? `${base}|${htStateOf(row.fav_ht, row.dog_ht)}` : base;
}

// ── Loading focus_configs.json (Phase 2's output) for the live strategy ────
// Returns {} if the file doesn't exist yet (e.g. focus_config_search.js
// hasn't been run) so callers degrade to "no configs known" instead of
// crashing notify.js on startup.
function loadFocusConfigs() {
  const file = path.join(OUT_DIR, 'focus_configs.json');
  if (!fs.existsSync(file)) return { results: {} };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

// ── Walk-forward harness ──────────────────────────────────────────────────
// trainTestFn(trainRows, testRows, testMonth) -> array of result objects
// (shape is caller-defined, but each should carry enough to pool later, e.g.
// { key, n, hits, roi... }). Runs over the last `windowMonths` months present
// in `rows` (default 8, per PLAN_FOCUS_BETS.md's walk-forward rule).
function walkForward(rows, trainTestFn, windowMonths = 8) {
  const months = [...new Set(rows.map(r => r.month).filter(Boolean))].sort();
  const testMonths = months.slice(-windowMonths);
  const out = [];
  for (const testMonth of testMonths) {
    const trainRows = rows.filter(r => r.month < testMonth);
    const testRows  = rows.filter(r => r.month === testMonth);
    if (!trainRows.length || !testRows.length) continue;
    const res = trainTestFn(trainRows, testRows, testMonth);
    if (res) out.push({ month: testMonth, result: res });
  }
  return out;
}

// ── Reporting ──────────────────────────────────────────────────────────────
function ensureOutDir() {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
}
function saveJson(name, data) {
  ensureOutDir();
  const file = path.join(OUT_DIR, name.endsWith('.json') ? name : `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
  return file;
}

module.exports = {
  DATA_DIR, FOCUS_KEYS, FOCUS_LABELS, FOCUS_HALF, FOCUS_IS_UNDER, FOCUS_THRESHOLD,
  BOOK_MARGIN, H1_SHARE,
  loadBook, mergeBooks, matchKey, normTeam, monthOf,
  outcome, lambdaFromRow, impliedPrice, computeCalibration, poissonAtLeast,
  tlBandOf, tierBucket, htStateOf, compositeKey, loadFocusConfigs,
  walkForward, saveJson,
  classifyLeague, wilsonCI, minOdds, TL_CLUSTERS,
};

// ── Self-test ──────────────────────────────────────────────────────────────
if (require.main === module && process.argv.includes('--selftest')) {
  console.log('\n═══ focus_lib self-test ═══════════════════════════════════════');
  console.log(`H1_SHARE (weighted from goal_timing_summary.json): ${(H1_SHARE * 100).toFixed(2)}%`);

  const b365 = loadBook('Bet365');
  const sbo  = loadBook('Sbobet');
  console.log(`\nBet365 rows: ${b365.length}`);
  console.log(`Sbobet rows: ${sbo.length}`);

  const months365 = [...new Set(b365.map(r => r.month))].sort();
  console.log(`Bet365 months: ${months365[0]} .. ${months365[months365.length - 1]} (${months365.length} months)`);

  const pairs = mergeBooks(b365, sbo);
  const matchedPairs = pairs.filter(p => p.sbo);
  console.log(`\nMerged pairs: ${pairs.length} (Bet365 rows), ${matchedPairs.length} with a Sbobet match (${(matchedPairs.length / pairs.length * 100).toFixed(1)}%)`);

  console.log('\nOutcome base rates + mean market-implied price (Bet365 rows):');
  console.log(`  ${'Key'.padEnd(14)} ${'base%'.padStart(6)}  ${'mean price'.padStart(11)}  ${'n priced'.padStart(9)}`);
  for (const key of FOCUS_KEYS) {
    const base = b365.filter(r => outcome(r, key)).length / b365.length * 100;
    let sum = 0, n = 0;
    for (const r of b365) {
      const ip = impliedPrice(r, key);
      if (ip) { sum += ip.price; n++; }
    }
    const meanPrice = n ? (sum / n).toFixed(3) : 'n/a';
    console.log(`  ${key.padEnd(14)} ${base.toFixed(1).padStart(6)}  ${String(meanPrice).padStart(11)}  ${String(n).padStart(9)}`);
  }
  console.log('\n(sanity: Over 0.5 1H at TL~2.5 should be roughly 1.25-1.35, Over 0.5 2H roughly 1.20-1.30)');
}
