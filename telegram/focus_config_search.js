'use strict';
// ── Focus-bet config search (PLAN_FOCUS_BETS.md Phase 2) ──────────────────────
// For each of the 7 in-scope 1T/2T Over/Under bets, finds which pre-match
// configuration (fav line/side, closing TL band, TL move, Over/Under odds
// move, league tier — plus, for the four 2H bets, the exact HT scoreline)
// produces a real edge over the market-implied price from focus_lib.js.
//
// Winner's-curse guard: every cell is selected on one fold (`row.fold`,
// engine.js's deterministic 50/50 split) and priced with the OTHER fold —
// same fix documented in CLAUDE.md's "Cross-Fit Bet Selection" section, since
// picking-and-pricing off the same pool inflates whichever cell "won".
//
// Walk-forward: the last 8 months are each held out in turn (train = all
// months strictly before the test month), per PLAN_FOCUS_BETS.md's rule. A
// cell survives only if it fires in >=6/8 held-out months with positive ROI
// and has pooled n>=100 at the model-implied price.
//
// IMPORTANT CAVEAT (see focus_lib.js's impliedPrice header): the CrossBooks
// CSVs carry no real historical price for 1H/2H 0.5/1.5 lines, only the FT
// Over/Under at the closing Total Line. Every "price"/"ROI" figure here is
// against a MODEL-IMPLIED price (Poisson split of a bivariate-Poisson fit to
// the match's own closing AH+O/U odds), not a real settled market price. This
// validates "does this configuration beat what the match's own odds imply",
// not "does this beat what a bookmaker would actually have quoted for this
// exact half-line market". Treat pooled ROI as a signal-quality ranking, not
// a literal expected return.
//
// Usage:
//   node focus_config_search.js                 — full search, all 7 keys
//   node focus_config_search.js --key=over05_2H  — one key only (faster, for iterating)
//   node focus_config_search.js --months=4       — shorter walk-forward window

const lib = require('./focus_lib');

const KEY_ARG    = (process.argv.find(a => a.startsWith('--key=')) || '').split('=')[1];
const KEYS       = KEY_ARG ? [KEY_ARG] : lib.FOCUS_KEYS;
const MONTHS_ARG = (process.argv.find(a => a.startsWith('--months=')) || '').split('=')[1];
const WF_MONTHS  = MONTHS_ARG ? parseInt(MONTHS_ARG, 10) : 8;

const MIN_N_TRAIN_FOLD = 100;  // min cell size within ONE fold to be a selection candidate
const MIN_N_PRICE_FOLD = 30;   // min cell size in the OTHER fold to accept its pricing
const MIN_N_TEST       = 15;   // min cell size in the held-out test month to count it
const EDGE_MIN_PP      = 2;    // Wilson CI lower bound must clear the mean implied fair% by this much
const MIN_MONTHS_FRAC  = 0.75; // >=6/8

// ── Grouping (single O(n) pass instead of a combinatorial filter sweep) ──
// Dimension bucketing (tlBandOf/tierBucket/htStateOf/compositeKey) lives in
// focus_lib.js — shared with notify.js's live FOCUS strategy so a live
// match's key is built by the exact same function as these historical cells.
function groupBy(rows, isHalf2) {
  const map = new Map();
  for (const r of rows) {
    const k = lib.compositeKey(r, isHalf2);
    let arr = map.get(k);
    if (!arr) map.set(k, arr = []);
    arr.push(r);
  }
  return map;
}

function stats(rows, key, correctionPct) {
  const n = rows.length;
  if (!n) return null;
  const hits = rows.filter(r => lib.outcome(r, key)).length;
  const p = hits / n * 100;
  const [lo, hi] = lib.wilsonCI(p, n);
  let sumFair = 0, priced = 0;
  for (const r of rows) {
    const ip = lib.impliedPrice(r, key, correctionPct);
    if (ip) { sumFair += ip.fairImplied; priced++; }
  }
  const meanFairPct = priced ? (sumFair / priced) * 100 : null;
  return { n, hits, p, lo, hi, meanFairPct, priced };
}

function qualifies(st) {
  return !!st && st.n >= MIN_N_TRAIN_FOLD && st.meanFairPct != null &&
    (st.lo - st.meanFairPct) >= EDGE_MIN_PP;
}

// Cross-fit select-on-one-fold, price-with-the-other — mirrors
// engine.js's mergeCrossFit but keyed by our own composite cells instead of
// the BETS list, since focus cells are configuration-defined, not bet-key-defined.
function crossFitCells(trainRows, key, isHalf2, correctionPct) {
  const foldA = trainRows.filter(r => r.fold === 'A');
  const foldB = trainRows.filter(r => r.fold === 'B');
  const mapA = groupBy(foldA, isHalf2);
  const mapB = groupBy(foldB, isHalf2);
  const allKeys = new Set([...mapA.keys(), ...mapB.keys()]);

  const selected = [];
  for (const k of allKeys) {
    const rowsA = mapA.get(k) || [];
    const rowsB = mapB.get(k) || [];
    const stA = rowsA.length ? stats(rowsA, key, correctionPct) : null;
    const stB = rowsB.length ? stats(rowsB, key, correctionPct) : null;

    const candidates = [];
    if (qualifies(stA) && stB && stB.n >= MIN_N_PRICE_FOLD) candidates.push({ pricedFold: 'B', st: stB });
    if (qualifies(stB) && stA && stA.n >= MIN_N_PRICE_FOLD) candidates.push({ pricedFold: 'A', st: stA });
    if (!candidates.length) continue;
    const best = candidates.reduce((x, y) => (y.st.n > x.st.n ? y : x));
    selected.push({ cellKey: k, pricedFold: best.pricedFold, priced: best.st });
  }
  return selected;
}

function evalOnTestMonth(selectedCells, testRows, key, isHalf2, correctionPct) {
  const testMap = groupBy(testRows, isHalf2);
  const out = [];
  for (const cell of selectedCells) {
    const rows = testMap.get(cell.cellKey) || [];
    if (rows.length < MIN_N_TEST) continue;
    let hits = 0, staked = 0, profit = 0;
    for (const r of rows) {
      const ip = lib.impliedPrice(r, key, correctionPct);
      if (!ip) continue;
      staked++;
      if (lib.outcome(r, key)) { hits++; profit += ip.price - 1; }
      else profit -= 1;
    }
    if (!staked) continue;
    out.push({
      cellKey: cell.cellKey, pricedFold: cell.pricedFold,
      trainStats: cell.priced, n: staked, hits, hitPct: hits / staked * 100,
      roi: profit / staked * 100,
    });
  }
  return out;
}

function runKey(key) {
  const isHalf2 = lib.FOCUS_HALF[key] === '2H';
  const allRows = runKey._allRows || (runKey._allRows = lib.loadBook('Bet365'));

  const perMonth = lib.walkForward(allRows, (trainRows, testRows, testMonth) => {
    // Calibration correction derived from TRAIN rows only (never the test
    // month) — see focus_lib.js's computeCalibration header for why this
    // must be walk-forward, not a single global constant.
    const correctionPct = lib.computeCalibration(trainRows, key);
    const cells = crossFitCells(trainRows, key, isHalf2, correctionPct);
    return evalOnTestMonth(cells, testRows, key, isHalf2, correctionPct);
  }, WF_MONTHS);

  // Aggregate by cellKey across months.
  const byCell = new Map();
  for (const { month, result } of perMonth) {
    for (const r of result) {
      let agg = byCell.get(r.cellKey);
      if (!agg) agg = { cellKey: r.cellKey, months: [], totalN: 0, totalHits: 0, totalProfit: 0 };
      agg.months.push({ month, n: r.n, hitPct: r.hitPct, roi: r.roi, trainStats: r.trainStats });
      agg.totalN += r.n;
      agg.totalHits += r.hits;
      agg.totalProfit += (r.roi / 100) * r.n;
      byCell.set(r.cellKey, agg);
    }
  }

  const survivors = [];
  for (const agg of byCell.values()) {
    const monthsSeen = agg.months.length;
    const monthsPositive = agg.months.filter(m => m.roi > 0).length;
    const pooledRoi = agg.totalN ? (agg.totalProfit / agg.totalN) * 100 : 0;
    const pooledHitPct = agg.totalN ? (agg.totalHits / agg.totalN) * 100 : 0;
    if (monthsSeen < Math.ceil(WF_MONTHS * 0.5)) continue; // must show up in at least half the window to judge consistency
    if (monthsPositive / monthsSeen < MIN_MONTHS_FRAC) continue;
    if (agg.totalN < 100) continue;
    if (pooledRoi <= 0) continue;
    survivors.push({
      key, cellKey: agg.cellKey, monthsSeen, monthsPositive,
      pooledN: agg.totalN, pooledHitPct, pooledRoi, months: agg.months,
    });
  }
  survivors.sort((a, b) => b.pooledRoi - a.pooledRoi);
  return survivors;
}

function parseCellKey(cellKey, isHalf2) {
  const parts = cellKey.split('|');
  const [fav_line, fav_side, tl_band, tier, tl_move, over_move, ht_state] = parts;
  const out = { fav_line, fav_side, tl_band, tier, tl_move, over_move };
  if (isHalf2) out.ht_state = ht_state;
  return out;
}

function main() {
  console.log('\n═══ Focus-bet config search (Phase 2) ═══════════════════════════════');
  console.log(`Keys: ${KEYS.join(', ')}`);
  console.log(`Walk-forward window: last ${WF_MONTHS} months`);
  console.log(`Thresholds: minTrainFold=${MIN_N_TRAIN_FOLD}, minPriceFold=${MIN_N_PRICE_FOLD}, minTest=${MIN_N_TEST}, edgeMin=${EDGE_MIN_PP}pp, monthsPositiveFrac>=${MIN_MONTHS_FRAC}, pooledN>=100`);

  const allResults = {};
  for (const key of KEYS) {
    process.stdout.write(`\nSearching ${key} (${lib.FOCUS_LABELS[key]})... `);
    const t0 = Date.now();
    const survivors = runKey(key);
    console.log(`${survivors.length} surviving cell(s), ${Date.now() - t0}ms`);
    allResults[key] = survivors;

    if (survivors.length) {
      const isHalf2 = lib.FOCUS_HALF[key] === '2H';
      console.log(`  ${'cell'.padEnd(60)} ${'seen'.padStart(4)} ${'pos'.padStart(4)} ${'n'.padStart(6)} ${'hit%'.padStart(6)} ${'roi%'.padStart(7)}`);
      for (const s of survivors.slice(0, 15)) {
        const cell = parseCellKey(s.cellKey, isHalf2);
        const label = `${cell.fav_line}/${cell.fav_side} TL:${cell.tl_band} ${cell.tier} tlm:${cell.tl_move} ovm:${cell.over_move}${cell.ht_state ? ' HT:' + cell.ht_state : ''}`;
        console.log(`  ${label.padEnd(60)} ${String(s.monthsSeen).padStart(4)} ${String(s.monthsPositive).padStart(4)} ${String(s.pooledN).padStart(6)} ${s.pooledHitPct.toFixed(1).padStart(6)} ${s.pooledRoi.toFixed(1).padStart(7)}`);
      }
    }
  }

  const file = lib.saveJson('focus_configs.json', {
    generatedAt: new Date().toISOString(),
    windowMonths: WF_MONTHS,
    thresholds: { MIN_N_TRAIN_FOLD, MIN_N_PRICE_FOLD, MIN_N_TEST, EDGE_MIN_PP, MIN_MONTHS_FRAC },
    caveat: 'ROI/price figures are against a model-implied price (see focus_lib.js impliedPrice header), not a real settled market price for these half-line markets.',
    results: allResults,
  });
  console.log(`\nSaved -> ${file}`);
}

main();
