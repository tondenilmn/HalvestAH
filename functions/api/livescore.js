/**
 * Cloudflare Pages Function: GET /api/livescore[?debug=1]
 *
 * Fetches live Pinnacle odds from botbot3.space livegame endpoint:
 *   botbot3.space/tables/v4/Q/livegame/555a04df41c008dbb9fae7894ff184cfe09692ec.js?date={ts}
 *
 * The livegame JS file does NOT embed HTML strings. Instead it builds match tables
 * by calling getData1() and getData2() repeatedly:
 *   match2text += getData2(rowIdx, 1, leagueId, enc, matchId, ah_hc, ah_ho, ...)
 *   match1text += getData1(rowIdx, 1, leagueId, enc, matchId, homeTeam, awayTeam, ...)
 *
 * We extract data directly from function call arguments instead of parsing HTML.
 *
 * Confirmed getData2() param indices (from browser Network tab):
 *   [0]=rowIdx  [1]=1  [2]=leagueId  [3]=encodedStr  [4]=matchId (40-char hex)
 *   [5]=ah_hc   [6]=ah_ho   [7]=ahDir
 *   [8]=awayAhC [9]=awayAhO [10]=awayAhDir
 *   [11]=ho_c   [12]=ho_o   [13]=hoDir   [14],[15]=extra
 *   [16]=ao_c   [17]=ao_o   [18]=aoDir   [19],[20]=extra
 *   [21]=tl_c   [22]=tl_o   [23]=tlDir
 *   [24]=ov_c   [25]=ov_o   [26-28]=codes
 *   [29]=un_c   [30]=un_o
 *
 * getData1() param positions assumed to follow same header pattern:
 *   [0]=rowIdx  [1]=1  [2]=leagueId  [3]=encodedStr  [4]=matchId
 *   [5]=homeTeam  [6]=awayTeam  (best guess — verify via ?debug=1 → getData1_sample)
 *
 * Returns:
 *   { matches: [{ id, url, home_team, away_team, score, odds: { ah_hc,… } }] }
 *   { matches: [], note: "…" }  — when no live data found
 */

// Bet365 is the PRIMARY (and effectively only) source now — Pinnacle is no
// longer listed on asianbetsoccer's #book_filter dropdown at all (confirmed
// 2026-08-22), so its hash can never be auto-discovered again; only
// hardcoded/env-var overrides could ever work for it, and even those go
// stale fast since it's delisted. Bet365's hash IS still listed and can
// self-heal via fetchAllBookHashes below. This mirrors telegram/livescore.js,
// which made the same switch already — see that file's own comment for the
// full history. PINNACLE_HASH is kept only as a best-effort secondary
// odds source (silently empty if it fails, same as SBOBET_HASH).
let PINNACLE_HASH = '30e528c380c96b362ffacdc66b2808c8ad59ce9e'; // overridden at runtime from context.env
let BET365_HASH   = '553c7f0fdbb889a93c9a85abaa1639de76943277'; // overridden at runtime from context.env
let SBOBET_HASH   = 'f1bd8f485d42c4e9700599b0db02cd537a78801f'; // overridden at runtime from context.env
// "Bet365 Live" — a separate #book_filter option from plain Bet365 (see
// BOOK_PATTERNS comment below). Confirmed 2026-09-06 by diffing this feed
// against plain Bet365 for the same match 6 minutes into play: its "open"
// position exactly matched plain Bet365's "close" (the real pre-match
// closing line), while its "close" position was already a different,
// moving number — i.e. this feed's "close" is the actual current live
// in-play price, not a second closing snapshot. Used as the live market
// price to compare our own model probability against for in-play value
// detection (api-football isn't usable for this yet — see PRODUCT context).
let BET365_LIVE_HASH = '56f7105ddda384f0955acb8ffe874c8b61daec49'; // overridden at runtime from context.env
// gS candidates — 'Q' is the confirmed primary value; rest are fallbacks.
// Auto-discovery (fetchAllBookHashes) is tried before the sweep when the primary hash fails.
// Worst-case subrequest budget: 1 (fast path) + 1 (page fetch) + 1 (Q+discovered) + 18 (sweep) = 21, well under 50.
const GS_PRIMARY    = 'Q';
const GS_CANDIDATES = ['Q', '1', '2', '3', 'AH', 'S', 'EU', 'A', 'ah', 's', '4', '5', '10', '6', '7', '8', 'B', 'F'];

// asianbetsoccer.com's WAF blocks a full desktop-Chrome User-Agent string
// (403) from some networks/hosts while accepting a bare "Mozilla/5.0" — try
// the full header set first (looks like a real browser where it isn't
// blocked), then fall back to the minimal UA that's known to get through.
// This was the actual root cause of the Daily Dashboard returning zero
// matches (2026-08-22): the fast-path Pinnacle hash 404'd (expected, they
// rotate), and the old single-header-set discovery fetch got a silent 403,
// so it never found a replacement hash at all — and Pinnacle wasn't even on
// the dropdown any more regardless.
const LIVESCORE_HEADER_SETS = [
  {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  },
  { 'User-Agent': 'Mozilla/5.0' },
];

// Anchored exact-match — the page also lists a separate "Bet365 Live" option
// (a real, separately useful feed — see BET365_LIVE_HASH above, not "0 odds
// rows" as originally assumed here); a loose /bet\s*365/i match would still
// collide with it and silently overwrite the plain-Bet365 hash since a naive
// loop takes the last match, so both patterns stay anchored and distinct.
const BOOK_PATTERNS = {
  pinnacle:   /^pinnacle$/i,
  bet365:     /^bet\s*365$/i,
  bet365live: /^bet\s*365\s*live$/i,
  sbobet:     /^sbo\s*bet$/i,
};

/**
 * Fetch the asianbetsoccer livescore page once and extract all three book
 * hashes from the #book_filter <select> options. Returns
 * { pinnacle, bet365, sbobet } — any value may be null if not found/delisted.
 */
// `diag` (optional) is filled in with what actually happened, so a caller
// (currently only the ?debug=1 handler) can tell "asianbetsoccer.com itself
// rejected/blocked this request" apart from "fetch succeeded but nothing
// matched the parser" — the two look identical from the plain
// {pinnacle,bet365,sbobet} result alone, which made an earlier failure on
// this exact path (Cloudflare edge unable to discover a fresh hash even
// though the same code works from other networks) impossible to diagnose
// without deploying extra logging each time.
async function fetchAllBookHashes(diag = null) {
  try {
    let resp, html;
    const attempts = [];
    for (const headers of LIVESCORE_HEADER_SETS) {
      resp = await fetch('https://www.asianbetsoccer.com/it/livescore.html', { headers });
      const bodyText = await resp.text();
      attempts.push({ ua: headers['User-Agent'], status: resp.status, ok: resp.ok, bodyLength: bodyText.length, bodySample: diag ? bodyText.slice(0, 500) : undefined });
      // A 2xx status with a near-empty body is a WAF/challenge interstitial,
      // not the real page — don't stop early on that, keep trying header
      // sets. Only accept a response that's actually the size of a real
      // livescore.html page.
      if (resp.ok && bodyText.length > 2000) { html = bodyText; break; }
    }
    if (diag) diag.attempts = attempts;
    if (html == null) return { pinnacle: null, bet365: null, bet365live: null, sbobet: null };
    if (diag) { diag.htmlLength = html.length; diag.htmlSample = html.slice(0, 500); }

    const result = { pinnacle: null, bet365: null, bet365live: null, sbobet: null };
    const optRe = /value="([a-f0-9]{40})"[^>]*>\s*([^<]+)/gi;
    let m;
    const allOptions = [];
    while ((m = optRe.exec(html)) !== null) {
      const [, hash, rawLabel] = m;
      const label = rawLabel.trim();
      allOptions.push({ hash: hash.slice(0, 8) + '…', label });
      if (!result.pinnacle && BOOK_PATTERNS.pinnacle.test(label)) result.pinnacle = hash;
      else if (!result.bet365 && BOOK_PATTERNS.bet365.test(label)) result.bet365   = hash;
      else if (!result.bet365live && BOOK_PATTERNS.bet365live.test(label)) result.bet365live = hash;
      else if (!result.sbobet && BOOK_PATTERNS.sbobet.test(label)) result.sbobet   = hash;
    }
    if (diag) diag.optionsFound = allOptions;

    // Fallback for Pinnacle: botbot3.space livegame URL embedded in page scripts
    if (!result.pinnacle) {
      const m2 = html.match(/botbot3\.space\/tables\/v4\/[^/]+\/livegame\/([a-f0-9]{40})\.js/);
      if (m2) result.pinnacle = m2[1];
    }

    return result;
  } catch (e) {
    if (diag) diag.error = e.message;
    return { pinnacle: null, bet365: null, bet365live: null, sbobet: null };
  }
}

async function fetchPinnacleHash()   { return (await fetchAllBookHashes()).pinnacle; }
async function fetchBet365Hash()     { return (await fetchAllBookHashes()).bet365; }
async function fetchBet365LiveHash() { return (await fetchAllBookHashes()).bet365live; }

// Second-line fallback when fetchAllBookHashes() above comes back empty —
// confirmed 2026-08-24 that asianbetsoccer.com's WAF returns a 202
// bot-challenge (193-byte body, both header sets) to every request
// originating from Cloudflare's edge network, so direct discovery from this
// Function can never succeed on its own. telegram/notify.js (running on
// Railway, a different network not subject to that block) exposes its own
// last-discovered hash via GET /hashes — relay through that instead. Set
// RAILWAY_RELAY_URL to the Railway service's public URL to enable.
// telegram/notify.js's /hashes endpoint (Railway, not subject to the WAF
// block Cloudflare's edge hits) also discovers/exposes bet365live_hash — see
// that file's getCurrentHashes()/startHashRelayServer.
async function fetchHashesViaRailwayRelay(railwayRelayUrl, diag = null) {
  if (!railwayRelayUrl) return { pinnacle: null, bet365: null, bet365live: null, sbobet: null };
  const url = `${railwayRelayUrl.replace(/\/$/, '')}/hashes`;
  try {
    const resp = await fetch(url);
    if (diag) diag.railwayRelay = { url, status: resp.status, ok: resp.ok };
    if (!resp.ok) return { pinnacle: null, bet365: null, bet365live: null, sbobet: null };
    const json = await resp.json();
    const isHash = v => typeof v === 'string' && /^[a-f0-9]{40}$/i.test(v);
    return {
      pinnacle:   isHash(json.pinnacle_hash)   ? json.pinnacle_hash   : null,
      bet365:     isHash(json.bet365_hash)     ? json.bet365_hash     : null,
      bet365live: isHash(json.bet365live_hash) ? json.bet365live_hash : null,
      sbobet:     isHash(json.sbobet_hash)     ? json.sbobet_hash     : null,
    };
  } catch (e) {
    if (diag) diag.railwayRelay = { url, error: e.message };
    return { pinnacle: null, bet365: null, bet365live: null, sbobet: null };
  }
}

/**
 * Fetch live odds for a secondary bookmaker (Bet365, Sbobet) by hash.
 * Returns Map<matchId, odds>. Non-fatal — empty map on any error.
 */
async function fetchLiveOddsMap(hash, timestamp) {
  if (!hash) return new Map();
  const url = `https://botbot3.space/tables/v4/${GS_PRIMARY}/livegame/${hash}.js?date=${timestamp}&_=${timestamp + 1}`;
  try {
    const resp = await fetch(url, { headers: makeBotbotHeaders(GS_PRIMARY, hash) });
    if (!resp.ok) return new Map();
    const jsText   = await resp.text();
    const oddsRows = parseGetData2Calls(jsText);
    const map = new Map();
    for (const row of oddsRows) {
      if (row.matchId) map.set(row.matchId, row.odds);
    }
    return map;
  } catch {
    return new Map();
  }
}

/**
 * Fetch the current live market odds (Bet365 Live feed) by matchId.
 * Returns Map<matchId, liveOdds>. Best-effort like fetchLiveOddsMap —
 * empty map on any failure, never blocks the primary Bet365 fetch.
 */
async function fetchBet365LiveMarketMap(hash, timestamp) {
  if (!hash) return new Map();
  const url = `https://botbot3.space/tables/v4/${GS_PRIMARY}/livegame/${hash}.js?date=${timestamp}&_=${timestamp + 1}`;
  try {
    const resp = await fetch(url, { headers: makeBotbotHeaders(GS_PRIMARY, hash) });
    if (!resp.ok) return new Map();
    const jsText = await resp.text();
    const rows   = parseGetData2NoneCalls(jsText);
    const map    = new Map();
    for (const row of rows) map.set(row.matchId, row.live_odds);
    return map;
  } catch {
    return new Map();
  }
}

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

export async function onRequest(context) {
  if (context.env?.PINNACLE_HASH)   PINNACLE_HASH   = context.env.PINNACLE_HASH;
  if (context.env?.BET365_HASH)     BET365_HASH     = context.env.BET365_HASH;
  if (context.env?.BET365_LIVE_HASH) BET365_LIVE_HASH = context.env.BET365_LIVE_HASH;
  if (context.env?.SBOBET_HASH)     SBOBET_HASH     = context.env.SBOBET_HASH;
  const RAILWAY_RELAY_URL = context.env?.RAILWAY_RELAY_URL || null;

  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type':                 'application/json',
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: cors });
  }

  const reqUrl  = new URL(context.request.url);
  const isDebug = reqUrl.searchParams.get('debug') === '1';

  // ?hashes=1 — return current active hashes (from env vars) without any botbot3 fetch.
  // Used by the Telegram notifier to bootstrap its hashes from the Cloudflare dashboard.
  if (reqUrl.searchParams.get('hashes') === '1') {
    return new Response(
      JSON.stringify({
        pinnacle_hash:   PINNACLE_HASH,
        bet365_hash:     BET365_HASH,
        bet365live_hash: BET365_LIVE_HASH,
        sbobet_hash:     SBOBET_HASH,
      }),
      { headers: cors }
    );
  }

  // ?debug=1 — inspect the raw JS and show extraction results (Bet365 hash,
  // since that's the primary source now — see constant comments above).
  // Also runs hash auto-discovery (fetchAllBookHashes) with diagnostics —
  // unlike the production path, this reports WHY discovery failed (blocked
  // fetch to asianbetsoccer.com vs. fetch OK but parser found nothing) so a
  // Cloudflare-edge-specific failure can be told apart from a stale hash.
  if (isDebug) {
    const hashDiag = {};
    let discoveredHashes = await fetchAllBookHashes(hashDiag);
    if (!discoveredHashes.pinnacle && !discoveredHashes.bet365 && !discoveredHashes.sbobet) {
      discoveredHashes = await fetchHashesViaRailwayRelay(RAILWAY_RELAY_URL, hashDiag);
    }

    const ts  = Date.now();
    const url = `https://botbot3.space/tables/v4/Q/livegame/${BET365_HASH}.js?date=${ts}&_=${ts + 1}`;
    const r   = await fetch(url, { headers: makeBotbotHeaders('Q', BET365_HASH) })
      .catch(e => ({ ok: false, status: 0, text: async () => e.message }));
    const body = await r.text();

    const oddsRows  = parseGetData2Calls(body);
    let   metaRows  = parseGetData1Calls(body);
    if (metaRows.length === 0) {
      const tm1Html = extractHtmlFromJs(body, 'tablematch1') ?? extractVarFromJs(body, 'match1text');
      if (tm1Html) metaRows = parseMatch1HtmlForMeta(tm1Html);
    }
    const matches  = mergeMatchData(oddsRows, metaRows);

    // Collect all getData1 call argument arrays for inspection
    const getData1Parsed = [];
    const re1 = /\bmatch1text\s*\+=\s*getData(?:live|last)1\s*\(/g;
    let rm1;
    while ((rm1 = re1.exec(body)) !== null) {
      const args = extractCallArgs(body, rm1.index + rm1[0].length);
      getData1Parsed.push(args);
    }

    // Diagnose orphan getData1 entries (meta rows with no matching getData2 odds row)
    const data2MatchIds = new Set(oddsRows.map(r => r.matchId).filter(Boolean));
    const orphans = metaRows
      .filter(m => m.matchId && !data2MatchIds.has(m.matchId))
      .map(m => {
        const inRawJs = body.includes(m.matchId);
        const idx     = body.indexOf(m.matchId);
        // Show 250 chars before matchId to capture the function name, 100 after for the first few args
        const context = inRawJs ? body.slice(Math.max(0, idx - 250), idx + 100).replace(/\s+/g, ' ') : null;
        return { matchId: m.matchId, home: m.homeTeam, away: m.awayTeam, minute: m.minute, inRawJs, context };
      });

    return new Response(
      JSON.stringify({
        status:           r.status,
        ok:               r.ok,
        url,
        raw_len:          body.length,
        getData2_count:   oddsRows.length,
        getData1_count:   metaRows.length,
        match_count:      matches.length,
        matches_preview:  matches,
        getData1_parsed:  getData1Parsed,
        orphan_meta:      orphans,
        hash_discovery: {
          seeded_bet365_hash:      BET365_HASH,
          seeded_bet365live_hash:  BET365_LIVE_HASH,
          discovered:              discoveredHashes,
          diag:                    hashDiag,
        },
      }),
      { headers: cors }
    );
  }

  const timestamp = Date.now();
  let lastError   = '';

  /**
   * Try a single (hash, gS) combination for the livegame endpoint.
   * Returns { matches, method } on success, null on failure.
   * Updates lastError on failure.
   */
  async function tryComboData(hash, gS) {
    const dataUrl = `https://botbot3.space/tables/v4/${gS}/livegame/${hash}.js?date=${timestamp}&_=${timestamp + 1}`;
    let jsText;
    try {
      const resp = await fetch(dataUrl, { headers: makeBotbotHeaders(gS, hash) });
      if (!resp.ok) {
        lastError = `HTTP ${resp.status} (gS=${gS}, book=${hash.slice(0, 8)}…)`;
        return null;
      }
      jsText = await resp.text();
    } catch (e) {
      lastError = e.message;
      return null;
    }

    const oddsRows = parseGetData2Calls(jsText);

    if (oddsRows.length === 0) {
      const tm1Html = extractHtmlFromJs(jsText, 'tablematch1') ?? extractVarFromJs(jsText, 'match1text');
      const tm2Html = extractHtmlFromJs(jsText, 'tablematch2') ?? extractVarFromJs(jsText, 'match2text');
      if (tm1Html && tm2Html) {
        return { matches: parseLivegameTables(tm1Html, tm2Html), method: 'html' };
      }
      lastError = `200 OK but no getData2() calls or HTML tables (gS=${gS}, book=${hash.slice(0, 8)}…)`;
      return null;
    }

    let metaRows = parseGetData1Calls(jsText);
    if (metaRows.length === 0) {
      const tm1Html = extractHtmlFromJs(jsText, 'tablematch1') ?? extractVarFromJs(jsText, 'match1text');
      if (tm1Html) metaRows = parseMatch1HtmlForMeta(tm1Html);
    }

    return { matches: mergeMatchData(oddsRows, metaRows), method: 'args' };
  }

  /**
   * Try a single (hash, gS) combination for the tablenext endpoint.
   * Returns match array on success, null on failure.
   */
  async function tryNextComboData(hash, gS) {
    const url = `https://botbot3.space/tables/v4/${gS}/tablenext/day0/${hash}.js?date=${timestamp}&_=${timestamp + 1}`;
    let jsText;
    try {
      const resp = await fetch(url, { headers: makeBotbotHeaders(gS, hash) });
      if (!resp.ok) return null;
      jsText = await resp.text();
    } catch { return null; }

    const oddsRows = parseGetData2Calls(jsText);
    if (oddsRows.length === 0) return null;
    const metaRows = parseGetDatanext1Calls(jsText);
    return mergeMatchData(oddsRows, metaRows);
  }

  // ── Fast path: try stored Bet365 hash. On 404, auto-discover and retry. ──
  // Bet365 is primary (see the constant comments above for why) — it carries
  // both the match list AND its own odds off one call, unlike the old
  // Pinnacle-primary design which needed a separate secondary-odds fetch.
  let liveResult = await tryComboData(BET365_HASH, GS_PRIMARY);

  if (!liveResult && lastError.includes('404')) {
    // Direct discovery from Cloudflare's edge is blocked by asianbetsoccer's
    // WAF (confirmed 2026-08-24 — 202 bot-challenge on every attempt), so
    // fall back to relaying through Railway (telegram/notify.js's /hashes
    // endpoint), a network that isn't subject to that block.
    let discovered = await fetchBet365Hash();
    if (!discovered) discovered = (await fetchHashesViaRailwayRelay(RAILWAY_RELAY_URL)).bet365;
    if (discovered && discovered !== BET365_HASH) {
      BET365_HASH = discovered;
      lastError = '';
      liveResult = await tryComboData(BET365_HASH, GS_PRIMARY);
    }
  }

  if (!liveResult) {
    return new Response(
      JSON.stringify({
        matches: [],
        note: `Hash ${BET365_HASH.slice(0,8)}… failed. ${lastError}`,
        // Still report whatever hashes are currently held, even though the
        // live fetch itself failed — otherwise a relay caller (Railway's
        // livescore.js falling back to this endpoint) sees a response with
        // no hash fields at all and can't tell this apart from "nothing
        // known", even when one of the three books is still valid.
        book:            BET365_HASH,
        bet365live_book: BET365_LIVE_HASH,
        pinnacle_book:   PINNACLE_HASH,
        sbobet_book:     SBOBET_HASH,
      }),
      { headers: cors }
    );
  }

  // ── Fetch tablenext + secondary (reference) book odds in parallel ───────
  // Pinnacle/Sbobet are best-effort only now — fetchLiveOddsMap silently
  // returns an empty map on any failure, so a delisted/stale Pinnacle hash
  // just means no reference odds for that book, not a broken response.
  const [nextMatches, pinnacleMap, sboMap, bet365LiveMap] = await Promise.all([
    tryNextComboData(BET365_HASH, GS_PRIMARY).then(r => r ?? []),
    fetchLiveOddsMap(PINNACLE_HASH, timestamp),
    fetchLiveOddsMap(SBOBET_HASH, timestamp),
    fetchBet365LiveMarketMap(BET365_LIVE_HASH, timestamp),
  ]);

  // Attach reference odds to each Bet365 match by shared matchId
  for (const m of liveResult.matches) {
    if (!m.id) continue;
    if (pinnacleMap.has(m.id))   m.pinnacle_odds    = pinnacleMap.get(m.id);
    if (sboMap.has(m.id))        m.sbobet_odds      = sboMap.get(m.id);
    // The actual current live/in-play market price (Bet365 Live feed) — use
    // this, not m.odds/m.bet365_odds (the frozen pre-match close), for any
    // in-play comparison against a model probability. See BET365_LIVE_HASH
    // above for how this differs from the other reference-odds maps.
    if (bet365LiveMap.has(m.id)) m.bet365_live_odds = bet365LiveMap.get(m.id);
    // Alias for consumers that expect this field name (e.g. telegram/
    // notify.js's L123 reads match.bet365_odds from its own livescore.js —
    // unrelated to this function, but kept consistent).
    m.bet365_odds = m.odds;
  }

  return new Response(
    JSON.stringify({
      matches:         liveResult.matches,
      next_matches:    nextMatches,
      gS:              GS_PRIMARY,
      book:            BET365_HASH,
      bet365live_book: BET365_LIVE_HASH,
      pinnacle_book:   PINNACLE_HASH,
      sbobet_book:     SBOBET_HASH,
      method:          liveResult.method,
    }),
    { headers: cors }
  );
}

/* ══════════════════════════════════════════════════════════════════════════
 * getData2() / getData1() argument extraction
 * ══════════════════════════════════════════════════════════════════════════ */

/**
 * Extract all arguments from a JS function call starting at `start`
 * (the position immediately after the opening parenthesis).
 * Handles: quoted strings (single/double), nested parens/brackets/braces,
 * escape sequences inside strings.
 */
function extractCallArgs(text, start) {
  let i = start, depth = 0, buf = '', inStr = false, strChar = '';
  const args = [];

  while (i < text.length) {
    const ch = text[i];

    if (inStr) {
      if (ch === '\\' && i + 1 < text.length) {
        buf += ch + text[i + 1];
        i += 2;
        continue;
      }
      if (ch === strChar) inStr = false;
      buf += ch;
      i++;
      continue;
    }

    if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
      buf += ch;
    } else if ('([{'.includes(ch)) {
      depth++;
      buf += ch;
    } else if (')]}'.includes(ch)) {
      if (depth === 0) {
        // Closing ')' ends the argument list
        const t = buf.trim();
        if (t) args.push(parseArgValue(t));
        break;
      }
      depth--;
      buf += ch;
    } else if (ch === ',' && depth === 0) {
      args.push(parseArgValue(buf.trim()));
      buf = '';
    } else {
      buf += ch;
    }
    i++;
  }

  return args;
}

/** Parse a single JS argument value: quoted string, number, null/undefined. */
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

/**
 * Parse all `match2text += getData2(...)` calls (plain Bet365/Pinnacle/Sbobet
 * feeds — a fixed pre-match line, frozen at kickoff). The "Bet365 Live" feed
 * uses a differently-shaped `getData2none(...)` call instead — see
 * parseGetData2NoneCalls below.
 * Returns array of { matchId, odds }.
 */
function parseGetData2Calls(jsText) {
  const re = /\bmatch2text\s*\+=\s*getData2\s*\(/g;
  const results = [];
  let m;

  const pf = v => {
    const n = (typeof v === 'number') ? v : parseFloat(v);
    return isNaN(n) ? null : n;
  };

  while ((m = re.exec(jsText)) !== null) {
    const args = extractCallArgs(jsText, m.index + m[0].length);
    if (args.length < 31) continue;
    const matchId = args[4];
    if (typeof matchId !== 'string' || matchId.length < 20) continue;

    results.push({
      matchId,
      odds: {
        ah_hc: pf(args[5]),
        ah_ho: pf(args[6]),
        ho_c:  pf(args[11]),
        ho_o:  pf(args[12]),
        ao_c:  pf(args[16]),
        ao_o:  pf(args[17]),
        tl_c:  pf(args[21]),
        tl_o:  pf(args[22]),
        ov_c:  pf(args[24]),
        ov_o:  pf(args[25]),
        un_c:  pf(args[29]),
        un_o:  pf(args[30]),
      },
    });
  }

  return results;
}

/**
 * Parse `match2text += getData2none(...)` calls — the "Bet365 Live" feed
 * (BET365_LIVE_HASH), a distinct #book_filter option from plain Bet365.
 *
 * Confirmed argument indices (2026-09-06, by diffing this feed against plain
 * getData2 for the same match at minute 6 of play — every "open"-position
 * value below matched plain Bet365's "close" value exactly, confirming
 * "open" here is the frozen pre-match closing line and "close" is the real,
 * already-moved live price):
 *   [5]=matchId
 *   [7]=live ah_hc    [8]=static ah_hc (== plain Bet365 close, unused here)
 *   [11]=live ho_c    [13]=static ho_c
 *   [15]=live tl_c    [16]=static tl_c
 *   [19]=live ov_c    [21]=static ov_c
 *   [27]=live ah_ac   [28]=static ah_ac
 *   [31]=live ao_c    [33]=static ao_c
 *   [36]=live un_c    [38]=static un_c
 *   [45]=live 1X2 home  [47]=live 1X2 draw  [49]=live 1X2 away
 *     ([46]/[48]/[50] are the matching static/pre-match 1X2 odds)
 * Only the live ("close") position is extracted — the static position is
 * redundant with plain Bet365's own `odds` field already parsed elsewhere.
 */
function parseGetData2NoneCalls(jsText) {
  const re = /\bmatch2text\s*\+=\s*getData2none\s*\(/g;
  const results = [];
  let m;
  const pf = v => { const n = (typeof v === 'number') ? v : parseFloat(v); return isNaN(n) ? null : n; };

  while ((m = re.exec(jsText)) !== null) {
    const args = extractCallArgs(jsText, m.index + m[0].length);
    if (args.length < 51) continue;
    const matchId = typeof args[5] === 'string' ? args[5] : null;
    if (!matchId) continue;

    results.push({
      matchId,
      live_odds: {
        ah_hc: pf(args[7]),
        ah_ac: pf(args[27]),
        ho_c:  pf(args[11]),
        ao_c:  pf(args[31]),
        tl_c:  pf(args[15]),
        ov_c:  pf(args[19]),
        un_c:  pf(args[36]),
        x2_h:  pf(args[45]),
        x2_x:  pf(args[47]),
        x2_a:  pf(args[49]),
      },
    });
  }

  return results;
}

/**
 * Parse all `match1text += getDatalive1(...)` and `getDatalast1(...)` calls.
 * Both functions share the same parameter layout (confirmed from ?debug=1):
 *   getDatalive1/getDatalast1(rowIdx, 1, leagueId, encodedStr, statusCode, matchId,
 *                              leagueName, ?, ?, homeTeam, timeOrMinute, ..., awayTeam, ...)
 *   [0]=rowIdx  [1]=1  [2]=leagueId  [3]=encodedStr  [4]=statusCode
 *   [5]=matchId  [6]=leagueName  [7]=?  [8]=?
 *   [9]=homeTeam  [10]=timeOrMinute (ISO datetime for upcoming, "N'" for live)
 *   [22]=awayTeam
 *
 * Score: args[11]=home goals, args[23]=away goals (confirmed by cross-referencing live matches).
 * HT score: args[12]=HT home goals, args[13]=HT away goals — confirmed 2026-09-05 by hooking
 * getDatalive1() live on asianbetsoccer.com and cross-referencing several in-progress matches
 * (e.g. a 73' match at 4-1 current / 3-1 HT had args [...,"73'",4,3,1,...]). These two slots are
 * real HT-score data, not a byproduct of when the scraper started watching the match — they're
 * present in the raw feed for ANY match that has reached halftime, live or otherwise. Before HT
 * they're just `0,0` placeholders (indistinguishable from a genuine 0-0 HT), which is why the
 * site's own UI renders '-' instead of a score there — we apply the same rule via `pastHT` below.
 * Corner kicks: args[24]=home, args[25]=away.
 * args[4] statusCode contains match stats like 'Q1_FA3-SB1-FC2' — NOT the score.
 * Score is only read for live matches (minute present); upcoming matches also have 0s here.
 */
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

    // [10] is live minute ("5'") for live/HT matches, ISO datetime for upcoming matches.
    // 'HT' contains 'T' so we must whitelist it before the ISO check.
    const rawTime    = typeof args[10] === 'string' ? args[10].replace(/\\'/g, "'") : null;
    const isHT       = rawTime === 'HT';
    const minute     = rawTime && (isHT || !rawTime.includes('T')) ? rawTime : null;
    const kickoffTime = rawTime && rawTime.includes('T') && !isHT ? rawTime : null;

    // Score: args[11] = home goals, args[23] = away goals (confirmed by cross-referencing
    // multiple live matches with known scores — corner kicks are at [24]/[25]).
    // Only set score for live/HT matches (minute present); upcoming matches have 0s here too.
    let score = null;
    if (minute && args.length > 23) {
      const hg = typeof args[11] === 'number' ? args[11] : parseInt(args[11], 10);
      const ag = typeof args[23] === 'number' ? args[23] : parseInt(args[23], 10);
      if (!isNaN(hg) && !isNaN(ag) && hg >= 0 && ag >= 0) score = `${hg}-${ag}`;
    }

    // HT score: only trust args[12]/[13] once the match has actually reached halftime —
    // pre-HT they're 0,0 placeholders, not a real scoreline.
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

/**
 * Parse team names, match IDs, and live scores from a match1text HTML string.
 * Used as fallback when getData1() calls are not present.
 * match1text is built by botbot3 via += string literals (32 chunks joined).
 */
function parseMatch1HtmlForMeta(tm1Html) {
  const H_ROW = /<tr[^>]+class=['"][^'"]*tr\d+[^'"]*['"][^>]*>\s*<td[^>]*>H<\/td>([\s\S]*?)<\/tr>/gi;
  const A_ROW = /<tr[^>]+class=['"][^'"]*tr\d+[^'"]*['"][^>]*>\s*<td[^>]*>A<\/td>([\s\S]*?)<\/tr>/gi;

  const hRows = [...tm1Html.matchAll(H_ROW)].map(m => m[1]);
  const aRows = [...tm1Html.matchAll(A_ROW)].map(m => m[1]);

  const count   = Math.min(hRows.length, aRows.length);
  const results = [];

  for (let i = 0; i < count; i++) {
    const h1      = parseTds(hRows[i]);
    const a1      = parseTds(aRows[i]);
    const matchId = getMatchId(hRows[i]) ?? getMatchId(aRows[i]);

    const homeTeam = h1[0] != null ? getText(h1[0]) : '';
    const awayTeam = a1[0] != null ? getText(a1[0]) : '';

    const rowText = (hRows[i] + aRows[i]).replace(/<[^>]+>/g, ' ');
    const scoreM  = rowText.match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/);
    const score   = scoreM ? `${scoreM[1]}-${scoreM[2]}` : null;

    // The HT column is explicitly labeled (class='info'>ht</td><td>N-M</td>) — a dash means
    // the match hasn't reached halftime yet, same convention as the getData1() args path above.
    const htM = (hRows[i] + aRows[i]).match(/class=['"]info['"]>ht<\/td>\s*<td[^>]*>(\d{1,2})\s*[-–]\s*(\d{1,2})<\/td>/i);
    const htScore = htM ? `${htM[1]}-${htM[2]}` : null;

    results.push({ matchId, homeTeam, awayTeam, score, htScore });
  }

  return results;
}

/**
 * Parse all `match1text += getDatanext1(...)` calls from a tablenext JS file.
 * Returns upcoming match metadata (no score/minute — those are null for upcoming matches).
 *   [5]=matchId  [6]=leagueName  [7]=homeTeam  [8]=kickoffTimeUTC  [15]=awayTeam
 */
function parseGetDatanext1Calls(jsText) {
  const re = /\bmatch1text\s*\+=\s*getDatanext1\s*\(/g;
  const results = [];
  let m;
  while ((m = re.exec(jsText)) !== null) {
    const args        = extractCallArgs(jsText, m.index + m[0].length);
    const matchId     = (typeof args[5] === 'string' && /^[a-f0-9]{20,}$/i.test(args[5])) ? args[5] : null;
    const league      = typeof args[6]  === 'string' ? args[6]  : '';
    const homeTeam    = typeof args[7]  === 'string' ? args[7]  : '';
    const kickoffTime = typeof args[8]  === 'string' ? args[8]  : null;
    const awayTeam    = typeof args[15] === 'string' ? args[15] : '';
    results.push({ matchId, homeTeam, awayTeam, league, minute: null, kickoffTime, score: null });
  }
  return results;
}

/**
 * Merge odds rows and metadata rows into final match objects.
 * Matches by matchId when available, otherwise by array index.
 */
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

    // Skip rows with no odds at all
    if (odds.ah_hc === null && odds.ho_c === null && odds.tl_c === null) continue;

    matches.push({
      id,
      url,
      home_team:    meta.homeTeam    || '',
      away_team:    meta.awayTeam    || '',
      league:       meta.league      || '',
      minute:       meta.minute      || null,
      kickoff_time: meta.kickoffTime || null,
      score:        meta.score       || null,
      ht_score:     meta.htScore     || null,
      odds,
    });
  }

  return matches;
}

/* ══════════════════════════════════════════════════════════════════════════
 * HTML string fallback — handles older botbot3 format where tables are
 * embedded as jQuery .html("…") calls or match1text += "…" string literals.
 * ══════════════════════════════════════════════════════════════════════════ */

function extractHtmlFromJs(jsText, tableId) {
  const marker = `$("#${tableId}").html("`;
  const start  = jsText.indexOf(marker);
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
    } else if (ch === '"') {
      break;
    } else {
      chars.push(ch);
      i++;
    }
  }
  return chars.join('');
}

function extractQuotedString(text, startIdx) {
  let i = startIdx;
  while (i < text.length && (text[i] === ' ' || text[i] === '\t')) i++;
  if (i >= text.length) return null;
  const quote = text[i];
  if (quote !== '"' && quote !== "'") return null;
  i++;
  const chars = [];
  while (i < text.length) {
    const ch = text[i];
    if (ch === '\\' && i + 1 < text.length) {
      const nx = text[i + 1];
      if      (nx === '"')  chars.push('"');
      else if (nx === "'")  chars.push("'");
      else if (nx === '\\') chars.push('\\');
      else if (nx === 'n')  chars.push('\n');
      else if (nx === 'r')  chars.push('\r');
      else if (nx === 't')  chars.push('\t');
      else                  chars.push(nx);
      i += 2;
    } else if (ch === quote) {
      break;
    } else {
      chars.push(ch);
      i++;
    }
  }
  return chars.join('');
}

function extractVarFromJs(jsText, varName) {
  const appendRe = new RegExp(`\\b${varName}\\s*\\+=\\s*["']`, 'g');
  const parts    = [];
  let m;
  while ((m = appendRe.exec(jsText)) !== null) {
    const chunk = extractQuotedString(jsText, m.index + m[0].length - 1);
    if (chunk !== null) parts.push(chunk);
  }
  if (parts.length > 0) return parts.join('');

  const assignRe = new RegExp(`\\b${varName}\\s*=\\s*["']`);
  const am = assignRe.exec(jsText);
  if (!am) return null;
  const result = extractQuotedString(jsText, am.index + am[0].length - 1);
  return (result && result.length > 0) ? result : null;
}

const parseTds   = html => [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map(m => m[1]);
const getText    = s => s.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim();
const pfHtml     = s => { const n = parseFloat(getText(s)); return isNaN(n) ? null : n; };
const getMatchId = html => { const m = html.match(/href=["'][^"']*[?&]id=([a-fA-F0-9]+)/i); return m ? m[1] : null; };

function parseLivegameTables(tm1Html, tm2Html) {
  const H_ROW = /<tr[^>]+class=['"][^'"]*tr\d+[^'"]*['"][^>]*>\s*<td[^>]*>H<\/td>([\s\S]*?)<\/tr>/gi;
  const A_ROW = /<tr[^>]+class=['"][^'"]*tr\d+[^'"]*['"][^>]*>\s*<td[^>]*>A<\/td>([\s\S]*?)<\/tr>/gi;

  const hRows1 = [...tm1Html.matchAll(H_ROW)].map(m => m[1]);
  const aRows1 = [...tm1Html.matchAll(A_ROW)].map(m => m[1]);
  const hRows2 = [...tm2Html.matchAll(H_ROW)].map(m => m[1]);
  const aRows2 = [...tm2Html.matchAll(A_ROW)].map(m => m[1]);

  const count   = Math.min(hRows1.length, aRows1.length, hRows2.length, aRows2.length);
  const matches = [];

  for (let i = 0; i < count; i++) {
    const h1 = parseTds(hRows1[i]);
    const a1 = parseTds(aRows1[i]);
    const h2 = parseTds(hRows2[i]);
    const a2 = parseTds(aRows2[i]);

    const id  = getMatchId(hRows1[i]) ?? getMatchId(aRows1[i]);
    const url = id ? `https://www.asianbetsoccer.com/it/match.html?id=${id}` : null;

    const homeName = h1[0] != null ? getText(h1[0]) : '';
    const awayName = a1[0] != null ? getText(a1[0]) : '';

    const rowText = (hRows1[i] + aRows1[i]).replace(/<[^>]+>/g, ' ');
    const scoreM  = rowText.match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/);
    const score   = scoreM ? `${scoreM[1]}-${scoreM[2]}` : null;

    const odds = {
      ah_hc: pfHtml(h2[0]),  ah_ho: pfHtml(h2[1]),
      ho_c:  pfHtml(h2[3]),  ho_o:  pfHtml(h2[4]),
      ao_c:  pfHtml(a2[3]),  ao_o:  pfHtml(a2[4]),
      tl_c:  pfHtml(h2[5]),  tl_o:  pfHtml(h2[6]),
      ov_c:  pfHtml(h2[9]),  ov_o:  pfHtml(h2[10]),
      un_c:  pfHtml(a2[7]),  un_o:  pfHtml(a2[8]),
    };

    if (!homeName && !awayName) continue;
    if (odds.ah_hc === null && odds.ho_c === null) continue;

    matches.push({ id, url, home_team: homeName, away_team: awayName, score, odds });
  }

  return matches;
}
