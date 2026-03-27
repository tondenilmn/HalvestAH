'use strict';
// ── GSA backtest — Option A: AH line + HT score ───────────────────────────────
//
// Pipeline per test match:
//   1. Baseline pool : all historical rows with this AH line (any side, any movement)
//   2. Signal pool   : baseline filtered to same fav_side + exact HT score (fav/dog)
//   3. Score bets    : signal pool vs baseline pool
//   4. 5 GSA filters : n, z, delta, signal%, baseline%
//
// The HT score is the PRIMARY signal — it encodes real game state (who scored,
// by how much) which causally affects 2H outcomes via tactics and psychology.
// Pre-match market signals (LM, TLM) are NOT used — backtesting showed they add
// zero out-of-sample edge (OOS hit rate ≈ baseline, -25% ROI@fair).
//
// ROI is calculated at mo (fair odds = 1/hit_rate, target shown in alerts).
// mo_lo (Wilson 95% CI floor) is reported as reference only.
//
// Usage:
//   node backtest_gsa.js                        — Feb 2026, ALL leagues
//   node backtest_gsa.js --tier TOP+MAJOR       — restrict to TOP+MAJOR
//   node backtest_gsa.js --month _01_26_        — different month
//   node backtest_gsa.js --all-months           — run all known months
//   node backtest_gsa.js --verbose              — show per-bet + HT breakdown
//   node backtest_gsa.js --ht 1 0               — only test HT fav=1 dog=0 cases
//
// Threshold overrides (override config.js values):
//   --min-n 80          GSA_MIN_N  (larger cells now — recommend 50+)
//   --min-z 2.0         GSA_MIN_Z
//   --min-delta 6       GSA_MIN_DELTA
//   --min-p-2h 50       GSA_MIN_P_2H
//   --min-p-ft 40       GSA_MIN_P_FT
//   --min-baseline 25   GSA_MIN_BASELINE

const path = require('path');
const { loadDatabase, scoreBets } = require('./engine');
const baseCfg = require('./config');

// ── CLI helpers ───────────────────────────────────────────────────────────────
const argv = process.argv;
function getArg(flag)       { const i = argv.indexOf(flag); return i !== -1 ? argv[i + 1] : null; }
function hasFlag(flag)      { return argv.includes(flag); }
function numArg(flag, fb)   { const v = getArg(flag); return v != null ? parseFloat(v) : fb; }

// ── Thresholds: config.js defaults + CLI overrides ───────────────────────────
const MIN_N        = numArg('--min-n',         baseCfg.GSA_MIN_N        ?? 80);
const MIN_Z        = numArg('--min-z',         baseCfg.GSA_MIN_Z        ?? 2.0);
const MIN_DELTA    = numArg('--min-delta',     baseCfg.GSA_MIN_DELTA    ?? 6);
const MIN_P_2H     = numArg('--min-p-2h',     baseCfg.GSA_MIN_P_2H     ?? 50);
const MIN_P_FT     = numArg('--min-p-ft',     baseCfg.GSA_MIN_P_FT     ?? 40);
const MIN_BASELINE = numArg('--min-baseline', baseCfg.GSA_MIN_BASELINE  ?? 25);

// ── Optional fixed HT score filter (for exploration) ─────────────────────────
// e.g. --ht 1 0 → only score test rows where fav led 1-0 at HT
const HT_FAV = getArg('--ht') != null ? parseInt(getArg('--ht'), 10) : null;
const HT_DOG = HT_FAV != null
  ? (() => { const i = argv.indexOf('--ht'); return i !== -1 ? parseInt(argv[i + 2], 10) : null; })()
  : null;

// ── CLI flags ─────────────────────────────────────────────────────────────────
const VERBOSE    = hasFlag('--verbose');
const ALL_MONTHS = hasFlag('--all-months');
const tierArg    = getArg('--tier')  ?? (baseCfg.HT_LEAGUE_TIER ?? 'ALL');
const monthArg   = getArg('--month') ?? '_02_26_';
const DATA_DIR   = path.resolve(__dirname, '../static/data');

// ── Allowed bets ──────────────────────────────────────────────────────────────
const BETS_2H = new Set([
  'over05_2H', 'over15_2H', 'under15_2H',
  'favScored2H', 'homeScored2H', 'awayScored2H',
  'favWins2H', 'homeWins2H', 'awayWins2H', 'draw2H',
]);
const BETS_FT = new Set([
  'over15FT', 'over25FT', 'under25FT',
  'homeWinsFT', 'awayWinsFT', 'drawFT', 'btts',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────
function applyTier(db, tier) {
  if (tier === 'TOP')       return db.filter(r => r.league_tier === 'TOP');
  if (tier === 'MAJOR')     return db.filter(r => r.league_tier === 'MAJOR');
  if (tier === 'TOP+MAJOR') return db.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
  return db;
}

// Pre-build lookup indexes over the historical DB for O(1) pool retrieval.
// fav_line is always snapped to VALID_LINES (exact), so string keys are safe.
function buildIndex(db) {
  const lineIdx     = new Map(); // favLine → rows (both sides)
  const lineSideIdx = new Map(); // `${favLine}_${favSide}` → rows
  const htIdx       = new Map(); // `${favLine}_${favSide}_${favHt}_${dogHt}` → rows
  for (const r of db) {
    const lk = String(r.fav_line);
    const sk = `${r.fav_line}_${r.fav_side}`;
    const hk = `${r.fav_line}_${r.fav_side}_${r.fav_ht}_${r.dog_ht}`;
    if (!lineIdx.has(lk))     lineIdx.set(lk, []);
    if (!lineSideIdx.has(sk)) lineSideIdx.set(sk, []);
    if (!htIdx.has(hk))       htIdx.set(hk, []);
    lineIdx.get(lk).push(r);
    lineSideIdx.get(sk).push(r);
    htIdx.get(hk).push(r);
  }
  return { lineIdx, lineSideIdx, htIdx };
}

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function pct(n, d) { return d ? (n / d * 100).toFixed(1) : '—'; }
function sign(v) { return v >= 0 ? '+' : ''; }
function htLabel(favHt, dogHt) { return `${favHt}–${dogHt}`; }

// ── Core: run one month ───────────────────────────────────────────────────────
function runMonth(fullDb, testLabel, tier) {
  const histDb   = fullDb.filter(r => !r.file_label.includes(testLabel));
  const testRows = fullDb.filter(r =>  r.file_label.includes(testLabel));
  if (!testRows.length) return null;

  const histTier = applyTier(histDb, tier);
  const idx      = buildIndex(histTier); // O(n) once — then O(1) lookups below

  const alerts = [];
  let nChecked = 0, nHtMissing = 0, nSmallPool = 0;

  for (const row of testRows) {
    const favLine = row.fav_line;
    const favSide = row.fav_side;
    const favHt   = row.fav_ht;
    const dogHt   = row.dog_ht;

    // HT score must be present to be a valid HT-window test case
    if (favHt == null || dogHt == null || isNaN(favHt) || isNaN(dogHt)) { nHtMissing++; continue; }
    nChecked++;

    // Optional: restrict to a specific HT score for focused analysis
    if (HT_FAV != null && (favHt !== HT_FAV || dogHt !== HT_DOG)) continue;

    // ── O(1) pool lookups via pre-built index ─────────────────────────────
    const blRows  = idx.lineIdx.get(String(favLine))                               || [];
    const blSide  = idx.lineSideIdx.get(`${favLine}_${favSide}`)                   || [];
    const cfgRows = idx.htIdx.get(`${favLine}_${favSide}_${favHt}_${dogHt}`)       || [];

    if (cfgRows.length < MIN_N) { nSmallPool++; continue; }

    const bets = scoreBets(cfgRows, blRows, blSide, MIN_N);
    for (const b of bets) {
      const is2H = BETS_2H.has(b.k);
      const isFT = BETS_FT.has(b.k);
      if (!is2H && !isFT) continue;
      const minP = is2H ? MIN_P_2H : MIN_P_FT;
      if (b.n    < MIN_N)        continue;
      if (b.z    < MIN_Z)        continue;
      if (b.edge < MIN_DELTA)    continue;
      if (b.p    < minP)         continue;
      if (b.bl   < MIN_BASELINE) continue;

      const hit = row[b.k] === true;
      alerts.push({ row, b, hit, type: is2H ? '2H' : 'FT', favHt, dogHt, favLine, favSide });
    }
  }

  return { testLabel, testRows: testRows.length, nChecked, nHtMissing, nSmallPool, alerts };
}

// ── Stats ─────────────────────────────────────────────────────────────────────
function calcStats(alerts) {
  if (!alerts.length) return null;
  const hits     = alerts.filter(a => a.hit).length;
  const hitPct   = hits / alerts.length * 100;
  const avgBl    = avg(alerts.map(a => a.b.bl));
  const avgSig   = avg(alerts.map(a => a.b.p));
  const avgDelta = avg(alerts.map(a => a.b.edge));

  const pnlFair = alerts.reduce((s, a) => {
    const o = parseFloat(a.b.mo);
    return isNaN(o) ? s : s + (a.hit ? o - 1 : -1);
  }, 0);
  const stFair  = alerts.filter(a => !isNaN(parseFloat(a.b.mo))).length;
  const roiFair = stFair ? pnlFair / stFair * 100 : 0;
  const avgOdds = avg(alerts.filter(a => !isNaN(parseFloat(a.b.mo))).map(a => parseFloat(a.b.mo)));

  const pnlLo  = alerts.reduce((s, a) => {
    const o = parseFloat(a.b.mo_lo);
    return isNaN(o) ? s : s + (a.hit ? o - 1 : -1);
  }, 0);
  const stLo   = alerts.filter(a => !isNaN(parseFloat(a.b.mo_lo))).length;
  const roiLo  = stLo ? pnlLo / stLo * 100 : 0;

  return { n: alerts.length, hits, hitPct, avgBl, avgSig, avgDelta,
           pnlFair, roiFair, stFair, avgOdds, pnlLo, roiLo, stLo };
}

// ── Per-bet breakdown ─────────────────────────────────────────────────────────
function printPerBet(alerts) {
  const byBet = new Map();
  for (const a of alerts) {
    if (!byBet.has(a.b.k)) byBet.set(a.b.k, []);
    byBet.get(a.b.k).push(a);
  }
  const rows = [...byBet.entries()]
    .map(([, alts]) => {
      const hits  = alts.filter(a => a.hit).length;
      const pnl   = alts.reduce((s, a) => {
        const o = parseFloat(a.b.mo);
        return isNaN(o) ? s : s + (a.hit ? o - 1 : -1);
      }, 0);
      const st    = alts.filter(a => !isNaN(parseFloat(a.b.mo))).length;
      const pnlLo = alts.reduce((s, a) => {
        const o = parseFloat(a.b.mo_lo);
        return isNaN(o) ? s : s + (a.hit ? o - 1 : -1);
      }, 0);
      const stLo  = alts.filter(a => !isNaN(parseFloat(a.b.mo_lo))).length;
      return {
        label:    alts[0].b.label,
        type:     alts[0].type,
        count:    alts.length,
        hits,
        hitPct:   hits / alts.length * 100,
        avgDelta: avg(alts.map(a => a.b.edge)),
        avgOdds:  avg(alts.filter(a => !isNaN(parseFloat(a.b.mo))).map(a => parseFloat(a.b.mo))),
        pnl, roi: st ? pnl / st * 100 : 0,
        pnlLo, roiLo: stLo ? pnlLo / stLo * 100 : 0,
      };
    })
    .sort((a, b) => b.count - a.count);

  console.log(`\n${'─'.repeat(100)}`);
  console.log('  Bet                        type   ×    hit%    Δ̄     avg odds  ROI@fair  ROI@lo   P&L@fair');
  console.log('  ' + '─'.repeat(98));
  for (const r of rows) {
    console.log(
      `  ${r.label.padEnd(26)} ${r.type.padEnd(4)}  ×${String(r.count).padStart(3)}` +
      `  ${r.hitPct.toFixed(1).padStart(5)}%` +
      `  ${sign(r.avgDelta)}${r.avgDelta.toFixed(1)}pp` +
      `  ${r.avgOdds.toFixed(2).padStart(8)}` +
      `  ${(sign(r.roi)   + r.roi.toFixed(1)).padStart(8)}%` +
      `  ${(sign(r.roiLo) + r.roiLo.toFixed(1)).padStart(7)}%` +
      `  ${(sign(r.pnl)   + r.pnl.toFixed(2)).padStart(8)}u`
    );
  }

  // ── HT score distribution ─────────────────────────────────────────────────
  const byHt = new Map();
  for (const a of alerts) {
    const k = htLabel(a.favHt, a.dogHt);
    if (!byHt.has(k)) byHt.set(k, { hits: 0, total: 0 });
    const e = byHt.get(k);
    e.total++;
    if (a.hit) e.hits++;
  }
  const htRows = [...byHt.entries()]
    .map(([k, v]) => ({ k, ...v, hitPct: v.hits / v.total * 100 }))
    .sort((a, b) => b.total - a.total);

  console.log(`\n  HT score distribution (fav–dog perspective):`);
  console.log(`  ${'HT'.padEnd(8)} ${'alerts'.padStart(6)}  ${'hit%'.padStart(6)}`);
  for (const r of htRows) {
    console.log(`  ${r.k.padEnd(8)} ${String(r.total).padStart(6)}  ${r.hitPct.toFixed(1).padStart(5)}%`);
  }
}

// ── Print summary block ───────────────────────────────────────────────────────
function printSummary(label, res) {
  const s = calcStats(res.alerts);
  console.log(`\n${'═'.repeat(72)}`);
  console.log(`GSA BACKTEST (Option A: line + HT score) — ${label}`);
  console.log(`Tier: ${tierArg}  ·  signal: AH line + HT score  ·  no movement filter`);
  if (HT_FAV != null) console.log(`HT filter: fav=${HT_FAV} dog=${HT_DOG}`);
  console.log(`Thresholds: n≥${MIN_N}  z≥${MIN_Z}  Δ≥${MIN_DELTA}pp  p≥${MIN_P_2H}%(2H)/${MIN_P_FT}%(FT)  bl≥${MIN_BASELINE}%`);
  console.log('═'.repeat(72));
  console.log(`Test matches              : ${res.testRows}`);
  console.log(`Processed (HT known)      : ${res.nChecked}`);
  console.log(`HT score missing          : ${res.nHtMissing}`);
  console.log(`Skipped (pool < ${MIN_N})     : ${res.nSmallPool}`);
  console.log(`Alerts fired              : ${res.alerts.length}`);
  if (!s) { console.log('\n⚠  No alerts.'); return null; }
  console.log(`\nHit rate                  : ${s.hits}/${s.n} = ${s.hitPct.toFixed(1)}%`);
  console.log(`Avg signal%               : ${s.avgSig.toFixed(1)}%`);
  console.log(`Avg baseline%             : ${s.avgBl.toFixed(1)}%`);
  console.log(`Avg delta                 : ${sign(s.avgDelta)}${s.avgDelta.toFixed(1)}pp`);
  console.log(`Avg fair odds (mo)        : ${s.avgOdds.toFixed(2)}`);
  console.log(`\nROI @ fair odds (mo)      : ${sign(s.roiFair)}${s.roiFair.toFixed(1)}%  P&L ${sign(s.pnlFair)}${s.pnlFair.toFixed(2)}u  (${s.stFair} bets)  ← primary`);
  console.log(`ROI @ CI floor (mo_lo)    : ${sign(s.roiLo)}${s.roiLo.toFixed(1)}%  P&L ${sign(s.pnlLo)}${s.pnlLo.toFixed(2)}u  (${s.stLo} bets)  ← reference`);
  return s;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  console.log(`\nLoading database from ${DATA_DIR}…`);
  const fullDb = loadDatabase(DATA_DIR);
  console.log(`Total rows: ${fullDb.length}`);

  if (ALL_MONTHS) {
    const MONTHS = [
      { label: '_01_25_',      name: 'Jan 2025' },
      { label: '_02_25_',      name: 'Feb 2025' },
      { label: '_03_25_',      name: 'Mar 2025' },
      { label: '_04_25_',      name: 'Apr 2025' },
      { label: '_05_25_',      name: 'May 2025' },
      { label: '_06_25_',      name: 'Jun 2025' },
      { label: '_09_25_',      name: 'Sep 2025' },
      { label: '_10_Pinnacle', name: 'Oct 2025' },
      { label: '_11_Pinnacle', name: 'Nov 2025' },
      { label: '_12_Pinnacle', name: 'Dec 2025' },
      { label: '_01_Pinnacle', name: 'Jan 2026' },
      { label: '_02_26_',      name: 'Feb 2026' },
    ];

    const allAlerts = [];
    const tableRows = [];

    for (const { label, name } of MONTHS) {
      process.stdout.write(`  ${name}… `);
      const res = runMonth(fullDb, label, tierArg);
      if (!res || !res.testRows) { console.log('no data'); continue; }
      const s = calcStats(res.alerts);
      allAlerts.push(...res.alerts);
      tableRows.push({ name, ...res, s });
      console.log(`${res.alerts.length} alerts`);
    }

    console.log(`\n${'═'.repeat(96)}`);
    console.log(`ALL-MONTHS GSA BACKTEST (Option A)  tier=${tierArg}  ·  signal: AH line + HT score  ·  n≥${MIN_N} z≥${MIN_Z} Δ≥${MIN_DELTA}pp`);
    console.log('═'.repeat(96));
    console.log('  Month        matches  alerts  hit%    sig%    bl%     Δ̄      avg odds  ROI@fair  ROI@lo');
    console.log('  ' + '─'.repeat(94));

    for (const r of tableRows) {
      const s = r.s;
      if (!s) { console.log(`  ${r.name.padEnd(10)}  ${String(r.testRows).padStart(7)}       0  —`); continue; }
      console.log(
        `  ${r.name.padEnd(10)}  ${String(r.testRows).padStart(7)}  ${String(r.alerts.length).padStart(6)}` +
        `  ${s.hitPct.toFixed(1).padStart(5)}%` +
        `  ${s.avgSig.toFixed(1).padStart(5)}%` +
        `  ${s.avgBl.toFixed(1).padStart(5)}%` +
        `  ${sign(s.avgDelta)}${s.avgDelta.toFixed(1).padStart(4)}pp` +
        `  ${s.avgOdds.toFixed(2).padStart(8)}` +
        `  ${(sign(s.roiFair) + s.roiFair.toFixed(1)).padStart(8)}%` +
        `  ${(sign(s.roiLo)   + s.roiLo.toFixed(1)).padStart(7)}%`
      );
    }

    const agg = calcStats(allAlerts);
    const totalMatches = tableRows.reduce((s, r) => s + r.testRows, 0);
    console.log('  ' + '─'.repeat(94));
    if (agg) {
      console.log(
        `  ${'TOTAL'.padEnd(10)}  ${String(totalMatches).padStart(7)}  ${String(agg.n).padStart(6)}` +
        `  ${agg.hitPct.toFixed(1).padStart(5)}%` +
        `  ${agg.avgSig.toFixed(1).padStart(5)}%` +
        `  ${agg.avgBl.toFixed(1).padStart(5)}%` +
        `  ${sign(agg.avgDelta)}${agg.avgDelta.toFixed(1).padStart(4)}pp` +
        `  ${agg.avgOdds.toFixed(2).padStart(8)}` +
        `  ${(sign(agg.roiFair) + agg.roiFair.toFixed(1)).padStart(8)}%` +
        `  ${(sign(agg.roiLo)   + agg.roiLo.toFixed(1)).padStart(7)}%`
      );
    }

    if (VERBOSE && agg) printPerBet(allAlerts);
    return;
  }

  // ── Single month ─────────────────────────────────────────────────────────
  const res = runMonth(fullDb, monthArg, tierArg);
  if (!res) { console.log(`No test rows for label: ${monthArg}`); return; }

  const s = printSummary(`${monthArg}  test`, res);
  if (s && VERBOSE) printPerBet(res.alerts);
}

main();
