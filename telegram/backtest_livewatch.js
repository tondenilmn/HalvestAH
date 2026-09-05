'use strict';
// Walk-forward validator/tuner for Strategy LIVEWATCH (notify.js/config.js's
// LIVEWATCH_* block). LIVEWATCH's own header comment says it's explicitly
// UNVALIDATED, unlike L123/LATEGOAL/QUIET2H — this script closes that gap
// the same way tune_l123.js validates L123: replay each held-out month's
// real match outcomes against what LIVEWATCH would have alerted on at its
// production trigger checkpoint, sweeping THRESHOLD_PCT / TIER / MIN_EDGE,
// and reporting claimed-vs-realized hit rate + coverage (alerts/month) per
// bucket — same acceptance bar used everywhere else in this codebase: pick
// the loosest config that stays well-calibrated, not just the one with the
// most alerts.
//
// CAVEAT — same limitation LATEGOAL's own header already documents: the
// Bet365 CSVs only carry HT/FT scores, not real per-minute goal data. The 4
// "Under" checkpoints (under05_1H @ kickoff, under05_2H/under15_2H @ HT) are
// exact — kickoff is always 0-0 and HT score is the row's own recorded HT
// score, so there is no ambiguity about the match state at the checkpoint.
// The 7 "Over" checkpoints (over05_1H/over15_1H/homeScored1H/awayScored1H @
// ~20', over05_2H/over15_2H/homeScored2H/awayScored2H @ ~70') can't be
// reconstructed exactly — whether a goal had ALREADY happened by the
// checkpoint minute isn't in the data. This script assumes every match
// reaches its Over checkpoint still scoreless-so-far in that half (the same
// state LIVEWATCH's own live code requires to still be "watching" a match),
// which is optimistic: a real deployment silently drops any match that
// already busted before the checkpoint, so real-world COVERAGE for these 7
// keys will be lower than what's reported here, though the hit-rate
// calibration is still meaningful conditional on that assumption.
//
// Usage:
//   node backtest_livewatch.js
//   BET365_DIR=<dir> node backtest_livewatch.js

const path = require('path');
const {
  loadDatasetDir, applyGameState, pct, wilsonCI,
} = require('./engine');
const { computeLiveOdd, computeLive1HOdd } = require('./live_odds');
const focusLib = require('./focus_lib');

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');

// ── Same TL-band bucketing LIVEWATCH itself uses (notify.js's TL_BANDS/tlBandOf) ──
const TL_BANDS = { '<2': [null, 2.0], '2-2.5': [2.0, 2.5], '2.5-3': [2.5, 3.0], '>3': [3.0, null] };
function inBand(v, band) {
  if (v == null || !band) return false;
  const [lo, hi] = band;
  return (lo == null || v >= lo) && (hi == null || v < hi);
}
function tlBandOf(v) { return Object.entries(TL_BANDS).find(([, b]) => inBand(v, b))?.[0] ?? null; }

function tierAllowed(rowTier, stratTier) {
  if (!stratTier || stratTier === 'ALL') return true;
  if (stratTier === 'TOP') return rowTier === 'TOP';
  if (stratTier === 'MAJOR') return rowTier === 'MAJOR';
  if (stratTier === 'TOP+MAJOR') return rowTier === 'TOP' || rowTier === 'MAJOR';
  return true;
}

const LIVEWATCH_EXTRA_HALF = { homeScored1H: '1H', awayScored1H: '1H', homeScored2H: '2H', awayScored2H: '2H' };
const LIVEWATCH_ALL_KEYS = [...focusLib.FOCUS_KEYS, ...Object.keys(LIVEWATCH_EXTRA_HALF)];
function halfOf(key) { return focusLib.FOCUS_HALF[key] || LIVEWATCH_EXTRA_HALF[key]; }
function isUnderKey(key) { return !!focusLib.FOCUS_IS_UNDER[key]; }

// Checkpoint minute per key = midpoint of its production trigger window
// (config.js LIVEWATCH_TRIGGER_WINDOW_*) — "typical" alert timing.
const CHECKPOINT_MIN = { '1H_OVER': 20, '1H_UNDER': 2, '2H_OVER': 70, '2H_UNDER': 45 };
function checkpointFor(key) { return CHECKPOINT_MIN[`${halfOf(key)}_${isUnderKey(key) ? 'UNDER' : 'OVER'}`]; }

// Mirrors notify.js's liveWatchBasePool — fav-line/side + closing-TL band,
// falling back to the line-only pool if the band is too thin.
function basePool(lineBase, tlBand, minN) {
  const band = lineBase.filter(r => tlBandOf(r.tl_c) === tlBand);
  return band.length >= minN ? band : lineBase;
}

// ── Settlement: every LIVEWATCH key is already a plain boolean field on the
// processed row (engine.js's processRow) — no market-equivalence needed here.
function settle(key, row) { return row[key] === true ? 1 : 0; }

// Memoized pct() by array identity — the pools above are now cached and
// reused by reference across many test rows, but pct() itself would still
// re-scan the same pool once per bet key per row without this.
const _pctCache = new WeakMap();
function pctMemo(rows, key) {
  let byKey = _pctCache.get(rows);
  if (!byKey) { byKey = new Map(); _pctCache.set(rows, byKey); }
  if (!byKey.has(key)) byKey.set(key, pct(rows, key));
  return byKey.get(key);
}

// Runs LIVEWATCH's actual two-gate logic (static edge + live-decayed CI
// lower bound) for one held-out month, against one (tier, threshold, minEdge)
// config. Returns per-key { n (fired), hits, claimedSum } so callers can
// compute hit-rate and claimed-vs-realized gap.
function runLiveWatchForMonth(testRows, histRows, cfg) {
  const perKey = {};
  for (const key of LIVEWATCH_ALL_KEYS) perKey[key] = { n: 0, hits: 0, claimedSum: 0 };

  const testPool = testRows.filter(r => tierAllowed(r.league_tier, cfg.TIER));

  // Cache line/side base pools per (fav_line, fav_side) — same rows get
  // reused across many test matches sharing that config.
  const lineBaseCache = new Map();
  function lineBase(favLine, favSide) {
    const k = `${favLine}|${favSide}`;
    if (!lineBaseCache.has(k)) {
      lineBaseCache.set(k, histRows.filter(r => r.fav_line === favLine && r.fav_side === favSide));
    }
    return lineBaseCache.get(k);
  }
  // Cache TL-band-narrowed pools per (fav_line, fav_side, tlBand) — this used
  // to be re-filtered from scratch for every single test row × key, which is
  // what made the naive version of this script too slow to finish.
  const bandPoolCache = new Map();
  function bandPool(favLine, favSide, tlBand) {
    const k = `${favLine}|${favSide}|${tlBand}`;
    if (!bandPoolCache.has(k)) {
      bandPoolCache.set(k, basePool(lineBase(favLine, favSide), tlBand, cfg.MIN_N));
    }
    return bandPoolCache.get(k);
  }
  // Cache HT-state-narrowed pools per (fav_line, fav_side, tlBand, homeHt, awayHt)
  // — same reasoning, this was the other O(n) refilter happening per row × key.
  const gsPoolCache = new Map();
  function gsPool(favLine, favSide, tlBand, homeHt, awayHt) {
    const k = `${favLine}|${favSide}|${tlBand}|${homeHt}|${awayHt}`;
    if (!gsPoolCache.has(k)) {
      const pool = bandPool(favLine, favSide, tlBand);
      gsPoolCache.set(k, applyGameState(pool, { trigger: 'HT', home_goals: String(homeHt), away_goals: String(awayHt) }));
    }
    return gsPoolCache.get(k);
  }

  for (const row of testPool) {
    const tlBand = tlBandOf(row.tl_c);
    const base = lineBase(row.fav_line, row.fav_side);
    if (base.length < cfg.MIN_N) continue;
    const pool = bandPool(row.fav_line, row.fav_side, tlBand);
    if (pool.length < cfg.MIN_N) continue;

    const homeHt = row.fav_side === 'HOME' ? row.fav_ht : row.dog_ht;
    const awayHt = row.fav_side === 'HOME' ? row.dog_ht : row.fav_ht;

    for (const key of LIVEWATCH_ALL_KEYS) {
      if (!cfg.KEYS.includes(key)) continue;
      const isHalf1 = halfOf(key) === '1H';
      const checkpoint = checkpointFor(key);

      let histP, histN, blP;
      if (isHalf1) {
        histP = pctMemo(pool, key); histN = pool.length;
        blP = pctMemo(base, key); // baseline: line/side only, before TL-band narrowing
      } else {
        const gsRows = gsPool(row.fav_line, row.fav_side, tlBand, homeHt, awayHt);
        if (gsRows.length < cfg.MIN_N) continue;
        histP = pctMemo(gsRows, key); histN = gsRows.length;
        blP = pctMemo(pool, key); // baseline: line/side + TL-band, before HT-state narrowing
      }

      const [lo] = wilsonCI(histP, histN);
      if ((lo - blP) < cfg.MIN_EDGE) continue;

      // Live-decay at the checkpoint minute, assuming the match is still
      // scoreless-so-far in the relevant half (see file header caveat) —
      // for the 4 exact "Under" checkpoints this assumption is always true.
      let liveOddLo;
      if (isHalf1) {
        liveOddLo = computeLive1HOdd(lo, key, checkpoint, row.fav_line, 0, 0);
      } else {
        liveOddLo = computeLiveOdd(lo, key, checkpoint, row.fav_line, 0, 0, row.fav_side);
      }
      if (liveOddLo.live_p == null || liveOddLo.live_p < cfg.THRESHOLD_PCT) continue;

      perKey[key].n++;
      perKey[key].hits += settle(key, row);
      perKey[key].claimedSum += liveOddLo.live_p;
    }
  }
  return perKey;
}

function mergeKeyStats(dst, src) {
  for (const key of LIVEWATCH_ALL_KEYS) {
    dst[key].n += src[key].n;
    dst[key].hits += src[key].hits;
    dst[key].claimedSum += src[key].claimedSum;
  }
}

function runWalkForward(full, testLabels, cfg, label) {
  console.log('═'.repeat(110));
  console.log(`CONFIG: ${label}  (TIER=${cfg.TIER} THRESHOLD_PCT=${cfg.THRESHOLD_PCT} MIN_EDGE=${cfg.MIN_EDGE} MIN_N=${cfg.MIN_N})`);
  console.log('═'.repeat(110));

  const pooled = {};
  for (const key of LIVEWATCH_ALL_KEYS) pooled[key] = { n: 0, hits: 0, claimedSum: 0 };

  for (const testLabel of testLabels) {
    const histRows = full.filter(r => !r.file_label.includes(testLabel));
    const testRows = full.filter(r => r.file_label.includes(testLabel));
    const perKey = runLiveWatchForMonth(testRows, histRows, cfg);
    mergeKeyStats(pooled, perKey);
  }

  let totalN = 0, totalHits = 0;
  console.log(`  ${'key'.padEnd(16)} ${'n/mo'.padStart(6)} ${'realized%'.padStart(10)} ${'claimed%'.padStart(9)} ${'gap'.padStart(6)}`);
  for (const key of LIVEWATCH_ALL_KEYS) {
    if (!cfg.KEYS.includes(key)) continue;
    const s = pooled[key];
    totalN += s.n; totalHits += s.hits;
    if (!s.n) { console.log(`  ${key.padEnd(16)} ${'0'.padStart(6)}        —         —      —`); continue; }
    const realized = s.hits / s.n * 100;
    const claimed = s.claimedSum / s.n;
    const gap = realized - claimed;
    const perMonth = (s.n / testLabels.length).toFixed(1);
    console.log(`  ${key.padEnd(16)} ${perMonth.padStart(6)} ${realized.toFixed(1).padStart(9)}% ${claimed.toFixed(1).padStart(8)}% ${(gap >= 0 ? '+' : '') + gap.toFixed(1)}`.padEnd(0));
  }
  const pooledRealized = totalN ? totalHits / totalN * 100 : 0;
  const pooledClaimed = totalN ? Object.values(pooled).reduce((s, v) => s + v.claimedSum, 0) / totalN : 0;
  console.log(`  ── pooled: alerts=${totalN} (${(totalN / testLabels.length).toFixed(1)}/mo)  realized%=${pooledRealized.toFixed(1)}  claimed%=${pooledClaimed.toFixed(1)}  gap=${(pooledRealized - pooledClaimed >= 0 ? '+' : '') + (pooledRealized - pooledClaimed).toFixed(1)}pp\n`);
  return { totalN, pooledRealized, pooledClaimed };
}

function main() {
  const raw = loadDatasetDir(BET365_DIR);
  console.log(`Loaded ${raw.length} rows from ${BET365_DIR}\n`);

  const fs = require('fs');
  const files = fs.readdirSync(BET365_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  const allLabels = files.map(f => path.basename(f, '.csv').replace('Bet365', ''));

  // Held-out months — same lock-box convention as tune_l123.js. Falls back
  // to all available labels if these specific two aren't present in the dir.
  let TEST_LABELS = ['_04_25', '_09_25'].filter(l => allLabels.includes(l));
  if (!TEST_LABELS.length) TEST_LABELS = allLabels;
  console.log(`Walk-forward test months: ${TEST_LABELS.join(', ')}\n`);

  const MIN_N = 50; // matches config.js's LIVEWATCH_MIN_N default

  const sweeps = [
    { TIER: 'TOP+MAJOR', THRESHOLD_PCT: 75, MIN_EDGE: 0, MIN_N, KEYS: LIVEWATCH_ALL_KEYS },
    { TIER: 'TOP+MAJOR', THRESHOLD_PCT: 70, MIN_EDGE: 0, MIN_N, KEYS: LIVEWATCH_ALL_KEYS },
    { TIER: 'TOP+MAJOR', THRESHOLD_PCT: 65, MIN_EDGE: 0, MIN_N, KEYS: LIVEWATCH_ALL_KEYS },
    { TIER: 'ALL',       THRESHOLD_PCT: 75, MIN_EDGE: 0, MIN_N, KEYS: LIVEWATCH_ALL_KEYS },
    { TIER: 'ALL',       THRESHOLD_PCT: 70, MIN_EDGE: 0, MIN_N, KEYS: LIVEWATCH_ALL_KEYS },
    { TIER: 'ALL',       THRESHOLD_PCT: 65, MIN_EDGE: 0, MIN_N, KEYS: LIVEWATCH_ALL_KEYS },
    { TIER: 'ALL',       THRESHOLD_PCT: 65, MIN_EDGE: 5, MIN_N, KEYS: LIVEWATCH_ALL_KEYS },
  ];

  const summary = [];
  for (const cfg of sweeps) {
    const label = `${cfg.TIER}, threshold=${cfg.THRESHOLD_PCT}%, minEdge=${cfg.MIN_EDGE}pp`;
    const { totalN, pooledRealized, pooledClaimed } = runWalkForward(raw, TEST_LABELS, cfg, label);
    summary.push({ label, totalN, pooledRealized, pooledClaimed, perMonth: totalN / TEST_LABELS.length });
  }

  console.log('═'.repeat(110));
  console.log('SUMMARY (sorted by alerts/month — pick the loosest config that keeps the gap small)');
  console.log('═'.repeat(110));
  for (const s of summary.sort((a, b) => b.perMonth - a.perMonth)) {
    const gap = s.pooledRealized - s.pooledClaimed;
    console.log(`  ${s.label.padEnd(38)} alerts/mo=${s.perMonth.toFixed(1).padStart(6)}  realized%=${s.pooledRealized.toFixed(1).padStart(5)}  claimed%=${s.pooledClaimed.toFixed(1).padStart(5)}  gap=${(gap >= 0 ? '+' : '') + gap.toFixed(1)}pp`);
  }
}

main();
