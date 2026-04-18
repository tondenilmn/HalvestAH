'use strict';
// ── Cross-book backtest ────────────────────────────────────────────────────────
// Merges Pinnacle + Bet365 + (optional Sbobet) CSVs by match, classifies
// cross-book configurations, and reports hit rates per outcome.
//
// Folder setup (under static/data/):
//   pinnacle/  ← Pinnacle exports
//   bet365/    ← Bet365 exports
//   sbobet/    ← Sbobet exports (optional)
//
// Usage:
//   node backtest_crossbook.js              — TOP+MAJOR, all configs
//   node backtest_crossbook.js --all        — all leagues
//   node backtest_crossbook.js --summary    — hide per-bet rows, show config totals only
//   node backtest_crossbook.js --min-n=20   — override minimum n (default 25)

const fs   = require('fs');
const path = require('path');
const Papa = require('papaparse');
const { processRow, BETS, zScore, wilsonCI, classifyLeague } = require('./engine');

// ── Config ────────────────────────────────────────────────────────────────────
const DATA_DIR   = path.resolve(__dirname, '../Crossbooks');
const PINN_DIR   = path.join(DATA_DIR, 'Pinnacle_Data_months');
const B365_DIR   = path.join(DATA_DIR, 'Bet365_Data_months');
const SBO_DIR    = path.join(DATA_DIR, 'Sbobet_Data_months');

const LEAGUE_TIER = process.argv.includes('--all') ? 'ALL' : 'TOP+MAJOR';
const SUMMARY     = process.argv.includes('--summary');
const MIN_N_ARG   = (process.argv.find(a => a.startsWith('--min-n=')) || '').split('=')[1];
const MIN_N       = MIN_N_ARG ? parseInt(MIN_N_ARG, 10) : 25;
const MIN_EDGE    = 3;   // pp above baseline to show a bet row

// Thresholds for cross-book signal classification
const LM_THRESH  = 0.20;   // fav line move ≥ 0.20 = meaningful (quarter-line +)
const TL_THRESH  = 0.20;   // TL move ≥ 0.20 = meaningful
const GAP_THRESH = 0.25;   // closing line gap ≥ 0.25 = mispricing

// ── CSV loader (no manifest required) ─────────────────────────────────────────
function loadFolder(dir) {
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  function walk(d) {
    for (const f of fs.readdirSync(d).sort()) {
      const full = path.join(d, f);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (!f.toLowerCase().endsWith('.csv')) continue;
      const csv  = fs.readFileSync(full, 'utf8');
      const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true });
      const label = path.basename(f, '.csv');
      for (const row of data) {
        const p = processRow(row, label);
        if (p) rows.push(p);
      }
    }
  }
  walk(dir);
  return rows;
}

// ── Team-name normalisation for fuzzy match-key ───────────────────────────────
function normTeam(s) {
  return (s || '').toLowerCase()
    .replace(/\bfc\b|\bafc\b|\bsc\b|\bfk\b|\bsk\b|\bbk\b|\bac\b|\bas\b/g, '')
    .replace(/\bunited\b/g, 'utd')
    .replace(/\bcity\b/g,   'city')   // keep city as-is
    .replace(/[^a-z0-9]/g, '')
    .trim();
}

function matchKey(r) {
  return `${r.date}|${normTeam(r.home_team)}|${normTeam(r.away_team)}`;
}

// ── Cross-book signal classification ─────────────────────────────────────────
// All signals are fav-normalised using Pinnacle's fav_side as reference.
// Returns: config label string
function classifyConfig(pinn, b365, sbo) {
  // Skip when books disagree on which team is favourite (level-ball noise)
  if (b365.fav_side !== pinn.fav_side) return 'DISAGREEMENT';
  if (sbo && sbo.fav_side !== pinn.fav_side) return 'DISAGREEMENT';

  // Fav-normalised line movement per book (positive = fav handicap deepened)
  const p_lm = pinn.fav_lc - pinn.fav_lo;
  const b_lm = b365.fav_lc - b365.fav_lo;
  const s_lm = sbo ? sbo.fav_lc - sbo.fav_lo : null;
  const hasSbo = s_lm !== null;

  // TL movement per book
  const p_tlm = (pinn.tl_c || 0) - (pinn.tl_o || 0);
  const b_tlm = (b365.tl_c || 0) - (b365.tl_o || 0);

  // Closing line gap (positive = Pinnacle priced fav higher than Bet365)
  const gap = pinn.fav_lc - b365.fav_lc;

  // ── AH line configs ──────────────────────────────────────────────────────
  // 1. All books moved fav, Pinnacle led
  if (p_lm >= LM_THRESH && b_lm > 0 && p_lm >= b_lm &&
      (!hasSbo || s_lm > 0))
    return 'ALL_STEAM_FAV';

  // 2. All books moved dog, Pinnacle led
  if (p_lm <= -LM_THRESH && b_lm < 0 && p_lm <= b_lm &&
      (!hasSbo || s_lm < 0))
    return 'ALL_STEAM_DOG';

  // 3. Pinnacle moved fav, Bet365 was flat (sharp-only signal)
  if (p_lm >= LM_THRESH && Math.abs(b_lm) < 0.10)
    return 'PINN_ONLY_FAV';

  // 4. Pinnacle moved dog, Bet365 was flat
  if (p_lm <= -LM_THRESH && Math.abs(b_lm) < 0.10)
    return 'PINN_ONLY_DOG';

  // 5. Bet365 moved fav, Pinnacle flat (public/square signal — fade candidate)
  if (b_lm >= LM_THRESH && Math.abs(p_lm) < 0.10)
    return 'B365_ONLY_FAV';

  // 6. Bet365 moved dog, Pinnacle flat
  if (b_lm <= -LM_THRESH && Math.abs(p_lm) < 0.10)
    return 'B365_ONLY_DOG';

  // ── TL configs ───────────────────────────────────────────────────────────
  // 7. TL steamed up on both books
  if (p_tlm >= TL_THRESH && b_tlm >= 0.10)
    return 'TL_STEAM_UP';

  // 8. TL steamed down on both books
  if (p_tlm <= -TL_THRESH && b_tlm <= -0.10)
    return 'TL_STEAM_DOWN';

  // ── Closing-gap configs ──────────────────────────────────────────────────
  // 9. Pinnacle priced fav materially higher than Bet365 at close
  if (gap >= GAP_THRESH) return 'CLOSING_GAP_FAV';

  // 10. Pinnacle priced dog materially higher (Bet365 has Pinn-endorsed fav cheaper)
  if (gap <= -GAP_THRESH) return 'CLOSING_GAP_DOG';

  return 'NONE';
}

// ── Stats helpers ─────────────────────────────────────────────────────────────
function hitRate(rows, key) {
  if (!rows.length) return 0;
  return rows.filter(r => r[key] === true).length / rows.length * 100;
}

function printConfigStats(label, desc, cfgRows, blRows) {
  const n = cfgRows.length;
  console.log(`\n${'━'.repeat(70)}`);
  console.log(`  ${label}  (n=${n})`);
  console.log(`  ${desc}`);
  if (n < MIN_N) {
    console.log(`  [too few rows — need at least ${MIN_N}]`);
    return;
  }
  if (SUMMARY) return;

  // Collect bets with meaningful edge.
  // For side-filtered bets (Home/Away wins), compare only the matching fav_side
  // in both cfg and baseline — otherwise mixing HOME+AWAY fav in cfgRows while
  // baseline is one side only produces artificial edges.
  const rows = [];
  for (const b of BETS) {
    const cfgPool = b.favSideBaseline
      ? cfgRows.filter(r => r.fav_side === b.favSideBaseline)
      : cfgRows;
    const blPool  = b.favSideBaseline
      ? blRows.filter(r => r.fav_side === b.favSideBaseline)
      : blRows;
    const nPool = cfgPool.length;
    if (nPool < MIN_N) continue;
    const p    = hitRate(cfgPool, b.k);
    const bl   = hitRate(blPool,  b.k);
    const edge = p - bl;
    if (Math.abs(edge) < MIN_EDGE) continue;
    const z    = zScore(cfgPool, blPool, b.k);
    if (Math.abs(z) < 1.5) continue;
    const [lo, hi] = wilsonCI(p, nPool);
    rows.push({ label: b.label, p, bl, edge, z, lo, hi, nPool });
  }

  if (!rows.length) {
    console.log(`  No bets above edge=${MIN_EDGE}pp / z≥1.5`);
    return;
  }

  rows.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));

  const hdr = `  ${'Bet'.padEnd(22)} ${'hit%'.padStart(5)}  ${'base%'.padStart(5)}  ${'edge'.padStart(5)}  ${'z'.padStart(5)}  ${'n'.padStart(5)}  CI`;
  console.log(hdr);
  console.log('  ' + '─'.repeat(72));
  for (const r of rows) {
    const sign = r.edge >= 0 ? '+' : '';
    console.log(
      `  ${r.label.padEnd(22)} ` +
      `${r.p.toFixed(1).padStart(5)}  ` +
      `${r.bl.toFixed(1).padStart(5)}  ` +
      `${(sign + r.edge.toFixed(1)).padStart(5)}  ` +
      `${r.z.toFixed(1).padStart(5)}  ` +
      `${String(r.nPool).padStart(5)}  ` +
      `[${r.lo.toFixed(0)}–${r.hi.toFixed(0)}%]`
    );
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  console.log('\n═══ Cross-book backtest ═══════════════════════════════════════════════');
  console.log(`  League tier : ${LEAGUE_TIER}`);
  console.log(`  Min N       : ${MIN_N}`);

  // Load each book
  const pinnAll = loadFolder(PINN_DIR);
  const b365All = loadFolder(B365_DIR);
  const sboAll  = loadFolder(SBO_DIR);   // may be [] if folder absent

  if (!pinnAll.length) {
    console.error(`\nNo Pinnacle rows found in ${PINN_DIR}`);
    console.error('Create the folder and put your Pinnacle CSVs there.');
    process.exit(1);
  }
  if (!b365All.length) {
    console.error(`\nNo Bet365 rows found in ${B365_DIR}`);
    console.error('Create the folder and put your Bet365 CSVs there.');
    process.exit(1);
  }

  console.log(`\n  Pinnacle rows : ${pinnAll.length}`);
  console.log(`  Bet365 rows   : ${b365All.length}`);
  if (sboAll.length) console.log(`  Sbobet rows   : ${sboAll.length}`);
  else console.log('  Sbobet        : not found (running 2-book mode)');

  // Apply tier filter
  function inTier(r) {
    if (LEAGUE_TIER === 'ALL') return true;
    return r.league_tier === 'TOP' || r.league_tier === 'MAJOR';
  }

  // Build lookup maps by match key
  const b365Map = new Map();
  for (const r of b365All) { if (inTier(r)) b365Map.set(matchKey(r), r); }

  const sboMap = new Map();
  for (const r of sboAll)  { if (inTier(r)) sboMap.set(matchKey(r), r); }

  // Match rows across books
  const matched = [];   // { pinn, b365, sbo|null, config }
  for (const pinn of pinnAll) {
    if (!inTier(pinn)) continue;
    const key  = matchKey(pinn);
    const b365 = b365Map.get(key);
    if (!b365) continue;                 // Bet365 is required
    const sbo  = sboMap.get(key) || null;

    const config = classifyConfig(pinn, b365, sbo);
    matched.push({ pinn, b365, sbo, config });
  }

  console.log(`\n  Matched rows  : ${matched.length}`);

  // Baseline = ALL matched Pinnacle rows (regardless of config)
  const blRows = matched.map(m => m.pinn);

  // Group by config
  const CONFIG_ORDER = [
    'ALL_STEAM_FAV', 'ALL_STEAM_DOG',
    'PINN_ONLY_FAV', 'PINN_ONLY_DOG',
    'B365_ONLY_FAV', 'B365_ONLY_DOG',
    'TL_STEAM_UP', 'TL_STEAM_DOWN',
    'CLOSING_GAP_FAV', 'CLOSING_GAP_DOG',
  ];

  const CONFIG_DESC = {
    ALL_STEAM_FAV:    'All books moved toward fav, Pinnacle led — strongest sharp signal',
    ALL_STEAM_DOG:    'All books moved toward dog, Pinnacle led',
    PINN_ONLY_FAV:    'Pinnacle moved fav (≥0.20), Bet365 flat — sharp-only, Bet365 offers value',
    PINN_ONLY_DOG:    'Pinnacle moved dog (≥0.20), Bet365 flat',
    B365_ONLY_FAV:    'Bet365 moved fav (≥0.20), Pinnacle flat — public/square money, fade candidate',
    B365_ONLY_DOG:    'Bet365 moved dog, Pinnacle flat — fade candidate',
    TL_STEAM_UP:      'TL steamed up on both books — market expects goals',
    TL_STEAM_DOWN:    'TL steamed down on both books — market expects low scoring',
    CLOSING_GAP_FAV:  'Pinnacle closing line ≥0.25 more fav-sided than Bet365 — Bet365 mispriced',
    CLOSING_GAP_DOG:  'Bet365 closing line ≥0.25 more fav-sided than Pinnacle — Pinn rejected fav move',
  };

  const groups = {};
  for (const cfg of CONFIG_ORDER) groups[cfg] = [];
  for (const m of matched) {
    if (groups[m.config]) groups[m.config].push(m.pinn);
  }

  // Print distribution summary
  console.log(`\n  Config distribution:`);
  const total = matched.length;
  for (const cfg of CONFIG_ORDER) {
    const n = groups[cfg].length;
    if (!n) continue;
    console.log(`    ${cfg.padEnd(20)} : ${String(n).padStart(5)}  (${(n / total * 100).toFixed(1)}%)`);
  }
  const nNone  = matched.filter(m => m.config === 'NONE').length;
  const nDisag = matched.filter(m => m.config === 'DISAGREEMENT').length;
  console.log(`    ${'NONE'.padEnd(20)} : ${String(nNone).padStart(5)}  (${(nNone / total * 100).toFixed(1)}%)`);
  if (nDisag) console.log(`    ${'DISAGREEMENT'.padEnd(20)} : ${String(nDisag).padStart(5)}  (disagreement on fav side)`);

  // Print per-config stats
  for (const cfg of CONFIG_ORDER) {
    const cfgRows = groups[cfg];
    printConfigStats(cfg, CONFIG_DESC[cfg], cfgRows, blRows);
  }

  console.log(`\n${'═'.repeat(70)}`);
  console.log('  Baseline = all matched rows regardless of config.');
  console.log('  Bets shown: |edge| ≥ ' + MIN_EDGE + 'pp and |z| ≥ 1.5.');
  console.log('  Live use: for each qualifying config, bet the top edge bets');
  console.log('  on the live market IF the outcome has not yet occurred.');
  console.log('');
}

main();
