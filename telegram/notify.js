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

  let favSide, favLc, favLo, dogOc;
  if (ahHc < -0.01) {
    favSide = 'HOME';
    favLc   = Math.abs(ahHc);
    favLo   = Math.abs(ahHo);
    dogOc   = aoC;
  } else if (ahHc > 0.01) {
    favSide = 'AWAY';
    favLc   = Math.abs(ahHc);
    favLo   = Math.abs(ahHo);
    dogOc   = hoC;
  } else {
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
  if (tier === 'TOP')   return 'TOP';
  if (tier === 'MAJOR') return 'MAJOR';
  return 'OTHER';
}

// AH arrow: "−0.25 → −0.75  +0.50"
function ahArrow(favLc, favLo) {
  const steamMag = favLc - favLo;
  const oStr     = favLo < 0.01 ? '0.00' : `−${favLo.toFixed(2)}`;
  return `${oStr} → −${favLc.toFixed(2)}  <b>+${steamMag.toFixed(2)}</b>`;
}

// Kickoff time in display timezone
function kickoffTimeLabel(kickoffTimeStr) {
  return new Intl.DateTimeFormat('it-IT', {
    timeZone: cfg.DISPLAY_TZ,
    hour:     '2-digit',
    minute:   '2-digit',
    hour12:   false,
  }).format(new Date(kickoffTimeStr));
}

// ── Message formatters ────────────────────────────────────────────────────────
function formatMessage(match, steam, tier, b365DogOc) {
  const { favSide, favLc, favLo, dogOc } = steam;

  const homeLabel = `${match.home_team} (H)`;
  const awayLabel = `${match.away_team} (A)`;
  const favTeam   = favSide === 'HOME' ? homeLabel : awayLabel;
  const dogTeam   = favSide === 'HOME' ? awayLabel : homeLabel;

  const b365Line = b365DogOc != null
    ? `📊 Bet365: <b>${b365DogOc.toFixed(2)}</b> ✅`
    : `📊 Bet365: n/a`;

  return [
    `🚨 <b>LIVE STEAM · DOG AH</b>  ${nowTime()}`,
    ``,
    `⚽ <b>${homeLabel} vs ${awayLabel}</b>`,
    `🏆 <i>${match.league || '—'}</i>  [${tierBadge(tier)}]  ·  ⏱ ${match.minute}'  ${match.score || '0–0'}`,
    ``,
    `📉 ${favTeam} (fav)  ${ahArrow(favLc, favLo)}`,
    ``,
    `💰 BET: <b>${dogTeam}  +${favLc.toFixed(2)}  @  ${dogOc.toFixed(2)}</b>`,
    b365Line,
  ].join('\n');
}

function formatUpcomingMessage(match, steam, tier, minsToKickoff, b365DogOc) {
  const { favSide, favLc, favLo, dogOc } = steam;

  const favTeam = favSide === 'HOME' ? match.home_team : match.away_team;
  const dogTeam = favSide === 'HOME' ? match.away_team : match.home_team;

  const koTime  = match.kickoff_time ? kickoffTimeLabel(match.kickoff_time) : null;
  const minsRnd = Math.round(minsToKickoff);
  const timing  = koTime
    ? `🕐 ${koTime}  (${minsRnd <= 1 ? 'now' : `in ${minsRnd} min`})`
    : `⏳ ${minsRnd <= 1 ? 'kicks off now' : `kicks off in ${minsRnd} min`}`;

  const b365Line = b365DogOc != null
    ? `📊 Bet365: <b>${b365DogOc.toFixed(2)}</b> ✅`
    : `📊 Bet365: n/a`;

  return [
    `⏰ <b>PRE-KICK STEAM · DOG AH</b>  ${nowTime()}`,
    ``,
    `⚽ <b>${match.home_team} vs ${match.away_team}</b>`,
    `🏆 <i>${match.league || '—'}</i>  [${tierBadge(tier)}]`,
    `${timing}`,
    ``,
    `📉 Fav: ${favTeam}  ${ahArrow(favLc, favLo)}`,
    ``,
    `📌 Pinnacle: ${dogTeam} +${favLc.toFixed(2)} @${dogOc.toFixed(2)}`,
    b365Line,
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

// ── Strong-Fav HT → over05_2H state ──────────────────────────────────────────
// At HT (min 44-52): store matches where strong fav (AH ≥ 1.00) is NOT winning.
// At 65-70': if still no 2H goal, fire an over05_2H alert.
const _htCandidates  = new Map();   // matchId → { htHome, htAway, steam, storedAt }
const _notifiedSFHT  = new Map();   // matchId → timestamp (dedup)
const SFHT_TTL       = 3 * 60 * 60 * 1000;

function parseScoreStr(score) {
  if (!score) return null;
  const m = String(score).replace('–', '-').replace('—', '-').match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  return { home: parseInt(m[1], 10), away: parseInt(m[2], 10) };
}

function alreadyNotifiedSFHT(matchId) {
  const ts = _notifiedSFHT.get(matchId);
  if (!ts) return false;
  if (Date.now() - ts > SFHT_TTL) { _notifiedSFHT.delete(matchId); return false; }
  return true;
}

function markNotifiedSFHT(matchId) {
  _notifiedSFHT.set(matchId, Date.now());
}

function formatStrongFavHTMessage(match, htScore, steam, tier, liveMin) {
  const { favSide, favLc } = steam;
  const favTeam  = favSide === 'HOME' ? match.home_team : match.away_team;
  const htStr    = `${htScore.home}-${htScore.away}`;
  const minsLeft = 90 - liveMin;

  return [
    `⏰ <b>STRONG FAV — NO 2H GOAL YET</b>  ·  ${nowTime()}`,
    ``,
    `🏆 <i>${match.league || '—'}</i>  [${tierBadge(tier)}]`,
    `⚽ <b>${match.home_team} vs ${match.away_team}</b>`,
    `🕐 <b>${liveMin}'</b>  Score: <b>${match.score || htStr}</b>  (HT: ${htStr})`,
    ``,
    `📊 <b>${favTeam}</b>  AH −${favLc.toFixed(2)}  ·  not winning at HT`,
    `   ~${minsLeft} min left, no goal scored in 2nd half`,
    ``,
    `💰 BET: <b>Over 0.5 (2nd half)</b>`,
    `   82% hit rate  ·  σ=2.5%  ·  min odds 1.23`,
  ].join('\n');
}

// ── Strategy 4: Fav +1 at HT, AH 0.25–1.00, TL ≤ 2.75 → Under 1.5 2H ────────
// Fires immediately at HT interval when fav leads by exactly 1.
// Backtest: 59.3% hit rate, σ=2.1%, n=3,804 (TOP+MAJOR, 12m OOS). BE odds 1.69.
const _notifiedUnder15HT = new Map();
const UNDER15HT_TTL = 3 * 60 * 60 * 1000;

function alreadyNotifiedUnder15HT(matchId) {
  const ts = _notifiedUnder15HT.get(matchId);
  if (!ts) return false;
  if (Date.now() - ts > UNDER15HT_TTL) { _notifiedUnder15HT.delete(matchId); return false; }
  return true;
}
function markNotifiedUnder15HT(matchId) { _notifiedUnder15HT.set(matchId, Date.now()); }

function formatUnder15HTMessage(match, steam, tier, htScore) {
  const { favSide, favLc } = steam;
  const favTeam = favSide === 'HOME' ? match.home_team : match.away_team;
  const tlC     = match.odds.tl_c;
  const htStr   = `${htScore.home}-${htScore.away}`;

  return [
    `🛡 <b>UNDER 1.5 2H — HT</b>  ·  ${nowTime()}`,
    ``,
    `⚽ <b>${match.home_team} vs ${match.away_team}</b>`,
    `🏆 <i>${match.league || '—'}</i>  [${tierBadge(tier)}]`,
    `🕐 HT  Score: <b>${htStr}</b>`,
    ``,
    `📊 <b>${favTeam}</b> −${favLc.toFixed(2)}  ·  TL ${tlC.toFixed(2)}`,
    `   Fav leads +1 at HT in a low-scoring game`,
    ``,
    `💰 BET: <b>Under 1.5 2H</b>  (in-play, 2nd half goals)`,
    `   ⚠️ Min odds: <b>1.75</b>  ·  59% hit rate  ·  σ=2.1%  ·  n=3,804`,
    `   Skip if odds < 1.70`,
  ].join('\n');
}

// ── Strategy 3: TLM=IN + high TL + no 1H goal at 25–32' → Over 0.5 1H ────────
const _notifiedTLM1H = new Map();
const TLM1H_TTL = 3 * 60 * 60 * 1000;

function alreadyNotifiedTLM1H(matchId) {
  const ts = _notifiedTLM1H.get(matchId);
  if (!ts) return false;
  if (Date.now() - ts > TLM1H_TTL) { _notifiedTLM1H.delete(matchId); return false; }
  return true;
}
function markNotifiedTLM1H(matchId) { _notifiedTLM1H.set(matchId, Date.now()); }

function formatTLM1HMessage(match, tlC, tlO, tier, liveMin) {
  const tlSteam  = tlC - tlO;
  const minsLeft = 45 - liveMin;
  const cluster  = tlC >= 3.0 ? `>3.0` : `2.5–3.0`;

  return [
    `⚡ <b>OVER 0.5 1H — STILL 0-0</b>  ·  ${nowTime()}`,
    ``,
    `🏆 <i>${match.league || '—'}</i>  [${tierBadge(tier)}]`,
    `⚽ <b>${match.home_team} vs ${match.away_team}</b>`,
    `🕐 <b>${liveMin}'</b>  Score: <b>0-0</b>  (~${minsLeft} min left in 1H)`,
    ``,
    `📈 TL steamed:  ${tlO.toFixed(2)} → ${tlC.toFixed(2)}  (+${tlSteam.toFixed(2)})`,
    `   Cluster: TL ${cluster}  ·  market expects goals`,
    ``,
    `💰 BET: <b>Over 0.5 goals — first half (in-play)</b>`,
  ].join('\n');
}

// ── Bet365 odds check via botbot3 oddsComp ────────────────────────────────────
// Fetches the same botbot3 oddsComp JS file used by scrape.js, finds Bet365's
// group, and returns { ahHc, hoC, aoC } — or null on any failure.
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
  return { ahHc: pf(h[0]), hoC: pf(h[3]), aoC: pf(a[3]) };
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
  } catch (e) {
    return null;
  }
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

  // Cleanup expired HT candidates once per scan
  for (const [id, c] of _htCandidates) {
    if (Date.now() - c.storedAt > SFHT_TTL) _htCandidates.delete(id);
  }

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

    const isLive        = liveMin != null && liveMin >= cfg.ALERT_MIN_MINUTE && liveMin <= cfg.ALERT_MAX_MINUTE;
    const isUpcoming    = minsToKickoff != null && minsToKickoff >= 0 && minsToKickoff <= cfg.UPCOMING_WINDOW_MINUTES;
    const isHTWindow    = liveMin != null && liveMin >= 44 && liveMin <= 52;
    const isSFHTAlert   = liveMin != null && liveMin >= 65 && liveMin <= 70;
    const isTLM1HWindow = liveMin != null && liveMin >= cfg.TLM1H_MIN_MINUTE && liveMin <= cfg.TLM1H_MAX_MINUTE;

    if (!isLive && !isUpcoming && !isHTWindow && !isSFHTAlert && !isTLM1HWindow) {
      if (VERBOSE) {
        const reason = minsToKickoff != null
          ? `min_to_ko=${minsToKickoff.toFixed(1)}`
          : `min=${liveMin ?? 'no_time'}`;
        console.log(`  SKIP [${reason}]  ${label}`);
      }
      continue;
    }

    // League tier filter (applies to all strategies)
    const tier = classifyLeague(match.league || '');
    if (cfg.LEAGUE_TIER === 'TOP' && tier !== 'TOP') {
      if (VERBOSE) console.log(`  SKIP [tier=${tier}]  ${label}`);
      continue;
    }
    if (cfg.LEAGUE_TIER === 'TOP+MAJOR' && tier !== 'TOP' && tier !== 'MAJOR') {
      if (VERBOSE) console.log(`  SKIP [tier=${tier}]  ${label}`);
      continue;
    }

    const matchId = match.id || `${match.home_team}:${match.away_team}`;
    const steam   = parseMatchSteam(match.odds || {});

    // ── Strategy 1: AH Steam → Bet Dog AH ────────────────────────────────────
    if (isLive || isUpcoming) {
      if (!steam) {
        if (VERBOSE) console.log(`  SKIP [no odds]  ${label}`);
      } else {
        const { steam: steamMag, dogOc } = steam;

        if (steamMag < cfg.LM_STEAM_MIN) {
          if (VERBOSE) console.log(`  SKIP [steam=${steamMag.toFixed(2)} < ${cfg.LM_STEAM_MIN}]  ${label}`);
        } else if (!dogOc || dogOc < 1.01 || dogOc > 20) {
          if (VERBOSE) console.log(`  SKIP [invalid dog_oc=${dogOc}]  ${label}`);
        } else if (alreadyNotified(matchId)) {
          if (VERBOSE) console.log(`  SKIP [already notified]  ${label}`);
        } else {
          // Bet365 check: fetch oddsComp, require same AH line + dog odds >= Pinnacle
          const b365 = await fetchBet365Data(matchId);
          let b365DogOc = null;
          if (b365 && b365.ahHc != null && Math.abs(b365.ahHc - (match.odds.ah_hc || 0)) < 0.13) {
            b365DogOc = steam.favSide === 'HOME' ? b365.aoC : b365.hoC;
            if (b365DogOc != null && b365DogOc < dogOc) {
              if (VERBOSE) console.log(`  SKIP [B365 dog_oc=${b365DogOc.toFixed(2)} < pinnacle=${dogOc.toFixed(2)}]  ${label}`);
              continue;
            }
          } else if (b365 && b365.ahHc != null) {
            // Bet365 is on a different AH line — skip
            if (VERBOSE) console.log(`  SKIP [B365 AH line=${b365.ahHc} != pinnacle=${match.odds.ah_hc}]  ${label}`);
            continue;
          }
          // b365 == null → oddsComp unavailable, fire anyway

          const steps = Math.round(steamMag / 0.25);
          let msg;
          if (isUpcoming) {
            msg = formatUpcomingMessage(match, steam, tier, minsToKickoff, b365DogOc);
            console.log(`ALERT (pre-kick) → ${label}  ko_in=${minsToKickoff.toFixed(1)}min  steam=+${steamMag.toFixed(2)} (${steps} steps)  dog_oc=${dogOc.toFixed(2)}  b365=${b365DogOc != null ? b365DogOc.toFixed(2) : 'n/a'}  tier=${tier}`);
          } else {
            msg = formatMessage(match, steam, tier, b365DogOc);
            console.log(`ALERT (live) → ${label}  steam=+${steamMag.toFixed(2)} (${steps} steps)  dog_oc=${dogOc.toFixed(2)}  b365=${b365DogOc != null ? b365DogOc.toFixed(2) : 'n/a'}  tier=${tier}`);
          }
          await sendTelegram(msg);
          markNotified(matchId);
        }
      }
    }

    // ── Strategy 2: Strong Fav (AH ≥ 1.00) not winning at HT → over05_2H ────
    if (steam) {
      // Store HT candidate when match is at or just past HT
      if (isHTWindow) {
        const rawMin = String(match.minute || '').replace(/'/g, '').trim();
        if ((rawMin === 'HT' || liveMin >= 45) && steam.favLc >= 0.88) {
          const score = parseScoreStr(match.score);
          if (score && !_htCandidates.has(matchId)) {
            const favGoals = steam.favSide === 'HOME' ? score.home : score.away;
            const dogGoals = steam.favSide === 'HOME' ? score.away : score.home;
            if (favGoals <= dogGoals) {
              _htCandidates.set(matchId, {
                htHome: score.home, htAway: score.away,
                steam,
                storedAt: Date.now(),
              });
              console.log(`  [SFHT] HT candidate stored: ${label}  HT=${score.home}-${score.away}  AH=-${steam.favLc.toFixed(2)}`);
            }
          }
        }
      }

      // ── Strategy 4: Fav +1 at HT, AH 0.25–1.00, TL ≤ 2.75 → Under 1.5 2H ──
      if (isHTWindow && match.odds) {
        const rawMin4 = String(match.minute || '').replace(/'/g, '').trim();
        if (rawMin4 === 'HT' || liveMin >= 45) {
          const score4 = parseScoreStr(match.score);
          if (score4) {
            const favGoals4 = steam.favSide === 'HOME' ? score4.home : score4.away;
            const dogGoals4 = steam.favSide === 'HOME' ? score4.away : score4.home;
            const tlC4      = match.odds.tl_c;

            if (favGoals4 - dogGoals4 === 1 &&
                steam.favLc >= 0.13 && steam.favLc <= 1.12 &&
                tlC4 != null && tlC4 <= 2.75) {
              if (alreadyNotifiedUnder15HT(matchId)) {
                if (VERBOSE) console.log(`  [U15HT] SKIP [already notified]  ${label}`);
              } else {
                const msg = formatUnder15HTMessage(match, steam, tier, score4);
                await sendTelegram(msg);
                markNotifiedUnder15HT(matchId);
                console.log(`[U15HT] ALERT → ${label}  HT=${score4.home}-${score4.away}  AH=-${steam.favLc.toFixed(2)}  TL=${tlC4.toFixed(2)}  tier=${tier}`);
              }
            } else if (VERBOSE) {
              console.log(`  [U15HT] SKIP [margin=${favGoals4 - dogGoals4} AH=${steam.favLc.toFixed(2)} TL=${tlC4}]  ${label}`);
            }
          }
        }
      }

      // Fire alert at 65–70' if still no goal in 2H
      if (isSFHTAlert) {
        const cand = _htCandidates.get(matchId);
        if (cand && !alreadyNotifiedSFHT(matchId)) {
          const curScore = parseScoreStr(match.score);
          if (curScore) {
            const goals2H = (curScore.home + curScore.away) - (cand.htHome + cand.htAway);
            if (goals2H === 0) {
              const htScore = { home: cand.htHome, away: cand.htAway };
              const msg = formatStrongFavHTMessage(match, htScore, cand.steam, tier, liveMin);
              await sendTelegram(msg);
              markNotifiedSFHT(matchId);
              console.log(`[SFHT] ALERT → ${label}  min=${liveMin}  HT=${cand.htHome}-${cand.htAway}  now=${curScore.home}-${curScore.away}  tier=${tier}`);
            } else if (VERBOSE) {
              console.log(`  [SFHT] skip [${goals2H} goal(s) in 2H already]  ${label}`);
            }
          }
        }
      }
    }

    // ── Strategy 3: DISABLED (backtest shows ~52% hit rate, BE odds 1.94 — not profitable)
    // if (isTLM1HWindow && match.odds) { ... }
  }

}

// ── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  const once = process.argv.includes('--once');

  if (once) {
    await runScan();
    process.exit(0);
  }

  console.log(`Scheduler started — every ${cfg.SCAN_INTERVAL_MINUTES} min.`);
  console.log(`Strategy 1: AH steam ≥ ${cfg.LM_STEAM_MIN} → bet dog AH  (window=${cfg.ALERT_MIN_MINUTE}–${cfg.ALERT_MAX_MINUTE}', pre-kick ${cfg.UPCOMING_WINDOW_MINUTES}min)`);
  console.log(`Strategy 2: Strong fav AH ≥ 1.00 not winning at HT → Over 0.5 2H at 65–70'  (min odds 1.23)`);
  console.log(`Strategy 3: DISABLED (Over 0.5 1H — backtest: ~52% hit, BE 1.94, not profitable)`);
  console.log(`Strategy 4: Fav +1 at HT, AH 0.25–1.00, TL ≤ 2.75 → Under 1.5 2H  (min odds 1.75)`);
  console.log(`Tier filter: ${cfg.LEAGUE_TIER}  [fixed: was ALL, now TOP+MAJOR]`);
  await runScan();
  cron.schedule(`*/${cfg.SCAN_INTERVAL_MINUTES} * * * *`, runScan);
}

main().catch(e => { console.error(e); process.exit(1); });
