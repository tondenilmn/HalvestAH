// telegram/research/test_live_model.js
//
// Demo / sanity harness for the E5 pricing engine (static/live_model.js).
// No test framework (this repo has none) — plain console output plus a set
// of hard invariant checks that print PASS/FAIL and set a non-zero exit code
// if anything breaks.
//
// Run: node telegram/research/test_live_model.js

'use strict';

const LM = require('../../static/live_model.js');

let failures = 0;
function check(name, ok, detail) {
  if (!ok) failures++;
  console.log(`   [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? '  — ' + detail : ''}`);
}
function pctf(x) { return x == null ? '  n/a ' : (x * 100).toFixed(2).padStart(6) + '%'; }
function oddsf(x) { return x == null ? '  n/a' : x.toFixed(3).padStart(7); }

function show(rows, title) {
  console.log(`\n  ${title}`);
  console.log('   ' + 'market'.padEnd(34) + '     p        lo       hi     fair   minback  maxlay');
  for (const r of rows) {
    console.log('   ' + r.market.padEnd(34) + ' ' + pctf(r.p) + ' ' + pctf(r.lo) + ' ' + pctf(r.hi)
      + ' ' + oddsf(r.fair_odds) + ' ' + oddsf(r.min_back_odds) + ' ' + oddsf(r.max_lay_odds));
  }
}

function ciValid(rows, label) {
  let bad = [];
  for (const r of rows) {
    if (r.lo == null || r.hi == null) continue;
    if (!(r.lo <= r.p + 1e-12 && r.p <= r.hi + 1e-12)) bad.push(`${r.market} lo=${r.lo} p=${r.p} hi=${r.hi}`);
    if (!(r.lo >= -1e-12 && r.hi <= 1 + 1e-12)) bad.push(`${r.market} out of [0,1]`);
  }
  check(`CI bounds valid (lo <= p <= hi) — ${label}`, bad.length === 0, bad.slice(0, 3).join(' | '));
  return bad.length === 0;
}

// Standard market ladder used in most of the scenarios below.
const FT_LADDER = [
  { type: 'over', line: 0.5, scope: 'match' },
  { type: 'over', line: 1.5, scope: 'match' },
  { type: 'over', line: 2.5, scope: 'match' },
  { type: 'over', line: 3.5, scope: 'match' },
  { type: 'under', line: 2.5, scope: 'match' },
  { type: 'btts', scope: 'match' },
  { type: 'result', side: 'home', scope: 'match' },
  { type: 'result', side: 'draw', scope: 'match' },
  { type: 'result', side: 'away', scope: 'match' },
  { type: 'nextgoal', side: 'home', window: 15 },
  { type: 'nextgoal', side: 'away', window: 15 },
  { type: 'nextgoal', side: 'none', window: 15 },
];

console.log('================================================================');
console.log(' E5 pricing engine — static/live_model.js sanity run');
console.log('================================================================');

const boot = LM.init();
console.log(` hazard loaded: ${boot.hazardLoaded}   lambda_lookup loaded: ${boot.lookupLoaded}`);

// ── 0. Building blocks ──────────────────────────────────────────────────
console.log('\n── 0. Clock parsing + remaining-mass integral ───────────────────');
for (const m of [10, 44, 45, '45+2', 'HT', 60, 75, 90, '90+2', '90+5']) {
  const c = LM.parseClock(m);
  console.log(`   ${String(m).padEnd(6)} -> half ${c.half} reg ${String(c.reg).padStart(4)} stop ${String(c.stop).padStart(3)}`
    + `  label ${c.label.padEnd(6)}  remaining fraction of half = ${(LM.remainingFraction(c) * 100).toFixed(2)}%`);
}
const seq = [88, 90, '90+2', '90+4', '90+6'].map(m => LM.remainingFraction(LM.parseClock(m)));
check('remaining mass strictly decreasing 88 -> 90 -> 90+2 -> 90+4 -> 90+6',
  seq.every((v, i) => i === 0 || v < seq[i - 1]), seq.map(v => v.toFixed(4)).join(' > '));
check('remaining mass reaches ~0 past the average added time',
  seq[seq.length - 1] < 0.01, `= ${seq[seq.length - 1].toFixed(5)}`);

console.log('\n── 0b. Lambda lookup fallback ──────────────────────────────────');
for (const ctx of [
  { ah_line: -1.0, tl: 2.5, tier: 'TOP' },
  { ah_line: 0, tl: 2.5, tier: 'MAJOR' },
  { ah_line: 0.75, tl: 3.0, tier: 'OTHER' },
  { ah_line: -3.75, tl: 4.5, tier: 'TOP' },
]) {
  const f = LM.lambdaFromLookup(ctx);
  console.log(`   line ${String(ctx.ah_line).padStart(5)} TL ${ctx.tl} ${ctx.tier.padEnd(5)}`
    + ` -> lam_h ${f.lambda_h.toFixed(3)} lam_a ${f.lambda_a.toFixed(3)}  (cell "${f.key}", level ${f.level}, n=${f.n})`);
}

// ── 1. Half-time, favourite 1-0 up ──────────────────────────────────────
// A real-looking TOP-tier fixture: home favourite on the -0.75 line,
// TL 2.75 -> E1-style lambdas.
console.log('\n── 1. HT, home favourite 1-0 up ────────────────────────────────');
const stateHT = {
  lambda_h: 1.75, lambda_a: 1.05, tier: 'TOP', ah_line: -0.75, tl: 2.75,
  home_goals: 1, away_goals: 0, ht_home_goals: 1, ht_away_goals: 0,
  red_h: 0, red_a: 0
};
const rowsHT = LM.priceLadder(FT_LADDER.concat([
  { type: 'over', line: 0.5, scope: 'half' },
  { type: 'over', line: 1.5, scope: 'half' },
  { type: 'under', line: 0.5, scope: 'half' },
  { type: 'btts', scope: 'remainder' },
]), stateHT, 'HT');
show(rowsHT, 'lambda_h=1.75 lambda_a=1.05, score 1-0, minute HT');
console.log(`   remaining 2H lambda: home ${rowsHT[0].detail.mu_home_remaining.toFixed(3)}`
  + `  away ${rowsHT[0].detail.mu_away_remaining.toFixed(3)}`
  + `  (state mult home ${rowsHT[0].detail.state_mult_home.toFixed(3)}, away ${rowsHT[0].detail.state_mult_away.toFixed(3)})`);
ciValid(rowsHT, 'HT 1-0');

// (a) internal consistency: the O/U ladder must be monotone.
const o05 = rowsHT[0].p, o15 = rowsHT[1].p, o25 = rowsHT[2].p, o35 = rowsHT[3].p, u25 = rowsHT[4].p;
check('O/U ladder monotone: P(o0.5) >= P(o1.5) >= P(o2.5) >= P(o3.5)',
  o05 >= o15 && o15 >= o25 && o25 >= o35, `${o05.toFixed(4)} >= ${o15.toFixed(4)} >= ${o25.toFixed(4)} >= ${o35.toFixed(4)}`);
check('Over 2.5 + Under 2.5 == 1', Math.abs(o25 + u25 - 1) < 1e-6, `${(o25 + u25).toFixed(12)}`);
// tolerance 1e-6: the pmfs are truncated at MAX_GOALS more goals per side,
// so a "certain" market lands at 1 - O(1e-9), not exactly 1. The same
// truncation is why the coherence sums below use 1e-6, not 0.
check('P(over 0.5 FT) == 1 with a goal already scored', Math.abs(o05 - 1) < 1e-6, o05.toFixed(12));
const rSum = rowsHT[6].p + rowsHT[7].p + rowsHT[8].p;
check('1X2 probabilities sum to 1', Math.abs(rSum - 1) < 1e-6, rSum.toFixed(12));
const ngSum = rowsHT[9].p + rowsHT[10].p + rowsHT[11].p;
check('next-goal (home/away/none) sums to 1', Math.abs(ngSum - 1) < 1e-6, ngSum.toFixed(12));
check('analytic p matches the MC mean within noise (over 2.5)',
  Math.abs(rowsHT[2].p - rowsHT[2].p_mc) < 0.05, `p=${rowsHT[2].p.toFixed(4)} p_mc=${rowsHT[2].p_mc.toFixed(4)}`);

// ── 2. Minute 60, 0-0, both sides full strength ─────────────────────────
console.log('\n── 2. Minute 60, 0-0, 11 v 11 ──────────────────────────────────');
const state60 = {
  lambda_h: 1.45, lambda_a: 1.30, tier: 'MAJOR', ah_line: -0.25, tl: 2.75,
  home_goals: 0, away_goals: 0, ht_home_goals: 0, ht_away_goals: 0, red_h: 0, red_a: 0
};
const rows60 = LM.priceLadder(FT_LADDER, state60, 60);
show(rows60, 'lambda_h=1.45 lambda_a=1.30, score 0-0, minute 60');
ciValid(rows60, 'min 60 0-0');

// ── 3. RED CARD EFFECT — minute 75, 1-1, home down a man ────────────────
console.log('\n── 3. Minute 75, 1-1 — red-card effect ─────────────────────────');
const base75 = {
  lambda_h: 1.60, lambda_a: 1.15, tier: 'MAJOR', ah_line: -0.5, tl: 2.75,
  home_goals: 1, away_goals: 1, ht_home_goals: 1, ht_away_goals: 0, red_h: 0, red_a: 0
};
const red75 = Object.assign({}, base75, { red_h: 1 }); // home team sent off
const rowsNoRed = LM.priceLadder(FT_LADDER, base75, 75);
const rowsRed = LM.priceLadder(FT_LADDER, red75, 75);
show(rowsNoRed, '11 v 11');
show(rowsRed, 'HOME DOWN TO 10 MEN (same minute, same score)');
console.log('\n   effect on remaining lambdas:');
console.log(`     11v11 : home ${rowsNoRed[0].detail.mu_home_remaining.toFixed(4)}  away ${rowsNoRed[0].detail.mu_away_remaining.toFixed(4)}`
  + `   (state mult H ${rowsNoRed[0].detail.state_mult_home.toFixed(3)} / A ${rowsNoRed[0].detail.state_mult_away.toFixed(3)})`);
console.log(`     10v11 : home ${rowsRed[0].detail.mu_home_remaining.toFixed(4)}  away ${rowsRed[0].detail.mu_away_remaining.toFixed(4)}`
  + `   (state mult H ${rowsRed[0].detail.state_mult_home.toFixed(3)} / A ${rowsRed[0].detail.state_mult_away.toFixed(3)})`);
console.log('\n   price move (11v11 -> 10v11):');
for (let i = 0; i < FT_LADDER.length; i++) {
  const a = rowsNoRed[i], b = rowsRed[i];
  const d = (b.p - a.p) * 100;
  console.log(`     ${a.market.padEnd(34)} ${pctf(a.p)} -> ${pctf(b.p)}   ${(d >= 0 ? '+' : '') + d.toFixed(2)} pp`
    + `   fair ${oddsf(a.fair_odds)} -> ${oddsf(b.fair_odds)}`);
}
check('red card cuts the sent-off side\'s remaining lambda (x~0.604)',
  rowsRed[0].detail.mu_home_remaining < rowsNoRed[0].detail.mu_home_remaining * 0.7,
  `${rowsNoRed[0].detail.mu_home_remaining.toFixed(4)} -> ${rowsRed[0].detail.mu_home_remaining.toFixed(4)}`);
check('red card raises the OPPONENT\'s remaining lambda (x~1.628)',
  rowsRed[0].detail.mu_away_remaining > rowsNoRed[0].detail.mu_away_remaining * 1.3,
  `${rowsNoRed[0].detail.mu_away_remaining.toFixed(4)} -> ${rowsRed[0].detail.mu_away_remaining.toFixed(4)}`);
check('red card moves P(away win FT) up by > 3 pp',
  (rowsRed[8].p - rowsNoRed[8].p) > 0.03,
  `${(rowsNoRed[8].p * 100).toFixed(2)}% -> ${(rowsRed[8].p * 100).toFixed(2)}%`);
ciValid(rowsRed, 'min 75 red card');

// ── 4. GAMMA-POISSON UPDATE — same minute/score-margin, different goals ──
// Minute 70, second half. Two matches identical in every input EXCEPT how
// many goals have already been scored IN THIS HALF. The old model used the
// score only to reduce "need"; here it also updates the rate posterior.
console.log('\n── 4. Gamma-Poisson update: goals already scored this half ─────');
const baseGP = {
  lambda_h: 1.50, lambda_a: 1.20, tier: 'MAJOR', ah_line: -0.5, tl: 2.75, red_h: 0, red_a: 0
};
// (i) 2-2 at minute 70 with HT 2-2  -> 0 goals this half  (k = 0)
// (ii) 2-2 at minute 70 with HT 0-0 -> 2 goals each this half (k = 2)
// Same current score, same margin/total state multipliers, same minute.
const gpQuiet = Object.assign({}, baseGP, { home_goals: 2, away_goals: 2, ht_home_goals: 2, ht_away_goals: 2 });
const gpBusy = Object.assign({}, baseGP, { home_goals: 2, away_goals: 2, ht_home_goals: 0, ht_away_goals: 0 });
const LADDER_GP = [
  { type: 'over', line: 0.5, scope: 'half_remainder' },
  { type: 'over', line: 1.5, scope: 'half_remainder' },
  { type: 'over', line: 4.5, scope: 'match' },
  { type: 'over', line: 5.5, scope: 'match' },
  { type: 'nextgoal', side: 'none', window: 10 },
];
const rQuiet = LM.priceLadder(LADDER_GP, gpQuiet, 70);
const rBusy = LM.priceLadder(LADDER_GP, gpBusy, 70);
console.log('   (i)  score 2-2 at 70\', HT was 2-2  => 0 goals this half (k=0, no update)');
console.log('   (ii) score 2-2 at 70\', HT was 0-0  => 2 goals each this half (k=2 per side)');
console.log(`\n   remaining lambda  home / away`);
console.log(`     k=0 : ${rQuiet[0].detail.mu_home_remaining.toFixed(4)} / ${rQuiet[0].detail.mu_away_remaining.toFixed(4)}`
  + `   posterior home Gamma(r=${rQuiet[0].detail.gamma_posterior_home.r.toFixed(2)}, beta=${rQuiet[0].detail.gamma_posterior_home.beta.toFixed(2)})`);
console.log(`     k=2 : ${rBusy[0].detail.mu_home_remaining.toFixed(4)} / ${rBusy[0].detail.mu_away_remaining.toFixed(4)}`
  + `   posterior home Gamma(r=${rBusy[0].detail.gamma_posterior_home.r.toFixed(2)}, beta=${rBusy[0].detail.gamma_posterior_home.beta.toFixed(2)})`);
const ratio = rBusy[0].detail.mu_home_remaining / rQuiet[0].detail.mu_home_remaining;
console.log(`     ratio (k=2 / k=0) = ${ratio.toFixed(4)}   [expected (alpha2+2)/alpha2 = ${((13.4483 + 2) / 13.4483).toFixed(4)}]`);
show(rQuiet, 'k = 0 goals this half');
show(rBusy, 'k = 2 goals each this half');
check('gamma-Poisson update raises remaining lambda when goals were scored this half',
  rBusy[0].detail.mu_home_remaining > rQuiet[0].detail.mu_home_remaining, `ratio ${ratio.toFixed(4)}`);
check('update magnitude matches the (alpha + k)/alpha closed form',
  Math.abs(ratio - (13.4483 + 2) / 13.4483) < 0.005, `${ratio.toFixed(5)} vs ${((13.4483 + 2) / 13.4483).toFixed(5)}`);
check('P(another goal in the rest of the half) is higher after a busy half',
  rBusy[0].p > rQuiet[0].p, `${(rQuiet[0].p * 100).toFixed(2)}% -> ${(rBusy[0].p * 100).toFixed(2)}%`);
ciValid(rQuiet, 'gamma-Poisson k=0'); ciValid(rBusy, 'gamma-Poisson k=2');

// ── 5. Late-game / stoppage-time behaviour ──────────────────────────────
console.log('\n── 5. Late-game decay, 0-0 at TL 2.5 ───────────────────────────');
const lateState = {
  lambda_h: 1.35, lambda_a: 1.15, tier: 'MAJOR', ah_line: -0.25, tl: 2.5,
  home_goals: 0, away_goals: 0, ht_home_goals: 0, ht_away_goals: 0, red_h: 0, red_a: 0
};
const lateRows = [];
for (const m of [46, 60, 75, 85, 89, 90, '90+2', '90+4', '90+6']) {
  const r = LM.priceMarket({ type: 'over', line: 0.5, scope: 'remainder' }, lateState, m, { samples: 300 });
  lateRows.push({ m, r });
  console.log(`   min ${String(r.minute).padEnd(6)}  P(>=1 more goal) = ${pctf(r.p)}  [${pctf(r.lo)} .. ${pctf(r.hi)}]  fair ${oddsf(r.fair_odds)}`);
}
check('P(>=1 more goal) strictly decreasing across 46..90+6',
  lateRows.every((x, i) => i === 0 || x.r.p < lateRows[i - 1].r.p));
check('P(>=1 more goal) -> ~0 deep in stoppage time', lateRows[lateRows.length - 1].r.p < 0.02,
  (lateRows[lateRows.length - 1].r.p * 100).toFixed(3) + '%');
ciValid(lateRows.map(x => x.r), 'late-game ladder');

// ── 6. 1st-half in-play + scale fallback (no lambdas supplied) ──────────
console.log('\n── 6. Minute 30, 1-0, lambdas taken from lambda_lookup.json ────');
const fbState = {
  tier: 'OTHER', ah_line: -0.5, tl: 2.5,
  home_goals: 1, away_goals: 0, red_h: 0, red_a: 0
};
const fbRows = LM.priceLadder([
  { type: 'over', line: 0.5, scope: 'half' },
  { type: 'over', line: 1.5, scope: 'half' },
  { type: 'over', line: 2.5, scope: 'match' },
  { type: 'result', side: 'home', scope: 'match' },
  { type: 'result', side: 'draw', scope: 'match' },
  { type: 'result', side: 'away', scope: 'match' },
  { type: 'btts', scope: 'match' },
  { type: 'nextgoal', side: 'none', window: 15 },
], fbState, 30);
console.log(`   scale source: ${JSON.stringify(fbRows[0].scale.lookup_source)}`
  + `  lam_h=${fbRows[0].scale.lambda_h} lam_a=${fbRows[0].scale.lambda_a}`);
console.log(`   MC scale source: ${JSON.stringify(fbRows[0].scale.mc_scale_source)}`);
show(fbRows, 'fallback scale, minute 30, 1-0');
ciValid(fbRows, 'lookup fallback');
check('1H match-scope market spans both halves (mu > current-half remaining)',
  fbRows[2].detail.mu_home_remaining > 0.5);

// ── 7. simulateMatch ────────────────────────────────────────────────────
console.log('\n── 7. simulateMatch() from HT 1-0 ──────────────────────────────');
const sim = LM.simulateMatch(stateHT, 'HT', { sims: 20000 });
console.log(`   mean FT score ${sim.mean_ft_home.toFixed(2)} - ${sim.mean_ft_away.toFixed(2)}`
  + `   P(home) ${(sim.p_home * 100).toFixed(2)}%  P(draw) ${(sim.p_draw * 100).toFixed(2)}%  P(away) ${(sim.p_away * 100).toFixed(2)}%`);
console.log('   most likely FT scores: ' + sim.top_scores.map(t => `${t.score} ${(t.p * 100).toFixed(1)}%`).join(', '));
check('simulateMatch 1X2 agrees with the analytic 1X2 within MC noise',
  Math.abs(sim.p_home - rowsHT[6].p) < 0.02 && Math.abs(sim.p_away - rowsHT[8].p) < 0.02,
  `sim ${(sim.p_home * 100).toFixed(2)}/${(sim.p_draw * 100).toFixed(2)}/${(sim.p_away * 100).toFixed(2)}`
  + ` vs analytic ${(rowsHT[6].p * 100).toFixed(2)}/${(rowsHT[7].p * 100).toFixed(2)}/${(rowsHT[8].p * 100).toFixed(2)}`);

// ── 8. Global CI-validity sweep across many random states ───────────────
console.log('\n── 8. CI-validity sweep (200 random states x 12 markets) ───────');
let sweepBad = 0, sweepN = 0, widthSum = 0;
let rngSeed = 12345;
function rnd() { rngSeed = (rngSeed * 1103515245 + 12345) & 0x7fffffff; return rngSeed / 0x7fffffff; }
for (let t = 0; t < 200; t++) {
  const hg = Math.floor(rnd() * 4), ag = Math.floor(rnd() * 4);
  const st = {
    lambda_h: 0.6 + rnd() * 2.2, lambda_a: 0.5 + rnd() * 2.0,
    tier: ['TOP', 'MAJOR', 'OTHER'][Math.floor(rnd() * 3)],
    ah_line: (Math.floor(rnd() * 17) - 8) * 0.25, tl: 1.5 + Math.floor(rnd() * 9) * 0.5,
    home_goals: hg, away_goals: ag,
    ht_home_goals: Math.floor(rnd() * (hg + 1)), ht_away_goals: Math.floor(rnd() * (ag + 1)),
    red_h: rnd() < 0.1 ? 1 : 0, red_a: rnd() < 0.1 ? 1 : 0
  };
  const min = 1 + Math.floor(rnd() * 94);
  const rows = LM.priceLadder(FT_LADDER, st, min, { samples: 120, seed: t + 1 });
  for (const r of rows) {
    sweepN++;
    if (r.lo == null) continue;
    if (!(r.lo <= r.p + 1e-12 && r.p <= r.hi + 1e-12)) sweepBad++;
    if (!(r.lo >= -1e-12 && r.hi <= 1 + 1e-12)) sweepBad++;
    if (!(r.p >= 0 && r.p <= 1)) sweepBad++;
    widthSum += (r.hi - r.lo);
  }
  // ladder monotonicity on every random state
  if (!(rows[0].p >= rows[1].p - 1e-12 && rows[1].p >= rows[2].p - 1e-12 && rows[2].p >= rows[3].p - 1e-12)) sweepBad++;
  if (Math.abs(rows[6].p + rows[7].p + rows[8].p - 1) > 1e-6) sweepBad++;
  if (Math.abs(rows[2].p + rows[4].p - 1) > 1e-6) sweepBad++;
}
console.log(`   ${sweepN} priced markets, mean CI width ${(widthSum / sweepN * 100).toFixed(2)} pp`);
check('no CI / monotonicity / coherence violation in the sweep', sweepBad === 0, `${sweepBad} violations`);

console.log('\n================================================================');
console.log(failures === 0 ? ' ALL CHECKS PASSED' : ` ${failures} CHECK(S) FAILED`);
console.log('================================================================');
process.exit(failures === 0 ? 0 : 1);
