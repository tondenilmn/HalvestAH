'use strict';
// Generalized version of backtest_tl25_over_under.js — parameterized by
// which Total Line to check (1.5, 2.5, etc.) instead of hardcoding 2.5.
// For matches whose CLOSING Total Line is exactly the target line, ov_c/
// un_c are the real bookmaker's Over/Under price for that exact line
// directly (no equivalence trick needed). Isolates L2 (movement)'s
// over{X}FT/under{X}FT picks at that TL and checks how many could actually
// be bet at a real bookmaker price better than our own advised odds.
//
// Only 1.5 and 2.5 are meaningful here — over35FT exists in the full BETS
// set but isn't one of the 13 _DASHBOARD_BET_KEYS the Dashboard/L2
// mechanism ever considers (so the real app never surfaces it this way),
// and there's no under35FT bet type defined in this app at all.
//
// Usage: node backtest_tl_over_under.js <tlLine> [comma-separated test labels] [tier]
//   e.g. node backtest_tl_over_under.js 1.5
//        node backtest_tl_over_under.js 1.5 Bet365_05_26,Bet365_11_25 TOP+MAJOR

const fs = require('fs');
const path = require('path');
const {
  loadDatasetDir, applyConfig, applyBaselineConfig, mergeCrossFit,
  pct, zScore, wilsonCI, minOdds, BETS,
} = require('./engine');

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');
const TL_LINE = parseFloat(process.argv[2] || '2.5');
const TIER = (process.argv[4] || 'TOP+MAJOR').toUpperCase();

const MIN_N = 15;
const MIN_Z = 1.5;
const MIN_EDGE = 0;
const TL_EXACT_TOL = 0.01;

const DASHBOARD_BET_KEYS = new Set([
  'homeWinsFT', 'drawFT', 'awayWinsFT',
  'over15FT', 'over25FT', 'under15FT', 'under25FT',
  'btts', 'noBtts',
  'homeOver05FT', 'homeOver15FT', 'awayOver05FT', 'awayOver15FT',
]);
const DASH_BETS = BETS.filter(b => DASHBOARD_BET_KEYS.has(b.k));

// Map a TL value to its exact over/under bet keys — only 1.5/2.5 exist as a
// matched pair in this app's bet set.
const LINE_KEYS = {
  '1.5': { over: 'over15FT', under: 'under15FT' },
  '2.5': { over: 'over25FT', under: 'under25FT' },
};
const lineKey = String(TL_LINE);
const keys = LINE_KEYS[lineKey];
if (!keys) {
  console.error(`No matched Over/Under bet-key pair defined for TL=${TL_LINE} in this app (only 1.5 and 2.5 exist as pairs; over35FT exists but has no under35FT counterpart and isn't in the Dashboard's bet-key set).`);
  process.exit(1);
}

function qualifiesBet(b) { return !!b && b.z >= MIN_Z && (b.lo - b.bl) >= MIN_EDGE; }
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

function main() {
  const files = fs.readdirSync(BET365_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  const allLabels = files.map(f => path.basename(f, '.csv')).sort();
  const TEST_LABELS = process.argv[3] ? process.argv[3].split(',') : allLabels;

  const raw = loadDatasetDir(BET365_DIR);
  const full = applyTier(raw);
  console.log(`Loaded ${raw.length} rows total, tier=${TIER}: ${full.length} rows`);
  console.log(`TL line=${TL_LINE}  (${keys.over} / ${keys.under})`);
  console.log(`Test months (walk-forward): ${TEST_LABELS.length} months\n`);

  const picks = [];

  for (const label of TEST_LABELS) {
    const histDb = full.filter(r => r.file_label !== label);
    const testDb = full.filter(r => r.file_label === label && r.tl_c != null && Math.abs(r.tl_c - TL_LINE) < TL_EXACT_TOL);
    const poolA = histDb.filter(r => r.fold === 'A');
    const poolB = histDb.filter(r => r.fold === 'B');

    const baseCache = new Map();
    const scoreCache = new Map();
    function getBase(pool, tag, favLine, favSide) {
      const key = `${tag}|${favLine}|${favSide}`;
      let base = baseCache.get(key);
      if (base === undefined) {
        base = applyBaselineConfig(pool, { fav_line: favLine, fav_side: favSide });
        baseCache.set(key, base);
      }
      return base;
    }
    function scoreLayer2(pool, tag, row) {
      const lineStable = row.line_move === 'STABLE';
      const tlStable = row.tl_move === 'STABLE';
      const favOddsMove = lineStable ? row.fav_odds_move : 'ANY';
      const dogOddsMove = lineStable ? row.dog_odds_move : 'ANY';
      const overMove = tlStable ? row.over_move : 'ANY';
      const underMove = tlStable ? row.under_move : 'ANY';
      const key = `${tag}|${row.fav_line}|${row.fav_side}|${row.line_move}|${row.tl_move}|${favOddsMove}|${dogOddsMove}|${overMove}|${underMove}`;
      let scored = scoreCache.get(key);
      if (scored !== undefined) return scored;
      const base = getBase(pool, tag, row.fav_line, row.fav_side);
      const moveCfg = {
        fav_line: row.fav_line, fav_side: row.fav_side,
        line_move: row.line_move, tl_move: row.tl_move,
        fav_odds_move: favOddsMove, dog_odds_move: dogOddsMove,
        over_move: overMove, under_move: underMove,
      };
      const cfgRows = applyConfig(pool, moveCfg);
      scored = scoreDashboard(cfgRows, base);
      scoreCache.set(key, scored);
      return scored;
    }
    function crossFitL2(row) {
      const scoredA = scoreLayer2(poolA, 'A', row);
      const scoredB = scoreLayer2(poolB, 'B', row);
      const crossFit = (scoredA.length && scoredB.length) ? mergeCrossFit(scoredA, scoredB, DASH_BETS, qualifiesBet) : [];
      if (crossFit.length) return crossFit.slice().sort((a, b) => rank(b) - rank(a))[0];
      const scored = scoreLayer2(histDb, 'full', row);
      if (!scored.length) return null;
      const qualifying = scored.filter(qualifiesBet).sort((a, b) => rank(b) - rank(a));
      return qualifying[0] || null;
    }

    for (const row of testDb) {
      const bet = crossFitL2(row);
      if (!bet) continue;
      if (bet.k !== keys.over && bet.k !== keys.under) continue;
      const marketOdds = bet.k === keys.over ? row.ov_c : row.un_c;
      if (marketOdds == null || marketOdds <= 1) continue;
      const hit = row[bet.k] === true;
      picks.push({ key: bet.k, hit, marketOdds, mo: parseFloat(bet.mo), mo_lo: parseFloat(bet.mo_lo), p: bet.p, month: label });
    }
  }

  console.log(`Matches with closing TL = ${TL_LINE} where L2 (movement) picked ${keys.over.replace('FT', '')} or ${keys.under.replace('FT', '')}: ${picks.length}\n`);

  function report(label, list) {
    const n = list.length;
    if (!n) { console.log(`${label}: n=0\n`); return; }
    const beatFair = list.filter(e => e.marketOdds > e.mo);
    const beatConservative = list.filter(e => e.marketOdds > e.mo_lo);
    const hits = list.filter(e => e.hit).length;
    const avgMarketOdds = list.reduce((s, e) => s + e.marketOdds, 0) / n;
    const avgMo = list.reduce((s, e) => s + e.mo, 0) / n;
    const avgMoLo = list.reduce((s, e) => s + e.mo_lo, 0) / n;
    const pnlBeatFair = beatFair.reduce((s, e) => s + (e.hit ? e.marketOdds - 1 : -1), 0);
    const roiBeatFair = beatFair.length ? pnlBeatFair / beatFair.length * 100 : 0;
    const hitsCons = beatConservative.filter(e => e.hit).length;
    const pnlBeatCons = beatConservative.reduce((s, e) => s + (e.hit ? e.marketOdds - 1 : -1), 0);
    const roiBeatCons = beatConservative.length ? pnlBeatCons / beatConservative.length * 100 : 0;
    console.log(`${label}:`);
    console.log(`  n=${n}  realized hit%=${(hits / n * 100).toFixed(1)}%`);
    console.log(`  avg real bookmaker odds=${avgMarketOdds.toFixed(2)}   avg advised fair odds (mo)=${avgMo.toFixed(2)}   avg advised conservative odds (mo_lo)=${avgMoLo.toFixed(2)}`);
    console.log(`  bookmaker odds > advised FAIR (mo):          ${beatFair.length}/${n} (${(beatFair.length / n * 100).toFixed(1)}%)  ROI on those=${(roiBeatFair >= 0 ? '+' : '') + roiBeatFair.toFixed(1)}%`);
    console.log(`  bookmaker odds > advised CONSERVATIVE (mo_lo): ${beatConservative.length}/${n} (${(beatConservative.length / n * 100).toFixed(1)}%)  hit%=${beatConservative.length ? (hitsCons / beatConservative.length * 100).toFixed(1) : '0.0'}%  ROI on those=${(roiBeatCons >= 0 ? '+' : '') + roiBeatCons.toFixed(1)}%\n`);
  }

  report('OVERALL', picks);
  report(`${keys.over} only`, picks.filter(e => e.key === keys.over));
  report(`${keys.under} only`, picks.filter(e => e.key === keys.under));
}

main();
