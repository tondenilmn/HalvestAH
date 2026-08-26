'use strict';
// Sweep test for a shrinkage-based fix to the Live Games HT selection
// procedure (see the walk-forward findings in backtest_live_ui_ht.js — the
// UI's displayed "advised odds" (bet.mo) loses money OOS because the winning
// bet is chosen by argmax over ~10-20 noisy small-n candidates per match,
// which systematically overstates whichever one wins ("winner's curse").
// mo_lo (Wilson CI lower bound) discounts the PRICE after the fact but
// doesn't change WHICH bet wins the argmax.
//
// This script tests shrinking every candidate's p toward baseline BEFORE
// ranking/selecting, not just before pricing:
//     p_shrunk = (n*p + k*bl) / (n+k)
// i.e. blend in k phantom baseline-rate observations — a noisy small-n cell
// gets pulled hard toward bl (so it stops winning the argmax by luck), a
// robust large-n cell barely moves. k=0 reproduces today's behaviour
// (equivalent to backtest_live_ui_ht.js's "mo" column).
//
// For each k in the sweep: re-rank the SAME per-match candidate set (the one
// that already passes today's qualifiesBet gate — z>=1.5, Wilson-CI-lower
// clears baseline) by shrunk score, take the new argmax winner, price it at
// mo_shrunk = 1/p_shrunk, and settle against the real outcome. Reports
// whether shrinkage actually changes which bet wins (not just its price) and
// whether ROI@mo_shrunk improves OOS.
//
// Usage: node backtest_live_ui_shrink_sweep.js [testFileLabel] [k1,k2,...]
//   e.g. node backtest_live_ui_shrink_sweep.js Bet365_04_26 0,10,20,40,80

const fs = require('fs');
const path = require('path');
const {
  loadDatasetDir, applyConfig, applyBaselineConfig, applyGameState, scoreBets, minOdds,
} = require('./engine');

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');
const TEST_LABEL = process.argv[2] || 'Bet365_04_26';
const K_SWEEP = (process.argv[3] || '0,10,20,40,80').split(',').map(Number);

const MIN_N = 15;   // DEFAULT_MIN_N in app.js
const MIN_Z = 1.5;
const MIN_EDGE = 0;

const _LIVE_SCAN_2H_KEYS = new Set([
  'over05_2H', 'over15_2H', 'under05_2H', 'under15_2H',
  'homeScored2H', 'awayScored2H',
  'homeWins2H', 'awayWins2H', 'draw2H',
  'btts2H',
]);

function qualifiesBet(b) {
  return !!b && b.z >= MIN_Z && (b.lo - b.bl) >= MIN_EDGE;
}
// today's ranking score (unchanged) — used only to decide the qualifying
// set and gate membership, same as backtest_live_ui_ht.js.
function baseScore(b) { return b ? b.z * (b.lo / 100) : -Infinity; }

function applyTier(rows) {
  return rows.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
}

function buildCfgFromRow(row) {
  const lineStable = row.line_move === 'STABLE';
  const tlStable = row.tl_move === 'STABLE';
  return {
    fav_line: row.fav_line,
    fav_side: row.fav_side,
    line_move: row.line_move,
    fav_odds_move: lineStable ? row.fav_odds_move : 'ANY',
    dog_odds_move: lineStable ? row.dog_odds_move : 'ANY',
    over_move: tlStable ? row.over_move : 'ANY',
    under_move: tlStable ? row.under_move : 'ANY',
    tl_c: row.tl_c != null ? row.tl_c : null,
  };
}

function filterLiveScanBets(bets) {
  return bets ? bets.filter(b => _LIVE_SCAN_2H_KEYS.has(b.k)) : bets;
}

function tally(entries, priceKey) {
  const n = entries.length;
  const hits = entries.filter(e => e.hit).length;
  const hitRate = n ? hits / n * 100 : 0;
  const pnl = entries.reduce((s, e) => s + (e.hit ? e[priceKey] - 1 : -1), 0);
  const roi = n ? pnl / n * 100 : 0;
  return { n, hits, hitRate, pnl, roi };
}

// p_shrunk = blend in k phantom observations at the baseline rate.
function pShrunk(b, k) {
  if (!k) return b.p;
  return (b.n * b.p + k * b.bl) / (b.n + k);
}
function shrinkScore(b, k) {
  if (!b) return -Infinity;
  return b.z * (pShrunk(b, k) / 100);
}

function main() {
  const files = fs.readdirSync(BET365_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  const allLabels = files.map(f => path.basename(f, '.csv'));
  if (!allLabels.includes(TEST_LABEL)) {
    console.error(`Unknown test month "${TEST_LABEL}". Available: ${allLabels.join(', ')}`);
    process.exit(1);
  }

  const raw = loadDatasetDir(BET365_DIR);
  const full = applyTier(raw);
  console.log(`Loaded ${raw.length} rows total, TOP+MAJOR: ${full.length} rows`);
  console.log(`Test month: ${TEST_LABEL}  (walk-forward — excluded from the historical pool)`);
  console.log(`k sweep: ${K_SWEEP.join(', ')}\n`);

  const histDb = full.filter(r => r.file_label !== TEST_LABEL);
  const testDb = full.filter(r => r.file_label === TEST_LABEL);
  console.log(`Historical pool (TOP+MAJOR, ex-test-month): ${histDb.length} rows`);
  console.log(`Test matches (TOP+MAJOR, ${TEST_LABEL}): ${testDb.length} rows\n`);

  // ── Pass 1: build the per-match candidate set once (k-independent) ────────
  // candidates[i] = { row, list: [betObj, ...] } — the qualifying 2H bets
  // (today's gate) for this match, deduped pre-vs-gs per key exactly like
  // buildQualifyingList, keeping BOTH raw fields (p, bl, n, z, lo) needed to
  // compute p_shrunk for any k afterwards.
  const matchCandidates = [];
  let noHistory = 0, noHtPool = 0, noQualifier = 0;

  for (const row of testDb) {
    const cfg = buildCfgFromRow(row);
    const cfgRows = applyConfig(histDb, cfg);
    const baselineRows = applyBaselineConfig(histDb, cfg);
    const blSide = baselineRows.filter(r => r.fav_side === cfg.fav_side);
    if (cfgRows.length < MIN_N || !baselineRows.length) { noHistory++; continue; }

    const preBetsAll = scoreBets(cfgRows, baselineRows, blSide, MIN_N);
    const preBets = filterLiveScanBets(preBetsAll);
    const preMap = new Map(preBets.map(b => [b.k, b]));

    const gs = { trigger: 'HT', home_goals: String(row.fav_side === 'HOME' ? row.fav_ht : row.dog_ht),
                 away_goals: String(row.fav_side === 'HOME' ? row.dog_ht : row.fav_ht) };
    const gsRows = applyGameState(cfgRows, gs);
    const gsBlRows = applyGameState(baselineRows, gs);
    const gsBlSide = applyGameState(blSide, gs);
    if (gsRows.length < MIN_N) { noHtPool++; continue; }

    const htBets = scoreBets(gsRows, gsBlRows, gsBlSide, MIN_N);
    const gsBets = filterLiveScanBets(htBets);
    const gsMap = new Map(gsBets.map(b => [b.k, b]));

    const qualifying = [];
    for (const k of _LIVE_SCAN_2H_KEYS) {
      const pre = preMap.get(k) || null;
      const gsB = gsMap.get(k) || null;
      const prePass = qualifiesBet(pre);
      const gsPass = qualifiesBet(gsB);
      if (!prePass && !gsPass) continue;
      const winner = baseScore(prePass ? pre : null) >= baseScore(gsPass ? gsB : null) ? pre : gsB;
      qualifying.push(winner);
    }
    if (!qualifying.length) { noQualifier++; continue; }
    matchCandidates.push({ row, list: qualifying });
  }

  console.log(`Matches skipped — insufficient signal-matched history: ${noHistory}`);
  console.log(`Matches skipped — insufficient same-HT-score history: ${noHtPool}`);
  console.log(`Matches skipped — no qualifying bet at HT: ${noQualifier}`);
  console.log(`Matches with a qualifying candidate set: ${matchCandidates.length}\n`);

  // ── Pass 2: sweep k, re-rank each match's candidate set by shrinkScore ────
  const baselineWinners = new Map(); // matchIdx -> winning key at k=0, for "did the pick change" diagnostics

  for (const k of K_SWEEP) {
    const topPickEntries = [];
    let changedFromBaseline = 0;

    matchCandidates.forEach(({ row, list }, idx) => {
      const ranked = [...list].sort((a, b) => shrinkScore(b, k) - shrinkScore(a, k));
      const top = ranked[0];
      const pShr = pShrunk(top, k);
      const moShrunk = minOdds(pShr);
      if (moShrunk == null) return;

      if (k === 0) baselineWinners.set(idx, top.k);
      else if (baselineWinners.get(idx) !== top.k) changedFromBaseline++;

      topPickEntries.push({ key: top.k, hit: row[top.k] === true, mo_shrunk: moShrunk, p_shrunk: pShr, n: top.n });
    });

    const t = tally(topPickEntries, 'mo_shrunk');
    const changePct = k === 0 ? 0 : (changedFromBaseline / topPickEntries.length * 100);
    const avgMo = topPickEntries.reduce((s, e) => s + e.mo_shrunk, 0) / topPickEntries.length;
    console.log('═'.repeat(90));
    console.log(`k=${k}${k === 0 ? '  (= today\'s behaviour, no shrinkage)' : ''}`);
    console.log('═'.repeat(90));
    console.log(`  n=${t.n}  hit%=${t.hitRate.toFixed(1)}%  ROI@mo_shrunk=${(t.roi >= 0 ? '+' : '') + t.roi.toFixed(1)}%  avg required price=${avgMo.toFixed(2)}  picks changed vs k=0: ${changePct.toFixed(1)}%`);

    const byKey = {};
    for (const e of topPickEntries) { (byKey[e.key] = byKey[e.key] || []).push(e); }
    const keyLine = Object.entries(byKey)
      .sort((a, b) => b[1].length - a[1].length)
      .map(([key, entries]) => `${key}=${entries.length}`)
      .join(', ');
    console.log(`  pick distribution: ${keyLine}\n`);
  }
}

main();
