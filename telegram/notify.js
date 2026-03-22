'use strict';
// ── HalvestAH Telegram Notifier ───────────────────────────────────────────────
// Runs a live scan every N minutes and sends Telegram alerts for qualifying bets.
//
// Usage:
//   node notify.js          — start the scheduler (runs forever)
//   node notify.js --once   — run one scan immediately and exit (for testing)

const path   = require('path');
const cron   = require('node-cron');
const cfg    = require('./config');
const { loadDatabase, loadDatabaseFromUrl, buildCfgFromMatch, applyConfig, applyBaselineConfig, applyGameState, scoreBets } = require('./engine');
const { fetchLiveMatches } = require('./livescore');

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${cfg.TELEGRAM_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    cfg.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`Telegram error: ${err}`);
    }
  } catch (e) {
    console.error(`Telegram fetch failed: ${e.message}`);
  }
}

// gsMap: Map of betKey → gs bet result (or null if not run)
function formatMessage(match, bets, matchCfg, gsMap) {
  const score  = match.score  ? `  <b>${match.score}</b>` : '';
  const minute = match.minute ? `  <b>${match.minute}</b>` : '';
  const league = match.league ? `🏆 <i>${match.league}</i>\n` : '';

  // Market context — AH line + line move signal on one line, TL on the next
  const ahSide = matchCfg.fav_side === 'HOME' ? 'Home' : 'Away';
  const ahLine = `${ahSide} -${matchCfg.fav_line}`;
  const tlVal  = match.odds.tl_c != null ? `TL ${match.odds.tl_c}` : '';
  const sig    = matchCfg.signals;

  const ahExtra = [
    sig.lineMove  !== 'UNKNOWN' ? `Line: <b>${sig.lineMove}</b>` : null,
    cfg.FAV_ODDS_ON && sig.favOddsMove !== 'UNKNOWN' ? `Fav: <b>${sig.favOddsMove}</b>` : null,
    cfg.DOG_ODDS_ON && sig.dogOddsMove !== 'UNKNOWN' ? `Dog: <b>${sig.dogOddsMove}</b>` : null,
  ].filter(Boolean).join('  ·  ');

  const tlExtra = sig.tlMove !== 'UNKNOWN' ? `TL: <b>${sig.tlMove}</b>` : '';

  const ahRow = `<code>${ahLine}</code>${ahExtra ? `  ·  ${ahExtra}` : ''}`;
  const tlRow = tlVal ? `<code>${tlVal}</code>${tlExtra ? `  ·  ${tlExtra}` : ''}` : '';
  const context = ahRow + (tlRow ? `\n${tlRow}` : '') + '\n';

  // GS label shown once above bets if available
  const gsLabel = gsMap ? `\n<i>🎯 ${match._gsLabel || 'in-play'}</i>\n` : '';

  // Bet categories — defines display order and grouping
  const CATEGORIES = [
    { label: 'AH',         keys: ['ahCover'] },
    { label: '1H Results', keys: ['favWins1H','draw1H','favScored1H','homeWins1H','awayWins1H','btts1H'] },
    { label: '1H Totals',  keys: ['over05_1H','over15_1H','under05_1H','under15_1H'] },
    { label: '2H Results', keys: ['favWins2H','favScored2H','draw2H','homeWins2H','awayWins2H','homeScored2H','awayScored2H'] },
    { label: '2H Totals',  keys: ['over05_2H','over15_2H','under05_2H','under15_2H','homeOver15_2H','awayOver15_2H'] },
    { label: 'FT Results', keys: ['homeWinsFT','awayWinsFT','drawFT','btts','dnbHome','dnbAway'] },
    { label: 'FT Totals',  keys: ['over15FT','over25FT','over35FT','under25FT'] },
  ];

  // Helper: format a single bet row
  function formatBet(b) {
    const zStr    = (b.z >= 0 ? '+' : '') + b.z.toFixed(1);
    const edgeStr = (b.edge >= 0 ? '+' : '') + b.edge.toFixed(1) + 'pp';
    const moStr   = b.mo ? `  @ <b>${b.mo}</b>` : '';
    let gsStr = '';
    if (gsMap) {
      const gs = gsMap.get(b.k);
      if (gs) {
        const gsZ = (gs.z >= 0 ? '+' : '') + gs.z.toFixed(1);
        gsStr = `\n    <i>↳ GS  z${gsZ}  n=${gs.n}</i>`;
      } else {
        gsStr = `\n    <i>↳ GS  n/a</i>`;
      }
    }
    const zBadge = b.z >= 3.0 ? '🔥' : b.z >= 2.5 ? '⚡' : '📊';
    return `${zBadge} <b>${b.label}</b>${moStr}\n    z<b>${zStr}</b>  <b>${b.p.toFixed(0)}%</b> vs ${b.bl.toFixed(0)}%  <b>${edgeStr}</b>  <i>n=${b.n}</i>${gsStr}`;
  }

  // Group bets by category; bets within each group sorted by z desc
  const betMap = new Map(bets.map(b => [b.k, b]));
  const groupLines = CATEGORIES
    .map(cat => {
      const catBets = cat.keys
        .map(k => betMap.get(k))
        .filter(Boolean)
        .sort((a, b) => b.z - a.z);
      if (!catBets.length) return null;
      const rows = catBets.map(formatBet).join('\n\n');
      return `📂 <b>${cat.label}</b> <i>(${catBets.length})</i>\n<tg-spoiler>${rows}</tg-spoiler>`;
    })
    .filter(Boolean)
    .join('\n\n');

  return `${league}⚽ <b>${match.home_team} vs ${match.away_team}</b>${score}${minute}\n${context}${gsLabel}\n${groupLines}`;
}

// ── Game state builder ─────────────────────────────────────────────────────────
// Derives a game state object from the live match data.
// If minute > 45 we're in 2H — use current score as HT proxy (best we have).
// If minute ≤ 45 we're in 1H — use FIRST_GOAL trigger based on whether
// the score is still 0-0 or someone has scored.
function buildGameState(match, matchCfg) {
  const score  = match.score;  // e.g. "1-0" or null
  const minute = match.minute; // e.g. "67'" or null

  if (!score || !minute) return null;

  const minNum = parseInt(minute, 10);
  if (isNaN(minNum)) return null;

  const parts = score.split('-');
  const homeG = parseInt(parts[0], 10);
  const awayG = parseInt(parts[1], 10);
  if (isNaN(homeG) || isNaN(awayG)) return null;

  if (minNum > 45) {
    // 2H in-play: use HT trigger with current score as proxy
    // (we don't have the actual HT split, this is an approximation)
    return {
      trigger:    'HT',
      home_goals: homeG,
      away_goals: awayG,
      _label:     `HT ${homeG}-${awayG} (approx)`,
      _approx:    true,
    };
  } else {
    // 1H in-play: use FIRST_GOAL trigger
    const favSide = matchCfg.fav_side;
    const favG = favSide === 'HOME' ? homeG : awayG;
    const dogG = favSide === 'HOME' ? awayG : homeG;
    let firstGoal;
    if (favG > 0)      firstGoal = 'FAV_1H';
    else if (dogG > 0) firstGoal = 'DOG_1H';
    else               firstGoal = null; // 0-0 in 1H — no first goal yet
    if (!firstGoal) return null; // nothing interesting to filter on
    return {
      trigger:     'FIRST_GOAL',
      first_goal:  firstGoal,
      _label:      `1H ${score} (${firstGoal})`,
      _approx:     false,
    };
  }
}

// ── Deduplication ─────────────────────────────────────────────────────────────
// In-memory — resets on restart. Keyed by matchId + betKey.
// Expires entries after 2 hours so a match can re-alert if signals change between runs.
const _notified = new Map(); // key → timestamp

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

// ── Core scan ─────────────────────────────────────────────────────────────────
let _db       = null;
let _dbPromise = null; // deduplicate concurrent calls during startup

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

async function runScan() {
  console.log(`[${new Date().toISOString()}] Scanning live matches…`);
  let matches;
  try {
    matches = await fetchLiveMatches();
  } catch (e) {
    console.error(`Livescore fetch failed: ${e.message}`);
    return;
  }

  if (!matches.length) {
    console.log('No live matches found.');
    return;
  }

  console.log(`Found ${matches.length} live match(es).`);
  const db = await getDb();

  for (const match of matches) {
    const matchCfg = buildCfgFromMatch(match.odds, cfg);
    if (!matchCfg) continue;

    // League tier filter — restrict DB to the configured tier before scoring
    let tierDb = db;
    if (cfg.LEAGUE_TIER === 'TOP')       tierDb = db.filter(r => r.league_tier === 'TOP');
    else if (cfg.LEAGUE_TIER === 'MAJOR') tierDb = db.filter(r => r.league_tier === 'MAJOR');
    else if (cfg.LEAGUE_TIER === 'TOP+MAJOR') tierDb = db.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');

    const cfgRows = applyConfig(tierDb, matchCfg);
    const blRows  = applyBaselineConfig(tierDb, matchCfg);
    const blSide  = blRows.filter(r => r.fav_side === matchCfg.fav_side);

    const bets = scoreBets(cfgRows, blRows, blSide, cfg.MIN_N);
    const qualifying = bets.filter(b =>
      b.z >= cfg.MIN_Z &&
      b.edge >= cfg.MIN_EDGE &&
      b.n >= cfg.MIN_N
    );

    if (!qualifying.length) continue;

    // Filter out already-notified bets
    const matchId  = match.id || `${match.home_team}:${match.away_team}`;
    const newBets  = qualifying.filter(b => !alreadyNotified(matchId, b.k));
    if (!newBets.length) continue;

    // ── Game state second pass ─────────────────────────────────────────────
    // Re-run scoring with current score as game state filter.
    // Uses MIN_N=15 (lower bar for in-play sample).
    const GS_MIN_N = 15;
    let gsMap = null;
    const gs = buildGameState(match, matchCfg);
    if (gs) {
      const gsRows = applyGameState(cfgRows, gs);
      if (gsRows.length >= GS_MIN_N) {
        const gsBets = scoreBets(gsRows, blRows, blSide, GS_MIN_N);
        gsMap = new Map(gsBets.map(b => [b.k, b]));
        match._gsLabel = gs._label + (gs._approx ? ' ⚠️approx' : '');
      }
    }

    // Attach signals to match for the message
    match._signals = matchCfg.signals;

    const msg = formatMessage(match, newBets, matchCfg, gsMap);
    console.log(`ALERT → ${match.home_team} vs ${match.away_team}: ${newBets.map(b => b.label).join(', ')}`);
    await sendTelegram(msg);

    for (const b of newBets) markNotified(matchId, b.k);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const once = process.argv.includes('--once');

  // Pre-load DB on startup
  await getDb();

  if (once) {
    await runScan();
    process.exit(0);
  }

  // Validate Telegram credentials before starting the loop
  if (cfg.TELEGRAM_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.error('ERROR: Fill in TELEGRAM_TOKEN and TELEGRAM_CHAT_ID in config.js before starting.');
    process.exit(1);
  }

  console.log(`Scheduler started — scanning every ${cfg.SCAN_INTERVAL_MINUTES} minute(s).`);
  await runScan(); // run immediately on start

  const cronExpr = `*/${cfg.SCAN_INTERVAL_MINUTES} * * * *`;
  cron.schedule(cronExpr, runScan);
}

main().catch(e => { console.error(e); process.exit(1); });
