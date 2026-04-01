'use strict';
// ── TL STEAM → BET UNDER (closing TL) ────────────────────────────────────────
//
// Condition: closing Total Line is ≥ threshold HIGHER than opening
//   tl_c - tl_o >= 0.50 (2-step steam)
//   tl_c - tl_o >= 0.75 (3-step steam)
// Bet: Under at closing under odds (un_c)
//
// Also split by fav_side to check if home/away context matters.
//
// P&L per unit (Under perspective):
//   total_goals = fav_ft + dog_ft
//   diff = total_goals - tl_c   (negative = under, positive = over)
//   diff < -0.26  → Full Win:  +( un_c − 1 )
//   diff < -0.01  → Half Win:  +0.5 × ( un_c − 1 )
//   |diff| ≤ 0.01 → Refund:    0
//   diff >  0.01  → Half Loss: −0.5
//   diff >  0.26  → Full Loss: −1
//
// Usage:
//   node backtest_under_tlsteam.js          — TOP+MAJOR
//   node backtest_under_tlsteam.js --all    — all leagues

const path = require('path');
const { loadDatabase } = require('./engine');

const LEAGUE_TIER = process.argv.includes('--all') ? 'ALL' : 'TOP+MAJOR';
const DATA_DIR    = path.resolve(__dirname, '../static/data');

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

// ── Helpers ────────────────────────────────────────────────────────────────────
function applyTier(db, tier) {
  if (tier === 'ALL')       return db;
  if (tier === 'TOP+MAJOR') return db.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
  if (tier === 'TOP')       return db.filter(r => r.league_tier === 'TOP');
  if (tier === 'MAJOR')     return db.filter(r => r.league_tier === 'MAJOR');
  return db;
}

function wilsonLower(hits, n, z = 1.645) {
  if (!n) return 0;
  const p = hits / n;
  const denom = 1 + z * z / n;
  const centre = p + z * z / (2 * n);
  const margin = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n));
  return (centre - margin) / denom;
}

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

// Under result based on total goals vs closing TL
function computePnl(r) {
  const goals = r.fav_ft + r.dog_ft;
  const diff  = goals - r.tl_c;           // positive = over, negative = under
  if      (diff < -0.26) return r.un_c - 1;
  else if (diff < -0.01) return 0.5 * (r.un_c - 1);
  else if (diff >  0.26) return -1;
  else if (diff >  0.01) return -0.5;
  else                   return 0;
}

function classifyResult(r) {
  const diff = (r.fav_ft + r.dog_ft) - r.tl_c;
  if      (diff < -0.26) return 'W';
  else if (diff < -0.01) return 'HW';
  else if (diff >  0.26) return 'L';
  else if (diff >  0.01) return 'HL';
  else                   return 'P';
}

// ── Section printer ────────────────────────────────────────────────────────────
function printSection(fullDb, sectionLabel, filterFn) {
  console.log('\n' + '═'.repeat(90));
  console.log(`  ${sectionLabel}`);
  console.log('═'.repeat(90));

  // ── Month-by-month ────────────────────────────────────────────────────────
  let totN = 0, totW = 0, totHW = 0, totHL = 0, totL = 0, totP = 0, totPnl = 0;
  const monthly = [];

  for (const { label: lbl, name } of MONTHS) {
    const testRows = fullDb.filter(r => r.file_label.includes(lbl));
    if (!testRows.length) continue;
    const matched = testRows.filter(filterFn);
    if (!matched.length) continue;

    let w = 0, hw = 0, hl = 0, l = 0, p = 0, pnl = 0;
    for (const r of matched) {
      const res = classifyResult(r);
      if (res === 'W')  w++;
      if (res === 'HW') hw++;
      if (res === 'HL') hl++;
      if (res === 'L')  l++;
      if (res === 'P')  p++;
      pnl += computePnl(r);
    }
    const n = matched.length;
    totN += n; totW += w; totHW += hw; totHL += hl; totL += l; totP += p; totPnl += pnl;
    monthly.push({ name, n, w, hw, hl, l, p, pnl,
      fullWin: w / n * 100, anyWin: (w + hw) / n * 100,
      avgOdds: avg(matched.map(r => r.un_c)),
      roi: pnl / n * 100,
      avgMove: avg(matched.map(r => r.tl_c - r.tl_o)) });
  }

  if (!monthly.length) { console.log('  (no data)'); return null; }

  console.log('\n── Monthly out-of-sample ─────────────────────────────────────────────────────');
  console.log('Month        n     W    HW    HL     L    P   Win%  AnyW%  Avg odds  Avg tlm  ROI%');
  console.log('─'.repeat(90));
  for (const m of monthly) {
    console.log(
      `${m.name.padEnd(12)} ${String(m.n).padStart(4)}` +
      `  ${String(m.w).padStart(4)} ${String(m.hw).padStart(4)} ${String(m.hl).padStart(4)}` +
      `  ${String(m.l).padStart(4)} ${String(m.p).padStart(4)}` +
      `  ${m.fullWin.toFixed(1).padStart(5)}%  ${m.anyWin.toFixed(1).padStart(5)}%` +
      `   ${m.avgOdds.toFixed(3).padStart(6)}` +
      `  ${('+' + m.avgMove.toFixed(2)).padStart(6)}` +
      `  ${(m.roi >= 0 ? '+' : '') + m.roi.toFixed(1).padStart(5)}%`
    );
  }
  const overallRoi = totN ? totPnl / totN * 100 : 0;
  console.log('─'.repeat(90));
  console.log(
    `${'TOTAL'.padEnd(12)} ${String(totN).padStart(4)}` +
    `  ${String(totW).padStart(4)} ${String(totHW).padStart(4)} ${String(totHL).padStart(4)}` +
    `  ${String(totL).padStart(4)} ${String(totP).padStart(4)}` +
    `  ${(totN ? totW / totN * 100 : 0).toFixed(1).padStart(5)}%` +
    `  ${(totN ? (totW + totHW) / totN * 100 : 0).toFixed(1).padStart(5)}%` +
    `   ${avg(monthly.map(m => m.avgOdds)).toFixed(3).padStart(6)}` +
    `         ${(overallRoi >= 0 ? '+' : '') + overallRoi.toFixed(1).padStart(5)}%`
  );
  console.log(`  σ(ROI monthly): ${std(monthly.map(m => m.roi)).toFixed(1)}%`);

  // ── Outcome breakdown ─────────────────────────────────────────────────────
  const allMatched = fullDb.filter(filterFn);
  const totalPnl   = allMatched.reduce((s, r) => s + computePnl(r), 0);
  const histW      = allMatched.filter(r => classifyResult(r) === 'W').length;
  const wl         = wilsonLower(histW, allMatched.length);

  console.log('\n── P&L by outcome ────────────────────────────────────────────────────────────');
  console.log('  Outcome                              n       %    Avg P&L   Total P&L');
  console.log('  ' + '─'.repeat(68));
  for (const [key, lbl] of [
    ['W',  'Full Win    (under covers fully)    '],
    ['HW', 'Half Win    (quarter-line partial)  '],
    ['P',  'Refund/Push (exact push)            '],
    ['HL', 'Half Loss   (quarter-line partial)  '],
    ['L',  'Full Loss   (over — went above TL)  '],
  ]) {
    const rows = allMatched.filter(r => classifyResult(r) === key);
    const pnl  = rows.reduce((s, r) => s + computePnl(r), 0);
    const ap   = rows.length ? pnl / rows.length : 0;
    const pct  = allMatched.length ? rows.length / allMatched.length * 100 : 0;
    console.log(
      `  ${lbl} ${String(rows.length).padStart(5)}` +
      `  ${pct.toFixed(1).padStart(5)}%` +
      `   ${(ap >= 0 ? '+' : '') + ap.toFixed(3).padStart(7)}` +
      `   ${(pnl >= 0 ? '+' : '') + pnl.toFixed(1).padStart(8)}`
    );
  }
  console.log('  ' + '─'.repeat(68));
  console.log(
    `  ${'TOTAL'.padEnd(37)} ${String(allMatched.length).padStart(5)}` +
    `  100.0%` +
    `   ${(totalPnl / allMatched.length >= 0 ? '+' : '') + (totalPnl / allMatched.length).toFixed(3).padStart(7)}` +
    `   ${(totalPnl >= 0 ? '+' : '') + totalPnl.toFixed(1).padStart(8)}`
  );
  console.log(
    `  Full-win rate: ${(histW / allMatched.length * 100).toFixed(1)}%` +
    `  ·  Avg under odds: ${avg(allMatched.map(r => r.un_c)).toFixed(3)}` +
    `  ·  Safe odds (Wilson): ${wl > 0 ? (1 / wl).toFixed(3) : '—'}`
  );

  // ── By closing TL ─────────────────────────────────────────────────────────
  console.log('\n── By closing Total Line ─────────────────────────────────────────────────────');
  console.log('  tl_c     n       W    W%   AnyW%  Avg un_c   ROI%');
  console.log('  ' + '─'.repeat(55));
  for (const line of [2.00, 2.25, 2.50, 2.75, 3.00, 3.25, 3.50]) {
    const g = allMatched.filter(r => r.tl_c != null && Math.abs(r.tl_c - line) < 0.13);
    if (g.length < 10) continue;
    const gW    = g.filter(r => classifyResult(r) === 'W').length;
    const gAnyW = g.filter(r => ['W','HW'].includes(classifyResult(r))).length;
    const gPnl  = g.reduce((s, r) => s + computePnl(r), 0);
    console.log(
      `  ${line.toFixed(2).padStart(5)}  ${String(g.length).padStart(5)}` +
      `  ${String(gW).padStart(5)}  ${(gW / g.length * 100).toFixed(1).padStart(5)}%` +
      `  ${(gAnyW / g.length * 100).toFixed(1).padStart(5)}%` +
      `   ${avg(g.map(r => r.un_c)).toFixed(3).padStart(6)}` +
      `  ${(gPnl / g.length * 100 >= 0 ? '+' : '') + (gPnl / g.length * 100).toFixed(1).padStart(5)}%`
    );
  }

  // ── By TL steam magnitude ─────────────────────────────────────────────────
  console.log('\n── By TL steam magnitude ─────────────────────────────────────────────────────');
  console.log('  TL move range       n       W    W%    ROI%    Avg un_c');
  console.log('  ' + '─'.repeat(58));
  for (const band of [
    { label: '0.50–0.74 (2-step)', lo: 0.50, hi: 0.75 },
    { label: '0.75–0.99 (3-step)', lo: 0.75, hi: 1.00 },
    { label: '≥ 1.00 (4-step+)',   lo: 1.00, hi: 99   },
  ]) {
    const g = fullDb.filter(r =>
      r.tl_c != null && r.tl_o != null &&
      (r.tl_c - r.tl_o) >= band.lo &&
      (r.tl_c - r.tl_o) <  band.hi
    );
    if (g.length < 10) continue;
    const gW   = g.filter(r => classifyResult(r) === 'W').length;
    const gPnl = g.reduce((s, r) => s + computePnl(r), 0);
    console.log(
      `  ${band.label.padEnd(20)} ${String(g.length).padStart(5)}` +
      `  ${String(gW).padStart(5)}  ${(gW / g.length * 100).toFixed(1).padStart(5)}%` +
      `  ${(gPnl / g.length * 100 >= 0 ? '+' : '') + (gPnl / g.length * 100).toFixed(1).padStart(5)}%` +
      `     ${avg(g.map(r => r.un_c)).toFixed(3).padStart(6)}`
    );
  }

  return { totN, totPnl, overallRoi };
}

// ── Main ───────────────────────────────────────────────────────────────────────
function main() {
  console.log(`\nLoading database from ${DATA_DIR}…`);
  const rawDb  = loadDatabase(DATA_DIR);
  const fullDb = applyTier(rawDb, LEAGUE_TIER);
  // Only rows where we have TL data
  const tlDb   = fullDb.filter(r => r.tl_c != null && r.tl_o != null && r.un_c != null);
  console.log(`Total rows: ${rawDb.length}  (tier filter: ${fullDb.length}  ·  with TL data: ${tlDb.length})`);

  for (const { steps, lo } of [
    { steps: '2-step', lo: 0.50 },
    { steps: '3-step', lo: 0.75 },
  ]) {
    const steamFn = r => (r.tl_c - r.tl_o) >= lo;

    console.log('\n\n' + '█'.repeat(90));
    console.log(`█  TL STEAM ≥ ${lo.toFixed(2)} (${steps})  ·  tier=${LEAGUE_TIER}  →  BET UNDER closing TL`);
    console.log('█'.repeat(90));

    // Overall
    const resAll = printSection(tlDb, `ALL matches — TL up ≥ ${lo.toFixed(2)}`, steamFn);

    // Split by fav_side
    const resHome = printSection(
      tlDb,
      `HOME fav  ·  TL up ≥ ${lo.toFixed(2)}  (home team is favourite)`,
      r => steamFn(r) && r.fav_side === 'HOME'
    );
    const resAway = printSection(
      tlDb,
      `AWAY fav  ·  TL up ≥ ${lo.toFixed(2)}  (away team is favourite)`,
      r => steamFn(r) && r.fav_side === 'AWAY'
    );

    if (resHome && resAway) {
      console.log('\n── Side split summary ────────────────────────────────────────────────────────');
      console.log(`  Home fav context: n=${resHome.totN}  ROI=${resHome.overallRoi >= 0 ? '+' : ''}${resHome.overallRoi.toFixed(1)}%`);
      console.log(`  Away fav context: n=${resAway.totN}  ROI=${resAway.overallRoi >= 0 ? '+' : ''}${resAway.overallRoi.toFixed(1)}%`);
    }
  }

  console.log('');
}

main();
