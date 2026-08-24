'use strict';
// One-off walk-forward check: on the subset of LATEGOAL "still no 2H goal"
// instances where the fav/home/away-scored bet (favScored2H/homeScored2H/
// awayScored2H) is the one that actually qualifies and would be alerted,
// would betting the generic "any goal in 2H" market (over05_2H) instead have
// been at least as profitable? Mirrors tune_l123.js's leave-one-month-out
// methodology and notify.js's runStrategyLateGoal selection logic exactly
// (same base pool, same TL-band bucketing, same HT-state filter, same
// qualifying gate) so the comparison is apples-to-apples with production.
//
// Usage: node backtest_lategoal_favvsany.js

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const { processRow, applyGameState, scoreBets, VALID_LINES } = require('./engine');

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');
const TIER = 'TOP+MAJOR';

const TL_BANDS = {
  '<2':    [null, 2.0], '2-2.5': [2.0, 2.5], '2.5-3': [2.5, 3.0], '>3': [3.0, null],
};
function inBand(v, band) {
  if (v == null || !band) return false;
  const [lo, hi] = band;
  return (lo == null || v >= lo) && (hi == null || v < hi);
}

// Same gate as notify.js's lateGoalQualifies / config.js defaults.
const CFG = { MIN_N: 30, MIN_Z: 1.8, MIN_EDGE: 0, MIN_BL: 20 };
const FAV_SIDE_KEYS = new Set(['favScored2H', 'homeScored2H', 'awayScored2H']);
const LATEGOAL_BETS = ['over05_2H', 'favScored2H', 'homeScored2H', 'awayScored2H'];

function loadDatasetDir(dir) {
  const files = fs.readdirSync(dir).filter(f => f.toLowerCase().endsWith('.csv'));
  const db = [];
  for (const f of files) {
    const csv = fs.readFileSync(path.join(dir, f), 'utf8');
    const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true });
    const label = path.basename(f, '.csv');
    for (const row of data) {
      const processed = processRow(row, label);
      if (processed) db.push(processed);
    }
  }
  return db;
}
function applyTier(rows) {
  if (TIER === 'ALL') return rows;
  return rows.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
}

function qualifies(b) {
  return b.n >= CFG.MIN_N && b.z >= CFG.MIN_Z && (b.lo - b.bl) >= CFG.MIN_EDGE && b.bl >= CFG.MIN_BL;
}

// Reproduces runStrategyLateGoal's bet selection for one historical row,
// using only rows from histDb (never testDb) as the training pool.
function lateGoalRec(row, histDb) {
  const lineBase = histDb.filter(r => r.fav_line === row.fav_line && r.fav_side === row.fav_side);
  if (lineBase.length < CFG.MIN_N) return null;

  const tlBand = Object.values(TL_BANDS).find(b => inBand(row.tl_c, b));
  const tlBase = tlBand ? lineBase.filter(r => inBand(r.tl_c, tlBand)) : [];
  const base = tlBase.length >= CFG.MIN_N ? tlBase : lineBase;

  const homeHt = row.fav_side === 'HOME' ? row.fav_ht : row.dog_ht;
  const awayHt = row.fav_side === 'HOME' ? row.dog_ht : row.fav_ht;
  const gs = { trigger: 'HT', home_goals: String(homeHt), away_goals: String(awayHt) };
  const gsRows = applyGameState(base, gs);
  if (gsRows.length < CFG.MIN_N) return null;

  const allBets = scoreBets(gsRows, base, base, CFG.MIN_N);
  if (!allBets.length) return null;

  const candidates = allBets.filter(b => LATEGOAL_BETS.includes(b.k) && qualifies(b));
  if (!candidates.length) return null;
  candidates.sort((a, b) => (b.z * b.lo / 100) - (a.z * a.lo / 100));
  const winner = candidates[0];
  const over05 = allBets.find(b => b.k === 'over05_2H');
  return { winner, over05 };
}

function settle(betKey, row) {
  return row[betKey] === true ? 1 : -1;
}

function tally(entries, priceKey = 'odds') {
  const n = entries.length;
  const hits = entries.filter(e => e.fraction === 1).length;
  const hitRate = n ? hits / n * 100 : 0;
  const pnl = entries.reduce((s, e) => s + (e.fraction === 1 ? e[priceKey] - 1 : -1), 0);
  const roi = n ? pnl / n * 100 : 0;
  return { n, hits, hitRate, pnl, roi };
}

function main() {
  const raw = loadDatasetDir(BET365_DIR);
  const full = applyTier(raw);
  console.log(`Loaded ${raw.length} rows, tier=${TIER}: ${full.length} rows\n`);

  const files = fs.readdirSync(BET365_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  const allLabels = files.map(f => path.basename(f, '.csv'));
  console.log(`Leave-one-month-out walk-forward across ${allLabels.length} months: ${allLabels.join(', ')}\n`);

  const favFamily = [];   // instances where a fav/home/away-scored bet won -> settled on THAT bet
  const overOnSameSubset = []; // same instances, settled instead on over05_2H

  for (const testLabel of allLabels) {
    const histDb = full.filter(r => r.file_label !== testLabel);
    const testDb = full.filter(r => r.file_label === testLabel);

    for (const row of testDb) {
      const rec = lateGoalRec(row, histDb);
      if (!rec) continue;
      const { winner, over05 } = rec;
      if (!FAV_SIDE_KEYS.has(winner.k)) continue; // only care about fav/home/away-scored alerts
      if (winner.mo == null) continue;

      favFamily.push({
        fraction: settle(winner.k, row), odds: winner.mo, oddsLo: winner.mo_lo, key: winner.k,
      });

      if (over05 && over05.mo != null) {
        overOnSameSubset.push({
          fraction: settle('over05_2H', row), odds: over05.mo, oddsLo: over05.mo_lo,
        });
      }
    }
  }

  const favFair = tally(favFamily, 'odds');
  const overFair = tally(overOnSameSubset, 'odds');
  const favLo = tally(favFamily, 'oddsLo');
  const overLo = tally(overOnSameSubset, 'oddsLo');

  console.log('═'.repeat(90));
  console.log('Subset: LATEGOAL instances where favScored2H/homeScored2H/awayScored2H WON the selection');
  console.log('═'.repeat(90));
  console.log(`  As alerted (fav/home/away-scored):`);
  console.log(`    n=${favFair.n}  hit%=${favFair.hitRate.toFixed(1)}%  ROI@fair=${(favFair.roi >= 0 ? '+' : '') + favFair.roi.toFixed(1)}%  ROI@mo_lo(production target)=${(favLo.roi >= 0 ? '+' : '') + favLo.roi.toFixed(1)}%`);
  console.log(`  Same matches, betting generic "any goal" (over05_2H) instead:`);
  console.log(`    n=${overFair.n}  hit%=${overFair.hitRate.toFixed(1)}%  ROI@fair=${(overFair.roi >= 0 ? '+' : '') + overFair.roi.toFixed(1)}%  ROI@mo_lo(production target)=${(overLo.roi >= 0 ? '+' : '') + overLo.roi.toFixed(1)}%`);

  const byKey = {};
  for (const e of favFamily) {
    byKey[e.key] = byKey[e.key] || [];
    byKey[e.key].push(e);
  }
  console.log(`\n  Breakdown by winning bet key:`);
  for (const [k, entries] of Object.entries(byKey)) {
    const tf = tally(entries, 'odds');
    const tl = tally(entries, 'oddsLo');
    console.log(`    ${k.padEnd(14)} n=${String(tf.n).padStart(4)}  hit%=${tf.hitRate.toFixed(1).padStart(5)}%  ROI@fair=${(tf.roi >= 0 ? '+' : '') + tf.roi.toFixed(1)}%  ROI@mo_lo=${(tl.roi >= 0 ? '+' : '') + tl.roi.toFixed(1)}%`);
  }
}

main();
