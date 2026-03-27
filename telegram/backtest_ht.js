'use strict';
// ── HT-focused backtest ────────────────────────────────────────────────────────
// DB  = all rows whose file_label does NOT contain TEST_LABEL
// Test = rows whose file_label contains TEST_LABEL
//
// For each test match: apply pre-match signal filter, then apply actual HT score
// as game state filter. Shows how much the HT state improves signal quality.
//
// Usage:
//   node backtest_ht.js            — TOP+MAJOR filter
//   node backtest_ht.js --all      — no league tier filter
//   node backtest_ht.js --summary  — suppress per-bet and per-HT-state tables

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

const SUMMARY  = process.argv.includes('--summary');
const DATA_DIR = path.resolve(__dirname, '../static/data');

// Allow --month <label> to override test month, e.g. --month _01_26_
const _monthIdx = process.argv.indexOf('--month');
const TEST_LABEL = _monthIdx !== -1 ? process.argv[_monthIdx + 1] : '_02_26_';

// Must match notify.js thresholds exactly
const HT_MIN_N          = 30;   // GSA_MIN_N
const GSA_MIN_DELTA     = 5;    // Δ vs HT-conditioned baseline (pp)
const GSA_MAX_CONS_ODDS = 1.95; // conservative odds ceiling
const GSA_MIN_P         = 55;   // minimum absolute hit rate (%)

// Only allow the 5 live 2H bets we want to place at HT.
const HT_ALLOWED_BETS = new Set([
  'homeScored2H', 'awayScored2H',
  'over05_2H', 'over15_2H', 'under15_2H',
]);

// ── Helpers ────────────────────────────────────────────────────────────────────
function applyTier(db, tier) {
  if (tier === 'ALL')       return db;
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
      tl_c: r.tl_c,     tl_o: r.tl_o,
      ov_c: r.ov_c,     ov_o: r.ov_o,
    };
  } else {
    return {
      ah_hc: r.fav_lc,  ah_ho: r.fav_lo,
      ho_c: r.dog_oc,   ho_o: r.dog_oo,
      ao_c: r.fav_oc,   ao_o: r.fav_oo,
      tl_c: r.tl_c,     tl_o: r.tl_o,
      ov_c: r.ov_c,     ov_o: r.ov_o,
    };
  }
}

function pct(n, d) { return d ? (n / d * 100).toFixed(1) : '0.0'; }
function avg(arr)  { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

function printGateSummary(label, alerts) {
  const known    = alerts.filter(a => a.hit !== null && a.hit !== undefined);
  const hits     = known.filter(a => a.hit === true).length;
  const avgBl    = avg(known.map(a => a.b.bl));
  const actualPct = known.length ? parseFloat((hits / known.length * 100).toFixed(1)) : 0;

  // Fair odds (mo = 1/P)
  const pnlLo = known.reduce((s, a) => a.b.mo     ? s + (a.hit ? a.b.mo - 1 : -1) : s, 0);
  const stakedLo  = known.filter(a => a.b.mo).length;
  const roiLo     = stakedLo ? pnlLo / stakedLo * 100 : 0;
  const avgOddsLo = avg(known.filter(a => a.b.mo).map(a => a.b.mo));

  // Mid odds ((mo + mo_mid) / 2)
  const pnlMid = known.reduce((s, a) => {
    if (!a.b.mo || !a.b.mo_mid) return s;
    const mid = (a.b.mo + a.b.mo_mid) / 2;
    return s + (a.hit ? mid - 1 : -1);
  }, 0);
  const stakedMid  = known.filter(a => a.b.mo && a.b.mo_mid).length;
  const roiMid     = stakedMid ? pnlMid / stakedMid * 100 : 0;
  const avgOddsMid = avg(known.filter(a => a.b.mo && a.b.mo_mid).map(a => (a.b.mo + a.b.mo_mid) / 2));

  // Conservative odds (mo_mid = 1/CI_lower)
  const pnlHi = known.reduce((s, a) => a.b.mo_mid ? s + (a.hit ? a.b.mo_mid - 1 : -1) : s, 0);
  const stakedHi  = known.filter(a => a.b.mo_mid).length;
  const roiHi     = stakedHi ? pnlHi / stakedHi * 100 : 0;
  const avgOddsHi = avg(known.filter(a => a.b.mo_mid).map(a => a.b.mo_mid));

  console.log(`  Alerts with outcome : ${known.length}`);
  console.log(`  Hit rate            : ${hits}/${known.length} = ${actualPct}%`);
  console.log(`  Avg baseline        : ${avgBl.toFixed(1)}%`);
  console.log(`  Edge realised       : ${(actualPct - avgBl).toFixed(1)}pp`);
  console.log(`  ── @ fair odds    (mo)              avg ${avgOddsLo.toFixed(2)}  ROI ${roiLo >= 0 ? '+' : ''}${roiLo.toFixed(1)}%  P&L ${pnlLo >= 0 ? '+' : ''}${pnlLo.toFixed(2)}u`);
  console.log(`  ── @ mid  odds    (mo+mo_mid)/2     avg ${avgOddsMid.toFixed(2)}  ROI ${roiMid >= 0 ? '+' : ''}${roiMid.toFixed(1)}%  P&L ${pnlMid >= 0 ? '+' : ''}${pnlMid.toFixed(2)}u`);
  console.log(`  ── @ safe odds    (mo_mid)          avg ${avgOddsHi.toFixed(2)}  ROI ${roiHi >= 0 ? '+' : ''}${roiHi.toFixed(1)}%  P&L ${pnlHi >= 0 ? '+' : ''}${pnlHi.toFixed(2)}u`);
  return { known: known.length, hits, actualPct, avgBl,
           pnlLo, roiLo, stakedLo, pnlMid, roiMid, stakedMid,
           pnlHi, roiHi, stakedHi };
}

function printPerBetTable(label, alerts) {
  const byBet = new Map();
  for (const a of alerts) {
    if (!byBet.has(a.b.k)) byBet.set(a.b.k, []);
    byBet.get(a.b.k).push(a);
  }
  console.log(`\n── Per-bet summary (${label}) ──────────────────────────────────────────`);
  const rows = [...byBet.entries()]
    .map(([, alts]) => {
      const hits  = alts.filter(a => a.hit === true).length;
      const total = alts.length;
      const pnlHi = alts.reduce((s, a) => {
        if (!a.b.mo_mid) return s;
        return s + (a.hit === true ? a.b.mo_mid - 1 : -1);
      }, 0);
      return {
        label:   alts[0].b.label,
        count:   total,
        hits,
        avgZ:    avg(alts.map(a => a.b.z)),
        avgEdge: avg(alts.map(a => a.b.edge)),
        pnl: pnlHi,
        staked:  alts.filter(a => a.b.mo_mid).length,
      };
    })
    .sort((a, b) => b.count - a.count);

  for (const s of rows) {
    const hitStr = `${s.hits}/${s.count} (${pct(s.hits, s.count)}%)`;
    const roiStr = s.staked ? `  ROI ${(s.pnl / s.staked * 100) >= 0 ? '+' : ''}${(s.pnl / s.staked * 100).toFixed(1)}%` : '';
    console.log(`  ${s.label.padEnd(24)} ×${String(s.count).padStart(3)}  z̄=${s.avgZ.toFixed(1)}  edge̅=+${s.avgEdge.toFixed(1)}pp  ${hitStr}${roiStr}`);
  }
}

// ── Core test logic (one month) ────────────────────────────────────────────────
function runMonth(fullDb, label) {
  const histDb   = fullDb.filter(r => !r.file_label.includes(label));
  const testRows = fullDb.filter(r =>  r.file_label.includes(label));
  const histTier = applyTier(histDb, cfg.LEAGUE_TIER);
  if (!testRows.length) return null;

  const alertsMA = [];
  const alertsHT = [];
  let nChecked = 0, nPassedSignal = 0, nTriggeredMA = 0, nHtSkipped = 0;
  const htStateStats = new Map();

  for (const testRow of testRows) {
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
      b.z >= cfg.MIN_Z && b.edge >= cfg.MIN_EDGE &&
      b.n >= cfg.MIN_N && b.bl >= (cfg.MIN_BASELINE ?? 0)
    );

    if (qualifying.length) {
      nTriggeredMA++;
      for (const b of qualifying) alertsMA.push({ row: testRow, matchCfg, b, hit: testRow[b.k] });
    }

    const favHt = testRow.fav_ht;
    const dogHt = testRow.dog_ht;
    if (favHt == null || dogHt == null || isNaN(favHt) || isNaN(dogHt)) { nHtSkipped++; continue; }

    const htKey = `Fav ${favHt} - Dog ${dogHt}`;
    if (!htStateStats.has(htKey)) htStateStats.set(htKey, { total: 0, triggered: 0, alerts: 0, hits: 0 });
    const hs = htStateStats.get(htKey);
    hs.total++;

    const homeGoals = matchCfg.fav_side === 'HOME' ? favHt : dogHt;
    const awayGoals = matchCfg.fav_side === 'HOME' ? dogHt : favHt;
    const gs = { trigger: 'HT', home_goals: homeGoals, away_goals: awayGoals };

    const htRows   = applyGameState(cfgRows, gs);
    if (htRows.length < HT_MIN_N) continue;

    const htBlRows = applyGameState(blRows, gs);
    const htBlSide = applyGameState(blSide, gs);
    if (htBlRows.length < HT_MIN_N) continue;

    const htBets = scoreBets(htRows, htBlRows, htBlSide, HT_MIN_N);
    const htQualifying = htBets.filter(b =>
      HT_ALLOWED_BETS.has(b.k)       &&
      b.edge   >= GSA_MIN_DELTA       &&
      b.n      >= HT_MIN_N            &&
      b.mo_mid <= GSA_MAX_CONS_ODDS   &&
      b.p      >= GSA_MIN_P
    );
    if (!htQualifying.length) continue;

    hs.triggered++;
    for (const b of htQualifying) {
      hs.alerts++;
      if (testRow[b.k] === true) hs.hits++;
      alertsHT.push({ row: testRow, matchCfg, b, hit: testRow[b.k], htKey });
    }
  }

  return { label, testRows: testRows.length, nChecked, nPassedSignal, nTriggeredMA,
           nHtSkipped, alertsMA, alertsHT, htStateStats };
}

// ── Stats helpers ──────────────────────────────────────────────────────────────
function gateStats(alerts) {
  const known   = alerts.filter(a => a.hit !== null && a.hit !== undefined);
  const hits    = known.filter(a => a.hit === true).length;
  const hitPct  = known.length ? hits / known.length * 100 : 0;
  const avgBl   = avg(known.map(a => a.b.bl));

  const pnlLo  = known.reduce((s, a) => a.b.mo     ? s + (a.hit ? a.b.mo - 1 : -1) : s, 0);
  const pnlMid = known.reduce((s, a) => {
    if (!a.b.mo || !a.b.mo_mid) return s;
    return s + (a.hit ? (a.b.mo + a.b.mo_mid) / 2 - 1 : -1);
  }, 0);
  const pnlHi  = known.reduce((s, a) => a.b.mo_mid ? s + (a.hit ? a.b.mo_mid - 1 : -1) : s, 0);
  const stLo   = known.filter(a => a.b.mo).length;
  const stMid  = known.filter(a => a.b.mo && a.b.mo_mid).length;
  const stHi   = known.filter(a => a.b.mo_mid).length;

  return {
    n: known.length, hits, hitPct, avgBl,
    roiLo:  stLo  ? pnlLo  / stLo  * 100 : 0,
    roiMid: stMid ? pnlMid / stMid * 100 : 0,
    roiHi:  stHi  ? pnlHi  / stHi  * 100 : 0,
    pnlLo, pnlMid, pnlHi, stLo, stMid, stHi,
    avgOddsLo:  avg(known.filter(a => a.b.mo).map(a => a.b.mo)),
    avgOddsMid: avg(known.filter(a => a.b.mo && a.b.mo_mid).map(a => (a.b.mo + a.b.mo_mid) / 2)),
    avgOddsHi:  avg(known.filter(a => a.b.mo_mid).map(a => a.b.mo_mid)),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────
function main() {
  const ALL_MONTHS = process.argv.includes('--all-months');

  console.log(`\nLoading full database from ${DATA_DIR}…`);
  const fullDb = loadDatabase(DATA_DIR);
  console.log(`Total rows: ${fullDb.length}`);

  if (ALL_MONTHS) {
    // All known month labels + human names
    const MONTHS = [
      { label: '_01_25_',    name: 'Jan 2025' },
      { label: '_02_25_',    name: 'Feb 2025' },
      { label: '_03_25_',    name: 'Mar 2025' },
      { label: '_04_25_',    name: 'Apr 2025' },
      { label: '_05_25_',    name: 'May 2025' },
      { label: '_06_25_',    name: 'Jun 2025' },
      { label: '_09_25_',    name: 'Sep 2025' },
      { label: '_10_Pinnacle', name: 'Oct 2025' },
      { label: '_11_Pinnacle', name: 'Nov 2025' },
      { label: '_12_Pinnacle', name: 'Dec 2025' },
      { label: '_01_Pinnacle', name: 'Jan 2026' },
      { label: '_02_26_',    name: 'Feb 2026' },
    ];

    const allHT = [];
    const rows = [];

    for (const { label, name } of MONTHS) {
      process.stdout.write(`  Testing ${name}… `);
      const res = runMonth(fullDb, label);
      if (!res || !res.testRows) { console.log('no data'); continue; }

      const ht = gateStats(res.alertsHT);
      allHT.push(...res.alertsHT);
      rows.push({ name, matches: res.testRows, alerts: res.alertsHT.length,
                  hits: ht.hits, n: ht.n, hitPct: ht.hitPct, avgBl: ht.avgBl,
                  roiLo: ht.roiLo, roiMid: ht.roiMid, roiHi: ht.roiHi,
                  pnlMid: ht.pnlMid, pnlHi: ht.pnlHi });
      console.log(`${res.alertsHT.length} HT alerts`);
    }

    // ── Per-month table ──────────────────────────────────────────────────────
    console.log('\n' + '═'.repeat(88));
    console.log('ALL-MONTHS HT BACKTEST  (5 live 2H bets · HT-corrected baseline · tier=TOP+MAJOR)');
    console.log('═'.repeat(88));
    console.log('  Month       matches  alerts  hit rate   baseline  edge    ROI@lo  ROI@mid  ROI@hi  P&L@mid');
    console.log('  ' + '─'.repeat(92));
    for (const r of rows) {
      const edge = (r.hitPct - r.avgBl).toFixed(1);
      console.log(
        `  ${r.name.padEnd(10)}  ${String(r.matches).padStart(7)}  ${String(r.alerts).padStart(6)}` +
        `  ${r.hitPct.toFixed(1).padStart(5)}%` +
        `  ${r.avgBl.toFixed(1).padStart(5)}%    ${(parseFloat(edge) >= 0 ? '+' : '') + edge}pp` +
        `  ${(r.roiLo  >= 0 ? '+' : '') + r.roiLo.toFixed(1).padStart(6)}%` +
        `  ${(r.roiMid >= 0 ? '+' : '') + r.roiMid.toFixed(1).padStart(6)}%` +
        `  ${(r.roiHi  >= 0 ? '+' : '') + r.roiHi.toFixed(1).padStart(6)}%` +
        `  ${(r.pnlMid >= 0 ? '+' : '') + r.pnlMid.toFixed(1).padStart(6)}`
      );
    }

    // ── Aggregate ────────────────────────────────────────────────────────────
    const agg = gateStats(allHT);
    const totalMatches = rows.reduce((s, r) => s + r.matches, 0);
    console.log('  ' + '─'.repeat(84));
    console.log(
      `  ${'TOTAL'.padEnd(10)}  ${String(totalMatches).padStart(7)}  ${String(agg.n).padStart(6)}` +
      `  ${agg.hitPct.toFixed(1).padStart(5)}%` +
      `  ${agg.avgBl.toFixed(1).padStart(5)}%    ${(agg.hitPct - agg.avgBl >= 0 ? '+' : '') + (agg.hitPct - agg.avgBl).toFixed(1)}pp` +
      `  ${(agg.roiLo  >= 0 ? '+' : '') + agg.roiLo.toFixed(1).padStart(6)}%` +
      `  ${(agg.roiMid >= 0 ? '+' : '') + agg.roiMid.toFixed(1).padStart(6)}%` +
      `  ${(agg.roiHi  >= 0 ? '+' : '') + agg.roiHi.toFixed(1).padStart(6)}%` +
      `  ${(agg.pnlMid >= 0 ? '+' : '') + agg.pnlMid.toFixed(1).padStart(6)}`
    );
    console.log(`\n  Avg odds (fair)  : ${agg.avgOddsLo.toFixed(2)}`);
    console.log(`  Avg odds (mid)   : ${agg.avgOddsMid.toFixed(2)}`);
    console.log(`  Avg odds (safe)  : ${agg.avgOddsHi.toFixed(2)}`);

    if (SUMMARY) return;

    // ── Aggregate per-bet breakdown ──────────────────────────────────────────
    printPerBetTable('ALL MONTHS — HT gate', allHT);
    return;
  }

  // ── Single-month mode ─────────────────────────────────────────────────────
  const histDb   = fullDb.filter(r => !r.file_label.includes(TEST_LABEL));
  const testRows = fullDb.filter(r =>  r.file_label.includes(TEST_LABEL));
  const res = runMonth(fullDb, TEST_LABEL);
  if (!res) { console.log('No test rows found for label:', TEST_LABEL); return; }

  console.log(`Historical DB (tier=${cfg.LEAGUE_TIER}) : ${applyTier(histDb, cfg.LEAGUE_TIER).length} rows`);
  console.log(`Test set                       : ${testRows.length} matches`);

  console.log('\n' + '═'.repeat(72));
  console.log(`HT BACKTEST RESULTS — test label: ${TEST_LABEL}  (tier=${cfg.LEAGUE_TIER})`);
  console.log('═'.repeat(72));
  console.log(`Matches processed        : ${res.nChecked}`);
  console.log(`Passed signal gate       : ${res.nPassedSignal}  (${pct(res.nPassedSignal, res.nChecked)}% of processed)`);
  console.log(`Triggered pre-match (MA) : ${res.nTriggeredMA}`);
  console.log(`Pre-match alerts (MA)    : ${res.alertsMA.length}`);
  console.log(`HT alerts (MA+HT)        : ${res.alertsHT.length}`);
  console.log(`  Test rows missing HT   : ${res.nHtSkipped}`);

  if (!res.alertsMA.length) { console.log('\n⚠  No pre-match alerts.'); return; }

  console.log('\n── Gate 1: Pre-match (Match Analysis only) ─────────────────────────────');
  const g1 = printGateSummary('MA', res.alertsMA);

  console.log('\n── Gate 2: Pre-match + HT game state (MIN_N=15) ────────────────────────');
  const g2 = printGateSummary('MA+HT', res.alertsHT);

  console.log('\n── HT gate impact vs pre-match ─────────────────────────────────────────');
  console.log(`  Alert change      : ${res.alertsMA.length} → ${res.alertsHT.length}`);
  console.log(`  Hit rate change   : ${g1.actualPct}% → ${g2.actualPct}%`);
  console.log(`  ROI @ fair odds   : ${g1.roiLo >= 0 ? '+' : ''}${g1.roiLo.toFixed(1)}% → ${g2.roiLo >= 0 ? '+' : ''}${g2.roiLo.toFixed(1)}%`);
  console.log(`  ROI @ mid  odds   : → ${g2.roiMid >= 0 ? '+' : ''}${g2.roiMid.toFixed(1)}%`);
  console.log(`  ROI @ safe odds   : → ${g2.roiHi >= 0 ? '+' : ''}${g2.roiHi.toFixed(1)}%`);

  if (SUMMARY) return;

  printPerBetTable('Pre-match MA only', res.alertsMA);
  printPerBetTable('Pre-match + HT gate', res.alertsHT);

  console.log('\n── Per-HT-state breakdown (fav/dog perspective) ────────────────────────');
  console.log('  HT state           matches  triggered  alerts  hit rate');
  console.log('  ' + '─'.repeat(64));
  const sortedStates = [...res.htStateStats.entries()]
    .filter(([, s]) => s.alerts > 0)
    .sort((a, b) => b[1].alerts - a[1].alerts);
  for (const [key, s] of sortedStates) {
    console.log(`  ${key.padEnd(18)}  ${String(s.total).padStart(7)}  ${String(s.triggered).padStart(9)}  ${String(s.alerts).padStart(6)}  ${pct(s.hits, s.alerts)}%`);
  }
}

main();
