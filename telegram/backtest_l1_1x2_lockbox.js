'use strict';
// Lock-box validation of "Layer 1 (opening-odds-only), settled at the
// OPENING 1X2 price, restricted to homeWinsFT/awayWinsFT only" — the
// narrowed hypothesis from backtest_l1_opening_breakdown.js (drawFT and
// Over/Under 2.5 FT dropped: they showed no consistent edge or flipped sign
// across tiers there).
//
// Methodology (mirrors CLAUDE.md's L123 validation: exploratory months +
// never-touched lock-box months, reported separately, no re-tuning after
// seeing the lock-box):
//   - Candidate bet set is fixed to {homeWinsFT, awayWinsFT} BEFORE this
//     script runs anything — drawFT/O-U removed from the argmax entirely so
//     they can't be re-selected.
//   - Bands/MIN_Z/MIN_EDGE/cross-fit mechanism are UNCHANGED from every
//     prior script in this line of investigation — nothing here was tuned
//     to make the lock-box number look good.
//   - Months are split chronologically: the first 14 (Bet365_01_25 through
//     Bet365_02_26) are EXPLORATORY (already partly seen, pooled, in
//     backtest_l1_opening_breakdown.js); the LAST 5 (Bet365_03_26 through
//     Bet365_07_26) are the LOCK-BOX — reported once, as-is.
//
// Usage: node backtest_l1_1x2_lockbox.js [tier]
//   tier: ALL | TOP+MAJOR | OTHER (default: runs all three)

const fs = require('fs');
const path = require('path');
const {
  loadDatasetDir, applyBaselineConfig, mergeCrossFit,
  pct, zScore, wilsonCI, minOdds, BETS,
} = require('./engine');

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');
const TIERS = process.argv[2] ? [process.argv[2].toUpperCase()] : ['TOP+MAJOR', 'OTHER', 'ALL'];

const MIN_N = 15;
const MIN_Z = 1.5;
const MIN_EDGE = 0;

// Narrowed candidate set — homeWinsFT/awayWinsFT ONLY, fixed a priori.
const CANDIDATE_KEYS = new Set(['homeWinsFT', 'awayWinsFT']);
const DASH_BETS = BETS.filter(b => CANDIDATE_KEYS.has(b.k));

const MARKET_KEY_OPEN = { homeWinsFT: 'x2_home_o', awayWinsFT: 'x2_away_o' };
function getMarketOddsOpen(row, betKey) {
  return row[MARKET_KEY_OPEN[betKey]];
}

function qualifiesBet(b) {
  return !!b && b.z >= MIN_Z && (b.lo - b.bl) >= MIN_EDGE;
}
function rank(b) { return b.z * (b.lo / 100); }

function applyTier(rows, tier) {
  if (tier === 'ALL') return rows;
  if (tier === 'OTHER') return rows.filter(r => r.league_tier === 'OTHER');
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

const EXPLORATORY = [
  'Bet365_01_25','Bet365_02_25','Bet365_03_25','Bet365_04_25','Bet365_05_25',
  'Bet365_06_25','Bet365_07_25','Bet365_08_25','Bet365_09_25','Bet365_10_25',
  'Bet365_11_25','Bet365_12_25','Bet365_01_26','Bet365_02_26',
];
const LOCKBOX = ['Bet365_03_26','Bet365_04_26','Bet365_05_26','Bet365_06_26','Bet365_07_26'];

function runMonth(full, testLabel) {
  const histDb = full.filter(r => r.file_label !== testLabel);
  const testDb = full.filter(r => r.file_label === testLabel);
  const poolA = histDb.filter(r => r.fold === 'A');
  const poolB = histDb.filter(r => r.fold === 'B');
  const entries = [];
  if (!poolA.length || !poolB.length) return entries;

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
  function crossFitL1(row) {
    const scoredA = scoreLayer1(poolA, 'A', row);
    const scoredB = scoreLayer1(poolB, 'B', row);
    const crossFit = (scoredA.length && scoredB.length) ? mergeCrossFit(scoredA, scoredB, DASH_BETS, qualifiesBet) : [];
    if (crossFit.length) return crossFit.slice().sort((a, b) => rank(b) - rank(a))[0];
    const scored = scoreLayer1(histDb, 'full', row);
    if (!scored.length) return null;
    const qualifying = scored.filter(qualifiesBet).sort((a, b) => rank(b) - rank(a));
    return qualifying[0] || null;
  }

  for (const row of testDb) {
    const bet = crossFitL1(row);
    if (!bet) continue;
    const marketOdds = getMarketOddsOpen(row, bet.k);
    if (marketOdds == null || marketOdds <= 1) continue;
    const hit = row[bet.k] === true;
    entries.push({ key: bet.k, hit, odds: marketOdds, mo: bet.mo, gated: marketOdds >= bet.mo });
  }
  return entries;
}

function summarize(entries) {
  const n = entries.length;
  if (!n) return { n: 0, hitRate: 0, roi: 0, avgOdds: 0, maxOdds: 0, top3Share: 0 };
  const hits = entries.filter(e => e.hit).length;
  const pnlPerBet = entries.map(e => e.hit ? e.odds - 1 : -1);
  const pnl = pnlPerBet.reduce((s, x) => s + x, 0);
  const avgOdds = entries.reduce((s, e) => s + e.odds, 0) / n;
  const maxOdds = Math.max(...entries.map(e => e.odds));
  // How much of total positive P&L comes from the single 3 biggest winning
  // bets — flags whether the ROI is broad-based or a couple of lucky longshots.
  const winPnls = pnlPerBet.filter(x => x > 0).sort((a, b) => b - a);
  const totalWinPnl = winPnls.reduce((s, x) => s + x, 0);
  const top3Share = totalWinPnl > 0 ? winPnls.slice(0, 3).reduce((s, x) => s + x, 0) / totalWinPnl * 100 : 0;
  return { n, hitRate: hits / n * 100, roi: pnl / n * 100, avgOdds, maxOdds, top3Share };
}

function report(label, entries) {
  const always = entries;
  const gated = entries.filter(e => e.gated);
  const sA = summarize(always);
  const sG = summarize(gated);
  console.log(`  ${label.padEnd(12)}  always: n=${sA.n.toString().padEnd(5)} hit%=${sA.hitRate.toFixed(1).padStart(5)}%  ROI=${(sA.roi >= 0 ? '+' : '') + sA.roi.toFixed(1)}%   |   gated: n=${sG.n.toString().padEnd(5)} hit%=${sG.hitRate.toFixed(1).padStart(5)}%  ROI=${(sG.roi >= 0 ? '+' : '') + sG.roi.toFixed(1)}%  avgOdds=${sG.avgOdds.toFixed(2)} maxOdds=${sG.maxOdds.toFixed(2)} top3WinShare=${sG.top3Share.toFixed(0)}%`);
  return { sA, sG };
}

function main() {
  const raw = loadDatasetDir(BET365_DIR);

  for (const tier of TIERS) {
    console.log('\n' + '═'.repeat(110));
    console.log(`TIER = ${tier}  —  homeWinsFT + awayWinsFT ONLY, opening-price settle, exploratory vs. LOCK-BOX`);
    console.log('═'.repeat(110));
    const full = applyTier(raw, tier);

    const expEntries = EXPLORATORY.flatMap(m => runMonth(full, m));
    const lockEntries = LOCKBOX.flatMap(m => runMonth(full, m));

    console.log('EXPLORATORY (14 months: 01_25..02_26) — already partly seen in prior scripts');
    report('pooled', expEntries);
    for (const k of ['homeWinsFT', 'awayWinsFT']) report(k, expEntries.filter(e => e.key === k));

    console.log('\nLOCK-BOX (5 months: 03_26..07_26) — reported once, as-is, no re-tuning');
    report('pooled', lockEntries);
    for (const k of ['homeWinsFT', 'awayWinsFT']) report(k, lockEntries.filter(e => e.key === k));
  }
}

main();
