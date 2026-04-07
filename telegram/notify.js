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
const { fetchLiveMatches, fetchNextMatches, refreshHashes } = require('./livescore');

const VERBOSE = process.argv.includes('--verbose');
const verbose = VERBOSE ? (...a) => console.log(...a) : () => {};

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
function buildMessage(emoji, title, match, tier, timing, context, betLines) {
  return [
    `${emoji} <b>${title}</b>  ·  ${nowTime()}`,
    ``,
    `🏆 <i>${esc(match.league) || '—'}</i>  [${tierBadge(tier)}]`,
    `⚽ <b>${esc(match.home_team)} vs ${esc(match.away_team)}</b>`,
    `${timing}`,
    ``,
    `📊 ${context}`,
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

  // All 3 books must be present — if any is missing, skip entirely
  if (!pin  || pin.ah_ho  == null || pin.ah_hc  == null) return null;
  if (!b365 || b365.ah_ho == null || b365.ah_hc == null) return null;
  if (!sbo  || sbo.ah_ho  == null || sbo.ah_hc  == null) return null;

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

  const pinSteam  = pin.ah_ho  - pin.ah_hc;
  const b365Steam = b365.ah_ho - b365.ah_hc;
  const sboSteam  = sbo.ah_ho  - sbo.ah_hc;

  // All 3 books must confirm AH steam in the same direction
  if (pinSteam  * dir < minSteam) return null;
  if (b365Steam * dir < minSteam) return null;
  if (sboSteam  * dir < minSteam) return null;

  // TL must rise on all 3 books
  if (pin.tl_c  == null || pin.tl_o  == null || pin.tl_c  <= pin.tl_o)  return null;
  if (b365.tl_c == null || b365.tl_o == null || b365.tl_c <= b365.tl_o) return null;
  if (sbo.tl_c  == null || sbo.tl_o  == null || sbo.tl_c  <= sbo.tl_o)  return null;

  return {
    type:     favSide === 'HOME' ? 'SX' : 'SY',
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
  const favTeam = isSX ? esc(match.home_team) : esc(match.away_team);
  const dir     = isSX ? 1 : -1;
  const arrow   = isSX ? '→ HOME' : '→ AWAY';
  const tlFmt   = (o, c) => `${o.toFixed(2)} → ${c.toFixed(2)}  (+${(c - o).toFixed(2)})`;
  const minOdds = isSX ? '1.46' : '1.42';
  const winRate = isSX ? '71.8%' : '74.1%';
  const n       = isSX ? '1,151' : '378';
  const betLines = [
    `📊 3/3 books ${arrow}  (structural fav)`,
    `   Pin:  AH ${sxyBookLine(sd.pinAhHo,  sd.pinAhHc,  dir)}  |  TL ${tlFmt(sd.tlO,     sd.tlC)}`,
    `   B365: AH ${sxyBookLine(sd.b365AhHo, sd.b365AhHc, dir)}  |  TL ${tlFmt(sd.b365TlO, sd.b365TlC)}`,
    `   Sbo:  AH ${sxyBookLine(sd.sboAhHo,  sd.sboAhHc,  dir)}  |  TL ${tlFmt(sd.sboTlO,  sd.sboTlC)}`,
    ``,
    `💰 1x2 <b>${isSX ? 'HOME' : 'AWAY'} WIN</b> at soft books`,
    `   Min odds: @${minOdds}  ·  ${winRate} win rate  ·  n=${n}`,
    `   ⚠️ Skip AH and Over — already repriced`,
  ];
  return buildMessage(
    isSX ? '🏠' : '✈️',
    isSX ? 'CONF. FAV — 3-BOOK STEAM' : 'STEAM FAV — 3-BOOK STEAM',
    match, tier,
    `⏱ ${esc(match.minute)}'  ${match.score || '0-0'}`,
    favTeam,
    betLines,
  );
}

function sxyAlert2Format(match, sd, tier, liveMin) {
  const isSX    = sd.type === 'SX';
  const favTeam = isSX ? esc(match.home_team) : esc(match.away_team);
  const minsLeft = 45 - liveMin;
  const betLines = [
    `Steam confirmed (3/3 books → ${isSX ? 'HOME' : 'AWAY'})`,
    `Avg goals in 1H for steamed games: 1.49  vs baseline 1.16`,
    ``,
    `💰 <b>Over 0.5 1H</b> (in-play)`,
    `   ~${minsLeft} min left · check live odds`,
  ];
  return buildMessage(
    '⚡',
    'STEAM + 0-0 AT 30\' — OVER 0.5 1H',
    match, tier,
    `⏱ ${liveMin}'  0-0`,
    favTeam,
    betLines,
  );
}

function sxyAlert3Format(match, sd, htScore, tier, liveMin) {
  const isSX     = sd.type === 'SX';
  const favTeam  = isSX ? esc(match.home_team) : esc(match.away_team);
  const htStr    = `${htScore.home}-${htScore.away}`;
  const favGoals = isSX ? htScore.home : htScore.away;
  const dogGoals = isSX ? htScore.away : htScore.home;

  let htState, primaryBet, primaryRate, secondaryLine, avoidLine;
  if (favGoals > dogGoals) {
    htState      = `${isSX ? 'Home' : 'Away'} leads`;
    primaryBet   = `1x2 <b>${isSX ? 'HOME' : 'AWAY'} WIN</b> live`;
    primaryRate  = isSX ? '91.5%' : '92.1%';
    secondaryLine = `💰 2H Over 0.5  →  ${isSX ? '83.9%' : '84.4%'}`;
    avoidLine     = '⚠️ Skip BTTS and FT Over';
  } else if (favGoals === 0 && dogGoals === 0) {
    htState      = '0-0';
    primaryBet   = `1x2 <b>${isSX ? 'HOME' : 'AWAY'} WIN</b> live`;
    primaryRate  = isSX ? '56.1%' : '60.0%';
    secondaryLine = `💰 2H Over 0.5  →  ${isSX ? '83.9%' : '84.4%'}`;
    avoidLine     = '⚠️ Skip Over and BTTS';
  } else if (favGoals === dogGoals) {
    htState      = `Draw (${htStr})`;
    primaryBet   = `1x2 <b>${isSX ? 'HOME' : 'AWAY'} WIN</b> live`;
    primaryRate  = isSX ? '55.1%' : '57.0%';
    secondaryLine = `💰 BTTS  →  ${isSX ? '51.1%' : '52.1%'}`;
    avoidLine     = '⚠️ Skip FT Over';
  } else {
    htState      = `${isSX ? 'Away' : 'Home'} leads — switch`;
    primaryBet   = '1x2 <b>BTTS</b> (opposite side leads)';
    primaryRate  = isSX ? '80.7%' : '82.9%';
    secondaryLine = '💰 2H Over 0.5';
    avoidLine     = `⚠️ Skip ${isSX ? 'HOME' : 'AWAY'} WIN — too risky`;
  }

  const minsLeft = 90 - (liveMin ?? 57);
  const betLines = [
    `HT: ${htStr} → still no 2H goal  (~${minsLeft} min left)`,
    `Steam: 3/3 books → ${isSX ? 'HOME' : 'AWAY'} ✅  |  HT state: ${htState}`,
    ``,
    `💰 ${primaryBet}  →  ${primaryRate}`,
    secondaryLine,
    avoidLine,
  ];
  return buildMessage(
    '📊',
    isSX ? 'CONF. FAV — NO 2H GOAL' : 'STEAM FAV — NO 2H GOAL',
    match, tier,
    `⏱ ${liveMin ?? '~57'}'  ${match.score || htStr}`,
    favTeam,
    betLines,
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
      console.log(`  SXY SKIP alert1 [no signal: pin=${pinOk?'ok':'MISS'} b365=${b365Ok?'ok':'MISS'} sbo=${sboOk?'ok':'MISS'}]  ${label}`);
    } else {
      const enabled = sd.type === 'SX' ? cfg.SX_ENABLED : cfg.SY_ENABLED;
      const tier_   = sd.type === 'SX' ? cfg.SX_TIER    : cfg.SY_TIER;
      if (!enabled) {
        console.log(`  SXY SKIP alert1 [${sd.type} disabled]  ${label}`);
      } else if (!tierAllowed(tier, tier_)) {
        console.log(`  SXY SKIP alert1 [tier=${tier} not in ${tier_}]  ${label}`);
      } else {
        if (!sxyCandidates.has(matchId)) {
          sxyCandidates.set(matchId, { ...sd, storedAt: Date.now() });
          console.log(`  SXY candidate stored: ${label}  type=${sd.type}  books=${sd.confirmedBooks}/3`);
        }
        const key1 = `${matchId}:${sd.type.toLowerCase()}:1`;
        if (!sxyDedup.has(key1)) {
          const msg = sxyAlert1Format(match, sd, tier);
          await sendTelegram(msg);
          sxyDedup.mark(key1);
          console.log(`${sd.type} ALERT 1 → ${label}  min=${liveMin}  books=${sd.confirmedBooks}/3  tier=${tier}`);
        } else {
          verbose(`  ${sd.type} SKIP alert1 [already notified]  ${label}`);
        }
      }
    }
  }

  // ── Alert 2: 30' check — still 0-0 → Over 0.5 1H ───────────────────────
  if (isSXYMidH) {
    const cand = sxyCandidates.get(matchId);
    if (!cand) { console.log(`  SXY SKIP alert2 [no candidate stored — match missed alert1 window?]  ${label}`); }
    else {
      const enabled = cand.type === 'SX' ? cfg.SX_ENABLED : cfg.SY_ENABLED;
      const tier_   = cand.type === 'SX' ? cfg.SX_TIER    : cfg.SY_TIER;
      if (enabled && tierAllowed(tier, tier_)) {
        const key2 = `${matchId}:${cand.type.toLowerCase()}:2`;
        if (sxyDedup.has(key2)) {
          verbose(`  ${cand.type} SKIP alert2 [already notified]  ${label}`);
        } else {
          const score = parseScoreStr(match.score);
          if (score && score.home === 0 && score.away === 0) {
            const msg = sxyAlert2Format(match, cand, tier, liveMin);
            await sendTelegram(msg);
            sxyDedup.mark(key2);
            console.log(`${cand.type} ALERT 2 → ${label}  min=${liveMin}  score=0-0  tier=${tier}`);
          } else {
            verbose(`  ${cand.type} SKIP alert2 [score not 0-0: ${match.score}]  ${label}`);
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
        console.log(`  SXY HT score stored: ${label}  HT=${score.home}-${score.away}`);
      }
    }
  }

  // ── Alert 3 — fire at 55–60' if no 2H goal yet ───────────────────────────
  if (isSXYHTFire) {
    const cand = sxyCandidates.get(matchId);
    if (!cand || !cand.htScore) {
      verbose(`  SXY SKIP alert3 [no HT score stored]  ${label}`);
    } else {
      const enabled = cand.type === 'SX' ? cfg.SX_ENABLED : cfg.SY_ENABLED;
      const tier_   = cand.type === 'SX' ? cfg.SX_TIER    : cfg.SY_TIER;
      if (enabled && tierAllowed(tier, tier_)) {
        const key3 = `${matchId}:${cand.type.toLowerCase()}:3`;
        if (sxyDedup.has(key3)) {
          verbose(`  ${cand.type} SKIP alert3 [already notified]  ${label}`);
        } else {
          const curScore = parseScoreStr(match.score);
          if (!curScore) { verbose(`  ${cand.type} SKIP alert3 [no current score]  ${label}`); }
          else {
            const goals2H = (curScore.home + curScore.away) - (cand.htScore.home + cand.htScore.away);
            if (goals2H > 0) {
              verbose(`  ${cand.type} SKIP alert3 [${goals2H} goal(s) already in 2H]  ${label}`);
            } else {
              const msg = sxyAlert3Format(match, cand, cand.htScore, tier, liveMin);
              await sendTelegram(msg);
              sxyDedup.mark(key3);
              console.log(`${cand.type} ALERT 3 → ${label}  min=${liveMin}  HT=${cand.htScore.home}-${cand.htScore.away}  now=${curScore.home}-${curScore.away}  tier=${tier}`);
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

function s6Format(match, matchCfg, poolN, bets, b365, tier, timing) {
  const { signals, fav_line, fav_side } = matchCfg;
  const favTeam  = fav_side === 'HOME' ? esc(match.home_team) : esc(match.away_team);
  const dogTeam  = fav_side === 'HOME' ? esc(match.away_team) : esc(match.home_team);
  const sigStr   = buildSignalBadges(signals);
  const betLines = bets.map(b => {
    const b365Odds = getB365OddsForBet(b.k, b365, fav_side);
    const b365Str  = b365Odds != null ? `Bet365: <b>${b365Odds.toFixed(2)}</b> ✅` : 'Bet365: n/a';
    const betLabel = b.avgTl != null ? b.label.replace('Total Line', `TL ${b.avgTl.toFixed(2)}`) : b.label;
    const edgeSign = b.mkt_edge >= 0 ? '+' : '';
    let teamStr = '';
    if (b.k === 'ahCover')  teamStr = `\n   🎯 <b>${favTeam}  −${Number(fav_line).toFixed(2)}</b>`;
    if (b.k === 'dogCover') teamStr = `\n   🎯 <b>${dogTeam}  +${Number(fav_line).toFixed(2)}</b>`;
    return (
      `💰 ${betLabel}` +
      teamStr + `\n` +
      `   Pinnacle avg ${b.mkt_avg_odds} + \n`
      `   ${b365Str} + \n`    
      `   n=${b.n}`
    );
  });
  return buildMessage('📈', 'MKT EDGE', match, tier, timing,
    `${favTeam} −${Number(fav_line).toFixed(2)}  ·  ${sigStr}  ·  pool: ${poolN}`,
    betLines,
  );
}

async function runStrategy6(match, ctx) {
  const { matchId, label, tier, liveMin, minsToKickoff, isMktEdge } = ctx;

  if (!cfg.S6_ENABLED) { console.log(`  S6 SKIP [disabled]  ${label}`); return; }
  if (!tierAllowed(tier, cfg.S6_TIER)) { console.log(`  S6 SKIP [tier=${tier} not in ${cfg.S6_TIER}]  ${label}`); return; }
  if (!isMktEdge) { console.log(`  S6 SKIP [not in mkt window min=${liveMin}]  ${label}`); return; }
  if (!_dbAll || !_dbAll.length) { console.log(`  S6 SKIP [DB empty]  ${label}`); return; }
  if (!match.odds) { console.log(`  S6 SKIP [no odds]  ${label}`); return; }

  const matchCfg = buildCfgFromMatch(match.odds, { LINE_MOVE_ON: true, TL_MOVE_ON: true });
  if (!matchCfg) { console.log(`  S6 SKIP [buildCfg returned null — odds incomplete?]  ${label}`); return; }

  const { signals } = matchCfg;
  const hasMovement =
    (signals.lineMove !== 'STABLE' && signals.lineMove !== 'UNKNOWN') ||
    (signals.tlMove   !== 'STABLE' && signals.tlMove   !== 'UNKNOWN');

  if (!hasMovement) {
    console.log(`  S6 SKIP [no movement: lm=${signals.lineMove} tlm=${signals.tlMove}]  ${label}`);
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
    console.log(`  S6 SKIP [no qualifying bets — pool=${cfgRows.length} ${best} thresh=${cfg.MKT_EDGE_THRESH}pp]  ${label}`);
    return;
  }

  const mktKey = `${matchId}:mktedge`;
  if (s6Dedup.has(mktKey)) {
    verbose(`  S6 SKIP [already notified]  ${label}`);
    return;
  }

  const b365 = await fetchBet365Data(matchId);

  // Drop bets where Bet365 odds are available but below the historical Pinnacle avg.
  const toFire = qualifying.filter(b => {
    const b365Odds = getB365OddsForBet(b.k, b365, matchCfg.fav_side);
    return b365Odds == null || b365Odds > b.mkt_avg_odds;
  });

  if (!toFire.length) {
    console.log(`  S6 SKIP [all qualifying bets below B365 threshold — b365=${b365 ? 'ok' : 'null'}]  ${label}`);
    return;
  }

  const score  = match.score || '0-0';
  const timing = `⏱ ${liveMin}'  ${score}`;

  const msg = s6Format(match, matchCfg, cfgRows.length, toFire, b365, tier, timing);
  await sendTelegram(msg);
  s6Dedup.mark(mktKey);
  console.log(`S6 ALERT → ${label}  pool=${cfgRows.length}  bets=${toFire.map(b => b.k).join(',')}  tier=${tier}`);
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

function s7Format(match, tier, timing, betTeam, b365Hc, b365Odds, pinHc, absDiff, minOdds) {
  const pinStr      = pinHc >= 0 ? `+${pinHc.toFixed(2)}` : pinHc.toFixed(2);
  const b365HcStr   = b365Hc >= 0 ? `+${b365Hc.toFixed(2)}` : b365Hc.toFixed(2);
  const strengthLabel = absDiff >= 0.75 ? '🔥 STRONG' : absDiff >= 0.50 ? '⚡ SOLID' : 'MILD';
  const oddsStr = `${b365Odds.toFixed(2)} ✅`;
  const betLines = [
    `💰 <b>${esc(betTeam)}  ${b365HcStr}</b>  at Bet365`,
    `   Pinnacle line: ${pinStr}  ·  gap: <b>+${absDiff.toFixed(2)}</b>  [${strengthLabel}]`,
    `   Bet365 odds: <b>${oddsStr}</b>   Min to bet: <b>${minOdds.toFixed(2)}</b>`,
  ];
  return buildMessage('↔️', 'B365 LINE GAP', match, tier,
    timing,
    `${esc(betTeam)} gets ${absDiff.toFixed(2)} extra goals vs Pinnacle sharp line`,
    betLines,
  );
}

async function runStrategy7(match, ctx) {
  const { matchId, label, tier, liveMin, isLive } = ctx;

  if (!cfg.S7_ENABLED) { console.log(`  S7 SKIP [disabled]  ${label}`); return; }
  if (!tierAllowed(tier, cfg.S7_TIER)) { console.log(`  S7 SKIP [tier=${tier} not in ${cfg.S7_TIER}]  ${label}`); return; }
  if (!isLive) { console.log(`  S7 SKIP [not in live window min=${liveMin}/${cfg.ALERT_MIN_MINUTE}-${cfg.ALERT_MAX_MINUTE}]  ${label}`); return; }
  if (!match.odds) { console.log(`  S7 SKIP [no odds]  ${label}`); return; }

  const pinHc = match.odds.ah_hc;
  if (pinHc == null) { console.log(`  S7 SKIP [no ah_hc in Pinnacle odds]  ${label}`); return; }

  const b365 = await fetchBet365Data(matchId);
  if (!b365 || b365.ahHc == null) {
    console.log(`  S7 SKIP [no B365 data for matchId=${matchId}]  ${label}`);
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
    console.log(`  S7 SKIP [hcDiff=${hcDiff.toFixed(2)} < ±${cfg.S7_MIN_HC_DIFF}  pin=${pinHc.toFixed(2)} b365=${b365Hc.toFixed(2)}]  ${label}`);
    return;
  }

  const absDiff = Math.abs(hcDiff);
  const minOdds = s7MinOdds(absDiff);

  // Only fire if Bet365 odds are confirmed at or above the break-even minimum
  if (b365Odds == null || b365Odds < minOdds) {
    console.log(`  S7 SKIP [b365Odds=${b365Odds != null ? b365Odds.toFixed(2) : 'n/a'} < minOdds=${minOdds.toFixed(2)}  diff=${absDiff.toFixed(2)}]  ${label}`);
    return;
  }

  const dedupKey = `${matchId}:s7:${betSide}`;
  if (s7Dedup.has(dedupKey)) {
    verbose(`  S7 SKIP [already notified]  ${label}`);
    return;
  }

  const timing = `⏱ ${liveMin}'  ${match.score || '0-0'}`;
  const msg = s7Format(match, tier, timing, betTeam, b365Hc, b365Odds, pinHc, absDiff, minOdds);
  await sendTelegram(msg);
  s7Dedup.mark(dedupKey);
  console.log(`S7 ALERT → ${label}  side=${betSide}  pinHc=${pinHc.toFixed(2)}  b365Hc=${b365Hc.toFixed(2)}  diff=${absDiff.toFixed(2)}  b365Odds=${b365Odds != null ? b365Odds.toFixed(2) : 'n/a'}  minOdds=${minOdds.toFixed(2)}  tier=${tier}`);
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
      try {
        const r = await fetchNextMatches();
        nextMatches        = r.matches;
        pinnacleHashFailed = pinnacleHashFailed || r.pinnacleHashFailed;
        bet365HashFailed   = bet365HashFailed   || r.bet365HashFailed;
        if (r.pinnacleHash) pinnacleHash = r.pinnacleHash;
        if (r.bet365Hash)   bet365Hash   = r.bet365Hash;
      } catch (e) { console.error(`NextGame fetch failed: ${e.message}`); }
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
    try {
      const nextResult = await fetchNextMatches();
      nextMatches        = nextResult.matches;
      pinnacleHashFailed = pinnacleHashFailed || nextResult.pinnacleHashFailed;
      bet365HashFailed   = bet365HashFailed   || nextResult.bet365HashFailed;
      if (nextResult.pinnacleHash) pinnacleHash = nextResult.pinnacleHash;
      if (nextResult.bet365Hash)   bet365Hash   = nextResult.bet365Hash;
    } catch (e) { console.error(`NextGame fetch failed: ${e.message}`); }
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

// ── Core scan ─────────────────────────────────────────────────────────────────
async function runScan() {
  console.log(`[${new Date().toISOString()}] Scanning…`);

  let matches;
  try { matches = await fetchMatches(); }
  catch (e) { console.error(`Livescore fetch failed: ${e.message}`); return; }

  if (!matches.length) { console.log('No matches found.'); return; }
  console.log(`Found ${matches.length} match(es).`);

  cleanupSxyCandidates();

  let inWindowCount = 0;

  for (const match of matches) {
    const ctx = matchContext(match);
    const { label, tier, liveMin, minsToKickoff, isLive, isUpcoming, isMktEdge, isSXYEarly, isSXYMidH, isSXYHTStore, isSXYHTFire } = ctx;

    const anyWindow = isLive || isUpcoming || isMktEdge || isSXYEarly || isSXYMidH || isSXYHTStore || isSXYHTFire;
    if (!anyWindow) {
      const reason = minsToKickoff != null
        ? `min_to_ko=${minsToKickoff.toFixed(1)}`
        : `min=${liveMin ?? 'no_time'}`;
      verbose(`  SKIP [${reason}]  ${label}`);
      continue;
    }

    inWindowCount++;
    const windows = [
      isLive        && `live(${cfg.ALERT_MIN_MINUTE}-${cfg.ALERT_MAX_MINUTE}')`,
      isUpcoming    && `upcoming(${minsToKickoff != null ? minsToKickoff.toFixed(1) + 'min' : '?'})`,
      isMktEdge     && `mktedge(${liveMin}')`,
      isSXYEarly    && `sxy_early(${liveMin}')`,
      isSXYMidH     && `sxy_midh(${liveMin}')`,
      isSXYHTStore  && `sxy_htstore(${liveMin}')`,
      isSXYHTFire   && `sxy_htfire(${liveMin}')`,
    ].filter(Boolean).join(' ');
    console.log(`  IN-WINDOW  ${label}  [${tier}]  windows=${windows}  score=${match.score || '—'}  odds_ok=${match.odds ? 'yes' : 'NO'}`);

    await runStrategySXY(match, ctx);
    await runStrategy6(match, ctx);
    await runStrategy7(match, ctx);
  }

  console.log(`Scan done — ${matches.length} matches, ${inWindowCount} in window.`);
}

// ── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  const once = process.argv.includes('--once');

  await loadDb();

  const on = s => s ? 'ON ' : 'OFF';
  console.log(`Strategy SX [${on(cfg.SX_ENABLED)}][${cfg.SX_TIER}]: Conf. Fav 3-book steam → 1x2 home win  (${cfg.SXSY_EARLY_MIN}–${cfg.SXSY_EARLY_MAX}' + 30' + HT  |  min steam ${cfg.SXSY_MIN_STEAM}  |  min books ${cfg.SXSY_MIN_BOOKS}/3)`);
  console.log(`Strategy SY [${on(cfg.SY_ENABLED)}][${cfg.SY_TIER}]: Steam Away Fav 3-book steam → 1x2 away win  (same windows)`);
  console.log(`Strategy S6 [${on(cfg.S6_ENABLED)}][${cfg.S6_TIER}]: Market edge ≥${cfg.MKT_EDGE_THRESH}pp  n≥${cfg.MKT_EDGE_MIN_N}  window=${cfg.S6_WINDOW_MINUTES}min`);
  console.log(`Strategy S7 [${on(cfg.S7_ENABLED)}][${cfg.S7_TIER}]: Bet365 vs Pinnacle AH line gap ≥${cfg.S7_MIN_HC_DIFF}  (live ${cfg.ALERT_MIN_MINUTE}–${cfg.ALERT_MAX_MINUTE}')`);
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
