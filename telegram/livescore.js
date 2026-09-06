'use strict';
// ── Live match fetcher ────────────────────────────────────────────────────────
// Adapted from functions/api/livescore.js for Node.js (no Cloudflare runtime).
// Uses built-in fetch (Node >= 18).

// Hashes are bootstrapped at startup via refreshHashes(), which scrapes
// asianbetsoccer.com directly (see fetchAllBookHashes below), falling back
// to a relay through the deployed Cloudflare Pages Function
// (fetchHashesViaRelay, needs HASH_RELAY_URL/DATA_URL set) if that comes
// back empty — e.g. asianbetsoccer's WAF blocking Railway's outbound IP
// specifically, seen intermittently even when it works fine locally and from
// Cloudflare's edge. Self-heals on every call either way. The hardcoded
// values below are just the seed in case BOTH paths fail on startup. If
// BET365_HASH/PINNACLE_HASH/SBOBET_HASH env vars are set, they override the
// seed — a manual stopgap you can set in the Railway dashboard without a
// redeploy when both auto-discovery paths are stuck (paste the fresh hash
// from a local `node -e "require('./livescore').refreshHashes().then(console.log)"` run).
let PINNACLE_HASH   = process.env.PINNACLE_HASH   || '30e528c380c96b362ffacdc66b2808c8ad59ce9e';
let BET365_HASH     = process.env.BET365_HASH     || '553c7f0fdbb889a93c9a85abaa1639de76943277';
// "Bet365 Live" — a separate #book_filter option from plain Bet365, whose
// odds are the actual current/moving live price rather than the frozen
// pre-match close (see functions/api/livescore.js's own BET365_LIVE_HASH
// comment for the full investigation). Discovered/refreshed the same way as
// the other three hashes below and relayed via getCurrentHashes()'s /hashes
// endpoint so Cloudflare's edge (blocked from discovering it directly by
// asianbetsoccer's WAF) can pick it up too.
let BET365_LIVE_HASH = process.env.BET365_LIVE_HASH || '56f7105ddda384f0955acb8ffe874c8b61daec49';
let SBOBET_HASH     = process.env.SBOBET_HASH     || 'f1bd8f485d42c4e9700599b0db02cd537a78801f';
const GS_PRIMARY    = 'Q';
const GS_CANDIDATES = ['Q', '1', '2', '3', 'AH', 'S', 'EU', 'A', 'ah', 's', '4', '5', '10', '6', '7', '8', 'B', 'F'];

function makeBotbotHeaders(gS, book) {
  return {
    Origin:            'https://www.asianbetsoccer.com',
    Referer:           'https://www.asianbetsoccer.com/it/livescore.html',
    'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept:            '*/*',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control':   'no-cache',
    Pragma:            'no-cache',
    Cookie:            `_cookie_Stats=${gS}; _cookie_Book=${book}; _cookie_LAN=it; _cookie_GMT=1`,
  };
}

function extractCallArgs(text, start) {
  let i = start, depth = 0, buf = '', inStr = false, strChar = '';
  const args = [];
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      if (ch === '\\' && i + 1 < text.length) { buf += ch + text[i + 1]; i += 2; continue; }
      if (ch === strChar) inStr = false;
      buf += ch; i++; continue;
    }
    if (ch === '"' || ch === "'") { inStr = true; strChar = ch; buf += ch; }
    else if ('([{'.includes(ch)) { depth++; buf += ch; }
    else if (')]}'.includes(ch)) {
      if (depth === 0) { const t = buf.trim(); if (t) args.push(parseArgValue(t)); break; }
      depth--; buf += ch;
    } else if (ch === ',' && depth === 0) { args.push(parseArgValue(buf.trim())); buf = ''; }
    else buf += ch;
    i++;
  }
  return args;
}

function parseArgValue(s) {
  if (!s || s === 'null' || s === 'undefined') return null;
  if ((s[0] === '"' || s[0] === "'") && s.length >= 2 && s[s.length - 1] === s[0]) {
    return s.slice(1, -1)
      .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\r/g, '\r')
      .replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, '\\');
  }
  const n = parseFloat(s);
  return isNaN(n) ? s : n;
}

function parseGetData2Calls(jsText) {
  const re = /\bmatch2text\s*\+=\s*getData2\s*\(/g;
  const results = [];
  let m;
  while ((m = re.exec(jsText)) !== null) {
    const args = extractCallArgs(jsText, m.index + m[0].length);
    if (args.length < 31) continue;
    const pf = v => { const n = typeof v === 'number' ? v : parseFloat(v); return isNaN(n) ? null : n; };
    const matchId = (typeof args[4] === 'string' && args[4].length >= 20) ? args[4] : null;
    results.push({
      matchId,
      odds: {
        ah_hc: pf(args[5]),  ah_ho: pf(args[6]),
        ho_c:  pf(args[11]), ho_o:  pf(args[12]),
        ao_c:  pf(args[16]), ao_o:  pf(args[17]),
        tl_c:  pf(args[21]), tl_o:  pf(args[22]),
        ov_c:  pf(args[24]), ov_o:  pf(args[25]),
        un_c:  pf(args[29]), un_o:  pf(args[30]),
      },
    });
  }
  return results;
}

function parseGetData1Calls(jsText) {
  const re = /\bmatch1text\s*\+=\s*getData(?:live|last)1\s*\(/g;
  const results = [];
  let m;
  while ((m = re.exec(jsText)) !== null) {
    const args = extractCallArgs(jsText, m.index + m[0].length);
    if (args.length < 23) continue;
    const matchId  = (typeof args[5] === 'string' && /^[a-f0-9]{20,}$/i.test(args[5])) ? args[5] : null;
    const homeTeam = typeof args[9]  === 'string' ? args[9]  : '';
    const awayTeam = typeof args[22] === 'string' ? args[22] : '';
    const league   = typeof args[6]  === 'string' ? args[6]  : '';
    const rawTime     = typeof args[10] === 'string' ? args[10].replace(/\\'/g, "'") : null;
    const isHT        = rawTime === 'HT';
    const minute      = rawTime && (isHT || !rawTime.includes('T')) ? rawTime : null;
    const kickoffTime = rawTime && rawTime.includes('T') && !isHT ? rawTime : null;
    let score = null;
    if (minute && args.length > 23) {
      const hg = typeof args[11] === 'number' ? args[11] : parseInt(args[11], 10);
      const ag = typeof args[23] === 'number' ? args[23] : parseInt(args[23], 10);
      if (!isNaN(hg) && !isNaN(ag) && hg >= 0 && ag >= 0) score = `${hg}-${ag}`;
    }
    // HT score: args[12]/[13] = HT home/away goals — confirmed 2026-09-05 by hooking
    // getDatalive1() live and cross-referencing several in-progress matches. Present in the
    // raw feed for ANY match past halftime, not just ones watched since kickoff. Pre-HT these
    // are 0,0 placeholders (indistinguishable from a real 0-0 HT), so only trust them once the
    // match has actually reached halftime — mirrors functions/api/livescore.js's parsing.
    const minuteNum = minute && !isHT ? parseInt(minute, 10) : null;
    const pastHT = isHT || (minuteNum !== null && !isNaN(minuteNum) && minuteNum > 45);
    let htScore = null;
    if (pastHT && args.length > 13) {
      const hth = typeof args[12] === 'number' ? args[12] : parseInt(args[12], 10);
      const hta = typeof args[13] === 'number' ? args[13] : parseInt(args[13], 10);
      if (!isNaN(hth) && !isNaN(hta) && hth >= 0 && hta >= 0) htScore = `${hth}-${hta}`;
    }
    results.push({ matchId, homeTeam, awayTeam, league, minute, kickoffTime, score, htScore });
  }
  return results;
}

function mergeMatchData(oddsRows, metaRows) {
  const metaByMatchId = new Map();
  for (const meta of metaRows) {
    if (meta.matchId) metaByMatchId.set(meta.matchId, meta);
  }
  const matches = [];
  for (let i = 0; i < oddsRows.length; i++) {
    const { matchId, odds } = oddsRows[i];
    const meta = (matchId && metaByMatchId.has(matchId))
      ? metaByMatchId.get(matchId)
      : (metaRows[i] || {});
    const id  = matchId || meta.matchId || null;
    const url = id ? `https://www.asianbetsoccer.com/it/match.html?id=${id}` : null;
    if (odds.ah_hc === null && odds.ho_c === null && odds.tl_c === null) continue;
    matches.push({
      id, url,
      home_team:    meta.homeTeam    || '',
      away_team:    meta.awayTeam    || '',
      league:       meta.league      || '',
      minute:       meta.minute      || null,
      kickoff_time: meta.kickoffTime || null,
      score:        meta.score       || null,
      ht_score:     meta.htScore     || null,
      x2_odds:      meta.x2          || null,
      odds,
    });
  }
  return matches;
}

// ── tablenext parser ──────────────────────────────────────────────────────────
// getDatanext1(rowIdx, ?, leagueKey, encodedOdds, statusCode,
//   matchId, leagueName, homeTeam, kickoffTimeUTC, h1X2c, dX2c, a1X2c,
//   h1X2o, dX2o, a1X2o, awayTeam)
// The h1X2*/a1X2* args are the ONLY source of 1X2 (match-winner) odds in this
// table — getData2 (parseGetData2Calls) only carries AH/TL/O-U — so they're
// extracted here into `x2` and carried through mergeMatchData onto
// match.x2_odds. Added 2026-09-05 for Strategy OPENLINE (see notify.js),
// which needs the OPENING 1X2 price (h1X2o/a1X2o) to check against, not just
// the AH/TL data every other strategy already uses.
function parseGetDatanext1Calls(jsText) {
  const re = /\bmatch1text\s*\+=\s*getDatanext1\s*\(/g;
  const results = [];
  let m;
  while ((m = re.exec(jsText)) !== null) {
    const args = extractCallArgs(jsText, m.index + m[0].length);
    if (args.length < 16) continue;
    const pf = v => { const n = typeof v === 'number' ? v : parseFloat(v); return isNaN(n) ? null : n; };
    const matchId     = (typeof args[5] === 'string' && /^[a-f0-9]{20,}$/i.test(args[5])) ? args[5] : null;
    const league      = typeof args[6]  === 'string' ? args[6]  : '';
    const homeTeam    = typeof args[7]  === 'string' ? args[7]  : '';
    const kickoffTime = typeof args[8]  === 'string' ? args[8]  : null;  // UTC ISO with Z
    const awayTeam    = typeof args[15] === 'string' ? args[15] : '';
    const x2 = {
      home_c: pf(args[9]),  draw_c: pf(args[10]), away_c: pf(args[11]),
      home_o: pf(args[12]), draw_o: pf(args[13]), away_o: pf(args[14]),
    };
    results.push({ matchId, homeTeam, awayTeam, league, minute: null, kickoffTime, score: null, x2 });
  }
  return results;
}

async function tryNextCombo(hash, gS, timestamp, day = 0) {
  const url = `https://botbot3.space/tables/v4/${gS}/tablenext/day${day}/${hash}.js?date=${timestamp}&_=${timestamp + 1}`;
  let jsText;
  try {
    const resp = await fetch(url, { headers: makeBotbotHeaders(gS, hash) });
    if (!resp.ok) {
      console.log(`  nextgame ${gS}/${hash.slice(0,8)}… → HTTP ${resp.status}`);
      return { matches: null, hashInvalid: resp.status === 404 };
    }
    jsText = await resp.text();
  } catch (e) {
    console.log(`  nextgame ${gS}/${hash.slice(0,8)}… → fetch error: ${e.message}`);
    return { matches: null, hashInvalid: false };
  }

  const oddsRows = parseGetData2Calls(jsText);
  if (oddsRows.length === 0) {
    console.log(`  nextgame ${gS}/${hash.slice(0,8)}… → OK but 0 getData2 calls (${jsText.length} bytes)`);
    return { matches: null, hashInvalid: false };
  }

  const metaRows = parseGetDatanext1Calls(jsText);
  const matches  = mergeMatchData(oddsRows, metaRows);
  console.log(`  nextgame ${gS}/${hash.slice(0,8)}… → OK  odds:${oddsRows.length}  meta:${metaRows.length}  merged:${matches.length}`);
  return { matches, hashInvalid: false };
}

async function tryCombo(hash, gS, timestamp) {
  const url = `https://botbot3.space/tables/v4/${gS}/livegame/${hash}.js?date=${timestamp}&_=${timestamp + 1}`;
  let jsText;
  try {
    const resp = await fetch(url, { headers: makeBotbotHeaders(gS, hash) });
    if (!resp.ok) {
      console.log(`  botbot3 ${gS}/${hash.slice(0,8)}… → HTTP ${resp.status}`);
      return { matches: null, hashInvalid: resp.status === 404 };
    }
    jsText = await resp.text();
  } catch (e) {
    console.log(`  botbot3 ${gS}/${hash.slice(0,8)}… → fetch error: ${e.message}`);
    return { matches: null, hashInvalid: false };
  }

  const oddsRows = parseGetData2Calls(jsText);
  if (oddsRows.length === 0) {
    console.log(`  botbot3 ${gS}/${hash.slice(0,8)}… → OK but 0 getData2 calls (${jsText.length} bytes)`);
    return { matches: null, hashInvalid: false };
  }

  const metaRows = parseGetData1Calls(jsText);
  const matches  = mergeMatchData(oddsRows, metaRows);
  console.log(`  botbot3 ${gS}/${hash.slice(0,8)}… → OK  odds:${oddsRows.length}  meta:${metaRows.length}  merged:${matches.length}`);
  return { matches, hashInvalid: false };
}

// Book name patterns for #book_filter option matching (case-insensitive).
// Anchored exact-match — "Bet365 Live" is a real, separately useful feed
// (see BET365_LIVE_HASH above, not "0 odds rows" as originally assumed
// here), but a loose /bet\s*365/i match would still collide with it and
// silently overwrite the plain-Bet365 hash since the loop below takes the
// last match, so both patterns stay anchored and distinct.
const BOOK_PATTERNS = {
  pinnacle:   /^pinnacle$/i,
  bet365:     /^bet\s*365$/i,
  bet365live: /^bet\s*365\s*live$/i,
  sbobet:     /^sbo\s*bet$/i,
};

/**
 * Fetch the asianbetsoccer livescore page once and extract all three book hashes
 * from the #book_filter <select> options (e.g. <option value="<40-hex>">Pinnacle</option>).
 * Returns { pinnacle, bet365, sbobet } — any value may be null if not found.
 */
// asianbetsoccer.com's WAF blocks a full desktop-Chrome User-Agent string
// (403) from some networks while accepting a bare "Mozilla/5.0" — try the
// full header set first (looks like a real browser where it isn't blocked),
// then fall back to the minimal UA that's known to get through.
const LIVESCORE_HEADER_SETS = [
  {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  },
  { 'User-Agent': 'Mozilla/5.0' },
];

// Second, independent path to a fresh hash — asks the already-deployed
// Cloudflare Pages Function (functions/api/livescore.js) what hash IT'S
// currently using. That function does its own live auto-discovery against
// asianbetsoccer.com on every request (not a stale hand-set value — see its
// own header comment), from Cloudflare's edge network, which isn't subject
// to the WAF rule that's been seen blocking Railway's outbound IP
// specifically (works fine locally, fails intermittently on Railway — see
// module header). Set HASH_RELAY_URL (or reuse DATA_URL, same origin already
// configured for the historical dataset) to the deployed Cloudflare Pages
// site to enable this. Only used as a fallback when the direct scrape below
// returns nothing, so it adds no extra latency/dependency in the common case.
const HASH_RELAY_URL = process.env.HASH_RELAY_URL || process.env.DATA_URL || null;

async function fetchHashesViaRelay() {
  if (!HASH_RELAY_URL) return { pinnacle: null, bet365: null, bet365live: null, sbobet: null };
  const url = `${HASH_RELAY_URL.replace(/\/$/, '')}/api/livescore`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.log(`  relay ${url} → HTTP ${resp.status}`);
      return { pinnacle: null, bet365: null, bet365live: null, sbobet: null };
    }
    const json = await resp.json();
    const isHash = v => typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v);
    const result = {
      bet365:     isHash(json.book)            ? json.book            : null,
      bet365live: isHash(json.bet365live_book) ? json.bet365live_book : null,
      pinnacle:   isHash(json.pinnacle_book)   ? json.pinnacle_book   : null,
      sbobet:     isHash(json.sbobet_book)     ? json.sbobet_book     : null,
    };
    console.log(`  relay → bet365=${result.bet365?.slice(0,8) ?? '—'}… bet365live=${result.bet365live?.slice(0,8) ?? '—'}… pinnacle=${result.pinnacle?.slice(0,8) ?? '—'}… sbobet=${result.sbobet?.slice(0,8) ?? '—'}…`);
    return result;
  } catch (e) {
    console.log(`  relay fetch threw: ${e.message}`);
    return { pinnacle: null, bet365: null, bet365live: null, sbobet: null };
  }
}

// Shared between the plain-fetch path and the headless-browser path below —
// both end up with the same rendered/raw HTML, just fetched a different way.
function parseBookHashesFromHtml(html) {
  const result = { pinnacle: null, bet365: null, bet365live: null, sbobet: null };
  const optRe = /value="([a-f0-9]{40})"[^>]*>\s*([^<]+)/gi;
  let m;
  while ((m = optRe.exec(html)) !== null) {
    const [, hash, rawLabel] = m;
    const label = rawLabel.trim();
    if (!result.pinnacle && BOOK_PATTERNS.pinnacle.test(label)) result.pinnacle = hash;
    else if (!result.bet365 && BOOK_PATTERNS.bet365.test(label)) result.bet365   = hash;
    else if (!result.bet365live && BOOK_PATTERNS.bet365live.test(label)) result.bet365live = hash;
    else if (!result.sbobet && BOOK_PATTERNS.sbobet.test(label)) result.sbobet   = hash;
  }

  // Fallback for Pinnacle: botbot3.space livegame URL embedded in page scripts
  if (!result.pinnacle) {
    const m2 = html.match(/botbot3\.space\/tables\/v4\/[^/]+\/livegame\/([a-f0-9]{40})\.js/);
    if (m2) result.pinnacle = m2[1];
  }
  return result;
}

async function fetchAllBookHashesDirect() {
  try {
    let resp;
    for (const headers of LIVESCORE_HEADER_SETS) {
      resp = await fetch('https://www.asianbetsoccer.com/it/livescore.html', { headers });
      if (resp.ok) break;
      console.log(`  livescore.html → HTTP ${resp.status} (UA "${headers['User-Agent'].slice(0, 20)}…") — trying next header set`);
    }
    if (!resp.ok) return { pinnacle: null, bet365: null, bet365live: null, sbobet: null };
    const html = await resp.text();
    const result = parseBookHashesFromHtml(html);

    return result;
  } catch (e) {
    // Was previously a bare `catch {}` — swallowed the real error (e.g. a
    // network-level failure fetching asianbetsoccer.com, distinct from an
    // HTTP error status) with no log line at all, making a Railway-specific
    // failure indistinguishable from "site returned no matches" in logs.
    console.log(`  livescore.html fetch threw: ${e.message}`);
    return { pinnacle: null, bet365: null, bet365live: null, sbobet: null };
  }
}

// Headless-browser fallback (added 2026-08-26) — asianbetsoccer.com's WAF
// started flat-out blocking plain HTTP clients entirely (both Cloudflare's
// edge AND Railway's own outbound fetch now get a 202 JS-challenge/403, where
// previously only the Cloudflare edge was blocked). Both those layers used to
// cover for each other, but once neither side can get a *real* fresh hash the
// relay just bounces the same stale value back and forth forever. A real
// Chromium instance (Playwright) runs the page's own JS the way a normal
// visitor's browser would, which the plain-fetch path can never do — so this
// is tried as a genuine third source, not just another disguise for fetch().
// Lazily required so a deploy without the `playwright` package (e.g. running
// notify.js locally without it installed) doesn't crash — this path just
// silently unavailable in that case, same as HASH_RELAY_URL being unset.
async function fetchAllBookHashesViaBrowser() {
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch {
    console.log('  Browser fallback: `playwright` not installed — skipping.');
    return { pinnacle: null, bet365: null, bet365live: null, sbobet: null };
  }

  let browser;
  try {
    // --disable-blink-features=AutomationControlled + the addInitScript below
    // mask the two most common automation tells (navigator.webdriver and the
    // Runtime.Enable CDP flag) that bot-management WAFs (Cloudflare/Akamai-
    // style) specifically fingerprint — stock Playwright without these was
    // observed (2026-09-06 Railway logs) coming back with all three hashes
    // null on every attempt, no exception thrown, which is consistent with
    // silently being served the same JS-challenge page a plain fetch() gets
    // rather than the real HTML.
    browser = await chromium.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
    });
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'it-IT',
      viewport: { width: 1366, height: 768 },
    });
    await page.addInitScript(() => {
      Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
    });
    await page.goto('https://www.asianbetsoccer.com/it/livescore.html', {
      waitUntil: 'domcontentloaded',
      timeout: 20000,
    });
    // Give any JS challenge/redirect a moment to resolve and the odds table's
    // script to populate #book_filter before reading the DOM.
    await page.waitForTimeout(3000);
    const html = await page.content();
    const result = parseBookHashesFromHtml(html);
    console.log(`  Browser fallback → bet365=${result.bet365?.slice(0,8) ?? '—'}… bet365live=${result.bet365live?.slice(0,8) ?? '—'}… pinnacle=${result.pinnacle?.slice(0,8) ?? '—'}… sbobet=${result.sbobet?.slice(0,8) ?? '—'}…`);
    // Diagnostics for when it still comes back empty — was previously
    // impossible to tell a WAF challenge page from a real page whose
    // #book_filter markup changed, since both look identical (all-null, no
    // exception) in the log.
    if (!result.pinnacle && !result.bet365 && !result.bet365live && !result.sbobet) {
      const title = await page.title().catch(() => '?');
      console.log(`  Browser fallback: empty result — page title="${title}", html=${html.length} bytes, url=${page.url()}`);
    }
    return result;
  } catch (e) {
    console.log(`  Browser fallback threw: ${e.message}`);
    return { pinnacle: null, bet365: null, bet365live: null, sbobet: null };
  } finally {
    if (browser) await browser.close().catch(() => {});
  }
}

/**
 * Fetch all three book hashes — direct scrape of asianbetsoccer.com first
 * (zero extra dependency, works fine in the common case), then a real
 * headless-browser visit (fetchAllBookHashesViaBrowser) if that comes back
 * empty, then the Cloudflare Pages relay as a last resort — see that
 * function's header comment for why the plain-fetch path alone stopped being
 * enough.
 */
async function fetchAllBookHashesUncached() {
  const direct = await fetchAllBookHashesDirect();
  if (direct.pinnacle || direct.bet365 || direct.bet365live || direct.sbobet) return direct;

  console.log('  Direct scrape returned nothing — trying headless browser…');
  const viaBrowser = await fetchAllBookHashesViaBrowser();
  if (viaBrowser.pinnacle || viaBrowser.bet365 || viaBrowser.bet365live || viaBrowser.sbobet) return viaBrowser;

  if (!HASH_RELAY_URL) {
    console.log('  Browser fallback returned nothing and HASH_RELAY_URL/DATA_URL not set — no fallback available.');
    return direct;
  }
  console.log('  Direct scrape returned nothing — trying Cloudflare relay…');
  return fetchHashesViaRelay();
}

// Single-flight guard (added 2026-09-06) — fetchLiveMatches, fetchNextMatches
// and fetchSbobetMatches each independently call into fetchAllBookHashes()
// when their own hash 404s, and since they all run concurrently via
// Promise.all in notify.js's fetchMatches(), a single scan cycle was
// launching up to 3 separate headless Chromium instances at once (confirmed
// in Railway logs 2026-09-06 — interleaved "Browser fallback" lines per
// cycle). That's needless resource contention on a small container and looks
// more bot-like to a fingerprinting WAF than one clean request. Concurrent
// callers now share a single in-flight discovery attempt instead.
let _inFlightHashFetch = null;
async function fetchAllBookHashes() {
  if (_inFlightHashFetch) return _inFlightHashFetch;
  _inFlightHashFetch = fetchAllBookHashesUncached().finally(() => { _inFlightHashFetch = null; });
  return _inFlightHashFetch;
}

/**
 * Refresh all book hashes — direct scrape of asianbetsoccer.com's
 * #book_filter dropdown first, falling back to the Cloudflare Pages relay
 * (see fetchAllBookHashes) when direct scraping returns nothing at all
 * (e.g. asianbetsoccer's WAF blocking Railway's outbound IP specifically —
 * seen intermittently, works fine locally). An earlier design read a
 * Cloudflare Pages Function endpoint (?hashes=1) as the sole source of
 * truth, but that endpoint just echoed whatever was last hand-set in the
 * Cloudflare env vars with no discovery of its own, which drifted stale and
 * caused live matches to silently stop resolving — 2026-08-24's fallback is
 * different: it relays through the deployed functions/api/livescore.js's
 * normal request path, which performs its OWN live auto-discovery against
 * asianbetsoccer.com from Cloudflare's edge (a different network than
 * Railway's) on every call, so it's a second live-discovery path, not a
 * static snapshot.
 * Updates module-level variables. Logs what changed.
 * Called at startup, on a 404 mid-scan, and daily by the scheduler.
 */
async function refreshHashes() {
  console.log('Hashes: refreshing from asianbetsoccer…');
  const { pinnacle, bet365, bet365live, sbobet } = await fetchAllBookHashes();

  let changed = 0;
  if (pinnacle   && pinnacle   !== PINNACLE_HASH)   { console.log(`  Pinnacle:    ${PINNACLE_HASH.slice(0,8)}… → ${pinnacle.slice(0,8)}…`);   PINNACLE_HASH   = pinnacle;   changed++; }
  if (bet365     && bet365     !== BET365_HASH)     { console.log(`  Bet365:      ${BET365_HASH.slice(0,8)}… → ${bet365.slice(0,8)}…`);       BET365_HASH     = bet365;     changed++; }
  if (bet365live && bet365live !== BET365_LIVE_HASH) { console.log(`  Bet365 Live: ${BET365_LIVE_HASH.slice(0,8)}… → ${bet365live.slice(0,8)}…`); BET365_LIVE_HASH = bet365live; changed++; }
  if (sbobet     && sbobet     !== SBOBET_HASH)     { console.log(`  Sbobet:      ${SBOBET_HASH.slice(0,8)}… → ${sbobet.slice(0,8)}…`);       SBOBET_HASH     = sbobet;     changed++; }
  if (changed === 0) console.log('  All hashes still current.');
  return { pinnacle: PINNACLE_HASH, bet365: BET365_HASH, bet365live: BET365_LIVE_HASH, sbobet: SBOBET_HASH };
}

// ── Stale-hash heuristic (added 2026-09-06) ───────────────────────────────
// botbot3.space often keeps serving HTTP 200 with an empty payload (0
// getData2 calls — logged as "OK but 0 getData2 calls") for a rotated-out
// hash for hours before it finally starts 404ing it. Every rediscovery
// trigger above (`hashInvalid`) is gated strictly on a real 404, so during
// that window each scan just quietly logs "no matches" and does nothing —
// this was the root cause behind auto-discovery taking hours to catch a
// daily hash rotation instead of minutes.
//
// fetchNextMatches's upcoming-fixtures listing (day0, every league
// worldwide) coming back genuinely empty is a much stronger stale-hash
// signal than fetchLiveMatches being empty — zero live matches anywhere is a
// normal quiet period, but zero *upcoming* fixtures anywhere in the world
// for several consecutive scans essentially never happens with a healthy
// hash. So: track consecutive scans where fetchNextMatches came back
// OK-but-empty (not a real 404 — that path already rediscovers on its own)
// and force a full fetchAllBookHashes() rediscovery once the streak crosses
// a threshold, rather than waiting for botbot3.space to eventually 404.
const NEXTGAME_EMPTY_STREAK_THRESHOLD = 3; // consecutive scans (~6 min at the default 2-min interval)
let _nextgameEmptyStreak = 0;

// Call once per scan with whether fetchNextMatches came back OK-but-empty
// this cycle. Returns true if it forced a rediscovery that actually changed
// BET365_HASH (caller should re-fetch this same cycle to recover sooner).
async function checkStaleHashHeuristic(nextMatchesEmptyNotFailed) {
  if (!nextMatchesEmptyNotFailed) {
    _nextgameEmptyStreak = 0;
    return false;
  }
  _nextgameEmptyStreak++;
  if (_nextgameEmptyStreak < NEXTGAME_EMPTY_STREAK_THRESHOLD) return false;

  console.log(`Hashes: ${_nextgameEmptyStreak} consecutive scans with zero upcoming fixtures (HTTP 200 but empty) — suspected stale hash, forcing rediscovery…`);
  _nextgameEmptyStreak = 0; // give the (possibly new) hash a fresh streak to prove itself before forcing again
  const before = BET365_HASH;
  await refreshHashes();
  if (BET365_HASH !== before) {
    console.log(`Hashes: stale-hash heuristic found a new Bet365 hash ${before.slice(0,8)}… → ${BET365_HASH.slice(0,8)}…`);
    return true;
  }
  console.log('Hashes: stale-hash heuristic triggered but rediscovery found no new hash — will re-check after another streak.');
  return false;
}

// Keep fetchPinnacleHash as a lightweight alias used by the 404 fallback path
async function fetchPinnacleHash() {
  const { pinnacle } = await fetchAllBookHashes();
  return pinnacle;
}

async function fetchBet365Hash() {
  const { bet365 } = await fetchAllBookHashes();
  return bet365;
}

async function fetchBet365LiveHash() {
  const { bet365live } = await fetchAllBookHashes();
  return bet365live;
}

async function fetchSbobetHash() {
  const { sbobet } = await fetchAllBookHashes();
  return sbobet;
}

// Bet365 is the primary (and only) source: it carries both the match list
// (teams/minute/score, via getDatalive1/getDatalast1) and the odds (via
// getData2) off the same livegame/{hash}.js payload — see tryCombo. Pinnacle
// is no longer listed on the asianbetsoccer book_filter dropdown, so its hash
// can't be auto-discovered any more; Bet365's can.
async function fetchLiveMatches() {
  const timestamp = Date.now();

  console.log(`Livescore: trying Bet365 hash=${BET365_HASH.slice(0,8)}…`);
  let { matches, hashInvalid } = await tryCombo(BET365_HASH, GS_PRIMARY, timestamp);

  // Auto-discovery: if hash is stale (404), fetch new hash from asianbetsoccer page
  if (!matches && hashInvalid) {
    console.log('Livescore: hash invalid — auto-discovering new Bet365 hash…');
    const discovered = await fetchBet365Hash();
    if (discovered && discovered !== BET365_HASH) {
      console.log(`Livescore: discovered new hash=${discovered.slice(0,8)}… — retrying`);
      BET365_HASH = discovered;
      ({ matches, hashInvalid } = await tryCombo(BET365_HASH, GS_PRIMARY, timestamp));
    } else if (!discovered) {
      console.log('Livescore: auto-discovery failed — update BET365_HASH manually');
    }
  }

  if (!matches) {
    if (hashInvalid) console.log('Livescore: Bet365 hash invalid (404) — update BET365_HASH in livescore.js');
    else             console.log('Livescore: no live matches right now (hash OK)');
    return { matches: [], bet365HashFailed: hashInvalid, bet365Hash: BET365_HASH };
  }

  // Alias odds onto match.bet365_odds — the field name notify.js's L123
  // strategy reads, kept distinct from the generic match.odds in case another
  // book is ever attached as secondary enrichment later.
  for (const m of matches) m.bet365_odds = m.odds;

  return { matches, bet365HashFailed: false, bet365Hash: BET365_HASH };
}

// Fetch Bet365 AH odds from a tablenext JS file and return { map, hashFailed }.
// hashFailed = true only on HTTP 404 (stale hash), not on other errors.
async function fetchBet365OddsMap(timestamp, day = 0) {
  if (!BET365_HASH) return { map: new Map(), hashFailed: false };
  const url = `https://botbot3.space/tables/v4/${GS_PRIMARY}/tablenext/day${day}/${BET365_HASH}.js?date=${timestamp}&_=${timestamp + 1}`;
  let jsText;
  try {
    const resp = await fetch(url, { headers: makeBotbotHeaders(GS_PRIMARY, BET365_HASH) });
    if (!resp.ok) {
      console.log(`  bet365 tablenext/${BET365_HASH.slice(0, 8)}… → HTTP ${resp.status}`);
      return { map: new Map(), hashFailed: resp.status === 404 };
    }
    jsText = await resp.text();
  } catch (e) {
    console.log(`  bet365 tablenext: fetch error — ${e.message}`);
    return { map: new Map(), hashFailed: false };
  }
  const oddsRows = parseGetData2Calls(jsText);
  console.log(`  bet365 tablenext/${BET365_HASH.slice(0, 8)}… → ${oddsRows.length} rows`);
  const map = new Map();
  for (const row of oddsRows) {
    if (row.matchId) map.set(row.matchId, row.odds);
  }
  return { map, hashFailed: false };
}

// Bet365-keyed, same reasoning as fetchLiveMatches: Pinnacle hash discovery
// is dead (delisted from asianbetsoccer's #book_filter dropdown — see
// fetchLiveMatches's comment), and this app is Bet365-priced end to end
// (historical dataset, live odds, everything) anyway — Pinnacle was never
// the right book to key upcoming-fixture discovery on. Originally written
// (2026-08-26) against PINNACLE_HASH for the match list + a separate
// fetchBet365OddsMap() call to enrich odds; rewritten 2026-08-27 to just
// hit the same tablenext/{BET365_HASH}.js file for both, once, the way
// tryCombo already does for live matches — same file format, same parsers,
// just a different table (tablenext instead of livegame).
async function fetchNextMatches() {
  const timestamp = Date.now();
  console.log(`NextGame: trying Bet365 hash=${BET365_HASH.slice(0,8)}…`);
  let { matches, hashInvalid } = await tryNextCombo(BET365_HASH, GS_PRIMARY, timestamp);

  // Auto-discovery: if hash is stale (404), reuse fetchLiveMatches's own
  // Bet365 hash discovery (BET365_HASH may already have been updated
  // in-process by a live-match scan this same cycle).
  if (!matches && hashInvalid) {
    console.log('NextGame: hash invalid — auto-discovering new Bet365 hash…');
    const discovered = await fetchBet365Hash();
    if (discovered && discovered !== BET365_HASH) {
      console.log(`NextGame: discovered new hash=${discovered.slice(0,8)}… — retrying`);
      BET365_HASH = discovered;
      ({ matches, hashInvalid } = await tryNextCombo(BET365_HASH, GS_PRIMARY, timestamp));
    } else if (!discovered) {
      console.log('NextGame: auto-discovery failed — update BET365_HASH manually');
    }
  }

  if (!matches) {
    if (hashInvalid) console.log('NextGame: Bet365 hash invalid (404) — update BET365_HASH in livescore.js');
    else             console.log('NextGame: no upcoming matches right now (hash OK)');
    return { matches: [], bet365HashFailed: hashInvalid, bet365Hash: BET365_HASH };
  }

  // Alias odds onto match.bet365_odds — same field name fetchLiveMatches
  // uses and notify.js's strategies read.
  for (const m of matches) m.bet365_odds = m.odds;

  return { matches, bet365HashFailed: false, bet365Hash: BET365_HASH };
}

// ── Sbobet fetch (added for Strategy CROSSDOG) ────────────────────────────────
// Mirrors fetchLiveMatches/fetchNextMatches exactly, keyed by SBOBET_HASH
// instead of BET365_HASH — tryCombo/tryNextCombo already take the hash as a
// plain parameter, so no new parsing logic is needed, just a second set of
// thin wrappers. Sbobet is used ONLY as a secondary cross-check of Bet365's
// own Asian Handicap line (Strategy CROSSDOG — see config.js), never as a
// primary match/odds source the way Bet365 is everywhere else in this file.
async function fetchSbobetLiveMatches() {
  const timestamp = Date.now();
  let { matches, hashInvalid } = await tryCombo(SBOBET_HASH, GS_PRIMARY, timestamp);
  if (!matches && hashInvalid) {
    console.log('Sbobet livegame: hash invalid — auto-discovering new Sbobet hash…');
    const discovered = await fetchSbobetHash();
    if (discovered && discovered !== SBOBET_HASH) {
      SBOBET_HASH = discovered;
      ({ matches, hashInvalid } = await tryCombo(SBOBET_HASH, GS_PRIMARY, timestamp));
    }
  }
  if (!matches) return { matches: [], sbobetHashFailed: hashInvalid, sbobetHash: SBOBET_HASH };
  for (const m of matches) m.sbobet_odds = m.odds;
  return { matches, sbobetHashFailed: false, sbobetHash: SBOBET_HASH };
}

async function fetchSbobetNextMatches() {
  const timestamp = Date.now();
  let { matches, hashInvalid } = await tryNextCombo(SBOBET_HASH, GS_PRIMARY, timestamp);
  if (!matches && hashInvalid) {
    console.log('Sbobet tablenext: hash invalid — auto-discovering new Sbobet hash…');
    const discovered = await fetchSbobetHash();
    if (discovered && discovered !== SBOBET_HASH) {
      SBOBET_HASH = discovered;
      ({ matches, hashInvalid } = await tryNextCombo(SBOBET_HASH, GS_PRIMARY, timestamp));
    }
  }
  if (!matches) return { matches: [], sbobetHashFailed: hashInvalid, sbobetHash: SBOBET_HASH };
  for (const m of matches) m.sbobet_odds = m.odds;
  return { matches, sbobetHashFailed: false, sbobetHash: SBOBET_HASH };
}

// Merges the live + upcoming Sbobet tables the same way notify.js's own
// fetchMatches() merges Bet365's two tables — live-table data (has
// minute/score) preferred on id overlap with the next-table data (only has
// kickoff_time). Returned matches carry team names/league for the caller to
// join against the corresponding Bet365 match by team name — Sbobet match
// ids live in a completely separate id space from Bet365's, so ids can't be
// used to link the two books' listings of the same real-world match.
async function fetchSbobetMatches() {
  const [liveResult, nextResult] = await Promise.all([fetchSbobetLiveMatches(), fetchSbobetNextMatches()]);
  const merged = new Map();
  for (const m of nextResult.matches) if (m.id) merged.set(m.id, m);
  for (const m of liveResult.matches) merged.set(m.id || `${m.home_team}:${m.away_team}`, m);
  return {
    matches: [...merged.values()],
    sbobetHashFailed: liveResult.sbobetHashFailed || nextResult.sbobetHashFailed,
    sbobetHash: SBOBET_HASH,
  };
}

async function fetchNextMatchesAllDays(maxDays = 1) {
  
  const timestamp = Date.now();
  console.log(`NextAll: hash=${PINNACLE_HASH.slice(0,8)}…  fetching day0–day${maxDays}`);

  // Validate hash on day0 first (with autodiscovery), same logic as fetchNextMatches
  let { matches: m0, hashInvalid: inv0 } = await tryNextCombo(PINNACLE_HASH, GS_PRIMARY, timestamp, 0);
  if (!m0 && inv0) {
    console.log('NextAll: hash invalid — auto-discovering…');
    const discovered = await fetchPinnacleHash();
    if (discovered && discovered !== PINNACLE_HASH) {
      console.log(`NextAll: new hash=${discovered.slice(0,8)}… — retrying day0`);
      PINNACLE_HASH = discovered;
    }
    if (discovered) {
      ({ matches: m0, hashInvalid: inv0 } = await tryNextCombo(PINNACLE_HASH, GS_PRIMARY, timestamp, 0));
    } else {
      console.log('NextAll: auto-discovery failed');
    }
  }
  if (!m0) {
    return { matches: [], pinnacleHashFailed: inv0, pinnacleHash: PINNACLE_HASH, bet365HashFailed: false, bet365Hash: BET365_HASH };
  }

  // Merge day0 results, then fetch day1..maxDays with the now-confirmed hash
  const seen = new Map();
  const addMatches = (list) => {
    for (const m of list) {
      if (m.id && !seen.has(m.id)) seen.set(m.id, m);
      else if (!m.id) seen.set(Symbol(), m);
    }
  };
  addMatches(m0);

  for (let day = 1; day <= maxDays; day++) {
    try {
      const { matches: dm } = await tryNextCombo(PINNACLE_HASH, GS_PRIMARY, timestamp, day);
      if (dm && dm.length) { addMatches(dm); console.log(`  NextAll day${day}: ${dm.length} matches`); }
      else                  console.log(`  NextAll day${day}: 0 matches (empty or no data)`);
    } catch (e) {
      console.error(`  NextAll day${day} failed: ${e.message}`);
    }
  }

  const allMatches = [...seen.values()];
  console.log(`NextAll: ${allMatches.length} unique matches across day0–day${maxDays}`);

  // Attach Bet365 odds for all days
  let bet365HashFailed = false;
  const b365Map = new Map();
  for (let day = 0; day <= maxDays; day++) {
    const { map, hashFailed } = await fetchBet365OddsMap(timestamp, day);
    if (hashFailed) { bet365HashFailed = true; break; }
    for (const [id, odds] of map) b365Map.set(id, odds);
  }
  if (b365Map.size > 0) {
    let attached = 0;
    for (const m of allMatches) {
      if (m.id && b365Map.has(m.id)) { m.bet365_odds = b365Map.get(m.id); attached++; }
    }
    console.log(`  NextAll bet365: attached to ${attached}/${allMatches.length} matches`);
  }

  return { matches: allMatches, pinnacleHashFailed: false, pinnacleHash: PINNACLE_HASH, bet365HashFailed, bet365Hash: BET365_HASH };
}

// ── OPENLINE window fetch ─────────────────────────────────────────────────────
// Strategy OPENLINE (notify.js) needs matches from ~a week out, not just the
// day0 slice fetchNextMatches() gives — asianbetsoccer's nextgame.html/
// tablenext table is day-indexed (day0 = today, dayN = today+N, confirmed
// against the real site 2026-09-05: day7 returned kickoffs exactly 7 days
// out, with opening 1X2/AH/TL odds already populated). Scans day0..maxDay and
// unions by id — deliberately wider than exactly "day7" so a league that
// posts its line a bit earlier/later than a week still gets caught; the
// caller's own dedup (by match id) makes seeing the same match on multiple
// days harmless. tryNextCombo already merges odds (getData2) + meta incl.
// 1X2 (getDatanext1/x2, see parseGetDatanext1Calls) per day, so no separate
// odds-attach pass is needed here — unlike the older, broken
// fetchNextMatchesAllDays above (still hardcoded to the dead PINNACLE_HASH,
// left in place unexported/unused rather than touched for this change).
async function fetchOpenlineMatches(maxDay = 9) {
  const timestamp = Date.now();
  console.log(`OpenLine: hash=${BET365_HASH.slice(0,8)}…  scanning day0–day${maxDay}`);

  const seen = new Map();
  let hashFailed = false;

  for (let day = 0; day <= maxDay; day++) {
    let { matches, hashInvalid } = await tryNextCombo(BET365_HASH, GS_PRIMARY, timestamp, day);
    if (!matches && hashInvalid) {
      console.log(`OpenLine: hash invalid at day${day} — auto-discovering…`);
      const discovered = await fetchBet365Hash();
      if (discovered && discovered !== BET365_HASH) {
        BET365_HASH = discovered;
        ({ matches, hashInvalid } = await tryNextCombo(BET365_HASH, GS_PRIMARY, timestamp, day));
      }
    }
    if (!matches) { if (hashInvalid) hashFailed = true; continue; }
    for (const m of matches) if (m.id) seen.set(m.id, m);
  }

  const allMatches = [...seen.values()];
  for (const m of allMatches) m.bet365_odds = m.odds;
  console.log(`OpenLine: ${allMatches.length} unique matches across day0–day${maxDay}`);
  return { matches: allMatches, bet365HashFailed: hashFailed, bet365Hash: BET365_HASH };
}

// Current in-memory hashes with no network call — used by notify.js's /hashes
// HTTP endpoint so the Cloudflare Pages Function can relay through Railway
// when its own direct discovery is blocked (see functions/api/livescore.js).
function getCurrentHashes() {
  return { pinnacle: PINNACLE_HASH, bet365: BET365_HASH, bet365live: BET365_LIVE_HASH, sbobet: SBOBET_HASH };
}

// module.exports = { fetchLiveMatches, fetchNextMatches, fetchNextMatchesAllDays, refreshHashes };
module.exports = { fetchLiveMatches, fetchNextMatches, fetchOpenlineMatches, fetchSbobetMatches, refreshHashes, getCurrentHashes, checkStaleHashHeuristic };
