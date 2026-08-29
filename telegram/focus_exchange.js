'use strict';
// ── Focus-bet exchange playbook (PLAN_FOCUS_BETS.md Phase 6) ───────────────────
// Calculators for running a FOCUS pick on a betting exchange (Betfair/
// Smarkets) instead of, or alongside, a soft-book bet-and-hold. All of them
// are pure functions driven by the same live-decay curve
// (computeLiveOdd/computeLive1HOdd from live_odds.js) the FOCUS strategy
// itself prices with — see BETTING_EDGE_ANALYSIS.md's "Focus bets" section
// for why these curves are trustworthy sources of a fair live price even
// though the exact 0.5/1.5 half-line markets have no historical settled
// price in this codebase's data.
//
// Exchange market note: "1st Half Goals 0.5/1.5" is commonly listed directly;
// "2nd Half Goals" often is NOT — fall back to the equivalent FT Over/Under
// line (focus_select.js's equivalentRealMarketFocus2h, same trick notify.js
// uses for the real-price check) which is essentially always listed.
//
// Usage: node focus_exchange.js --demo

const { computeLiveOdd, computeLive1HOdd } = require('./live_odds');
const focusLib = require('./focus_lib');
const focusSelect = require('./focus_select');

function isHalf1(key) { return focusLib.FOCUS_HALF[key] === '1H'; }

function priceAt(key, anchorP, minute, favLine, favSide, favG, dogG) {
  return isHalf1(key)
    ? computeLive1HOdd(anchorP, key, minute, favLine, favG, dogG)
    : computeLiveOdd(anchorP, key, minute, favLine, favG, dogG, favSide);
}

// ── 1) Time-decay lay (for an Under key: lay the Over side at HT/kickoff,
// then look for the minute where the model's projected price has drifted
// far enough — because no goal has happened — that backing Over now at that
// price locks in profit on both outcomes ("green-up")). ────────────────────
// commissionPct: exchange commission on net winnings (e.g. 2 for 2%).
function timeDecayLay(key, anchorP, favLine, favSide, layPrice, layStake, commissionPct, opts = {}) {
  const isOver = key.startsWith('over');
  if (isOver) throw new Error('timeDecayLay expects an Under key — lay the complementary Over side');
  const overKeyThreshold = focusLib.FOCUS_THRESHOLD[key]; // same threshold, opposite side
  const overKey = key.replace('under', 'over');
  const startMinute = isHalf1(key) ? 0 : 45;
  const endMinute = isHalf1(key) ? 44 : 90;
  const step = opts.stepMinutes || 5;
  const commission = commissionPct / 100;

  const ladder = [];
  for (let m = startMinute; m <= endMinute; m += step) {
    const liveMinuteArg = isHalf1(key) ? m : m; // computeLive*Odd takes absolute match minute
    const res = priceAt(overKey, 100 - anchorP, liveMinuteArg, favLine, favSide, 0, 0);
    if (res.live_p == null || res.alreadyDecided) continue;
    const overPriceNow = res.fair_odd;
    // Backing Over now at overPriceNow to green up the earlier Over lay:
    // back stake B such that liability if Over wins (layStake*(layPrice-1))
    // is offset by back-side profit (B*(overPriceNow-1)), and if Under wins
    // the lay-side profit (layStake, net of commission) offsets the back
    // stake lost (B). Standard exchange green-up formula:
    const backStake = (layStake * (layPrice - 1) + layStake) / overPriceNow;
    const profitIfOver = backStake * (overPriceNow - 1) - layStake * (layPrice - 1);
    const profitIfUnder = layStake * (1 - commission) - backStake;
    ladder.push({
      minute: m, overFairPrice: overPriceNow, backStakeToGreen: parseFloat(backStake.toFixed(2)),
      profitIfOver: parseFloat(profitIfOver.toFixed(2)), profitIfUnder: parseFloat(profitIfUnder.toFixed(2)),
    });
  }
  const greenMinute = ladder.find(r => r.profitIfOver > 0 && r.profitIfUnder > 0);
  return { ladder, greenMinute: greenMinute ? greenMinute.minute : null };
}

// ── 2) Back-then-lay split on an Over key: back pre-kickoff/at-HT at the
// exchange, then lay at a lower price once/if the market's Over price
// shortens (a goal looks close, or one just went in) — either for an equal
// green (lock the same profit both ways) or a "free bet" (keep the stake,
// only cash in the middle outcome). ─────────────────────────────────────────
function backThenLaySplit(backPrice, backStake, layPrice, mode = 'equal') {
  if (mode === 'equal') {
    // lay stake L such that: backStake*(backPrice-1) - L*(layPrice-1) == -backStake + L
    // solves to the standard green-up stake:
    const layStake = backStake * backPrice / layPrice;
    const profitBothSides = backStake * (backPrice - 1) - layStake * (layPrice - 1);
    return { mode, layStake: parseFloat(layStake.toFixed(2)), profitBothSides: parseFloat(profitBothSides.toFixed(2)) };
  }
  // 'freebet' — lay only the stake back, keep the upside if Over still lands.
  const layStake = backStake;
  const profitIfLayWins = backStake * (backPrice - 1) - layStake * (layPrice - 1);
  const profitIfBackWins = backStake * (backPrice - 1) - layStake * (layPrice - 1) + layStake; // lay-side liability already paid, back still collects
  return {
    mode, layStake: parseFloat(layStake.toFixed(2)),
    note: 'Stake returned either way; extra upside kept if the original Over bet still lands.',
    profitIfLayWins: parseFloat(profitIfLayWins.toFixed(2)),
  };
}

// ── 3) Ladder entry: split a stake across several entry points instead of
// one lump bet at HT/kickoff, betting more of it only while the bet is still
// alive (no goal yet). Returns the expected blended price vs. a single-entry
// baseline. ──────────────────────────────────────────────────────────────
function ladderEntry(key, anchorP, favLine, favSide, totalStake, splits = [0.5, 0.25, 0.25], checkMinutes) {
  const startMinute = isHalf1(key) ? 0 : 45;
  const minutes = checkMinutes || (isHalf1(key) ? [startMinute, 15, 30] : [startMinute, 60, 70]);
  if (minutes.length !== splits.length) throw new Error('splits and checkMinutes must be the same length');

  let blendedStakeWeightedPrice = 0, staked = 0, expectedProfit = 0;
  const rungs = [];
  for (let i = 0; i < minutes.length; i++) {
    const res = priceAt(key, anchorP, minutes[i], favLine, favSide, 0, 0);
    if (res.alreadyDecided) { rungs.push({ minute: minutes[i], stake: totalStake * splits[i], note: res.note }); continue; }
    const price = res.fair_odd;
    const stake = totalStake * splits[i];
    staked += stake;
    blendedStakeWeightedPrice += price * stake;
    rungs.push({ minute: minutes[i], price, stake: parseFloat(stake.toFixed(2)), live_p: res.live_p });
  }
  const blendedPrice = staked ? blendedStakeWeightedPrice / staked : null;
  const singleEntry = priceAt(key, anchorP, startMinute, favLine, favSide, 0, 0);
  return { rungs, blendedPrice, singleEntryPrice: singleEntry.fair_odd };
}

// ── 4) Book vs exchange arbitrage of the model: soft book offers >= min_odd
// (Wilson-CI floor) AND the exchange lay price is below fair_odd*(1-commission)
// -> guaranteed-profit pair. Rare, but cheap to check every time. ──────────
function bookVsExchangeArb(softBookPrice, minOdd, exchangeLayPrice, fairOdd, commissionPct, stake) {
  const commission = commissionPct / 100;
  const softClearsFloor = softBookPrice >= minOdd;
  const exchangeCheap = exchangeLayPrice < fairOdd * (1 - commission);
  if (!softClearsFloor || !exchangeCheap) return { arbitrage: false, softClearsFloor, exchangeCheap };
  // Back on soft book at softBookPrice, lay same outcome on exchange at exchangeLayPrice.
  const layStake = stake * softBookPrice / exchangeLayPrice;
  const profitIfWins = stake * (softBookPrice - 1) - layStake * (exchangeLayPrice - 1);
  const profitIfLoses = layStake * (1 - commission) - stake;
  return {
    arbitrage: profitIfWins > 0 && profitIfLoses > 0,
    layStake: parseFloat(layStake.toFixed(2)),
    profitIfWins: parseFloat(profitIfWins.toFixed(2)),
    profitIfLoses: parseFloat(profitIfLoses.toFixed(2)),
  };
}

// ── 5) Exit rule: the minute after which the model's live_lo drops below
// 1/currentLayPrice — the "cut" minute for any open Over/back position.
function cutMinute(key, anchorLoP, favLine, favSide, currentLayPrice, opts = {}) {
  const isHalf2 = !isHalf1(key);
  const startMinute = isHalf1(key) ? 0 : 45;
  const endMinute = isHalf1(key) ? 44 : 90;
  const step = opts.stepMinutes || 1;
  const impliedFloor = 1 / currentLayPrice * 100;
  for (let m = startMinute; m <= endMinute; m += step) {
    const res = priceAt(key, anchorLoP, m, favLine, favSide, 0, 0);
    if (res.live_p == null) continue;
    if (res.live_p < impliedFloor) return m;
  }
  return null; // never crosses within the half — hold to the end
}

// ── Demo ──────────────────────────────────────────────────────────────────
function demo() {
  console.log('\n═══ Focus-bet exchange playbook — demo (Phase 6) ═══════════════════');
  const favLine = 0.25, favSide = 'HOME';

  console.log('\n1) Time-decay lay — under05_2H, HT anchor p=33%, lay Under05_2H @2.9, stake 10, commission 2%:');
  const td = timeDecayLay('under05_2H', 33, favLine, favSide, 2.9, 10, 2);
  for (const r of td.ladder) console.log(`   min ${String(r.minute).padStart(2)}: Over05_2H fair=${r.overFairPrice}  backToGreen=${r.backStakeToGreen}  P(Over)=${r.profitIfOver}  P(Under)=${r.profitIfUnder}`);
  console.log(`   Green-up minute: ${td.greenMinute ?? 'never within window'}`);

  console.log('\n2) Back-then-lay split — backed Over15_1H @2.4 stake 10, now layable @1.8:');
  console.log('   equal:', backThenLaySplit(2.4, 10, 1.8, 'equal'));
  console.log('   freebet:', backThenLaySplit(2.4, 10, 1.8, 'freebet'));

  console.log('\n3) Ladder entry — under05_2H anchor p=33%, stake 30 split 50/25/25 at HT/60/70:');
  const ladder = ladderEntry('under05_2H', 33, favLine, favSide, 30);
  for (const r of ladder.rungs) console.log(`   min ${r.minute}: price=${r.price ?? '—'} stake=${r.stake} live_p=${r.live_p ?? '—'}${r.note ? ' ' + r.note : ''}`);
  console.log(`   Blended price: ${ladder.blendedPrice?.toFixed(3)} vs single-entry ${ladder.singleEntryPrice}`);

  console.log('\n4) Book-vs-exchange arb check — soft 2.10 (min 1.95), exchange lay 1.85, fair 2.00, commission 2%, stake 10:');
  console.log('  ', bookVsExchangeArb(2.10, 1.95, 1.85, 2.00, 2, 10));

  console.log('\n5) Cut minute — under05_2H, lo anchor p=25%, current lay price 3.2:');
  console.log('   Cut at minute:', cutMinute('under05_2H', 25, favLine, favSide, 3.2));
}

module.exports = { timeDecayLay, backThenLaySplit, ladderEntry, bookVsExchangeArb, cutMinute };

if (require.main === module && process.argv.includes('--demo')) demo();
