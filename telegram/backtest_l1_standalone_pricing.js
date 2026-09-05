'use strict';
// Isolates Layer 1 (opening-odds-only signal) from the L123 consensus blend
// and checks it standalone against real bookmaker closing prices — same
// question backtest_l2_standalone_pricing.js already answered for Layer 2
// ("does this layer carry real edge on its own, not just when it happens to
// agree with the other two"), applied to Layer 1 instead.
//
// Layer 1 = fav opening-odds band (ODDS_BANDS) + opening TL band (TL_BANDS),
// mirroring notify.js's layer1Live() exactly (same bands, same base pool
// query by fav_line/fav_side). Same cross-fit mechanism (row.fold A/B,
// price from the OTHER fold) and same market-price check
// (homeWinsFT/awayWinsFT/drawFT always; over25FT/under25FT only when
// tl_c=2.5) as backtest_l2_standalone_pricing.js, so results are directly
// comparable between the two layers.
//
// Usage: node backtest_l1_standalone_pricing.js [testFileLabel] [tier]
//   e.g. node backtest_l1_standalone_pricing.js Bet365_05_26 TOP+MAJOR

const fs = require('fs');
const path = require('path');
const {
  loadDatasetDir, applyBaselineConfig, mergeCrossFit,
  pct, zScore, wilsonCI, minOdds, BETS,
} = require('./engine');

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');
const TEST_LABEL = process.argv[2] || 'Bet365_05_26';
const TIER = (process.argv[3] || 'TOP+MAJOR').toUpperCase();

const MIN_N = 15;
const MIN_Z = 1.5;
const MIN_EDGE = 0;

const DASHBOARD_BET_KEYS = new Set([
  'homeWinsFT', 'drawFT', 'awayWinsFT',
  'over15FT', 'over25FT', 'under15FT', 'under25FT',
  'btts', 'noBtts',
  'homeOver05FT', 'homeOver15FT', 'awayOver05FT', 'awayOver15FT',
]);
const DASH_BETS = BETS.filter(b => DASHBOARD_BET_KEYS.has(b.k));

const MARKET_KEY = { homeWinsFT: 'x2_home_c', awayWinsFT: 'x2_away_c', drawFT: 'x2_draw_c' };
const TL_EXACT_TOL = 0.01;
function getMarketOdds(row, betKey) {
  const flat = MARKET_KEY[betKey];
  if (flat) return row[flat];
  if (betKey === 'over25FT' && row.tl_c != null && Math.abs(row.tl_c - 2.5) < TL_EXACT_TOL) return row.ov_c;
  if (betKey === 'under25FT' && row.tl_c != null && Math.abs(row.tl_c - 2.5) < TL_EXACT_TOL) return row.un_c;
  return null;
}

function qualifiesBet(b) {
  return !!b && b.z >= MIN_Z && (b.lo - b.bl) >= MIN_EDGE;
}
function rank(b) { return b.z * (b.lo / 100); }

function applyTier(rows) {
  if (TIER === 'ALL') return rows;
  if (TIER === 'OTHER') return rows.filter(r => r.league_tier === 'OTHER');
  return rows.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
}

function scoreDashboard(cfgRows, baseRows) {
  if (cfgRows.length < MIN_N || baseRows.length < MIN_N) return [];
  const n = cfgRows.length;
  const results = [];
  for (const b of DASH_BETS) {
    const p = pct(cfgRows, b.k);
    const bl = pct(baseRows, b.k);
    const z = zScore(cfgRows, baseRows, b.k);
    const [lo, hi] = wilsonCI(p, n);
    results.push({ ...b, n, p, bl, z, edge: p - bl, lo, hi, mo: minOdds(p), mo_lo: minOdds(lo) });
  }
  return results;
}

// Same bands notify.js's layer1Live() uses, applied to OPENING odds
// (fav_oo/tl_o) rather than closing (that's Layer 3's job).
const ODDS_BANDS = [
  [null, 1.60], [1.60, 1.75], [1.75, 1.90], [1.90, 2.05],
  [2.05, 2.30], [2.30, 2.70], [2.70, null],
];
const TL_BANDS = {
  '<2':    [null, 2.0],
  '2-2.5': [2.0,  2.5],
  '2.5-3': [2.5,  3.0],
  '>3':    [3.0,  null],
};
function inBand(v, band) {
  if (v == null || !band) return false;
  const [lo, hi] = band;
  return (lo == null || v >= lo) && (hi == null || v < hi);
}
function oddsBandOf(v) {
  const b = ODDS_BANDS.find(bb => inBand(v, bb));
  return b ? `${b[0]}-${b[1]}` : null;
}
function tlBandOf(v) {
  return Object.entries(TL_BANDS).find(([, b]) => inBand(v, b))?.[0] ?? null;
}

// Memoized the same way backtest_l2_standalone_pricing.js is — discrete
// (fav_line, fav_side, odds band, TL band) combos, bounded space.
const _baseCache = new Map();
const _scoreCache = new Map();

function getBase(pool, tag, favLine, favSide) {
  const key = `${tag}|${favLine}|${favSide}`;
  let base = _baseCache.get(key);
  if (base === undefined) {
    base = applyBaselineConfig(pool, { fav_line: favLine, fav_side: favSide });
    _baseCache.set(key, base);
  }
  return base;
}

function scoreLayer1(pool, tag, row) {
  if (row.fav_oo == null) return [];
  const oddsBand = ODDS_BANDS.find(b => inBand(row.fav_oo, b));
  const tlBand = Object.values(TL_BANDS).find(b => inBand(row.tl_o, b));
  const key = `${tag}|${row.fav_line}|${row.fav_side}|${oddsBandOf(row.fav_oo)}|${tlBandOf(row.tl_o)}`;
  let scored = _scoreCache.get(key);
  if (scored !== undefined) return scored;
  const base = getBase(pool, tag, row.fav_line, row.fav_side);
  const cfgRows = base.filter(r => inBand(r.fav_oo, oddsBand) && (tlBand ? inBand(r.tl_o, tlBand) : true));
  scored = scoreDashboard(cfgRows, base);
  _scoreCache.set(key, scored);
  return scored;
}

// Cross-fit L1 pick: qualifying-only, no non-qualifying fallback (matches
// L2's crossFitL2 shape). Falls back to the single unsplit pool if either
// fold is too thin.
function crossFitL1(poolA, poolB, histDb, row) {
  const scoredA = scoreLayer1(poolA, 'A', row);
  const scoredB = scoreLayer1(poolB, 'B', row);
  const crossFit = (scoredA.length && scoredB.length) ? mergeCrossFit(scoredA, scoredB, DASH_BETS, qualifiesBet) : [];
  if (crossFit.length) return crossFit.slice().sort((a, b) => rank(b) - rank(a))[0];

  const scored = scoreLayer1(histDb, 'full', row);
  if (!scored.length) return null;
  const qualifying = scored.filter(qualifiesBet).sort((a, b) => rank(b) - rank(a));
  return qualifying[0] || null;
}

function tally(entries, priceKey) {
  const n = entries.length;
  if (!n) return { n: 0, hitRate: 0, roi: 0, avgClaimedP: 0 };
  const hits = entries.filter(e => e.hit).length;
  const hitRate = hits / n * 100;
  const pnl = entries.reduce((s, e) => s + (e.hit ? e[priceKey] - 1 : -1), 0);
  const roi = pnl / n * 100;
  const avgClaimedP = entries.reduce((s, e) => s + e.p, 0) / n;
  return { n, hits, hitRate, roi, avgClaimedP };
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

  const entries = [];
  const marketEntries = [];
  let keyCounts = {};
  let keyMarketableCounts = {};

  for (const row of testDb) {
    const bet = crossFitL1(poolA, poolB, histDb, row);
    if (!bet) continue;

    const hit = row[bet.k] === true;
    entries.push({ hit, mo: parseFloat(bet.mo), mo_lo: parseFloat(bet.mo_lo), p: bet.p });
    keyCounts[bet.k] = (keyCounts[bet.k] || 0) + 1;

    const marketOdds = getMarketOdds(row, bet.k);
    if (marketOdds != null && marketOdds > 1) {
      keyMarketableCounts[bet.k] = (keyMarketableCounts[bet.k] || 0) + 1;
      marketEntries.push({ hit, marketOdds, p: bet.p, mo: parseFloat(bet.mo) });
    }
  }

  console.log(`L1-standalone qualifying picks: ${entries.length}\n`);

  const atMo = tally(entries, 'mo');
  const atLo = tally(entries, 'mo_lo');
  const gap = atMo.avgClaimedP - atMo.hitRate;
  console.log('═'.repeat(90));
  console.log('L1 (opening odds) STANDALONE — internal backtest (own historical pool)');
  console.log('═'.repeat(90));
  console.log(`  n=${atMo.n}  realized hit%=${atMo.hitRate.toFixed(1)}%  claimed avg p=${atMo.avgClaimedP.toFixed(1)}%  calibration gap=${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pp`);
  console.log(`  ROI@mo (fair)          =${(atMo.roi >= 0 ? '+' : '') + atMo.roi.toFixed(1)}%`);
  console.log(`  ROI@mo_lo (conservative)=${(atLo.roi >= 0 ? '+' : '') + atLo.roi.toFixed(1)}%\n`);

  console.log('═'.repeat(90));
  console.log('COVERAGE — which bet keys L1 picked');
  console.log('═'.repeat(90));
  const sortedKeys = Object.entries(keyCounts).sort((a, b) => b[1] - a[1]);
  for (const [k, c] of sortedKeys) {
    const mCount = keyMarketableCounts[k] || 0;
    const tag = mCount === 0 ? '[no market column — model-only]'
      : mCount === c ? '[real market price available]'
      : `[real market price for ${mCount}/${c} — only when tl_c=2.5]`;
    console.log(`  ${tag}  ${k}: ${c}`);
  }
  console.log(`\n  ${marketEntries.length}/${entries.length} L1 picks (${entries.length ? (marketEntries.length / entries.length * 100).toFixed(1) : '0.0'}%) had a real bookmaker price directly checkable.\n`);

  if (marketEntries.length) {
    const n = marketEntries.length;
    const avgMarketOdds = marketEntries.reduce((s, e) => s + e.marketOdds, 0) / n;
    const avgMarketImpliedP = marketEntries.reduce((s, e) => s + 100 / e.marketOdds, 0) / n;
    const avgClaimedP = marketEntries.reduce((s, e) => s + e.p, 0) / n;
    const clearsMarket = marketEntries.filter(e => e.marketOdds >= e.mo);
    const pnlAtMarket = marketEntries.reduce((s, e) => s + (e.hit ? e.marketOdds - 1 : -1), 0);
    const roiAtMarket = pnlAtMarket / n * 100;
    const pnlGated = clearsMarket.reduce((s, e) => s + (e.hit ? e.marketOdds - 1 : -1), 0);
    const roiGated = clearsMarket.length ? pnlGated / clearsMarket.length * 100 : 0;
    console.log('═'.repeat(90));
    console.log(`REAL BOOKMAKER PRICE CHECK — L1 standalone`);
    console.log('═'.repeat(90));
    console.log(`  n=${n}  avg market odds=${avgMarketOdds.toFixed(2)} (implied ${avgMarketImpliedP.toFixed(1)}%)  our claimed p=${avgClaimedP.toFixed(1)}%  edge vs market=${(avgClaimedP - avgMarketImpliedP >= 0 ? '+' : '') + (avgClaimedP - avgMarketImpliedP).toFixed(1)}pp`);
    console.log(`  market odds actually clear our min-odds requirement: ${clearsMarket.length}/${n} (${(clearsMarket.length / n * 100).toFixed(1)}%)`);
    console.log(`  ROI if you always bet at the real market price          =${(roiAtMarket >= 0 ? '+' : '') + roiAtMarket.toFixed(1)}%`);
    console.log(`  ROI only when the real market price clears our min-odds =${(roiGated >= 0 ? '+' : '') + roiGated.toFixed(1)}%  (n=${clearsMarket.length})\n`);
  }
}

main();
