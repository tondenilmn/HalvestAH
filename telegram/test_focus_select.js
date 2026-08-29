'use strict';
// Isolated unit test for focus_select.js — does NOT require notify.js (which
// has no require.main guard and runs a real live scan + sends real Telegram
// alerts as a side effect of being required). Only exercises the pure
// matching/pricing functions against synthetic data.

const focusSelect = require('./focus_select');
const focusLib = require('./focus_lib');

let failures = 0;
function check(label, cond) {
  console.log(`${cond ? 'OK  ' : 'FAIL'} ${label}`);
  if (!cond) failures++;
}

// ── findMatchingCell ────────────────────────────────────────────────────────
// Use the actual under05_2H survivor: fav 0.25/HOME, TL 2-2.5, OTHER tier,
// tl_move STABLE, over_move STABLE, HT 0-0 (from focus_configs.json).
const survivors = focusSelect.loadConfigs().results.under05_2H || [];
check('focus_configs.json has at least one under05_2H survivor', survivors.length > 0);

if (survivors.length) {
  const target = survivors.find(s => s.cellKey.startsWith('0.25|HOME|2-2.5|OTHER|STABLE|STABLE|0-0'));
  check('the expected 0.25/HOME/TL2-2.5/OTHER/STABLE/STABLE/HT0-0 cell exists', !!target);

  const matchCfgSignals = { favLine: 0.25, favSide: 'HOME', tlMove: 'STABLE', overMove: 'STABLE' };
  const odds = { tl_c: 2.25 }; // inside the 2-2.5 band
  const cell = focusSelect.findMatchingCell('under05_2H', matchCfgSignals, 'OTHER', odds, { favHt: 0, dogHt: 0 });
  check('findMatchingCell matches a live match with identical dims', !!cell && cell.cellKey === target.cellKey);

  // Mismatched tier should NOT match.
  const noMatch = focusSelect.findMatchingCell('under05_2H', matchCfgSignals, 'TOP', odds, { favHt: 0, dogHt: 0 });
  check('findMatchingCell returns null when tier differs (TOP vs OTHER)', noMatch === null);

  // Mismatched HT state should NOT match.
  const noMatchHt = focusSelect.findMatchingCell('under05_2H', matchCfgSignals, 'OTHER', odds, { favHt: 1, dogHt: 0 });
  check('findMatchingCell returns null when HT state differs (1-0fav vs 0-0)', noMatchHt === null);

  // A key with zero surviving cells should always return null.
  const noneForKey = focusSelect.findMatchingCell('over05_2H', matchCfgSignals, 'OTHER', odds, { favHt: 0, dogHt: 0 });
  check('findMatchingCell returns null for a key with no surviving cells (over05_2H)', noneForKey === null);
}

// ── equivalentRealMarketFocus2h ─────────────────────────────────────────────
const eqOver05 = focusSelect.equivalentRealMarketFocus2h('over05_2H', 1, 0);
check(`over05_2H at HT 1-0 (total 1) -> Over 1.5 FT (got ${eqOver05?.label})`, eqOver05?.label === 'Over 1.5 FT');

const eqUnder15 = focusSelect.equivalentRealMarketFocus2h('under15_2H', 0, 0);
check(`under15_2H at HT 0-0 (total 0) -> Under 1.5 FT (got ${eqUnder15?.label})`, eqUnder15?.label === 'Under 1.5 FT');

const eqOver15 = focusSelect.equivalentRealMarketFocus2h('over15_2H', 2, 1);
check(`over15_2H at HT 2-1 (total 3) -> Over 4.5 FT (got ${eqOver15?.label})`, eqOver15?.label === 'Over 4.5 FT');

const eqNone = focusSelect.equivalentRealMarketFocus2h('over05_1H', 0, 0);
check('equivalentRealMarketFocus2h returns null for a 1H key', eqNone === null);

console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
