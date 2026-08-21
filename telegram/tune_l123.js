'use strict';
// Walk-forward validator/tuner for Strategy L123's thresholds — runs ONLY the
// convergence computation (skips the expensive Layer 1-4 sweep printouts in
// layer_analysis.js, which aren't needed to evaluate the agree-N gate) across
// held-out months, so each held-out month is genuinely never touched by the
// training pool it's scored against.
//
// Usage:
//   node tune_l123.js                       — run TEST_LABELS below
//   BET365_DIR=<dir> node tune_l123.js       — point at a different dataset dir
//
// To change which months/configs are tested, edit TEST_LABELS/CONFIGS in
// main() below. Keep in mind: repeatedly comparing configs against the same
// held-out months is itself a mild form of overfitting (researcher degrees
// of freedom) — once a config is chosen, confirm it once against months that
// were never used for comparison before trusting the result.

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const {
  processRow, applyConfig, scoreBets, VALID_LINES,
} = require('./engine');

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');
const TIER = 'TOP+MAJOR';

const ODDS_BANDS = [
  [null, 1.60], [1.60, 1.75], [1.75, 1.90], [1.90, 2.05],
  [2.05, 2.30], [2.30, 2.70], [2.70, null],
];
const TL_BANDS = {
  '<2':    [null, 2.0], '2-2.5': [2.0, 2.5], '2.5-3': [2.5, 3.0], '>3': [3.0, null],
};
function inBand(v, band) {
  if (v == null || !band) return false;
  const [lo, hi] = band;
  return (lo == null || v >= lo) && (hi == null || v < hi);
}
function snapLine(v) {
  if (v == null) return null;
  return VALID_LINES.find(x => Math.abs(v - x) < 0.13) ?? null;
}

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

// Mirrors notify.js's l123Qualifies/l123BestQualifying and
// layer1Live/layer2Live/layer3Live — keep in sync if those change.
function makeRecFns(cfg) {
  // Gates on the Wilson CI lower bound (b.lo), not the raw point estimate
  // (b.edge) — see config.js's L123_MIN_EDGE comment for why.
  function qualifies(b) {
    return b.n >= cfg.MIN_N && b.z >= cfg.MIN_Z && (b.lo - b.bl) >= cfg.MIN_EDGE && b.bl >= cfg.MIN_BL;
  }
  function bestQualifying(bets) {
    const q = bets.filter(qualifies);
    if (!q.length) return null;
    q.sort((a, b) => (b.z * b.lo / 100) - (a.z * a.lo / 100));
    return q[0];
  }
  function layer1Rec(row, histDb) {
    const line = snapLine(row.fav_lo);
    if (line == null) return null;
    const base = histDb.filter(r => snapLine(r.fav_lo) === line && r.fav_side === row.fav_side);
    if (base.length < cfg.MIN_N) return null;
    const oddsBand = ODDS_BANDS.find(b => inBand(row.fav_oo, b));
    const tlBand = Object.values(TL_BANDS).find(b => inBand(row.tl_o, b));
    const cfgRows = base.filter(r => inBand(r.fav_oo, oddsBand) && (tlBand ? inBand(r.tl_o, tlBand) : true));
    if (cfgRows.length < cfg.MIN_N) return null;
    return bestQualifying(scoreBets(cfgRows, base, base, cfg.MIN_N));
  }
  function layer2Rec(row, histDb) {
    const base = histDb.filter(r => r.fav_line === row.fav_line && r.fav_side === row.fav_side);
    if (base.length < cfg.MIN_N) return null;
    const cfgRows = applyConfig(base, {
      fav_line: row.fav_line, fav_side: row.fav_side,
      line_move: row.line_move, fav_odds_move: row.fav_odds_move,
      dog_odds_move: row.dog_odds_move, tl_move: row.tl_move,
    });
    if (cfgRows.length < cfg.MIN_N) return null;
    return bestQualifying(scoreBets(cfgRows, base, base, cfg.MIN_N));
  }
  function layer3Rec(row, histDb) {
    const base = histDb.filter(r => r.fav_line === row.fav_line && r.fav_side === row.fav_side);
    if (base.length < cfg.MIN_N) return null;
    const oddsBand = ODDS_BANDS.find(b => inBand(row.fav_oc, b));
    const tlBand = Object.values(TL_BANDS).find(b => inBand(row.tl_c, b));
    const cfgRows = base.filter(r => inBand(r.fav_oc, oddsBand) && (tlBand ? inBand(r.tl_c, tlBand) : true));
    if (cfgRows.length < cfg.MIN_N) return null;
    return bestQualifying(scoreBets(cfgRows, base, base, cfg.MIN_N));
  }
  return { layer1Rec, layer2Rec, layer3Rec };
}

function settlementFraction(margin) {
  if (margin > 0.49) return 1; if (margin > 0.01) return 0.5;
  if (margin > -0.49) return margin > -0.01 ? 0 : -0.5; return -1;
}
function settleBet(betKey, row) {
  if (betKey === 'ahCover' || betKey === 'dogCover') {
    const ah2h = row.fav_2h - row.dog_2h - row.fav_line;
    return settlementFraction(betKey === 'ahCover' ? ah2h : -ah2h);
  }
  if (betKey === 'overTL' || betKey === 'underTL') {
    if (row.tl_c == null) return null;
    const total = row.fav_ft + row.dog_ft;
    return settlementFraction(betKey === 'overTL' ? total - row.tl_c : row.tl_c - total);
  }
  return row[betKey] === true ? 1 : -1;
}
function hitPoint(f) { return f > 0 ? (f === 1 ? 1 : 0.5) : 0; }
function tallyBucket(entries) {
  const nonPush = entries.filter(e => e.fraction !== 0);
  const hitPts = nonPush.reduce((s, e) => s + hitPoint(e.fraction), 0);
  const hitRate = nonPush.length ? hitPts / nonPush.length * 100 : 0;
  const pnl = nonPush.reduce((s, e) => s + (e.fraction === 1 ? e.odds - 1 : e.fraction === 0.5 ? (e.odds - 1) / 2 : e.fraction === -0.5 ? -0.5 : -1), 0);
  const roi = nonPush.length ? pnl / nonPush.length * 100 : 0;
  return { n: entries.length, nonPush: nonPush.length, hitRate, pnl, roi };
}

// Runs L123's actual gate (>= MIN_AGREE of 3 layers agree) for one held-out
// month, pricing at mo_lo (Wilson lower-bound odds) — matching production.
function runL123ForMonth(testDb, histDb, cfg) {
  const { layer1Rec, layer2Rec, layer3Rec } = makeRecFns(cfg);
  const agreeN = [];
  const agree3 = [];

  for (const row of testDb) {
    const r1 = layer1Rec(row, histDb);
    const r2 = layer2Rec(row, histDb);
    const r3 = layer3Rec(row, histDb);
    const recs = [r1, r2, r3].filter(Boolean);
    const keys = recs.map(r => r.k);
    if (!keys.length) continue;

    const counts = {};
    keys.forEach(k => counts[k] = (counts[k] || 0) + 1);
    const [topKey, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (topCount >= cfg.MIN_AGREE) {
      const rec = recs.find(r => r.k === topKey);
      const fraction = settleBet(topKey, row);
      if (fraction != null && rec.mo_lo != null) {
        agreeN.push({ fraction, odds: rec.mo_lo });
        if (topCount === 3) agree3.push({ fraction, odds: rec.mo_lo });
      }
    }
  }
  return { fire: tallyBucket(agreeN), fire3: tallyBucket(agree3) };
}

function runWalkForward(full, testLabels, cfg, label) {
  console.log('═'.repeat(100));
  console.log(`CONFIG: ${label}`);
  console.log('═'.repeat(100));
  const perMonth = [];
  for (const testLabel of testLabels) {
    const histDb = full.filter(r => !r.file_label.includes(testLabel));
    const testDb = full.filter(r => r.file_label.includes(testLabel));
    const t0 = Date.now();
    const { fire, fire3 } = runL123ForMonth(testDb, histDb, cfg);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    perMonth.push(fire);
    console.log(`  ${testLabel.padEnd(8)} n=${String(fire.n).padStart(4)} nonPush=${String(fire.nonPush).padStart(4)} hit%=${fire.hitRate.toFixed(1).padStart(5)}% ROI@fair=${(fire.roi >= 0 ? '+' : '') + fire.roi.toFixed(1)}%   (3/3 subset: n=${fire3.n} hit%=${fire3.hitRate.toFixed(1)}% ROI=${fire3.roi.toFixed(1)}%)   [${secs}s]`);
  }
  const totalN = perMonth.reduce((s, f) => s + f.nonPush, 0);
  const totalPnl = perMonth.reduce((s, f) => s + f.pnl, 0);
  const posMonths = perMonth.filter(f => f.roi > 0).length;
  const aggRoi = totalN ? totalPnl / totalN * 100 : 0;
  console.log(`  ── pooled: n=${totalN}  ROI@fair=${(aggRoi >= 0 ? '+' : '') + aggRoi.toFixed(1)}%  positive months: ${posMonths}/${perMonth.length}\n`);
}

function main() {
  const raw = loadDatasetDir(BET365_DIR);
  const full = applyTier(raw);
  console.log(`Loaded ${raw.length} rows, tier=${TIER}: ${full.length} rows\n`);

  const files = fs.readdirSync(BET365_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  const allLabels = files.map(f => path.basename(f, '.csv').replace('Bet365', ''));

  // Default: the two lock-box months used to confirm the Wilson-lower-bound
  // fix (2026-08-21) — never touched by any prior config comparison. Edit
  // these to validate future changes; once a config is chosen, confirm it
  // against months not already used for comparison.
  const TEST_LABELS = ['_04_25', '_09_25'].filter(l => allLabels.includes(l));
  console.log(`Walk-forward test months: ${TEST_LABELS.join(', ')}\n`);

  // The current production default (config.js: MIN_N=30, MIN_Z=1.8,
  // MIN_EDGE=0 CI-based, MIN_BL=20, MIN_AGREE=2 — fires on 2/3 or 3/3).
  runWalkForward(full, TEST_LABELS, { MIN_N: 30, MIN_Z: 1.8, MIN_EDGE: 0, MIN_BL: 20, MIN_AGREE: 2 }, 'production default (CI-edge >=0)');
}

main();
