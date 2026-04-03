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
  applyConfig, applyBaselineConfig, applyGameState,
  buildCfgFromMatch, scoreBets, computeHtAsSignalProbe,
} = require('./engine');
const { fetchLiveMatches, fetchNextMatches } = require('./livescore');

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

// True when the match is at halftime (raw minute field = 'HT' or ≥ 45 in HT window).
function isAtHT(rawMin, liveMin) {
  return rawMin === 'HT' || (liveMin != null && liveMin >= 45);
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
    isMktEdge:     minsToKickoff != null && minsToKickoff >= 0 && minsToKickoff <= cfg.S6_WINDOW_MINUTES,
    isHT:          liveMin != null && liveMin >= cfg.HT_MIN_MINUTE && liveMin <= cfg.HT_MAX_MINUTE,
    isSFHTFire:    liveMin != null && liveMin >= cfg.S2_FIRE_MIN_MINUTE && liveMin <= cfg.S2_FIRE_MAX_MINUTE,
    isTLM1H:       liveMin != null && liveMin >= cfg.TLM1H_MIN_MINUTE && liveMin <= cfg.TLM1H_MAX_MINUTE,
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

// AH arrow: "−0.25 → −0.75  +0.50"
function ahArrow(favLc, favLo) {
  const oStr = favLo < 0.01 ? '0.00' : `−${favLo.toFixed(2)}`;
  return `${oStr} → −${favLc.toFixed(2)}  <b>+${(favLc - favLo).toFixed(2)}</b>`;
}

// Build signal badges string from a signals object (shared by S5 and S6).
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
    `⚽ <b>${esc(match.home_team)} vs ${esc(match.away_team)}</b>`,
    `🏆 <i>${esc(match.league) || '—'}</i>  [${tierBadge(tier)}]`,
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

// ── Strategy 1: AH Steam → Bet Dog AH ─────────────────────────────────────────
// Backtest (TOP+MAJOR, 12m OOS, n=934): 55.8% win rate · +21% ROI
const s1Dedup = new Dedup(3 * 60 * 60 * 1000);

function s1FormatLive(match, steam, tier, b365DogOc) {
  const { favSide, favLc, favLo, dogOc } = steam;
  const favTeam = favSide === 'HOME' ? esc(match.home_team) : esc(match.away_team);
  const dogTeam = favSide === 'HOME' ? esc(match.away_team) : esc(match.home_team);
  const betLines = [
    `💰 <b>${dogTeam}  +${favLc.toFixed(2)}</b>  (min: @${dogOc.toFixed(2)})`,
    `   Bet365: ${b365DogOc != null ? `<b>${b365DogOc.toFixed(2)}</b> ✅` : 'n/a'}`,
  ];
  return buildMessage('🚨', 'STEAM → DOG AH', match, tier,
    `⏱ ${esc(match.minute)}'  ${esc(match.score) || '0-0'}`,
    `${favTeam} (fav)  ${ahArrow(favLc, favLo)}`,
    betLines,
  );
}

function s1FormatUpcoming(match, steam, tier, minsToKickoff, b365DogOc) {
  const { favSide, favLc, favLo, dogOc } = steam;
  const favTeam = favSide === 'HOME' ? esc(match.home_team) : esc(match.away_team);
  const dogTeam = favSide === 'HOME' ? esc(match.away_team) : esc(match.home_team);
  const koTime  = match.kickoff_time ? kickoffTimeLabel(match.kickoff_time) : null;
  const minsRnd = Math.round(minsToKickoff);
  const timing  = koTime
    ? `🕐 ${koTime}  (${minsRnd <= 1 ? 'now' : `in ${minsRnd} min`})`
    : `⏳ ${minsRnd <= 1 ? 'kicks off now' : `kicks off in ${minsRnd} min`}`;
  const betLines = [
    `💰 <b>${dogTeam}  +${favLc.toFixed(2)}</b>  (min: @${dogOc.toFixed(2)})`,
    `   Bet365: ${b365DogOc != null ? `<b>${b365DogOc.toFixed(2)}</b> ✅` : 'n/a'}`,
  ];
  return buildMessage('⏰', 'PRE-KICK STEAM → DOG AH', match, tier,
    timing,
    `${favTeam} (fav)  ${ahArrow(favLc, favLo)}`,
    betLines,
  );
}

async function runStrategy1(match, ctx) {
  const { matchId, label, tier, steam, liveMin, minsToKickoff, isLive, isUpcoming } = ctx;

  if (!cfg.S1_ENABLED || !tierAllowed(tier, cfg.S1_TIER)) return;
  if (!isLive && !isUpcoming) return;
  if (!steam) { verbose(`  S1 SKIP [no odds]  ${label}`); return; }

  const { steam: steamMag, dogOc } = steam;

  if (steamMag < cfg.LM_STEAM_MIN) {
    verbose(`  S1 SKIP [steam=${steamMag.toFixed(2)} < ${cfg.LM_STEAM_MIN}]  ${label}`);
    return;
  }
  if (!dogOc || dogOc < 1.01 || dogOc > 20) {
    verbose(`  S1 SKIP [invalid dog_oc=${dogOc}]  ${label}`);
    return;
  }
  if (s1Dedup.has(matchId)) {
    verbose(`  S1 SKIP [already notified]  ${label}`);
    return;
  }

  // Bet365 check: same AH line required + dog odds must beat Pinnacle
  const b365 = await fetchBet365Data(matchId);
  let b365DogOc = null;

  if (b365 && b365.ahHc != null) {
    if (Math.abs(b365.ahHc - (match.odds.ah_hc || 0)) >= 0.13) {
      verbose(`  S1 SKIP [B365 AH line=${b365.ahHc} != pinnacle=${match.odds.ah_hc}]  ${label}`);
      return;
    }
    b365DogOc = steam.favSide === 'HOME' ? b365.aoC : b365.hoC;
    if (b365DogOc != null && b365DogOc < dogOc) {
      verbose(`  S1 SKIP [B365 dog_oc=${b365DogOc.toFixed(2)} < pinnacle=${dogOc.toFixed(2)}]  ${label}`);
      return;
    }
  }
  // b365 == null → oddsComp unavailable, fire anyway

  const steps = Math.round(steamMag / 0.25);
  let msg;
  if (isUpcoming) {
    msg = s1FormatUpcoming(match, steam, tier, minsToKickoff, b365DogOc);
    console.log(`S1 ALERT (pre-kick) → ${label}  ko_in=${minsToKickoff.toFixed(1)}min  steam=+${steamMag.toFixed(2)} (${steps} steps)  dog_oc=${dogOc.toFixed(2)}  b365=${b365DogOc != null ? b365DogOc.toFixed(2) : 'n/a'}  tier=${tier}`);
  } else {
    msg = s1FormatLive(match, steam, tier, b365DogOc);
    console.log(`S1 ALERT (live) → ${label}  steam=+${steamMag.toFixed(2)} (${steps} steps)  dog_oc=${dogOc.toFixed(2)}  b365=${b365DogOc != null ? b365DogOc.toFixed(2) : 'n/a'}  tier=${tier}`);
  }
  await sendTelegram(msg);
  s1Dedup.mark(matchId);
}

// ── Strategy 2: Strong Fav not winning at HT → Over 0.5 2H ───────────────────
// Store candidate at HT; fire at S2_FIRE window if still no 2H goal.
// Backtest (TOP+MAJOR, 12m OOS): 82% hit rate on Over 0.5 2H, n=3,800+
const s2HtCandidates = new Map();   // matchId → { htHome, htAway, steam, storedAt }
const s2Dedup        = new Dedup(3 * 60 * 60 * 1000);
const S2_CAND_TTL    = 3 * 60 * 60 * 1000;

function s2Format(match, htScore, steam, tier, liveMin) {
  const { favSide, favLc } = steam;
  const favTeam  = favSide === 'HOME' ? esc(match.home_team) : esc(match.away_team);
  const htStr    = `${htScore.home}-${htScore.away}`;
  const minsLeft = 90 - liveMin;
  const betLines = [
    `💰 <b>Over 0.5 2H</b>  (1.22 – 1.23)`,
    `   82% hit rate  ·  n=3,800+`,
  ];
  return buildMessage('⏰', 'STRONG FAV — NO 2H GOAL', match, tier,
    `⏱ ${liveMin}'  ${esc(match.score) || htStr}  (HT: ${htStr})`,
    `${favTeam} −${favLc.toFixed(2)}  ·  not winning at HT  ·  ~${minsLeft} min left  ·  no 2H goal yet`,
    betLines,
  );
}

async function runStrategy2(match, ctx) {
  const { matchId, label, tier, steam, liveMin, rawMin, isHT, isSFHTFire } = ctx;

  if (!cfg.S2_ENABLED || !tierAllowed(tier, cfg.S2_TIER)) return;
  if (!steam) return;

  // Store HT candidate when match enters HT window
  if (isHT && isAtHT(rawMin, liveMin) && steam.favLc >= cfg.S2_FAV_AH_MIN) {
    const score = parseScoreStr(match.score);
    if (score && !s2HtCandidates.has(matchId)) {
      const favGoals = steam.favSide === 'HOME' ? score.home : score.away;
      const dogGoals = steam.favSide === 'HOME' ? score.away : score.home;
      if (favGoals <= dogGoals) {
        s2HtCandidates.set(matchId, {
          htHome: score.home, htAway: score.away,
          steam, storedAt: Date.now(),
        });
        console.log(`  S2 HT candidate stored: ${label}  HT=${score.home}-${score.away}  AH=-${steam.favLc.toFixed(2)}`);
      }
    }
  }

  // Fire alert if still no 2H goal at S2_FIRE window
  if (isSFHTFire) {
    const cand = s2HtCandidates.get(matchId);
    if (!cand || s2Dedup.has(matchId)) {
      if (cand) verbose(`  S2 SKIP [already notified]  ${label}`);
      return;
    }
    const curScore = parseScoreStr(match.score);
    if (!curScore) return;
    const goals2H = (curScore.home + curScore.away) - (cand.htHome + cand.htAway);
    if (goals2H === 0) {
      const msg = s2Format(match, { home: cand.htHome, away: cand.htAway }, cand.steam, tier, liveMin);
      await sendTelegram(msg);
      s2Dedup.mark(matchId);
      console.log(`S2 ALERT → ${label}  min=${liveMin}  HT=${cand.htHome}-${cand.htAway}  now=${curScore.home}-${curScore.away}  tier=${tier}`);
    } else {
      verbose(`  S2 SKIP [${goals2H} goal(s) in 2H already]  ${label}`);
    }
  }
}

// ── Strategy 3: TLM steam + TL ≥ 2.5 + 0-0 at 25–32' → Over 0.5 1H ──────────
// Default OFF — backtest: ~52% hit rate, BE odds 1.94, not profitable.
// Set S3_ENABLED=true in config.js or Railway env to re-enable.
const s3Dedup = new Dedup(3 * 60 * 60 * 1000);

function s3Format(match, tlC, tlO, tier, liveMin) {
  const tlSteam  = tlC - tlO;
  const minsLeft = 45 - liveMin;
  const cluster  = tlC >= 3.0 ? '&gt;3.0' : '2.5–3.0';
  return [
    `⚡ <b>OVER 0.5 1H — STILL 0-0</b>  ·  ${nowTime()}`,
    ``,
    `🏆 <i>${esc(match.league) || '—'}</i>  [${tierBadge(tier)}]`,
    `⚽ <b>${esc(match.home_team)} vs ${esc(match.away_team)}</b>`,
    `🕐 <b>${liveMin}'</b>  Score: <b>0-0</b>  (~${minsLeft} min left in 1H)`,
    ``,
    `📈 TL steamed:  ${tlO.toFixed(2)} → ${tlC.toFixed(2)}  (+${tlSteam.toFixed(2)})`,
    `   Cluster: TL ${cluster}  ·  market expects goals`,
    ``,
    `💰 BET: <b>Over 0.5 goals — first half (in-play)</b>`,
  ].join('\n');
}

async function runStrategy3(match, ctx) {
  const { matchId, label, tier, liveMin, isTLM1H } = ctx;

  if (!cfg.S3_ENABLED || !tierAllowed(tier, cfg.S3_TIER)) return;
  if (!isTLM1H) return;
  if (!match.odds) { verbose(`  S3 SKIP [no odds]  ${label}`); return; }

  const { tl_c: tlC, tl_o: tlO } = match.odds;
  if (tlC == null || tlO == null) { verbose(`  S3 SKIP [no TL data]  ${label}`); return; }

  const tlSteam = tlC - tlO;
  if (tlC < cfg.TLM1H_MIN_TL) {
    verbose(`  S3 SKIP [TL=${tlC.toFixed(2)} < ${cfg.TLM1H_MIN_TL}]  ${label}`);
    return;
  }
  if (tlSteam < cfg.TLM1H_MIN_STEAM) {
    verbose(`  S3 SKIP [TLM steam=${tlSteam.toFixed(2)} < ${cfg.TLM1H_MIN_STEAM}]  ${label}`);
    return;
  }

  const score = parseScoreStr(match.score);
  if (!score || score.home !== 0 || score.away !== 0) {
    verbose(`  S3 SKIP [score not 0-0: ${match.score}]  ${label}`);
    return;
  }

  if (s3Dedup.has(matchId)) {
    verbose(`  S3 SKIP [already notified]  ${label}`);
    return;
  }

  const msg = s3Format(match, tlC, tlO, tier, liveMin);
  await sendTelegram(msg);
  s3Dedup.mark(matchId);
  console.log(`S3 ALERT → ${label}  min=${liveMin}  TL=${tlO.toFixed(2)}→${tlC.toFixed(2)} (+${tlSteam.toFixed(2)})  tier=${tier}`);
}

// ── Strategy 4: Fav leads +1 at HT, AH 0.25–1.00, TL ≤ 2.75 → Under 1.5 2H ──
// Backtest (TOP+MAJOR, 12m OOS, n=3,804): 59.3% hit · σ=2.1% · BE odds 1.69
const s4Dedup = new Dedup(3 * 60 * 60 * 1000);

function s4Format(match, steam, tier, score) {
  const { favSide, favLc } = steam;
  const favTeam = favSide === 'HOME' ? esc(match.home_team) : esc(match.away_team);
  const tlC     = match.odds.tl_c;
  const htStr   = `${score.home}-${score.away}`;
  const betLines = [
    `💰 <b>Under 1.5 2H</b>  (1.69 – 1.75)`,
    `   59% hit rate  ·  n=3,804`,
  ];
  return buildMessage('🛡', 'UNDER 1.5 2H — HT', match, tier,
    `⏱  HT  ${htStr}`,
    `${favTeam} −${favLc.toFixed(2)}  ·  TL ${tlC.toFixed(2)}  ·  leads +1 at HT`,
    betLines,
  );
}

async function runStrategy4(match, ctx) {
  const { matchId, label, tier, steam, liveMin, rawMin, isHT } = ctx;

  if (!cfg.S4_ENABLED || !tierAllowed(tier, cfg.S4_TIER)) return;
  if (!isHT || !steam || !match.odds) return;
  if (!isAtHT(rawMin, liveMin)) return;

  const score = parseScoreStr(match.score);
  if (!score) return;

  const favGoals = steam.favSide === 'HOME' ? score.home : score.away;
  const dogGoals = steam.favSide === 'HOME' ? score.away : score.home;
  const tlC      = match.odds.tl_c;

  if (favGoals - dogGoals !== 1) {
    verbose(`  S4 SKIP [margin=${favGoals - dogGoals}]  ${label}`);
    return;
  }
  if (steam.favLc < cfg.S4_FAV_AH_MIN || steam.favLc > cfg.S4_FAV_AH_MAX) {
    verbose(`  S4 SKIP [AH=${steam.favLc.toFixed(2)} out of [${cfg.S4_FAV_AH_MIN},${cfg.S4_FAV_AH_MAX}]]  ${label}`);
    return;
  }
  if (tlC == null || tlC > cfg.S4_MAX_TL) {
    verbose(`  S4 SKIP [TL=${tlC} > ${cfg.S4_MAX_TL}]  ${label}`);
    return;
  }
  if (s4Dedup.has(matchId)) {
    verbose(`  S4 SKIP [already notified]  ${label}`);
    return;
  }

  const msg = s4Format(match, steam, tier, score);
  await sendTelegram(msg);
  s4Dedup.mark(matchId);
  console.log(`S4 ALERT → ${label}  HT=${score.home}-${score.away}  AH=-${steam.favLc.toFixed(2)}  TL=${tlC.toFixed(2)}  tier=${tier}`);
}

// ── Strategy 5: HT-as-signal DB probe ─────────────────────────────────────────
// At HT, filters the historical DB by AH line + fav side + HT score,
// then alerts when a 2H/FT bet shows meaningful z-score above baseline.
const s5Dedup = new Dedup(2 * 60 * 60 * 1000);

function s5Format(match, signals, htScore, baseN, gsN, bets, tier) {
  const { favSide, favLine } = signals;
  const favTeam  = favSide === 'HOME' ? esc(match.home_team) : esc(match.away_team);
  const htStr    = `${htScore.home}-${htScore.away}`;
  const sigBadges = buildSignalBadges(signals);
  const betLines = bets.slice(0, 5).map(b => {
    const edgeStr = (b.edge >= 0 ? '+' : '') + b.edge.toFixed(1);
    const fairStr = b.fairOdds   != null ? b.fairOdds.toFixed(2)   : '—';
    const minStr  = b.minOddsVal != null ? b.minOddsVal.toFixed(2) : '—';
    return (
      `💰 <b>${b.label}</b>  (${fairStr} – ${minStr})\n` +
      `   z=${b.z.toFixed(1)}  ${b.p.toFixed(1)}% vs ${b.bl.toFixed(1)}% (${edgeStr}pp)  n=${b.n}`
    );
  });
  return buildMessage('🔍', 'HT SIGNAL', match, tier,
    `⏱  HT  ${htStr}`,
    `${favTeam} −${Number(favLine).toFixed(2)}  ·  pool ${baseN} → HT: ${gsN}  ·  signals: ${sigBadges}`,
    betLines,
  );
}

async function runStrategy5(match, ctx) {
  const { matchId, label, tier, liveMin, rawMin, isHT } = ctx;

  if (!cfg.S5_ENABLED || !tierAllowed(tier, cfg.S5_TIER)) return;
  if (!isHT || !_dbAll || !_dbAll.length || !match.odds) return;
  if (!isAtHT(rawMin, liveMin)) return;

  const score = parseScoreStr(match.score);
  if (!score) return;

  const matchCfg = buildCfgFromMatch(match.odds, {});
  if (!matchCfg) return;

  const base = applyBaselineConfig(_dbAll, {
    fav_line: matchCfg.fav_line,
    fav_side: matchCfg.fav_side,
  });
  const gs     = { trigger: 'HT', home_goals: score.home, away_goals: score.away };
  const baseGs = applyGameState(base, gs);
  const probe  = computeHtAsSignalProbe(base, baseGs);

  const qualifying = probe
    .filter(b => b.n >= cfg.HT_MIN_N && b.z >= cfg.HT_MIN_Z && b.bl >= cfg.HT_MIN_BASELINE)
    .sort((a, b) => b.z - a.z);

  if (!qualifying.length) {
    verbose(`  S5 no qualifying bets  ${label}  HT=${score.home}-${score.away}  base=${base.length}  gs=${baseGs.length}`);
    return;
  }
  if (s5Dedup.has(matchId)) {
    verbose(`  S5 SKIP [already notified]  ${label}`);
    return;
  }

  const msg = s5Format(match, matchCfg.signals, score, base.length, baseGs.length, qualifying, tier);
  await sendTelegram(msg);
  s5Dedup.mark(matchId);
  console.log(`S5 ALERT → ${label}  HT=${score.home}-${score.away}  base=${base.length}  gs=${baseGs.length}  bets=${qualifying.length}  tier=${tier}`);
}

// ── Strategy 6: Market-calibrated edge (pre-match, ALL leagues) ───────────────
// Fires when signal-filtered pool shows ≥ MKT_EDGE_THRESH pp above
// Pinnacle's market-implied probability, and Bet365 odds beat Pinnacle avg.
// Backtest (ALL, May 2025): mkt_edge ≥ 10pp
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
      `💰 <b>${betLabel}</b>  ≥ ${b.mo}\n` +
      `   ${b.p.toFixed(1)}% hit  ·  mkt ${b.mkt_bl.toFixed(1)}%  ·  <b>${edgeSign}${b.mkt_edge.toFixed(1)}pp</b>\n` +
      `   Pinnacle avg ${b.mkt_avg_odds}  ·  ${b365Str}` +
      teamStr + `\n` +
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

  if (!cfg.S6_ENABLED || !tierAllowed(tier, cfg.S6_TIER)) return;
  if (!isMktEdge || !_dbAll || !_dbAll.length || !match.odds) return;

  const matchCfg = buildCfgFromMatch(match.odds, { LINE_MOVE_ON: true, TL_MOVE_ON: true });
  if (!matchCfg) return;

  const { signals } = matchCfg;
  const hasMovement =
    (signals.lineMove !== 'STABLE' && signals.lineMove !== 'UNKNOWN') ||
    (signals.tlMove   !== 'STABLE' && signals.tlMove   !== 'UNKNOWN');

  if (!hasMovement) {
    verbose(`  S6 SKIP [no movement]  ${label}`);
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
    verbose(`  S6 no qualifying bets  ${label}  pool=${cfgRows.length}`);
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
    verbose(`  S6 all bets below B365 threshold  ${label}`);
    return;
  }

  const minsRnd = Math.round(minsToKickoff);
  const timing  = match.kickoff_time
    ? `⏳ ${kickoffTimeLabel(match.kickoff_time)}  (in ${minsRnd <= 1 ? '&lt;1' : minsRnd} min)`
    : `⏳ kicks off in ${minsRnd <= 1 ? '&lt;1' : minsRnd} min`;

  const msg = s6Format(match, matchCfg, cfgRows.length, toFire, b365, tier, timing);
  await sendTelegram(msg);
  s6Dedup.mark(mktKey);
  console.log(`S6 ALERT → ${label}  pool=${cfgRows.length}  bets=${toFire.map(b => b.k).join(',')}  tier=${tier}`);
}

// ── Match fetcher (live + upcoming) ──────────────────────────────────────────
async function fetchMatches() {
  let liveMatches;
  let nextMatches = [];

  if (cfg.DATA_URL) {
    const url  = `${cfg.DATA_URL.replace(/\/$/, '')}/api/livescore`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Cloudflare livescore returned HTTP ${resp.status}`);
    const data = await resp.json();
    liveMatches = data.matches      || [];
    nextMatches = data.next_matches || [];
    if (nextMatches.length === 0) {
      try { nextMatches = await fetchNextMatches(); }
      catch (e) { console.error(`NextGame fetch failed: ${e.message}`); }
    }
  } else {
    liveMatches = await fetchLiveMatches();
    try { nextMatches = await fetchNextMatches(); }
    catch (e) { console.error(`NextGame fetch failed: ${e.message}`); }
  }

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

  // Cleanup expired S2 HT candidates once per scan
  for (const [id, c] of s2HtCandidates) {
    if (Date.now() - c.storedAt > S2_CAND_TTL) s2HtCandidates.delete(id);
  }

  for (const match of matches) {
    const ctx = matchContext(match);
    const { label, liveMin, minsToKickoff, isLive, isUpcoming, isMktEdge, isHT, isSFHTFire, isTLM1H } = ctx;

    const anyWindow = isLive || isUpcoming || isMktEdge || isHT || isSFHTFire || isTLM1H;
    if (!anyWindow) {
      const reason = minsToKickoff != null
        ? `min_to_ko=${minsToKickoff.toFixed(1)}`
        : `min=${liveMin ?? 'no_time'}`;
      verbose(`  SKIP [${reason}]  ${label}`);
      continue;
    }

    await runStrategy1(match, ctx);
    await runStrategy2(match, ctx);
    await runStrategy3(match, ctx);
    await runStrategy4(match, ctx);
    await runStrategy5(match, ctx);
    await runStrategy6(match, ctx);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  const once = process.argv.includes('--once');

  await loadDb();

  const on = s => s ? 'ON ' : 'OFF';
  console.log(`Strategy 1 [${on(cfg.S1_ENABLED)}][${cfg.S1_TIER}]: AH steam ≥ ${cfg.LM_STEAM_MIN} → dog AH  (live ${cfg.ALERT_MIN_MINUTE}–${cfg.ALERT_MAX_MINUTE}', pre-kick ${cfg.UPCOMING_WINDOW_MINUTES}min)`);
  console.log(`Strategy 2 [${on(cfg.S2_ENABLED)}][${cfg.S2_TIER}]: Strong fav AH ≥ ${cfg.S2_FAV_AH_MIN} not winning at HT → Over 0.5 2H at ${cfg.S2_FIRE_MIN_MINUTE}–${cfg.S2_FIRE_MAX_MINUTE}'`);
  console.log(`Strategy 3 [${on(cfg.S3_ENABLED)}][${cfg.S3_TIER}]: TLM ≥ ${cfg.TLM1H_MIN_STEAM} + TL ≥ ${cfg.TLM1H_MIN_TL} + 0-0 at ${cfg.TLM1H_MIN_MINUTE}–${cfg.TLM1H_MAX_MINUTE}' → Over 0.5 1H`);
  console.log(`Strategy 4 [${on(cfg.S4_ENABLED)}][${cfg.S4_TIER}]: Fav +1 at HT, AH ${cfg.S4_FAV_AH_MIN}–${cfg.S4_FAV_AH_MAX}, TL ≤ ${cfg.S4_MAX_TL} → Under 1.5 2H`);
  console.log(`Strategy 5 [${on(cfg.S5_ENABLED)}][${cfg.S5_TIER}]: HT DB probe  z≥${cfg.HT_MIN_Z}  n≥${cfg.HT_MIN_N}  baseline≥${cfg.HT_MIN_BASELINE}%`);
  console.log(`Strategy 6 [${on(cfg.S6_ENABLED)}][${cfg.S6_TIER}]: Market edge ≥${cfg.MKT_EDGE_THRESH}pp  n≥${cfg.MKT_EDGE_MIN_N}  window=${cfg.S6_WINDOW_MINUTES}min`);
  console.log(`Global tier default: ${cfg.LEAGUE_TIER}  |  HT window: ${cfg.HT_MIN_MINUTE}–${cfg.HT_MAX_MINUTE}'`);

  if (once) {
    await runScan();
    process.exit(0);
  }

  console.log(`Scheduler started — every ${cfg.SCAN_INTERVAL_MINUTES} min.`);
  await runScan();
  cron.schedule(`*/${cfg.SCAN_INTERVAL_MINUTES} * * * *`, runScan);
}

main().catch(e => { console.error(e); process.exit(1); });
