'use strict';
// ── Configuration Discovery ────────────────────────────────────────────────────
// Sweeps all signal combinations × HT game states and ranks by z-score.
// Outputs configurations suitable for proposing to the asianbetsoccer bot.
//
// Usage:
//   node discover.js                         — full sweep, TOP+MAJOR, pre-match only
//   node discover.js --ht                    — include HT game states
//   node discover.js --ht-only               — only HT game states (skip pre-match)
//   node discover.js --bet over05_2H         — filter to a specific bet key
//   node discover.js --line 0.75             — filter to a specific AH line
//   node discover.js --tier ALL              — use all leagues (default: TOP+MAJOR)
//   node discover.js --top 30                — show top N results (default: 50)
//   node discover.js --min-z 2.5             — minimum z-score (default: 2.0)
//   node discover.js --min-n 35              — minimum pool size (default: 35)
//   node discover.js --min-edge 6            — minimum edge pp (default: 6)
//   node discover.js --min-baseline 25       — minimum baseline % (default: 25)

const path = require('path');
const {
  loadDatabase, loadDatabaseFromUrl,
  applyConfig, applyBaselineConfig, applyGameState,
  pct, zScore, wilsonCI,
  VALID_LINES, BETS,
} = require('./engine');
const cfg = require('./config');

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};
const hasFlag = f => args.includes(f);

const TIER        = getArg('--tier',         'TOP+MAJOR');
const TOP_N       = parseInt(getArg('--top',  '50'), 10);
const MIN_Z       = parseFloat(getArg('--min-z',    '2.0'));
const MIN_N       = parseInt(getArg('--min-n',      '35'), 10);
const MIN_EDGE    = parseFloat(getArg('--min-edge',  '6'));
const MIN_BL      = parseFloat(getArg('--min-baseline', '25'));
const FILTER_BET  = getArg('--bet',  null);   // e.g. over05_2H
const FILTER_LINE = getArg('--line', null);   // e.g. 0.75
const WITH_HT     = hasFlag('--ht') || hasFlag('--ht-only');
const HT_ONLY     = hasFlag('--ht-only');

// ── HT game states to sweep ───────────────────────────────────────────────────
// Common scorelines that actually appear in the database in meaningful numbers.
const HT_STATES = [
  { home_goals: 0, away_goals: 0 },
  { home_goals: 1, away_goals: 0 },
  { home_goals: 0, away_goals: 1 },
  { home_goals: 1, away_goals: 1 },
  { home_goals: 2, away_goals: 0 },
  { home_goals: 0, away_goals: 2 },
  { home_goals: 2, away_goals: 1 },
  { home_goals: 1, away_goals: 2 },
];

// ── Helpers ───────────────────────────────────────────────────────────────────
function minOdds(p) {
  return p > 0 ? parseFloat((1 / (p / 100)).toFixed(2)) : null;
}

function signalLabel(cfg) {
  const parts = [];
  if (cfg.line_move     !== 'ANY') parts.push(`LM:${cfg.line_move}`);
  if (cfg.fav_odds_move !== 'ANY') parts.push(`FavOdds:${cfg.fav_odds_move}`);
  if (cfg.dog_odds_move !== 'ANY') parts.push(`DogOdds:${cfg.dog_odds_move}`);
  if (cfg.tl_move       !== 'ANY') parts.push(`TL:${cfg.tl_move}`);
  return parts.length ? parts.join('  ') : 'ANY signals';
}

function htLabel(ht) {
  return ht ? `HT ${ht.home_goals}-${ht.away_goals}` : 'Pre-match';
}

function tierFilter(db) {
  if (TIER === 'TOP')       return db.filter(r => r.league_tier === 'TOP');
  if (TIER === 'MAJOR')     return db.filter(r => r.league_tier === 'MAJOR');
  if (TIER === 'TOP+MAJOR') return db.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
  return db; // ALL
}

// ── Core sweep ────────────────────────────────────────────────────────────────
function sweep(db) {
  const results = [];

  const lines = FILTER_LINE
    ? [parseFloat(FILTER_LINE)]
    : VALID_LINES;

  const sides = ['HOME', 'AWAY', 'ANY'];

  const lmOptions  = ['DEEPER', 'STABLE', 'SHRANK'];
  const fomOptions = ['IN', 'STABLE', 'OUT', 'ANY'];
  const domOptions = ['IN', 'STABLE', 'OUT', 'ANY'];
  const tlmOptions = ['UP', 'STABLE', 'DOWN', 'ANY'];

  // Game states to sweep
  const gameStates = [];
  if (!HT_ONLY) gameStates.push(null);          // pre-match (no GS filter)
  if (WITH_HT)  gameStates.push(...HT_STATES.map(s => ({ trigger: 'HT', ...s })));

  for (const favLine of lines) {
    for (const favSide of sides) {

      // Base pool: line + side filtered (no signals)
      let base = db.filter(r => Math.abs(r.fav_line - favLine) < 0.13);
      if (favSide !== 'ANY') base = base.filter(r => r.fav_side === favSide);
      if (!base.length) continue;

      for (const gs of gameStates) {
        const baseGs = gs ? applyGameState(base, gs) : base;
        if (baseGs.length < MIN_N) continue;

        // Baseline for this (line, side, gs) combo
        const blSideRows = favSide === 'ANY' ? null : baseGs;
        const blHome     = favSide === 'ANY' ? baseGs.filter(r => r.fav_side === 'HOME') : null;
        const blAway     = favSide === 'ANY' ? baseGs.filter(r => r.fav_side === 'AWAY') : null;

        for (const lm of lmOptions) {
          for (const fom of fomOptions) {
            for (const dom of domOptions) {
              for (const tlm of tlmOptions) {
                const cfgObj = {
                  fav_line:     favLine.toFixed(2),
                  fav_side:     favSide,
                  line_move:    lm,
                  fav_odds_move: fom,
                  dog_odds_move: dom,
                  tl_move:      tlm,
                  tl_max:       null,
                };

                const cfgRows = applyConfig(base, cfgObj);
                const gsRows  = gs ? applyGameState(cfgRows, gs) : cfgRows;
                if (gsRows.length < MIN_N) continue;

                for (const b of BETS) {
                  if (FILTER_BET && b.k !== FILTER_BET) continue;

                  let blPool;
                  if      (b.favSideBaseline === 'HOME' && blHome) blPool = blHome;
                  else if (b.favSideBaseline === 'AWAY' && blAway) blPool = blAway;
                  else    blPool = blSideRows || baseGs;

                  const p    = pct(gsRows, b.k);
                  const bl   = pct(blPool, b.k);
                  const z    = zScore(gsRows, blPool, b.k);
                  const edge = p - bl;

                  if (z < MIN_Z || edge < MIN_EDGE || bl < MIN_BL) continue;

                  const [lo] = wilsonCI(p, gsRows.length);
                  const mo     = minOdds(p);
                  const mo_mid = minOdds((p + lo) / 2);

                  results.push({
                    bet:     b.label,
                    betKey:  b.k,
                    favLine, favSide, gs,
                    lm, fom, dom, tlm,
                    n: gsRows.length, p, bl, z, edge, lo,
                    mo, mo_mid,
                  });
                }
              }
            }
          }
        }
      }
    }
  }

  // Deduplicate: keep best z per (bet, line, side, gs, signals)
  const seen = new Map();
  for (const r of results) {
    const key = `${r.betKey}|${r.favLine}|${r.favSide}|${htLabel(r.gs)}|${r.lm}|${r.fom}|${r.dom}|${r.tlm}`;
    if (!seen.has(key) || seen.get(key).z < r.z) seen.set(key, r);
  }

  return [...seen.values()].sort((a, b) => b.z - a.z).slice(0, TOP_N);
}

// ── Output formatter ──────────────────────────────────────────────────────────
function formatResult(r, rank) {
  const side    = r.favSide === 'ANY' ? 'Any side' : `${r.favSide === 'HOME' ? 'Home' : 'Away'} fav`;
  const line    = `-${r.favLine}`;
  const signals = signalLabel({ line_move: r.lm, fav_odds_move: r.fom, dog_odds_move: r.dom, tl_move: r.tlm });
  const ht      = r.gs ? `  |  ${htLabel(r.gs)}` : '';
  const odds    = (r.mo && r.mo_mid) ? `[${r.mo}–${r.mo_mid}]` : r.mo ? `[${r.mo}]` : '—';
  const edge    = `+${r.edge.toFixed(1)}pp`;

  return [
    `#${rank}  ${r.bet}`,
    `    AH: ${side} ${line}  |  ${signals}${ht}`,
    `    ${r.p.toFixed(1)}% vs ${r.bl.toFixed(1)}% baseline  ${edge}  z=${r.z.toFixed(2)}  n=${r.n}  odds ${odds}`,
  ].join('\n');
}

// ── asianbetsoccer bot format ─────────────────────────────────────────────────
// Compact block you can copy-paste when submitting configs to the bot service.
function formatBotConfig(r) {
  const side = r.favSide === 'ANY' ? 'ANY' : r.favSide;
  const lm   = r.lm  !== 'ANY' ? r.lm  : null;
  const fom  = r.fom !== 'ANY' ? r.fom : null;
  const dom  = r.dom !== 'ANY' ? r.dom : null;
  const tlm  = r.tlm !== 'ANY' ? r.tlm : null;
  const ht   = r.gs  ? `HT ${r.gs.home_goals}-${r.gs.away_goals}` : null;

  const fields = [
    `Bet: ${r.bet}`,
    `AH line: ${side} -${r.favLine}`,
    lm  ? `Line move: ${lm}`       : null,
    fom ? `Fav odds: ${fom}`       : null,
    dom ? `Dog odds: ${dom}`       : null,
    tlm ? `TL move: ${tlm}`        : null,
    ht  ? `HT score: ${ht}`        : null,
    `Hit rate: ${r.p.toFixed(1)}%  (baseline ${r.bl.toFixed(1)}%  edge +${r.edge.toFixed(1)}pp)`,
    `Min odds: ${r.mo}–${r.mo_mid}`,
  ].filter(Boolean);

  return fields.join('\n');
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log('Loading database…');
  let db;
  if (cfg.DATA_URL) {
    db = await loadDatabaseFromUrl(cfg.DATA_URL);
  } else {
    const dataDir = path.resolve(__dirname, cfg.DATA_DIR || '../static/data');
    db = loadDatabase(dataDir);
  }
  console.log(`Loaded ${db.length} rows`);

  db = tierFilter(db);
  console.log(`After ${TIER} tier filter: ${db.length} rows`);

  console.log(`\nSweeping configurations (min_z=${MIN_Z}, min_n=${MIN_N}, min_edge=${MIN_EDGE}, min_bl=${MIN_BL})…`);
  if (WITH_HT)  console.log(`HT game states: ${HT_STATES.map(s => `${s.home_goals}-${s.away_goals}`).join(', ')}`);
  if (HT_ONLY)  console.log('Mode: HT only (pre-match skipped)');

  const results = sweep(db);
  console.log(`Found ${results.length} configurations (showing top ${Math.min(TOP_N, results.length)})\n`);

  console.log('═'.repeat(72));
  console.log('RANKED RESULTS');
  console.log('═'.repeat(72));
  results.forEach((r, i) => {
    console.log(formatResult(r, i + 1));
    console.log();
  });

  console.log('═'.repeat(72));
  console.log('BOT CONFIG FORMAT (copy-paste for asianbetsoccer)');
  console.log('═'.repeat(72));
  results.forEach((r, i) => {
    console.log(`── Config #${i + 1} ─────────────────────────────`);
    console.log(formatBotConfig(r));
    console.log();
  });
}

main().catch(e => { console.error(e); process.exit(1); });
