'use strict';
// ── Backtest — simulate notifier against last month's matches ─────────────────
// DB  = all rows whose file_label does NOT contain TEST_FOLDER
// Test = rows whose file_label contains TEST_FOLDER
//
// Usage:
//   node backtest.js            — TOP+MAJOR filter, current thresholds
//   node backtest.js --all      — no league tier filter
//   node backtest.js --verbose  — also print matches that did NOT trigger

const path = require('path');
const { loadDatabase, buildCfgFromMatch, applyConfig, applyBaselineConfig, scoreBets } = require('./engine');

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

const VERBOSE     = process.argv.includes('--verbose');
const SUMMARY     = process.argv.includes('--summary');
const DATA_DIR    = path.resolve(__dirname, '../static/data');
const TEST_LABEL  = '_02_26_';  // matches file labels like 01_02_26_Pinnacle

function applyTier(db, tier) {
  if (tier === 'ALL') return db;
  if (tier === 'TOP')       return db.filter(r => r.league_tier === 'TOP');
  if (tier === 'MAJOR')     return db.filter(r => r.league_tier === 'MAJOR');
  if (tier === 'TOP+MAJOR') return db.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
  return db;
}

// Reconstruct odds object from a processed row (reverse of processRow normalisation)
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

function main() {
  console.log(`\nLoading full database from ${DATA_DIR}…`);
  const fullDb = loadDatabase(DATA_DIR);
  console.log(`Total rows: ${fullDb.length}`);

  const histDb   = fullDb.filter(r => !r.file_label.includes(TEST_LABEL));
  const testRows = fullDb.filter(r =>  r.file_label.includes(TEST_LABEL));
  const histTier = applyTier(histDb, cfg.LEAGUE_TIER);

  console.log(`Historical DB (excl. Feb26): ${histDb.length} rows`);
  console.log(`Historical DB (tier=${cfg.LEAGUE_TIER}):  ${histTier.length} rows`);
  console.log(`Test set (Feb 2026):         ${testRows.length} matches`);

  // Note: engine.js only classifies TOP / OTHER (no MAJOR), so TOP+MAJOR ≈ TOP only
  if (cfg.LEAGUE_TIER === 'TOP+MAJOR') {
    const topCount   = histDb.filter(r => r.league_tier === 'TOP').length;
    const majorCount = histDb.filter(r => r.league_tier === 'MAJOR').length;
    console.log(`  (TOP: ${topCount}, MAJOR: ${majorCount} — engine.js only implements TOP tier)`);
  }

  let nChecked = 0, nPassedSignal = 0, nTriggered = 0;
  const allAlerts = [];

  for (const testRow of testRows) {
    const odds = rowToOdds(testRow);
    const matchCfg = buildCfgFromMatch(odds, cfg);
    if (!matchCfg) continue;
    nChecked++;

    // Signal quality gate
    if (cfg.REQUIRE_MOVEMENT) {
      const s = matchCfg.signals;
      const hasMovement =
        (cfg.LINE_MOVE_ON  && s.lineMove    !== 'STABLE' && s.lineMove    !== 'UNKNOWN') ||
        (cfg.TL_MOVE_ON    && s.tlMove      !== 'STABLE' && s.tlMove      !== 'UNKNOWN') ||
        (cfg.FAV_ODDS_ON   && s.favOddsMove !== 'STABLE' && s.favOddsMove !== 'UNKNOWN') ||
        (cfg.DOG_ODDS_ON   && s.dogOddsMove !== 'STABLE' && s.dogOddsMove !== 'UNKNOWN');
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
    const qualifying = bets.filter(b => b.z >= cfg.MIN_Z && b.edge >= cfg.MIN_EDGE && b.n >= cfg.MIN_N && b.bl >= (cfg.MIN_BASELINE ?? 0));

    if (VERBOSE && !qualifying.length) {
      const s = matchCfg.signals;
      console.log(`  no alert: ${testRow.home_team} vs ${testRow.away_team}  LM=${s.lineMove} TLM=${s.tlMove}  cfgN=${cfgRows.length}`);
    }

    if (!qualifying.length) continue;
    nTriggered++;

    for (const b of qualifying) {
      allAlerts.push({ row: testRow, matchCfg, b, hit: testRow[b.k] });
    }
  }

  // ── Print results ─────────────────────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  console.log(`BACKTEST RESULTS — Feb 2026 as test set  (tier=${cfg.LEAGUE_TIER})`);
  console.log('═'.repeat(72));
  console.log(`Matches processed:         ${nChecked}`);
  console.log(`Passed signal gate:         ${nPassedSignal}  (${pct(nPassedSignal, nChecked)}% of processed)`);
  console.log(`Would have triggered:       ${nTriggered}  (${pct(nTriggered, nPassedSignal)}% of signal-passed)`);
  console.log(`Total bet alerts:           ${allAlerts.length}`);

  if (!allAlerts.length) {
    console.log('\n⚠  No alerts. Try:');
    console.log('   node backtest.js --all       (removes league tier filter)');
    console.log('   node backtest.js --all --verbose  (shows why each match was skipped)');
    return;
  }

  // Per-bet summary
  const byBet = new Map();
  for (const a of allAlerts) {
    if (!byBet.has(a.b.k)) byBet.set(a.b.k, []);
    byBet.get(a.b.k).push(a);
  }

  console.log('\n── Per-bet summary ────────────────────────────────────────────────────');
  const betSummary = [...byBet.entries()]
    .map(([k, alerts]) => {
      const hits  = alerts.filter(a => a.hit === true).length;
      const total = alerts.length;
      return { label: alerts[0].b.label, count: total, hits, avgZ: avg(alerts.map(a => a.b.z)), avgEdge: avg(alerts.map(a => a.b.edge)) };
    })
    .sort((a, b) => b.count - a.count);

  for (const s of betSummary) {
    const hitStr = `${s.hits}/${s.count} hit (${pct(s.hits, s.count)}%)`;
    console.log(`  ${s.label.padEnd(24)} ×${String(s.count).padStart(2)}  z̄=${s.avgZ.toFixed(1)}  edge̅=+${s.avgEdge.toFixed(1)}pp  ${hitStr}`);
  }

  // Individual alerts
  if (SUMMARY) { console.log('\n(individual alerts suppressed — run without --summary to see them)'); }
  if (!SUMMARY) console.log('\n── Individual alerts ──────────────────────────────────────────────────');
  for (const { row, matchCfg: mc, b, hit } of (SUMMARY ? [] : allAlerts)) {
    const s      = mc.signals;
    const hitStr = hit === true ? '✓ HIT' : '✗ MISS';
    const sigStr = `LM=${s.lineMove} TLM=${s.tlMove}`;
    console.log(`  [${row.date}] ${row.home_team} vs ${row.away_team}`);
    console.log(`    League: ${row.league}  |  AH ${mc.fav_line} ${mc.fav_side}  ${sigStr}  cfgN=${b.n}`);
    console.log(`    → ${b.label}  z=${b.z.toFixed(2)}  ${b.p.toFixed(0)}% vs bl ${b.bl.toFixed(0)}%  +${b.edge.toFixed(1)}pp  min odds ${b.mo}  ${hitStr}`);
  }

  // Overall
  const known     = allAlerts.filter(a => a.hit !== null);
  const totalHits = known.filter(a => a.hit === true).length;
  const avgBl     = avg(known.map(a => a.b.bl));
  const actualPct = parseFloat(pct(totalHits, known.length));
  console.log('\n── Overall ────────────────────────────────────────────────────────────');
  console.log(`  Alerts with outcome: ${known.length}`);
  console.log(`  Hit rate:            ${totalHits}/${known.length} = ${actualPct}%`);
  console.log(`  Avg baseline:        ${avgBl.toFixed(1)}%`);
  console.log(`  Edge realised:       ${(actualPct - avgBl).toFixed(1)}pp`);
}

main();
