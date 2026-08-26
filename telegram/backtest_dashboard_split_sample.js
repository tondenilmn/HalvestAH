'use strict';
// Same split-sample check as backtest_live_ui_split_sample.js, applied to
// the DAILY DASHBOARD's pick instead of Live Games' HT pick — does the
// Dashboard's openingOddsSignal() suffer the same winner's-curse bias?
//
// openingOddsSignal (static/app.js) does the exact same shape of argmax as
// Live Games/Manual Analysis: build a fav_line+fav_side pool, narrow it to
// an opening-odds band + opening-TL cluster, run scoreBetsFast over the 13
// _DASHBOARD_BET_KEYS FT/pre-match markets, and pick whichever qualifies
// best (or, failing that, the best positive-edge one) — all from that same
// single pool, then priced from that same pool. If that's biased the same
// way, cross-fitting it should have the same effect: hit rate roughly
// unchanged, ROI@mo flips from negative to positive.
//
// This backtest uses row.fold directly (the SAME per-row deterministic
// hash static/app.js and telegram/engine.js now stamp via foldOf()) rather
// than a month-parity split, since that's what would actually ship if this
// gets wired into the Dashboard — a faithful test of the real mechanism,
// not an approximation of it.
//
// Usage: node backtest_dashboard_split_sample.js [testFileLabel] [tier]
//   tier: TOP+MAJOR (default) | OTHER | ALL
//   e.g. node backtest_dashboard_split_sample.js Bet365_04_26

const fs = require('fs');
const path = require('path');
const { loadDatasetDir, pct, zScore, wilsonCI, minOdds, avgMarketImplied, BETS } = require('./engine');

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');
const TEST_LABEL = process.argv[2] || 'Bet365_04_26';
const TIER = (process.argv[3] || 'TOP+MAJOR').toUpperCase();

const MIN_N = 15;   // DEFAULT_MIN_N in app.js
const MIN_Z = 1.5;
const MIN_EDGE = 0;

// Mirrors static/app.js's DASHBOARD_ODDS_BANDS / TL_CLUSTERS / _DASHBOARD_BET_KEYS.
const ODDS_BANDS = [
  [null, 1.60], [1.60, 1.75], [1.75, 1.90], [1.90, 2.05],
  [2.05, 2.30], [2.30, 2.70], [2.70, null],
];
const TL_CLUSTERS = {
  '<2': [null, 2.0], '2-2.5': [2.0, 2.5], '2.5-3': [2.5, 3.0], '>3': [3.0, null],
};
const DASHBOARD_BET_KEYS = new Set([
  'homeWinsFT', 'drawFT', 'awayWinsFT',
  'over15FT', 'over25FT', 'under15FT', 'under25FT',
  'btts', 'noBtts',
  'homeOver05FT', 'homeOver15FT', 'awayOver05FT', 'awayOver15FT',
]);

function inBand(v, band) {
  if (v == null || !band) return false;
  const [lo, hi] = band;
  return (lo == null || v >= lo) && (hi == null || v < hi);
}
function qualifiesBet(b) {
  return !!b && b.z >= MIN_Z && (b.lo - b.bl) >= MIN_EDGE;
}
function scoreRank(b) { return b ? b.z * (b.lo / 100) : -Infinity; }

function applyTier(rows) {
  if (TIER === 'ALL') return rows;
  if (TIER === 'OTHER') return rows.filter(r => r.league_tier === 'OTHER');
  return rows.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
}

// Direct port of scoreBetsFast/scoreBets restricted to DASHBOARD_BET_KEYS —
// baseline == base itself (the whole fav_line+fav_side pool, no further
// odds/TL restriction), matching openingOddsSignal's own baseline choice.
function scoreDashboardBets(cfgRows, base) {
  if (cfgRows.length < MIN_N || base.length < MIN_N) return [];
  const n = cfgRows.length;
  const results = [];
  for (const b of BETS) {
    if (!DASHBOARD_BET_KEYS.has(b.k)) continue;
    const p = pct(cfgRows, b.k);
    const bl = pct(base, b.k);
    const z = zScore(cfgRows, base, b.k);
    const edge = p - bl;
    const [lo, hi] = wilsonCI(p, n);
    results.push({ ...b, n, p, bl, z, edge, lo, hi, mo: minOdds(p), mo_lo: minOdds(lo) });
  }
  return results;
}

// The (favLine, favSide, oddsBand, tlBand) combo space is tiny (7 odds
// bands x 5 tl bands x ~7 lines x 2 sides =~ 490 combos max) compared to
// tens of thousands of test rows sharing them — mirrors the real app's
// dashboardBaselineStats()/_dashBaseCache memoization (same rationale: this
// would otherwise re-filter/re-score the same ~80k-row pool per test row).
// One cache per pool tag ('A'/'B') since poolA and poolB are different rows.
const _baseCache = new Map();   // `${tag}|${line}|${side}` -> base rows
const _scoreCache = new Map();  // `${tag}|${line}|${side}|${oddsIdx}|${tlKey}` -> scoreDashboardBets() result

function bandKeys(favOo, tlO) {
  const oddsIdx = ODDS_BANDS.findIndex(b => inBand(favOo, b));
  const tlKey = Object.keys(TL_CLUSTERS).find(k => inBand(tlO, TL_CLUSTERS[k])) ?? 'none';
  return { oddsIdx, tlKey };
}

function scoredComboFor(pool, tag, favLine, favSide, favOo, tlO) {
  const baseKey = `${tag}|${favLine}|${favSide}`;
  let base = _baseCache.get(baseKey);
  if (!base) {
    base = pool.filter(r => r.fav_line === favLine && r.fav_side === favSide);
    _baseCache.set(baseKey, base);
  }
  if (base.length < MIN_N) return null;

  const { oddsIdx, tlKey } = bandKeys(favOo, tlO);
  const scoreKey = `${baseKey}|${oddsIdx}|${tlKey}`;
  let scored = _scoreCache.get(scoreKey);
  if (scored === undefined) {
    const oddsBand = oddsIdx >= 0 ? ODDS_BANDS[oddsIdx] : null;
    const tlBand = tlKey !== 'none' ? TL_CLUSTERS[tlKey] : null;
    const cfgRows = base.filter(r => inBand(r.fav_oo, oddsBand) && (tlBand ? inBand(r.tl_o, tlBand) : true));
    scored = scoreDashboardBets(cfgRows, base);
    _scoreCache.set(scoreKey, scored);
  }
  return scored;
}

// One fixture's pick from ONE pool — mirrors openingOddsSignal exactly:
// band-narrow, score, take best qualifying (else best positive-edge).
function pickFromPool(pool, tag, favLine, favSide, favOo, tlO) {
  const allBets = scoredComboFor(pool, tag, favLine, favSide, favOo, tlO);
  if (!allBets || !allBets.length) return null;
  const qualifying = allBets.filter(qualifiesBet).sort((a, b) => scoreRank(b) - scoreRank(a));
  const best = qualifying[0] || allBets.filter(b => b.edge > 0 && b.n >= MIN_N).sort((a, b) => scoreRank(b) - scoreRank(a))[0] || null;
  return best ? { bet: best, qualifies: qualifying.length > 0 } : null;
}

// Pricing pool: same fav_line/fav_side/odds-band/TL-cluster narrowing as
// selection (pickFromPool), just run against the OTHER fold's rows.
function priceFromPoolBanded(pool, tag, favLine, favSide, favOo, tlO, key) {
  const bets = scoredComboFor(pool, tag, favLine, favSide, favOo, tlO);
  if (!bets) return null;
  return bets.find(b => b.k === key) || null;
}

function tally(entries, priceKey) {
  const n = entries.length;
  const hits = entries.filter(e => e.hit).length;
  const hitRate = n ? hits / n * 100 : 0;
  const pnl = entries.reduce((s, e) => s + (e.hit ? e[priceKey] - 1 : -1), 0);
  const roi = n ? pnl / n * 100 : 0;
  return { n, hits, hitRate, pnl, roi };
}

function main() {
  const files = fs.readdirSync(BET365_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  const allLabels = files.map(f => path.basename(f, '.csv'));
  if (!allLabels.includes(TEST_LABEL)) {
    console.error(`Unknown test month "${TEST_LABEL}". Available: ${allLabels.join(', ')}`);
    process.exit(1);
  }

  const raw = loadDatasetDir(BET365_DIR);
  const full = applyTier(raw);
  console.log(`Loaded ${raw.length} rows total, tier=${TIER}: ${full.length} rows`);
  console.log(`Test month: ${TEST_LABEL}  (walk-forward — excluded from the historical pool)\n`);

  const histDb = full.filter(r => r.file_label !== TEST_LABEL);
  const testDb = full.filter(r => r.file_label === TEST_LABEL);
  const poolA = histDb.filter(r => r.fold === 'A');
  const poolB = histDb.filter(r => r.fold === 'B');
  console.log(`Historical pool split by row.fold: A=${poolA.length} rows, B=${poolB.length} rows`);
  console.log(`Test matches (tier=${TIER}, ${TEST_LABEL}): ${testDb.length} rows\n`);

  const controlEntries = [];
  const splitEntries = [];

  for (const row of testDb) {
    // Dashboard reads OPENING odds/TL only — mirror deriveOpeningContext
    // using this row's own opening fields for the favourite side.
    const favOoActual = row.fav_oo;
    const tlOActual = row.tl_o;

    const selA = pickFromPool(poolA, 'A', row.fav_line, row.fav_side, favOoActual, tlOActual);
    const selB = pickFromPool(poolB, 'B', row.fav_line, row.fav_side, favOoActual, tlOActual);

    if (selA) controlEntries.push({ hit: row[selA.bet.k] === true, mo: selA.bet.mo });
    if (selB) controlEntries.push({ hit: row[selB.bet.k] === true, mo: selB.bet.mo });

    if (selA) {
      const priced = priceFromPoolBanded(poolB, 'B', row.fav_line, row.fav_side, favOoActual, tlOActual, selA.bet.k);
      if (priced && priced.mo != null) splitEntries.push({ hit: row[selA.bet.k] === true, mo: priced.mo });
    }
    if (selB) {
      const priced = priceFromPoolBanded(poolA, 'A', row.fav_line, row.fav_side, favOoActual, tlOActual, selB.bet.k);
      if (priced && priced.mo != null) splitEntries.push({ hit: row[selB.bet.k] === true, mo: priced.mo });
    }
  }

  const ctl = tally(controlEntries, 'mo');
  const spl = tally(splitEntries, 'mo');

  console.log('═'.repeat(90));
  console.log(`CONTROL — naive select+price from the SAME half (controlA + controlB pooled)`);
  console.log('═'.repeat(90));
  console.log(`  n=${ctl.n}  hit%=${ctl.hitRate.toFixed(1)}%  ROI@mo=${(ctl.roi >= 0 ? '+' : '') + ctl.roi.toFixed(1)}%`);

  console.log(`\n${'═'.repeat(90)}`);
  console.log(`SPLIT-SAMPLE — select from one half, price from the OTHER (splitAB + splitBA pooled)`);
  console.log('═'.repeat(90));
  console.log(`  n=${spl.n}  hit%=${spl.hitRate.toFixed(1)}%  ROI@mo=${(spl.roi >= 0 ? '+' : '') + spl.roi.toFixed(1)}%`);
}

main();
