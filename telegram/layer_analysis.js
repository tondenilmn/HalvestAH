'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// LAYER ANALYSIS — systematic profitability sweep across 4 independent
// information layers, plus a convergence/divergence study across them.
//
// The four layers, in order of how much information they use:
//   Layer 1 — OPENING ODDS ONLY   (fav_lo, fav_oo/dog_oo, tl_o)
//   Layer 2 — MOVEMENT ONLY       (line_move, fav_odds_move, dog_odds_move, tl_move)
//   Layer 3 — CLOSING ODDS ONLY   (fav_line/fav_lc, fav_oc/dog_oc, tl_c)
//   Layer 4 — FULL CONFIG         (movement signals, which by construction encode
//                                   opening+closing together, PLUS an HT trigger)
//             Deliberately independent of the Bayesian LR posterior used by
//             backtest.js's Gate 2 — plain z/edge/Wilson stats only.
//
// Layers 1 and 3 (odds bins) are each swept two ways:
//   --band     fixed odds/TL bands (default; comparable to applyConfig's
//              odds_tolerance/tl_c filters, just swept across the whole range)
//   --quantile empirical quantile bins (default 5 = quintiles; --qbins to change)
// Both variants always run; the report prints both so you can compare a
// hand-chosen banding against a data-driven one.
//
// Convergence section: for a held-out test month, computes what Layers 1/2/3
// would each have recommended for every match (independently, using only the
// information that layer is allowed to see), tallies how often they agree,
// and reports realized hit-rate/ROI by agreement level — vs. Layer 4 alone.
//
// Usage:
//   node layer_analysis.js                  — Bet365 dataset, TOP+MAJOR, quintile bins
//   node layer_analysis.js --source pinnacle — use the Pinnacle dataset (static/data/) instead
//   node layer_analysis.js --all             — all leagues
//   node layer_analysis.js --top 20          — top N rows per layer report (default 15)
//   node layer_analysis.js --qbins 10        — deciles instead of quintiles
//   node layer_analysis.js --min-n 30 --min-z 1.8 --min-edge 5 --min-baseline 20
//   node layer_analysis.js --test _02_26     — held-out month for convergence (default: latest)
// ══════════════════════════════════════════════════════════════════════════════

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const {
  loadDatabase,
  processRow,
  applyConfig,
  applyGameState,
  scoreBets,
  VALID_LINES,
  BETS,
  GS_PROBE_OUTCOMES,
  pct,
  zScore,
  wilsonCI,
} = require('./engine');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const hasFlag = f => args.includes(f);

const TIER       = hasFlag('--all') ? 'ALL' : 'TOP+MAJOR';
const TOP_N      = parseInt(getArg('--top', '15'), 10);
const QBINS      = parseInt(getArg('--qbins', '5'), 10);
const MIN_N      = parseInt(getArg('--min-n', '30'), 10);
const MIN_Z      = parseFloat(getArg('--min-z', '1.8'));
const MIN_EDGE   = parseFloat(getArg('--min-edge', '5'));
const MIN_BL     = parseFloat(getArg('--min-baseline', '20'));
const TEST_LABEL = getArg('--test', '_02_26');
const SOURCE     = getArg('--source', 'bet365'); // 'bet365' | 'pinnacle'

// Bet365 export dataset — plain directory of CSVs, no manifest.json (that file
// is only generated for the Cloudflare Pages static/data/ bundle).
const BET365_DIR = 'D:\\BET\\Match_Dataset\\Bet365_Data_months';
const DATA_DIR = path.resolve(__dirname, '../static/data');

// Loads every *.csv directly from a directory — no manifest.json required.
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

// ── Shared bins ───────────────────────────────────────────────────────────────
// Not exported by engine.js — kept in sync manually (see CLAUDE.md sync note).
const LINE_THRESH = 0.12;

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
function bandLabel(band) {
  const [lo, hi] = band;
  if (lo == null) return `<${hi}`;
  if (hi == null) return `≥${lo}`;
  return `${lo}-${hi}`;
}
function snapLine(v) {
  if (v == null) return null;
  return VALID_LINES.find(x => Math.abs(v - x) < 0.13) ?? null;
}
function minOdds(p) { return p > 0 ? parseFloat((1 / (p / 100)).toFixed(2)) : null; }

function applyTier(rows) {
  if (TIER === 'ALL') return rows;
  return rows.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
}

function qualifies(b) {
  return b.n >= MIN_N && b.z >= MIN_Z && b.edge >= MIN_EDGE && b.bl >= MIN_BL;
}

function bestQualifying(bets) {
  const q = bets.filter(qualifies);
  if (!q.length) return null;
  q.sort((a, b) => (b.z * b.lo / 100) - (a.z * a.lo / 100));
  return q[0];
}

// ── Layer 1 / Layer 3 — odds-value sweeps (band + quantile variants) ─────────
// `fields` picks which columns represent "the odds this layer is allowed to see":
//   opening: { line: 'fav_lo', odds: 'fav_oo', tl: 'tl_o' }
//   closing: { line: 'fav_line' (already snapped), odds: 'fav_oc', tl: 'tl_c' }
function oddsLayerBandSweep(db, fields, layerName) {
  const results = [];
  for (const line of VALID_LINES) {
    for (const side of ['HOME', 'AWAY']) {
      const base = db.filter(r => {
        const l = fields.line === 'fav_line' ? r.fav_line : snapLine(r[fields.line]);
        return l === line && r.fav_side === side;
      });
      if (base.length < MIN_N) continue;

      for (const oddsBand of ODDS_BANDS) {
        for (const [tlKey, tlBand] of Object.entries(TL_BANDS)) {
          const cfgRows = base.filter(r => inBand(r[fields.odds], oddsBand) && inBand(r[fields.tl], tlBand));
          if (cfgRows.length < MIN_N) continue;

          for (const b of BETS) {
            const p = pct(cfgRows, b.k), bl = pct(base, b.k);
            const z = zScore(cfgRows, base, b.k), edge = p - bl;
            const n = cfgRows.length;
            if (n < MIN_N || z < MIN_Z || edge < MIN_EDGE || bl < MIN_BL) continue;
            const [lo] = wilsonCI(p, n);
            results.push({
              layer: layerName, variant: 'band', line, side,
              oddsBin: bandLabel(oddsBand), tlBin: tlKey,
              bet: b.label, betKey: b.k, n, p, bl, z, edge, lo,
              mo: minOdds(p), mo_lo: minOdds(lo),
            });
          }
        }
      }
    }
  }
  return results.sort((a, b) => (b.z * b.lo / 100) - (a.z * a.lo / 100));
}

function quantileBins(rows, field, n) {
  const valid = rows.filter(r => r[field] != null).sort((a, b) => a[field] - b[field]);
  if (!valid.length) return [];
  const bins = [];
  for (let i = 0; i < n; i++) {
    const lo = Math.floor(valid.length * i / n), hi = Math.floor(valid.length * (i + 1) / n);
    const slice = valid.slice(lo, hi);
    if (!slice.length) continue;
    bins.push({
      label: `Q${i + 1}/${n} [${slice[0][field].toFixed(2)}–${slice[slice.length - 1][field].toFixed(2)}]`,
      set: new Set(slice),
      lo: slice[0][field], hi: slice[slice.length - 1][field],
    });
  }
  return bins;
}

// Locates which quantile bin a value (not necessarily part of the pool the bins
// were built from — e.g. a held-out test-set row) falls into. Bins are sorted
// ascending by construction; a value below the first bin's low edge or above the
// last bin's high edge is clamped to the nearest bin.
function findQuantileBin(bins, value) {
  if (value == null || !bins.length) return null;
  for (const b of bins) if (value <= b.hi) return b;
  return bins[bins.length - 1];
}

function oddsLayerQuantileSweep(db, fields, layerName) {
  const results = [];
  for (const line of VALID_LINES) {
    for (const side of ['HOME', 'AWAY']) {
      const base = db.filter(r => {
        const l = fields.line === 'fav_line' ? r.fav_line : snapLine(r[fields.line]);
        return l === line && r.fav_side === side;
      });
      if (base.length < MIN_N) continue;

      const oddsBins = quantileBins(base, fields.odds, QBINS);
      const tlBins = quantileBins(base, fields.tl, QBINS);

      for (const ob of oddsBins) {
        for (const tb of tlBins) {
          const cfgRows = base.filter(r => ob.set.has(r) && tb.set.has(r));
          if (cfgRows.length < MIN_N) continue;

          for (const b of BETS) {
            const p = pct(cfgRows, b.k), bl = pct(base, b.k);
            const z = zScore(cfgRows, base, b.k), edge = p - bl;
            const n = cfgRows.length;
            if (n < MIN_N || z < MIN_Z || edge < MIN_EDGE || bl < MIN_BL) continue;
            const [lo] = wilsonCI(p, n);
            results.push({
              layer: layerName, variant: 'quantile', line, side,
              oddsBin: ob.label, tlBin: tb.label,
              bet: b.label, betKey: b.k, n, p, bl, z, edge, lo,
              mo: minOdds(p), mo_lo: minOdds(lo),
            });
          }
        }
      }
    }
  }
  return results.sort((a, b) => (b.z * b.lo / 100) - (a.z * a.lo / 100));
}

// ── Layer 2 / Layer 4 — movement grid (optionally + HT trigger) ─────────────
const HT_STATES = [
  { home_goals: 0, away_goals: 0 }, { home_goals: 1, away_goals: 0 },
  { home_goals: 0, away_goals: 1 }, { home_goals: 1, away_goals: 1 },
  { home_goals: 2, away_goals: 0 }, { home_goals: 0, away_goals: 2 },
];

function movementSweep(db, { includeHT, layerName }) {
  const results = [];
  const lmOptions = ['DEEPER', 'STABLE', 'SHRANK'];
  const fomOptions = ['IN', 'STABLE', 'OUT', 'ANY'];
  const domOptions = ['IN', 'STABLE', 'OUT', 'ANY'];
  const tlmOptions = ['UP', 'STABLE', 'DOWN', 'ANY'];
  const gsOptions = [null, ...(includeHT ? HT_STATES.map(s => ({ trigger: 'HT', ...s })) : [])];

  for (const favLine of VALID_LINES) {
    for (const favSide of ['HOME', 'AWAY']) {
      const base = db.filter(r => r.fav_line === favLine && r.fav_side === favSide);
      if (base.length < MIN_N) continue;

      for (const gs of gsOptions) {
        const baseGs = gs ? applyGameState(base, gs) : base;
        if (baseGs.length < MIN_N) continue;

        for (const lm of lmOptions) {
          for (const fom of fomOptions) {
            for (const dom of domOptions) {
              for (const tlm of tlmOptions) {
                const cfgRows = applyConfig(base, {
                  fav_line: favLine, fav_side: favSide,
                  line_move: lm, fav_odds_move: fom, dog_odds_move: dom, tl_move: tlm,
                });
                const gsRows = gs ? applyGameState(cfgRows, gs) : cfgRows;
                if (gsRows.length < MIN_N) continue;

                // With an HT trigger active, FT/1H bets are mechanically implied by
                // the HT score itself (e.g. Over 1.5 FT is ~guaranteed once the HT
                // trigger already shows 1+ goals) — restrict to genuine 2H bets,
                // mirroring engine.js's GS_PROBE_OUTCOMES guard.
                const betPool = gs ? GS_PROBE_OUTCOMES : BETS;
                for (const b of betPool) {
                  const p = pct(gsRows, b.k), bl = pct(baseGs, b.k);
                  const z = zScore(gsRows, baseGs, b.k), edge = p - bl;
                  const n = gsRows.length;
                  if (n < MIN_N || z < MIN_Z || edge < MIN_EDGE || bl < MIN_BL) continue;
                  const [lo] = wilsonCI(p, n);
                  results.push({
                    layer: layerName, variant: 'movement', line: favLine, side: favSide,
                    lm, fom, dom, tlm, gs: gs ? `HT ${gs.home_goals}-${gs.away_goals}` : 'pre-match',
                    bet: b.label, betKey: b.k, n, p, bl, z, edge, lo,
                    mo: minOdds(p), mo_lo: minOdds(lo),
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  // Dedup: best z per (bet, line, side, gs, signals)
  const seen = new Map();
  for (const r of results) {
    const key = `${r.betKey}|${r.line}|${r.side}|${r.gs}|${r.lm}|${r.fom}|${r.dom}|${r.tlm}`;
    if (!seen.has(key) || seen.get(key).z < r.z) seen.set(key, r);
  }
  return [...seen.values()].sort((a, b) => (b.z * b.lo / 100) - (a.z * a.lo / 100));
}

// ── Convergence: per-row recommendation from each layer's own information ────
function gsFromRow(row) {
  return row.fav_side === 'HOME'
    ? { trigger: 'HT', home_goals: row.fav_ht, away_goals: row.dog_ht }
    : { trigger: 'HT', home_goals: row.dog_ht, away_goals: row.fav_ht };
}

function layer1Rec(row, histDb) {
  const line = snapLine(row.fav_lo);
  if (line == null) return null;
  const base = histDb.filter(r => snapLine(r.fav_lo) === line && r.fav_side === row.fav_side);
  if (base.length < MIN_N) return null;
  const oddsBand = ODDS_BANDS.find(b => inBand(row.fav_oo, b));
  const tlBand = Object.values(TL_BANDS).find(b => inBand(row.tl_o, b));
  const cfgRows = base.filter(r => inBand(r.fav_oo, oddsBand) && (tlBand ? inBand(r.tl_o, tlBand) : true));
  if (cfgRows.length < MIN_N) return null;
  return bestQualifying(scoreBets(cfgRows, base, base, MIN_N));
}

function layer1RecQ(row, histDb) {
  const line = snapLine(row.fav_lo);
  if (line == null) return null;
  const base = histDb.filter(r => snapLine(r.fav_lo) === line && r.fav_side === row.fav_side);
  if (base.length < MIN_N) return null;
  const ob = findQuantileBin(quantileBins(base, 'fav_oo', QBINS), row.fav_oo);
  const tb = findQuantileBin(quantileBins(base, 'tl_o', QBINS), row.tl_o);
  if (!ob || !tb) return null;
  const cfgRows = base.filter(r => ob.set.has(r) && tb.set.has(r));
  if (cfgRows.length < MIN_N) return null;
  return bestQualifying(scoreBets(cfgRows, base, base, MIN_N));
}

function layer2Rec(row, histDb) {
  const base = histDb.filter(r => r.fav_line === row.fav_line && r.fav_side === row.fav_side);
  if (base.length < MIN_N) return null;
  const cfgRows = applyConfig(base, {
    fav_line: row.fav_line, fav_side: row.fav_side,
    line_move: row.line_move, fav_odds_move: row.fav_odds_move,
    dog_odds_move: row.dog_odds_move, tl_move: row.tl_move,
  });
  if (cfgRows.length < MIN_N) return null;
  return bestQualifying(scoreBets(cfgRows, base, base, MIN_N));
}

function layer3Rec(row, histDb) {
  const base = histDb.filter(r => r.fav_line === row.fav_line && r.fav_side === row.fav_side);
  if (base.length < MIN_N) return null;
  const oddsBand = ODDS_BANDS.find(b => inBand(row.fav_oc, b));
  const tlBand = Object.values(TL_BANDS).find(b => inBand(row.tl_c, b));
  const cfgRows = base.filter(r => inBand(r.fav_oc, oddsBand) && (tlBand ? inBand(r.tl_c, tlBand) : true));
  if (cfgRows.length < MIN_N) return null;
  return bestQualifying(scoreBets(cfgRows, base, base, MIN_N));
}

function layer3RecQ(row, histDb) {
  const base = histDb.filter(r => r.fav_line === row.fav_line && r.fav_side === row.fav_side);
  if (base.length < MIN_N) return null;
  const ob = findQuantileBin(quantileBins(base, 'fav_oc', QBINS), row.fav_oc);
  const tb = findQuantileBin(quantileBins(base, 'tl_c', QBINS), row.tl_c);
  if (!ob || !tb) return null;
  const cfgRows = base.filter(r => ob.set.has(r) && tb.set.has(r));
  if (cfgRows.length < MIN_N) return null;
  return bestQualifying(scoreBets(cfgRows, base, base, MIN_N));
}

function layer4Rec(row, histDb) {
  const base = histDb.filter(r => r.fav_line === row.fav_line && r.fav_side === row.fav_side);
  if (base.length < MIN_N) return null;
  const cfgRows = applyConfig(base, {
    fav_line: row.fav_line, fav_side: row.fav_side,
    line_move: row.line_move, fav_odds_move: row.fav_odds_move,
    dog_odds_move: row.dog_odds_move, tl_move: row.tl_move,
  });
  const gsRows = applyGameState(cfgRows, gsFromRow(row));
  if (gsRows.length < MIN_N) return null;
  // HT trigger active — restrict to genuine 2H bets (see movementSweep comment above).
  const gsProbeKeys = new Set(GS_PROBE_OUTCOMES.map(b => b.k));
  const bets = scoreBets(gsRows, base, base, MIN_N).filter(b => gsProbeKeys.has(b.k));
  return bestQualifying(bets);
}

// ── Settlement (for realized hit-rate/ROI on the test set) ───────────────────
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

function runConvergence(testDb, histDb, { rec1, rec3, label }) {
  console.log('═'.repeat(124));
  console.log(`CONVERGENCE ANALYSIS (${label}) — test set ${TEST_LABEL} (${testDb.length} matches)`);
  console.log('Per match: what would Layer 1 / 2 / 3 each recommend, using only their own information?');
  console.log('═'.repeat(124));

  const buckets = { agree3: [], agree2: [], solo: [], disagree: [] };
  const layer4Entries = [];
  let nWithAnyRec = 0;

  for (const row of testDb) {
    const r1 = rec1(row, histDb);
    const r2 = layer2Rec(row, histDb);
    const r3 = rec3(row, histDb);
    const recs = [r1, r2, r3].filter(Boolean);
    if (recs.length) nWithAnyRec++;

    const keys = recs.map(r => r.k);
    if (keys.length === 3 && keys[0] === keys[1] && keys[1] === keys[2]) {
      const fraction = settleBet(keys[0], row);
      if (fraction != null) buckets.agree3.push({ fraction, odds: recs[0].mo });
    } else if (keys.length >= 2) {
      const counts = {};
      keys.forEach(k => counts[k] = (counts[k] || 0) + 1);
      const [topKey, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
      if (topCount >= 2) {
        const rec = recs.find(r => r.k === topKey);
        const fraction = settleBet(topKey, row);
        if (fraction != null) buckets.agree2.push({ fraction, odds: rec.mo });
      } else {
        for (const r of recs) {
          const fraction = settleBet(r.k, row);
          if (fraction != null) buckets.disagree.push({ fraction, odds: r.mo });
        }
      }
    } else if (keys.length === 1) {
      const fraction = settleBet(keys[0], row);
      if (fraction != null) buckets.solo.push({ fraction, odds: recs[0].mo });
    }

    const r4 = layer4Rec(row, histDb);
    if (r4) {
      const fraction = settleBet(r4.k, row);
      if (fraction != null) layer4Entries.push({ fraction, odds: r4.mo });
    }
  }

  console.log(`Matches with at least one qualifying layer recommendation: ${nWithAnyRec}/${testDb.length}\n`);

  const printBucket = (bucketLabel, entries) => {
    const t = tallyBucket(entries);
    console.log(`  ${bucketLabel.padEnd(28)} n=${String(t.n).padStart(4)}  non-push=${String(t.nonPush).padStart(4)}  hit%=${t.hitRate.toFixed(1).padStart(5)}%  ROI@fair=${(t.roi >= 0 ? '+' : '') + t.roi.toFixed(1)}%`);
  };
  printBucket('3/3 layers agree', buckets.agree3);
  printBucket('2/3 layers agree', buckets.agree2);
  printBucket('Only 1 layer recommends', buckets.solo);
  printBucket('Layers disagree (no consensus)', buckets.disagree);
  console.log();
  printBucket('Layer 4 alone (full config)', layer4Entries);
  console.log();
}

// ── Report printing ────────────────────────────────────────────────────────
function printRows(rows, top) {
  console.log(`  ${'#'.padStart(3)}  ${'Bet'.padEnd(20)} ${'Line'.padStart(5)} ${'Side'.padEnd(5)} ${'Bin/Signals'.padEnd(38)} ${'n'.padStart(5)} ${'hit%'.padStart(6)} ${'bl%'.padStart(6)} ${'edge'.padStart(7)} ${'z'.padStart(6)} ${'odds'.padStart(11)}`);
  console.log('  ' + '─'.repeat(120));
  rows.slice(0, top).forEach((r, i) => {
    const bin = r.oddsBin != null
      ? `odds:${r.oddsBin} TL:${r.tlBin}`
      : `LM:${r.lm} FavO:${r.fom} DogO:${r.dom} TL:${r.tlm}${r.gs ? '  ' + r.gs : ''}`;
    const odds = `${r.mo ?? '—'}/${r.mo_lo ?? '—'}`;
    console.log(
      `  ${String(i + 1).padStart(3)}  ${r.bet.padEnd(20)} ${(-r.line).toFixed(2).padStart(5)} ${r.side.padEnd(5)} ${bin.padEnd(38)} ` +
      `${String(r.n).padStart(5)} ${r.p.toFixed(1).padStart(5)}% ${r.bl.toFixed(1).padStart(5)}% ${('+' + r.edge.toFixed(1)).padStart(6)}pp ${r.z.toFixed(2).padStart(6)} ${odds.padStart(11)}`
    );
  });
  console.log();
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const sourceDir = SOURCE === 'pinnacle' ? DATA_DIR : BET365_DIR;
  console.log(`Loading database from ${SOURCE} (${sourceDir})…`);
  const raw = SOURCE === 'pinnacle' ? loadDatabase(sourceDir) : loadDatasetDir(sourceDir);
  const full = applyTier(raw);
  console.log(`Total rows: ${raw.length}  (tier=${TIER}: ${full.length})`);
  console.log(`Thresholds: min_n=${MIN_N} min_z=${MIN_Z} min_edge=${MIN_EDGE}pp min_baseline=${MIN_BL}%  qbins=${QBINS}\n`);

  const histDb = full.filter(r => !r.file_label.includes(TEST_LABEL));
  const testDb = full.filter(r => r.file_label.includes(TEST_LABEL));
  console.log(`Held-out test set (${TEST_LABEL}): ${testDb.length} rows  |  training pool: ${histDb.length} rows\n`);

  console.log('═'.repeat(124));
  console.log('LAYER 1 — OPENING ODDS ONLY (band variant)');
  console.log('═'.repeat(124));
  printRows(oddsLayerBandSweep(histDb, { line: 'fav_lo', odds: 'fav_oo', tl: 'tl_o' }, 'L1'), TOP_N);

  console.log('═'.repeat(124));
  console.log(`LAYER 1 — OPENING ODDS ONLY (quantile variant, n=${QBINS})`);
  console.log('═'.repeat(124));
  printRows(oddsLayerQuantileSweep(histDb, { line: 'fav_lo', odds: 'fav_oo', tl: 'tl_o' }, 'L1'), TOP_N);

  console.log('═'.repeat(124));
  console.log('LAYER 2 — MOVEMENT ONLY (opening→closing direction)');
  console.log('═'.repeat(124));
  printRows(movementSweep(histDb, { includeHT: false, layerName: 'L2' }), TOP_N);

  console.log('═'.repeat(124));
  console.log('LAYER 3 — CLOSING ODDS ONLY (band variant)');
  console.log('═'.repeat(124));
  printRows(oddsLayerBandSweep(histDb, { line: 'fav_line', odds: 'fav_oc', tl: 'tl_c' }, 'L3'), TOP_N);

  console.log('═'.repeat(124));
  console.log(`LAYER 3 — CLOSING ODDS ONLY (quantile variant, n=${QBINS})`);
  console.log('═'.repeat(124));
  printRows(oddsLayerQuantileSweep(histDb, { line: 'fav_line', odds: 'fav_oc', tl: 'tl_c' }, 'L3'), TOP_N);

  console.log('═'.repeat(124));
  console.log('LAYER 4 — FULL CONFIG (movement + HT trigger, plain z/edge stats)');
  console.log('═'.repeat(124));
  printRows(movementSweep(histDb, { includeHT: true, layerName: 'L4' }), TOP_N);

  // ── Convergence / divergence ─────────────────────────────────────────────
  // Run once per odds-binning variant, since Layer 1/3 recommendations depend
  // on which binning scheme is used to place a match into a bin (Layer 2's
  // movement-direction recommendation is unaffected — same in both runs).
  runConvergence(testDb, histDb, { rec1: layer1Rec, rec3: layer3Rec, label: 'band variant' });
  runConvergence(testDb, histDb, { rec1: layer1RecQ, rec3: layer3RecQ, label: `quantile variant, n=${QBINS}` });

  console.log(`\nReading this: if the "3/3 agree" / "2/3 agree" rows show a higher hit%/ROI than`);
  console.log(`"disagree" or any single layer alone, convergence across independent layers is`);
  console.log(`itself a usable signal — require at least 2/3 agreement before betting. If Layer 4`);
  console.log(`(one combined filter) beats the best agreement bucket, a single richer filter is`);
  console.log(`doing better than an ensemble of simpler ones for this dataset.`);
}

main();
