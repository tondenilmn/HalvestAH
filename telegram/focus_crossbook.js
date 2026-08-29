'use strict';
// ── Focus-bet cross-book check (PLAN_FOCUS_BETS.md Phase 4) ───────────────────
// Answers "follow the market or fade it?" for the 7 in-scope 1H/2H O/U bets,
// using two independent signals:
//   A) MOVEMENT — Bet365's own closing-vs-opening Total Line move (tl_move,
//      already computed by engine.js's processRow). Does steaming toward more
//      goals (tl_move=UP) predict more Over-family hits (follow), fewer
//      (fade), or neither (no signal)? Mirror logic for Under-family bets.
//   B) BOOK DISAGREEMENT — Sbobet's closing Total Line vs Bet365's, on the
//      subset of matches both books quote (see focus_lib.mergeBooks). When
//      the sharper/lower-margin book (Sbobet, see CrossBooks note) sees more
//      total goals than Bet365 at closing, does that predict Over-family
//      hits better than Bet365's own price already implies?
// Walk-forward validated the same way as focus_config_search.js (last 8
// months, train = strictly-before months) — this script only reports
// hit-rate/edge deltas between buckets, it doesn't do cross-fit cell
// selection (there's no "cell" being picked here, just a fixed 3-way split
// per key), so the winner's-curse guard doesn't apply the same way; still,
// only a >=6/8-months-consistent direction is called a real verdict.
//
// Usage: node focus_crossbook.js [--months=8]

const lib = require('./focus_lib');

const MONTHS_ARG = (process.argv.find(a => a.startsWith('--months=')) || '').split('=')[1];
const WF_MONTHS  = MONTHS_ARG ? parseInt(MONTHS_ARG, 10) : 8;
const GAP_THRESH = 0.20; // Sbobet vs Bet365 closing TL gap considered meaningful
const MIN_N      = 40;   // per-bucket, per-month minimum to count

const OVER_FAMILY  = new Set(['over05_1H', 'over15_1H', 'over05_2H', 'over15_2H']);
const UNDER_FAMILY = new Set(['under05_1H', 'under05_2H', 'under15_2H']);

function bucketStats(rows, key, correctionPct) {
  const n = rows.length;
  if (n < MIN_N) return null;
  let hits = 0, staked = 0, profit = 0, sumFair = 0, priced = 0;
  for (const r of rows) {
    const ip = lib.impliedPrice(r, key, correctionPct);
    if (!ip) continue;
    priced++; staked++;
    sumFair += ip.fairImplied;
    if (lib.outcome(r, key)) { hits++; profit += ip.price - 1; }
    else profit -= 1;
  }
  if (!staked) return null;
  return {
    n: staked, hitPct: hits / staked * 100,
    meanFairPct: (sumFair / priced) * 100,
    roi: profit / staked * 100,
  };
}

// ── A) Movement (tl_move) ─────────────────────────────────────────────────
function movementAnalysis(rows, key) {
  const perMonth = lib.walkForward(rows, (trainRows, testRows) => {
    const correctionPct = lib.computeCalibration(trainRows, key);
    const buckets = { UP: [], DOWN: [], STABLE: [] };
    for (const r of testRows) if (buckets[r.tl_move]) buckets[r.tl_move].push(r);
    return {
      UP: bucketStats(buckets.UP, key, correctionPct),
      DOWN: bucketStats(buckets.DOWN, key, correctionPct),
    };
  }, WF_MONTHS);

  let upBetterMonths = 0, downBetterMonths = 0, monthsCompared = 0;
  let upN = 0, upProfit = 0, downN = 0, downProfit = 0;
  for (const { result } of perMonth) {
    if (!result.UP || !result.DOWN) continue;
    monthsCompared++;
    if (result.UP.roi > result.DOWN.roi) upBetterMonths++; else downBetterMonths++;
    upN += result.UP.n; upProfit += (result.UP.roi / 100) * result.UP.n;
    downN += result.DOWN.n; downProfit += (result.DOWN.roi / 100) * result.DOWN.n;
  }
  if (!monthsCompared) return { verdict: 'insufficient data', monthsCompared: 0 };

  const upRoi = upN ? upProfit / upN * 100 : null;
  const downRoi = downN ? downProfit / downN * 100 : null;
  const isOver = OVER_FAMILY.has(key);
  // "follow" = betting in the direction the line moved wins more (UP move ->
  // bet Over; DOWN move -> bet Under, i.e. Over-family loses on DOWN days).
  let verdict = 'no signal';
  const consistentFrac = Math.max(upBetterMonths, downBetterMonths) / monthsCompared;
  if (consistentFrac >= 0.75 && upN >= 100 && downN >= 100) {
    if (isOver) verdict = upRoi > downRoi ? 'follow (bet Over when TL steams UP)' : 'fade (bet Over when TL steams DOWN)';
    else verdict = downRoi > upRoi ? 'follow (bet Under when TL steams DOWN)' : 'fade (bet Under when TL steams UP)';
  }
  return { verdict, monthsCompared, upBetterMonths, downBetterMonths, upN, upRoi, downN, downRoi };
}

// ── B) Book disagreement (Sbobet vs Bet365 closing TL) ────────────────────
function disagreementAnalysis(pairs, key) {
  const matched = pairs.filter(p => p.sbo).map(p => ({ ...p.b365, _sboTlGap: p.sbo.tl_c - p.b365.tl_c }));

  const perMonth = lib.walkForward(matched, (trainRows, testRows) => {
    const correctionPct = lib.computeCalibration(trainRows, key);
    const buckets = { HIGHER: [], LOWER: [] };
    for (const r of testRows) {
      if (r._sboTlGap == null) continue;
      if (r._sboTlGap >= GAP_THRESH) buckets.HIGHER.push(r);
      else if (r._sboTlGap <= -GAP_THRESH) buckets.LOWER.push(r);
    }
    return {
      HIGHER: bucketStats(buckets.HIGHER, key, correctionPct),
      LOWER: bucketStats(buckets.LOWER, key, correctionPct),
    };
  }, WF_MONTHS);

  let higherBetterMonths = 0, lowerBetterMonths = 0, monthsCompared = 0;
  let higherN = 0, higherProfit = 0, lowerN = 0, lowerProfit = 0;
  for (const { result } of perMonth) {
    if (!result.HIGHER || !result.LOWER) continue;
    monthsCompared++;
    if (result.HIGHER.roi > result.LOWER.roi) higherBetterMonths++; else lowerBetterMonths++;
    higherN += result.HIGHER.n; higherProfit += (result.HIGHER.roi / 100) * result.HIGHER.n;
    lowerN += result.LOWER.n; lowerProfit += (result.LOWER.roi / 100) * result.LOWER.n;
  }
  if (!monthsCompared) return { verdict: 'insufficient data', monthsCompared: 0 };

  const higherRoi = higherN ? higherProfit / higherN * 100 : null;
  const lowerRoi = lowerN ? lowerProfit / lowerN * 100 : null;
  const isOver = OVER_FAMILY.has(key);
  let verdict = 'no signal';
  const consistentFrac = Math.max(higherBetterMonths, lowerBetterMonths) / monthsCompared;
  if (consistentFrac >= 0.75 && higherN >= 50 && lowerN >= 50) {
    if (isOver) verdict = higherRoi > lowerRoi ? 'Sbobet-higher-TL predicts Over beating Bet365 price' : 'Sbobet-lower-TL predicts Over beating Bet365 price (counter-intuitive)';
    else verdict = lowerRoi > higherRoi ? 'Sbobet-lower-TL predicts Under beating Bet365 price' : 'Sbobet-higher-TL predicts Under beating Bet365 price (counter-intuitive)';
  }
  return { verdict, monthsCompared, higherBetterMonths, lowerBetterMonths, higherN, higherRoi, lowerN, lowerRoi };
}

function main() {
  console.log('\n═══ Focus-bet cross-book check (Phase 4) ═══════════════════════════');
  const b365 = lib.loadBook('Bet365');
  const sbo  = lib.loadBook('Sbobet');
  const pairs = lib.mergeBooks(b365, sbo);
  const matchedCount = pairs.filter(p => p.sbo).length;
  console.log(`Bet365 rows: ${b365.length}, Sbobet rows: ${sbo.length}, matched pairs: ${matchedCount} (${(matchedCount / pairs.length * 100).toFixed(1)}%)`);

  const results = {};
  for (const key of [...OVER_FAMILY, ...UNDER_FAMILY]) {
    console.log(`\n── ${key} (${lib.FOCUS_LABELS[key]}) ──`);
    const mv = movementAnalysis(b365, key);
    console.log(`  A) Movement:      ${mv.verdict}` + (mv.monthsCompared ? ` [${mv.upBetterMonths ?? '-'}/${mv.monthsCompared} months UP-better, UP roi=${mv.upRoi?.toFixed(1)}% n=${mv.upN}, DOWN roi=${mv.downRoi?.toFixed(1)}% n=${mv.downN}]` : ''));
    const dg = disagreementAnalysis(pairs, key);
    console.log(`  B) Disagreement:  ${dg.verdict}` + (dg.monthsCompared ? ` [${dg.higherBetterMonths ?? '-'}/${dg.monthsCompared} months HIGHER-better, HIGHER roi=${dg.higherRoi?.toFixed(1)}% n=${dg.higherN}, LOWER roi=${dg.lowerRoi?.toFixed(1)}% n=${dg.lowerN}]` : ''));
    results[key] = { movement: mv, disagreement: dg };
  }

  const file = lib.saveJson('focus_crossbook.json', {
    generatedAt: new Date().toISOString(),
    windowMonths: WF_MONTHS,
    gapThreshold: GAP_THRESH,
    caveat: 'ROI figures are against the model-implied price (see focus_lib.js), not a real settled market price for these half-line markets.',
    results,
  });
  console.log(`\nSaved -> ${file}`);
}

main();
