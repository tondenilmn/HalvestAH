'use strict';
// Market-calibrated backtest — mkt_edge >= 15pp, May 2025 as test set
// Proper quarter-line and push settlement for AH and TL bets.
//
// Settlement rules (margin = actual - line):
//   > 0.49  → FULL_WIN  (full profit)
//   > 0.01  → HALF_WIN  (half wins at odds, half refunded)  → (odds-1)/2
//   > -0.01 → PUSH      (refund, excluded from P&L)
//   > -0.49 → HALF_LOSS (half refunded, half lost)          → -0.5
//   else    → FULL_LOSS  → -1
//
// For dogCover: margin_dog = -(fav2h - dog2h - fav_line)
// For ahCover:  margin_fav =  (fav2h - dog2h - fav_line)
// For overTL:   margin_over = (fav_ft + dog_ft) - tl_c
// For underTL:  margin_under = tl_c - (fav_ft + dog_ft)

const path = require('path');
const { loadDatabase, buildCfgFromMatch, applyConfig, applyBaselineConfig, scoreBets } = require('./engine');

const cfg = {
  LINE_MOVE_ON:     true,
  TL_MOVE_ON:       true,
  FAV_ODDS_ON:      false,
  DOG_ODDS_ON:      false,
  REQUIRE_MOVEMENT: true,
  MIN_N:            35,
  MIN_Z:            1.5,
  LEAGUE_TIER:      process.argv.includes('--all') ? 'ALL' : 'TOP+MAJOR',
};

const MKT_EDGE_THRESH = 10;
const MKT_KEYS = new Set(['ahCover', 'dogCover', 'overTL', 'underTL']);
const DATA_DIR   = path.resolve(__dirname, '../static/data');
const TEST_LABEL = '_03_25_';

function avg(arr) { return arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : 0; }
function pct(a, b) { return b ? (a / b * 100).toFixed(1) : '0.0'; }

function applyTier(rows, tier) {
  if (tier === 'ALL') return rows;
  if (tier === 'TOP')       return rows.filter(r => r.league_tier === 'TOP');
  if (tier === 'TOP+MAJOR') return rows.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
  return rows;
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

// Returns settlement fraction from the BET's perspective:
//   1.0 = full win, 0.5 = half win, 0 = push, -0.5 = half loss, -1 = full loss
function settlement(margin) {
  if (margin >  0.49) return  1.0;
  if (margin >  0.01) return  0.5;
  if (margin > -0.01) return  0.0;
  if (margin > -0.49) return -0.5;
  return -1.0;
}

function computeSettlement(betKey, testRow) {
  const ah2h = testRow.fav_2h - testRow.dog_2h - testRow.fav_line;
  const total = testRow.fav_ft + testRow.dog_ft;
  switch (betKey) {
    case 'ahCover':  return settlement(ah2h);
    case 'dogCover': return settlement(-ah2h);
    case 'overTL':   return testRow.tl_c != null ? settlement(total - testRow.tl_c) : null;
    case 'underTL':  return testRow.tl_c != null ? settlement(testRow.tl_c - total) : null;
    default: return null;
  }
}

function settlePnl(fraction, odds) {
  if (fraction ===  1.0) return +(odds - 1);
  if (fraction ===  0.5) return +(odds - 1) / 2;
  if (fraction ===  0.0) return 0;          // push: stake returned
  if (fraction === -0.5) return -0.5;       // half loss
  return -1.0;                               // full loss
}

function settlementLabel(f) {
  if (f ===  1.0) return 'full_win';
  if (f ===  0.5) return 'half_win';
  if (f ===  0.0) return 'push';
  if (f === -0.5) return 'half_loss';
  return 'full_loss';
}

function printResults(label, alerts) {
  // Exclude pushes from P&L denominator
  const nonPush = alerts.filter(a => a.fraction !== 0.0 && a.fraction !== null);
  const pushes  = alerts.filter(a => a.fraction === 0.0);

  // Settlement breakdown
  const full_wins  = alerts.filter(a => a.fraction ===  1.0).length;
  const half_wins  = alerts.filter(a => a.fraction ===  0.5).length;
  const push_n     = pushes.length;
  const half_loss  = alerts.filter(a => a.fraction === -0.5).length;
  const full_loss  = alerts.filter(a => a.fraction === -1.0).length;

  // Hit rate: full wins count 1, half wins count 0.5, excl pushes
  const hitPoints = full_wins * 1 + half_wins * 0.5;
  const hitRate   = nonPush.length ? (hitPoints / nonPush.length * 100) : 0;

  // Market implied (excl pushes)
  const mktArr    = nonPush.filter(a => a.b.mkt_bl != null);
  const avgMktBl  = mktArr.length ? avg(mktArr.map(a => a.b.mkt_bl)) : 0;

  // P&L at fair min odds
  const pnlFair = nonPush.reduce((s, a) => s + settlePnl(a.fraction, a.b.mo), 0);
  const roiFair = nonPush.length ? pnlFair / nonPush.length * 100 : 0;

  // P&L at Pinnacle avg odds
  const mktPnl  = mktArr.reduce((s, a) => s + settlePnl(a.fraction, a.b.mkt_avg_odds), 0);
  const roiMkt  = mktArr.length ? mktPnl / mktArr.length * 100 : 0;
  const avgMktO = mktArr.length ? avg(mktArr.map(a => a.b.mkt_avg_odds)) : 0;

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

function main() {
  console.log(`\nLoading database from ${DATA_DIR}…`);
  const fullDb = loadDatabase(DATA_DIR);
  console.log(`Total rows: ${fullDb.length}`);

  const histDb   = fullDb.filter(r => !r.file_label.includes(TEST_LABEL));
  const testRows = fullDb.filter(r =>  r.file_label.includes(TEST_LABEL));
  const histTier = applyTier(histDb, cfg.LEAGUE_TIER);
  const testTier = applyTier(testRows, cfg.LEAGUE_TIER);

  console.log(`Historical DB (excl. May25)   : ${histDb.length} rows`);
  console.log(`Historical DB (tier=${cfg.LEAGUE_TIER}) : ${histTier.length} rows`);
  console.log(`Test set (May 2025)           : ${testRows.length} rows`);
  console.log(`Test set after tier filter    : ${testTier.length} rows`);

  let nChecked = 0, nPassedSignal = 0, nTriggered = 0;
  const alerts = [];

  for (const testRow of testTier) {
    const odds = rowToOdds(testRow);
    const matchCfg = buildCfgFromMatch(odds, cfg);
    if (!matchCfg) continue;
    nChecked++;

    if (cfg.REQUIRE_MOVEMENT) {
      const s = matchCfg.signals;
      const hasMovement =
        (cfg.LINE_MOVE_ON && s.lineMove !== 'STABLE' && s.lineMove !== 'UNKNOWN') ||
        (cfg.TL_MOVE_ON   && s.tlMove   !== 'STABLE' && s.tlMove   !== 'UNKNOWN');
      if (!hasMovement) continue;
    }
    nPassedSignal++;

    const cfgRows = applyConfig(histTier, matchCfg);
    const blRows  = applyBaselineConfig(histTier, matchCfg);
    const blSide  = blRows.filter(r => r.fav_side === matchCfg.fav_side);
    const bets    = scoreBets(cfgRows, blRows, blSide, cfg.MIN_N);

    const qualifying = bets.filter(b =>
      MKT_KEYS.has(b.k) &&
      b.mkt_edge != null &&
      b.mkt_edge >= MKT_EDGE_THRESH &&
      b.n >= cfg.MIN_N &&
      b.z >= cfg.MIN_Z
    );

    if (!qualifying.length) continue;
    nTriggered++;

    for (const b of qualifying) {
      const fraction = computeSettlement(b.k, testRow);
      alerts.push({ row: testRow, matchCfg, b, fraction });
    }
  }

  console.log('\n' + '═'.repeat(72));
  console.log(`MARKET-CALIBRATED BACKTEST — May 2025  (tier=${cfg.LEAGUE_TIER})`);
  console.log(`Gate: mkt_edge ≥ ${MKT_EDGE_THRESH}pp | MIN_N=${cfg.MIN_N} | MIN_Z=${cfg.MIN_Z}`);
  console.log(`Settlement: quarter-line aware (half win/loss) + push handling`);
  console.log('═'.repeat(72));
  console.log(`Matches checked          : ${nChecked}`);
  console.log(`Passed signal gate       : ${nPassedSignal}  (${pct(nPassedSignal, nChecked)}%)`);
  console.log(`Would have triggered     : ${nTriggered}  (${pct(nTriggered, nPassedSignal)}% of signal-passed)`);
  console.log(`Total alerts             : ${alerts.length}`);

  if (!alerts.length) {
    console.log('\n⚠  No alerts generated.');
    return;
  }

  printResults(`All market bets  (mkt_edge ≥ ${MKT_EDGE_THRESH}pp)`, alerts);

  for (const k of MKT_KEYS) {
    const sub = alerts.filter(a => a.b.k === k);
    if (sub.length) printResults(k, sub);
  }
}

main();
