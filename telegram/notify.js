'use strict';
// ── HalvestAH Telegram Notifier ───────────────────────────────────────────────
// GSA-only notifier: fires during the HT window (min 46–56) when the
// signal-conditioned HT game state shows a meaningful edge on 2H markets.
//
// Usage:
//   node notify.js          — start the scheduler (runs forever)
//   node notify.js --once   — run one scan immediately and exit (for testing)

const path = require('path');
const cron = require('node-cron');
const cfg  = require('./config');
const { loadDatabase, loadDatabaseFromUrl, buildCfgFromMatch,
        applyConfig, applyBaselineConfig, applyGameState, scoreBets } = require('./engine');
const { fetchLiveMatches } = require('./livescore');

// ── HT window ─────────────────────────────────────────────────────────────────
const HT_MIN_MINUTE = 46;
const HT_MAX_MINUTE = 56;

// ── Allowed 2H bets for GSA alerts ────────────────────────────────────────────
const HT_ALLOWED_BETS = new Set([
  'homeScored2H', 'awayScored2H',
  'over05_2H', 'over15_2H', 'under15_2H',
]);

// ── GSA thresholds ────────────────────────────────────────────────────────────
const GSA_MIN_DELTA     = 5;     // Δ vs HT-conditioned baseline (pp)
const GSA_MIN_N         = 30;    // min rows after HT game state filter
const GSA_MAX_CONS_ODDS = 1.95;  // conservative odds ceiling
const GSA_MIN_P         = 55;    // minimum absolute hit rate (%)

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

// Tier icon based on hit rate + delta
function betIcon(p, delta) {
  if (p >= 75 && delta >= 10) return '🔥';
  if (p >= 68 && delta >= 7)  return '⚡';
  return '✅';
}

// AH line display: "Away -0.75(-0.50)" — closing(opening), fav-normalised
function ahLineDisplay(matchCfg, odds) {
  const side    = matchCfg.fav_side === 'HOME' ? 'Home' : 'Away';
  const closing = parseFloat(matchCfg.fav_line);
  const ahHo    = odds.ah_ho;
  const opening = ahHo != null ? Math.abs(parseFloat(ahHo)).toFixed(2) : null;
  const closingStr = isNaN(closing) ? matchCfg.fav_line : closing.toFixed(2);
  return opening && opening !== closingStr
    ? `${side} −${closingStr}(−${opening})`
    : `${side} −${closingStr}`;
}

// TL display: "TL 2.50(2.75)" — closing(opening)
function tlDisplay(odds) {
  const { tl_c, tl_o } = odds;
  if (tl_c == null) return null;
  return tl_o != null && tl_o !== tl_c
    ? `TL ${tl_c}(${tl_o})`
    : `TL ${tl_c}`;
}

// Compact signal summary: STEAM / DRIFT / Fav↓ / Fav↑ etc.
function signalSummary(matchCfg) {
  const sig   = matchCfg.signals;
  const parts = [];
  if (sig.lineMove === 'DEEPER')        parts.push('STEAM');
  else if (sig.lineMove === 'SHRANK')   parts.push('DRIFT');
  if (cfg.FAV_ODDS_ON && sig.favOddsMove === 'SHORTER')  parts.push('Fav↓');
  else if (cfg.FAV_ODDS_ON && sig.favOddsMove === 'DRIFTED') parts.push('Fav↑');
  if (cfg.DOG_ODDS_ON && sig.dogOddsMove === 'SHORTER')  parts.push('Dog↓');
  else if (cfg.DOG_ODDS_ON && sig.dogOddsMove === 'DRIFTED') parts.push('Dog↑');
  return parts.join(' · ');
}

// ── GSA message formatter ─────────────────────────────────────────────────────
function formatGsaMessage(match, bets, matchCfg, homeGoals, awayGoals) {
  const ahLine  = ahLineDisplay(matchCfg, match.odds);
  const tl      = tlDisplay(match.odds);
  const signals = signalSummary(matchCfg);
  const minute  = match.minute ? ` · ${match.minute}` : '';

  // AH + TL on one line, signals on next
  const ahTlLine = [ahLine, tl].filter(Boolean).join('  ');

  const header = [
    `⏸ <b>HALF TIME GSA</b>  ·  ${nowTime()}`,
    ``,
    `🏆 <i>${match.league || '—'}</i>`,
    `⚽ <b>${match.home_team} vs ${match.away_team}</b>`,
    `📊 HT <b>${homeGoals}–${awayGoals}</b>${minute}`,
    `⚖️ ${ahTlLine}`,
    signals ? `📡 ${signals}` : null,
  ].filter(l => l != null).join('\n');

  const betLines = [...bets]
    .sort((a, b) => (b.p + b.edge) - (a.p + a.edge))
    .map(b => {
      const icon      = betIcon(b.p, b.edge);
      const oddsRange = (b.mo && b.mo_mid)
        ? `<code>[${b.mo} – ${b.mo_mid}]</code>`
        : (b.mo_mid ? `<code>≥ ${b.mo_mid}</code>` : '—');
      const delta = (b.edge >= 0 ? '+' : '') + b.edge.toFixed(1) + 'pp';

      return (
        `${icon} <b>${b.label}</b>  ${oddsRange}\n` +
        `   ${b.p.toFixed(0)}% vs ${b.bl.toFixed(0)}% (<b>${delta}</b>)  ·  n=${b.n}`
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
  try {
    matches = await fetchMatches();
  } catch (e) {
    console.error(`Livescore fetch failed: ${e.message}`);
    return;
  }

  if (!matches.length) { console.log('No live matches.'); return; }
  console.log(`Found ${matches.length} match(es).`);

  const db = await getDb();

  for (const match of matches) {
    // ── HT window gate ────────────────────────────────────────────────────
    const minNum     = match.minute ? parseInt(match.minute, 10) : null;
    const isHtWindow = minNum != null && !isNaN(minNum) &&
                       minNum >= HT_MIN_MINUTE && minNum <= HT_MAX_MINUTE;
    if (!isHtWindow || !match.score) continue;

    const label    = `${match.home_team} vs ${match.away_team}`;
    const matchCfg = buildCfgFromMatch(match.odds, cfg);
    if (!matchCfg) {
      if (VERBOSE) console.log(`  SKIP [no cfg]  ${label}`);
      continue;
    }

    // ── Signal movement gate ──────────────────────────────────────────────
    if (cfg.REQUIRE_MOVEMENT) {
      const s = matchCfg.signals;
      const hasMovement =
        (cfg.LINE_MOVE_ON && s.lineMove    !== 'STABLE' && s.lineMove    !== 'UNKNOWN') ||
        (cfg.TL_MOVE_ON   && s.tlMove      !== 'STABLE' && s.tlMove      !== 'UNKNOWN') ||
        (cfg.FAV_ODDS_ON  && s.favOddsMove !== 'STABLE' && s.favOddsMove !== 'UNKNOWN') ||
        (cfg.DOG_ODDS_ON  && s.dogOddsMove !== 'STABLE' && s.dogOddsMove !== 'UNKNOWN');
      if (!hasMovement) {
        if (VERBOSE) console.log(`  SKIP [flat]    ${label}  LM:${matchCfg.signals.lineMove}`);
        continue;
      }
    }

    // ── Parse HT score ────────────────────────────────────────────────────
    const [homeGoals, awayGoals] = match.score.split('-').map(v => parseInt(v, 10));
    if (isNaN(homeGoals) || isNaN(awayGoals)) continue;

    // ── Build DB pools ────────────────────────────────────────────────────
    const htTier = cfg.HT_LEAGUE_TIER || 'ALL';
    let tierDb = db;
    if      (htTier === 'TOP')       tierDb = db.filter(r => r.league_tier === 'TOP');
    else if (htTier === 'MAJOR')     tierDb = db.filter(r => r.league_tier === 'MAJOR');
    else if (htTier === 'TOP+MAJOR') tierDb = db.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');

    const cfgRows = applyConfig(tierDb, matchCfg);
    const blRows  = applyBaselineConfig(tierDb, matchCfg);
    const blSide  = blRows.filter(r => r.fav_side === matchCfg.fav_side);

    if (VERBOSE) {
      const s = matchCfg.signals;
      console.log(`  HT CHECK  ${label}  [${homeGoals}-${awayGoals}]  LM:${s.lineMove} TL:${s.tlMove}  pool:${cfgRows.length}`);
    }

    // ── Apply HT game state ───────────────────────────────────────────────
    const htGs        = { trigger: 'HT', home_goals: homeGoals, away_goals: awayGoals };
    const htRows      = applyGameState(cfgRows, htGs);
    const htBlRows    = applyGameState(blRows,  htGs);
    const htBlSide    = applyGameState(blSide,  htGs);

    if (htRows.length < GSA_MIN_N || htBlRows.length < GSA_MIN_N) continue;

    // ── Score & filter ────────────────────────────────────────────────────
    const htBets      = scoreBets(htRows, htBlRows, htBlSide, GSA_MIN_N);
    const qualifying  = htBets.filter(b =>
      HT_ALLOWED_BETS.has(b.k)       &&
      b.edge   >= GSA_MIN_DELTA       &&
      b.n      >= GSA_MIN_N           &&
      b.mo_mid <= GSA_MAX_CONS_ODDS   &&
      b.p      >= GSA_MIN_P
    );

    if (!qualifying.length) continue;

    const matchId = match.id || `${match.home_team}:${match.away_team}`;
    const newBets = qualifying.filter(b => !alreadyNotified(matchId, `ht:${b.k}`));
    if (!newBets.length) continue;

    const msg = formatGsaMessage(match, newBets, matchCfg, homeGoals, awayGoals);
    console.log(`HT ALERT → ${label} [${homeGoals}-${awayGoals}]: ${newBets.map(b => b.label).join(', ')}`);
    await sendTelegram(msg);
    for (const b of newBets) markNotified(matchId, `ht:${b.k}`);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const once = process.argv.includes('--once');
  await getDb();

  if (once) { await runScan(); process.exit(0); }

  if (cfg.TELEGRAM_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.error('ERROR: Fill in TELEGRAM_TOKEN and TELEGRAM_CHAT_ID in config.js');
    process.exit(1);
  }

  console.log(`Scheduler started — every ${cfg.SCAN_INTERVAL_MINUTES} min.`);
  await runScan();
  cron.schedule(`*/${cfg.SCAN_INTERVAL_MINUTES} * * * *`, runScan);
}

main().catch(e => { console.error(e); process.exit(1); });
