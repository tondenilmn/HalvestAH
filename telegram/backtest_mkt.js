'use strict';
// Market-calibrated backtest — mkt_edge >= 15pp, May 2025 as test set
// Only the 4 bets with direct market odds: ahCover, dogCover, overTL, underTL

const path = require('path');
const { loadDatabase, buildCfgFromMatch, applyConfig, applyBaselineConfig, scoreBets } = require('./engine');

const cfg = {
  LINE_MOVE_ON:     true,
  TL_MOVE_ON:       true,
  FAV_ODDS_ON:      false,
  DOG_ODDS_ON:      false,
  REQUIRE_MOVEMENT: true,
  MIN_N:            35,
  MIN_Z:            1.5,   // softer — mkt_edge is the primary gate
  MIN_EDGE:         0,     // not used as primary gate here
  MIN_BASELINE:     0,
  LEAGUE_TIER:      process.argv.includes('--all') ? 'ALL' : 'TOP+MAJOR',
};

const MKT_EDGE_THRESH = 15;  // pp above market implied
const MKT_KEYS = new Set(['ahCover', 'dogCover', 'overTL', 'underTL']);
const DATA_DIR  = path.resolve(__dirname, '../static/data');
const TEST_LABEL = '_05_25_';

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

function printResults(label, alerts) {
  const known = alerts.filter(a => a.hit !== null && a.hit !== undefined);
  const hits  = known.filter(a => a.hit === true).length;
  const actualPct = known.length ? (hits / known.length * 100) : 0;

  // P&L at fair min odds (historical)
  const pnlFair = known.reduce((s, a) => s + (a.hit ? a.b.mo - 1 : -1), 0);
  const roiFair = known.length ? pnlFair / known.length * 100 : 0;

  // P&L at Pinnacle avg odds (market reference)
  const mktKnown = known.filter(a => a.b.mkt_avg_odds != null);
  const pnlMkt   = mktKnown.reduce((s, a) => s + (a.hit ? a.b.mkt_avg_odds - 1 : -1), 0);
  const roiMkt   = mktKnown.length ? pnlMkt / mktKnown.length * 100 : 0;
  const avgMktBl = mktKnown.length ? avg(mktKnown.map(a => a.b.mkt_bl)) : 0;

  console.log(`\n── ${label} ──────────────────────────────────────────────────────`);
  console.log(`  Alerts             : ${alerts.length}  (with known outcome: ${known.length})`);
  console.log(`  Hit rate           : ${hits}/${known.length} = ${actualPct.toFixed(1)}%`);
  console.log(`  Avg market implied : ${avgMktBl.toFixed(1)}%`);
  console.log(`  Edge vs market     : ${(actualPct - avgMktBl).toFixed(1)}pp`);
  console.log(`  ── P&L at fair min odds ────────────────────────────`);
  console.log(`  Avg fair odds      : ${avg(known.map(a => a.b.mo)).toFixed(2)}`);
  console.log(`  P&L                : ${pnlFair >= 0 ? '+' : ''}${pnlFair.toFixed(2)} units on ${known.length} bets`);
  console.log(`  ROI                : ${roiFair >= 0 ? '+' : ''}${roiFair.toFixed(1)}%`);
  if (mktKnown.length) {
    console.log(`  ── P&L at Pinnacle avg odds ────────────────────────`);
    console.log(`  Avg Pinnacle odds  : ${avg(mktKnown.map(a => a.b.mkt_avg_odds)).toFixed(2)}`);
    console.log(`  P&L                : ${pnlMkt >= 0 ? '+' : ''}${pnlMkt.toFixed(2)} units on ${mktKnown.length} bets`);
    console.log(`  ROI                : ${roiMkt >= 0 ? '+' : ''}${roiMkt.toFixed(1)}%`);
  }

  // Per-bet breakdown
  const byBet = new Map();
  for (const a of known) {
    if (!byBet.has(a.b.k)) byBet.set(a.b.k, []);
    byBet.get(a.b.k).push(a);
  }
  console.log(`\n  Per-bet breakdown:`);
  console.log(`  ${'Bet'.padEnd(14)} ${'N'.padStart(5)} ${'Hit%'.padStart(6)} ${'MktBl%'.padStart(7)} ${'EdgeVsMkt'.padStart(10)} ${'AvgMktOdds'.padStart(11)} ${'ROI@Mkt'.padStart(8)}`);
  for (const [k, arr] of [...byBet.entries()].sort((a, b) => b[1].length - a[1].length)) {
    const h = arr.filter(a => a.hit).length;
    const hp = (h / arr.length * 100).toFixed(1);
    const mktArr = arr.filter(a => a.b.mkt_bl != null);
    const bl = mktArr.length ? avg(mktArr.map(a => a.b.mkt_bl)).toFixed(1) : '—';
    const edge = mktArr.length ? ((h / arr.length * 100) - avg(mktArr.map(a => a.b.mkt_bl))).toFixed(1) : '—';
    const avgMo = mktArr.length ? avg(mktArr.map(a => a.b.mkt_avg_odds)).toFixed(2) : '—';
    const mktPnl = mktArr.reduce((s, a) => s + (a.hit ? a.b.mkt_avg_odds - 1 : -1), 0);
    const mktRoi = mktArr.length ? (mktPnl / mktArr.length * 100).toFixed(1) : '—';
    console.log(`  ${k.padEnd(14)} ${String(arr.length).padStart(5)} ${hp.padStart(6)}% ${String(bl).padStart(6)}% ${String(edge).padStart(9)}pp ${String(avgMo).padStart(11)} ${String(mktRoi).padStart(7)}%`);
  }
}

function main() {
  console.log(`\nLoading database from ${DATA_DIR}…`);
  const fullDb = loadDatabase(DATA_DIR);
  console.log(`Total rows: ${fullDb.length}`);

  const histDb   = fullDb.filter(r => !r.file_label.includes(TEST_LABEL));
  const testRows = fullDb.filter(r =>  r.file_label.includes(TEST_LABEL));
  const histTier = applyTier(histDb, cfg.LEAGUE_TIER);

  console.log(`Historical DB (excl. May25)   : ${histDb.length} rows`);
  console.log(`Historical DB (tier=${cfg.LEAGUE_TIER}) : ${histTier.length} rows`);
  console.log(`Test set (May 2025)           : ${testRows.length} rows`);
  const testTier = applyTier(testRows, cfg.LEAGUE_TIER);
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

    // Market-calibrated gate: only MKT_KEYS bets with mkt_edge >= threshold
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
      alerts.push({ row: testRow, matchCfg, b, hit: testRow[b.k] });
    }
  }

  console.log('\n' + '═'.repeat(72));
  console.log(`MARKET-CALIBRATED BACKTEST — May 2025  (tier=${cfg.LEAGUE_TIER})`);
  console.log(`Gate: mkt_edge ≥ ${MKT_EDGE_THRESH}pp | MIN_N=${cfg.MIN_N} | MIN_Z=${cfg.MIN_Z}`);
  console.log(`Bets: ${[...MKT_KEYS].join(', ')}`);
  console.log('═'.repeat(72));
  console.log(`Matches checked          : ${nChecked}`);
  console.log(`Passed signal gate       : ${nPassedSignal}  (${pct(nPassedSignal, nChecked)}%)`);
  console.log(`Would have triggered     : ${nTriggered}  (${pct(nTriggered, nPassedSignal)}% of signal-passed)`);
  console.log(`Total alerts             : ${alerts.length}`);

  if (!alerts.length) {
    console.log('\n⚠  No alerts generated.');
    return;
  }

  printResults(`All 4 market bets  (mkt_edge ≥ ${MKT_EDGE_THRESH}pp)`, alerts);

  // Also split by bet type
  for (const k of MKT_KEYS) {
    const sub = alerts.filter(a => a.b.k === k);
    if (sub.length) printResults(k, sub);
  }
}

main();
