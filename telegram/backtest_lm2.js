'use strict';
// ── AH Line Moves 2 Steps Toward Fav → Bet Dog AH Cover ───────────────────────
//
// Condition: closing AH line is ≥ 0.50 deeper than opening (fav_lc - fav_lo ≥ 0.45)
// Bet: underdog covers the AH at closing odds (dog_oc)
//
// P&L per unit staked (handles quarter-line half results):
//   ah2h = fav_2h - dog_2h - fav_line
//   ah2h < -0.26  → full dog win:  profit = dog_oc - 1
//   ah2h < -0.01  → half dog win:  profit = 0.5 * (dog_oc - 1)
//   |ah2h| ≤ 0.01 → push:          profit = 0
//   ah2h >  0.01  → half dog loss: profit = -0.5
//   ah2h >  0.26  → full dog loss: profit = -1
//
// Usage:
//   node backtest_lm2.js          — TOP+MAJOR filter
//   node backtest_lm2.js --all    — all leagues
//   node backtest_lm2.js --exact  — exactly 2 steps (0.45–0.55 only)
//   node backtest_lm2.js --min1   — at least 1 step (≥ 0.20) for comparison

const path = require('path');
const { loadDatabase } = require('./engine');

const LEAGUE_TIER = process.argv.includes('--all') ? 'ALL' : 'TOP+MAJOR';
const DATA_DIR    = path.resolve(__dirname, '../static/data');

// Movement thresholds
const MODE_EXACT = process.argv.includes('--exact'); // exactly 2 steps: 0.45–0.55
const MODE_MIN1  = process.argv.includes('--min1');  // at least 1 step: ≥ 0.20

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

// Build the main filter based on CLI flags
function buildFilter() {
  if (MODE_EXACT) {
    // Exactly 2 steps: movement between 0.45 and 0.55
    return r => r.fav_lo != null && (r.fav_lc - r.fav_lo) >= 0.45 && (r.fav_lc - r.fav_lo) <= 0.55;
  }
  if (MODE_MIN1) {
    // At least 1 step: movement ≥ 0.20
    return r => r.fav_lo != null && (r.fav_lc - r.fav_lo) >= 0.20;
  }
  // Default: at least 2 steps (≥ 0.45)
  return r => r.fav_lo != null && (r.fav_lc - r.fav_lo) >= 0.45;
}

// Compute P&L per unit for dog AH cover
function computePnl(r) {
  const ah2h = r.fav_2h - r.dog_2h - r.fav_line;
  if      (ah2h < -0.26) return r.dog_oc - 1;         // full dog win
  else if (ah2h < -0.01) return 0.5 * (r.dog_oc - 1); // half dog win (quarter line push)
  else if (ah2h >  0.26) return -1;                    // full dog loss
  else if (ah2h >  0.01) return -0.5;                  // half dog loss (quarter line fav by 1)
  else                   return 0;                     // exact push (level lines)
}

// Win = full win only; halfWin = half dog win; push; halfLoss; loss
function classifyResult(r) {
  const ah2h = r.fav_2h - r.dog_2h - r.fav_line;
  if      (ah2h < -0.26) return 'W';
  else if (ah2h < -0.01) return 'HW';
  else if (ah2h >  0.26) return 'L';
  else if (ah2h >  0.01) return 'HL';
  else                   return 'P';
}

// ── Main ───────────────────────────────────────────────────────────────────────
function main() {
  const modeLabel = MODE_EXACT ? 'EXACTLY 2 steps (0.45–0.55)'
                  : MODE_MIN1  ? 'at least 1 step (≥ 0.20)'
                               : 'at least 2 steps (≥ 0.45)';

  console.log(`\nLoading database from ${DATA_DIR}…`);
  const rawDb  = loadDatabase(DATA_DIR);
  const fullDb = applyTier(rawDb, LEAGUE_TIER);
  console.log(`Total rows: ${rawDb.length}  (after tier filter: ${fullDb.length})\n`);

  const filter = buildFilter();

  console.log('═'.repeat(90));
  console.log(`LINE STEAM → DOG AH COVER BACKTEST  (tier=${LEAGUE_TIER}  ·  movement: ${modeLabel})`);
  console.log('  Bet: dog covers pre-match AH line at closing odds (dog_oc)');
  console.log('  Evaluation: out-of-sample per month (12 months), then overall');
  console.log('═'.repeat(90));

  // ── Month-by-month out-of-sample ───────────────────────────────────────────
  let totN = 0, totW = 0, totHW = 0, totHL = 0, totL = 0, totP = 0;
  let totPnl = 0;
  const monthly = [];

  for (const { label, name } of MONTHS) {
    const testRows = fullDb.filter(r => r.file_label.includes(label));
    if (!testRows.length) continue;

    const matched = testRows.filter(filter);
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

    const n       = matched.length;
    const fullWin = w / n * 100;
    const anyWin  = (w + hw) / n * 100;  // W + HW (dog covered at least half)
    const avgOdds = avg(matched.map(r => r.dog_oc));
    const roi     = pnl / n * 100;
    const avgMove = avg(matched.map(r => r.fav_lc - r.fav_lo));

    totN   += n;  totW += w; totHW += hw; totHL += hl; totL += l; totP += p;
    totPnl += pnl;
    monthly.push({ name, n, w, hw, hl, l, p, pnl, fullWin, anyWin, avgOdds, roi, avgMove });
  }

  // ── Print month-by-month table ─────────────────────────────────────────────
  console.log('\n── Out-of-sample results by month ────────────────────────────────────────────');
  console.log(
    'Month        n     W    HW    HL     L    P   Win%  AnyW%   Avg odds   Avg lm    ROI%'
  );
  console.log('─'.repeat(90));
  for (const m of monthly) {
    console.log(
      `${m.name.padEnd(12)} ${String(m.n).padStart(4)}  ${String(m.w).padStart(4)} ${String(m.hw).padStart(4)} ` +
      `${String(m.hl).padStart(4)} ${String(m.l).padStart(5)} ${String(m.p).padStart(4)}` +
      `  ${m.fullWin.toFixed(1).padStart(5)}%` +
      `  ${m.anyWin.toFixed(1).padStart(5)}%` +
      `   ${m.avgOdds.toFixed(3).padStart(7)}` +
      `   ${('+' + m.avgMove.toFixed(2)).padStart(6)}` +
      `   ${(m.roi >= 0 ? '+' : '') + m.roi.toFixed(1).padStart(5)}%`
    );
  }

  const overallRoi    = totN ? totPnl / totN * 100 : 0;
  const overallWin    = totN ? totW / totN * 100 : 0;
  const overallAnyWin = totN ? (totW + totHW) / totN * 100 : 0;
  const roiArr        = monthly.map(m => m.roi);

  console.log('─'.repeat(90));
  console.log(
    `${'TOTAL'.padEnd(12)} ${String(totN).padStart(4)}  ${String(totW).padStart(4)} ${String(totHW).padStart(4)} ` +
    `${String(totHL).padStart(4)} ${String(totL).padStart(5)} ${String(totP).padStart(4)}` +
    `  ${overallWin.toFixed(1).padStart(5)}%` +
    `  ${overallAnyWin.toFixed(1).padStart(5)}%` +
    `   ${avg(monthly.map(m => m.avgOdds)).toFixed(3).padStart(7)}` +
    `         ${(overallRoi >= 0 ? '+' : '') + overallRoi.toFixed(1).padStart(5)}%`
  );
  console.log(`  σ(ROI monthly): ${std(roiArr).toFixed(1)}%`);

  // ── Full-history baseline (all months combined) ────────────────────────────
  const allMatched = fullDb.filter(filter);
  const histHits   = allMatched.filter(r => !r.ahCover).length;  // dog wins or pushes
  const histFullW  = allMatched.filter(r => classifyResult(r) === 'W').length;
  const wl = wilsonLower(histFullW, allMatched.length);
  const fairOdds = histFullW > 0 ? allMatched.length / histFullW : null;
  const safeOdds = wl > 0 ? 1 / wl : null;

  console.log('\n── Full-history stats (all months) ───────────────────────────────────────────');
  console.log(`  Total matched: ${allMatched.length}`);
  console.log(`  Full-win rate: ${(histFullW / allMatched.length * 100).toFixed(1)}% (${histFullW}/${allMatched.length})`);
  console.log(`  Dog wins/pushes: ${(histHits / allMatched.length * 100).toFixed(1)}% (${histHits}/${allMatched.length})`);
  if (fairOdds) console.log(`  Fair odds: ${fairOdds.toFixed(3)}  ·  Safe odds (Wilson CI): ${safeOdds ? safeOdds.toFixed(3) : '—'}`);

  // ── Breakdown by closing AH line ──────────────────────────────────────────
  console.log('\n── Breakdown by closing AH line ──────────────────────────────────────────────');
  console.log('  fav_line    n       W    W%   AnyW%   Avg dog_oc    ROI%');
  console.log('  ' + '─'.repeat(65));

  const lines = [0.25, 0.50, 0.75, 1.00, 1.25, 1.50];
  for (const line of lines) {
    const group = allMatched.filter(r => Math.abs(r.fav_line - line) < 0.13);
    if (!group.length) continue;

    const gW     = group.filter(r => classifyResult(r) === 'W').length;
    const gAnyW  = group.filter(r => ['W', 'HW'].includes(classifyResult(r))).length;
    const gPnl   = group.reduce((s, r) => s + computePnl(r), 0);
    const gAvgOc = avg(group.map(r => r.dog_oc));
    const gRoi   = gPnl / group.length * 100;

    console.log(
      `  ${('−' + line.toFixed(2)).padStart(7)}   ${String(group.length).padStart(5)}` +
      `  ${String(gW).padStart(5)}  ${(gW / group.length * 100).toFixed(1).padStart(5)}%` +
      `  ${(gAnyW / group.length * 100).toFixed(1).padStart(5)}%` +
      `     ${gAvgOc.toFixed(3).padStart(6)}` +
      `    ${(gRoi >= 0 ? '+' : '') + gRoi.toFixed(1).padStart(5)}%`
    );
  }

  // ── Breakdown by opening → closing transition ─────────────────────────────
  console.log('\n── Breakdown by line transition (open → close) ───────────────────────────────');
  console.log('  Transition         n       W    W%   AnyW%   ROI%');
  console.log('  ' + '─'.repeat(55));

  // Group by rounded (fav_lo_snapped → fav_line)
  const transitions = {};
  for (const r of allMatched) {
    const VALID = [0.00, 0.25, 0.50, 0.75, 1.00, 1.25, 1.50];
    const openSnap = VALID.find(v => Math.abs(r.fav_lo - v) < 0.13);
    if (openSnap === undefined) continue;
    const key = `${openSnap.toFixed(2)} → ${r.fav_line.toFixed(2)}`;
    if (!transitions[key]) transitions[key] = [];
    transitions[key].push(r);
  }

  const sorted = Object.entries(transitions)
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 15); // top 15 by count

  for (const [key, group] of sorted) {
    if (group.length < 10) continue;
    const gW    = group.filter(r => classifyResult(r) === 'W').length;
    const gAnyW = group.filter(r => ['W', 'HW'].includes(classifyResult(r))).length;
    const gPnl  = group.reduce((s, r) => s + computePnl(r), 0);
    const gRoi  = gPnl / group.length * 100;

    console.log(
      `  ${key.padEnd(20)} ${String(group.length).padStart(5)}` +
      `  ${String(gW).padStart(5)}  ${(gW / group.length * 100).toFixed(1).padStart(5)}%` +
      `  ${(gAnyW / group.length * 100).toFixed(1).padStart(5)}%` +
      `   ${(gRoi >= 0 ? '+' : '') + gRoi.toFixed(1).padStart(5)}%`
    );
  }

  // ── Sensitivity: effect of steam size ────────────────────────────────────
  console.log('\n── Sensitivity: dog ROI by steam magnitude ───────────────────────────────────');
  console.log('  Movement range      n       W    W%    ROI%    Avg dog_oc');
  console.log('  ' + '─'.repeat(60));

  const steamBands = [
    { label: '0.20–0.29', lo: 0.20, hi: 0.30 },
    { label: '0.30–0.39', lo: 0.30, hi: 0.40 },
    { label: '0.40–0.49', lo: 0.40, hi: 0.50 },
    { label: '0.45–0.55 (2-step)', lo: 0.45, hi: 0.55 },
    { label: '0.50–0.59', lo: 0.50, hi: 0.60 },
    { label: '0.60–0.74', lo: 0.60, hi: 0.75 },
    { label: '≥ 0.75',   lo: 0.75, hi: 99   },
  ];
  // For this we use the full unfiltered db (respecting tier)
  for (const band of steamBands) {
    const group = fullDb.filter(r =>
      r.fav_lo != null &&
      (r.fav_lc - r.fav_lo) >= band.lo &&
      (r.fav_lc - r.fav_lo) <  band.hi
    );
    if (group.length < 20) continue;
    const gW    = group.filter(r => classifyResult(r) === 'W').length;
    const gPnl  = group.reduce((s, r) => s + computePnl(r), 0);
    const gRoi  = gPnl / group.length * 100;
    const gAvgOc = avg(group.map(r => r.dog_oc));

    console.log(
      `  ${band.label.padEnd(20)} ${String(group.length).padStart(5)}` +
      `  ${String(gW).padStart(5)}  ${(gW / group.length * 100).toFixed(1).padStart(5)}%` +
      `  ${(gRoi >= 0 ? '+' : '') + gRoi.toFixed(1).padStart(5)}%` +
      `     ${gAvgOc.toFixed(3).padStart(6)}`
    );
  }

  console.log('');
}

main();
