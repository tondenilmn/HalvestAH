'use strict';
// Focused check: for matches whose CLOSING Total Line is exactly 2.5, ov_c/
// un_c are the real bookmaker's Over/Under 2.5 FT price directly (no
// equivalence trick needed — see getMarketOdds's comment). This isolates
// L2 (movement)'s over25FT/under25FT picks at TL=2.5 specifically and
// checks how many of them could actually be bet at a real bookmaker price
// strictly BETTER than our own advised minimum odds.
//
// Usage: node backtest_tl25_over_under.js [comma-separated test labels] [tier]
//   defaults to all 19 available months, TOP+MAJOR

const fs = require('fs');
const path = require('path');
const {
  loadDatasetDir, applyConfig, applyBaselineConfig, mergeCrossFit,
  pct, zScore, wilsonCI, minOdds, BETS,
} = require('./engine');

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');
const TIER = (process.argv[3] || 'TOP+MAJOR').toUpperCase();

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
  const TEST_LABELS = process.argv[2] ? process.argv[2].split(',') : allLabels;

  const raw = loadDatasetDir(BET365_DIR);
  const full = applyTier(raw);
  console.log(`Loaded ${raw.length} rows total, tier=${TIER}: ${full.length} rows`);
  console.log(`Test months (walk-forward): ${TEST_LABELS.length} months\n`);

  const picks = []; // { key: 'over25FT'|'under25FT', hit, marketOdds, mo, mo_lo, p, month }

  for (const label of TEST_LABELS) {
    const histDb = full.filter(r => r.file_label !== label);
    const testDb = full.filter(r => r.file_label === label && r.tl_c != null && Math.abs(r.tl_c - 2.5) < TL_EXACT_TOL);
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
      if (bet.k !== 'over25FT' && bet.k !== 'under25FT') continue; // only Over/Under 2.5 picks
      const marketOdds = bet.k === 'over25FT' ? row.ov_c : row.un_c;
      if (marketOdds == null || marketOdds <= 1) continue;
      const hit = row[bet.k] === true;
      picks.push({ key: bet.k, hit, marketOdds, mo: parseFloat(bet.mo), mo_lo: parseFloat(bet.mo_lo), p: bet.p, month: label });
    }
  }

  console.log(`Matches with closing TL = 2.5 where L2 (movement) picked Over2.5 or Under2.5: ${picks.length}\n`);

  function report(label, list) {
    const n = list.length;
    if (!n) { console.log(`${label}: n=0\n`); return; }
    const beatFair = list.filter(e => e.marketOdds > e.mo);       // strictly better than fair (mo)
    const beatConservative = list.filter(e => e.marketOdds > e.mo_lo); // strictly better than conservative (mo_lo)
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

  report('OVERALL (Over2.5 + Under2.5 combined)', picks);
  report('Over 2.5 FT only', picks.filter(e => e.key === 'over25FT'));
  report('Under 2.5 FT only', picks.filter(e => e.key === 'under25FT'));

  console.log('═'.repeat(100));
  console.log('SAMPLE — first 15 individual matches (bookmaker odds vs advised)');
  console.log('═'.repeat(100));
  for (const e of picks.slice(0, 15)) {
    const beats = e.marketOdds > e.mo ? 'YES' : 'no';
    console.log(`  ${e.month}  ${e.key}  hit=${e.hit}  bookmaker=${e.marketOdds.toFixed(2)}  advised(mo)=${e.mo.toFixed(2)}  beats advised=${beats}`);
  }
}

main();
