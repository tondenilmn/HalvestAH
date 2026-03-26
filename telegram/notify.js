'use strict';
// ── HalvestAH Telegram Notifier — GSA HT alerts ───────────────────────────────
//
// Fires during HT window (minute 46–56) when:
//   1. AH line OR TL shows real movement (DEEPER/SHRANK or UP/DOWN)
//   2. Signal+HT pool passes all 4 GSA filters:
//        n >= GSA_MIN_N        (enough historical matches)
//        delta >= GSA_MIN_DELTA (movement adds improvement vs baseline)
//        signal% >= GSA_MIN_P  (absolute hit rate high enough)
//        consOdds <= GSA_MAX_CONS_ODDS (odds are realistic to find)
//
// Two pools per match:
//   baseline = AH line + AH closing odds ±tol + TL closing  (no movement)
//   signal   = baseline + active movement filters (LM, TLM, etc.)
// Both pools are then filtered by the HT score before scoring.
//
// Usage:
//   node notify.js          — start scheduler (runs every N minutes)
//   node notify.js --once   — single scan + exit (for testing)

const path = require('path');
const cron = require('node-cron');
const cfg  = require('./config');
const {
  loadDatabase, loadDatabaseFromUrl, buildCfgFromMatch,
  applyConfig, applyGameState, scoreBets,
} = require('./engine');
const { fetchLiveMatches } = require('./livescore');

// ── HT window ─────────────────────────────────────────────────────────────────
const HT_MIN_MINUTE = 46;
const HT_MAX_MINUTE = 50;

// ── Allowed bet keys — 2H and FT only ────────────────────────────────────────
const BETS_2H = new Set([
  'over05_2H', 'over15_2H', 'under15_2H',
  'favScored2H', 'homeScored2H', 'awayScored2H',
  'favWins2H', 'homeWins2H', 'awayWins2H', 'draw2H',
]);
const BETS_FT = new Set([
  'over15FT', 'over25FT', 'under25FT',
  'homeWinsFT', 'awayWinsFT', 'drawFT', 'btts',
]);

// ── GSA thresholds ────────────────────────────────────────────────────────────
const MIN_N         = cfg.GSA_MIN_N         ?? 20;
const MIN_DELTA     = cfg.GSA_MIN_DELTA     ?? 5;
const MIN_P_2H      = cfg.GSA_MIN_P_2H      ?? 50;
const MIN_P_FT      = cfg.GSA_MIN_P_FT      ?? 40;
const MAX_CONS_ODDS = cfg.GSA_MAX_CONS_ODDS ?? 2.50;

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${cfg.TELEGRAM_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: cfg.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) console.error(`Telegram error: ${await res.text()}`);
  } catch (e) {
    console.error(`Telegram fetch failed: ${e.message}`);
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────────
function nowTime() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

function tierIcon(p, delta) {
  if (p >= 75 && delta >= 10) return '🔥';
  if (p >= 65 && delta >= 7)  return '⚡';
  return '✅';
}

function ahDisplay(matchCfg, odds) {
  const side    = matchCfg.fav_side === 'HOME' ? 'Home' : 'Away';
  const closing = parseFloat(matchCfg.fav_line);
  const opening = odds.ah_ho != null ? Math.abs(parseFloat(odds.ah_ho)).toFixed(2) : null;
  const cStr    = isNaN(closing) ? matchCfg.fav_line : closing.toFixed(2);
  return opening && opening !== cStr ? `${side} −${cStr}(−${opening})` : `${side} −${cStr}`;
}

function tlDisplay(odds) {
  const { tl_c, tl_o } = odds;
  if (tl_c == null) return null;
  return tl_o != null && tl_o !== tl_c ? `TL ${tl_c}(${tl_o})` : `TL ${tl_c}`;
}

function signalSummary(sig) {
  const parts = [];
  if      (sig.lineMove === 'DEEPER') parts.push('LINE STEAM');
  else if (sig.lineMove === 'SHRANK') parts.push('LINE DRIFT');
  if      (sig.tlMove   === 'UP')     parts.push('TL UP');
  else if (sig.tlMove   === 'DOWN')   parts.push('TL DOWN');
  if (cfg.FAV_ODDS_ON) {
    if      (sig.favOddsMove === 'IN')  parts.push('Fav STEAM');
    else if (sig.favOddsMove === 'OUT') parts.push('Fav DRIFT');
  }
  if (cfg.DOG_ODDS_ON) {
    if      (sig.dogOddsMove === 'IN')  parts.push('Dog STEAM');
    else if (sig.dogOddsMove === 'OUT') parts.push('Dog DRIFT');
  }
  if (cfg.OVER_ODDS_ON) {
    if      (sig.overMove === 'IN')  parts.push('Over↓');
    else if (sig.overMove === 'OUT') parts.push('Over↑');
  }
  if (cfg.UNDER_ODDS_ON) {
    if      (sig.underMove === 'IN')  parts.push('Under↓');
    else if (sig.underMove === 'OUT') parts.push('Under↑');
  }
  return parts.join(' · ');
}

// ── Message formatter ─────────────────────────────────────────────────────────
function formatMessage(match, bets, matchCfg, homeGoals, awayGoals, sigN, blN) {
  const ah      = ahDisplay(matchCfg, match.odds);
  const tl      = tlDisplay(match.odds);
  const signals = signalSummary(matchCfg.signals);
  const ahTl    = [ah, tl].filter(Boolean).join('  ');

  const header = [
    `⏸ <b>HT GSA ALERT</b>  ·  ${nowTime()}`,
    ``,
    `🏆 <i>${match.league || '—'}</i>`,
    `⚽ <b>${match.home_team} vs ${match.away_team}</b>`,
    `📊 HT <b>${homeGoals}–${awayGoals}</b>  ·  ${match.minute || ''}`,
    `⚖️ ${ahTl}`,
    signals ? `📡 ${signals}` : null,
    ``,
    `Signal n=<b>${sigN}</b>  ·  Baseline n=${blN}`,
  ].filter(l => l != null).join('\n');

  const betLines = [...bets]
    .sort((a, b) => b.edge - a.edge)
    .map(b => {
      const icon  = tierIcon(b.p, b.edge);
      const delta = (b.edge >= 0 ? '+' : '') + b.edge.toFixed(1) + 'pp';
      const type  = BETS_2H.has(b.k) ? '2H' : 'FT';
      return (
        `${icon} <b>[${type}] ${b.label}</b>\n` +
        `   ${b.p.toFixed(0)}% vs ${b.bl.toFixed(0)}% (<b>${delta}</b>)  ·  find ≥ <code>${b.mo_lo}</code>  ·  n=${b.n}`
      );
    })
    .join('\n\n');

  return `${header}\n\n${betLines}\n`;
}

// ── Deduplication ─────────────────────────────────────────────────────────────
const _notified = new Map(); // key → timestamp, expires after 2h

function alreadyNotified(matchId, betKey) {
  const key = `${matchId}:${betKey}`;
  const ts  = _notified.get(key);
  if (!ts) return false;
  if (Date.now() - ts > 2 * 60 * 60 * 1000) { _notified.delete(key); return false; }
  return true;
}

function markNotified(matchId, betKey) {
  _notified.set(`${matchId}:${betKey}`, Date.now());
}

// ── Tier filter ───────────────────────────────────────────────────────────────
function filterByTier(db, tier) {
  if (tier === 'TOP')       return db.filter(r => r.league_tier === 'TOP');
  if (tier === 'MAJOR')     return db.filter(r => r.league_tier === 'MAJOR');
  if (tier === 'TOP+MAJOR') return db.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
  return db; // ALL
}

// ── Database loader ───────────────────────────────────────────────────────────
let _db = null, _dbPromise = null;

async function getDb() {
  if (_db) return _db;
  if (_dbPromise) return _dbPromise;
  _dbPromise = (async () => {
    if (cfg.DATA_URL) {
      console.log(`Loading database from ${cfg.DATA_URL}…`);
      _db = await loadDatabaseFromUrl(cfg.DATA_URL);
    } else {
      const dataDir = path.resolve(__dirname, cfg.DATA_DIR);
      console.log(`Loading database from ${dataDir}…`);
      _db = loadDatabase(dataDir);
    }
    console.log(`Database ready — ${_db.length} rows`);
    return _db;
  })();
  return _dbPromise;
}

// ── Live match fetcher ────────────────────────────────────────────────────────
async function fetchMatches() {
  if (cfg.DATA_URL) {
    const url  = `${cfg.DATA_URL.replace(/\/$/, '')}/api/livescore`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Cloudflare livescore returned HTTP ${resp.status}`);
    return (await resp.json()).matches || [];
  }
  return fetchLiveMatches();
}

// ── Core scan ─────────────────────────────────────────────────────────────────
const VERBOSE = process.argv.includes('--verbose');

async function runScan() {
  console.log(`[${new Date().toISOString()}] Scanning…`);

  let matches;
  try { matches = await fetchMatches(); }
  catch (e) { console.error(`Livescore fetch failed: ${e.message}`); return; }

  if (!matches.length) { console.log('No live matches.'); return; }
  console.log(`Found ${matches.length} match(es).`);

  const db = await getDb();

  for (const match of matches) {
    const label  = `${match.home_team} vs ${match.away_team}`;
    const rawMin = match.minute ? String(match.minute).replace(/'/g, '').trim() : null;
    const minNum = rawMin ? parseInt(rawMin, 10) : null;

    // ── HT window gate — accepts explicit 'HT' string or minute 46–50 ─────
    const isHtWindow = rawMin === 'HT' ||
                       (minNum != null && !isNaN(minNum) &&
                        minNum >= HT_MIN_MINUTE && minNum <= HT_MAX_MINUTE);
    if (!isHtWindow || !match.score) {
      if (VERBOSE) console.log(`  SKIP [not HT]  ${label}  min=${match.minute}`);
      continue;
    }

    // ── Parse HT score ────────────────────────────────────────────────────
    const [homeGoals, awayGoals] = match.score.split('-').map(v => parseInt(v, 10));
    if (isNaN(homeGoals) || isNaN(awayGoals)) continue;

    // ── Build match cfg (carries all signal values + odds fields) ─────────
    const matchCfg = buildCfgFromMatch(match.odds, cfg);
    if (!matchCfg) {
      if (VERBOSE) console.log(`  SKIP [no cfg]  ${label}`);
      continue;
    }

    const sig     = matchCfg.signals;
    const matchId = match.id || `${match.home_team}:${match.away_team}`;

    // ── Movement gate — at least one active signal must be a real move ────
    if (cfg.REQUIRE_MOVEMENT) {
      const hasMove =
        (cfg.LINE_MOVE_ON  && !['STABLE','UNKNOWN'].includes(sig.lineMove))  ||
        (cfg.TL_MOVE_ON    && !['STABLE','UNKNOWN'].includes(sig.tlMove));
      if (!hasMove) {
        if (VERBOSE) console.log(`  SKIP [flat]  ${label}  LM:${sig.lineMove} TL:${sig.tlMove}`);
        continue;
      }
    }

    // ── Build baseline cfg: AH line + odds tol + TL closing, no movement ─
    const blCfg = {
      fav_line:       matchCfg.fav_line,
      fav_side:       matchCfg.fav_side,
      odds_tolerance: matchCfg.odds_tolerance,
      fav_oc:         matchCfg.fav_oc,
      dog_oc:         matchCfg.dog_oc,
      tl_c:           matchCfg.tl_c,
      line_move:      'ANY',
      fav_odds_move:  'ANY',
      dog_odds_move:  'ANY',
      tl_move:        'ANY',
      over_move:      'ANY',
      under_move:     'ANY',
    };

    // ── Build signal cfg: baseline + active movement filters ──────────────
    const sigCfg = {
      ...blCfg,
      line_move:     cfg.LINE_MOVE_ON  && !['STABLE','UNKNOWN'].includes(sig.lineMove)    ? sig.lineMove    : 'ANY',
      tl_move:       cfg.TL_MOVE_ON    && !['STABLE','UNKNOWN'].includes(sig.tlMove)      ? sig.tlMove      : 'ANY',
      fav_odds_move: cfg.FAV_ODDS_ON   && !['STABLE','UNKNOWN'].includes(sig.favOddsMove) ? sig.favOddsMove : 'ANY',
      dog_odds_move: cfg.DOG_ODDS_ON   && !['STABLE','UNKNOWN'].includes(sig.dogOddsMove) ? sig.dogOddsMove : 'ANY',
      over_move:     cfg.OVER_ODDS_ON  && !['STABLE','UNKNOWN'].includes(sig.overMove)    ? sig.overMove    : 'ANY',
      under_move:    cfg.UNDER_ODDS_ON && !['STABLE','UNKNOWN'].includes(sig.underMove)   ? sig.underMove   : 'ANY',
    };

    // ── Apply tier filter and build DB pools ──────────────────────────────
    const tierDb  = filterByTier(db, cfg.HT_LEAGUE_TIER || 'ALL');
    const blRows  = applyConfig(tierDb, blCfg);
    const cfgRows = applyConfig(tierDb, sigCfg);
    const blSide  = blRows.filter(r => r.fav_side === sigCfg.fav_side);

    if (VERBOSE) {
      console.log(`  CHECK  ${label}  [${homeGoals}-${awayGoals}]  LM:${sig.lineMove} TL:${sig.tlMove}  bl:${blRows.length} sig:${cfgRows.length}`);
    }

    // ── Apply HT game state to both pools ─────────────────────────────────
    const htGs      = { trigger: 'HT', home_goals: homeGoals, away_goals: awayGoals };
    const htSigRows = applyGameState(cfgRows, htGs);
    const htBlRows  = applyGameState(blRows,  htGs);
    const htBlSide  = applyGameState(blSide,  htGs);

    if (htSigRows.length < MIN_N) {
      if (VERBOSE) console.log(`  SKIP [n=${htSigRows.length} < ${MIN_N}]  ${label}`);
      continue;
    }

    // ── Score bets and apply 4 GSA filters ───────────────────────────────
    const bets = scoreBets(htSigRows, htBlRows, htBlSide, MIN_N);

    const qualifying = bets.filter(b => {
      const is2H  = BETS_2H.has(b.k);
      const isFT  = BETS_FT.has(b.k);
      if (!is2H && !isFT) return false;
      const minP  = is2H ? MIN_P_2H : MIN_P_FT;
      const cons  = parseFloat(b.mo_lo);
      return (
        b.n     >= MIN_N         &&   // enough data
        b.edge  >= MIN_DELTA     &&   // signal adds edge
        b.p     >= minP          &&   // absolute hit rate high enough
        !isNaN(cons) && cons <= MAX_CONS_ODDS  // odds realistic to find
      );
    });

    if (!qualifying.length) continue;

    // ── Deduplicate ───────────────────────────────────────────────────────
    const newBets = qualifying.filter(b => !alreadyNotified(matchId, b.k));
    if (!newBets.length) continue;

    // ── Send alert ────────────────────────────────────────────────────────
    const msg = formatMessage(match, newBets, matchCfg, homeGoals, awayGoals, htSigRows.length, htBlRows.length);
    console.log(`ALERT → ${label} [${homeGoals}-${awayGoals}]: ${newBets.map(b => b.label).join(', ')}`);
    await sendTelegram(msg);
    for (const b of newBets) markNotified(matchId, b.k);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const once = process.argv.includes('--once');
  await getDb();

  if (once) { await runScan(); process.exit(0); }

  console.log(`Scheduler started — every ${cfg.SCAN_INTERVAL_MINUTES} min.`);
  await runScan();
  cron.schedule(`*/${cfg.SCAN_INTERVAL_MINUTES} * * * *`, runScan);
}

main().catch(e => { console.error(e); process.exit(1); });
