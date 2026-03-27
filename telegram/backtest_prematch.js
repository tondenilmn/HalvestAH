'use strict';
// ── Pre-match signal backtest (all months) ────────────────────────────────────
// Tests pre-match Match Analysis alerts (z≥2, edge≥6pp, n≥35, bl≥25%) across
// all months to find which bet types are profitable and at what minimum odds.
//
// Usage:
//   node backtest_prematch.js          — TOP+MAJOR filter
//   node backtest_prematch.js --all    — all leagues

const path = require('path');
const { loadDatabase, buildCfgFromMatch, applyConfig, applyBaselineConfig, scoreBets } = require('./engine');

const LEAGUE_TIER = process.argv.includes('--all') ? 'ALL' : 'TOP+MAJOR';
const DATA_DIR    = path.resolve(__dirname, '../static/data');

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
  LEAGUE_TIER,
};

// Expected out-of-sample hit rate shrinkage (relative %).
// 10% means: historical 70% → expected real 63%.
const SHRINK_PCT = 10;

const MONTHS = [
  { label: '_01_25_',      name: 'Jan 2025' },
  { label: '_02_25_',      name: 'Feb 2025' },
  { label: '_03_25_',      name: 'Mar 2025' },
  { label: '_04_25_',      name: 'Apr 2025' },
  { label: '_05_25_',      name: 'May 2025' },
  { label: '_06_25_',      name: 'Jun 2025' },
  { label: '_09_25_',      name: 'Sep 2025' },
  { label: '_10_Pinnacle', name: 'Oct 2025' },
  { label: '_11_Pinnacle', name: 'Nov 2025' },
  { label: '_12_Pinnacle', name: 'Dec 2025' },
  { label: '_01_Pinnacle', name: 'Jan 2026' },
  { label: '_02_26_',      name: 'Feb 2026' },
];

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
    return { ah_hc: -r.fav_lc, ah_ho: -r.fav_lo,
             ho_c: r.fav_oc,   ho_o: r.fav_oo,
             ao_c: r.dog_oc,   ao_o: r.dog_oo,
             tl_c: r.tl_c,     tl_o: r.tl_o,
             ov_c: r.ov_c,     ov_o: r.ov_o };
  }
  return { ah_hc: r.fav_lc,  ah_ho: r.fav_lo,
           ho_c: r.dog_oc,   ho_o: r.dog_oo,
           ao_c: r.fav_oc,   ao_o: r.fav_oo,
           tl_c: r.tl_c,     tl_o: r.tl_o,
           ov_c: r.ov_c,     ov_o: r.ov_o };
}

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }

// ── Run one month ──────────────────────────────────────────────────────────────
function runMonth(fullDb, label) {
  const histDb   = applyTier(fullDb.filter(r => !r.file_label.includes(label)), LEAGUE_TIER);
  const testRows = fullDb.filter(r => r.file_label.includes(label));
  if (!testRows.length) return null;

  const alerts = [];
  for (const testRow of testRows) {
    const odds = rowToOdds(testRow);
    const matchCfg = buildCfgFromMatch(odds, cfg);
    if (!matchCfg) continue;

    if (cfg.REQUIRE_MOVEMENT) {
      const s = matchCfg.signals;
      const ok =
        (cfg.LINE_MOVE_ON && s.lineMove !== 'STABLE' && s.lineMove !== 'UNKNOWN') ||
        (cfg.TL_MOVE_ON   && s.tlMove   !== 'STABLE' && s.tlMove   !== 'UNKNOWN');
      if (!ok) continue;
    }

    const cfgRows = applyConfig(histDb, matchCfg);
    const blRows  = applyBaselineConfig(histDb, matchCfg);
    const blSide  = blRows.filter(r => r.fav_side === matchCfg.fav_side);
    const bets    = scoreBets(cfgRows, blRows, blSide, cfg.MIN_N);

    for (const b of bets) {
      if (b.z    >= cfg.MIN_Z        &&
          b.edge >= cfg.MIN_EDGE     &&
          b.n    >= cfg.MIN_N        &&
          b.bl   >= (cfg.MIN_BASELINE ?? 0)) {
        alerts.push({ row: testRow, matchCfg, b, hit: testRow[b.k] });
      }
    }
  }
  return { label, testRows: testRows.length, alerts };
}

// ── Stats ──────────────────────────────────────────────────────────────────────
function computeStats(alerts) {
  const known = alerts.filter(a => a.hit !== null && a.hit !== undefined);
  const hits  = known.filter(a => a.hit === true).length;
  const hitPct = known.length ? hits / known.length * 100 : 0;
  const avgBl  = avg(known.map(a => a.b.bl));

  const pnlLo  = known.reduce((s, a) => a.b.mo
    ? s + (a.hit ? a.b.mo - 1 : -1) : s, 0);
  const pnlMid = known.reduce((s, a) => (a.b.mo && a.b.mo_mid)
    ? s + (a.hit ? (a.b.mo + a.b.mo_mid) / 2 - 1 : -1) : s, 0);
  const pnlHi  = known.reduce((s, a) => a.b.mo_mid
    ? s + (a.hit ? a.b.mo_mid - 1 : -1) : s, 0);
  const stLo   = known.filter(a => a.b.mo).length;
  const stMid  = known.filter(a => a.b.mo && a.b.mo_mid).length;
  const stHi   = known.filter(a => a.b.mo_mid).length;

  return {
    n: known.length, hits, hitPct, avgBl,
    roiLo:      stLo  ? pnlLo  / stLo  * 100 : 0,
    roiMid:     stMid ? pnlMid / stMid * 100 : 0,
    roiHi:      stHi  ? pnlHi  / stHi  * 100 : 0,
    pnlLo, pnlMid, pnlHi,
    avgOddsLo:  avg(known.filter(a => a.b.mo).map(a => a.b.mo)),
    avgOddsMid: avg(known.filter(a => a.b.mo && a.b.mo_mid).map(a => (a.b.mo + a.b.mo_mid) / 2)),
    avgOddsHi:  avg(known.filter(a => a.b.mo_mid).map(a => a.b.mo_mid)),
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────
function main() {
  console.log(`\nLoading full database from ${DATA_DIR}…`);
  const fullDb = loadDatabase(DATA_DIR);
  console.log(`Total rows: ${fullDb.length}`);

  const allAlerts = [];
  const monthRows = [];

  for (const { label, name } of MONTHS) {
    process.stdout.write(`  Testing ${name}… `);
    const res = runMonth(fullDb, label);
    if (!res || !res.testRows) { console.log('no data'); continue; }
    allAlerts.push(...res.alerts);
    const s = computeStats(res.alerts);
    monthRows.push({ name, matches: res.testRows, ...s });
    console.log(`${res.alerts.length} alerts  hit=${s.hitPct.toFixed(1)}%  ROI@mid=${s.roiMid >= 0 ? '+' : ''}${s.roiMid.toFixed(1)}%`);
  }

  // ── Per-month summary ──────────────────────────────────────────────────────
  const totalMatches = monthRows.reduce((s, r) => s + r.matches, 0);
  const agg = computeStats(allAlerts);

  console.log('\n' + '═'.repeat(96));
  console.log(`ALL-MONTHS PRE-MATCH BACKTEST  (z≥2 · edge≥6pp · n≥35 · bl≥25% · tier=${LEAGUE_TIER})`);
  console.log('═'.repeat(96));
  console.log('  Month       matches  alerts  hit rate   baseline  edge    ROI@lo  ROI@mid  ROI@hi  P&L@mid');
  console.log('  ' + '─'.repeat(92));
  for (const r of monthRows) {
    const edge = r.hitPct - r.avgBl;
    console.log(
      `  ${r.name.padEnd(10)}  ${String(r.matches).padStart(7)}  ${String(r.n).padStart(6)}` +
      `  ${r.hitPct.toFixed(1).padStart(5)}%  ${r.avgBl.toFixed(1).padStart(5)}%` +
      `    ${(edge >= 0 ? '+' : '') + edge.toFixed(1)}pp` +
      `  ${(r.roiLo  >= 0 ? '+' : '') + r.roiLo.toFixed(1).padStart(6)}%` +
      `  ${(r.roiMid >= 0 ? '+' : '') + r.roiMid.toFixed(1).padStart(6)}%` +
      `  ${(r.roiHi  >= 0 ? '+' : '') + r.roiHi.toFixed(1).padStart(6)}%` +
      `  ${(r.pnlMid >= 0 ? '+' : '') + r.pnlMid.toFixed(1).padStart(6)}`
    );
  }
  console.log('  ' + '─'.repeat(88));
  const aggEdge = agg.hitPct - agg.avgBl;
  console.log(
    `  ${'TOTAL'.padEnd(10)}  ${String(totalMatches).padStart(7)}  ${String(agg.n).padStart(6)}` +
    `  ${agg.hitPct.toFixed(1).padStart(5)}%  ${agg.avgBl.toFixed(1).padStart(5)}%` +
    `    ${(aggEdge >= 0 ? '+' : '') + aggEdge.toFixed(1)}pp` +
    `  ${(agg.roiLo  >= 0 ? '+' : '') + agg.roiLo.toFixed(1).padStart(6)}%` +
    `  ${(agg.roiMid >= 0 ? '+' : '') + agg.roiMid.toFixed(1).padStart(6)}%` +
    `  ${(agg.roiHi  >= 0 ? '+' : '') + agg.roiHi.toFixed(1).padStart(6)}%` +
    `  ${(agg.pnlMid >= 0 ? '+' : '') + agg.pnlMid.toFixed(1).padStart(6)}`
  );
  console.log(`\n  Avg odds (fair)  : ${agg.avgOddsLo.toFixed(2)}`);
  console.log(`  Avg odds (mid)   : ${agg.avgOddsMid.toFixed(2)}`);
  console.log(`  Avg odds (safe)  : ${agg.avgOddsHi.toFixed(2)}`);

  // ── Per-bet breakdown ──────────────────────────────────────────────────────
  const byBet = new Map();
  for (const a of allAlerts) {
    if (!byBet.has(a.b.k)) byBet.set(a.b.k, []);
    byBet.get(a.b.k).push(a);
  }

  const betSummaries = [...byBet.entries()]
    .map(([, alts]) => {
      const known  = alts.filter(a => a.hit !== null && a.hit !== undefined);
      const hits   = known.filter(a => a.hit === true).length;
      const hitPct = known.length ? hits / known.length * 100 : 0;
      const avgBl  = avg(known.map(a => a.b.bl));
      const pnlLo  = known.reduce((s, a) => a.b.mo  ? s + (a.hit ? a.b.mo - 1 : -1) : s, 0);
      const pnlMid = known.reduce((s, a) => (a.b.mo && a.b.mo_mid)
        ? s + (a.hit ? (a.b.mo + a.b.mo_mid) / 2 - 1 : -1) : s, 0);
      const pnlHi  = known.reduce((s, a) => a.b.mo_mid ? s + (a.hit ? a.b.mo_mid - 1 : -1) : s, 0);
      const stLo   = known.filter(a => a.b.mo).length;
      const stMid  = known.filter(a => a.b.mo && a.b.mo_mid).length;
      const stHi   = known.filter(a => a.b.mo_mid).length;

      // Break-even odds at realized hit rate
      const beOdds  = hitPct > 0 ? 1 / (hitPct / 100) : null;
      // Required odds accounting for shrinkage
      const shrunk  = hitPct * (1 - SHRINK_PCT / 100);
      const reqOdds = shrunk > 0 ? 1 / (shrunk / 100) : null;

      return {
        label: alts[0].b.label, k: alts[0].b.k,
        count: known.length, hitPct, avgBl, edge: hitPct - avgBl,
        roiLo:  stLo  ? pnlLo  / stLo  * 100 : 0,
        roiMid: stMid ? pnlMid / stMid * 100 : 0,
        roiHi:  stHi  ? pnlHi  / stHi  * 100 : 0,
        avgOddsLo:  avg(known.filter(a => a.b.mo).map(a => a.b.mo)),
        avgOddsMid: avg(known.filter(a => a.b.mo && a.b.mo_mid).map(a => (a.b.mo + a.b.mo_mid) / 2)),
        avgOddsHi:  avg(known.filter(a => a.b.mo_mid).map(a => a.b.mo_mid)),
        beOdds, reqOdds,
      };
    })
    .filter(s => s.count >= 20)
    .sort((a, b) => b.roiHi - a.roiHi);

  console.log('\n' + '═'.repeat(110));
  console.log(`PER-BET BREAKDOWN — all months  (only bets with ≥20 alerts shown)`);
  console.log(`  BE-odds = 1/realized_hit  ·  Req-odds = 1/(hit×${(1-SHRINK_PCT/100).toFixed(2)}) = min odds for +EV with ${SHRINK_PCT}% shrinkage`);
  console.log('═'.repeat(110));
  console.log('  Bet                      ×cnt  hit%    bl%    edge   ROI@lo  ROI@mid  ROI@hi  OddsLo  OddsMid  OddsHi  BE    Req');
  console.log('  ' + '─'.repeat(106));

  for (const s of betSummaries) {
    const beStr  = s.beOdds  ? s.beOdds.toFixed(2)  : '—   ';
    const reqStr = s.reqOdds ? s.reqOdds.toFixed(2) : '—   ';
    const edge   = (s.edge >= 0 ? '+' : '') + s.edge.toFixed(1) + 'pp';
    const marker = s.roiHi > 0 ? ' ◄' : '';
    console.log(
      `  ${s.label.padEnd(23)} ×${String(s.count).padStart(4)}` +
      `  ${s.hitPct.toFixed(1).padStart(5)}%  ${s.avgBl.toFixed(1).padStart(5)}%` +
      `  ${edge.padStart(8)}` +
      `  ${(s.roiLo  >= 0 ? '+' : '') + s.roiLo.toFixed(1).padStart(6)}%` +
      `  ${(s.roiMid >= 0 ? '+' : '') + s.roiMid.toFixed(1).padStart(6)}%` +
      `  ${(s.roiHi  >= 0 ? '+' : '') + s.roiHi.toFixed(1).padStart(6)}%` +
      `   ${s.avgOddsLo.toFixed(2)}   ${s.avgOddsMid.toFixed(2)}   ${s.avgOddsHi.toFixed(2)}` +
      `   ${beStr}  ${reqStr}${marker}`
    );
  }

  // ── Minimum odds gate analysis ─────────────────────────────────────────────
  // Filter alerts by mo_mid threshold: only bet when conservative min odds ≥ X.
  // Shows impact of only chasing bets where market should offer longer odds.
  console.log('\n' + '═'.repeat(60));
  console.log('MINIMUM ODDS GATE  (filter by mo_mid ≥ threshold)');
  console.log('  Only accept alerts where conservative min odds ≥ X');
  console.log('  P&L simulated betting at exactly the threshold (worst case)');
  console.log('═'.repeat(60));
  console.log('  threshold  alerts  hit%   P&L    ROI');
  console.log('  ' + '─'.repeat(48));

  const THRESHOLDS = [1.40, 1.50, 1.55, 1.60, 1.65, 1.70, 1.75, 1.80, 1.90, 2.00];
  for (const minOdds of THRESHOLDS) {
    const filtered = allAlerts.filter(a => a.b.mo_mid && a.b.mo_mid >= minOdds);
    const known    = filtered.filter(a => a.hit !== null && a.hit !== undefined);
    if (!known.length) continue;
    const hits = known.filter(a => a.hit === true).length;
    const hitPct = hits / known.length * 100;
    // P&L if you bet at exactly this minimum threshold
    const pnl = known.reduce((s, a) => s + (a.hit ? minOdds - 1 : -1), 0);
    const roi = pnl / known.length * 100;
    const marker = roi > 0 ? ' ◄ profitable' : '';
    console.log(
      `  ≥ ${minOdds.toFixed(2).padStart(5)}   ${String(known.length).padStart(6)}  ${hitPct.toFixed(1).padStart(5)}%  ${(pnl >= 0 ? '+' : '') + pnl.toFixed(1).padStart(7)}u  ${(roi >= 0 ? '+' : '') + roi.toFixed(1).padStart(6)}%${marker}`
    );
  }

  // ── Positive ROI bet whitelist ─────────────────────────────────────────────
  console.log('\n' + '═'.repeat(72));
  console.log('PROFITABLE BET TYPES  (ROI@safe > 0 AND count ≥ 20)');
  console.log('  These bets beat the model\'s own conservative odds estimate.');
  console.log('  Required odds = minimum to find in market for +EV after shrinkage.');
  console.log('═'.repeat(72));

  const profitable = betSummaries.filter(s => s.roiHi > 0);
  if (!profitable.length) {
    console.log('  None found at current thresholds.');
  } else {
    for (const s of profitable) {
      console.log(`  ✓ ${s.label}`);
      console.log(`    Hit rate  : ${s.hitPct.toFixed(1)}% (baseline ${s.avgBl.toFixed(1)}%, edge +${s.edge.toFixed(1)}pp)`);
      console.log(`    ROI@safe  : +${s.roiHi.toFixed(1)}%  (${s.count} alerts over ${monthRows.length} months)`);
      console.log(`    Avg odds  : fair=${s.avgOddsLo.toFixed(2)}  mid=${s.avgOddsMid.toFixed(2)}  safe=${s.avgOddsHi.toFixed(2)}`);
      console.log(`    Find ≥    : ${s.reqOdds ? s.reqOdds.toFixed(2) : '—'} for +EV after ${SHRINK_PCT}% shrinkage`);
      console.log('');
    }
  }
}

main();
