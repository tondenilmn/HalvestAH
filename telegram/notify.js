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

const cron = require('node-cron');
const cfg  = require('./config');
const { classifyLeague } = require('./engine');
const { fetchLiveMatches, fetchNextMatches } = require('./livescore');

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
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: cfg.DISPLAY_TZ,
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  }).format(new Date());
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
  let favSide, favLc, favLo, dogOc;
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

// Tier badge (compact)
function tierBadge(tier) {
  if (tier === 'TOP')   return '⭐ TOP';
  if (tier === 'MAJOR') return '🔵 MAJOR';
  return '⚪ OTHER';
}

// AH arrow: "−0.25 → −0.75  +0.50"
function ahArrow(favLc, favLo) {
  const steamMag = favLc - favLo;
  const oStr     = favLo < 0.01 ? '0.00' : `−${favLo.toFixed(2)}`;
  return `${oStr} → −${favLc.toFixed(2)}  <b>+${steamMag.toFixed(2)}</b>`;
}

// Kickoff time in Italian timezone (for prematch)
function kickoffTimeLabel(kickoffTimeStr) {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: cfg.DISPLAY_TZ,
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  }).format(new Date(kickoffTimeStr));
}

// ── Message formatters ────────────────────────────────────────────────────────
function formatMessage(match, steam, tier) {
  const { favSide, favLc, favLo, dogOc } = steam;
  const steamMag = favLc - favLo;

  const homeLabel = `${match.home_team} (H)`;
  const awayLabel = `${match.away_team} (A)`;
  const favTeam   = favSide === 'HOME' ? homeLabel : awayLabel;
  const dogTeam   = favSide === 'HOME' ? awayLabel : homeLabel;

  return [
    `🚨 <b>LIVE STEAM · DOG AH</b>  ${nowTime()}`,
    ``,
    `⚽ <b>${homeLabel} vs ${awayLabel}</b>`,
    `🏆 <i>${match.league || '—'}</i>  ·  ${tierBadge(tier)}  ·  ⏱ ${match.minute}'  ${match.score || '0–0'}`,
    ``,
    `📉 ${favTeam} (fav)  ${ahArrow(favLc, favLo)}`,
    ``,
    `💰 BET: <b>${dogTeam}  +${favLc.toFixed(2)}  @  ${dogOc.toFixed(2)}</b>`,
  ].join('\n');
}

function formatUpcomingMessage(match, steam, tier, minsToKickoff) {
  const { favSide, favLc, favLo, dogOc } = steam;
  const steamMag = favLc - favLo;

  const homeLabel = `${match.home_team} (H)`;
  const awayLabel = `${match.away_team} (A)`;
  const favTeam   = favSide === 'HOME' ? homeLabel : awayLabel;
  const dogTeam   = favSide === 'HOME' ? awayLabel : homeLabel;

  const koTime  = match.kickoff_time ? kickoffTimeLabel(match.kickoff_time) : null;
  const minsRnd = Math.round(minsToKickoff);
  const timing  = koTime
    ? `🕐 ${koTime}  (${minsRnd <= 1 ? 'now' : `in ${minsRnd} min`})`
    : `⏳ ${minsRnd <= 1 ? 'kicks off now' : `kicks off in ${minsRnd} min`}`;

  return [
    `⏰ <b>PRE-KICK STEAM · DOG AH</b>  ${nowTime()}`,
    ``,
    `⚽ <b>${homeLabel} vs ${awayLabel}</b>`,
    `🏆 <i>${match.league || '—'}</i>  ·  ${tierBadge(tier)}  ·  ${timing}`,
    ``,
    `📉 ${favTeam} (fav)  ${ahArrow(favLc, favLo)}`,
    ``,
    `💰 BET: <b>${dogTeam}  +${favLc.toFixed(2)}  @  ${dogOc.toFixed(2)}</b>`,
  ].join('\n');
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

// ── Match fetcher (live + upcoming) ──────────────────────────────────────────
async function fetchMatches() {
  let liveMatches;
  if (cfg.DATA_URL) {
    const url  = `${cfg.DATA_URL.replace(/\/$/, '')}/api/livescore`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Cloudflare livescore returned HTTP ${resp.status}`);
    liveMatches = (await resp.json()).matches || [];
  } else {
    liveMatches = await fetchLiveMatches();
  }

  // Always fetch upcoming matches from tablenext (no Cloudflare endpoint yet)
  let nextMatches = [];
  try { nextMatches = await fetchNextMatches(); }
  catch (e) { console.error(`NextGame fetch failed: ${e.message}`); }

  // Merge — deduplicate by matchId
  const seen = new Set(liveMatches.map(m => m.id).filter(Boolean));
  for (const m of nextMatches) {
    if (!m.id || !seen.has(m.id)) {
      liveMatches.push(m);
      if (m.id) seen.add(m.id);
    }
  }

  return liveMatches;
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

    // Compute minutes to kickoff for non-live matches.
    // tablenext times have a Z suffix (real UTC) → compare directly with Date.now().
    // livegame getDatalast1 times have no suffix (Italian wall-clock) → shift now by SITE_GMT_OFFSET.
    let minsToKickoff = null;
    if (liveMin == null && match.kickoff_time) {
      const kt = match.kickoff_time;
      if (/Z$|[+-]\d{2}:\d{2}$/.test(kt)) {
        minsToKickoff = (new Date(kt).getTime() - Date.now()) / 60000;
      } else {
        const kickoffMs = new Date(kt + 'Z').getTime();
        const nowMs     = Date.now() + cfg.SITE_GMT_OFFSET * 3600000;
        minsToKickoff   = (kickoffMs - nowMs) / 60000;
      }
    }

    const isLive     = liveMin != null && liveMin >= cfg.ALERT_MIN_MINUTE && liveMin <= cfg.ALERT_MAX_MINUTE;
    const isUpcoming = minsToKickoff != null && minsToKickoff >= 0 && minsToKickoff <= cfg.UPCOMING_WINDOW_MINUTES;

    if (!isLive && !isUpcoming) {
      if (VERBOSE) {
        const reason = minsToKickoff != null
          ? `min_to_ko=${minsToKickoff.toFixed(1)}`
          : `min=${liveMin ?? 'no_time'}`;
        console.log(`  SKIP [${reason}]  ${label}`);
      }
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

    // Dog odds sanity check
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
    const steps = Math.round(steamMag / 0.25);
    let msg;
    if (isUpcoming) {
      msg = formatUpcomingMessage(match, steam, tier, minsToKickoff);
      console.log(`ALERT (pre-kick) → ${label}  ko_in=${minsToKickoff.toFixed(1)}min  steam=+${steamMag.toFixed(2)} (${steps} steps)  dog_oc=${dogOc.toFixed(2)}  tier=${tier}`);
    } else {
      msg = formatMessage(match, steam, tier);
      console.log(`ALERT (live) → ${label}  steam=+${steamMag.toFixed(2)} (${steps} steps)  dog_oc=${dogOc.toFixed(2)}  tier=${tier}`);
    }
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
