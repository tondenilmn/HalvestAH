'use strict';
// Sanity check for the 1H port added to live_odds.js (PLAN_FOCUS_BETS.md Phase 3).
// Not a full app.js-vs-node diff (app.js runs in a browser global scope, not
// requirable from Node) — instead checks the ported functions against hand
// -computed expectations at a few control points, and that they degrade
// smoothly as minute increases.

const {
  computeLive1HOdd, computeLiveResult1H, computeLiveBtts1H,
} = require('./live_odds');

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
}

// At minute 0 (full half ahead), live_p should equal the anchor p almost exactly.
const r0 = computeLive1HOdd(35, 'over05_1H', 0);
check(`over05_1H @ min0 anchor=35% -> live≈35% (got ${r0.live_p})`, Math.abs(r0.live_p - 35) < 0.5);

// As minute increases with no goal, live_p for an "over" bet should monotonically decrease.
const m15 = computeLive1HOdd(35, 'over05_1H', 15).live_p;
const m30 = computeLive1HOdd(35, 'over05_1H', 30).live_p;
const m44 = computeLive1HOdd(35, 'over05_1H', 44).live_p;
check(`over05_1H decays with minute (35 > ${m15} > ${m30} > ${m44})`, 35 > m15 && m15 > m30 && m30 > m44);

// Under bets should increase (more likely to stay under) as minute increases with no goal.
const u0  = computeLive1HOdd(65, 'under05_1H', 0).live_p;
const u30 = computeLive1HOdd(65, 'under05_1H', 30).live_p;
check(`under05_1H rises as time passes scoreless (${u0} < ${u30})`, u30 > u0);

// Already-hit / already-busted short circuits.
const hit = computeLive1HOdd(40, 'over05_1H', 20, 0.75, 1, 0);
check(`over05_1H already hit once a goal exists -> live_p=100`, hit.live_p === 100 && hit.alreadyDecided);

const bust = computeLive1HOdd(60, 'under05_1H', 20, 0.75, 1, 0);
check(`under05_1H already busted once a goal exists -> live_p=0`, bust.live_p === 0 && bust.alreadyDecided);

// Unsupported key returns nulls.
const unsup = computeLive1HOdd(50, 'over25FT', 10);
check(`unsupported key (over25FT) -> live_p null`, unsup.live_p === null);

// computeLiveResult1H: at minute 0 the joint favWin/draw/dogWin should sum to ~100.
const res = computeLiveResult1H(30, 20, 0, 0.75, 0, 0, false);
const sum = res.fav_win_p + res.draw_p + res.dog_win_p;
check(`computeLiveResult1H sums to ~100 (got ${sum.toFixed(2)})`, Math.abs(sum - 100) < 0.5);

// computeLiveBtts1H: product of two 50% anchors at minute 0 ~ 25%.
const btts = computeLiveBtts1H(50, 50, 0, 0.75, 0, 0, false);
check(`computeLiveBtts1H(50,50) @ min0 ≈ 25% (got ${btts.live_p})`, Math.abs(btts.live_p - 25) < 1);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
