'use strict';
// Same Layer 1 (opening-odds-only) pick as backtest_l1_standalone_pricing.js,
// but checks/settles against the OPENING market price instead of the
// CLOSING one — i.e. "what if I actually bet the moment the line opens,
// instead of waiting for (and checking against) the closing price".
//
// Why this is a different question from backtest_l1_standalone_pricing.js:
// that script's "real market price" was the CLOSING 1X2/O-U price — a
// sharper, more-informed number the market had time to move toward, which
// is why Layer 1 (an opening-odds-only signal) lost to it. The opening
// price is the number actually available if you place the bet immediately
// instead of waiting — a much less efficient, less-informed price at that
// moment, so the same signal has a real shot at beating it even though it
// can't beat the closing price.
//
// Same cross-fit mechanism (row.fold A/B, price from the OTHER fold), same
// Layer 1 bands (ODDS_BANDS/TL_BANDS on fav_oo/tl_o) and same DASH_BETS
// (1X2 + Over/Under 2.5 FT, the only markets with a directly matchable
// price column) as backtest_l1_standalone_pricing.js — but Over/Under 2.5
// eligibility and price now come from the OPENING total line/odds
// (tl_o/ov_o/un_o), not closing (tl_c/ov_c/un_c), since that's the number
// that actually existed at bet time.
//
// Usage: node backtest_l1_at_opening_price.js [testFileLabel] [tier]
//   e.g. node backtest_l1_at_opening_price.js Bet365_05_26 TOP+MAJOR

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

// OPENING columns, not closing — this is the whole point of this script.
const MARKET_KEY_OPEN = { homeWinsFT: 'x2_home_o', awayWinsFT: 'x2_away_o', drawFT: 'x2_draw_o' };
const TL_EXACT_TOL = 0.01;
function getMarketOddsOpen(row, betKey) {
  const flat = MARKET_KEY_OPEN[betKey];
  if (flat) return row[flat];
  if (betKey === 'over25FT' && row.tl_o != null && Math.abs(row.tl_o - 2.5) < TL_EXACT_TOL) return row.ov_o;
  if (betKey === 'under25FT' && row.tl_o != null && Math.abs(row.tl_o - 2.5) < TL_EXACT_TOL) return row.un_o;
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

  const marketEntries = [];
  let keyMarketableCounts = {};
  let totalPicks = 0;

  for (const row of testDb) {
    const bet = crossFitL1(poolA, poolB, histDb, row);
    if (!bet) continue;
    totalPicks++;

    const hit = row[bet.k] === true;
    const marketOdds = getMarketOddsOpen(row, bet.k);
    if (marketOdds != null && marketOdds > 1) {
      keyMarketableCounts[bet.k] = (keyMarketableCounts[bet.k] || 0) + 1;
      marketEntries.push({ hit, marketOdds, p: bet.p, mo: parseFloat(bet.mo) });
    }
  }

  console.log(`L1 picks: ${totalPicks}, of which ${marketEntries.length} had a directly matchable OPENING market price.\n`);

  if (!marketEntries.length) { console.log('No market-checkable picks this month.\n'); return; }

  const n = marketEntries.length;
  const avgMarketOdds = marketEntries.reduce((s, e) => s + e.marketOdds, 0) / n;
  const avgMarketImpliedP = marketEntries.reduce((s, e) => s + 100 / e.marketOdds, 0) / n;
  const avgClaimedP = marketEntries.reduce((s, e) => s + e.p, 0) / n;
  const clearsMarket = marketEntries.filter(e => e.marketOdds >= e.mo);
  const hits = marketEntries.filter(e => e.hit).length;
  const pnlAtMarket = marketEntries.reduce((s, e) => s + (e.hit ? e.marketOdds - 1 : -1), 0);
  const roiAtMarket = pnlAtMarket / n * 100;
  const pnlGated = clearsMarket.reduce((s, e) => s + (e.hit ? e.marketOdds - 1 : -1), 0);
  const roiGated = clearsMarket.length ? pnlGated / clearsMarket.length * 100 : 0;
  const gatedHits = clearsMarket.filter(e => e.hit).length;

  console.log('═'.repeat(90));
  console.log(`REAL BOOKMAKER OPENING PRICE CHECK — L1, bet AT OPENING (no wait for closing)`);
  console.log('═'.repeat(90));
  console.log(`  n=${n}  hit%=${(hits / n * 100).toFixed(1)}%  avg opening odds=${avgMarketOdds.toFixed(2)} (implied ${avgMarketImpliedP.toFixed(1)}%)  our claimed p=${avgClaimedP.toFixed(1)}%  edge vs opening market=${(avgClaimedP - avgMarketImpliedP >= 0 ? '+' : '') + (avgClaimedP - avgMarketImpliedP).toFixed(1)}pp`);
  console.log(`  opening odds actually clear our min-odds requirement: ${clearsMarket.length}/${n} (${(clearsMarket.length / n * 100).toFixed(1)}%)`);
  console.log(`  ROI if you always bet at the opening price               =${(roiAtMarket >= 0 ? '+' : '') + roiAtMarket.toFixed(1)}%`);
  console.log(`  ROI only when the opening price clears our min-odds      =${(roiGated >= 0 ? '+' : '') + roiGated.toFixed(1)}%  (n=${clearsMarket.length}, hit%=${clearsMarket.length ? (gatedHits / clearsMarket.length * 100).toFixed(1) : '0.0'}%)\n`);

  console.log('═'.repeat(90));
  console.log('COVERAGE — which bet keys L1 picked (of the market-checkable subset)');
  console.log('═'.repeat(90));
  const sortedKeys = Object.entries(keyMarketableCounts).sort((a, b) => b[1] - a[1]);
  for (const [k, c] of sortedKeys) console.log(`  ${k}: ${c}`);
  console.log();
}

main();
