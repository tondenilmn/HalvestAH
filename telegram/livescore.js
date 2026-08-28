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
let PINNACLE_HASH = process.env.PINNACLE_HASH || '30e528c380c96b362ffacdc66b2808c8ad59ce9e';
let BET365_HASH   = process.env.BET365_HASH   || '6f8bbe38e5554e2b299bb07bfe3f19640061088a';
let SBOBET_HASH   = process.env.SBOBET_HASH   || 'f1bd8f485d42c4e9700599b0db02cd537a78801f';
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
    results.push({ matchId, homeTeam, awayTeam, league, minute, kickoffTime, score });
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
      odds,
    });
  }
  return matches;
}

// ── tablenext parser ──────────────────────────────────────────────────────────
// getDatanext1(rowIdx, ?, leagueKey, encodedOdds, statusCode,
//   matchId, leagueName, homeTeam, kickoffTimeUTC, h1X2c, dX2c, a1X2c,
//   h1X2o, dX2o, a1X2o, awayTeam)
function parseGetDatanext1Calls(jsText) {
  const re = /\bmatch1text\s*\+=\s*getDatanext1\s*\(/g;
  const results = [];
  let m;
  while ((m = re.exec(jsText)) !== null) {
    const args = extractCallArgs(jsText, m.index + m[0].length);
    if (args.length < 16) continue;
    const matchId     = (typeof args[5] === 'string' && /^[a-f0-9]{20,}$/i.test(args[5])) ? args[5] : null;
    const league      = typeof args[6]  === 'string' ? args[6]  : '';
    const homeTeam    = typeof args[7]  === 'string' ? args[7]  : '';
    const kickoffTime = typeof args[8]  === 'string' ? args[8]  : null;  // UTC ISO with Z
    const awayTeam    = typeof args[15] === 'string' ? args[15] : '';
    results.push({ matchId, homeTeam, awayTeam, league, minute: null, kickoffTime, score: null });
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
// Anchored exact-match — the page also lists a separate "Bet365 Live" option
// whose hash serves a different feed (0 odds rows on the livegame endpoint);
// a loose /bet\s*365/i match would collide with it and silently overwrite
// the correct hash with a broken one since the loop below takes the last match.
const BOOK_PATTERNS = {
  pinnacle: /^pinnacle$/i,
  bet365:   /^bet\s*365$/i,
  sbobet:   /^sbo\s*bet$/i,
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
  if (!HASH_RELAY_URL) return { pinnacle: null, bet365: null, sbobet: null };
  const url = `${HASH_RELAY_URL.replace(/\/$/, '')}/api/livescore`;
  try {
    const resp = await fetch(url);
    if (!resp.ok) {
      console.log(`  relay ${url} → HTTP ${resp.status}`);
      return { pinnacle: null, bet365: null, sbobet: null };
    }
    const json = await resp.json();
    const isHash = v => typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v);
    const result = {
      bet365:   isHash(json.book)          ? json.book          : null,
      pinnacle: isHash(json.pinnacle_book) ? json.pinnacle_book : null,
      sbobet:   isHash(json.sbobet_book)   ? json.sbobet_book   : null,
    };
    console.log(`  relay → bet365=${result.bet365?.slice(0,8) ?? '—'}… pinnacle=${result.pinnacle?.slice(0,8) ?? '—'}… sbobet=${result.sbobet?.slice(0,8) ?? '—'}…`);
    return result;
  } catch (e) {
    console.log(`  relay fetch threw: ${e.message}`);
    return { pinnacle: null, bet365: null, sbobet: null };
  }
}

// Shared between the plain-fetch path and the headless-browser path below —
// both end up with the same rendered/raw HTML, just fetched a different way.
function parseBookHashesFromHtml(html) {
  const result = { pinnacle: null, bet365: null, sbobet: null };
  const optRe = /value="([a-f0-9]{40})"[^>]*>\s*([^<]+)/gi;
  let m;
  while ((m = optRe.exec(html)) !== null) {
    const [, hash, rawLabel] = m;
    const label = rawLabel.trim();
    if (!result.pinnacle && BOOK_PATTERNS.pinnacle.test(label)) result.pinnacle = hash;
    else if (!result.bet365 && BOOK_PATTERNS.bet365.test(label)) result.bet365   = hash;
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
    if (!resp.ok) return { pinnacle: null, bet365: null, sbobet: null };
    const html = await resp.text();
    const result = parseBookHashesFromHtml(html);

    return result;
  } catch (e) {
    // Was previously a bare `catch {}` — swallowed the real error (e.g. a
    // network-level failure fetching asianbetsoccer.com, distinct from an
    // HTTP error status) with no log line at all, making a Railway-specific
    // failure indistinguishable from "site returned no matches" in logs.
    console.log(`  livescore.html fetch threw: ${e.message}`);
    return { pinnacle: null, bet365: null, sbobet: null };
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
    return { pinnacle: null, bet365: null, sbobet: null };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const page = await browser.newPage({
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
      locale: 'it-IT',
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
    console.log(`  Browser fallback → bet365=${result.bet365?.slice(0,8) ?? '—'}… pinnacle=${result.pinnacle?.slice(0,8) ?? '—'}… sbobet=${result.sbobet?.slice(0,8) ?? '—'}…`);
    return result;
  } catch (e) {
    console.log(`  Browser fallback threw: ${e.message}`);
    return { pinnacle: null, bet365: null, sbobet: null };
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
async function fetchAllBookHashes() {
  const direct = await fetchAllBookHashesDirect();
  if (direct.pinnacle || direct.bet365 || direct.sbobet) return direct;

  console.log('  Direct scrape returned nothing — trying headless browser…');
  const viaBrowser = await fetchAllBookHashesViaBrowser();
  if (viaBrowser.pinnacle || viaBrowser.bet365 || viaBrowser.sbobet) return viaBrowser;

  if (!HASH_RELAY_URL) {
    console.log('  Browser fallback returned nothing and HASH_RELAY_URL/DATA_URL not set — no fallback available.');
    return direct;
  }
  console.log('  Direct scrape returned nothing — trying Cloudflare relay…');
  return fetchHashesViaRelay();
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
  const { pinnacle, bet365, sbobet } = await fetchAllBookHashes();

  let changed = 0;
  if (pinnacle && pinnacle !== PINNACLE_HASH) { console.log(`  Pinnacle: ${PINNACLE_HASH.slice(0,8)}… → ${pinnacle.slice(0,8)}…`); PINNACLE_HASH = pinnacle; changed++; }
  if (bet365   && bet365   !== BET365_HASH)   { console.log(`  Bet365:   ${BET365_HASH.slice(0,8)}… → ${bet365.slice(0,8)}…`);   BET365_HASH   = bet365;   changed++; }
  if (sbobet   && sbobet   !== SBOBET_HASH)   { console.log(`  Sbobet:   ${SBOBET_HASH.slice(0,8)}… → ${sbobet.slice(0,8)}…`);   SBOBET_HASH   = sbobet;   changed++; }
  if (changed === 0) console.log('  All hashes still current.');
  return { pinnacle: PINNACLE_HASH, bet365: BET365_HASH, sbobet: SBOBET_HASH };
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

// Current in-memory hashes with no network call — used by notify.js's /hashes
// HTTP endpoint so the Cloudflare Pages Function can relay through Railway
// when its own direct discovery is blocked (see functions/api/livescore.js).
function getCurrentHashes() {
  return { pinnacle: PINNACLE_HASH, bet365: BET365_HASH, sbobet: SBOBET_HASH };
}

// module.exports = { fetchLiveMatches, fetchNextMatches, fetchNextMatchesAllDays, refreshHashes };
module.exports = { fetchLiveMatches, fetchNextMatches, refreshHashes, getCurrentHashes };
