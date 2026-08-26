'use strict';
// Walk-forward backtest of the WEB UI's Live Games tab, specifically the
// HT-conditioned pick (analyzeLiveMatch's htBets/gsBets branch in
// static/app.js) — i.e. "if I'd watched this match live and acted on the
// tab's advised odds the moment HT hit, how would it have done?"
//
// Mirrors static/app.js exactly for the pieces that matter here:
//   - buildRawCfgFromLiveOdds's tier1/tier2 signal-stability cascade
//     (movement signals only activate when the matching tier-1 signal is
//     STABLE) — reproduced from the match's own historical
//     line_move/tl_move/fav_odds_move/... fields (processRow already
//     computes these).
//   - applyConfig / applyBaselineConfig / applyGameState('HT') / scoreBets
//     (all straight from engine.js, itself a direct port of app.js).
//   - qualifiesBet (z >= MIN_Z=1.5 AND Wilson-CI-lower clears baseline by
//     MIN_EDGE=0pp) and buildQualifyingList's bestScore ranking
//     (z * lo/100) to pick the "Top Pick" a user would actually see/act on.
//   - filterLiveScanBets's 2H-only key set (_LIVE_SCAN_2H_KEYS) — at HT
//     exactly (minute=45, past1H=true), only 2H markets are shown.
//   - The "advised odds" is bet.mo (fair value, 1/p) — the number the UI's
//     pick-odds badge shows ("Bet only if you can get at least this
//     price"), NOT the more conservative mo_lo.
//
// Walk-forward: the test month is fully excluded from the historical pool
// used to compute every bet's hit rate/edge (no lookahead). Both the
// training pool and the test matches are restricted to TOP+MAJOR leagues
// only, per the user's request.
//
// Usage: node backtest_live_ui_ht.js [testFileLabel]
//   e.g. node backtest_live_ui_ht.js Bet365_04_26

const fs = require('fs');
const path = require('path');
const {
  loadDatasetDir, applyConfig, applyBaselineConfig, applyGameState, scoreBets,
} = require('./engine');

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');
const TEST_LABEL = process.argv[2] || 'Bet365_04_26';

const MIN_N   = 15;   // DEFAULT_MIN_N in app.js
const MIN_Z   = 1.5;
const MIN_EDGE = 0;

const LINE_THRESH = 0.12;
const TL_THRESH   = 0.12;

const _LIVE_SCAN_2H_KEYS = new Set([
  'over05_2H', 'over15_2H', 'under05_2H', 'under15_2H',
  'homeScored2H', 'awayScored2H',
  'homeWins2H', 'awayWins2H', 'draw2H',
  'btts2H',
]);

function qualifiesBet(b) {
  return !!b && b.z >= MIN_Z && (b.lo - b.bl) >= MIN_EDGE;
}
function score(b) { return b ? b.z * (b.lo / 100) : -Infinity; }

function applyTier(rows) {
  return rows.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
}

// Reproduces buildRawCfgFromLiveOdds's tier1/tier2 cascade using the row's
// own (already-computed) historical signal fields, straight off processRow.
// Tier 1 (fav_line, fav_side, line_move) is always on. Tier 2
// (fav_odds_move/dog_odds_move, over_move/under_move) only activates when
// the matching tier-1 signal (line_move / tl_move) is STABLE.
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
  console.log(`Test month: ${TEST_LABEL}  (walk-forward — excluded from the historical pool)\n`);

  const histDb = full.filter(r => r.file_label !== TEST_LABEL);
  const testDb = full.filter(r => r.file_label === TEST_LABEL);
  console.log(`Historical pool (TOP+MAJOR, ex-test-month): ${histDb.length} rows`);
  console.log(`Test matches (TOP+MAJOR, ${TEST_LABEL}): ${testDb.length} rows\n`);

  const topPickEntries = [];   // one per match — the single bet the UI's Top Pick banner would show at HT
  const allQualEntries = [];   // every qualifying 2H bet at HT, across all matches
  let noHistory = 0, noHtPool = 0, noQualifier = 0;

  for (const row of testDb) {
    const cfg = buildCfgFromRow(row);

    const cfgRows = applyConfig(histDb, cfg);
    const baselineRows = applyBaselineConfig(histDb, cfg);
    const blSide = baselineRows.filter(r => r.fav_side === cfg.fav_side);
    if (cfgRows.length < MIN_N || !baselineRows.length) { noHistory++; continue; }

    // pre-match (no HT conditioning) — same signal-matched pool, no game state filter
    const preBetsAll = scoreBets(cfgRows, baselineRows, blSide, MIN_N);
    const preBets = filterLiveScanBets(preBetsAll);
    const preMap = new Map(preBets.map(b => [b.k, b]));

    // HT-conditioned — the actual historical HT scoreline this match reached
    const gs = { trigger: 'HT', home_goals: String(row.fav_side === 'HOME' ? row.fav_ht : row.dog_ht),
                 away_goals: String(row.fav_side === 'HOME' ? row.dog_ht : row.fav_ht) };
    const gsRows = applyGameState(cfgRows, gs);
    const gsBlRows = applyGameState(baselineRows, gs);
    const gsBlSide = applyGameState(blSide, gs);
    if (gsRows.length < MIN_N) { noHtPool++; continue; }

    const htBets = scoreBets(gsRows, gsBlRows, gsBlSide, MIN_N);
    const gsBets = filterLiveScanBets(htBets);
    const gsMap = new Map(gsBets.map(b => [b.k, b]));

    // buildQualifyingList's merge: for every 2H bet key, take whichever of
    // pre/gs qualifies with the higher CI-discounted score.
    const qualifying = [];
    for (const k of _LIVE_SCAN_2H_KEYS) {
      const pre = preMap.get(k) || null;
      const gsB = gsMap.get(k) || null;
      const prePass = qualifiesBet(pre);
      const gsPass = qualifiesBet(gsB);
      if (!prePass && !gsPass) continue;
      const winner = score(prePass ? pre : null) >= score(gsPass ? gsB : null) ? pre : gsB;
      qualifying.push(winner);
    }
    if (!qualifying.length) { noQualifier++; continue; }
    qualifying.sort((a, b) => score(b) - score(a));

    for (const bet of qualifying) {
      if (bet.mo == null) continue;
      allQualEntries.push({ key: bet.k, hit: row[bet.k] === true, mo: bet.mo, mo_lo: bet.mo_lo, mo_mid: bet.mo_mid, p: bet.p, n: bet.n });
    }
    const top = qualifying[0];
    if (top.mo != null) {
      topPickEntries.push({ key: top.k, hit: row[top.k] === true, mo: top.mo, mo_lo: top.mo_lo, mo_mid: top.mo_mid, p: top.p, n: top.n });
    }
  }

  console.log(`Matches skipped — insufficient signal-matched history: ${noHistory}`);
  console.log(`Matches skipped — insufficient same-HT-score history: ${noHtPool}`);
  console.log(`Matches skipped — no qualifying bet at HT: ${noQualifier}\n`);

  console.log('═'.repeat(90));
  console.log(`TOP PICK — the single bet the UI would show as its headline pick at HT (n=${topPickEntries.length} matches)`);
  console.log('═'.repeat(90));
  const tpFair = tally(topPickEntries, 'mo');
  const tpMid = tally(topPickEntries, 'mo_mid');
  const tpLo = tally(topPickEntries, 'mo_lo');
  console.log(`  n=${tpFair.n}  hit%=${tpFair.hitRate.toFixed(1)}%  ROI@advised(mo)=${(tpFair.roi >= 0 ? '+' : '') + tpFair.roi.toFixed(1)}%  ROI@safer-margin(mo_mid)=${(tpMid.roi >= 0 ? '+' : '') + tpMid.roi.toFixed(1)}%  ROI@conservative(mo_lo)=${(tpLo.roi >= 0 ? '+' : '') + tpLo.roi.toFixed(1)}%`);

  const byKeyTop = {};
  for (const e of topPickEntries) { (byKeyTop[e.key] = byKeyTop[e.key] || []).push(e); }
  console.log(`\n  Breakdown by bet key:`);
  for (const [k, entries] of Object.entries(byKeyTop).sort((a, b) => b[1].length - a[1].length)) {
    const tf = tally(entries, 'mo');
    const tm = tally(entries, 'mo_mid');
    console.log(`    ${k.padEnd(14)} n=${String(tf.n).padStart(4)}  hit%=${tf.hitRate.toFixed(1).padStart(5)}%  ROI@mo=${(tf.roi >= 0 ? '+' : '') + tf.roi.toFixed(1)}%  ROI@mo_mid=${(tm.roi >= 0 ? '+' : '') + tm.roi.toFixed(1)}%`);
  }

  console.log(`\n${'═'.repeat(90)}`);
  console.log(`ALL QUALIFYING 2H BETS AT HT (n=${allQualEntries.length} bet instances — several matches contribute >1)`);
  console.log('═'.repeat(90));
  const aqFair = tally(allQualEntries, 'mo');
  const aqMid = tally(allQualEntries, 'mo_mid');
  const aqLo = tally(allQualEntries, 'mo_lo');
  console.log(`  n=${aqFair.n}  hit%=${aqFair.hitRate.toFixed(1)}%  ROI@advised(mo)=${(aqFair.roi >= 0 ? '+' : '') + aqFair.roi.toFixed(1)}%  ROI@safer-margin(mo_mid)=${(aqMid.roi >= 0 ? '+' : '') + aqMid.roi.toFixed(1)}%  ROI@conservative(mo_lo)=${(aqLo.roi >= 0 ? '+' : '') + aqLo.roi.toFixed(1)}%`);

  const byKeyAll = {};
  for (const e of allQualEntries) { (byKeyAll[e.key] = byKeyAll[e.key] || []).push(e); }
  console.log(`\n  Breakdown by bet key:`);
  for (const [k, entries] of Object.entries(byKeyAll).sort((a, b) => b[1].length - a[1].length)) {
    const tf = tally(entries, 'mo');
    const tm = tally(entries, 'mo_mid');
    const tl = tally(entries, 'mo_lo');
    console.log(`    ${k.padEnd(14)} n=${String(tf.n).padStart(4)}  hit%=${tf.hitRate.toFixed(1).padStart(5)}%  ROI@mo=${(tf.roi >= 0 ? '+' : '') + tf.roi.toFixed(1)}%  ROI@mo_mid=${(tm.roi >= 0 ? '+' : '') + tm.roi.toFixed(1)}%  ROI@mo_lo=${(tl.roi >= 0 ? '+' : '') + tl.roi.toFixed(1)}%`);
  }
}

main();
