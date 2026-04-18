'use strict';
// ── HalvestAH Telegram Notifier ───────────────────────────────────────────────
//
// Usage:
//   node notify.js          — start scheduler (runs every N minutes)
//   node notify.js --once   — single scan + exit (for testing)
//   node notify.js --verbose — verbose logging (skip reasons, suppressed bets)

const path = require('path');
const cron = require('node-cron');
const cfg  = require('./config');
const {
  classifyLeague,
  loadDatabase, loadDatabaseFromUrl,
  applyConfig, applyBaselineConfig,
  buildCfgFromMatch, scoreBets,
} = require('./engine');
// const { fetchLiveMatches, fetchNextMatches, fetchNextMatchesAllDays, refreshHashes } = require('./livescore');
const { fetchLiveMatches, fetchNextMatches, refreshHashes } = require('./livescore');

const VERBOSE = process.argv.includes('--verbose') || process.env.VERBOSE === 'true';
const verbose = VERBOSE ? (...a) => console.log(...a) : () => {};

// Format: [min'] Match  Strategy  reason
function flog(liveMin, label, strat, msg) {
  const m = liveMin != null ? `[${liveMin}']` : '[—]';
  console.log(`${m.padEnd(6)} ${label}  ${strat}  ${msg}`);
}
function flogv(liveMin, label, strat, msg) {
  if (VERBOSE) flog(liveMin, label, strat, msg);
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${cfg.TELEGRAM_TOKEN}/sendMessage`;
  const preview = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  console.log(`[TELEGRAM] Sending notification → "${preview}…"`);
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: cfg.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      console.error(`[TELEGRAM] Send FAILED: ${await res.text()}`);
    } else {
      console.log(`[TELEGRAM] Sent OK`);
      _scanAlerts++;
    }
  } catch (e) {
    console.error(`[TELEGRAM] Fetch failed: ${e.message}`);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

// Escape HTML special chars (team/league names may contain < >)
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function nowTime() {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: cfg.DISPLAY_TZ,
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  }).format(new Date());
}

function kickoffTimeLabel(kickoffTimeStr) {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: cfg.DISPLAY_TZ,
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  }).format(new Date(kickoffTimeStr));
}

// Parse live minute from match.minute. Returns null if upcoming/not started.
function parseLiveMinute(minute) {
  if (minute == null) return null;
  const s = String(minute).replace(/'/g, '').trim();
  if (s === 'HT') return 45;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

// Parse "H-A" score string → { home, away } or null.
function parseScoreStr(score) {
  if (!score) return null;
  const m = String(score).replace('–', '-').replace('—', '-').match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  return { home: parseInt(m[1], 10), away: parseInt(m[2], 10) };
}

// Returns true if matchTier is allowed under stratTier setting.
function tierAllowed(matchTier, stratTier) {
  if (!stratTier || stratTier === 'ALL') return true;
  if (stratTier === 'TOP')       return matchTier === 'TOP';
  if (stratTier === 'MAJOR')     return matchTier === 'MAJOR';
  if (stratTier === 'TOP+MAJOR') return matchTier === 'TOP' || matchTier === 'MAJOR';
  return true;
}

// Determine fav/dog AH params from raw livescore odds. Returns null if data missing.
function parseMatchSteam(odds) {
  const { ah_hc: ahHc, ah_ho: ahHo, ho_c: hoC, ao_c: aoC } = odds;
  if (ahHc == null || ahHo == null || hoC == null || aoC == null) return null;

  let favSide, favLc, favLo, dogOc;
  if (ahHc < -0.01) {
    favSide = 'HOME'; favLc = Math.abs(ahHc); favLo = Math.abs(ahHo); dogOc = aoC;
  } else if (ahHc > 0.01) {
    favSide = 'AWAY'; favLc = Math.abs(ahHc); favLo = Math.abs(ahHo); dogOc = hoC;
  } else {
    favSide = hoC <= aoC ? 'HOME' : 'AWAY';
    favLc   = 0.0;
    favLo   = Math.abs(ahHo);
    dogOc   = favSide === 'HOME' ? aoC : hoC;
  }

  return { favSide, favLc, favLo, steam: favLc - favLo, dogOc };
}

// Compute all window flags and common fields for a match once per scan iteration.
function matchContext(match) {
  const liveMin = parseLiveMinute(match.minute);
  const rawMin  = String(match.minute || '').replace(/'/g, '').trim();

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

  return {
    matchId:       match.id || `${match.home_team}:${match.away_team}`,
    label:         `${match.home_team} vs ${match.away_team}`,
    tier:          classifyLeague(match.league || ''),
    steam:         parseMatchSteam(match.odds || {}),
    liveMin,
    rawMin,
    minsToKickoff,
    isLive:        liveMin != null && liveMin >= cfg.ALERT_MIN_MINUTE && liveMin <= cfg.ALERT_MAX_MINUTE,
    isUpcoming:    minsToKickoff != null && minsToKickoff >= 0 && minsToKickoff <= cfg.UPCOMING_WINDOW_MINUTES,
    isMktEdge:     liveMin != null && liveMin >= 1 && liveMin <= cfg.S6_WINDOW_MINUTES,
    isSXYEarly:   liveMin != null && liveMin >= cfg.SXSY_EARLY_MIN     && liveMin <= cfg.SXSY_EARLY_MAX,
    isSXYMidH:    liveMin != null && liveMin >= cfg.SXSY_MIDH_MIN      && liveMin <= cfg.SXSY_MIDH_MAX,
    isSXYHTStore: liveMin != null && liveMin >= cfg.SXSY_HT_STORE_MIN  && liveMin <= cfg.SXSY_HT_STORE_MAX,
    isSXYHTFire:  liveMin != null && liveMin >= cfg.SXSY_HT_FIRE_MIN   && liveMin <= cfg.SXSY_HT_FIRE_MAX,
    isS8Fire:     liveMin != null && liveMin >= cfg.S8_FIRE_MIN        && liveMin <= cfg.S8_FIRE_MAX,
    isS9Fire:     liveMin != null && liveMin >= cfg.S9_FIRE_MIN        && liveMin <= cfg.S9_FIRE_MAX,
    isS10Fire:    liveMin != null && liveMin >= cfg.S10_FIRE_MIN       && liveMin <= cfg.S10_FIRE_MAX,
    isS11Fire:    liveMin != null && liveMin >= cfg.S11_FIRE_MIN       && liveMin <= cfg.S11_FIRE_MAX,
    isS12Fire:    liveMin != null && liveMin >= cfg.S12_FIRE_MIN       && liveMin <= cfg.S12_FIRE_MAX,
    isSteamNext:  liveMin == null && (minsToKickoff == null || minsToKickoff > 0),
    isS1HTStore:  liveMin != null && liveMin >= cfg.S1_HT_STORE_MIN && liveMin <= cfg.S1_HT_STORE_MAX,
    isS1Fire:     liveMin != null && liveMin >= cfg.S1_FIRE_MIN      && liveMin <= cfg.S1_FIRE_MAX,
    isS2HTStore:  liveMin != null && liveMin >= cfg.S2_HT_STORE_MIN && liveMin <= cfg.S2_HT_STORE_MAX,
    isS2Fire:     liveMin != null && liveMin >= cfg.S2_FIRE_MIN      && liveMin <= cfg.S2_FIRE_MAX,
    isS3Fire:     liveMin != null && liveMin >= cfg.S3_FIRE_MIN      && liveMin <= cfg.S3_FIRE_MAX,
    isS5HTStore:  liveMin != null && liveMin >= cfg.S5_HT_STORE_MIN  && liveMin <= cfg.S5_HT_STORE_MAX,
    isS5Fire:     liveMin != null && liveMin >= cfg.S5_FIRE_MIN       && liveMin <= cfg.S5_FIRE_MAX,
    isSS6HTStore: liveMin != null && liveMin >= cfg.SS6_HT_STORE_MIN && liveMin <= cfg.SS6_HT_STORE_MAX,
    isSS6Fire:    liveMin != null && liveMin >= cfg.SS6_FIRE_MIN      && liveMin <= cfg.SS6_FIRE_MAX,
  };
}

// ── Deduplication ─────────────────────────────────────────────────────────────
class Dedup {
  constructor(ttlMs) {
    this._map = new Map();
    this._ttl = ttlMs;
  }

  has(key) {
    const ts = this._map.get(key);
    if (!ts) return false;
    if (Date.now() - ts > this._ttl) { this._map.delete(key); return false; }
    return true;
  }

  mark(key) { this._map.set(key, Date.now()); }
}

// ── Message builders ──────────────────────────────────────────────────────────

function tierBadge(tier) {
  if (tier === 'TOP')   return 'TOP';
  if (tier === 'MAJOR') return 'MAJOR';
  return 'OTHER';
}

// Build signal badges string from a signals object (used by S6).
function buildSignalBadges(signals) {
  const { lineMove, favOddsMove, dogOddsMove, tlMove } = signals;
  return [
    lineMove    !== 'STABLE' && lineMove    !== 'UNKNOWN' ? `LM:${lineMove}`     : null,
    favOddsMove !== 'STABLE' && favOddsMove !== 'UNKNOWN' ? `FAV:${favOddsMove}` : null,
    dogOddsMove !== 'STABLE' && dogOddsMove !== 'UNKNOWN' ? `DOG:${dogOddsMove}` : null,
    tlMove      !== 'STABLE' && tlMove      !== 'UNKNOWN' ? `TL:${tlMove}`       : null,
  ].filter(Boolean).join('  ') || '—';
}

// Common message frame used by all strategies.
// betLines: array of strings, each pair is '💰 <bet>' and '📌 Min odds: ...'
function buildMessage(strategyName, match, minuteScore, betLines) {
  return [
    `<b>${strategyName}</b>`,
    ``,
    `🕐 ${nowTime()}`,
    `🏆 ${esc(match.league) || '—'}`,
    `⚽ ${esc(match.home_team)} vs ${esc(match.away_team)}`,
    `⏱ ${minuteScore}`,
    ``,
    ...betLines,
  ].join('\n');
}

// ── Bet365 odds (botbot3 oddsComp) ────────────────────────────────────────────
function _extractHtml(jsText, tableId) {
  const marker = `$("#${tableId}").html("`;
  const start = jsText.indexOf(marker);
  if (start === -1) return null;
  let i = start + marker.length;
  const chars = [];
  while (i < jsText.length) {
    const ch = jsText[i];
    if (ch === '\\' && i + 1 < jsText.length) {
      const nx = jsText[i + 1];
      if      (nx === '"')  chars.push('"');
      else if (nx === "'")  chars.push("'");
      else if (nx === '\\') chars.push('\\');
      else if (nx === 'n')  chars.push('\n');
      else if (nx === 'r')  chars.push('\r');
      else if (nx === 't')  chars.push('\t');
      else                  chars.push(nx);
      i += 2;
    } else if (ch === '"') { break; }
    else { chars.push(ch); i++; }
  }
  return chars.join('');
}

function _parseBet365Odds(jsText) {
  const tm1Html = _extractHtml(jsText, 'tablematch1');
  if (!tm1Html) return null;
  const bookmakers = [...tm1Html.matchAll(/class='bnfsd'>([^<]+)</g)].map(m => m[1].trim());
  const b365Idx = bookmakers.findIndex(b => /bet.?365/i.test(b));
  if (b365Idx === -1) return null;

  const tm2Html = _extractHtml(jsText, 'tablematch2');
  if (!tm2Html) return null;
  const groups = tm2Html.split("<tr class='vrng'><td colspan='25'></td></tr>");
  if (b365Idx >= groups.length) return null;

  const group = groups[b365Idx];
  const hRow = group.match(/<tr[^>]*><td>H<\/td>(.*?)<\/tr>/);
  const aRow = group.match(/<tr[^>]*><td>A<\/td>(.*?)<\/tr>/);
  if (!hRow || !aRow) return null;

  const tds = html => [...html.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(m => m[1].trim());
  const pf  = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };
  const h = tds(hRow[1]);
  const a = tds(aRow[1]);
  const oRow = group.match(/<tr[^>]*><td>O<\/td>(.*?)<\/tr>/);
  const uRow = group.match(/<tr[^>]*><td>U<\/td>(.*?)<\/tr>/);
  const o = oRow ? tds(oRow[1]) : [];
  const u = uRow ? tds(uRow[1]) : [];

  return {
    ahHc: pf(h[0]), hoC: pf(h[3]), aoC: pf(a[3]),
    ovC:  o.length > 3 ? pf(o[3]) : null,
    unC:  u.length > 3 ? pf(u[3]) : null,
  };
}

async function fetchBet365Data(matchId) {
  try {
    const resp = await fetch(`https://botbot3.space/tables/v4/oddsComp/${matchId}.js`, {
      headers: {
        Origin:       'https://www.asianbetsoccer.com',
        Referer:      'https://www.asianbetsoccer.com/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      },
    });
    if (!resp.ok) return null;
    return _parseBet365Odds(await resp.text());
  } catch {
    return null;
  }
}

// ── Database ──────────────────────────────────────────────────────────────────
let _dbAll = null;

async function loadDb() {
  try {
    if (cfg.DATA_URL) {
      console.log(`[DB] Loading from ${cfg.DATA_URL}…`);
      _dbAll = await loadDatabaseFromUrl(cfg.DATA_URL);
    } else {
      const dataDir = path.resolve(__dirname, cfg.DATA_DIR);
      console.log(`[DB] Loading from ${dataDir}…`);
      _dbAll = loadDatabase(dataDir);
    }
    console.log(`[DB] Ready — ${_dbAll.length} rows (ALL)`);
  } catch (e) {
    console.error(`[DB] Load failed: ${e.message}`);
    _dbAll = [];
  }
}


// ── Strategy SX / SY: 3-book steam → structural favourite wins ────────────────
// SX: all available books steamed AH toward home, home opened as structural fav
// SY: all available books steamed AH toward away, home opened as structural dog
//
// Alert 1 (1–10'):  steam confirmed → bet 1x2 fav at soft books
// Alert 2 (28–32'): still 0-0 → Over 0.5 1H in-play
// Alert 3 (44–52'): HT score → 2H live bet
//
// Win rates from master_steam_analysis.html (73,910 fixtures):
//   SX home win 71.8%  (n=1,151) · SY away win 74.1% (n=378)
//   HT: leading fav wins 91-92%, 0-0 wins 56-60%, drawn wins 55-57%, losing → BTTS 81-83%
//   2H Over 0.5: 83-84% in all HT states

const sxyCandidates = new Map(); // matchId → { type, favSide, steamData, storedAt }
const SXYC_TTL      = 4 * 60 * 60 * 1000;
const sxyDedup      = new Dedup(6 * 60 * 60 * 1000); // keyed by matchId:sx1/sx2/sx3/sy1/sy2/sy3

// Analyse AH steam direction and magnitude across all available books.
// Returns a signal object if the steam qualifies, or null if not.
function detectSXYSignal(match) {
  const pin  = match.odds;
  const b365 = match.bet365_odds;
  const sbo  = match.sbobet_odds;

  // Pinnacle must always be present
  if (!pin || pin.ah_ho == null || pin.ah_hc == null) return null;

  // Structural role determined by Pinnacle opening line
  const ahHo = pin.ah_ho;
  let favSide;
  if      (ahHo < -0.01) favSide = 'HOME';   // SX
  else if (ahHo >  0.01) favSide = 'AWAY';   // SY
  else return null;                            // pick'em — skip

  // Steam direction: positive = toward home, negative = toward away
  // For SX (home fav) we want positive; for SY (away fav) we want negative
  const dir      = favSide === 'HOME' ? 1 : -1;
  const minSteam = cfg.SXSY_MIN_STEAM;

  const pinSteam = pin.ah_ho - pin.ah_hc;

  // Pinnacle AH steam must always confirm
  if (pinSteam * dir < minSteam) return null;

  // Pinnacle TL must always rise
  if (pin.tl_c == null || pin.tl_o == null || pin.tl_c <= pin.tl_o) return null;

  if (favSide === 'AWAY') {
    // SY: all 3 books required
    if (!b365 || b365.ah_ho == null || b365.ah_hc == null) return null;
    if (!sbo  || sbo.ah_ho  == null || sbo.ah_hc  == null) return null;

    const b365Steam = b365.ah_ho - b365.ah_hc;
    const sboSteam  = sbo.ah_ho  - sbo.ah_hc;

    if (b365Steam * dir < minSteam) return null;
    if (sboSteam  * dir < minSteam) return null;

    if (b365.tl_c == null || b365.tl_o == null || b365.tl_c <= b365.tl_o) return null;
    if (sbo.tl_c  == null || sbo.tl_o  == null || sbo.tl_c  <= sbo.tl_o)  return null;

    return {
      type: 'SY',
      favSide,
      confirmedBooks: 3,
      pinSteam, b365Steam, sboSteam,
      pinAhHo:  pin.ah_ho,   pinAhHc:  pin.ah_hc,
      b365AhHo: b365.ah_ho,  b365AhHc: b365.ah_hc,
      sboAhHo:  sbo.ah_ho,   sboAhHc:  sbo.ah_hc,
      tlO: pin.tl_o, tlC: pin.tl_c,
      b365TlO: b365.tl_o, b365TlC: b365.tl_c,
      sboTlO:  sbo.tl_o,  sboTlC:  sbo.tl_c,
    };
  }

  // SX: Pinnacle + any one of Bet365 or Sbobet must confirm AH steam + TL rising
  const b365AhOk = b365 && b365.ah_ho != null && b365.ah_hc != null;
  const sboAhOk  = sbo  && sbo.ah_ho  != null && sbo.ah_hc  != null;

  const b365Confirms = b365AhOk &&
    (b365.ah_ho - b365.ah_hc) * dir >= minSteam &&
    b365.tl_c != null && b365.tl_o != null && b365.tl_c > b365.tl_o;
  const sboConfirms  = sboAhOk &&
    (sbo.ah_ho - sbo.ah_hc) * dir >= minSteam &&
    sbo.tl_c  != null && sbo.tl_o  != null && sbo.tl_c  > sbo.tl_o;

  if (!b365Confirms && !sboConfirms) return null;

  const b365Steam = b365AhOk ? b365.ah_ho - b365.ah_hc : null;
  const sboSteam  = sboAhOk  ? sbo.ah_ho  - sbo.ah_hc  : null;

  return {
    type: 'SX',
    favSide,
    confirmedBooks: 1 + (b365Confirms ? 1 : 0) + (sboConfirms ? 1 : 0),
    pinSteam, b365Steam, sboSteam,
    pinAhHo:  pin.ah_ho,        pinAhHc:  pin.ah_hc,
    b365AhHo: b365?.ah_ho ?? null, b365AhHc: b365?.ah_hc ?? null,
    sboAhHo:  sbo?.ah_ho  ?? null, sboAhHc:  sbo?.ah_hc  ?? null,
    tlO: pin.tl_o, tlC: pin.tl_c,
    b365TlO: b365?.tl_o ?? null, b365TlC: b365?.tl_c ?? null,
    sboTlO:  sbo?.tl_o  ?? null, sboTlC:  sbo?.tl_c  ?? null,
  };
}

// Format a book's AH movement as "−0.75 → −1.00  +0.25 ✅" or "n/a"
function sxyBookLine(ahHo, ahHc, dir) {
  if (ahHo == null || ahHc == null) return 'n/a';
  const steam = (ahHo - ahHc) * dir;
  const fmt   = v => v >= 0 ? `+${v.toFixed(2)}` : `${v.toFixed(2)}`;
  const tick  = steam >= cfg.SXSY_MIN_STEAM ? ' ✅' : ' ❌';
  return `AH ${fmt(ahHo)} → ${fmt(ahHc)}  (${steam >= 0 ? '+' : ''}${steam.toFixed(2)})${tick}`;
}

function sxyAlert1Format(match, sd, tier) {
  const isSX    = sd.type === 'SX';
  const side    = isSX ? 'HOME' : 'AWAY';
  const minOdds = isSX ? '1.46' : '1.42';
  const winRate = isSX ? '71.8%' : '74.1%';
  const booksLabel = isSX ? `Pin+${sd.confirmedBooks - 1} book confirmed` : '3/3 books confirmed';
  return buildMessage(
    isSX ? `SX — Conf. Fav ${sd.confirmedBooks}/3-book steam` : 'SY — Steam Away Fav 3-book steam',
    match,
    `${esc(match.minute)}'  ${match.score || '0-0'}`,
    [
      `💰 <b>1x2 ${side} WIN at soft books</b>`,
      `📌 Min odds: @${minOdds}  (${winRate} win rate — ${booksLabel})`,
    ],
  );
}

function sxyAlert2Format(match, sd, tier, liveMin) {
  const isSX     = sd.type === 'SX';
  const minsLeft = 45 - liveMin;
  const scoreStr = match.score || '0-0';
  const title    = isSX ? `SX — Home fav 0 goals at ${liveMin}'` : `SY — Still 0-0 at 30'`;
  return buildMessage(
    title,
    match,
    `${liveMin}'  ${scoreStr}`,
    [
      `💰 <b>Over 0.5 1H (in-play)</b>`,
      `📌 Check live odds  (~${minsLeft} min left)`,
    ],
  );
}

function sxyAlert3Format(match, sd, htScore, tier, liveMin) {
  const isSX     = sd.type === 'SX';
  const side     = isSX ? 'HOME' : 'AWAY';
  const htStr    = `${htScore.home}-${htScore.away}`;
  const favGoals = isSX ? htScore.home : htScore.away;
  const dogGoals = isSX ? htScore.away : htScore.home;
  const minsLeft = 90 - (liveMin ?? 57);

  let primaryBet, primaryRate, secondaryBet, secondaryRate;
  if (favGoals > dogGoals) {
    primaryBet   = `1x2 <b>${side} WIN</b> live`;
    primaryRate  = isSX ? '91.5%' : '92.1%';
    secondaryBet = `2H Over 0.5`;
    secondaryRate = isSX ? '83.9%' : '84.4%';
  } else if (favGoals === 0 && dogGoals === 0) {
    primaryBet   = `1x2 <b>${side} WIN</b> live`;
    primaryRate  = isSX ? '56.1%' : '60.0%';
    secondaryBet = `2H Over 0.5`;
    secondaryRate = isSX ? '83.9%' : '84.4%';
  } else if (favGoals === dogGoals) {
    primaryBet   = `1x2 <b>${side} WIN</b> live`;
    primaryRate  = isSX ? '55.1%' : '57.0%';
    secondaryBet = `BTTS`;
    secondaryRate = isSX ? '51.1%' : '52.1%';
  } else {
    primaryBet   = `<b>BTTS</b> live`;
    primaryRate  = isSX ? '80.7%' : '82.9%';
    secondaryBet = `2H Over 0.5`;
    secondaryRate = isSX ? '83.9%' : '84.4%';
  }

  return buildMessage(
    isSX ? 'SX — No 2H goal yet' : 'SY — No 2H goal yet',
    match,
    `${liveMin ?? '~57'}'  ${match.score || htStr}  [HT ${htStr}]`,
    [
      `💰 <b>${primaryBet}</b>`,
      `📌 Check live odds  (${primaryRate} — ~${minsLeft} min left)`,
      `💰 <b>${secondaryBet}</b>`,
      `📌 Check live odds  (${secondaryRate})`,
    ],
  );
}

async function runStrategySXY(match, ctx) {
  const { matchId, label, tier, liveMin, isSXYEarly, isSXYMidH, isSXYHTStore, isSXYHTFire } = ctx;

  // ── Alert 1: early live (1–10') ──────────────────────────────────────────
  if (isSXYEarly) {
    const sd = detectSXYSignal(match);
    if (!sd) {
      // Diagnose which book/condition failed
      const pin  = match.odds;
      const b365 = match.bet365_odds;
      const sbo  = match.sbobet_odds;
      const pinOk  = pin  && pin.ah_ho  != null && pin.ah_hc  != null;
      const b365Ok = b365 && b365.ah_ho != null && b365.ah_hc != null;
      const sboOk  = sbo  && sbo.ah_ho  != null && sbo.ah_hc  != null;

      // Distinguish: not attached vs. attached but no AH odds
      const bookStatus = bk => !bk ? 'no_data' : (bk.ah_ho != null && bk.ah_hc != null ? 'ok' : 'no_ah');
      let reason = `pin=${bookStatus(pin)} b365=${bookStatus(b365)} sbo=${bookStatus(sbo)}`;

      // If Pinnacle has AH odds, diagnose further
      if (pinOk) {
        const ahHo = pin.ah_ho;
        const dir  = ahHo < -0.01 ? 1 : ahHo > 0.01 ? -1 : 0;
        if (dir === 0) {
          reason += ' | pick\'em (no fav side)';
        } else {
          const minS   = cfg.SXSY_MIN_STEAM;
          const isSX   = dir === 1;  // home fav
          const ps     = (pin.ah_ho - pin.ah_hc) * dir;
          if (ps < minS) {
            reason += ` | AH steam fail: pin_ah=${ps.toFixed(3)}`;
          } else if (pin.tl_c == null || pin.tl_o == null || pin.tl_c <= pin.tl_o) {
            reason += ` | TL not rising: pin_tl=${pin.tl_o}→${pin.tl_c}`;
          } else if (isSX) {
            // SX: need Pinnacle + any one other — diagnose why neither b365 nor sbo qualified
            const diagBook = (bk, name) => {
              if (!bk || bk.ah_ho == null || bk.ah_hc == null) return `${name}=no_ah`;
              const s = (bk.ah_ho - bk.ah_hc) * dir;
              if (s < minS) return `${name}_ah=${s.toFixed(3)}`;
              if (bk.tl_c == null || bk.tl_o == null || bk.tl_c <= bk.tl_o) return `${name}_tl=${bk.tl_o}→${bk.tl_c}`;
              return null;
            };
            const fails = [diagBook(b365, 'b365'), diagBook(sbo, 'sbo')].filter(Boolean);
            if (fails.length) reason += ` | neither b365/sbo qualified: ${fails.join(' ')}`;
          } else {
            // SY: all 3 required — report each failure
            const bs = b365Ok ? (b365.ah_ho - b365.ah_hc) * dir : null;
            const ss = sboOk  ? (sbo.ah_ho  - sbo.ah_hc)  * dir : null;
            const steamFail = [
              bs != null && bs < minS && `b365_ah=${bs.toFixed(3)}`,
              ss != null && ss < minS && `sbo_ah=${ss.toFixed(3)}`,
            ].filter(Boolean);
            if (steamFail.length) reason += ` | AH steam fail: ${steamFail.join(' ')}`;
            else {
              const tlFails = [
                b365Ok && (b365.tl_c == null || b365.tl_o == null || b365.tl_c <= b365.tl_o) && `b365_tl=${b365.tl_o}→${b365.tl_c}`,
                sboOk  && (sbo.tl_c  == null || sbo.tl_o  == null || sbo.tl_c  <= sbo.tl_o)  && `sbo_tl=${sbo.tl_o}→${sbo.tl_c}`,
              ].filter(Boolean);
              if (tlFails.length) reason += ` | TL not rising: ${tlFails.join(' ')}`;
            }
          }
        }
      }

      flogv(liveMin, label, 'SXY-A1', `SKIP: no signal (${reason})`);
    } else {
      const enabled = sd.type === 'SX' ? cfg.SX_ENABLED : cfg.SY_ENABLED;
      const tier_   = sd.type === 'SX' ? cfg.SX_TIER    : cfg.SY_TIER;
      if (!enabled) {
        flogv(liveMin, label, 'SXY-A1', `SKIP: ${sd.type} disabled`);
      } else if (!tierAllowed(tier, tier_)) {
        flogv(liveMin, label, 'SXY-A1', `SKIP: tier=${tier} not in ${tier_}`);
      } else {
        if (!sxyCandidates.has(matchId)) {
          sxyCandidates.set(matchId, { ...sd, storedAt: Date.now() });
          flogv(liveMin, label, 'SXY-A1', `stored candidate: type=${sd.type} books=${sd.confirmedBooks}/3`);
        }
        const key1 = `${matchId}:${sd.type.toLowerCase()}:1`;
        if (!sxyDedup.has(key1)) {
          const msg = sxyAlert1Format(match, sd, tier);
          await sendTelegram(msg);
          sxyDedup.mark(key1);
          flog(liveMin, label, `SXY-A1`, `ALERT: ${sd.type} ${sd.confirmedBooks}/3 books steam=${sd.pinSteam.toFixed(2)} tier=${tier}`);
        } else {
          flogv(liveMin, label, 'SXY-A1', 'SKIP: already notified');
        }
      }
    }
  }

  // ── Alert 2: 30' check — fav home not scored yet → Over 0.5 1H ─────────
  if (isSXYMidH) {
    const cand = sxyCandidates.get(matchId);
    if (!cand) { flogv(liveMin, label, 'SXY-A2', 'SKIP: no candidate stored (missed alert1 window?)'); }
    else {
      const enabled = cand.type === 'SX' ? cfg.SX_ENABLED : cfg.SY_ENABLED;
      const tier_   = cand.type === 'SX' ? cfg.SX_TIER    : cfg.SY_TIER;
      if (enabled && tierAllowed(tier, tier_)) {
        const key2 = `${matchId}:${cand.type.toLowerCase()}:2`;
        if (sxyDedup.has(key2)) {
          flogv(liveMin, label, 'SXY-A2', 'SKIP: already notified');
        } else {
          const score = parseScoreStr(match.score);
          // SX: fire if home fav hasn't scored yet (home=0); SY: still requires 0-0
          const favNotScored = score && (cand.type === 'SX' ? score.home === 0 : score.home === 0 && score.away === 0);
          if (favNotScored) {
            const msg = sxyAlert2Format(match, cand, tier, liveMin);
            await sendTelegram(msg);
            sxyDedup.mark(key2);
            flog(liveMin, label, 'SXY-A2', `ALERT: score=${match.score} fav_not_scored tier=${tier}`);
          } else {
            flogv(liveMin, label, 'SXY-A2', `SKIP: fav already scored (${match.score})`);
          }
        }
      }
    }
  }

  // ── Alert 3 — store HT score (44–52') ───────────────────────────────────
  if (isSXYHTStore) {
    const cand = sxyCandidates.get(matchId);
    if (cand && !cand.htScore) {
      const score = parseScoreStr(match.score);
      if (score) {
        cand.htScore = { home: score.home, away: score.away };
        flogv(liveMin, label, 'SXY-HT', `stored: HT=${score.home}-${score.away}`);
      }
    }
  }

  // ── Alert 3 — fire at 55–60' if no 2H goal yet ───────────────────────────
  if (isSXYHTFire) {
    const cand = sxyCandidates.get(matchId);
    if (!cand || !cand.htScore) {
      flogv(liveMin, label, 'SXY-A3', 'SKIP: no HT score stored');
    } else {
      const enabled = cand.type === 'SX' ? cfg.SX_ENABLED : cfg.SY_ENABLED;
      const tier_   = cand.type === 'SX' ? cfg.SX_TIER    : cfg.SY_TIER;
      if (enabled && tierAllowed(tier, tier_)) {
        const key3 = `${matchId}:${cand.type.toLowerCase()}:3`;
        if (sxyDedup.has(key3)) {
          flogv(liveMin, label, 'SXY-A3', 'SKIP: already notified');
        } else {
          const curScore = parseScoreStr(match.score);
          if (!curScore) { flogv(liveMin, label, 'SXY-A3', 'SKIP: no current score'); }
          else {
            const goals2H = (curScore.home + curScore.away) - (cand.htScore.home + cand.htScore.away);
            if (goals2H > 0) {
              flogv(liveMin, label, 'SXY-A3', `SKIP: ${goals2H} goal(s) already in 2H`);
            } else {
              const msg = sxyAlert3Format(match, cand, cand.htScore, tier, liveMin);
              await sendTelegram(msg);
              sxyDedup.mark(key3);
              flog(liveMin, label, 'SXY-A3', `ALERT: HT=${cand.htScore.home}-${cand.htScore.away} now=${curScore.home}-${curScore.away} tier=${tier}`);
            }
          }
        }
      }
    }
  }
}

// Cleanup expired SXY candidates (called once per scan)
function cleanupSxyCandidates() {
  const now = Date.now();
  for (const [id, c] of sxyCandidates) {
    if (now - c.storedAt > SXYC_TTL) sxyCandidates.delete(id);
  }
}

const MKT_KEYS = new Set(['ahCover', 'dogCover', 'overTL', 'underTL']);
const s6Dedup  = new Dedup(4 * 60 * 60 * 1000);

function getB365OddsForBet(betKey, b365, favSide) {
  if (!b365) return null;
  if (betKey === 'ahCover')  return favSide === 'HOME' ? b365.hoC : b365.aoC;
  if (betKey === 'dogCover') return favSide === 'HOME' ? b365.aoC : b365.hoC;
  if (betKey === 'overTL')   return b365.ovC ?? null;
  if (betKey === 'underTL')  return b365.unC ?? null;
  return null;
}

function s6Format(match, matchCfg, poolN, bets, b365, tier, minuteScore) {
  const { fav_line, fav_side } = matchCfg;
  const favTeam = fav_side === 'HOME' ? esc(match.home_team) : esc(match.away_team);
  const dogTeam = fav_side === 'HOME' ? esc(match.away_team) : esc(match.home_team);
  const betLines = bets.flatMap(b => {
    const b365Odds = getB365OddsForBet(b.k, b365, fav_side);
    const oddsStr  = b365Odds != null ? `@${b365Odds.toFixed(2)} (Bet365)` : `@${b.mkt_avg_odds} (Pinnacle avg)`;
    let betLabel;
    if (b.k === 'ahCover')  betLabel = `AH <b>${favTeam} −${Number(fav_line).toFixed(2)}</b>`;
    else if (b.k === 'dogCover') betLabel = `AH <b>${dogTeam} +${Number(fav_line).toFixed(2)}</b>`;
    else if (b.k === 'overTL')   betLabel = `Over ${b.avgTl != null ? b.avgTl.toFixed(2) : fav_line} (TL)`;
    else if (b.k === 'underTL')  betLabel = `Under ${b.avgTl != null ? b.avgTl.toFixed(2) : fav_line} (TL)`;
    else betLabel = b.label;
    return [`💰 <b>${betLabel}</b>`, `📌 Min odds: ${oddsStr}`];
  });
  return buildMessage('S6 — Market Edge', match, minuteScore, betLines);
}

async function runStrategy6(match, ctx) {
  const { matchId, label, tier, liveMin, minsToKickoff, isMktEdge } = ctx;

  if (!cfg.S6_ENABLED) { flogv(liveMin, label, 'S6', 'SKIP: disabled'); return; }
  if (!tierAllowed(tier, cfg.S6_TIER)) { flogv(liveMin, label, 'S6', `SKIP: tier=${tier} not in ${cfg.S6_TIER}`); return; }
  if (!isMktEdge) { flogv(liveMin, label, 'S6', `SKIP: not in mkt window (min=${liveMin} needs 1-${cfg.S6_WINDOW_MINUTES})`); return; }
  if (!_dbAll || !_dbAll.length) { flog(liveMin, label, 'S6', 'SKIP: DB empty'); return; }
  if (!match.odds) { flogv(liveMin, label, 'S6', 'SKIP: no odds'); return; }

  const matchCfg = buildCfgFromMatch(match.odds, { LINE_MOVE_ON: true, TL_MOVE_ON: true });
  if (!matchCfg) { flogv(liveMin, label, 'S6', 'SKIP: odds incomplete (buildCfg returned null)'); return; }

  const { signals } = matchCfg;
  const hasMovement =
    (signals.lineMove !== 'STABLE' && signals.lineMove !== 'UNKNOWN') ||
    (signals.tlMove   !== 'STABLE' && signals.tlMove   !== 'UNKNOWN');

  if (!hasMovement) {
    flogv(liveMin, label, 'S6', `SKIP: no movement (lm=${signals.lineMove} tlm=${signals.tlMove})`);
    return;
  }

  const cfgRows = applyConfig(_dbAll, matchCfg);
  const blRows  = applyBaselineConfig(_dbAll, matchCfg);
  const blSide  = blRows.filter(r => r.fav_side === matchCfg.fav_side);
  const bets    = scoreBets(cfgRows, blRows, blSide, cfg.MKT_EDGE_MIN_N);

  const qualifying = bets.filter(b =>
    MKT_KEYS.has(b.k) && b.mkt_edge != null && b.mkt_edge >= cfg.MKT_EDGE_THRESH,
  );

  if (!qualifying.length) {
    const mktBets = bets.filter(b => MKT_KEYS.has(b.k));
    const best = mktBets.length ? `best_edge=${Math.max(...mktBets.map(b => b.mkt_edge ?? -999)).toFixed(1)}pp` : 'no_mkt_bets';
    flogv(liveMin, label, 'S6', `SKIP: no qualifying bets (pool=${cfgRows.length} ${best} thresh=${cfg.MKT_EDGE_THRESH}pp)`);
    return;
  }

  const mktKey = `${matchId}:mktedge`;
  if (s6Dedup.has(mktKey)) {
    flogv(liveMin, label, 'S6', 'SKIP: already notified');
    return;
  }

  const b365 = await fetchBet365Data(matchId);

  // Drop bets where Bet365 odds are available but below the historical Pinnacle avg.
  const toFire = qualifying.filter(b => {
    const b365Odds = getB365OddsForBet(b.k, b365, matchCfg.fav_side);
    return b365Odds == null || b365Odds > b.mkt_avg_odds;
  });

  if (!toFire.length) {
    flogv(liveMin, label, 'S6', `SKIP: all qualifying bets below B365 threshold (b365=${b365 ? 'ok' : 'null'})`);
    return;
  }

  const score = match.score || '0-0';
  const msg = s6Format(match, matchCfg, cfgRows.length, toFire, b365, tier, `${liveMin}'  ${score}`);
  await sendTelegram(msg);
  s6Dedup.mark(mktKey);
  flog(liveMin, label, 'S6', `ALERT: bets=${toFire.map(b => b.k).join(',')} pool=${cfgRows.length} tier=${tier}`);
}

// ── Strategy 7: Bet365 vs Pinnacle AH line gap ───────────────────────────────
// Fires in the first 1–5 live minutes when Bet365 offers a more generous AH
// handicap than Pinnacle. Pinnacle's line is the sharp consensus; if Bet365
// hasn't moved, the side getting the better number at Bet365 is +EV.
//
// Backtest (Jan–Mar 2025, both HOME and AWAY directions):
//   HC diff 0.25–0.49 → N=6,989  hit=52.3%  ROI=+2.6%  BE odds=1.91  min=1.95
//   HC diff 0.50–0.74 → N=331    hit=53.2%  ROI=+4.7%  BE odds=1.88  min=1.92
//   HC diff ≥ 0.75    → N=78     hit=59.0%  ROI=+17.2% BE odds=1.70  min=1.73
const s7Dedup = new Dedup(3 * 60 * 60 * 1000);

// Returns minimum acceptable Bet365 odds for a given HC diff (break-even + 2% margin).
// Derived from backtest hit rates per tier.
function s7MinOdds(absDiff) {
  if (absDiff >= 0.75) return 1.73;  // hit 59.0% → BE 1.696 → +2% = 1.73
  if (absDiff >= 0.50) return 1.92;  // hit 53.2% → BE 1.881 → +2% = 1.92
  return 1.95;                        // hit 52.3% → BE 1.912 → +2% = 1.95
}

function s7Format(match, tier, minuteScore, betTeam, b365Hc, b365Odds, pinHc, absDiff, minOdds) {
  const pinStr    = pinHc >= 0 ? `+${pinHc.toFixed(2)}` : pinHc.toFixed(2);
  const b365HcStr = b365Hc >= 0 ? `+${b365Hc.toFixed(2)}` : b365Hc.toFixed(2);
  const strength  = absDiff >= 0.75 ? '🔥 STRONG' : absDiff >= 0.50 ? '⚡ SOLID' : 'MILD';
  return buildMessage('S7 — Bet365 Line Gap', match, minuteScore, [
    `💰 <b>AH ${esc(betTeam)}  ${b365HcStr}  at Bet365</b>  [${strength} — gap +${absDiff.toFixed(2)} vs Pinnacle ${pinStr}]`,
    `📌 Min odds: @${minOdds.toFixed(2)}  (Bet365 current: ${b365Odds.toFixed(2)})`,
  ]);
}

async function runStrategy7(match, ctx) {
  const { matchId, label, tier, liveMin, isLive } = ctx;

  if (!cfg.S7_ENABLED) { flogv(liveMin, label, 'S7', 'SKIP: disabled'); return; }
  if (!tierAllowed(tier, cfg.S7_TIER)) { flogv(liveMin, label, 'S7', `SKIP: tier=${tier} not in ${cfg.S7_TIER}`); return; }
  if (!isLive) { flogv(liveMin, label, 'S7', `SKIP: not in live window (min=${liveMin} needs ${cfg.ALERT_MIN_MINUTE}-${cfg.ALERT_MAX_MINUTE})`); return; }
  if (!match.odds) { flogv(liveMin, label, 'S7', 'SKIP: no odds'); return; }

  const pinHc = match.odds.ah_hc;
  if (pinHc == null) { flogv(liveMin, label, 'S7', 'SKIP: ah_hc missing in Pinnacle odds'); return; }

  const b365 = await fetchBet365Data(matchId);
  if (!b365 || b365.ahHc == null) {
    flogv(liveMin, label, 'S7', `SKIP: no B365 data (matchId=${matchId})`);
    return;
  }

  const b365Hc = b365.ahHc;
  const hcDiff = b365Hc - pinHc;   // positive = B365 more generous to HOME bettor

  let betSide, betTeam, b365Odds;

  if (hcDiff >= cfg.S7_MIN_HC_DIFF) {
    betSide  = 'HOME';
    betTeam  = match.home_team;
    b365Odds = b365.hoC;
  } else if (hcDiff <= -cfg.S7_MIN_HC_DIFF) {
    betSide  = 'AWAY';
    betTeam  = match.away_team;
    b365Odds = b365.aoC;
  } else {
    flogv(liveMin, label, 'S7', `SKIP: hcDiff=${hcDiff.toFixed(2)} below ±${cfg.S7_MIN_HC_DIFF} (pin=${pinHc.toFixed(2)} b365=${b365Hc.toFixed(2)})`);
    return;
  }

  const absDiff = Math.abs(hcDiff);
  const minOdds = s7MinOdds(absDiff);

  // Only fire if Bet365 odds are confirmed at or above the break-even minimum
  if (b365Odds == null || b365Odds < minOdds) {
    flogv(liveMin, label, 'S7', `SKIP: b365Odds=${b365Odds != null ? b365Odds.toFixed(2) : 'n/a'} below minOdds=${minOdds.toFixed(2)} (diff=${absDiff.toFixed(2)})`);
    return;
  }

  const dedupKey = `${matchId}:s7:${betSide}`;
  if (s7Dedup.has(dedupKey)) {
    flogv(liveMin, label, 'S7', 'SKIP: already notified');
    return;
  }

  const msg = s7Format(match, tier, `${liveMin}'  ${match.score || '0-0'}`, betTeam, b365Hc, b365Odds, pinHc, absDiff, minOdds);
  await sendTelegram(msg);
  s7Dedup.mark(dedupKey);
  flog(liveMin, label, 'S7', `ALERT: side=${betSide} pin=${pinHc.toFixed(2)} b365=${b365Hc.toFixed(2)} diff=${absDiff.toFixed(2)} odds=${b365Odds != null ? b365Odds.toFixed(2) : 'n/a'} min=${minOdds.toFixed(2)} tier=${tier}`);
}

// ── Strategy S8: Pinnacle Cross – High Volume → Over 2.5 FT at 60' ──────────
// Pre-match Pinnacle-only signal:
//   1. AH closing home >= -1  (high-volume: home not a heavy favourite)
//   2. AH home steam >= 0.50  (ah_ho − ah_hc ≥ 0.50)
//   3. TL moved up >= 0.25    (market pricing in goals)
// Fires at ~60' when Over 2.5 FT is still unsettled (total goals < 3).

const s8Dedup = new Dedup(4 * 60 * 60 * 1000);

function detectS8Signal(odds) {
  if (!odds) return null;
  const { ah_hc: ahHc, ah_ho: ahHo, tl_c: tlC, tl_o: tlO } = odds;
  if (ahHc == null || ahHo == null) return null;
  if (ahHc > cfg.S8_AH_HC_MAX) return null;              // home closing must be <= -1 (home at least 1-goal fav)
  const homeSteam = ahHo - ahHc;
  if (homeSteam < cfg.S8_MIN_HOME_STEAM) return null;     // home steam >= 0.50
  if (tlC == null || tlO == null) return null;
  const tlMove = tlC - tlO;
  if (tlMove < cfg.S8_MIN_TL_MOVE) return null;           // TL up >= 0.25
  return { ahHc, ahHo, homeSteam, tlC, tlO, tlMove };
}

function s8Format(match, sd, liveMin) {
  const fmt      = v => v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
  const minsLeft = 90 - liveMin;
  return buildMessage(
    'S8 — High Volume Over 2.5',
    match,
    `${liveMin}'  ${match.score || '?-?'}`,
    [
      `💰 <b>Over 2.5 FT (in-play)</b>`,
      `📌 Check live odds  (~${minsLeft} min left, score still unsettled)`,
      `📌 AH home: ${fmt(sd.ahHo)} → ${fmt(sd.ahHc)}  (steam +${sd.homeSteam.toFixed(2)})`,
      `📌 TL: ${sd.tlO.toFixed(2)} → ${sd.tlC.toFixed(2)}  (↑${sd.tlMove.toFixed(2)})`,
    ],
  );
}

async function runStrategy8(match, ctx) {
  const { matchId, label, tier, liveMin, isS8Fire } = ctx;

  if (!cfg.S8_ENABLED) { flogv(liveMin, label, 'S8', 'SKIP: disabled'); return; }
  if (!tierAllowed(tier, cfg.S8_TIER)) { flogv(liveMin, label, 'S8', `SKIP: tier=${tier} not in ${cfg.S8_TIER}`); return; }
  if (!isS8Fire) { flogv(liveMin, label, 'S8', `SKIP: not in fire window (min=${liveMin} needs ${cfg.S8_FIRE_MIN}-${cfg.S8_FIRE_MAX})`); return; }
  if (!match.odds) { flogv(liveMin, label, 'S8', 'SKIP: no odds'); return; }

  const sd = detectS8Signal(match.odds);
  if (!sd) {
    const ahHc       = match.odds.ah_hc ?? '?';
    const homeSteam  = ((match.odds.ah_ho ?? 0) - (match.odds.ah_hc ?? 0)).toFixed(2);
    const tlMove     = ((match.odds.tl_c  ?? 0) - (match.odds.tl_o  ?? 0)).toFixed(2);
    flogv(liveMin, label, 'S8', `SKIP: no signal (ahHc=${ahHc} homeSteam=${homeSteam} tlMove=${tlMove})`);
    return;
  }

  const score = parseScoreStr(match.score);
  if (!score) { flogv(liveMin, label, 'S8', 'SKIP: no score'); return; }

  const totalGoals = score.home + score.away;
  if (totalGoals >= 3) {
    flogv(liveMin, label, 'S8', `SKIP: Over 2.5 already settled (${match.score})`);
    return;
  }

  const dedupKey = `${matchId}:s8`;
  if (s8Dedup.has(dedupKey)) { flogv(liveMin, label, 'S8', 'SKIP: already notified'); return; }

  const msg = s8Format(match, sd, liveMin);
  await sendTelegram(msg);
  s8Dedup.mark(dedupKey);
  flog(liveMin, label, 'S8', `ALERT: score=${match.score} goals=${totalGoals} ahHc=${sd.ahHc.toFixed(2)} steam=${sd.homeSteam.toFixed(2)} tlMove=${sd.tlMove.toFixed(2)} tier=${tier}`);
}

// ── Strategy S9: Sbobet Cross → Over 2.5 FT at 60' ──────────────────────────
// Sbobet-only signal — line stable, pure odds compression:
//   1. AH home closing <= -1
//   2. AH line stable (no handicap move)
//   3. AH home odds dropped >= 0.20
//   4. Total Line stable
//   5. Over odds dropped >= 0.15
// Fires at ~60' when Over 2.5 FT is still unsettled (total goals < 3).

const s9Dedup = new Dedup(4 * 60 * 60 * 1000);

function detectS9Signal(sbo) {
  if (!sbo) return null;
  const { ah_hc: ahHc, ah_ho: ahHo, ho_c: hoC, ho_o: hoO,
          tl_c: tlC, tl_o: tlO, ov_c: ovC, ov_o: ovO } = sbo;

  if (ahHc == null || ahHo == null) return null;
  if (ahHc > cfg.S9_AH_HC_MAX) return null;                           // home closing must be <= -1

  const ahLineMove = Math.abs(ahHc - ahHo);
  if (ahLineMove > cfg.S9_LINE_STABLE_THRESH) return null;            // AH line must be stable

  if (hoC == null || hoO == null) return null;
  const hoOddsDrop = hoO - hoC;
  if (hoOddsDrop < cfg.S9_MIN_HO_ODDS_DROP) return null;              // home odds must have dropped >= 0.20

  if (tlC == null || tlO == null) return null;
  const tlMove = Math.abs(tlC - tlO);
  if (tlMove > cfg.S9_TL_STABLE_THRESH) return null;                  // TL must be stable

  if (ovC == null || ovO == null) return null;
  const ovOddsDrop = ovO - ovC;
  if (ovOddsDrop < cfg.S9_MIN_OV_ODDS_DROP) return null;              // over odds must have dropped >= 0.15

  return { ahHc, ahHo, ahLineMove, hoC, hoO, hoOddsDrop,
           tlC, tlO, ovC, ovO, ovOddsDrop };
}

function s9Format(match, sd, liveMin) {
  const fmt      = v => v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
  const minsLeft = 90 - liveMin;
  return buildMessage(
    'S9 — Sbobet Cross Over 2.5',
    match,
    `${liveMin}'  ${match.score || '?-?'}`,
    [
      `💰 <b>Over 2.5 FT (in-play)</b>`,
      `📌 Check live odds  (~${minsLeft} min left, score still unsettled)`,
      `📌 AH home close: ${fmt(sd.ahHc)}  (line stable, move: ${sd.ahLineMove.toFixed(2)})`,
      `📌 Home odds: ${sd.hoO.toFixed(2)} → ${sd.hoC.toFixed(2)}  (↓${sd.hoOddsDrop.toFixed(2)})`,
      `📌 Over odds: ${sd.ovO.toFixed(2)} → ${sd.ovC.toFixed(2)}  (↓${sd.ovOddsDrop.toFixed(2)})`,
    ],
  );
}

async function runStrategy9(match, ctx) {
  const { matchId, label, tier, liveMin, isS9Fire } = ctx;

  if (!cfg.S9_ENABLED) { flogv(liveMin, label, 'S9', 'SKIP: disabled'); return; }
  if (!tierAllowed(tier, cfg.S9_TIER)) { flogv(liveMin, label, 'S9', `SKIP: tier=${tier} not in ${cfg.S9_TIER}`); return; }
  if (!isS9Fire) { flogv(liveMin, label, 'S9', `SKIP: not in fire window (min=${liveMin} needs ${cfg.S9_FIRE_MIN}-${cfg.S9_FIRE_MAX})`); return; }

  const sbo = match.sbobet_odds;
  if (!sbo) { flogv(liveMin, label, 'S9', 'SKIP: no Sbobet odds'); return; }

  const sd = detectS9Signal(sbo);
  if (!sd) {
    const ahHc      = sbo.ah_hc ?? '?';
    const ahLine    = Math.abs((sbo.ah_hc ?? 0) - (sbo.ah_ho ?? 0)).toFixed(2);
    const hoOdds    = ((sbo.ho_o ?? 0) - (sbo.ho_c ?? 0)).toFixed(2);
    const tlLine    = Math.abs((sbo.tl_c ?? 0) - (sbo.tl_o ?? 0)).toFixed(2);
    const ovOdds    = ((sbo.ov_o ?? 0) - (sbo.ov_c ?? 0)).toFixed(2);
    flogv(liveMin, label, 'S9', `SKIP: no signal (ahHc=${ahHc} ahLine=${ahLine} hoOddsDrop=${hoOdds} tlMove=${tlLine} ovOddsDrop=${ovOdds})`);
    return;
  }

  const score = parseScoreStr(match.score);
  if (!score) { flogv(liveMin, label, 'S9', 'SKIP: no score'); return; }

  const totalGoals = score.home + score.away;
  if (totalGoals >= 3) {
    flogv(liveMin, label, 'S9', `SKIP: Over 2.5 already settled (${match.score})`);
    return;
  }

  const dedupKey = `${matchId}:s9`;
  if (s9Dedup.has(dedupKey)) { flogv(liveMin, label, 'S9', 'SKIP: already notified'); return; }

  const msg = s9Format(match, sd, liveMin);
  await sendTelegram(msg);
  s9Dedup.mark(dedupKey);
  flog(liveMin, label, 'S9', `ALERT: score=${match.score} goals=${totalGoals} ahHc=${sd.ahHc.toFixed(2)} hoOddsDrop=${sd.hoOddsDrop.toFixed(2)} ovOddsDrop=${sd.ovOddsDrop.toFixed(2)} tier=${tier}`);
}

// ── Strategy S10: Sbobet Away Steam → Away to score (live at ~20') ───────────
// Sbobet-only signal — line stable, home odds drifting up (money going away):
//   1. AH home closing in [−0.25, +0.50]
//   2. AH line stable
//   3. AH home odds rose >= 0.35  (ho_c − ho_o ≥ threshold)
//   4. TL stable
// Fires at ~20' 1H if away team hasn't scored yet.

const s10Dedup = new Dedup(4 * 60 * 60 * 1000);

function detectS10Signal(sbo) {
  if (!sbo) return null;
  const { ah_hc: ahHc, ah_ho: ahHo, ho_c: hoC, ho_o: hoO,
          tl_c: tlC, tl_o: tlO } = sbo;

  if (ahHc == null || ahHo == null) return null;
  if (ahHc < cfg.S10_AH_HC_MIN || ahHc > cfg.S10_AH_HC_MAX) return null;  // home closing in [−0.25, +0.50]

  const ahLineMove = Math.abs(ahHc - ahHo);
  if (ahLineMove > cfg.S10_LINE_STABLE_THRESH) return null;                // AH line must be stable

  if (hoC == null || hoO == null) return null;
  const hoOddsRise = hoC - hoO;
  if (hoOddsRise < cfg.S10_MIN_HO_ODDS_RISE) return null;                  // home odds must have risen >= 0.35

  if (tlC == null || tlO == null) return null;
  const tlMove = Math.abs(tlC - tlO);
  if (tlMove > cfg.S10_TL_STABLE_THRESH) return null;                      // TL must be stable

  return { ahHc, ahHo, ahLineMove, hoC, hoO, hoOddsRise, tlC, tlO };
}

function s10Format(match, sd, liveMin) {
  const fmt      = v => v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
  const minsLeft1H = 45 - liveMin;
  return buildMessage(
    'S10 — Sbobet Away Steam',
    match,
    `${liveMin}'  ${match.score || '?-?'}`,
    [
      `💰 <b>Away to score (live)</b>`,
      `📌 Check live odds  (~${minsLeft1H} min to HT, then 2H)`,
      `📌 AH home close: ${fmt(sd.ahHc)}  (line stable, move: ${sd.ahLineMove.toFixed(2)})`,
      `📌 Home odds: ${sd.hoO.toFixed(2)} → ${sd.hoC.toFixed(2)}  (↑${sd.hoOddsRise.toFixed(2)} — away backed)`,
    ],
  );
}

async function runStrategy10(match, ctx) {
  const { matchId, label, tier, liveMin, isS10Fire } = ctx;

  if (!cfg.S10_ENABLED) { flogv(liveMin, label, 'S10', 'SKIP: disabled'); return; }
  if (!tierAllowed(tier, cfg.S10_TIER)) { flogv(liveMin, label, 'S10', `SKIP: tier=${tier} not in ${cfg.S10_TIER}`); return; }
  if (!isS10Fire) { flogv(liveMin, label, 'S10', `SKIP: not in fire window (min=${liveMin} needs ${cfg.S10_FIRE_MIN}-${cfg.S10_FIRE_MAX})`); return; }

  const sbo = match.sbobet_odds;
  if (!sbo) { flogv(liveMin, label, 'S10', 'SKIP: no Sbobet odds'); return; }

  const sd = detectS10Signal(sbo);
  if (!sd) {
    const ahHc     = sbo.ah_hc ?? '?';
    const ahLine   = Math.abs((sbo.ah_hc ?? 0) - (sbo.ah_ho ?? 0)).toFixed(2);
    const hoRise   = ((sbo.ho_c ?? 0) - (sbo.ho_o ?? 0)).toFixed(2);
    const tlLine   = Math.abs((sbo.tl_c ?? 0) - (sbo.tl_o ?? 0)).toFixed(2);
    flogv(liveMin, label, 'S10', `SKIP: no signal (ahHc=${ahHc} ahLine=${ahLine} hoOddsRise=${hoRise} tlMove=${tlLine})`);
    return;
  }

  const score = parseScoreStr(match.score);
  if (!score) { flogv(liveMin, label, 'S10', 'SKIP: no score'); return; }

  if (score.away >= 1) {
    flogv(liveMin, label, 'S10', `SKIP: away already scored (${match.score})`);
    return;
  }

  const dedupKey = `${matchId}:s10`;
  if (s10Dedup.has(dedupKey)) { flogv(liveMin, label, 'S10', 'SKIP: already notified'); return; }

  const msg = s10Format(match, sd, liveMin);
  await sendTelegram(msg);
  s10Dedup.mark(dedupKey);
  flog(liveMin, label, 'S10', `ALERT: score=${match.score} ahHc=${sd.ahHc.toFixed(2)} hoOddsRise=${sd.hoOddsRise.toFixed(2)} tlMove=${(Math.abs(sd.tlC - sd.tlO)).toFixed(2)} tier=${tier}`);
}

// ── Strategy S11: Pinnacle + Sbobet Home → Home to score 2H (at HT) ─────────
// Cross-book: Pinnacle line steamed home + Sbobet line stable but odds confirm home steam.
// Fires at HT (44–52') when home hasn't scored yet → bet home scores in 2H.

const s11Dedup = new Dedup(4 * 60 * 60 * 1000);

function detectS11Signal(pin, sbo) {
  if (!pin || !sbo) return null;

  // ── Pinnacle checks ──────────────────────────────────────────────────────
  const { ah_hc: pinAhHc, ah_ho: pinAhHo } = pin;
  if (pinAhHc == null || pinAhHo == null) return null;
  if (pinAhHc > cfg.S11_PIN_AH_HC_MAX) return null;              // Pinnacle home closing <= −0.75
  const pinHomeSteam = pinAhHo - pinAhHc;
  if (pinHomeSteam < cfg.S11_PIN_MIN_HOME_STEAM) return null;    // Pinnacle home steam >= 0.50

  // ── Sbobet checks ────────────────────────────────────────────────────────
  const { ah_hc: sboAhHc, ah_ho: sboAhHo, ho_c: sboHoC, ho_o: sboHoO } = sbo;
  if (sboAhHc == null || sboAhHo == null) return null;
  const sboLineMove = Math.abs(sboAhHc - sboAhHo);
  if (sboLineMove > cfg.S11_SBO_LINE_STABLE_THRESH) return null; // Sbobet AH line must be stable
  if (sboHoC == null || sboHoO == null) return null;
  const sboHoOddsSteam = sboHoO - sboHoC;
  if (sboHoOddsSteam < cfg.S11_SBO_MIN_HO_ODDS_STEAM) return null; // Sbobet home odds steam >= 0.20

  return { pinAhHc, pinAhHo, pinHomeSteam,
           sboAhHc, sboAhHo, sboLineMove, sboHoC, sboHoO, sboHoOddsSteam };
}

function s11Format(match, sd, liveMin, htScore) {
  const fmt    = v => v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
  const htStr  = htScore ? `${htScore.home}-${htScore.away}` : match.score || '?-?';
  return buildMessage(
    'S11 — Pin+Sbo Home 2H',
    match,
    `HT  ${htStr}`,
    [
      `💰 <b>Home to score in 2H (live)</b>`,
      `📌 Home yet to score — bet now at HT`,
      `📌 Pinnacle AH home: ${fmt(sd.pinAhHo)} → ${fmt(sd.pinAhHc)}  (steam +${sd.pinHomeSteam.toFixed(2)})`,
      `📌 Sbobet  AH home: ${fmt(sd.sboAhHc)}  (line stable)  ·  odds: ${sd.sboHoO.toFixed(2)} → ${sd.sboHoC.toFixed(2)}  (↓${sd.sboHoOddsSteam.toFixed(2)})`,
    ],
  );
}

async function runStrategy11(match, ctx) {
  const { matchId, label, tier, liveMin, isS11Fire } = ctx;

  if (!cfg.S11_ENABLED) { flogv(liveMin, label, 'S11', 'SKIP: disabled'); return; }
  if (!tierAllowed(tier, cfg.S11_TIER)) { flogv(liveMin, label, 'S11', `SKIP: tier=${tier} not in ${cfg.S11_TIER}`); return; }
  if (!isS11Fire) { flogv(liveMin, label, 'S11', `SKIP: not in HT window (min=${liveMin} needs ${cfg.S11_FIRE_MIN}-${cfg.S11_FIRE_MAX})`); return; }

  const pin = match.odds;
  const sbo = match.sbobet_odds;
  if (!pin) { flogv(liveMin, label, 'S11', 'SKIP: no Pinnacle odds'); return; }
  if (!sbo) { flogv(liveMin, label, 'S11', 'SKIP: no Sbobet odds'); return; }

  const sd = detectS11Signal(pin, sbo);
  if (!sd) {
    const pinAhHc  = pin.ah_hc ?? '?';
    const pinSteam = ((pin.ah_ho ?? 0) - (pin.ah_hc ?? 0)).toFixed(2);
    const sboLine  = Math.abs((sbo.ah_hc ?? 0) - (sbo.ah_ho ?? 0)).toFixed(2);
    const sboOdds  = ((sbo.ho_o ?? 0) - (sbo.ho_c ?? 0)).toFixed(2);
    flogv(liveMin, label, 'S11', `SKIP: no signal (pinAhHc=${pinAhHc} pinSteam=${pinSteam} sboLine=${sboLine} sboOddsSteam=${sboOdds})`);
    return;
  }

  const score = parseScoreStr(match.score);
  if (!score) { flogv(liveMin, label, 'S11', 'SKIP: no score'); return; }

  if (score.home >= 1) {
    flogv(liveMin, label, 'S11', `SKIP: home already scored (${match.score})`);
    return;
  }

  const dedupKey = `${matchId}:s11`;
  if (s11Dedup.has(dedupKey)) { flogv(liveMin, label, 'S11', 'SKIP: already notified'); return; }

  const msg = s11Format(match, sd, liveMin, score);
  await sendTelegram(msg);
  s11Dedup.mark(dedupKey);
  flog(liveMin, label, 'S11', `ALERT: score=${match.score} pinSteam=${sd.pinHomeSteam.toFixed(2)} sboOdds=${sd.sboHoOddsSteam.toFixed(2)} tier=${tier}`);
}

// ── Strategy S12: Pinnacle Fav Steam → Over 0.5 remaining at 65' ─────────────
// Pre-match Pinnacle signal: line deepened toward fav + fav odds shortened.
// Fires at ~65' when fav is Drawing or Losing → bet Over 0.5 remaining goals.

const s12Dedup = new Dedup(4 * 60 * 60 * 1000);

function detectS12Signal(odds) {
  if (!odds) return null;
  const { ah_hc, ah_ho, ho_c, ho_o, ao_c, ao_o } = odds;
  if (ah_hc == null || ah_ho == null) return null;

  let favSide, favOc, favOo;
  if (ah_hc < -0.01) {
    favSide = 'HOME'; favOc = ho_c; favOo = ho_o;
  } else if (ah_hc > 0.01) {
    favSide = 'AWAY'; favOc = ao_c; favOo = ao_o;
  } else {
    return null; // pick'em — skip
  }
  if (favOc == null || favOo == null) return null;

  const lineSteam = Math.abs(ah_hc) - Math.abs(ah_ho);
  if (lineSteam < cfg.S12_MIN_LINE_STEAM) return null;

  const oddsSteam = favOo - favOc;
  if (oddsSteam < cfg.S12_MIN_ODDS_STEAM) return null;

  return { favSide, ah_hc, ah_ho, lineSteam, favOc, favOo, oddsSteam };
}

async function runStrategy12(match, ctx) {
  const { matchId, label, tier, liveMin, isS12Fire } = ctx;

  if (!cfg.S12_ENABLED)            { flogv(liveMin, label, 'S12', 'SKIP: disabled'); return; }
  if (!tierAllowed(tier, cfg.S12_TIER)) { flogv(liveMin, label, 'S12', `SKIP: tier=${tier} not in ${cfg.S12_TIER}`); return; }
  if (!isS12Fire)                  { flogv(liveMin, label, 'S12', `SKIP: not in fire window (min=${liveMin} needs ${cfg.S12_FIRE_MIN}-${cfg.S12_FIRE_MAX})`); return; }
  if (!match.odds)                 { flogv(liveMin, label, 'S12', 'SKIP: no odds'); return; }

  const sd = detectS12Signal(match.odds);
  if (!sd) {
    const ahHc = match.odds.ah_hc ?? '?';
    const ls   = (Math.abs(match.odds.ah_hc ?? 0) - Math.abs(match.odds.ah_ho ?? 0)).toFixed(2);
    flogv(liveMin, label, 'S12', `SKIP: no signal (ahHc=${ahHc} lineSteam=${ls})`);
    return;
  }

  const score = parseScoreStr(match.score);
  if (!score) { flogv(liveMin, label, 'S12', 'SKIP: no score'); return; }

  const favGoals = sd.favSide === 'HOME' ? score.home : score.away;
  const dogGoals = sd.favSide === 'HOME' ? score.away : score.home;
  if (favGoals > dogGoals) { flogv(liveMin, label, 'S12', `SKIP: fav winning (${match.score})`); return; }

  const dedupKey = `${matchId}:s12`;
  if (s12Dedup.has(dedupKey)) { flogv(liveMin, label, 'S12', 'SKIP: already notified'); return; }

  const favTeam  = sd.favSide === 'HOME' ? match.home_team : match.away_team;
  const state    = favGoals === dogGoals ? 'DRAW' : 'LOSING';
  const minsLeft = 90 - liveMin;
  const fmt      = v => v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2);

  const msg = buildMessage(
    'S12 — Fav Steam → Over 0.5 remaining',
    match,
    `${liveMin}'  ${match.score || '?-?'}  (${esc(favTeam)} is <b>${state}</b>)`,
    [
      `💰 <b>Over 0.5 goals remaining</b>  (~${minsLeft} min left)`,
      `📌 Pinnacle AH: ${fmt(sd.ah_ho)} → ${fmt(sd.ah_hc)}  (line +${sd.lineSteam.toFixed(2)})`,
      `📌 Fav odds: ${sd.favOo.toFixed(2)} → ${sd.favOc.toFixed(2)}  (↓${sd.oddsSteam.toFixed(2)})`,
    ],
  );

  await sendTelegram(msg);
  s12Dedup.mark(dedupKey);
  flog(liveMin, label, 'S12', `ALERT: ${state} score=${match.score} lineSteam=${sd.lineSteam.toFixed(2)} oddsSteam=${sd.oddsSteam.toFixed(2)} tier=${tier}`);
}

// ── Hash-failure alert (once per failed hash value) ──────────────────────────
const _hashAlerted = new Set();
async function notifyHashFailed(bookmaker, shortHash) {
  const key = `${bookmaker}:${shortHash}`;
  if (_hashAlerted.has(key)) return;
  _hashAlerted.add(key);
  const msg = `⚠️ <b>${esc(bookmaker)} hash invalid</b>\n\nThe bookmaker hash <code>${esc(shortHash)}…</code> returned 404.\nUpdate <code>${esc(bookmaker === 'Pinnacle' ? 'PINNACLE_HASH' : 'BET365_HASH')}</code> in <code>livescore.js</code>.`;
  console.log(`Hash alert: ${bookmaker} hash ${shortHash} is invalid — sending Telegram notification`);
  await sendTelegram(msg);
}

// ── Match fetcher (live + upcoming) ──────────────────────────────────────────
async function fetchMatches() {
  let liveMatches;
  let nextMatches = [];
  let pinnacleHashFailed = false;
  let bet365HashFailed   = false;
  let sbobetHashFailed   = false;
  let pinnacleHash = '????????';
  let bet365Hash   = '????????';
  let sbobetHash   = '????????';

  if (cfg.DATA_URL) {
    const url  = `${cfg.DATA_URL.replace(/\/$/, '')}/api/livescore`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Cloudflare livescore returned HTTP ${resp.status}`);
    const data = await resp.json();
    liveMatches = data.matches      || [];
    nextMatches = data.next_matches || [];
    if (nextMatches.length === 0) {
      // try {
      //   const r = await fetchNextMatchesAllDays(cfg.SN_MAX_DAYS);
      //   nextMatches        = r.matches;
      //   pinnacleHashFailed = pinnacleHashFailed || r.pinnacleHashFailed;
      //   bet365HashFailed   = bet365HashFailed   || r.bet365HashFailed;
      //   if (r.pinnacleHash) pinnacleHash = r.pinnacleHash;
      //   if (r.bet365Hash)   bet365Hash   = r.bet365Hash;
      // } catch (e) { console.error(`NextGame fetch failed: ${e.message}`); }
    }
  } else {
    const liveResult = await fetchLiveMatches();
    liveMatches        = liveResult.matches;
    pinnacleHashFailed = liveResult.pinnacleHashFailed;
    bet365HashFailed   = liveResult.bet365HashFailed   || false;
    sbobetHashFailed   = liveResult.sbobetHashFailed   || false;
    if (liveResult.pinnacleHash) pinnacleHash = liveResult.pinnacleHash;
    if (liveResult.bet365Hash)   bet365Hash   = liveResult.bet365Hash;
    if (liveResult.sbobetHash)   sbobetHash   = liveResult.sbobetHash;
    // try {
    //   const nextResult = await fetchNextMatchesAllDays(cfg.SN_MAX_DAYS);
    //   nextMatches        = nextResult.matches;
    //   pinnacleHashFailed = pinnacleHashFailed || nextResult.pinnacleHashFailed;
    //   bet365HashFailed   = bet365HashFailed   || nextResult.bet365HashFailed;
    //   if (nextResult.pinnacleHash) pinnacleHash = nextResult.pinnacleHash;
    //   if (nextResult.bet365Hash)   bet365Hash   = nextResult.bet365Hash;
    // } catch (e) { console.error(`NextGame fetch failed: ${e.message}`); }
  }

  // Send Telegram alerts for any stale hashes (throttled to 1/hour per bookmaker)
  if (pinnacleHashFailed) await notifyHashFailed('Pinnacle', pinnacleHash.slice(0, 8));
  if (bet365HashFailed)   await notifyHashFailed('Bet365',   bet365Hash.slice(0, 8));
  if (sbobetHashFailed)   await notifyHashFailed('Sbobet',   sbobetHash.slice(0, 8));

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

// ── Strategy SN: Pre-match Pinnacle steam ────────────────────────────────────
// Fires when Pinnacle moves both AH line AND Total Line before kick-off.
// The opening→current movement is already embedded in the tablenext payload
// (ah_ho/tl_o = opening, ah_hc/tl_c = current). No state storage needed.
// Bet at Bet365 while it still lags Pinnacle's repriced line.

const snDedup = new Dedup(24 * 60 * 60 * 1000); // 24h — reset on process restart

const s1Candidates = new Map(); // matchId → { favSide, ahHc, hoMove, aoMove, ovMove, tlC, storedAt, htScore }
// S2 shares the same pre-match candidates map as S1 (identical detection gates)
const S1C_TTL      = 5 * 60 * 60 * 1000;
const s1Dedup      = new Dedup(6 * 60 * 60 * 1000);
const s2Dedup      = new Dedup(6 * 60 * 60 * 1000);

const s3Candidates = new Map(); // matchId → { lineMove, aoOddsMove, ahHc, tlC, storedAt }
const S3C_TTL      = 5 * 60 * 60 * 1000;
const s3Dedup      = new Dedup(6 * 60 * 60 * 1000);

const s5Candidates  = new Map(); // matchId → { ovMove, tlMove, tlC, storedAt, htScore }
const S5C_TTL       = 5 * 60 * 60 * 1000;
const s5Dedup       = new Dedup(6 * 60 * 60 * 1000);

const ss6Candidates = new Map(); // matchId → { aoOddsMove, ahHc, tlC, storedAt, htScore }
const SS6C_TTL      = 5 * 60 * 60 * 1000;
const ss6Dedup      = new Dedup(6 * 60 * 60 * 1000);

function detectSNSignal(odds) {
  if (!odds || odds.ah_hc == null || odds.ah_ho == null) return null;
  if (odds.tl_c == null || odds.tl_o == null) return null;

  const ahMove = odds.ah_hc - odds.ah_ho;  // negative = toward HOME fav (more given to dog)
  const tlMove = odds.tl_c - odds.tl_o;    // positive = TL rising

  if (Math.abs(ahMove) < cfg.SN_MIN_AH_MOVE) return null;
  if (Math.abs(tlMove) < cfg.SN_MIN_TL_MOVE) return null;

  // Fav side determined by opening line
  const favSide = odds.ah_ho < -0.01 ? 'HOME' : odds.ah_ho > 0.01 ? 'AWAY' : null;
  if (!favSide) return null;

  // Steam = AH moved toward fav (more handicap given to dog); Drift = moved toward dog
  const direction = (favSide === 'HOME' ? ahMove < 0 : ahMove > 0) ? 'STEAM_FAV' : 'DRIFT_DOG';

  return { ahMove, tlMove, favSide, direction,
           ahOpen: odds.ah_ho, ahClose: odds.ah_hc,
           tlOpen: odds.tl_o,  tlClose: odds.tl_c };
}

function snFormat(match, sd, b365, minsToKickoff) {
  const side    = sd.favSide;
  const ahFmt   = v => v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
  const moveFmt = v => (v >= 0 ? '+' : '') + v.toFixed(2);
  const koStr   = minsToKickoff == null  ? 'kickoff unknown'
    : minsToKickoff < 60 ? `in ${Math.round(minsToKickoff)} min`
    : `in ${(minsToKickoff / 60).toFixed(1)}h`;

  const b365Odds1x2 = b365 ? (side === 'HOME' ? b365.ho_c : b365.ao_c) : null;
  const oddsStr     = b365Odds1x2 != null ? `@${b365Odds1x2.toFixed(2)}` : '@n/a';
  const b365Lag     = `B365 AH: ${ahFmt(b365.ah_hc)}  (Pinnacle now: ${ahFmt(sd.ahClose)}  — lag: ${moveFmt(b365.ah_hc - sd.ahClose)})`;

  return buildMessage(
    sd.direction === 'STEAM_FAV' ? 'SN — Pre-match steam (fav)' : 'SN — Pre-match drift (dog)',
    match,
    `Pre-kickoff  [${koStr}]`,
    [
      `💰 <b>1x2 ${side} WIN at Bet365  ${oddsStr}</b>`,
      `📌 AH: ${ahFmt(sd.ahOpen)} → ${ahFmt(sd.ahClose)} (${moveFmt(sd.ahMove)})  ·  TL: ${sd.tlOpen.toFixed(2)} → ${sd.tlClose.toFixed(2)} (${moveFmt(sd.tlMove)})`,
      `📌 ${b365Lag}`,
    ],
  );
}

async function runStrategySN(match, ctx) {
  const { matchId, label, tier, liveMin, minsToKickoff, isSteamNext } = ctx;

  if (!cfg.SN_ENABLED || !isSteamNext) return;
  if (!tierAllowed(tier, cfg.SN_TIER)) { flogv(liveMin, label, 'SN', `SKIP: tier=${tier} not in ${cfg.SN_TIER}`); return; }
  if (!match.odds) { flogv(liveMin, label, 'SN', 'SKIP: no odds'); return; }

  const sd = detectSNSignal(match.odds);
  if (!sd) {
    const ahM = ((match.odds.ah_hc ?? 0) - (match.odds.ah_ho ?? 0)).toFixed(2);
    const tlM = ((match.odds.tl_c  ?? 0) - (match.odds.tl_o  ?? 0)).toFixed(2);
    flogv(liveMin, label, 'SN', `SKIP: no signal (ahMove=${ahM} tlMove=${tlM} thresholds: AH≥${cfg.SN_MIN_AH_MOVE} TL≥${cfg.SN_MIN_TL_MOVE})`);
    return;
  }

  const dedupKey = `${matchId}:sn:${sd.direction}`;
  if (snDedup.has(dedupKey)) { flogv(liveMin, label, 'SN', 'SKIP: already notified'); return; }

  const b365 = match.bet365_odds ?? null;

  // Require B365 odds to be present — no point alerting if we can't verify the lag
  if (!b365 || b365.ah_hc == null) {
    flog(liveMin, label, 'SN', 'SKIP: no B365 odds');
    return;
  }

  // Skip if B365 has already fully repriced (lag below threshold)
  const lag = Math.abs(b365.ah_hc - sd.ahClose);
  if (lag < cfg.SN_B365_LAG_MIN) {
    flog(liveMin, label, 'SN', `SKIP: B365 already repriced (lag=${lag.toFixed(2)} < ${cfg.SN_B365_LAG_MIN})`);
    return;
  }

  const msg = snFormat(match, sd, b365, minsToKickoff);
  await sendTelegram(msg);
  snDedup.mark(dedupKey);
  flog(liveMin, label, 'SN', `ALERT: dir=${sd.direction} ahMove=${sd.ahMove.toFixed(2)} tlMove=${sd.tlMove.toFixed(2)} tier=${tier} ko=${minsToKickoff != null ? minsToKickoff.toFixed(0)+'m' : '?'}`);
}

// ── Strategy S1: Sbobet S1 — pre-match AH+Over odds steam → Over 0.5 Goals Remaining at 65' ─
//
// Pre-match gates (all required):
//   1. (ho_c − ho_o) ≤ −0.20  OR  (ao_c − ao_o) ≤ −0.20   (AH odds steam on either side)
//   2. (ov_c − ov_o) ≤ −0.15                                 (Over odds steam)
//   3. AH closing line in [−1.5, +1.5]
//   4. TL closing in [2.0, 3.0]
//
// In-play fire at ~65' (all required):
//   • Fav team was winning at HT
//   • Current score diff ≤ 1 goal
//   • Current total goals ≤ 3
//   Bet: Over 0.5 Goals Remaining

function detectS1Signal(odds) {
  if (!odds) return null;
  const { ah_hc, ho_c, ho_o, ao_c, ao_o, ov_c, ov_o, tl_c } = odds;
  if (ah_hc == null || ho_c == null || ho_o == null || ao_c == null || ao_o == null) return null;
  if (ov_c == null || ov_o == null || tl_c == null) return null;

  const hoMove = ho_c - ho_o;
  const aoMove = ao_c - ao_o;
  // At least one AH side must have dropped by ≥ threshold
  if (hoMove > cfg.S1_MIN_AH_ODDS_MOVE && aoMove > cfg.S1_MIN_AH_ODDS_MOVE) return null;

  // Over odds must have dropped by ≥ threshold
  const ovMove = ov_c - ov_o;
  if (ovMove > cfg.S1_MIN_OV_ODDS_MOVE) return null;

  // AH closing line range
  if (ah_hc < cfg.S1_AH_LINE_MIN || ah_hc > cfg.S1_AH_LINE_MAX) return null;

  // TL closing range
  if (tl_c < cfg.S1_TL_MIN || tl_c > cfg.S1_TL_MAX) return null;

  // Fav side
  let favSide;
  if      (ah_hc < -0.01) favSide = 'HOME';
  else if (ah_hc >  0.01) favSide = 'AWAY';
  else    favSide = (ho_c <= ao_c) ? 'HOME' : 'AWAY';

  return { favSide, ahHc: ah_hc, hoMove, aoMove, ovMove, tlC: tl_c };
}

function s1Format(match, cand, liveMin) {
  const htStr    = `${cand.htScore.home}-${cand.htScore.away}`;
  const minsLeft = 90 - liveMin;
  const ahHcStr  = cand.ahHc >= 0 ? `+${cand.ahHc.toFixed(2)}` : cand.ahHc.toFixed(2);
  const steamSide = cand.hoMove <= cfg.S1_MIN_AH_ODDS_MOVE ? 'HOME' : 'AWAY';
  const steamOdds = steamSide === 'HOME' ? cand.hoMove : cand.aoMove;
  return buildMessage(
    'Sbobet_S1 — Over 0.5 Goals Remaining',
    match,
    `${liveMin}'  ${match.score || '—'}  [HT ${htStr}]`,
    [
      `💰 <b>Over 0.5 Goals Remaining (in-play)</b>`,
      `📌 Look for in-play Over 0.5  (~${minsLeft} min left)`,
      `📌 AH ${ahHcStr}  ·  TL ${cand.tlC.toFixed(2)}  ·  fav: ${cand.favSide}`,
      `📌 Pre-match steam: AH ${steamSide} ${steamOdds >= 0 ? '+' : ''}${steamOdds.toFixed(2)}  ·  Over ${cand.ovMove >= 0 ? '+' : ''}${cand.ovMove.toFixed(2)}`,
    ],
  );
}

async function runStrategyS1(match, ctx) {
  const { matchId, label, tier, liveMin, isSteamNext, isS1HTStore, isS1Fire } = ctx;

  if (!cfg.S1_ENABLED) return;
  if (!tierAllowed(tier, cfg.S1_TIER)) { flogv(liveMin, label, 'Sbobet_S1', `SKIP: tier=${tier} not in ${cfg.S1_TIER}`); return; }

  // ── Pre-match: detect signal and store candidate ─────────────────────────
  if (isSteamNext) {
    const sbo = match.sbobet_odds;
    if (!sbo) { flogv(liveMin, label, 'Sbobet_S1', 'SKIP: no Sbobet odds'); return; }
    const sd = detectS1Signal(sbo);
    if (!sd) {
      const hoM = (sbo.ho_c != null && sbo.ho_o != null) ? (sbo.ho_c - sbo.ho_o).toFixed(2) : 'n/a';
      const aoM = (sbo.ao_c != null && sbo.ao_o != null) ? (sbo.ao_c - sbo.ao_o).toFixed(2) : 'n/a';
      const ovM = (sbo.ov_c != null && sbo.ov_o != null) ? (sbo.ov_c - sbo.ov_o).toFixed(2) : 'n/a';
      flogv(liveMin, label, 'Sbobet_S1', `no prematch signal (sbo: hoM=${hoM} aoM=${aoM} ovM=${ovM} ahHc=${sbo.ah_hc} tlC=${sbo.tl_c})`);
      return;
    }
    if (!s1Candidates.has(matchId)) {
      s1Candidates.set(matchId, { ...sd, storedAt: Date.now(), htScore: null });
      flog(liveMin, label, 'Sbobet_S1', `stored pre-match candidate: fav=${sd.favSide} ahHc=${sd.ahHc.toFixed(2)} tlC=${sd.tlC.toFixed(2)} hoM=${sd.hoMove.toFixed(2)} aoM=${sd.aoMove.toFixed(2)} ovM=${sd.ovMove.toFixed(2)}`);
    }
    return;
  }

  // ── HT window: store HT score ────────────────────────────────────────────
  if (isS1HTStore) {
    const cand = s1Candidates.get(matchId);
    if (cand && !cand.htScore) {
      const score = parseScoreStr(match.score);
      if (score) {
        cand.htScore = { home: score.home, away: score.away };
        flog(liveMin, label, 'Sbobet_S1', `stored HT score: ${score.home}-${score.away} fav=${cand.favSide}`);
      }
    }
    return;
  }

  // ── 65' fire window ──────────────────────────────────────────────────────
  if (isS1Fire) {
    const cand = s1Candidates.get(matchId);
    if (!cand) { flogv(liveMin, label, 'Sbobet_S1', 'SKIP: no candidate (missed pre-match window?)'); return; }
    if (!cand.htScore) { flogv(liveMin, label, 'Sbobet_S1', 'SKIP: no HT score stored'); return; }

    const dedupKey = `${matchId}:s1:fire`;
    if (s1Dedup.has(dedupKey)) { flogv(liveMin, label, 'Sbobet_S1', 'SKIP: already notified'); return; }

    // Fav must have been winning at HT
    const htFavGoals = cand.favSide === 'HOME' ? cand.htScore.home : cand.htScore.away;
    const htDogGoals = cand.favSide === 'HOME' ? cand.htScore.away : cand.htScore.home;
    if (htFavGoals <= htDogGoals) {
      flogv(liveMin, label, 'Sbobet_S1', `SKIP: fav not winning at HT (${cand.htScore.home}-${cand.htScore.away} fav=${cand.favSide})`);
      return;
    }

    const curScore = parseScoreStr(match.score);
    if (!curScore) { flogv(liveMin, label, 'Sbobet_S1', 'SKIP: no current score'); return; }

    const totalGoals = curScore.home + curScore.away;
    const scoreDiff  = Math.abs(curScore.home - curScore.away);

    if (scoreDiff > cfg.S1_MAX_SCORE_DIFF) {
      flogv(liveMin, label, 'Sbobet_S1', `SKIP: score diff ${scoreDiff} > ${cfg.S1_MAX_SCORE_DIFF} (score=${match.score})`);
      return;
    }
    if (totalGoals > cfg.S1_MAX_TOTAL_GOALS) {
      flogv(liveMin, label, 'Sbobet_S1', `SKIP: total goals ${totalGoals} > ${cfg.S1_MAX_TOTAL_GOALS} (score=${match.score})`);
      return;
    }

    const msg = s1Format(match, cand, liveMin);
    await sendTelegram(msg);
    s1Dedup.mark(dedupKey);
    flog(liveMin, label, 'Sbobet_S1', `ALERT: HT=${cand.htScore.home}-${cand.htScore.away} score=${match.score} diff=${scoreDiff} goals=${totalGoals} tier=${tier}`);
  }
}

function cleanupS1Candidates() {
  const now = Date.now();
  for (const [id, c] of s1Candidates) {
    if (now - c.storedAt > S1C_TTL) s1Candidates.delete(id);
  }
}

// ── Strategy S2: Sbobet S2 — same pre-match gates as S1; HT 1-1 → Over 0.5 Goals Remaining ─
//
// Pre-match gates: identical to S1 (reuses s1Candidates)
// HT condition: score must be exactly 1-1
// Fire at 65': score diff ≤ 1 (draw or one-goal game)
// Bet: Over 0.5 Goals Remaining

function s2Format(match, cand, liveMin) {
  const htStr    = `${cand.htScore.home}-${cand.htScore.away}`;
  const minsLeft = 90 - liveMin;
  const ahHcStr  = cand.ahHc >= 0 ? `+${cand.ahHc.toFixed(2)}` : cand.ahHc.toFixed(2);
  const steamSide = cand.hoMove <= cfg.S1_MIN_AH_ODDS_MOVE ? 'HOME' : 'AWAY';
  const steamOdds = steamSide === 'HOME' ? cand.hoMove : cand.aoMove;
  const curScore  = match.score || '—';
  return buildMessage(
    'Sbobet_S2 — Over 0.5 Goals Remaining',
    match,
    `${liveMin}'  ${curScore}  [HT ${htStr}]`,
    [
      `💰 <b>Over 0.5 Goals Remaining (in-play)</b>`,
      `📌 Look for in-play Over 0.5  (~${minsLeft} min left)`,
      `📌 AH ${ahHcStr}  ·  TL ${cand.tlC.toFixed(2)}  ·  fav: ${cand.favSide}`,
      `📌 Pre-match steam: AH ${steamSide} ${steamOdds >= 0 ? '+' : ''}${steamOdds.toFixed(2)}  ·  Over ${cand.ovMove >= 0 ? '+' : ''}${cand.ovMove.toFixed(2)}`,
    ],
  );
}

async function runStrategyS2(match, ctx) {
  const { matchId, label, tier, liveMin, isSteamNext, isS2HTStore, isS2Fire } = ctx;

  if (!cfg.S2_ENABLED) return;
  if (!tierAllowed(tier, cfg.S2_TIER)) { flogv(liveMin, label, 'Sbobet_S2', `SKIP: tier=${tier} not in ${cfg.S2_TIER}`); return; }

  // ── Pre-match: reuse S1 detection — candidate is stored by runStrategyS1 ─
  // (runStrategyS1 runs first in the scan loop, so s1Candidates is already populated)

  // ── HT window: store HT score (shared map with S1) ───────────────────────
  // S1 already handles storage in its own isS1HTStore block.
  // S2 uses the same s1Candidates map, so nothing extra to store here —
  // unless S2 has a different HT window (it defaults to the same 44-52').
  if (isS2HTStore) {
    const cand = s1Candidates.get(matchId);
    if (cand && !cand.htScore) {
      const score = parseScoreStr(match.score);
      if (score) {
        cand.htScore = { home: score.home, away: score.away };
        flog(liveMin, label, 'Sbobet_S2', `stored HT score: ${score.home}-${score.away}`);
      }
    }
    return;
  }

  // ── 65' fire window ──────────────────────────────────────────────────────
  if (isS2Fire) {
    const cand = s1Candidates.get(matchId);
    if (!cand) { flogv(liveMin, label, 'Sbobet_S2', 'SKIP: no candidate (missed pre-match window?)'); return; }
    if (!cand.htScore) { flogv(liveMin, label, 'Sbobet_S2', 'SKIP: no HT score stored'); return; }

    const dedupKey = `${matchId}:s2:fire`;
    if (s2Dedup.has(dedupKey)) { flogv(liveMin, label, 'Sbobet_S2', 'SKIP: already notified'); return; }

    // HT must be exactly 1-1
    if (cand.htScore.home !== 1 || cand.htScore.away !== 1) {
      flogv(liveMin, label, 'Sbobet_S2', `SKIP: HT not 1-1 (was ${cand.htScore.home}-${cand.htScore.away})`);
      return;
    }

    const curScore = parseScoreStr(match.score);
    if (!curScore) { flogv(liveMin, label, 'Sbobet_S2', 'SKIP: no current score'); return; }

    const scoreDiff  = Math.abs(curScore.home - curScore.away);
    const totalGoals = curScore.home + curScore.away;

    if (scoreDiff > cfg.S2_MAX_SCORE_DIFF) {
      flogv(liveMin, label, 'Sbobet_S2', `SKIP: score diff ${scoreDiff} > ${cfg.S2_MAX_SCORE_DIFF} (score=${match.score})`);
      return;
    }
    if (totalGoals > cfg.S2_MAX_TOTAL_GOALS) {
      flogv(liveMin, label, 'Sbobet_S2', `SKIP: total goals ${totalGoals} > ${cfg.S2_MAX_TOTAL_GOALS} (score=${match.score})`);
      return;
    }

    const msg = s2Format(match, cand, liveMin);
    await sendTelegram(msg);
    s2Dedup.mark(dedupKey);
    flog(liveMin, label, 'Sbobet_S2', `ALERT: HT=1-1 score=${match.score} diff=${scoreDiff} goals=${totalGoals} tier=${tier}`);
  }
}

// ── Strategy S3: Sbobet S3 — contradictory signal → Away Team Score Next Goal ─
//
// Pre-match gates (all required, from sbobet_odds):
//   1. AH line moves toward home ≥ 0.75  (ah_ho − ah_hc ≥ 0.75)
//   2. Away AH closing odds drop ≥ 0.10   (ao_c − ao_o ≤ −0.10) ← sharp money on away
//   3. AH closing line in [−1.0, +1.5]
//   4. TL closing in [2.25, 3.0]
//
// Fire at 65' (no HT condition):
//   Goal difference ≤ 1
//   Away conceded ≤ 2 goals (home goals ≤ 2)
//   Bet: Away Team Score Next Goal  @min 1.80

function detectS3Signal(odds) {
  if (!odds) return null;
  const { ah_hc, ah_ho, ao_c, ao_o, tl_c } = odds;
  if (ah_hc == null || ah_ho == null || ao_c == null || ao_o == null || tl_c == null) return null;

  // AH line moved toward home by ≥ threshold (opening − closing ≥ 0.75)
  const lineMove = ah_ho - ah_hc;
  if (lineMove < cfg.S3_MIN_LINE_MOVE) return null;

  // Away AH odds dropped (contradictory sharp signal)
  const aoOddsMove = ao_c - ao_o;
  if (aoOddsMove > cfg.S3_MIN_AWAY_ODDS_DROP) return null;

  // AH closing line range
  if (ah_hc < cfg.S3_AH_LINE_MIN || ah_hc > cfg.S3_AH_LINE_MAX) return null;

  // TL closing range
  if (tl_c < cfg.S3_TL_MIN || tl_c > cfg.S3_TL_MAX) return null;

  return { lineMove, aoOddsMove, ahHo: ah_ho, ahHc: ah_hc, tlC: tl_c };
}

function s3Format(match, cand, liveMin) {
  const minsLeft  = 90 - liveMin;
  const ahHoStr   = cand.ahHo >= 0 ? `+${cand.ahHo.toFixed(2)}` : cand.ahHo.toFixed(2);
  const ahHcStr   = cand.ahHc >= 0 ? `+${cand.ahHc.toFixed(2)}` : cand.ahHc.toFixed(2);
  return buildMessage(
    'Sbobet_S3 — Away Next Goal (contradictory signal)',
    match,
    `${liveMin}'  ${match.score || '—'}`,
    [
      `💰 <b>Away Team Score Next Goal</b>`,
      `📌 Min odds: @${cfg.S3_MIN_ODDS.toFixed(2)}  (~${minsLeft} min left)`,
      `📌 AH: ${ahHoStr} → ${ahHcStr}  (line moved +${cand.lineMove.toFixed(2)} toward home)`,
      `📌 Away odds move: ${cand.aoOddsMove >= 0 ? '+' : ''}${cand.aoOddsMove.toFixed(2)}  TL: ${cand.tlC.toFixed(2)}  ⚠️ Sharp money on away`,
    ],
  );
}

async function runStrategyS3(match, ctx) {
  const { matchId, label, tier, liveMin, isSteamNext, isS3Fire } = ctx;

  if (!cfg.S3_ENABLED) return;
  if (!tierAllowed(tier, cfg.S3_TIER)) { flogv(liveMin, label, 'Sbobet_S3', `SKIP: tier=${tier} not in ${cfg.S3_TIER}`); return; }

  // ── Pre-match: detect signal and store candidate ─────────────────────────
  if (isSteamNext) {
    const sbo = match.sbobet_odds;
    if (!sbo) { flogv(liveMin, label, 'Sbobet_S3', 'SKIP: no Sbobet odds'); return; }
    const sd = detectS3Signal(sbo);
    if (!sd) {
      const lineM  = (sbo.ah_ho != null && sbo.ah_hc != null) ? (sbo.ah_ho - sbo.ah_hc).toFixed(2) : 'n/a';
      const aoM    = (sbo.ao_c  != null && sbo.ao_o  != null) ? (sbo.ao_c  - sbo.ao_o).toFixed(2)  : 'n/a';
      flogv(liveMin, label, 'Sbobet_S3', `no prematch signal (sbo: lineMove=${lineM} aoM=${aoM} ahHc=${sbo.ah_hc} tlC=${sbo.tl_c})`);
      return;
    }
    if (!s3Candidates.has(matchId)) {
      s3Candidates.set(matchId, { ...sd, storedAt: Date.now() });
      flog(liveMin, label, 'Sbobet_S3', `stored pre-match candidate: lineMove=${sd.lineMove.toFixed(2)} aoOddsMove=${sd.aoOddsMove.toFixed(2)} ahHc=${sd.ahHc.toFixed(2)} tlC=${sd.tlC.toFixed(2)}`);
    }
    return;
  }

  // ── 65' fire window ──────────────────────────────────────────────────────
  if (isS3Fire) {
    const cand = s3Candidates.get(matchId);
    if (!cand) { flogv(liveMin, label, 'Sbobet_S3', 'SKIP: no candidate (missed pre-match window?)'); return; }

    const dedupKey = `${matchId}:s3:fire`;
    if (s3Dedup.has(dedupKey)) { flogv(liveMin, label, 'Sbobet_S3', 'SKIP: already notified'); return; }

    const curScore = parseScoreStr(match.score);
    if (!curScore) { flogv(liveMin, label, 'Sbobet_S3', 'SKIP: no current score'); return; }

    const scoreDiff     = Math.abs(curScore.home - curScore.away);
    const awayConceded  = curScore.home;  // goals conceded by away = goals scored by home

    if (scoreDiff > cfg.S3_MAX_SCORE_DIFF) {
      flogv(liveMin, label, 'Sbobet_S3', `SKIP: score diff ${scoreDiff} > ${cfg.S3_MAX_SCORE_DIFF} (score=${match.score})`);
      return;
    }
    if (awayConceded > cfg.S3_MAX_AWAY_CONCEDED) {
      flogv(liveMin, label, 'Sbobet_S3', `SKIP: away conceded ${awayConceded} > ${cfg.S3_MAX_AWAY_CONCEDED} (score=${match.score})`);
      return;
    }

    const msg = s3Format(match, cand, liveMin);
    await sendTelegram(msg);
    s3Dedup.mark(dedupKey);
    flog(liveMin, label, 'Sbobet_S3', `ALERT: score=${match.score} diff=${scoreDiff} awayConceded=${awayConceded} tier=${tier}`);
  }
}

function cleanupS3Candidates() {
  const now = Date.now();
  for (const [id, c] of s3Candidates) {
    if (now - c.storedAt > S3C_TTL) s3Candidates.delete(id);
  }
}

// ── Strategy S5: Sbobet S5 — Over odds steam + flat/rising TL → Over 0.5 Remaining ──────────
//
// Pre-match gates (sbobet_odds):
//   1. (ov_c − ov_o) ≤ −0.25   Over odds drop ≥ 0.25
//   2. (tl_c − tl_o) ≥ 0       TL flat or rising (does not decrease)
//   3. tl_c in [2.0, 2.75]
//
// HT condition (44–52'): total goals at HT = 0 or 1
// Fire at 65–70': total goals ≤ 2  +  goal difference ≤ 1
// Bet: Over 0.5 Goals Remaining

function detectS5Signal(odds) {
  if (!odds) return null;
  const { ov_c, ov_o, tl_c, tl_o } = odds;
  if (ov_c == null || ov_o == null || tl_c == null || tl_o == null) return null;

  // Over odds must have dropped by ≥ threshold
  const ovMove = ov_c - ov_o;
  if (ovMove > cfg.S5_MIN_OV_DROP) return null;

  // TL must be flat or rising (not decreasing)
  const tlMove = tl_c - tl_o;
  if (tlMove < 0) return null;

  // TL closing range
  if (tl_c < cfg.S5_TL_MIN || tl_c > cfg.S5_TL_MAX) return null;

  return { ovMove, tlMove, tlC: tl_c, tlO: tl_o };
}

function s5Format(match, cand, liveMin) {
  const htStr    = `${cand.htScore.home}-${cand.htScore.away}`;
  const htGoals  = cand.htScore.home + cand.htScore.away;
  const minsLeft = 90 - liveMin;
  const tlDir    = cand.tlMove > 0 ? `↑ +${cand.tlMove.toFixed(2)}` : '→ flat';
  return buildMessage(
    'Sbobet_S5 — Over 0.5 Goals Remaining',
    match,
    `${liveMin}'  ${match.score || '—'}  [HT ${htStr}]`,
    [
      `💰 <b>Over 0.5 Goals Remaining (in-play)</b>`,
      `📌 Look for in-play Over 0.5  (~${minsLeft} min left)`,
      `📌 TL: ${cand.tlO.toFixed(2)} → ${cand.tlC.toFixed(2)} (${tlDir})  ·  Over move: ${cand.ovMove >= 0 ? '+' : ''}${cand.ovMove.toFixed(2)}`,
      `📌 HT goals: ${htGoals}  (0 or 1 required)`,
    ],
  );
}

async function runStrategyS5(match, ctx) {
  const { matchId, label, tier, liveMin, isSteamNext, isS5HTStore, isS5Fire } = ctx;

  if (!cfg.S5_ENABLED) return;
  if (!tierAllowed(tier, cfg.S5_TIER)) { flogv(liveMin, label, 'Sbobet_S5', `SKIP: tier=${tier} not in ${cfg.S5_TIER}`); return; }

  // ── Pre-match: detect signal and store candidate ─────────────────────────
  if (isSteamNext) {
    const sbo = match.sbobet_odds;
    if (!sbo) { flogv(liveMin, label, 'Sbobet_S5', 'SKIP: no Sbobet odds'); return; }
    const sd = detectS5Signal(sbo);
    if (!sd) {
      const ovM  = (sbo.ov_c != null && sbo.ov_o != null) ? (sbo.ov_c - sbo.ov_o).toFixed(2) : 'n/a';
      const tlM  = (sbo.tl_c != null && sbo.tl_o != null) ? (sbo.tl_c - sbo.tl_o).toFixed(2) : 'n/a';
      flogv(liveMin, label, 'Sbobet_S5', `no prematch signal (sbo: ovM=${ovM} tlM=${tlM} tlC=${sbo.tl_c})`);
      return;
    }
    if (!s5Candidates.has(matchId)) {
      s5Candidates.set(matchId, { ...sd, storedAt: Date.now(), htScore: null });
      flog(liveMin, label, 'Sbobet_S5', `stored pre-match candidate: ovM=${sd.ovMove.toFixed(2)} tlM=${sd.tlMove.toFixed(2)} tlC=${sd.tlC.toFixed(2)}`);
    }
    return;
  }

  // ── HT window: store HT score and validate HT goals ─────────────────────
  if (isS5HTStore) {
    const cand = s5Candidates.get(matchId);
    if (cand && !cand.htScore) {
      const score = parseScoreStr(match.score);
      if (score) {
        cand.htScore = { home: score.home, away: score.away };
        const htGoals = score.home + score.away;
        flog(liveMin, label, 'Sbobet_S5', `stored HT score: ${score.home}-${score.away} (goals=${htGoals})`);
      }
    }
    return;
  }

  // ── 65–70' fire window ───────────────────────────────────────────────────
  if (isS5Fire) {
    const cand = s5Candidates.get(matchId);
    if (!cand) { flogv(liveMin, label, 'Sbobet_S5', 'SKIP: no candidate (missed pre-match window?)'); return; }
    if (!cand.htScore) { flogv(liveMin, label, 'Sbobet_S5', 'SKIP: no HT score stored'); return; }

    const dedupKey = `${matchId}:s5:fire`;
    if (s5Dedup.has(dedupKey)) { flogv(liveMin, label, 'Sbobet_S5', 'SKIP: already notified'); return; }

    // HT total goals must be 0 or 1
    const htGoals = cand.htScore.home + cand.htScore.away;
    if (htGoals > cfg.S5_HT_MAX_GOALS) {
      flogv(liveMin, label, 'Sbobet_S5', `SKIP: HT goals ${htGoals} > ${cfg.S5_HT_MAX_GOALS} (${cand.htScore.home}-${cand.htScore.away})`);
      return;
    }

    const curScore = parseScoreStr(match.score);
    if (!curScore) { flogv(liveMin, label, 'Sbobet_S5', 'SKIP: no current score'); return; }

    const totalGoals = curScore.home + curScore.away;
    const scoreDiff  = Math.abs(curScore.home - curScore.away);

    if (totalGoals > cfg.S5_MAX_TOTAL_GOALS) {
      flogv(liveMin, label, 'Sbobet_S5', `SKIP: total goals ${totalGoals} > ${cfg.S5_MAX_TOTAL_GOALS} (score=${match.score})`);
      return;
    }
    if (scoreDiff > cfg.S5_MAX_SCORE_DIFF) {
      flogv(liveMin, label, 'Sbobet_S5', `SKIP: score diff ${scoreDiff} > ${cfg.S5_MAX_SCORE_DIFF} (score=${match.score})`);
      return;
    }

    const msg = s5Format(match, cand, liveMin);
    await sendTelegram(msg);
    s5Dedup.mark(dedupKey);
    flog(liveMin, label, 'Sbobet_S5', `ALERT: HT=${cand.htScore.home}-${cand.htScore.away}(goals=${htGoals}) score=${match.score} total=${totalGoals} diff=${scoreDiff} tier=${tier}`);
  }
}

function cleanupS5Candidates() {
  const now = Date.now();
  for (const [id, c] of s5Candidates) {
    if (now - c.storedAt > S5C_TTL) s5Candidates.delete(id);
  }
}

// ── Strategy SS6: Sbobet S6 — Strong Away Steam → Away Team Score Next Goal ──
//
// Pre-match gates (sbobet_odds):
//   1. ao_c − ao_o ≤ −0.35   strong away odds steam
//   2. ah_hc in [−0.5, +1.5]  away fav or small underdog
//   3. tl_c in [2.0, 3.0]
//
// HT condition (44–52'): away winning, drawing, or losing by ≤1  (home − away ≤ 1)
// Fire at 65': home − away ≤ 1  +  total goals ≤ 3
// Bet: Away Team Score Next Goal  @min 1.60

function detectSS6Signal(odds) {
  if (!odds) return null;
  const { ah_hc, ao_c, ao_o, tl_c } = odds;
  if (ah_hc == null || ao_c == null || ao_o == null || tl_c == null) return null;

  // Strong away odds steam
  const aoOddsMove = ao_c - ao_o;
  if (aoOddsMove > cfg.SS6_MIN_AWAY_DROP) return null;

  // AH closing line range
  if (ah_hc < cfg.SS6_AH_LINE_MIN || ah_hc > cfg.SS6_AH_LINE_MAX) return null;

  // TL closing range
  if (tl_c < cfg.SS6_TL_MIN || tl_c > cfg.SS6_TL_MAX) return null;

  return { aoOddsMove, ahHc: ah_hc, tlC: tl_c };
}

function ss6Format(match, cand, liveMin) {
  const htStr    = `${cand.htScore.home}-${cand.htScore.away}`;
  const minsLeft = 90 - liveMin;
  const ahHcStr  = cand.ahHc >= 0 ? `+${cand.ahHc.toFixed(2)}` : cand.ahHc.toFixed(2);
  return buildMessage(
    'Sbobet_S6 — Away Next Goal (Strong Steam)',
    match,
    `${liveMin}'  ${match.score || '—'}  [HT ${htStr}]`,
    [
      `💰 <b>Away Team Score Next Goal</b>`,
      `📌 Min odds: @${cfg.SS6_MIN_ODDS.toFixed(2)}  (~${minsLeft} min left)`,
      `📌 Away odds move: ${cand.aoOddsMove >= 0 ? '+' : ''}${cand.aoOddsMove.toFixed(2)}  (strong steam ≤ ${cfg.SS6_MIN_AWAY_DROP})`,
      `📌 AH: ${ahHcStr}  ·  TL: ${cand.tlC.toFixed(2)}`,
    ],
  );
}

async function runStrategySS6(match, ctx) {
  const { matchId, label, tier, liveMin, isSteamNext, isSS6HTStore, isSS6Fire } = ctx;

  if (!cfg.SS6_ENABLED) return;
  if (!tierAllowed(tier, cfg.SS6_TIER)) { flogv(liveMin, label, 'Sbobet_S6', `SKIP: tier=${tier} not in ${cfg.SS6_TIER}`); return; }

  // ── Pre-match: detect signal and store candidate ─────────────────────────
  if (isSteamNext) {
    const sbo = match.sbobet_odds;
    if (!sbo) { flogv(liveMin, label, 'Sbobet_S6', 'SKIP: no Sbobet odds'); return; }
    const sd = detectSS6Signal(sbo);
    if (!sd) {
      const aoM = (sbo.ao_c != null && sbo.ao_o != null) ? (sbo.ao_c - sbo.ao_o).toFixed(2) : 'n/a';
      flogv(liveMin, label, 'Sbobet_S6', `no prematch signal (sbo: aoM=${aoM} ahHc=${sbo.ah_hc} tlC=${sbo.tl_c})`);
      return;
    }
    if (!ss6Candidates.has(matchId)) {
      ss6Candidates.set(matchId, { ...sd, storedAt: Date.now(), htScore: null });
      flog(liveMin, label, 'Sbobet_S6', `stored pre-match candidate: aoM=${sd.aoOddsMove.toFixed(2)} ahHc=${sd.ahHc.toFixed(2)} tlC=${sd.tlC.toFixed(2)}`);
    }
    return;
  }

  // ── HT window: store HT score ────────────────────────────────────────────
  if (isSS6HTStore) {
    const cand = ss6Candidates.get(matchId);
    if (cand && !cand.htScore) {
      const score = parseScoreStr(match.score);
      if (score) {
        cand.htScore = { home: score.home, away: score.away };
        const deficit = score.home - score.away;
        flog(liveMin, label, 'Sbobet_S6', `stored HT score: ${score.home}-${score.away} (home-away=${deficit})`);
      }
    }
    return;
  }

  // ── 65' fire window ──────────────────────────────────────────────────────
  if (isSS6Fire) {
    const cand = ss6Candidates.get(matchId);
    if (!cand) { flogv(liveMin, label, 'Sbobet_S6', 'SKIP: no candidate (missed pre-match window?)'); return; }
    if (!cand.htScore) { flogv(liveMin, label, 'Sbobet_S6', 'SKIP: no HT score stored'); return; }

    const dedupKey = `${matchId}:ss6:fire`;
    if (ss6Dedup.has(dedupKey)) { flogv(liveMin, label, 'Sbobet_S6', 'SKIP: already notified'); return; }

    // HT condition: away not losing by 2+ (home − away ≤ 1)
    const htDeficit = cand.htScore.home - cand.htScore.away;
    if (htDeficit > cfg.SS6_MAX_AWAY_DEFICIT) {
      flogv(liveMin, label, 'Sbobet_S6', `SKIP: HT away deficit ${htDeficit} > ${cfg.SS6_MAX_AWAY_DEFICIT} (${cand.htScore.home}-${cand.htScore.away})`);
      return;
    }

    const curScore = parseScoreStr(match.score);
    if (!curScore) { flogv(liveMin, label, 'Sbobet_S6', 'SKIP: no current score'); return; }

    const curDeficit = curScore.home - curScore.away;
    const totalGoals = curScore.home + curScore.away;

    if (curDeficit > cfg.SS6_MAX_AWAY_DEFICIT) {
      flogv(liveMin, label, 'Sbobet_S6', `SKIP: away losing by ${curDeficit} > ${cfg.SS6_MAX_AWAY_DEFICIT} (score=${match.score})`);
      return;
    }
    if (totalGoals > cfg.SS6_MAX_TOTAL_GOALS) {
      flogv(liveMin, label, 'Sbobet_S6', `SKIP: total goals ${totalGoals} > ${cfg.SS6_MAX_TOTAL_GOALS} (score=${match.score})`);
      return;
    }

    const msg = ss6Format(match, cand, liveMin);
    await sendTelegram(msg);
    ss6Dedup.mark(dedupKey);
    flog(liveMin, label, 'Sbobet_S6', `ALERT: HT=${cand.htScore.home}-${cand.htScore.away} score=${match.score} deficit=${curDeficit} goals=${totalGoals} tier=${tier}`);
  }
}

function cleanupSS6Candidates() {
  const now = Date.now();
  for (const [id, c] of ss6Candidates) {
    if (now - c.storedAt > SS6C_TTL) ss6Candidates.delete(id);
  }
}

// ── Core scan ─────────────────────────────────────────────────────────────────
let _scanAlerts = 0;

async function runScan() {
  _scanAlerts = 0;
  console.log(`[${new Date().toISOString()}] Scanning…`);

  let matches;
  try { matches = await fetchMatches(); }
  catch (e) { console.error(`Livescore fetch failed: ${e.message}`); return; }

  if (!matches.length) { console.log('No matches found.'); return; }

  cleanupSxyCandidates();
  cleanupS1Candidates();
  cleanupS3Candidates();
  cleanupS5Candidates();
  cleanupSS6Candidates();

  let inWindowCount = 0;

  for (const match of matches) {
    const ctx = matchContext(match);
    const { label, tier, liveMin, minsToKickoff, isLive, isUpcoming, isMktEdge, isSXYEarly, isSXYMidH, isSXYHTStore, isSXYHTFire, isSteamNext, isS1HTStore, isS1Fire, isS2HTStore, isS2Fire, isS3Fire, isS5HTStore, isS5Fire, isSS6HTStore, isSS6Fire } = ctx;

    const anyWindow = isLive || isUpcoming || isMktEdge || isSXYEarly || isSXYMidH || isSXYHTStore || isSXYHTFire || isSteamNext || isS1HTStore || isS1Fire || isS2HTStore || isS2Fire || isS3Fire || isS5HTStore || isS5Fire || isSS6HTStore || isSS6Fire;
    if (!anyWindow) {
      const timing = minsToKickoff != null
        ? `min_to_ko=${minsToKickoff.toFixed(1)}`
        : `min=${liveMin ?? 'no_time'}`;
      // Structural diagnostics — show missing books and tier even for out-of-window matches
      const pin  = match.odds;
      const b365 = match.bet365_odds;
      const sbo  = match.sbobet_odds;
      const pinOk  = pin  && pin.ah_ho  != null && pin.ah_hc  != null;
      const b365Ok = b365 && b365.ah_ho != null && b365.ah_hc != null;
      const sboOk  = sbo  && sbo.ah_ho  != null && sbo.ah_hc  != null;
      const issues = [
        !pinOk  && 'pin_missing',
        !b365Ok && 'b365_missing',
        !sboOk  && 'sbo_missing',
        !tierAllowed(tier, cfg.SX_TIER) && !tierAllowed(tier, cfg.S6_TIER) && !tierAllowed(tier, cfg.S7_TIER) && !tierAllowed(tier, cfg.SN_TIER) && !tierAllowed(tier, cfg.S1_TIER) && !tierAllowed(tier, cfg.S3_TIER) && !tierAllowed(tier, cfg.SS6_TIER) && `tier=${tier}_excluded`,
      ].filter(Boolean);
      const issueStr = issues.length ? `  ⚠ ${issues.join(' ')}` : '';
      flogv(liveMin, `${label} [${tier}]`, 'ALL', `out-of-window (${timing})${issueStr}`);
      continue;
    }

    inWindowCount++;
    const koLabel = minsToKickoff != null ? `ko=${minsToKickoff.toFixed(0)}m` : '?';
    const windows = [
      isLive        && `live(${cfg.ALERT_MIN_MINUTE}-${cfg.ALERT_MAX_MINUTE}')`,
      isUpcoming    && `upcoming(${minsToKickoff != null ? minsToKickoff.toFixed(1) + 'min' : '?'})`,
      isMktEdge     && `mktedge(${liveMin}')`,
      isSXYEarly    && `sxy_early(${liveMin}')`,
      isSXYMidH     && `sxy_midh(${liveMin}')`,
      isSXYHTStore  && `sxy_htstore(${liveMin}')`,
      isSXYHTFire   && `sxy_htfire(${liveMin}')`,
      isSteamNext   && `steam_next(${koLabel})`,
      isS1HTStore   && `s1_htstore(${liveMin}')`,
      isS1Fire      && `s1_fire(${liveMin}')`,
      isS2HTStore   && `s2_htstore(${liveMin}')`,
      isS2Fire      && `s2_fire(${liveMin}')`,
      isS3Fire      && `s3_fire(${liveMin}')`,
      isS5HTStore   && `s5_htstore(${liveMin}')`,
      isS5Fire      && `s5_fire(${liveMin}')`,
      isSS6HTStore  && `ss6_htstore(${liveMin}')`,
      isSS6Fire     && `ss6_fire(${liveMin}')`,
    ].filter(Boolean).join(' ');

    flogv(liveMin, `${label} [${tier}]`, 'ALL', `in-window: ${windows}  score=${match.score || '—'}  odds=${match.odds ? 'ok' : 'MISSING'}`);

    await runStrategySXY(match, ctx);
    await runStrategy6(match, ctx);
    await runStrategy7(match, ctx);
    await runStrategySN(match, ctx);
    await runStrategy8(match, ctx);
    await runStrategy9(match, ctx);
    await runStrategy10(match, ctx);
    await runStrategy11(match, ctx);
    await runStrategy12(match, ctx);
    await runStrategyS1(match, ctx);
    await runStrategyS2(match, ctx);
    await runStrategyS3(match, ctx);
    await runStrategyS5(match, ctx);
    await runStrategySS6(match, ctx);
  }

  console.log(`Scan done — ${matches.length} matches · ${inWindowCount} in window · ${_scanAlerts} alert(s) sent.`);
}

// ── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  const once = process.argv.includes('--once');

  await loadDb();

  const on = s => s ? 'ON ' : 'OFF';
  console.log(`Strategy SX [${on(cfg.SX_ENABLED)}][${cfg.SX_TIER}]: Conf. Fav steam → 1x2 home win  (${cfg.SXSY_EARLY_MIN}–${cfg.SXSY_EARLY_MAX}' + 30' + HT  |  min steam ${cfg.SXSY_MIN_STEAM}  |  books Pin+any1)`);
  console.log(`Strategy SY [${on(cfg.SY_ENABLED)}][${cfg.SY_TIER}]: Steam Away Fav steam → 1x2 away win  (same windows  |  min steam ${cfg.SXSY_MIN_STEAM}  |  books 3/3 required)`);
  console.log(`Strategy S6 [${on(cfg.S6_ENABLED)}][${cfg.S6_TIER}]: Market edge ≥${cfg.MKT_EDGE_THRESH}pp  n≥${cfg.MKT_EDGE_MIN_N}  window=${cfg.S6_WINDOW_MINUTES}min`);
  console.log(`Strategy S7 [${on(cfg.S7_ENABLED)}][${cfg.S7_TIER}]: Bet365 vs Pinnacle AH line gap ≥${cfg.S7_MIN_HC_DIFF}  (live ${cfg.ALERT_MIN_MINUTE}–${cfg.ALERT_MAX_MINUTE}')`);
  console.log(`Strategy SN [${on(cfg.SN_ENABLED)}][${cfg.SN_TIER}]: Pre-match steam  AH≥${cfg.SN_MIN_AH_MOVE} + TL≥${cfg.SN_MIN_TL_MOVE}  days=0-${cfg.SN_MAX_DAYS}  b365_lag≥${cfg.SN_B365_LAG_MIN}`);
  console.log(`Strategy S8  [${on(cfg.S8_ENABLED)}][${cfg.S8_TIER}]: Pin homeSteam≥${cfg.S8_MIN_HOME_STEAM} + TL≥${cfg.S8_MIN_TL_MOVE} + ahHc≤${cfg.S8_AH_HC_MAX}  fire=${cfg.S8_FIRE_MIN}-${cfg.S8_FIRE_MAX}'`);
  console.log(`Strategy S9  [${on(cfg.S9_ENABLED)}][${cfg.S9_TIER}]: (sbobet)  ahHc≤${cfg.S9_AH_HC_MAX}  lineStable + hoOddsDrop≥${cfg.S9_MIN_HO_ODDS_DROP} + tlStable + ovDrop≥${cfg.S9_MIN_OV_ODDS_DROP}  fire=${cfg.S9_FIRE_MIN}-${cfg.S9_FIRE_MAX}'`);
  console.log(`Strategy S10 [${on(cfg.S10_ENABLED)}][${cfg.S10_TIER}]: (sbobet)  ahHc[${cfg.S10_AH_HC_MIN},${cfg.S10_AH_HC_MAX}]  lineStable + hoOddsRise≥${cfg.S10_MIN_HO_ODDS_RISE} + tlStable  fire=${cfg.S10_FIRE_MIN}-${cfg.S10_FIRE_MAX}'`);
  console.log(`Strategy S11 [${on(cfg.S11_ENABLED)}][${cfg.S11_TIER}]: Pin+Sbo  pinAhHc≤${cfg.S11_PIN_AH_HC_MAX} pinSteam≥${cfg.S11_PIN_MIN_HOME_STEAM} + sboLineStable + sboOddsSteam≥${cfg.S11_SBO_MIN_HO_ODDS_STEAM}  fire=${cfg.S11_FIRE_MIN}-${cfg.S11_FIRE_MAX}'`);
  console.log(`Strategy S12 [${on(cfg.S12_ENABLED)}][${cfg.S12_TIER}]: Pin lineSteam≥${cfg.S12_MIN_LINE_STEAM} + oddsSteam≥${cfg.S12_MIN_ODDS_STEAM}  fire=${cfg.S12_FIRE_MIN}-${cfg.S12_FIRE_MAX}'  (fav drawing/losing)`);
  console.log(`Strategy Sbobet_S1 [${on(cfg.S1_ENABLED)}][${cfg.S1_TIER}]: (sbobet_odds)  AH_odds≤${cfg.S1_MIN_AH_ODDS_MOVE} + Over≤${cfg.S1_MIN_OV_ODDS_MOVE}  ahLine[${cfg.S1_AH_LINE_MIN},${cfg.S1_AH_LINE_MAX}]  TL[${cfg.S1_TL_MIN},${cfg.S1_TL_MAX}]  fire=${cfg.S1_FIRE_MIN}-${cfg.S1_FIRE_MAX}'`);
  console.log(`Strategy Sbobet_S2 [${on(cfg.S2_ENABLED)}][${cfg.S2_TIER}]: (sbobet_odds)  same prematch as S1  HT=1-1  scoreDiff≤${cfg.S2_MAX_SCORE_DIFF}  goals≤${cfg.S2_MAX_TOTAL_GOALS}  fire=${cfg.S2_FIRE_MIN}-${cfg.S2_FIRE_MAX}'`);
  console.log(`Strategy Sbobet_S3 [${on(cfg.S3_ENABLED)}][${cfg.S3_TIER}]: (sbobet_odds)  lineMove≥${cfg.S3_MIN_LINE_MOVE} + awayOddsDrop≤${cfg.S3_MIN_AWAY_ODDS_DROP}  ahLine[${cfg.S3_AH_LINE_MIN},${cfg.S3_AH_LINE_MAX}]  TL[${cfg.S3_TL_MIN},${cfg.S3_TL_MAX}]  fire=${cfg.S3_FIRE_MIN}-${cfg.S3_FIRE_MAX}'  minOdds=${cfg.S3_MIN_ODDS}`);
  console.log(`Strategy Sbobet_S5 [${on(cfg.S5_ENABLED)}][${cfg.S5_TIER}]: (sbobet_odds)  overDrop≤${cfg.S5_MIN_OV_DROP} + TLflat/up  TL[${cfg.S5_TL_MIN},${cfg.S5_TL_MAX}]  HT_goals≤${cfg.S5_HT_MAX_GOALS}  fire=${cfg.S5_FIRE_MIN}-${cfg.S5_FIRE_MAX}'`);
  console.log(`Strategy Sbobet_S6 [${on(cfg.SS6_ENABLED)}][${cfg.SS6_TIER}]: (sbobet_odds)  awayDrop≤${cfg.SS6_MIN_AWAY_DROP}  ahLine[${cfg.SS6_AH_LINE_MIN},${cfg.SS6_AH_LINE_MAX}]  TL[${cfg.SS6_TL_MIN},${cfg.SS6_TL_MAX}]  HTdeficit≤${cfg.SS6_MAX_AWAY_DEFICIT}  goals≤${cfg.SS6_MAX_TOTAL_GOALS}  fire=${cfg.SS6_FIRE_MIN}-${cfg.SS6_FIRE_MAX}'  minOdds=${cfg.SS6_MIN_ODDS}`);
  console.log(`Global tier default: ${cfg.LEAGUE_TIER}`);

  // Refresh all book hashes at startup
  await refreshHashes();

  if (once) {
    await runScan();
    process.exit(0);
  }

  console.log(`Scheduler started — every ${cfg.SCAN_INTERVAL_MINUTES} min.`);
  await runScan();
  cron.schedule(`*/${cfg.SCAN_INTERVAL_MINUTES} * * * *`, runScan);
  // Refresh hashes daily at 06:00 UTC (hashes rotate ~once/day)
  cron.schedule('0 6 * * *', () => refreshHashes().catch(e => console.error('Hash refresh error:', e)));
}

main().catch(e => { console.error(e); process.exit(1); });
