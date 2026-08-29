'use strict';
// ── Strategy FOCUS — live selection (PLAN_FOCUS_BETS.md Phase 5) ─────────────
// Pure matching/pricing/staking logic for the 7 in-scope 1T/2T Over/Under
// bets. notify.js wires this into the scan loop (runStrategyFocusPreMatch /
// runStrategyFocusHt) the same way every other strategy there works —
// this module has no Telegram/dedup/track-record code of its own, just the
// "does this live match match a validated config, and if so at what price"
// logic, kept separate so it's independently testable.
//
// Design, following BETTING_EDGE_ANALYSIS.md's "Focus bets" findings
// (2026-08-29): unlike HTPICK/DASHBOARD (which argmax over many candidates
// live and therefore need cross-fit pricing to avoid winner's-curse), FOCUS's
// candidate set was already fixed OFFLINE by focus_config_search.js's
// walk-forward+cross-fit search — at alert time there's no argmax, just "does
// this match hit one of the pre-validated cells", so a single-pool historical
// estimate at alert time is enough (same shape as QUIET2H/LATEGOAL).
//
// IMPORTANT: focus_configs.json currently has very few surviving cells (see
// BETTING_EDGE_ANALYSIS.md) — most of the 7 keys have NO validated config at
// all. This module only ever proposes a key/cell combination that appears in
// focus_configs.json; it does not fall back to an unvalidated guess.

const path = require('path');
const lib = require('./focus_lib');
const { wilsonCI } = require('./engine');

const MIN_LIVE_N = 50; // floor for the live production pool (_dbAll) backing a matched cell

// Parses a cellKey (built by focus_lib.compositeKey) back into its filter
// dimensions, purely for display in alert messages.
function parseCellKey(cellKey, isHalf2) {
  const parts = cellKey.split('|');
  const [fav_line, fav_side, tl_band, tier, tl_move, over_move, ht_state] = parts;
  const out = { fav_line, fav_side, tl_band, tier, tl_move, over_move };
  if (isHalf2) out.ht_state = ht_state;
  return out;
}

// Loads focus_configs.json once per process (notify.js runs long-lived, so
// this is cached — re-run focus_config_search.js and restart notify.js to
// pick up a refreshed set of validated cells).
let _configsCache = null;
function loadConfigs() {
  if (_configsCache) return _configsCache;
  _configsCache = lib.loadFocusConfigs();
  return _configsCache;
}

// Live match's fav_line/fav_side/tl_move/over_move come from
// engine.buildCfgFromMatch's `signals` (always computed there regardless of
// which cfg_flags are on) — this function just re-buckets them the same way
// focus_lib.compositeKey buckets a historical row, then does a plain string
// match against every validated cellKey for the given key.
function findMatchingCell(key, matchCfgSignals, tier, odds, htState) {
  const isHalf2 = lib.FOCUS_HALF[key] === '2H';
  const liveRow = {
    fav_line: matchCfgSignals.favLine,
    fav_side: matchCfgSignals.favSide,
    tl_c: odds.tl_c,
    league_tier: tier,
    tl_move: matchCfgSignals.tlMove,
    over_move: matchCfgSignals.overMove,
    fav_ht: htState ? htState.favHt : undefined,
    dog_ht: htState ? htState.dogHt : undefined,
  };
  const liveKey = lib.compositeKey(liveRow, isHalf2);
  const survivors = (loadConfigs().results || {})[key] || [];
  const match = survivors.find(s => s.cellKey === liveKey);
  return match ? { ...match, isHalf2, filters: parseCellKey(match.cellKey, isHalf2) } : null;
}

// Recomputes p/lo fresh from the live production pool (_dbAll, the same
// dataset every other strategy in notify.js prices against) rather than
// reusing focus_configs.json's own pooled stats (which were computed from
// CrossBooks/Bet365_Data_months — a different, offline dataset used only for
// research). Returns null if the live pool is too thin.
function priceCellLive(dbAll, key, cellKey, isHalf2) {
  const pool = dbAll.filter(r => lib.compositeKey(r, isHalf2) === cellKey);
  if (pool.length < MIN_LIVE_N) return null;
  const hits = pool.filter(r => lib.outcome(r, key)).length;
  const p = hits / pool.length * 100;
  const [lo, hi] = wilsonCI(p, pool.length);
  return { n: pool.length, hits, p, lo, hi };
}

// Generalized equivalence to a real, directly-quotable FT Over/Under market —
// only valid for the 2H keys fired AT HT (current score == HT snapshot, no 2H
// goals possible yet). Same trick as notify.js's equivalentRealMarket
// (LATEGOAL) / equivalentRealMarketQuiet2h, generalized to all 4 2H keys:
//   overNH_2H (>=k more 2H goals)  == Over  (currentTotal + k - 0.5) FT
//   underNH_2H (<=k-1 more goals)  == Under (currentTotal + k - 0.5) FT
// where k is the bet's own goal threshold (1 for the "0.5" line, 2 for "1.5").
const _THRESHOLD_2H = { over05_2H: 1, over15_2H: 2, under05_2H: 1, under15_2H: 2 };
function equivalentRealMarketFocus2h(betKey, htHome, htAway) {
  const total = htHome + htAway;
  const k = _THRESHOLD_2H[betKey];
  if (k == null) return null;
  const line = total + k - 0.5;
  const isOver = betKey.startsWith('over');
  return {
    apiKey: isOver ? 'overTL' : 'underTL',
    avgTl: line,
    label: `${isOver ? 'Over' : 'Under'} ${line} FT`,
  };
}

module.exports = {
  MIN_LIVE_N,
  loadConfigs,
  findMatchingCell,
  priceCellLive,
  equivalentRealMarketFocus2h,
  parseCellKey,
};
