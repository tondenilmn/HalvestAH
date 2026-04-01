'use strict';
// ── Backtest — simulate notifier against last month's matches ─────────────────
// DB  = all rows whose file_label does NOT contain TEST_LABEL
// Test = rows whose file_label contains TEST_LABEL
//
// Usage:
//   node backtest.js            — TOP+MAJOR filter, current thresholds
//   node backtest.js --all      — no league tier filter
//   node backtest.js --verbose  — also print matches that did NOT trigger
//   node backtest.js --summary  — suppress individual alerts

const path = require('path');
const { loadDatabase, buildCfgFromMatch, applyConfig, applyBaselineConfig, applyGameState, scoreBets } = require('./engine');

const cfg = {
  LINE_MOVE_ON:     true,
  TL_MOVE_ON:       true,
  FAV_ODDS_ON:      false,
  DOG_ODDS_ON:      false,
  REQUIRE_MOVEMENT: true,
  MIN_N:            35,
  MIN_Z:            2.0,
  MIN_EDGE:         6,
  MIN_BASELINE:     25,
  LEAGUE_TIER:      process.argv.includes('--all') ? 'ALL' : 'TOP+MAJOR',
};

const VERBOSE  = process.argv.includes('--verbose');
const SUMMARY  = process.argv.includes('--summary');
const DATA_DIR = path.resolve(__dirname, '../static/data');
const TEST_LABEL = '_02_26_';

// ── Thresholds ─────────────────────────────────────────────────────────────────
const LINE_THRESH  = 0.13;
const TL_THRESH    = 0.13;
const BAYES_MIN_N  = 15;   // min rows per LR cell (hits and misses) to be reliable
const HT_MIN_N     = 15;   // min rows after HT game state filter

// ── Bet keys that use a side-filtered pool for their baseline ──────────────────
const FAV_SIDE_BASELINE = {
  homeWins2H:    'HOME', awayWins2H:    'AWAY',
  homeScored2H:  'HOME', awayScored2H:  'AWAY',
  homeOver15_2H: 'HOME', awayOver15_2H: 'AWAY',
  homeWins1H:    'HOME', awayWins1H:    'AWAY',
  homeWinsFT:    'HOME', awayWinsFT:    'AWAY',
};

// ── Bayesian engine (ported from static/app.js) ────────────────────────────────
function getDimValue(r, dim) {
  if (dim === 'lm')  return r.line_move;
  if (dim === 'om')  return r.fav_odds_move;
  if (dim === 'tlm') return r.tl_move;
  if (dim === 'ovm') return r.over_move;
  return null;
}

function computeBayesLRs(baseRows, betKeys) {
  const DIMS = ['lm', 'om', 'tlm', 'ovm'];
  const lrTable = {};

  for (const betKey of betKeys) {
    lrTable[betKey] = {};
    const pool   = FAV_SIDE_BASELINE[betKey]
      ? baseRows.filter(r => r.fav_side === FAV_SIDE_BASELINE[betKey])
      : baseRows;
    const hits   = pool.filter(r => r[betKey] === true);
    const misses = pool.filter(r => r[betKey] === false);

    for (const dim of DIMS) {
      const allVals = new Set(pool.map(r => getDimValue(r, dim)));
      const K = allVals.size || 1;
      lrTable[betKey][dim] = {};
      for (const v of allVals) {
        const hitsV   = hits.filter(r => getDimValue(r, dim) === v).length;
        const missesV = misses.filter(r => getDimValue(r, dim) === v).length;
        lrTable[betKey][dim][v] = (hitsV + 1) / (hits.length + K)
                                / ((missesV + 1) / (misses.length + K));
      }
    }
  }
  return lrTable;
}

function bayesianPosterior(baselineRate, lrTable, betKey, signals) {
  const safe = Math.max(0.001, Math.min(0.999, baselineRate));
  let logOdds = Math.log(safe / (1 - safe));
  const betLRs = lrTable[betKey];
  if (!betLRs) return { posterior: baselineRate, delta: 0 };
  for (const [dim, value] of Object.entries(signals)) {
    if (!value || value === 'UNKNOWN') continue;
    const lr = betLRs[dim]?.[value];
    if (!lr || lr <= 0) continue;
    logOdds += Math.log(lr);
  }
  const posterior = 1 / (1 + Math.exp(-logOdds));
  return { posterior, delta: posterior - baselineRate };
}

function checkBayesGate(baseRows, signals, betKey) {
  const pool = FAV_SIDE_BASELINE[betKey]
    ? baseRows.filter(r => r.fav_side === FAV_SIDE_BASELINE[betKey])
    : baseRows;
  if (!pool.length) return { pass: true, unreliable: true }; // can't judge — don't suppress

  const baselineRate = pool.filter(r => r[betKey] === true).length / pool.length;

  // Check reliability: any active signal cell < BAYES_MIN_N on hits OR misses → unreliable
  let unreliable = false;
  for (const [dim, value] of Object.entries(signals)) {
    if (!value || value === 'UNKNOWN') continue;
    const hits   = pool.filter(r => r[betKey] === true  && getDimValue(r, dim) === value).length;
    const misses = pool.filter(r => r[betKey] === false && getDimValue(r, dim) === value).length;
    if (hits < BAYES_MIN_N || misses < BAYES_MIN_N) { unreliable = true; break; }
  }

  if (unreliable) return { pass: true, unreliable: true }; // sparse data — don't suppress

  // Compute LR table just for this bet
  const lrTable = computeBayesLRs(baseRows, [betKey]);
  const { delta } = bayesianPosterior(baselineRate, lrTable, betKey, signals);

  return { pass: delta > 0, unreliable: false, delta: delta * 100 };
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function applyTier(db, tier) {
  if (tier === 'ALL') return db;
  if (tier === 'TOP')       return db.filter(r => r.league_tier === 'TOP');
  if (tier === 'MAJOR')     return db.filter(r => r.league_tier === 'MAJOR');
  if (tier === 'TOP+MAJOR') return db.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
  return db;
}

function rowToOdds(r) {
  if (r.fav_side === 'HOME') {
    return {
      ah_hc: -r.fav_lc, ah_ho: -r.fav_lo,
      ho_c: r.fav_oc,   ho_o: r.fav_oo,
      ao_c: r.dog_oc,   ao_o: r.dog_oo,
      tl_c: r.tl_c, tl_o: r.tl_o,
      ov_c: r.ov_c, ov_o: r.ov_o,
    };
  } else {
    return {
      ah_hc: r.fav_lc,  ah_ho: r.fav_lo,
      ho_c: r.dog_oc,   ho_o: r.dog_oo,
      ao_c: r.fav_oc,   ao_o: r.fav_oo,
      tl_c: r.tl_c, tl_o: r.tl_o,
      ov_c: r.ov_c, ov_o: r.ov_o,
    };
  }
}

function pct(n, d) { return d ? (n / d * 100).toFixed(0) : '0'; }
function avg(arr)  { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function printGateSummary(label, alerts) {
  const known     = alerts.filter(a => a.hit !== null && a.hit !== undefined);
  const hits      = known.filter(a => a.hit === true).length;
  const avgBl     = avg(known.map(a => a.b.bl));
  const actualPct = known.length ? parseFloat((hits / known.length * 100).toFixed(1)) : 0;

  // Flat betting at min odds: stake 1 unit per bet
  // win → profit of (mo - 1), loss → -1
  const pnl = known.reduce((sum, a) => {
    if (!a.b.mo) return sum;
    return sum + (a.hit === true ? a.b.mo - 1 : -1);
  }, 0);
  const staked   = known.filter(a => a.b.mo).length;
  const roi      = staked ? pnl / staked * 100 : 0;
  const avgOdds  = avg(known.filter(a => a.b.mo).map(a => a.b.mo));

  // Market-calibrated edge: actual hit rate vs what Pinnacle implied at close
  const mktKnown    = known.filter(a => a.b.mkt_bl != null);
  const avgMktBl    = mktKnown.length ? avg(mktKnown.map(a => a.b.mkt_bl)) : null;
  const mktHits     = mktKnown.filter(a => a.hit === true).length;
  const mktActualPct = mktKnown.length ? parseFloat((mktHits / mktKnown.length * 100).toFixed(1)) : null;
  const avgMktOdds  = mktKnown.length ? avg(mktKnown.map(a => a.b.mkt_avg_odds)).toFixed(2) : null;

  console.log(`  Alerts with outcome : ${known.length}`);
  console.log(`  Hit rate            : ${hits}/${known.length} = ${actualPct}%`);
  console.log(`  Avg naive baseline  : ${avgBl.toFixed(1)}%`);
  console.log(`  Edge vs naive bl    : ${(actualPct - avgBl).toFixed(1)}pp`);
  if (mktKnown.length) {
    console.log(`  ── Market-calibrated (n=${mktKnown.length} bets with market odds) ─`);
    console.log(`  Avg market implied  : ${avgMktBl.toFixed(1)}%  (avg Pinnacle odds ${avgMktOdds})`);
    console.log(`  Hit rate (mkt bets) : ${mktActualPct}%`);
    console.log(`  Edge vs market      : ${(mktActualPct - avgMktBl).toFixed(1)}pp`);
  }
  console.log(`  ── Flat bet @ min odds ──────────────────────────`);
  console.log(`  Avg min odds        : ${avgOdds.toFixed(2)}`);
  console.log(`  Units staked        : ${staked}`);
  console.log(`  P&L                 : ${pnl >= 0 ? '+' : ''}${pnl.toFixed(2)} units`);
  console.log(`  ROI                 : ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}%`);
  return { known: known.length, hits, actualPct, avgBl, pnl, roi, staked };
}

// ── Main ───────────────────────────────────────────────────────────────────────
function main() {
  console.log(`\nLoading full database from ${DATA_DIR}…`);
  const fullDb = loadDatabase(DATA_DIR);
  console.log(`Total rows: ${fullDb.length}`);

  const histDb   = fullDb.filter(r => !r.file_label.includes(TEST_LABEL));
  const testRows = fullDb.filter(r =>  r.file_label.includes(TEST_LABEL));
  const histTier = applyTier(histDb, cfg.LEAGUE_TIER);

  console.log(`Historical DB (excl. Feb26)   : ${histDb.length} rows`);
  console.log(`Historical DB (tier=${cfg.LEAGUE_TIER}) : ${histTier.length} rows`);
  console.log(`Test set (Feb 2026)           : ${testRows.length} matches`);

  let nChecked = 0, nPassedSignal = 0, nTriggered = 0;
  const alertsMA    = [];  // Match Analysis gate only (pre-match)
  const alertsBoth  = [];  // Match Analysis + Bayesian gate (pre-match)
  const alertsHT    = [];  // Match Analysis + HT game state filter
  let nSuppressedDelta = 0;
  let nKeptUnreliable  = 0;
  let nHtSkipped = 0;      // test rows missing HT data

  for (const testRow of testRows) {
    const odds = rowToOdds(testRow);
    const matchCfg = buildCfgFromMatch(odds, cfg);
    if (!matchCfg) continue;
    nChecked++;

    // Signal quality gate
    if (cfg.REQUIRE_MOVEMENT) {
      const s = matchCfg.signals;
      const hasMovement =
        (cfg.LINE_MOVE_ON && s.lineMove !== 'STABLE' && s.lineMove !== 'UNKNOWN') ||
        (cfg.TL_MOVE_ON   && s.tlMove   !== 'STABLE' && s.tlMove   !== 'UNKNOWN');
      if (!hasMovement) {
        if (VERBOSE) console.log(`  SKIP flat: ${testRow.home_team} vs ${testRow.away_team}`);
        continue;
      }
    }
    nPassedSignal++;

    const cfgRows = applyConfig(histTier, matchCfg);
    const blRows  = applyBaselineConfig(histTier, matchCfg);
    const blSide  = blRows.filter(r => r.fav_side === matchCfg.fav_side);
    const bets    = scoreBets(cfgRows, blRows, blSide, cfg.MIN_N);
    const qualifying = bets.filter(b =>
      b.z >= cfg.MIN_Z && b.edge >= cfg.MIN_EDGE &&
      b.n >= cfg.MIN_N && b.bl >= (cfg.MIN_BASELINE ?? 0)
    );

    if (!qualifying.length) continue;
    nTriggered++;

    // Build Bayesian base rows for this match (AH line + side + TL)
    const fl = parseFloat(matchCfg.fav_line);
    let bayesBase = histTier.filter(r => Math.abs(r.fav_line - fl) < LINE_THRESH);
    bayesBase = bayesBase.filter(r => r.fav_side === matchCfg.fav_side);
    if (testRow.tl_c != null) {
      bayesBase = bayesBase.filter(r => r.tl_c != null && Math.abs(r.tl_c - testRow.tl_c) < TL_THRESH);
    }

    // Derive signals from matchCfg + testRow (over_move not in matchCfg.signals)
    const s = matchCfg.signals;
    const signals = {};
    if (s.lineMove    !== 'UNKNOWN') signals.lm  = s.lineMove;
    if (s.favOddsMove !== 'UNKNOWN') signals.om  = s.favOddsMove;
    if (s.tlMove      !== 'UNKNOWN') signals.tlm = s.tlMove;
    if (testRow.over_move && testRow.over_move !== 'UNKNOWN') signals.ovm = testRow.over_move;

    for (const b of qualifying) {
      const alert = { row: testRow, matchCfg, b, hit: testRow[b.k] };
      alertsMA.push(alert);

      // Bayesian gate
      if (!bayesBase.length) {
        // No base rows to compute LR — don't suppress
        alertsBoth.push({ ...alert, bayesNote: 'no-base' });
        nKeptUnreliable++;
        continue;
      }
      const { pass, unreliable, delta } = checkBayesGate(bayesBase, signals, b.k);

      if (unreliable) {
        // Sparse LR cells — can't confirm or deny, keep alert
        alertsBoth.push({ ...alert, bayesNote: 'unreliable' });
        nKeptUnreliable++;
      } else if (pass) {
        alertsBoth.push({ ...alert, bayesNote: `delta+${delta?.toFixed(1)}pp` });
      } else {
        nSuppressedDelta++;
        if (VERBOSE) {
          console.log(`  BAYES SUPPRESS [delta≤0]: ${testRow.home_team} vs ${testRow.away_team}  → ${b.label}`);
        }
      }
    }

    // ── HT game state pass ──────────────────────────────────────────────────
    // Re-score using actual HT score from test row as game state filter.
    // Uses HT_MIN_N (15) as lower bar since HT filter reduces sample.
    const favHt = testRow.fav_ht;
    const dogHt = testRow.dog_ht;
    if (favHt == null || dogHt == null || isNaN(favHt) || isNaN(dogHt)) {
      nHtSkipped++;
    } else {
      // Convert fav/dog HT goals → home/away for applyGameState
      const homeGoals = matchCfg.fav_side === 'HOME' ? favHt : dogHt;
      const awayGoals = matchCfg.fav_side === 'HOME' ? dogHt : favHt;
      const gs = { trigger: 'HT', home_goals: homeGoals, away_goals: awayGoals };

      const htRows      = applyGameState(cfgRows, gs);
      if (htRows.length >= HT_MIN_N) {
        const htBets      = scoreBets(htRows, blRows, blSide, HT_MIN_N);
        const htQualifying = htBets.filter(b =>
          b.z >= cfg.MIN_Z && b.edge >= cfg.MIN_EDGE &&
          b.n >= HT_MIN_N  && b.bl >= (cfg.MIN_BASELINE ?? 0)
        );
        for (const b of htQualifying) {
          alertsHT.push({ row: testRow, matchCfg, b, hit: testRow[b.k],
                          htScore: `${homeGoals}-${awayGoals}` });
        }
      }
    }
  }

  // ── Print results ──────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  console.log(`BACKTEST RESULTS — Feb 2026 as test set  (tier=${cfg.LEAGUE_TIER})`);
  console.log('═'.repeat(72));
  console.log(`Matches processed        : ${nChecked}`);
  console.log(`Passed signal gate       : ${nPassedSignal}  (${pct(nPassedSignal, nChecked)}% of processed)`);
  console.log(`Would have triggered     : ${nTriggered}  (${pct(nTriggered, nPassedSignal)}% of signal-passed)`);
  console.log(`Total alerts (MA only)   : ${alertsMA.length}`);
  console.log(`Total alerts (MA+Bayes)  : ${alertsBoth.length}`);
  console.log(`  Suppressed (delta ≤ 0) : ${nSuppressedDelta}`);
  console.log(`  Kept (unreliable LR)   : ${nKeptUnreliable}`);
  console.log(`Total alerts (MA + HT)   : ${alertsHT.length}`);
  console.log(`  Test rows missing HT   : ${nHtSkipped}`);

  if (!alertsMA.length) {
    console.log('\n⚠  No alerts. Try:');
    console.log('   node backtest.js --all       (removes league tier filter)');
    console.log('   node backtest.js --all --verbose');
    return;
  }

  // ── Gate 1: Match Analysis only ─────────────────────────────────────────────
  console.log('\n── Gate 1: Match Analysis only ────────────────────────────────────────');
  const g1 = printGateSummary('MA', alertsMA);

  // ── Gate 2: Match Analysis + Bayesian ───────────────────────────────────────
  console.log('\n── Gate 2: Match Analysis + Bayesian (delta > 0, sparse kept) ─────────');
  const g2 = printGateSummary('MA+Bayes', alertsBoth);

  // ── Gate 3: Match Analysis + HT game state ───────────────────────────────────
  console.log('\n── Gate 3: Match Analysis + HT score filter (MIN_N=15) ─────────────────');
  const g3 = printGateSummary('MA+HT', alertsHT);

  // ── Delta ────────────────────────────────────────────────────────────────────
  console.log('\n── Bayesian gate impact ────────────────────────────────────────────────');
  console.log(`  Alert reduction   : ${alertsMA.length} → ${alertsBoth.length}  (−${alertsMA.length - alertsBoth.length}, −${pct(alertsMA.length - alertsBoth.length, alertsMA.length)}%)`);
  console.log(`  Hit rate change   : ${g1.actualPct}% → ${g2.actualPct}%  (${(g2.actualPct - g1.actualPct) >= 0 ? '+' : ''}${(g2.actualPct - g1.actualPct).toFixed(1)}pp)`);
  console.log(`  Edge change       : +${(g1.actualPct - g1.avgBl).toFixed(1)}pp → +${(g2.actualPct - g2.avgBl).toFixed(1)}pp`);
  console.log(`  P&L change        : ${g1.pnl >= 0 ? '+' : ''}${g1.pnl.toFixed(2)} → ${g2.pnl >= 0 ? '+' : ''}${g2.pnl.toFixed(2)} units`);
  console.log(`  ROI change        : ${g1.roi >= 0 ? '+' : ''}${g1.roi.toFixed(1)}% → ${g2.roi >= 0 ? '+' : ''}${g2.roi.toFixed(1)}%`);
  console.log('\n── HT gate vs pre-match ────────────────────────────────────────────────');
  console.log(`  Alert change      : ${alertsMA.length} → ${alertsHT.length}  (${alertsHT.length - alertsMA.length >= 0 ? '+' : ''}${alertsHT.length - alertsMA.length})`);
  console.log(`  Hit rate change   : ${g1.actualPct}% → ${g3.actualPct}%  (${(g3.actualPct - g1.actualPct) >= 0 ? '+' : ''}${(g3.actualPct - g1.actualPct).toFixed(1)}pp)`);
  console.log(`  Edge change       : +${(g1.actualPct - g1.avgBl).toFixed(1)}pp → +${(g3.actualPct - g3.avgBl).toFixed(1)}pp`);
  console.log(`  P&L change        : ${g1.pnl >= 0 ? '+' : ''}${g1.pnl.toFixed(2)} → ${g3.pnl >= 0 ? '+' : ''}${g3.pnl.toFixed(2)} units`);
  console.log(`  ROI change        : ${g1.roi >= 0 ? '+' : ''}${g1.roi.toFixed(1)}% → ${g3.roi >= 0 ? '+' : ''}${g3.roi.toFixed(1)}%`);

  // ── Per-bet summary (both gates) ─────────────────────────────────────────────
  if (!SUMMARY) {
    for (const [label, alerts] of [['MA only', alertsMA], ['MA + Bayesian', alertsBoth], ['MA + HT score', alertsHT]]) {
      const byBet = new Map();
      for (const a of alerts) {
        if (!byBet.has(a.b.k)) byBet.set(a.b.k, []);
        byBet.get(a.b.k).push(a);
      }
      console.log(`\n── Per-bet summary (${label}) ────────────────────────────────────────`);
      const betSummary = [...byBet.entries()]
        .map(([k, alts]) => {
          const hits  = alts.filter(a => a.hit === true).length;
          const total = alts.length;
          const mktAlts = alts.filter(a => a.b.mkt_bl != null && a.hit !== null && a.hit !== undefined);
          const mktHits = mktAlts.filter(a => a.hit === true).length;
          const avgMktBl = mktAlts.length ? avg(mktAlts.map(a => a.b.mkt_bl)) : null;
          const mktPct   = mktAlts.length ? mktHits / mktAlts.length * 100 : null;
          return { label: alts[0].b.label, count: total, hits,
                   avgZ: avg(alts.map(a => a.b.z)), avgEdge: avg(alts.map(a => a.b.edge)),
                   mktAlts: mktAlts.length, mktPct, avgMktBl };
        })
        .sort((a, b) => b.count - a.count);
      for (const s of betSummary) {
        const hitStr = `${s.hits}/${s.count} hit (${pct(s.hits, s.count)}%)`;
        const mktStr = s.mktAlts
          ? `  vs-mkt ${(s.mktPct - s.avgMktBl).toFixed(1)}pp (${s.mktPct.toFixed(0)}% vs mkt ${s.avgMktBl.toFixed(0)}%)`
          : '';
        console.log(`  ${s.label.padEnd(24)} ×${String(s.count).padStart(2)}  z̄=${s.avgZ.toFixed(1)}  edge̅=+${s.avgEdge.toFixed(1)}pp  ${hitStr}${mktStr}`);
      }
    }
  }
}

main();
