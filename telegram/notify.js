'use strict';
// ── HalvestAH Telegram Notifier — AH Steam → Bet Dog ──────────────────────────
//
// Strategy: when the pre-match AH line steams ≥ 0.50 toward the favourite
// (e.g. −0.25 → −0.75), bet on the underdog at closing AH odds.
//
// Backtest (TOP+MAJOR, 12-month OOS, n=934):
//   Win rate : 55.8%   Fair odds : 1.79   Avg odds : 1.89   ROI : +21%
//   By closing line: −1.50 → 75.2% wins / +43% ROI (strongest tier)
//
// No database required — purely market-signal based.
//
// Usage:
//   node notify.js          — start scheduler (runs every N minutes)
//   node notify.js --once   — single scan + exit (for testing)

const path = require('path');
const cron = require('node-cron');
const cfg  = require('./config');
const { classifyLeague } = require('./engine');
const { fetchLiveMatches } = require('./livescore');

const VERBOSE = process.argv.includes('--verbose');

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

// Parse live minute from match.minute field.
// Returns a number if the match is live, or null if upcoming / not started.
function parseLiveMinute(minute) {
  if (minute == null) return null;
  const s = String(minute).replace(/'/g, '').trim();
  if (s === 'HT') return 45;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

// Determine fav side, fav/dog closing and opening AH lines, and dog closing odds
// from raw livescore odds. Returns null if required data is missing.
function parseMatchSteam(odds) {
  const ahHc = odds.ah_hc;  // closing AH handicap (home perspective)
  const ahHo = odds.ah_ho;  // opening AH handicap (home perspective)
  const hoC  = odds.ho_c;   // home closing odds
  const aoC  = odds.ao_c;   // away closing odds

  if (ahHc == null || ahHo == null || hoC == null || aoC == null) return null;

  // Derive fav side from closing handicap sign
  let favSide, favLc, favLo, dogOc, favTeam, dogTeam;
  if (ahHc < -0.01) {
    // Home is fav
    favSide = 'HOME';
    favLc   = Math.abs(ahHc);
    favLo   = Math.abs(ahHo);
    dogOc   = aoC;
  } else if (ahHc > 0.01) {
    // Away is fav
    favSide = 'AWAY';
    favLc   = Math.abs(ahHc);
    favLo   = Math.abs(ahHo);
    dogOc   = hoC;
  } else {
    // Level ball: fav = lower closing odds
    favSide = hoC <= aoC ? 'HOME' : 'AWAY';
    favLc   = 0.0;
    favLo   = Math.abs(ahHo);
    dogOc   = favSide === 'HOME' ? aoC : hoC;
  }

  const steam = favLc - favLo;  // positive = fav steamed deeper
  return { favSide, favLc, favLo, steam, dogOc };
}

// Format the AH line for display: e.g. "−0.75 (was −0.25)"
function ahLabel(favLc, favLo) {
  const cStr = favLc.toFixed(2);
  const oStr = favLo.toFixed(2);
  return `−${cStr}  (was −${oStr})`;
}

// Strength label based on steam magnitude
function steamLabel(steam) {
  if (steam >= 0.75) return '🔥🔥 MASSIVE STEAM';
  if (steam >= 0.50) return '🔥 STEAM';
  return '⚡ STEAM';
}

// ROI reference by closing line (from backtest_lm2.js results)
function roiRef(favLc) {
  if (Math.abs(favLc - 1.50) < 0.13) return '+43% ROI hist';
  if (Math.abs(favLc - 1.25) < 0.13) return '+33% ROI hist';
  if (Math.abs(favLc - 1.00) < 0.13) return '+20% ROI hist';
  if (Math.abs(favLc - 0.75) < 0.13) return '+18% ROI hist';
  if (Math.abs(favLc - 0.50) < 0.13) return '+10% ROI hist';
  return '+21% ROI hist';
}

// Human-readable tier label
function tierLabel(tier) {
  if (tier === 'TOP')   return '⭐ TOP League';
  if (tier === 'MAJOR') return '🔵 MAJOR League';
  return '⚪ Minor League';
}

// ── Message formatter ─────────────────────────────────────────────────────────
function formatMessage(match, steam, tier) {
  const { favSide, favLc, favLo, dogOc } = steam;
  const steamMag = favLc - favLo;

  const favTeam = favSide === 'HOME' ? match.home_team : match.away_team;
  const dogTeam = favSide === 'HOME' ? match.away_team : match.home_team;
  const dogLine = favLc.toFixed(2);   // dog gets +favLc

  const steps = Math.round(steamMag / 0.25);
  const stepsLabel = `${steps} step${steps !== 1 ? 's' : ''}  (+${steamMag.toFixed(2)})`;

  const lines = [
    `${steamLabel(steamMag)} <b>DOG AH ALERT</b>  ·  ${nowTime()}`,
    ``,
    `🏆 <i>${match.league || '—'}</i>  ·  ${tierLabel(tier)}`,
    `⚽ <b>${match.home_team} vs ${match.away_team}</b>`,
    `🕐 <b>${match.minute}'</b>  Score: <b>${match.score || '0–0'}</b>`,
    ``,
    `📉 <b>${favTeam}</b> fav steamed ${stepsLabel}`,
    `   AH: ${ahLabel(favLc, favLo)}`,
    ``,
    `💰 BET: <b>${dogTeam}  +${dogLine}  @  ${dogOc.toFixed(2)}</b>`,
    ``,
    `📈 ${roiRef(favLc)}  ·  55.8% win rate  (OOS, ALL leagues)`,
  ];

  return lines.join('\n');
}

// ── Deduplication ─────────────────────────────────────────────────────────────
// Keyed by matchId. Expires after 3 hours (one match lifespan).
const _notified = new Map();
const DEDUP_TTL = 3 * 60 * 60 * 1000;

function alreadyNotified(matchId) {
  const ts = _notified.get(matchId);
  if (!ts) return false;
  if (Date.now() - ts > DEDUP_TTL) { _notified.delete(matchId); return false; }
  return true;
}

function markNotified(matchId) {
  _notified.set(matchId, Date.now());
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
async function runScan() {
  console.log(`[${new Date().toISOString()}] Scanning…`);

  let matches;
  try { matches = await fetchMatches(); }
  catch (e) { console.error(`Livescore fetch failed: ${e.message}`); return; }

  if (!matches.length) { console.log('No matches found.'); return; }
  console.log(`Found ${matches.length} match(es).`);

  for (const match of matches) {
    const label   = `${match.home_team} vs ${match.away_team}`;
    const liveMin = parseLiveMinute(match.minute);

    // Only alert when the match is live between minute ALERT_MIN and ALERT_MAX
    if (liveMin == null || liveMin < cfg.ALERT_MIN_MINUTE || liveMin > cfg.ALERT_MAX_MINUTE) {
      if (VERBOSE) console.log(`  SKIP [min=${liveMin ?? 'upcoming'}]  ${label}`);
      continue;
    }

    // League tier filter
    const tier = classifyLeague(match.league || '');
    if (cfg.LEAGUE_TIER === 'TOP' && tier !== 'TOP') {
      if (VERBOSE) console.log(`  SKIP [tier=${tier}]  ${label}`);
      continue;
    }
    if (cfg.LEAGUE_TIER === 'TOP+MAJOR' && tier !== 'TOP' && tier !== 'MAJOR') {
      if (VERBOSE) console.log(`  SKIP [tier=${tier}]  ${label}`);
      continue;
    }

    // Parse steam
    const steam = parseMatchSteam(match.odds || {});
    if (!steam) {
      if (VERBOSE) console.log(`  SKIP [no odds]  ${label}`);
      continue;
    }

    const { steam: steamMag, dogOc } = steam;

    // Steam threshold
    if (steamMag < cfg.LM_STEAM_MIN) {
      if (VERBOSE) console.log(`  SKIP [steam=${steamMag.toFixed(2)} < ${cfg.LM_STEAM_MIN}]  ${label}`);
      continue;
    }

    // Dog odds sanity check (must be a valid decimal odds)
    if (!dogOc || dogOc < 1.01 || dogOc > 20) {
      if (VERBOSE) console.log(`  SKIP [invalid dog_oc=${dogOc}]  ${label}`);
      continue;
    }

    // Deduplication
    const matchId = match.id || `${match.home_team}:${match.away_team}`;
    if (alreadyNotified(matchId)) {
      if (VERBOSE) console.log(`  SKIP [already notified]  ${label}`);
      continue;
    }

    // Fire alert
    const msg = formatMessage(match, steam);
    const steps = Math.round(steamMag / 0.25);
    console.log(`ALERT → ${label}  steam=+${steamMag.toFixed(2)} (${steps} steps)  dog_oc=${dogOc.toFixed(2)}  tier=${tier}`);
    await sendTelegram(msg);
    markNotified(matchId);
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const once = process.argv.includes('--once');

  if (once) {
    await runScan();
    process.exit(0);
  }

  console.log(`Scheduler started — every ${cfg.SCAN_INTERVAL_MINUTES} min.`);
  console.log(`Strategy: AH steam ≥ ${cfg.LM_STEAM_MIN} → bet dog AH  (tier=${cfg.LEAGUE_TIER}  window=${cfg.ALERT_MIN_MINUTE}–${cfg.ALERT_MAX_MINUTE}')`);
  await runScan();
  cron.schedule(`*/${cfg.SCAN_INTERVAL_MINUTES} * * * *`, runScan);
}

main().catch(e => { console.error(e); process.exit(1); });
