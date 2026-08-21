'use strict';
// ── Under 1.5 2H at HT — fav leading by 1 goal ───────────────────────────────
//
// Hypothesis: when the favourite leads by exactly 1 goal at HT in a game with
// a low-to-medium total line, the 2nd half tends to be defended = under 1.5 2H.
//
// Signals tested:
//   - Fav leading margin at HT (exactly +1)
//   - AH closing line range (0.00–0.50, 0.25–1.00, etc.)
//   - TL closing range (≤ 2.50, ≤ 2.75, ≤ 3.00)
//   - AH steam (fav_lc - fav_lo) — does steam add anything?
//
// Usage:
//   node backtest_under15ht.js          — TOP+MAJOR
//   node backtest_under15ht.js --all    — all leagues

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
  if (tier === 'ALL') return db;
  if (tier === 'TOP+MAJOR') return db.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
  return db.filter(r => r.league_tier === tier);
}

function wilsonLower(hits, n, z = 1.645) {
  if (!n) return 0;
  const p = hits / n;
  const d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return Math.max(0, c - m);
}

function avg(arr)  { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr)  {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function pct(h, n) { return n ? (h / n * 100) : 0; }

// ── Evaluate rule across all months (walk-forward OOS) ────────────────────────
function evalRule(fullDb, filterFn, betKey) {
  const monthly = [];
  let totN = 0, totHits = 0;
  let allHistN = 0, allHistHits = 0;

  for (const { label, name } of MONTHS) {
    const testRows = fullDb.filter(r =>  r.file_label.includes(label));
    const histRows = fullDb.filter(r => !r.file_label.includes(label));
    if (!testRows.length) continue;

    const testMatches = testRows.filter(filterFn);
    const histMatches = histRows.filter(filterFn);
    if (!testMatches.length) continue;

    const hits     = testMatches.filter(r => r[betKey] === true).length;
    const hitPct   = pct(hits, testMatches.length);
    const histHits = histMatches.filter(r => r[betKey] === true).length;
    const histPct  = pct(histHits, histMatches.length);

    monthly.push({ name, n: testMatches.length, hits, hitPct, histN: histMatches.length, histPct });
    totN    += testMatches.length;
    totHits += hits;
    allHistN    += histMatches.length;
    allHistHits += histHits;
  }

  const overallHitPct  = pct(totHits, totN);
  const overallHistPct = pct(allHistHits, allHistN);
  const wlLower        = wilsonLower(totHits, totN);
  const fairOdds       = overallHitPct > 0 ? 100 / overallHitPct : null;
  const safeOdds       = wlLower > 0 ? 1 / wlLower : null;
  const monthHits      = monthly.map(m => m.hitPct);

  return {
    totN, totHits, overallHitPct, overallHistPct,
    fairOdds, safeOdds,
    stdDev: std(monthHits),
    monthly,
  };
}

// ── Print rule ──────────────────────────────────────────────────────────────────
function printRule(name, res) {
  if (!res.totN) { console.log(`  ${name}  — no data\n`); return; }

  const edge     = res.overallHitPct - res.overallHistPct;
  const beOdds   = res.overallHitPct > 0 ? (100 / res.overallHitPct).toFixed(2) : '—';
  const safeStr  = res.safeOdds ? res.safeOdds.toFixed(2) : '—';
  const profStr  = res.safeOdds && res.overallHitPct > 0
    ? (1 / (res.overallHitPct / 100) <= res.safeOdds ? '  ← PROFITABLE @ safe odds' : '')
    : '';

  console.log(`\n  ${name}`);
  console.log(`    n=${res.totN}  hit=${res.overallHitPct.toFixed(1)}%  hist=${res.overallHistPct.toFixed(1)}%  edge=${(edge >= 0 ? '+' : '')}${edge.toFixed(1)}pp  σ=${res.stdDev.toFixed(1)}%`);
  console.log(`    Fair odds: ${res.fairOdds ? res.fairOdds.toFixed(2) : '—'}   Safe odds: ${safeStr}   BE odds: ${beOdds}${profStr}`);

  const monthLine = res.monthly.map(m =>
    `${m.name.slice(0, 3)}'${m.name.slice(-2)}:${m.hitPct.toFixed(0)}%`
  ).join('  ');
  console.log(`    By month:  ${monthLine}`);
}

// ── Main ───────────────────────────────────────────────────────────────────────
function main() {
  console.log(`\nLoading database from ${DATA_DIR}…`);
  const rawDb  = loadDatabase(DATA_DIR);
  const fullDb = applyTier(rawDb, LEAGUE_TIER);
  console.log(`Total: ${rawDb.length} rows  |  After tier filter (${LEAGUE_TIER}): ${fullDb.length}\n`);

  console.log('═'.repeat(90));
  console.log('UNDER 1.5 2H at HT  —  fav leading +1  ·  12-month walk-forward OOS');
  console.log(`League tier: ${LEAGUE_TIER}  |  Bet: under15_2H  (≤1 goal in 2nd half)`);
  console.log('═'.repeat(90));

  // ── 1. Baseline: fav leads by exactly +1, any AH, any TL ─────────────────────
  console.log('\n━━ Section 1: Baseline (fav +1 at HT, no AH/TL filter) ─────────────────────');

  const base = evalRule(fullDb,
    r => r.fav_ht != null && r.dog_ht != null && (r.fav_ht - r.dog_ht) === 1,
    'under15_2H'
  );
  printRule('All  (fav +1, any AH, any TL)', base);

  // ── 2. AH range breakdown ─────────────────────────────────────────────────────
  console.log('\n━━ Section 2: AH line breakdown (fav +1 at HT) ─────────────────────────────');

  for (const [label, lo, hi] of [
    ['AH 0.00–0.50  (level–small fav)',  0.00, 0.50],
    ['AH 0.25–0.75  (small fav)',        0.25, 0.75],
    ['AH 0.50–1.00  (moderate fav)',     0.50, 1.00],
    ['AH 0.25–1.00  (small–mod fav)',    0.25, 1.00],
    ['AH ≥ 1.00     (strong fav)',       1.00, 99.0],
  ]) {
    const res = evalRule(fullDb,
      r => r.fav_ht != null && r.dog_ht != null && (r.fav_ht - r.dog_ht) === 1 &&
           r.fav_lc >= lo - 0.01 && r.fav_lc <= hi + 0.01,
      'under15_2H'
    );
    printRule(label, res);
  }

  // ── 3. TL filter breakdown (AH 0.25–1.00 as base) ────────────────────────────
  console.log('\n━━ Section 3: TL filter breakdown (fav +1, AH 0.25–1.00) ───────────────────');

  for (const [label, tlMax] of [
    ['TL ≤ 2.50', 2.50], ['TL ≤ 2.75', 2.75], ['TL ≤ 3.00', 3.00],
    ['TL ≥ 2.75', null], ['TL ≥ 3.00 (high scoring)', null],
  ]) {
    const tlFilter = tlMax != null
      ? r => r.tl_c != null && r.tl_c <= tlMax
      : label.includes('3.00')
        ? r => r.tl_c != null && r.tl_c >= 3.00
        : r => r.tl_c != null && r.tl_c >= 2.75;

    const res = evalRule(fullDb,
      r => r.fav_ht != null && r.dog_ht != null && (r.fav_ht - r.dog_ht) === 1 &&
           r.fav_lc >= 0.24 && r.fav_lc <= 1.01 && tlFilter(r),
      'under15_2H'
    );
    printRule(label, res);
  }

  // ── 4. Best combo: AH 0.25–1.00, TL ≤ 2.75, with/without steam ──────────────
  console.log('\n━━ Section 4: Best combo — AH 0.25–1.00, TL ≤ 2.75 (+/- steam) ─────────────');

  const bestBase = evalRule(fullDb,
    r => r.fav_ht != null && r.dog_ht != null && (r.fav_ht - r.dog_ht) === 1 &&
         r.fav_lc >= 0.24 && r.fav_lc <= 1.01 &&
         r.tl_c != null && r.tl_c <= 2.75,
    'under15_2H'
  );
  printRule('AH 0.25–1.00  TL ≤ 2.75  (no steam filter)', bestBase);

  const bestSteam = evalRule(fullDb,
    r => r.fav_ht != null && r.dog_ht != null && (r.fav_ht - r.dog_ht) === 1 &&
         r.fav_lc >= 0.24 && r.fav_lc <= 1.01 &&
         r.tl_c != null && r.tl_c <= 2.75 &&
         r.fav_lo != null && r.fav_lc >= r.fav_lo + 0.13,  // fav steamed
    'under15_2H'
  );
  printRule('AH 0.25–1.00  TL ≤ 2.75  + AH steam (fav_lc > fav_lo + 0.13)', bestSteam);

  const bestTlUp = evalRule(fullDb,
    r => r.fav_ht != null && r.dog_ht != null && (r.fav_ht - r.dog_ht) === 1 &&
         r.fav_lc >= 0.24 && r.fav_lc <= 1.01 &&
         r.tl_c != null && r.tl_c <= 2.75 &&
         r.tl_o != null && r.tl_c <= r.tl_o - 0.13,  // TL shrank (market expects FEWER goals)
    'under15_2H'
  );
  printRule('AH 0.25–1.00  TL ≤ 2.75  + TL shrank (market lowered goal expectation)', bestTlUp);

  // ── 5. Alternative bets for the same scenario ─────────────────────────────────
  console.log('\n━━ Section 5: Alternative bets — same filter (AH 0.25–1.00, TL ≤ 2.75, fav +1) ─');
  const coreFilter = r =>
    r.fav_ht != null && r.dog_ht != null && (r.fav_ht - r.dog_ht) === 1 &&
    r.fav_lc >= 0.24 && r.fav_lc <= 1.01 &&
    r.tl_c != null && r.tl_c <= 2.75;

  for (const [betKey, label] of [
    ['under15_2H',  'Under 1.5 2H'],
    ['under05_2H',  'Under 0.5 2H  (0-0 in 2H)'],
    ['over15_2H',   'Over 1.5 2H'],
    ['over05_2H',   'Over 0.5 2H'],
    ['ahCover',     'Fav covers AH'],
    ['favScored2H', 'Fav scores in 2H'],
    ['under25FT',   'Under 2.5 FT  (useful FT proxy)'],
  ]) {
    const res = evalRule(fullDb, coreFilter, betKey);
    if (!res.totN) continue;
    const edge   = res.overallHitPct - res.overallHistPct;
    const be     = res.overallHitPct > 0 ? (100 / res.overallHitPct).toFixed(2) : '—';
    const safe   = res.safeOdds ? res.safeOdds.toFixed(2) : '—';
    const σ      = res.stdDev.toFixed(1);
    console.log(`  ${betKey.padEnd(16)} n=${String(res.totN).padStart(4)}  hit=${res.overallHitPct.toFixed(1).padStart(5)}%  edge=${(edge >= 0 ? '+' : '') + edge.toFixed(1).padStart(5)}pp  σ=${σ}%  BE=${be.padStart(5)}  safe=${safe.padStart(5)}`);
  }

  // ── 6. Profitability summary ───────────────────────────────────────────────────
  console.log('\n━━ Section 6: Profitability — Under 1.5 2H @ HT (best combo) ──────────────');
  console.log('   At HT 1-0 (fav leading), in-play Under 1.5 2H typical market odds:');
  console.log('   TL 2.25: ~1.55–1.65  |  TL 2.50: ~1.65–1.75  |  TL 2.75: ~1.70–1.85\n');

  const { overallHitPct: h, safeOdds: safe, fairOdds: fair, totN: n } = bestBase;
  const wlLo = wilsonLower(bestBase.totHits, n) * 100;

  console.log(`  Hit rate (12m OOS)    : ${h.toFixed(1)}%  (95% CI lower: ~${wlLo.toFixed(1)}%)`);
  console.log(`  Break-even odds       : ${(100 / h).toFixed(2)}`);
  console.log(`  Safe odds (Wilson CI) : ${safe ? safe.toFixed(2) : '—'}`);

  for (const odds of [1.60, 1.65, 1.70, 1.75, 1.80, 1.85]) {
    const req    = 100 / odds;
    const margin = h - req;
    const pnl    = (h / 100) * (odds - 1) - (1 - h / 100);
    const roi    = pnl * 100;
    const verdict = roi > 0 ? `+${roi.toFixed(1)}% ROI  PROFITABLE` : `${roi.toFixed(1)}% ROI  deficit`;
    console.log(`  @ odds ${odds.toFixed(2)}  need ${req.toFixed(1)}%  →  ${verdict}  (${(margin >= 0 ? '+' : '') + margin.toFixed(1)}pp)`);
  }

  console.log('');
  console.log('  ★  This strategy fires at HT interval (~min 44–50).');
  console.log('     Trigger conditions: live score shows fav leads by exactly 1 goal,');
  console.log('     pre-match AH was 0.25–1.00, TL closing was ≤ 2.75.');
  console.log('     The "In-play Under 1.5 2H" market must be available and above break-even.');
  console.log('');
}

main();
