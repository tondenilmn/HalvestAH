'use strict';
// Split-sample test for the Live Games HT selection procedure: does
// decoupling "which bet wins the argmax" from "what's its priced
// probability" actually fix the winner's-curse bias (unlike the shrinkage
// experiment in backtest_live_ui_shrink_sweep.js, which turned out to only
// re-price the SAME picks, not change selection)?
//
// Method: split the walk-forward historical pool (test month excluded) into
// two non-overlapping halves, A and B, by month. For each test match, run
// FOUR arms using the identical A/B partition so sample size is matched:
//
//   controlA — select the argmax AND price it, both from pool A alone
//   controlB — select the argmax AND price it, both from pool B alone
//     (these two are the "naive" baseline at HALF the usual data — the
//     apples-to-apples control for the split-sample arms below, since a
//     fair test of "does decoupling help" must hold sample size constant)
//
//   splitAB  — select the argmax from pool A, price THAT SAME bet using
//              pool B (a sample that had no say in the selection)
//   splitBA  — mirror: select from B, price from A
//     (splitAB + splitBA together = a 2-fold cross-fit using the full A+B
//     data exactly once each for selection and once each for pricing —
//     matched total data volume to control-A + control-B pooled)
//
// If split-sample selection actually removes winner's-curse inflation,
// ROI@price should be visibly better for split (AB+BA pooled) than for
// control (A+B pooled), at the same total sample size.
//
// Usage: node backtest_live_ui_split_sample.js [testFileLabel] [tier]
//   tier: TOP+MAJOR (default) | OTHER | ALL
//   e.g. node backtest_live_ui_split_sample.js Bet365_04_26 OTHER

const fs = require('fs');
const path = require('path');
const {
  loadDatasetDir, applyConfig, applyBaselineConfig, applyGameState, scoreBets,
} = require('./engine');

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');
const TEST_LABEL = process.argv[2] || 'Bet365_04_26';
const TIER = (process.argv[3] || 'TOP+MAJOR').toUpperCase();

const MIN_N = 15;   // DEFAULT_MIN_N in app.js
const MIN_Z = 1.5;
const MIN_EDGE = 0;

const _LIVE_SCAN_2H_KEYS = new Set([
  'over05_2H', 'over15_2H', 'under05_2H', 'under15_2H',
  'homeScored2H', 'awayScored2H',
  'homeWins2H', 'awayWins2H', 'draw2H',
  'btts2H',
]);

function qualifiesBet(b) {
  return !!b && b.z >= MIN_Z && (b.lo - b.bl) >= MIN_EDGE;
}
function baseScore(b) { return b ? b.z * (b.lo / 100) : -Infinity; }

function applyTier(rows) {
  if (TIER === 'ALL') return rows;
  if (TIER === 'OTHER') return rows.filter(r => r.league_tier === 'OTHER');
  return rows.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
}

function buildCfgFromRow(row) {
  const lineStable = row.line_move === 'STABLE';
  const tlStable = row.tl_move === 'STABLE';
  return {
    fav_line: row.fav_line,
    fav_side: row.fav_side,
    line_move: row.line_move,
    fav_odds_move: lineStable ? row.fav_odds_move : 'ANY',
    dog_odds_move: lineStable ? row.dog_odds_move : 'ANY',
    over_move: tlStable ? row.over_move : 'ANY',
    under_move: tlStable ? row.under_move : 'ANY',
    tl_c: row.tl_c != null ? row.tl_c : null,
  };
}

function filterLiveScanBets(bets) {
  return bets ? bets.filter(b => _LIVE_SCAN_2H_KEYS.has(b.k)) : bets;
}

function tally(entries, priceKey) {
  const n = entries.length;
  const hits = entries.filter(e => e.hit).length;
  const hitRate = n ? hits / n * 100 : 0;
  const pnl = entries.reduce((s, e) => s + (e.hit ? e[priceKey] - 1 : -1), 0);
  const roi = n ? pnl / n * 100 : 0;
  return { n, hits, hitRate, pnl, roi };
}

// Computes both the pre-match and HT-conditioned bet maps for one pool,
// given a match's cfg and (always known, since this is historical) the
// real HT game-state filter.
function computePoolMaps(pool, cfg, gs) {
  const cfgRows = applyConfig(pool, cfg);
  const baselineRows = applyBaselineConfig(pool, cfg);
  const blSide = baselineRows.filter(r => r.fav_side === cfg.fav_side);

  let preMap = new Map();
  if (cfgRows.length >= MIN_N && baselineRows.length) {
    preMap = new Map(filterLiveScanBets(scoreBets(cfgRows, baselineRows, blSide, MIN_N)).map(b => [b.k, b]));
  }

  let gsMap = new Map();
  const gsRows = applyGameState(cfgRows, gs);
  const gsBlRows = applyGameState(baselineRows, gs);
  const gsBlSide = applyGameState(blSide, gs);
  if (gsRows.length >= MIN_N) {
    gsMap = new Map(filterLiveScanBets(scoreBets(gsRows, gsBlRows, gsBlSide, MIN_N)).map(b => [b.k, b]));
  }

  return { preMap, gsMap };
}

// buildQualifyingList's merge, generalized to report which SOURCE (pre/gs)
// won for each key, not just the bet object — needed so pricing can later
// query the exact same (key, source) definition from a different pool.
function selectFrom(maps) {
  const qualifying = [];
  for (const k of _LIVE_SCAN_2H_KEYS) {
    const pre = maps.preMap.get(k) || null;
    const gsB = maps.gsMap.get(k) || null;
    const prePass = qualifiesBet(pre);
    const gsPass = qualifiesBet(gsB);
    if (!prePass && !gsPass) continue;
    const useGs = baseScore(gsPass ? gsB : null) > baseScore(prePass ? pre : null);
    qualifying.push({ key: k, source: useGs ? 'gs' : 'pre', bet: useGs ? gsB : pre });
  }
  qualifying.sort((a, b) => baseScore(b.bet) - baseScore(a.bet));
  return qualifying;
}

function priceFrom(maps, key, source) {
  const map = source === 'pre' ? maps.preMap : maps.gsMap;
  return map.get(key) || null;
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

  const histLabels = [...new Set(histDb.map(r => r.file_label))].sort();
  const labelsA = histLabels.filter((_, i) => i % 2 === 0);
  const labelsB = histLabels.filter((_, i) => i % 2 === 1);
  const poolA = histDb.filter(r => labelsA.includes(r.file_label));
  const poolB = histDb.filter(r => labelsB.includes(r.file_label));
  console.log(`Historical pool split by month (deterministic alternation):`);
  console.log(`  Pool A: ${labelsA.length} months, ${poolA.length} rows — ${labelsA.join(', ')}`);
  console.log(`  Pool B: ${labelsB.length} months, ${poolB.length} rows — ${labelsB.join(', ')}`);
  console.log(`Test matches (TOP+MAJOR, ${TEST_LABEL}): ${testDb.length} rows\n`);

  const controlEntries = [];   // controlA + controlB pooled — naive same-pool select+price, half data
  const splitEntries = [];     // splitAB + splitBA pooled — select on one half, price on the other
  let noSelA = 0, noSelB = 0, noPriceAB = 0, noPriceBA = 0;

  for (const row of testDb) {
    const cfg = buildCfgFromRow(row);
    const gs = {
      trigger: 'HT',
      home_goals: String(row.fav_side === 'HOME' ? row.fav_ht : row.dog_ht),
      away_goals: String(row.fav_side === 'HOME' ? row.dog_ht : row.fav_ht),
    };

    const mapsA = computePoolMaps(poolA, cfg, gs);
    const mapsB = computePoolMaps(poolB, cfg, gs);

    const selA = selectFrom(mapsA);
    const selB = selectFrom(mapsB);

    // control arms — select and price from the SAME half
    if (selA.length) {
      const top = selA[0];
      if (top.bet.mo != null) controlEntries.push({ key: top.key, hit: row[top.key] === true, mo: top.bet.mo });
    } else noSelA++;
    if (selB.length) {
      const top = selB[0];
      if (top.bet.mo != null) controlEntries.push({ key: top.key, hit: row[top.key] === true, mo: top.bet.mo });
    } else noSelB++;

    // split arms — select from one half, price from the OTHER
    if (selA.length) {
      const top = selA[0];
      const priced = priceFrom(mapsB, top.key, top.source);
      if (priced && priced.mo != null) splitEntries.push({ key: top.key, hit: row[top.key] === true, mo: priced.mo });
      else noPriceAB++;
    }
    if (selB.length) {
      const top = selB[0];
      const priced = priceFrom(mapsA, top.key, top.source);
      if (priced && priced.mo != null) splitEntries.push({ key: top.key, hit: row[top.key] === true, mo: priced.mo });
      else noPriceBA++;
    }
  }

  console.log(`Matches with no qualifying pick from A: ${noSelA}   from B: ${noSelB}`);
  console.log(`Split picks dropped — B too thin to price A's pick: ${noPriceAB}   A too thin to price B's pick: ${noPriceBA}\n`);

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

  const byKeyCtl = {}, byKeySpl = {};
  for (const e of controlEntries) (byKeyCtl[e.key] = byKeyCtl[e.key] || []).push(e);
  for (const e of splitEntries) (byKeySpl[e.key] = byKeySpl[e.key] || []).push(e);
  console.log(`\n  Pick distribution — control: ${Object.entries(byKeyCtl).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => `${k}=${v.length}`).join(', ')}`);
  console.log(`  Pick distribution — split:   ${Object.entries(byKeySpl).sort((a, b) => b[1].length - a[1].length).map(([k, v]) => `${k}=${v.length}`).join(', ')}`);
}

main();
