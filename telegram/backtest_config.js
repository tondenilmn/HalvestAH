'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// CONFIGURABLE BACKTEST — edit the CONFIG block below, then run:
//   node backtest_config.js
//
// How it works:
//   1. Your CONFIG filters are applied to the full historical DB → signal pool
//   2. The signal pool is scored against the baseline → z-scores, edges
//   3. Qualifying bets (above MIN_Z / MIN_EDGE / MIN_N / MIN_BASELINE) are listed
//   4. For each qualifying bet: month-by-month actual hit rate shows OOS stability
//
// Signal values:
//   line_move     : 'DEEPER' (fav steamed) | 'SHRANK' (dog drifted) | 'STABLE' | 'ANY'
//   fav_odds_move : 'IN'  (fav odds shortened)  | 'OUT' (fav odds drifted)  | 'STABLE' | 'ANY'
//   dog_odds_move : 'IN'  (dog odds shortened)  | 'OUT' (dog odds drifted)  | 'STABLE' | 'ANY'
//   tl_move       : 'UP'  (more goals expected) | 'DOWN' (fewer goals)      | 'STABLE' | 'ANY'
//   over_move     : 'IN'  (over odds shortened) | 'OUT' (over odds drifted) | 'STABLE' | 'ANY'
//   under_move    : 'IN'  (under shortened)     | 'OUT' (under drifted)     | 'STABLE' | 'ANY'
// ══════════════════════════════════════════════════════════════════════════════

// ─────────────────────────── YOUR CONFIGURATION ───────────────────────────────
const CONFIG = {

  // ── League tier ─────────────────────────────────────────────────────────────
  LEAGUE_TIER:  'ALL',  // 'TOP' | 'TOP+MAJOR' | 'ALL'

  // ── AH line ─────────────────────────────────────────────────────────────────
  fav_line:  'ANY',           // 0.25 | 0.50 | 0.75 | 1.00 | 1.25 | 1.50 | 'ANY'
  fav_side:  'HOME',           // 'HOME' | 'AWAY' | 'ANY'

  // ── Pre-match market signals ─────────────────────────────────────────────────
  line_move:     'DEEPER',       // 'DEEPER' | 'SHRANK' | 'STABLE' | 'ANY'
  fav_odds_move: 'ANY',       // 'IN' (fav shortened) | 'OUT' (fav drifted) | 'STABLE' | 'ANY'
  dog_odds_move: 'ANY',       // 'IN' (dog shortened) | 'OUT' (dog drifted) | 'STABLE' | 'ANY'
  tl_move:       'ANY',       // 'UP' (more goals) | 'DOWN' (fewer goals) | 'STABLE' | 'ANY'
  over_move:     'ANY',       // 'IN' (over shortened) | 'OUT' (over drifted) | 'STABLE' | 'ANY'
  under_move:    'ANY',       // 'IN' (under shortened) | 'OUT' (under drifted) | 'STABLE' | 'ANY'

  // ── AH line movement magnitude (in handicap units, e.g. 0.25 = 1 step) ──────
  lm_min:  null,              // e.g. 0.45 = at least 2 steps toward fav
  lm_max:  null,              // e.g. 0.55 = at most 2 steps (combined: exactly 2 steps)

  // ── Total line closing value range ───────────────────────────────────────────
  tl_min:  null,              // e.g. 2.5 (only matches with TL ≥ 2.5)
  tl_max:  null,              // e.g. 3.0 (only matches with TL ≤ 3.0)

  // ── Game state (optional — set trigger to null to disable) ──────────────────
  // NB: home_goals / away_goals are always in HOME/AWAY orientation, not fav/dog.
  game_state: null,
  // game_state: { trigger: 'HT', home_goals: 0, away_goals: 0 },    // 0-0 at HT
  // game_state: { trigger: 'HT', home_goals: 1, away_goals: 0 },    // home leads 1-0 at HT
  // game_state: { trigger: 'HT', home_goals: 0, away_goals: 1 },    // away leads 0-1 at HT
  // game_state: { trigger: 'FIRST_GOAL', first_goal: 'FAV_1H' },    // fav scored first in 1H
  // game_state: { trigger: 'FIRST_GOAL', first_goal: 'DOG_1H' },    // dog scored first in 1H
  // game_state: { trigger: 'FIRST_GOAL', first_goal: 'NO_GOAL' },   // no goal in 1H
  // game_state: { trigger: 'INPLAY_2H', home_2h: 0, away_2h: 0 },  // 0-0 so far in 2H

  // ── Scoring thresholds ───────────────────────────────────────────────────────
  MIN_N:        30,           // minimum rows in signal pool
  MIN_Z:         2.5,         // minimum z-score to show
  MIN_EDGE:      0,           // minimum pp above baseline (use 5 or 6 for tighter filter)
  MIN_BASELINE:  0,           // minimum baseline hit rate % (use 25 to exclude rare events)

  // ── Bet filter (null = show all 32 bets) ────────────────────────────────────
  BETS_FILTER: null,
  // BETS_FILTER: ['over05_2H', 'over15_2H', 'favScored2H', 'under15_2H'],
};
// ─────────────────────────── END OF CONFIGURATION ─────────────────────────────

const path = require('path');
const {
  loadDatabase,
  applyConfig,
  applyBaselineConfig,
  applyGameState,
  scoreBets,
} = require('./engine');

const DATA_DIR = path.resolve(__dirname, '../static/data');

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
  if (tier === 'TOP')       return db.filter(r => r.league_tier === 'TOP');
  if (tier === 'MAJOR')     return db.filter(r => r.league_tier === 'MAJOR');
  if (tier === 'TOP+MAJOR') return db.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
  return db;
}

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}
function sign(v) { return v >= 0 ? '+' : ''; }

// Build the engine-compatible cfg object from CONFIG
function buildEngineCfg(cfg) {
  return {
    fav_line:      cfg.fav_line,
    fav_side:      cfg.fav_side,
    line_move:     cfg.line_move,
    fav_odds_move: cfg.fav_odds_move,
    dog_odds_move: cfg.dog_odds_move,
    tl_move:       cfg.tl_move,
    over_move:     cfg.over_move,
    under_move:    cfg.under_move,
    // No odds_tolerance / fav_oc / dog_oc by default (add here if needed)
  };
}

// Apply magnitude and range filters that sit on top of the engine cfg
function applyExtraFilters(rows, cfg) {
  let r = rows;

  // AH line movement magnitude
  if (cfg.lm_min != null)
    r = r.filter(row => row.fav_lo != null && (row.fav_lc - row.fav_lo) >= cfg.lm_min);
  if (cfg.lm_max != null)
    r = r.filter(row => row.fav_lo != null && (row.fav_lc - row.fav_lo) <= cfg.lm_max);

  // Total line closing range
  if (cfg.tl_min != null)
    r = r.filter(row => row.tl_c != null && row.tl_c >= cfg.tl_min);
  if (cfg.tl_max != null)
    r = r.filter(row => row.tl_c != null && row.tl_c <= cfg.tl_max);

  return r;
}

// Full filter pipeline: engine cfg + extra filters + game state
function filterRows(rows, cfg) {
  const engineCfg = buildEngineCfg(cfg);
  let r = applyConfig(rows, engineCfg);
  r = applyExtraFilters(r, cfg);
  if (cfg.game_state && cfg.game_state.trigger)
    r = applyGameState(r, cfg.game_state);
  return r;
}

// Baseline: same AH line + side (no signal filters, no magnitude, no GS)
function baselineRows(rows, cfg) {
  const blCfg = {
    fav_line: cfg.fav_line,
    fav_side: cfg.fav_side,
  };
  let r = applyBaselineConfig(rows, blCfg);
  // Propagate TL range to baseline so the comparison is fair
  if (cfg.tl_min != null) r = r.filter(row => row.tl_c != null && row.tl_c >= cfg.tl_min);
  if (cfg.tl_max != null) r = r.filter(row => row.tl_c != null && row.tl_c <= cfg.tl_max);
  return r;
}

// Format a config value for display
function cfgStr(key, val) {
  if (val === 'ANY' || val == null) return null;
  return `${key}=${val}`;
}

// Print CONFIG summary
function printConfigSummary(cfg) {
  const signals = [
    cfgStr('LM',   cfg.line_move),
    cfgStr('FOM',  cfg.fav_odds_move),
    cfgStr('DOM',  cfg.dog_odds_move),
    cfgStr('TLM',  cfg.tl_move),
    cfgStr('OVM',  cfg.over_move),
    cfgStr('UNM',  cfg.under_move),
    cfg.lm_min  != null ? `lm≥${cfg.lm_min}`  : null,
    cfg.lm_max  != null ? `lm≤${cfg.lm_max}`  : null,
    cfg.tl_min  != null ? `TL≥${cfg.tl_min}`  : null,
    cfg.tl_max  != null ? `TL≤${cfg.tl_max}`  : null,
  ].filter(Boolean);

  const lineStr = cfg.fav_line === 'ANY' ? 'AH=ANY' : `AH=−${cfg.fav_line}`;
  const sideStr = cfg.fav_side === 'ANY' ? '' : `  side=${cfg.fav_side}`;

  console.log(`  ${lineStr}${sideStr}  tier=${cfg.LEAGUE_TIER}`);
  if (signals.length) console.log(`  Signals: ${signals.join('  ')}`);
  else                console.log(`  Signals: (none — full baseline only)`);

  if (cfg.game_state && cfg.game_state.trigger) {
    const gs = cfg.game_state;
    if (gs.trigger === 'HT')
      console.log(`  GameState: HT score ${gs.home_goals ?? 0}–${gs.away_goals ?? 0} (home–away)`);
    else if (gs.trigger === 'FIRST_GOAL')
      console.log(`  GameState: first goal = ${gs.first_goal}`);
    else if (gs.trigger === 'INPLAY_2H')
      console.log(`  GameState: 2H in-play score ≥ ${gs.home_2h ?? 0}–${gs.away_2h ?? 0}`);
  }

  console.log(`  Thresholds: n≥${cfg.MIN_N}  z≥${cfg.MIN_Z}  edge≥${cfg.MIN_EDGE}pp  bl≥${cfg.MIN_BASELINE}%`);
  if (cfg.BETS_FILTER) console.log(`  Bet filter: [${cfg.BETS_FILTER.join(', ')}]`);
}

// ── Main ───────────────────────────────────────────────────────────────────────
function main() {
  console.log(`\nLoading database…`);
  const rawDb  = loadDatabase(DATA_DIR);
  const fullDb = applyTier(rawDb, CONFIG.LEAGUE_TIER);
  console.log(`Total rows: ${rawDb.length}  (tier-filtered: ${fullDb.length})\n`);

  console.log('═'.repeat(80));
  console.log('CONFIGURABLE BACKTEST');
  printConfigSummary(CONFIG);
  console.log('═'.repeat(80));

  // ── 1. Full-history signal pool ─────────────────────────────────────────────
  const sigRows  = filterRows(fullDb, CONFIG);
  const blRows   = baselineRows(fullDb, CONFIG);
  const blSide   = blRows.filter(r => r.fav_side === CONFIG.fav_side || CONFIG.fav_side === 'ANY');

  console.log(`\n── Signal pool (full history) ─────────────────────────────────────────────`);
  console.log(`  Matched rows   : ${sigRows.length}`);
  console.log(`  Baseline rows  : ${blRows.length}`);
  if (!sigRows.length) { console.log('\n⚠  No rows match your CONFIG. Loosen the filters.'); return; }
  if (sigRows.length < CONFIG.MIN_N) { console.log(`\n⚠  Pool (${sigRows.length}) below MIN_N (${CONFIG.MIN_N}). Results unreliable.`); }

  // ── 2. Score bets ────────────────────────────────────────────────────────────
  const allBets = scoreBets(sigRows, blRows, blSide, CONFIG.MIN_N);

  const qualifying = allBets.filter(b => {
    if (b.z    <  CONFIG.MIN_Z)        return false;
    if (b.edge <  CONFIG.MIN_EDGE)     return false;
    if (b.bl   <  CONFIG.MIN_BASELINE) return false;
    if (CONFIG.BETS_FILTER && !CONFIG.BETS_FILTER.includes(b.k)) return false;
    return true;
  });

  console.log(`\n── Qualifying bets (historical signal pool, full DB) ───────────────────────`);
  console.log(`  Found ${allBets.length} bets scored  ·  ${qualifying.length} pass thresholds\n`);

  if (!qualifying.length) {
    console.log('  No bets qualify. Try lowering MIN_Z / MIN_EDGE or loosening signal filters.\n');
    // Show top 5 closest misses
    const sorted = allBets.filter(b => CONFIG.BETS_FILTER == null || CONFIG.BETS_FILTER.includes(b.k))
      .sort((a, b) => b.z - a.z).slice(0, 8);
    console.log('  Top bets by z-score (closest misses):');
    console.log(`  ${'Bet'.padEnd(24)} ${'n'.padStart(5)}  ${'hit%'.padStart(6)}  ${'bl%'.padStart(6)}  ${'edge'.padStart(7)}  ${'z'.padStart(6)}  ${'mo'.padStart(6)}`);
    console.log('  ' + '─'.repeat(72));
    for (const b of sorted) {
      console.log(
        `  ${b.label.padEnd(24)} ${String(b.n).padStart(5)}` +
        `  ${b.p.toFixed(1).padStart(5)}%` +
        `  ${b.bl.toFixed(1).padStart(5)}%` +
        `  ${(sign(b.edge) + b.edge.toFixed(1) + 'pp').padStart(7)}` +
        `  ${b.z.toFixed(2).padStart(6)}` +
        `  ${b.mo ? b.mo.toFixed(2) : '—'}`
      );
    }
    return;
  }

  // Sort qualifying bets by z descending
  qualifying.sort((a, b) => b.z - a.z);

  console.log(`  ${'Bet'.padEnd(24)} ${'n'.padStart(5)}  ${'hit%'.padStart(6)}  ${'bl%'.padStart(6)}  ${'edge'.padStart(7)}  ${'z'.padStart(6)}  ${'mo (fair)'.padStart(10)}  ${'mo_lo (safe)'.padStart(13)}`);
  console.log('  ' + '─'.repeat(88));
  for (const b of qualifying) {
    console.log(
      `  ${b.label.padEnd(24)} ${String(b.n).padStart(5)}` +
      `  ${b.p.toFixed(1).padStart(5)}%` +
      `  ${b.bl.toFixed(1).padStart(5)}%` +
      `  ${(sign(b.edge) + b.edge.toFixed(1) + 'pp').padStart(7)}` +
      `  ${b.z.toFixed(2).padStart(6)}` +
      `  ${(b.mo    ? b.mo.toFixed(2)    : '—').padStart(10)}` +
      `  ${(b.mo_lo ? b.mo_lo.toFixed(2) : '—').padStart(13)}`
    );
  }

  // ── 3. Month-by-month actual hit rate (OOS stability check) ─────────────────
  console.log(`\n── Out-of-sample monthly breakdown ────────────────────────────────────────`);
  console.log(`  For each bet: actual hit rate in the test month (rows matching your CONFIG)`);
  console.log(`  Hist = predicted from prior history  ·  Actual = realized that month\n`);

  for (const bet of qualifying) {
    const monthData = [];
    let totN = 0, totHits = 0;

    for (const { label, name } of MONTHS) {
      const testRows = fullDb.filter(r => r.file_label.includes(label));
      if (!testRows.length) continue;

      // Signal rows in the test month
      const testSig  = filterRows(testRows, CONFIG);
      if (!testSig.length) continue;

      const hits    = testSig.filter(r => r[bet.k] === true).length;
      const actual  = hits / testSig.length * 100;

      // Historical signal pool from all OTHER months
      const histDb   = fullDb.filter(r => !r.file_label.includes(label));
      const histSig  = filterRows(histDb, CONFIG);
      const histBl   = baselineRows(histDb, CONFIG);
      const histBlSd = histBl.filter(r => r.fav_side === CONFIG.fav_side || CONFIG.fav_side === 'ANY');
      const histBets = scoreBets(histSig, histBl, histBlSd, CONFIG.MIN_N);
      const histBet  = histBets.find(b => b.k === bet.k);
      const histPct  = histBet ? histBet.p : null;
      const mo       = histBet ? histBet.mo : null;
      const pnl      = mo != null
        ? hits * (mo - 1) - (testSig.length - hits) * 1
        : null;
      const roi      = (pnl != null && testSig.length) ? pnl / testSig.length * 100 : null;

      totN    += testSig.length;
      totHits += hits;
      monthData.push({ name, n: testSig.length, hits, actual, histPct, mo, roi });
    }

    if (!monthData.length) continue;

    const overallActual = totN ? totHits / totN * 100 : 0;
    const actuals       = monthData.map(m => m.actual);
    const sigmaActual   = std(actuals);
    const histPcts      = monthData.map(m => m.histPct).filter(v => v != null);
    const avgHistPred   = histPcts.length ? avg(histPcts) : bet.p;
    const rois          = monthData.map(m => m.roi).filter(v => v != null);
    const totPnl        = monthData.reduce((s, m) => {
      if (m.mo == null) return s;
      return s + m.hits * (m.mo - 1) - (m.n - m.hits) * 1;
    }, 0);
    const overallRoi    = totN ? totPnl / totN * 100 : 0;

    console.log(`  ┌─ ${bet.label}`);
    console.log(`  │  Hist hit%=${bet.p.toFixed(1)}%  baseline=${bet.bl.toFixed(1)}%  edge=${sign(bet.edge)}${bet.edge.toFixed(1)}pp  z=${bet.z.toFixed(2)}  n=${bet.n}`);
    console.log(`  │  Fair odds: ${bet.mo ? bet.mo.toFixed(2) : '—'}   Safe odds (Wilson CI): ${bet.mo_lo ? bet.mo_lo.toFixed(2) : '—'}`);
    console.log(`  │`);
    console.log(`  │  Month        test_n   hist%   actual%   diff      ROI@fair`);
    console.log(`  │  ${'─'.repeat(62)}`);

    for (const m of monthData) {
      const diff    = m.histPct != null ? m.actual - m.histPct : null;
      const diffStr = diff != null ? `${sign(diff)}${diff.toFixed(1)}pp` : '   —  ';
      const histStr = m.histPct != null ? m.histPct.toFixed(1) + '%' : '   —  ';
      const roiStr  = m.roi != null ? `${sign(m.roi)}${m.roi.toFixed(1)}%` : '   —  ';
      console.log(
        `  │  ${m.name.padEnd(12)} ${String(m.n).padStart(6)}` +
        `  ${histStr.padStart(7)}` +
        `  ${m.actual.toFixed(1).padStart(7)}%` +
        `  ${diffStr.padStart(8)}` +
        `  ${roiStr.padStart(9)}`
      );
    }

    console.log(`  │  ${'─'.repeat(62)}`);
    console.log(
      `  │  ${'TOTAL'.padEnd(12)} ${String(totN).padStart(6)}` +
      `  ${avgHistPred.toFixed(1).padStart(6)}%` +
      `  ${overallActual.toFixed(1).padStart(7)}%` +
      `  ${sign(overallActual - avgHistPred)}${(overallActual - avgHistPred).toFixed(1).padStart(5)}pp` +
      `  ${(sign(overallRoi) + overallRoi.toFixed(1) + '%').padStart(9)}`
    );
    console.log(`  │  σ(monthly actual): ${sigmaActual.toFixed(1)}%   σ(monthly ROI): ${std(rois).toFixed(1)}%`);
    console.log(`  └${'─'.repeat(66)}\n`);
  }

  // ── 4. Simple P&L simulation at fair and safe odds ──────────────────────────
  console.log(`── P&L simulation (betting all qualifying bets, full DB) ──────────────────`);
  console.log(`  At fair odds (mo): betting at exactly the break-even odds from history`);
  console.log(`  At safe odds (mo_lo): betting at the Wilson CI lower bound (conservative)\n`);

  // For each qualifying bet, compute OOS P&L month-by-month
  let totAlerts = 0, totHitsFair = 0;
  let pnlFair = 0, pnlSafe = 0;

  for (const { label } of MONTHS) {
    const testRows = fullDb.filter(r => r.file_label.includes(label));
    if (!testRows.length) continue;

    const histDb  = fullDb.filter(r => !r.file_label.includes(label));
    const histSig = filterRows(histDb, CONFIG);
    const histBl  = baselineRows(histDb, CONFIG);
    const histBlSd = histBl.filter(r => r.fav_side === CONFIG.fav_side || CONFIG.fav_side === 'ANY');
    const histBets = scoreBets(histSig, histBl, histBlSd, CONFIG.MIN_N);

    const testSig = filterRows(testRows, CONFIG);
    if (!testSig.length) continue;

    for (const b of histBets) {
      if (b.z    <  CONFIG.MIN_Z)        continue;
      if (b.edge <  CONFIG.MIN_EDGE)     continue;
      if (b.bl   <  CONFIG.MIN_BASELINE) continue;
      if (CONFIG.BETS_FILTER && !CONFIG.BETS_FILTER.includes(b.k)) continue;
      if (!b.mo || !b.mo_lo) continue;

      for (const r of testSig) {
        const hit = r[b.k] === true;
        totAlerts++;
        if (hit) totHitsFair++;
        pnlFair += hit ? b.mo    - 1 : -1;
        pnlSafe += hit ? b.mo_lo - 1 : -1;
      }
    }
  }

  if (totAlerts) {
    const hitPct = totHitsFair / totAlerts * 100;
    console.log(`  Total bets placed  : ${totAlerts}`);
    console.log(`  Hit rate           : ${hitPct.toFixed(1)}% (${totHitsFair}/${totAlerts})`);
    console.log(`  P&L @ fair odds    : ${sign(pnlFair)}${pnlFair.toFixed(2)}u   ROI=${sign(pnlFair/totAlerts*100)}${(pnlFair/totAlerts*100).toFixed(1)}%`);
    console.log(`  P&L @ safe odds    : ${sign(pnlSafe)}${pnlSafe.toFixed(2)}u   ROI=${sign(pnlSafe/totAlerts*100)}${(pnlSafe/totAlerts*100).toFixed(1)}%`);
    console.log(`\n  Note: "fair odds" = 1/hit_rate from prior-month history.`);
    console.log(`        "safe odds" = 1/Wilson_CI_lower (more conservative).`);
    console.log(`        Positive ROI@safe = strategy beats its own conservative estimate.`);
  } else {
    console.log('  No bets to simulate (signal pool too small in individual months).');
  }

  console.log('');
}

main();
