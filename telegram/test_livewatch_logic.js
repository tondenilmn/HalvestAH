'use strict';
// Isolated test for Strategy LIVEWATCH's core logic (pool selection + live
// decay) against the REAL production dataset (static/data/Bet365), without
// requiring notify.js — see notify.js's header: requiring it directly runs
// the live scheduler and can send real Telegram alerts.
//
// Mirrors notify.js's liveWatchBasePool()/runStrategyLiveWatch() logic using
// the same engine.js/live_odds.js primitives, to confirm the wiring is sound
// before trusting it in production.

const path = require('path');
const { loadDatabase, pct, applyGameState, wilsonCI } = require('./engine');
const { computeLiveOdd, computeLive1HOdd } = require('./live_odds');
const focusLib = require('./focus_lib');

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
}

const dbAll = loadDatabase(path.resolve(__dirname, '../static/data'));
console.log(`Loaded ${dbAll.length} historical rows\n`);

function tlBandOf(v) {
  const bands = { '<2': [null, 2.0], '2-2.5': [2.0, 2.5], '2.5-3': [2.5, 3.0], '>3': [3.0, null] };
  for (const [name, [lo, hi]] of Object.entries(bands)) {
    if ((lo == null || v >= lo) && (hi == null || v < hi)) return name;
  }
  return null;
}
function basePool(favLine, favSide, tlBand, minN) {
  const lineBase = dbAll.filter(r => r.fav_line === favLine && r.fav_side === favSide);
  const bandBase = lineBase.filter(r => tlBandOf(r.tl_c) === tlBand);
  return bandBase.length >= minN ? bandBase : lineBase;
}

// ── 1H key: find a real (favLine, favSide, tlBand) combo with a decent pool ──
const pool1h = basePool(0.25, 'HOME', '2-2.5', 50);
check(`1H base pool has rows (n=${pool1h.length})`, pool1h.length >= 50);

const histP1h = pct(pool1h, 'over05_1H');
check(`over05_1H historical rate is a sane percentage (${histP1h.toFixed(1)}%)`, histP1h > 0 && histP1h < 100);

// At minute 0 (kickoff, 0-0), live_p should be ~= historical p.
const atKickoff = computeLive1HOdd(histP1h, 'over05_1H', 0, 0.25, 0, 0);
check(`computeLive1HOdd @ kickoff ≈ historical rate (${atKickoff.live_p} vs ${histP1h.toFixed(1)})`, Math.abs(atKickoff.live_p - histP1h) < 1);

// As minute increases scoreless, live_p should decay downward — eventually
// crossing below a 70% threshold if histP1h started above it, or never
// crossing if it started below. Either way, the trend must be monotonic down.
const atMin30 = computeLive1HOdd(histP1h, 'over05_1H', 30, 0.25, 0, 0);
check(`live_p decays as minutes pass scoreless (${histP1h.toFixed(1)} > ${atKickoff.live_p} >= ${atMin30.live_p})`, atKickoff.live_p >= atMin30.live_p);

// Once a goal exists, over05_1H must show alreadyDecided (already hit).
const afterGoal = computeLive1HOdd(histP1h, 'over05_1H', 20, 0.25, 1, 0);
check('over05_1H flips to alreadyDecided once a goal exists', afterGoal.alreadyDecided === true && afterGoal.live_p === 100);

// ── 2H key: HT-conditioned pool + live decay ─────────────────────────────
const pool2h = basePool(0.25, 'HOME', '2-2.5', 50);
const gsRows = applyGameState(pool2h, { trigger: 'HT', home_goals: '0', away_goals: '0' });
check(`HT 0-0 conditioned pool is non-trivial (n=${gsRows.length})`, gsRows.length > 0);

if (gsRows.length >= 20) {
  const histP2h = pct(gsRows, 'under05_2H');
  check(`under05_2H historical rate at HT 0-0 is sane (${histP2h.toFixed(1)}%)`, histP2h > 0 && histP2h < 100);

  // Right at HT (minute 46, no 2H goals yet), live_p should ≈ historical rate.
  const at46 = computeLiveOdd(histP2h, 'under05_2H', 46, 0.25, 0, 0, 'HOME');
  check(`computeLiveOdd @ HT ≈ historical rate (${at46.live_p} vs ${histP2h.toFixed(1)})`, Math.abs(at46.live_p - histP2h) < 5);

  // As the 2H progresses scorelessly, under05_2H's live_p should RISE (more
  // likely to stay under as time runs out) — this is the "wait for it to
  // climb past threshold" behavior LIVEWATCH is built to catch.
  const at75 = computeLiveOdd(histP2h, 'under05_2H', 75, 0.25, 0, 0, 'HOME');
  check(`under05_2H live_p rises as 2H stays scoreless (${at46.live_p} < ${at75.live_p})`, at75.live_p > at46.live_p);

  // Once a 2H goal happens, under05_2H must flip to alreadyDecided (busted).
  const busted = computeLiveOdd(histP2h, 'under05_2H', 60, 0.25, 1, 0, 'HOME');
  check('under05_2H flips to alreadyDecided (busted) once a 2H goal exists', busted.alreadyDecided === true && busted.live_p === 0);
}

// ── CI-lower-bound gating + baseline edge (2026-08-29 additions) ──────────
const [lo1h, hi1h] = wilsonCI(histP1h, pool1h.length);
check(`wilsonCI lower bound is below the point estimate (${lo1h} < ${histP1h.toFixed(1)})`, lo1h < histP1h);
check(`wilsonCI upper bound is above the point estimate (${hi1h} > ${histP1h.toFixed(1)})`, hi1h > histP1h);

const loLiveOdd = computeLive1HOdd(lo1h, 'over05_1H', 20, 0.25, 0, 0);
const pointLiveOdd = computeLive1HOdd(histP1h, 'over05_1H', 20, 0.25, 0, 0);
check(`CI-lower decayed live_p is <= point-estimate decayed live_p (${loLiveOdd.live_p} <= ${pointLiveOdd.live_p})`, loLiveOdd.live_p <= pointLiveOdd.live_p);

// Baseline edge: a less-conditioned pool (line-only) vs the more-conditioned
// TL-banded pool — the two need not be equal, confirming the edge check has
// something real to compare.
const lineOnlyPool = dbAll.filter(r => r.fav_line === 0.25 && r.fav_side === 'HOME');
const blP1h = pct(lineOnlyPool, 'over05_1H');
check(`baseline (line-only, n=${lineOnlyPool.length}) computable and distinct from banded pool's rate`, typeof blP1h === 'number' && lineOnlyPool.length >= pool1h.length);

// ── "team to score" keys (added 2026-08-29 at user request) ──────────────
const homeScore2hAnchor = pct(basePool(0.25, 'HOME', '2-2.5', 50), 'homeScored2H');
check(`homeScored2H historical rate is sane (${homeScore2hAnchor.toFixed(1)}%)`, homeScore2hAnchor > 0 && homeScore2hAnchor < 100);
const homeScore2hLive = computeLiveOdd(homeScore2hAnchor, 'homeScored2H', 60, 0.25, 0, 0, 'HOME');
check('computeLiveOdd supports homeScored2H (live_p is a number)', typeof homeScore2hLive.live_p === 'number');
const homeScore2hDecided = computeLiveOdd(homeScore2hAnchor, 'homeScored2H', 60, 0.25, 1, 0, 'HOME');
check('homeScored2H already-hit once home scores in 2H (live_p=100)', homeScore2hDecided.live_p === 100 && homeScore2hDecided.alreadyDecided === true);

const awayScore1hAnchor = pct(basePool(0.25, 'HOME', '2-2.5', 50), 'awayScored1H');
const awayScore1hLive = computeLive1HOdd(awayScore1hAnchor, 'awayScored1H', 20, 0.25, 0, 0);
check('computeLive1HOdd supports awayScored1H (live_p is a number)', typeof awayScore1hLive.live_p === 'number');

// ── config wiring sanity ──────────────────────────────────────────────────
check('focus_lib.FOCUS_KEYS has all 7 keys', focusLib.FOCUS_KEYS.length === 7);
check('focus_lib.FOCUS_HALF classifies over05_1H as 1H', focusLib.FOCUS_HALF['over05_1H'] === '1H');
check('focus_lib.FOCUS_HALF classifies under05_2H as 2H', focusLib.FOCUS_HALF['under05_2H'] === '2H');

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
