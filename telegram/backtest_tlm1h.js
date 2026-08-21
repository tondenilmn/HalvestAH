'use strict';
// ── Strategy 3 backtest: TLM=IN + TL ≥ 2.5 + still 0-0 at ~25–32' → Over 0.5 1H
//
// Problem: CSV data has HT/FT scores only — no minute-by-minute timestamps.
// The strategy fires at 25–32' when the match is still 0-0. We can't directly
// filter for "0-0 at minute 25" in historical data.
//
// Approach:
//   Direct measurement  — over05_1H rate for all TL-condition-filtered matches
//                         (upper bound: includes matches where goal came before 25')
//   Conditional estimate — adjusts for the fact that only 0-0 matches at minute M
//                          trigger the alert, using a uniform goal-timing model:
//
//     hit_rate ≈ [over05_1H% × (45-M)/45] / [under05_1H% + over05_1H% × (45-M)/45]
//
//   where M = alert midpoint (default 28.5' = midpoint of 25–32 window).
//
// Usage:
//   node backtest_tlm1h.js           — TOP+MAJOR, current config thresholds
//   node backtest_tlm1h.js --all     — all leagues
//   node backtest_tlm1h.js --wide    — also test relaxed params (TL 2.0+, steam 0.13)

const path   = require('path');
const { loadDatabase, wilsonCI } = require('./engine');

const LEAGUE_TIER = process.argv.includes('--all') ? 'ALL' : 'TOP+MAJOR';
const WIDE        = process.argv.includes('--wide');
const DATA_DIR    = path.resolve(__dirname, '../static/data');

// ── Config (mirrors notify.js defaults) ──────────────────────────────────────
const ALERT_MIDPOINT = 28.5;         // midpoint of 25–32' window
const FRAC_AFTER     = (45 - ALERT_MIDPOINT) / 45; // ≈ 0.367

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

// ── Helpers ───────────────────────────────────────────────────────────────────
function applyTier(db, tier) {
  if (tier === 'ALL') return db;
  if (tier === 'TOP+MAJOR') return db.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
  if (tier === 'TOP')       return db.filter(r => r.league_tier === 'TOP');
  return db;
}

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

// Conditional hit rate: given 0-0 at minute M, what % end with a 1H goal?
// Uses uniform goal-timing approximation.
function conditionalHitRate(over05Rate, fracAfter) {
  const p   = over05Rate / 100;
  const q   = 1 - p;           // under05_1H rate
  const win = p * fracAfter;   // P(goal in remaining 1H)
  const denom = q + win;       // P(0-0 at minute M) = no goal ever + goal came late
  if (denom <= 0) return 0;
  return (win / denom) * 100;
}

// Break-even odds = 1 / hit_rate
function breakEven(pct) { return pct > 0 ? (100 / pct).toFixed(2) : '—'; }

// Safe min odds = 1 / Wilson CI lower bound (95%)
function safeOdds(hits, n) {
  if (!n) return '—';
  const [lo] = wilsonCI(hits / n * 100, n);
  return lo > 0 ? (100 / lo).toFixed(2) : '—';
}

// ── Evaluate one variant across months ────────────────────────────────────────
function evalVariant(fullDb, filterFn, fracAfter) {
  const monthly = [];
  let totN = 0, totOver = 0, totUnder = 0;

  for (const { label, name } of MONTHS) {
    const testRows = fullDb.filter(r =>  r.file_label.includes(label));
    if (!testRows.length) continue;

    const testFiltered = testRows.filter(filterFn);
    if (!testFiltered.length) continue;

    const nOver  = testFiltered.filter(r => r.over05_1H).length;
    const nUnder = testFiltered.length - nOver;
    const directPct = nOver / testFiltered.length * 100;
    const condPct   = conditionalHitRate(directPct, fracAfter);

    monthly.push({ name, n: testFiltered.length, nOver, nUnder, directPct, condPct });
    totN     += testFiltered.length;
    totOver  += nOver;
    totUnder += nUnder;
  }

  const directPct = totN ? totOver / totN * 100 : 0;
  const condPct   = conditionalHitRate(directPct, fracAfter);
  const condHits  = Math.round(totOver * fracAfter);   // estimated wins (goals after M')

  return { totN, totOver, totUnder, directPct, condPct, condHits, monthly };
}

// ── Print variant ──────────────────────────────────────────────────────────────
function printVariant(label, res, fracAfter) {
  const { totN, totOver, totUnder, directPct, condPct, condHits, monthly } = res;
  if (!totN) { console.log(`  ${label}  — no data\n`); return; }

  const condN   = Math.round(totUnder + totOver * fracAfter); // estimated fired matches
  const beOdds  = breakEven(condPct);
  const safe    = safeOdds(condHits, condN);
  const stdDev  = std(monthly.map(m => m.condPct));
  const monthLine = monthly.map(m => {
    const v = m.condPct.toFixed(0).padStart(3);
    return `${m.name.slice(0, 3)}'${m.name.slice(-2)}:${v}%`;
  }).join('  ');

  console.log(`\n${label}`);
  console.log(`  Filtered matches (all 1H)     : ${totN}  (over05_1H: ${totOver}  goalless: ${totUnder})`);
  console.log(`  Direct over05_1H rate         : ${directPct.toFixed(1)}%  (upper bound — incl. early-goal matches)`);
  console.log(`  ─── Conditional on 0-0 at ${ALERT_MIDPOINT.toFixed(0)}' ───────────────────────────`);
  console.log(`  Estimated fired matches       : ~${condN}  (${(condN / totN * 100).toFixed(0)}% of filtered)`);
  console.log(`  Estimated hit rate            : ${condPct.toFixed(1)}%  (σ = ${stdDev.toFixed(1)}% month-to-month)`);
  console.log(`  Break-even odds               : ${beOdds}  (need odds > this to profit)`);
  console.log(`  Conservative safe odds        : ${safe}  (Wilson CI lower bound)`);
  console.log(`  By month (conditional est.):  ${monthLine}`);
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  console.log(`\nLoading database from ${DATA_DIR}…`);
  const rawDb  = loadDatabase(DATA_DIR);
  const fullDb = applyTier(rawDb, LEAGUE_TIER);
  console.log(`Total rows: ${rawDb.length}  after tier filter (${LEAGUE_TIER}): ${fullDb.length}\n`);

  // Rows with TL data
  const hasTl = fullDb.filter(r => r.tl_c != null && r.tl_o != null);
  console.log(`Rows with TL data: ${hasTl.length}  (${(hasTl.length / fullDb.length * 100).toFixed(0)}% of tier-filtered DB)\n`);

  console.log('═'.repeat(80));
  console.log(`STRATEGY 3 BACKTEST  —  TLM=IN + TL ≥ X + 0-0 at ~${ALERT_MIDPOINT.toFixed(0)}' → Over 0.5 1H`);
  console.log(`League tier: ${LEAGUE_TIER}  |  Goal-timing model: uniform (${(FRAC_AFTER * 100).toFixed(0)}% of goals after ${ALERT_MIDPOINT.toFixed(0)}')`);
  console.log('═'.repeat(80));

  // ── Section 1: Current config (TL ≥ 2.5, steam ≥ 0.25) ─────────────────────
  console.log('\n━━ Section 1: Current config (notify.js defaults) ─────────────────────────');
  console.log('   TL closing ≥ 2.5  +  TL steam ≥ 0.25  (tl_c - tl_o)');

  const cfgFilter = r =>
    r.tl_c >= 2.5 && (r.tl_c - r.tl_o) >= 0.25;
  const cfgRes = evalVariant(hasTl, cfgFilter, FRAC_AFTER);
  printVariant('TL ≥ 2.5  steam ≥ 0.25', cfgRes, FRAC_AFTER);

  // Breakdown by TL cluster
  console.log('\n  ─── TL cluster breakdown (same steam ≥ 0.25) ────────────────────────────');
  for (const [clLabel, [lo, hi]] of [['TL 2.5–3.0', [2.5, 3.0]], ['TL ≥ 3.0', [3.0, null]]]) {
    const f = r => r.tl_c >= lo && (hi == null || r.tl_c < hi) && (r.tl_c - r.tl_o) >= 0.25;
    const res = evalVariant(hasTl, f, FRAC_AFTER);
    if (res.totN < 50) { console.log(`  ${clLabel}: insufficient data (n=${res.totN})`); continue; }
    const condN = Math.round(res.totUnder + res.totOver * FRAC_AFTER);
    console.log(`  ${clLabel.padEnd(14)}  n=${res.totN}  direct=${res.directPct.toFixed(1)}%  cond=${res.condPct.toFixed(1)}%  BE=${breakEven(res.condPct)}  safe=${safeOdds(res.condHits, condN)}  σ=${std(res.monthly.map(m => m.condPct)).toFixed(1)}%`);
  }

  // ── Section 2: Baseline (TL ≥ 2.5, no steam requirement) ────────────────────
  console.log('\n━━ Section 2: Baseline — same TL range, NO steam requirement ──────────────');
  const blFilter = r => r.tl_c >= 2.5;
  const blRes = evalVariant(hasTl, blFilter, FRAC_AFTER);
  printVariant('TL ≥ 2.5  (all, no steam)', blRes, FRAC_AFTER);
  console.log(`\n  Signal edge (steam vs no-steam): ${(cfgRes.condPct - blRes.condPct) >= 0 ? '+' : ''}${(cfgRes.condPct - blRes.condPct).toFixed(1)}pp`);

  // ── Section 3: Steam sensitivity ─────────────────────────────────────────────
  console.log('\n━━ Section 3: Steam threshold sensitivity ─────────────────────────────────');
  console.log('   TL ≥ 2.5, varying steam minimum\n');
  for (const steam of [0.13, 0.25, 0.50]) {
    const f   = r => r.tl_c >= 2.5 && (r.tl_c - r.tl_o) >= steam;
    const res = evalVariant(hasTl, f, FRAC_AFTER);
    if (!res.totN) continue;
    const condN   = Math.round(res.totUnder + res.totOver * FRAC_AFTER);
    const stdDev  = std(res.monthly.map(m => m.condPct));
    console.log(`  steam ≥ ${steam.toFixed(2)}  n=${res.totN}  direct=${res.directPct.toFixed(1)}%  cond=${res.condPct.toFixed(1)}%  BE=${breakEven(res.condPct)}  safe=${safeOdds(res.condHits, condN)}  σ=${stdDev.toFixed(1)}%`);
  }

  // ── Section 4: Wide params (--wide flag) ──────────────────────────────────────
  if (WIDE) {
    console.log('\n━━ Section 4: Wide parameter grid ─────────────────────────────────────────');
    for (const tlMin of [2.0, 2.5, 3.0]) {
      for (const steamMin of [0.13, 0.25, 0.50]) {
        const f   = r => r.tl_c >= tlMin && (r.tl_c - r.tl_o) >= steamMin;
        const res = evalVariant(hasTl, f, FRAC_AFTER);
        if (res.totN < 50) continue;
        const condN  = Math.round(res.totUnder + res.totOver * FRAC_AFTER);
        const stdDev = std(res.monthly.map(m => m.condPct));
        console.log(`  TL ≥ ${tlMin.toFixed(1)}  steam ≥ ${steamMin.toFixed(2)}  n=${String(res.totN).padStart(4)}  direct=${res.directPct.toFixed(1)}%  cond=${res.condPct.toFixed(1)}%  BE=${breakEven(res.condPct).padStart(5)}  safe=${safeOdds(res.condHits, condN).padStart(5)}  σ=${stdDev.toFixed(1)}%`);
      }
    }
  }

  // ── Section 5: Profitability summary ─────────────────────────────────────────
  console.log('\n━━ Section 5: Profitability summary ───────────────────────────────────────');
  console.log('   In-play Over 0.5 1H market at ~28\' (0-0 score)');
  console.log('   Typical market range: 1.50–1.80 in TL ≥ 2.5 games\n');

  const condPct  = cfgRes.condPct;
  const condN    = Math.round(cfgRes.totUnder + cfgRes.totOver * FRAC_AFTER);
  const [lo, hi] = wilsonCI(condPct, condN);

  console.log(`  Estimated hit rate     : ${condPct.toFixed(1)}%  (95% CI: ${lo.toFixed(1)}–${hi.toFixed(1)}%)`);
  console.log(`  Break-even odds needed : ${breakEven(condPct)}`);
  console.log(`  Conservative (CI low)  : ${breakEven(lo)}`);
  for (const targetOdds of [1.50, 1.60, 1.70, 1.80]) {
    const reqHit  = 100 / targetOdds;
    const margin  = condPct - reqHit;
    const verdict = margin > 0
      ? `EDGE +${margin.toFixed(1)}pp  → potentially profitable`
      : `DEFICIT ${margin.toFixed(1)}pp  → NOT profitable`;
    console.log(`  @ odds ${targetOdds.toFixed(2)}  need ${reqHit.toFixed(1)}%  you have ${condPct.toFixed(1)}%  → ${verdict}`);
  }

  console.log('\n  ⚠  Note: uniform goal-timing model is an approximation.');
  console.log('     Football goals are slightly more frequent in late 1H minutes,');
  console.log('     which would modestly increase the conditional hit rate above the estimate.');
  console.log('');
}

main();
