'use strict';
// Strategy 6 — apply to yesterday's games (2026-04-03)
// Uses Pinnacle_03_04_26.csv as test set + Bet365_03_04_26.csv for B365 gate.
// Historical DB: all data in static/data/ (these CSVs are NOT in the DB).
//
// B365 gate: for each qualifying bet, Bet365 closing odds must exceed
// the historical Pinnacle average odds (mkt_avg_odds) — same as live notify.
//
// Settlement: quarter-line aware (same as backtest_mkt.js).

const fs   = require('fs');
const path = require('path');
const Papa = require('papaparse');

const {
  loadDatabase, processRow: _processRow, buildCfgFromMatch,
  applyConfig, applyBaselineConfig, scoreBets,
} = require('./engine');

// ── Config (mirrors notify.js S6 settings) ────────────────────────────────────
const MKT_EDGE_THRESH = 10;    // pp above market implied
const MKT_EDGE_MIN_N  = 35;    // min signal pool size
const MIN_Z           = 1.5;   // min z-score (same as backtest_mkt.js)
const MKT_KEYS        = new Set(['ahCover', 'dogCover', 'overTL', 'underTL']);
const TIER            = 'ALL'; // Strategy 6 default

const PINNACLE_CSV = path.resolve('D:/BET/Pinnacle_Data_months/Pinnacle_10_25.csv');
const BET365_CSV   = path.resolve('D:/BET/Bet365_Data_months/Bet365_10_25.csv');
const DATA_DIR     = path.resolve(__dirname, '../static/data');

// ── Helpers ───────────────────────────────────────────────────────────────────
function sf(v) { const n = parseFloat(String(v == null ? '' : v).trim()); return isNaN(n) ? null : n; }
function avg(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function pct(a, b) { return b ? (a / b * 100).toFixed(1) : '0.0'; }

// Parse and normalise a row from the external CSV files.
// Returns null if the row is invalid (no score, missing odds, etc.).
function parseExternalRow(row) {
  // Re-use processRow from engine by faking fileLabel = 'test'
  // But processRow is not exported. Instead, use Papa-parsed row directly.
  // We replicate the minimal logic needed for S6.
  const sf2 = v => { const n = parseFloat(String(v == null ? '' : v).trim()); return isNaN(n) ? null : n; };
  const parseScore = s => {
    s = String(s || '').trim();
    if (!s.includes('-')) return [null, null];
    const [a, b] = s.split('-').map(Number);
    return (isNaN(a) || isNaN(b)) ? [null, null] : [a, b];
  };

  const ahHc = sf2(row['Home AH Closing']);
  const ahHo = sf2(row['Home AH Opening']);
  const hoC  = sf2(row['Home Odds Closing']);
  const hoO  = sf2(row['Home Odds Opening']);
  const aoC  = sf2(row['Away Odds Closing']);
  const aoO  = sf2(row['Away Odds Opening']);
  const tlC  = sf2(row['Total Line Closing']);
  const tlO  = sf2(row['Total Line Opening']);
  const ovC  = sf2(row['Over Odds Closing']);
  const ovO  = sf2(row['Over Odds Opening']);
  const unC  = sf2(row['Under Odds Closing']);
  const unO  = sf2(row['Under Odds Opening']);

  if ([ahHc, ahHo, hoC, hoO, aoC, aoO].some(v => v === null)) return null;

  const [htH, htA] = parseScore(row['HT Result']);
  const [ftH, ftA] = parseScore(row['FT Result']);
  if (htH === null || ftH === null) return null;

  return {
    league:    String(row['League']    || '').trim(),
    homeTeam:  String(row['Home Team'] || '').trim(),
    awayTeam:  String(row['Away Team'] || '').trim(),
    date:      String(row['Date']      || '').trim(),
    // Odds for strategy engine
    odds: { ah_hc: ahHc, ah_ho: ahHo, ho_c: hoC, ho_o: hoO, ao_c: aoC, ao_o: aoO,
            tl_c: tlC, tl_o: tlO, ov_c: ovC, ov_o: ovO, un_c: unC, un_o: unO },
    // Raw fields for settlement
    ahHc, htH, htA, ftH, ftA, tlC, hoC, aoC, ovC, unC,
  };
}

// Derive fav side + line from odds (same logic as engine.js buildCfgFromMatch prerequisite)
function getFavSide(odds) {
  const { ah_hc, ho_c, ao_c } = odds;
  if (ah_hc == null) return null;
  if (ah_hc < -0.01) return 'HOME';
  if (ah_hc >  0.01) return 'AWAY';
  return (ho_c != null && ao_c != null && ho_c <= ao_c) ? 'HOME' : 'AWAY';
}

// Build b365 object (mirrors _parseBet365Odds return shape) from CSV row
function bet365FromRow(row) {
  return {
    hoC: sf(row['Home Odds Closing']),
    aoC: sf(row['Away Odds Closing']),
    ovC: sf(row['Over Odds Closing']),
    unC: sf(row['Under Odds Closing']),
  };
}

// Get B365 odds for a specific bet key (mirrors getB365OddsForBet in notify.js)
function getB365OddsForBet(betKey, b365, favSide) {
  if (!b365) return null;
  if (betKey === 'ahCover')  return favSide === 'HOME' ? b365.hoC : b365.aoC;
  if (betKey === 'dogCover') return favSide === 'HOME' ? b365.aoC : b365.hoC;
  if (betKey === 'overTL')   return b365.ovC ?? null;
  if (betKey === 'underTL')  return b365.unC ?? null;
  return null;
}

// Quarter-line settlement (same as backtest_mkt.js)
function settlement(margin) {
  if (margin >  0.49) return  1.0;
  if (margin >  0.01) return  0.5;
  if (margin > -0.01) return  0.0;
  if (margin > -0.49) return -0.5;
  return -1.0;
}

function computeSettlement(betKey, row, favSide) {
  const favHt = favSide === 'HOME' ? row.htH : row.htA;
  const dogHt = favSide === 'HOME' ? row.htA : row.htH;
  const favFt = favSide === 'HOME' ? row.ftH : row.ftA;
  const dogFt = favSide === 'HOME' ? row.ftA : row.ftH;

  // fav line from matchCfg
  const favLc = Math.abs(row.ahHc);
  const fav2h = favFt - favHt;
  const dog2h = dogFt - dogHt;
  const ah2h  = fav2h - dog2h - favLc;
  const total = row.ftH + row.ftA;

  switch (betKey) {
    case 'ahCover':  return settlement(ah2h);
    case 'dogCover': return settlement(-ah2h);
    case 'overTL':   return row.tlC != null ? settlement(total - row.tlC) : null;
    case 'underTL':  return row.tlC != null ? settlement(row.tlC - total) : null;
    default: return null;
  }
}

function settlePnl(fraction, odds) {
  if (fraction ===  1.0) return +(odds - 1);
  if (fraction ===  0.5) return +(odds - 1) / 2;
  if (fraction ===  0.0) return 0;
  if (fraction === -0.5) return -0.5;
  return -1.0;
}

function settlementLabel(f) {
  if (f ===  1.0) return 'full_win';
  if (f ===  0.5) return 'half_win';
  if (f ===  0.0) return 'push';
  if (f === -0.5) return 'half_loss';
  return 'full_loss';
}

// ── Load CSVs ─────────────────────────────────────────────────────────────────
function loadExternalCsv(filepath) {
  const csv = fs.readFileSync(filepath, 'utf8');
  const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true });
  return data;
}

// Build index key for matching games between Pinnacle and Bet365 CSVs
function matchKey(row) {
  const league = String(row['League']    || '').trim().toLowerCase();
  const home   = String(row['Home Team'] || '').trim().toLowerCase();
  const away   = String(row['Away Team'] || '').trim().toLowerCase();
  return `${league}|${home}|${away}`;
}

// ── Print results ─────────────────────────────────────────────────────────────
function printResults(label, alerts) {
  const nonPush = alerts.filter(a => a.fraction !== 0.0 && a.fraction !== null);
  const pushes  = alerts.filter(a => a.fraction === 0.0);

  const full_wins = alerts.filter(a => a.fraction ===  1.0).length;
  const half_wins = alerts.filter(a => a.fraction ===  0.5).length;
  const push_n    = pushes.length;
  const half_loss = alerts.filter(a => a.fraction === -0.5).length;
  const full_loss = alerts.filter(a => a.fraction === -1.0).length;

  const hitPoints = full_wins * 1 + half_wins * 0.5;
  const hitRate   = nonPush.length ? (hitPoints / nonPush.length * 100) : 0;

  const mktArr   = nonPush.filter(a => a.b.mkt_bl != null);
  const avgMktBl = mktArr.length ? avg(mktArr.map(a => a.b.mkt_bl)) : 0;

  const pnlFair  = nonPush.reduce((s, a) => s + settlePnl(a.fraction, a.b.mo), 0);
  const roiFair  = nonPush.length ? pnlFair / nonPush.length * 100 : 0;

  const mktPnl   = mktArr.reduce((s, a) => s + settlePnl(a.fraction, a.b.mkt_avg_odds), 0);
  const roiMkt   = mktArr.length ? mktPnl / mktArr.length * 100 : 0;
  const avgMktO  = mktArr.length ? avg(mktArr.map(a => a.b.mkt_avg_odds)) : 0;

  console.log(`\n── ${label} ──────────────────────────────────────────────────────`);
  console.log(`  Total alerts       : ${alerts.length}`);
  console.log(`  Settlement split   : ${full_wins} full wins · ${half_wins} half wins · ${push_n} pushes · ${half_loss} half losses · ${full_loss} full losses`);
  console.log(`  Non-push bets      : ${nonPush.length}`);
  console.log(`  Hit rate (adj)     : ${hitPoints.toFixed(1)} pts / ${nonPush.length} = ${hitRate.toFixed(1)}%  (full=1pt, half=0.5pt)`);
  console.log(`  Avg market implied : ${avgMktBl.toFixed(1)}%`);
  console.log(`  Edge vs market     : ${(hitRate - avgMktBl).toFixed(1)}pp`);
  console.log(`  ── P&L at fair min odds (excl. pushes) ─────────────────────`);
  console.log(`  Avg fair odds      : ${avg(nonPush.map(a => a.b.mo)).toFixed(2)}`);
  console.log(`  P&L                : ${pnlFair >= 0 ? '+' : ''}${pnlFair.toFixed(2)} units on ${nonPush.length} bets`);
  console.log(`  ROI                : ${roiFair >= 0 ? '+' : ''}${roiFair.toFixed(1)}%`);
  if (mktArr.length) {
    console.log(`  ── P&L at Pinnacle avg odds (excl. pushes) ─────────────────`);
    console.log(`  Avg Pinnacle odds  : ${avgMktO.toFixed(2)}`);
    console.log(`  P&L                : ${mktPnl >= 0 ? '+' : ''}${mktPnl.toFixed(2)} units on ${mktArr.length} bets`);
    console.log(`  ROI                : ${roiMkt >= 0 ? '+' : ''}${roiMkt.toFixed(1)}%`);
  }

  // Per-bet breakdown
  const byBet = new Map();
  for (const a of alerts) {
    if (!byBet.has(a.b.k)) byBet.set(a.b.k, []);
    byBet.get(a.b.k).push(a);
  }
  if (byBet.size > 1) {
    console.log(`\n  Per-bet breakdown (excl. pushes):`);
    console.log(`  ${'Bet'.padEnd(14)} ${'N'.padStart(4)} ${'FW'.padStart(4)} ${'HW'.padStart(4)} ${'P'.padStart(3)} ${'HL'.padStart(4)} ${'FL'.padStart(4)} ${'Hit%'.padStart(6)} ${'MktBl%'.padStart(7)} ${'Edge'.padStart(6)} ${'MktOdds'.padStart(8)} ${'ROI@Mkt'.padStart(8)}`);
    for (const [k, arr] of [...byBet.entries()].sort((a,b) => b[1].length - a[1].length)) {
      const np   = arr.filter(a => a.fraction !== 0.0);
      const fw   = arr.filter(a => a.fraction ===  1.0).length;
      const hw   = arr.filter(a => a.fraction ===  0.5).length;
      const p    = arr.filter(a => a.fraction ===  0.0).length;
      const hl   = arr.filter(a => a.fraction === -0.5).length;
      const fl   = arr.filter(a => a.fraction === -1.0).length;
      const hp   = np.length ? ((fw + hw * 0.5) / np.length * 100).toFixed(1) : '—';
      const mktA = np.filter(a => a.b.mkt_bl != null);
      const bl   = mktA.length ? avg(mktA.map(a => a.b.mkt_bl)).toFixed(1) : '—';
      const edge = mktA.length ? ((fw + hw * 0.5) / np.length * 100 - avg(mktA.map(a => a.b.mkt_bl))).toFixed(1) : '—';
      const mo   = mktA.length ? avg(mktA.map(a => a.b.mkt_avg_odds)).toFixed(2) : '—';
      const rp   = mktA.reduce((s, a) => s + settlePnl(a.fraction, a.b.mkt_avg_odds), 0);
      const roi  = mktA.length ? (rp / mktA.length * 100).toFixed(1) : '—';
      console.log(`  ${k.padEnd(14)} ${String(arr.length).padStart(4)} ${String(fw).padStart(4)} ${String(hw).padStart(4)} ${String(p).padStart(3)} ${String(hl).padStart(4)} ${String(fl).padStart(4)} ${String(hp).padStart(5)}% ${String(bl).padStart(6)}% ${String(edge).padStart(5)}pp ${String(mo).padStart(8)} ${String(roi).padStart(7)}%`);
    }
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const verbose = process.argv.includes('--verbose');

  console.log(`\nLoading historical DB from ${DATA_DIR}…`);
  const histDb = loadDatabase(DATA_DIR);
  console.log(`Historical DB rows: ${histDb.length}`);
  // Strategy 6 uses ALL leagues
  const db = histDb; // no tier filter for S6

  console.log(`\nLoading test CSVs…`);
  const pinnacleRaw = loadExternalCsv(PINNACLE_CSV);
  const bet365Raw   = loadExternalCsv(BET365_CSV);
  console.log(`Pinnacle rows: ${pinnacleRaw.length}  |  Bet365 rows: ${bet365Raw.length}`);

  // Build Bet365 index by match key
  const b365Index = new Map();
  for (const row of bet365Raw) {
    const key = matchKey(row);
    b365Index.set(key, row);
  }

  // Parse Pinnacle test rows
  const testRows = [];
  for (const row of pinnacleRaw) {
    const parsed = parseExternalRow(row);
    if (parsed) testRows.push(parsed);
  }
  console.log(`Pinnacle rows parsed: ${testRows.length} (of ${pinnacleRaw.length} raw)`);

  let nChecked = 0, nMovement = 0, nQualifying = 0, nB365Pass = 0, nB365Fail = 0, nB365NA = 0;
  const alerts       = [];  // bets that passed B365 gate
  const alertsNoB365 = [];  // qualifying bets before B365 gate (for comparison)

  for (const testRow of testRows) {
    const { odds, league, homeTeam, awayTeam, date } = testRow;
    const label = `${homeTeam} vs ${awayTeam} (${league})`;

    const matchCfg = buildCfgFromMatch(odds, { LINE_MOVE_ON: true, TL_MOVE_ON: true });
    if (!matchCfg) continue;
    nChecked++;

    // Require movement (same as runStrategy6 in notify.js)
    const { signals } = matchCfg;
    const hasMovement =
      (signals.lineMove !== 'STABLE' && signals.lineMove !== 'UNKNOWN') ||
      (signals.tlMove   !== 'STABLE' && signals.tlMove   !== 'UNKNOWN');

    if (!hasMovement) {
      if (verbose) console.log(`  SKIP [no movement]  ${label}`);
      continue;
    }
    nMovement++;

    const cfgRows = applyConfig(db, matchCfg);
    const blRows  = applyBaselineConfig(db, matchCfg);
    const blSide  = blRows.filter(r => r.fav_side === matchCfg.fav_side);
    const bets    = scoreBets(cfgRows, blRows, blSide, MKT_EDGE_MIN_N);

    const qualifying = bets.filter(b =>
      MKT_KEYS.has(b.k) &&
      b.mkt_edge != null &&
      b.mkt_edge >= MKT_EDGE_THRESH &&
      b.n >= MKT_EDGE_MIN_N &&
      b.z >= MIN_Z
    );

    if (!qualifying.length) {
      if (verbose) console.log(`  no qualifying bets  ${label}  pool=${cfgRows.length}`);
      continue;
    }
    nQualifying++;

    // Record all qualifying bets (before B365 gate) for comparison
    for (const b of qualifying) {
      const fraction = computeSettlement(b.k, testRow, matchCfg.fav_side);
      alertsNoB365.push({ label, league, homeTeam, awayTeam, date, matchCfg, b, fraction });
    }

    // B365 gate: look up Bet365 row for this match
    const key = `${league.toLowerCase()}|${homeTeam.toLowerCase()}|${awayTeam.toLowerCase()}`;
    const b365Row = b365Index.get(key);
    const b365    = b365Row ? bet365FromRow(b365Row) : null;

    const toFire = qualifying.filter(b => {
      const b365Odds = getB365OddsForBet(b.k, b365, matchCfg.fav_side);
      if (b365Odds == null) { nB365NA++; return true; } // no B365 data → fire anyway
      if (b365Odds > b.mkt_avg_odds) { nB365Pass++; return true; }
      nB365Fail++;
      if (verbose) console.log(`  B365 SKIP [${b.k}] b365=${b365Odds.toFixed(2)} <= mkt_avg=${b.mkt_avg_odds}  ${label}`);
      return false;
    });

    if (!toFire.length) continue;

    console.log(`ALERT → ${label}  pool=${cfgRows.length}  bets=${toFire.map(b => b.k).join(',')}  lm=${signals.lineMove}  tlm=${signals.tlMove}`);

    for (const b of toFire) {
      const fraction = computeSettlement(b.k, testRow, matchCfg.fav_side);
      const b365Odds = getB365OddsForBet(b.k, b365, matchCfg.fav_side);
      const result   = settlementLabel(fraction);
      const favTeam  = matchCfg.fav_side === 'HOME' ? homeTeam : awayTeam;
      const dogTeam  = matchCfg.fav_side === 'HOME' ? awayTeam : homeTeam;
      console.log(`  ${b.k.padEnd(14)}  ${favTeam} −${Number(matchCfg.fav_line).toFixed(2)} vs ${dogTeam}  mkt_edge=+${b.mkt_edge.toFixed(1)}pp  z=${b.z.toFixed(2)}  n=${b.n}  mkt_avg=${b.mkt_avg_odds}  b365=${b365Odds != null ? b365Odds.toFixed(2) : 'n/a'}  → ${result}`);
      alerts.push({ label, league, homeTeam, awayTeam, date, matchCfg, b, fraction, b365Odds });
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  console.log(`STRATEGY 6 — Yesterday's Games (2026-04-03)  tier=${TIER}`);
  console.log(`Gate: mkt_edge ≥ ${MKT_EDGE_THRESH}pp | MIN_N=${MKT_EDGE_MIN_N} | MIN_Z=${MIN_Z} | REQUIRE_MOVEMENT=true`);
  console.log(`Bet365 gate: B365 odds must exceed Pinnacle historical avg`);
  console.log('═'.repeat(72));
  console.log(`Test rows parsed         : ${testRows.length}`);
  console.log(`Matches checked          : ${nChecked}`);
  console.log(`Passed movement gate     : ${nMovement}  (${pct(nMovement, nChecked)}%)`);
  console.log(`Passed mkt_edge gate     : ${nQualifying}  (${pct(nQualifying, nMovement)}% of movement-passed)`);
  console.log(`Total qualifying bets    : ${alertsNoB365.length}  (before B365 gate)`);
  console.log(`B365 passed              : ${nB365Pass}  |  failed: ${nB365Fail}  |  no B365 data: ${nB365NA}`);
  console.log(`Final alerts (after B365): ${alerts.length}`);

  if (!alertsNoB365.length) {
    console.log('\n⚠  No qualifying bets before B365 gate.');
    return;
  }

  printResults(`All bets — PRE B365 gate  (mkt_edge ≥ ${MKT_EDGE_THRESH}pp)`, alertsNoB365);

  if (alerts.length) {
    printResults(`All bets — POST B365 gate`, alerts);

    for (const k of MKT_KEYS) {
      const sub = alerts.filter(a => a.b.k === k);
      if (sub.length) printResults(k, sub);
    }
  } else {
    console.log('\n⚠  All qualifying bets filtered out by B365 gate.');
  }
}

main();
