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
let BET365_HASH   = 'a684e2d1d433e85c7070cb057ab6e3135d8ed162'; // overridden at runtime from context.env
let SBOBET_HASH   = '3232dc0679a9e90f92c895b626b67d7af6c5f661'; // overridden at runtime from context.env
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
// whose hash serves a different feed (0 odds rows on the livegame endpoint);
// a loose /bet\s*365/i match would collide with it and silently overwrite
// the correct hash with a broken one since a naive loop takes the last match.
const BOOK_PATTERNS = {
  pinnacle: /^pinnacle$/i,
  bet365:   /^bet\s*365$/i,
  sbobet:   /^sbo\s*bet$/i,
};

/**
 * Fetch the asianbetsoccer livescore page once and extract all three book
 * hashes from the #book_filter <select> options. Returns
 * { pinnacle, bet365, sbobet } — any value may be null if not found/delisted.
 */
async function fetchAllBookHashes() {
  try {
    let resp;
    for (const headers of LIVESCORE_HEADER_SETS) {
      resp = await fetch('https://www.asianbetsoccer.com/it/livescore.html', { headers });
      if (resp.ok) break;
    }
    if (!resp.ok) return { pinnacle: null, bet365: null, sbobet: null };
    const html = await resp.text();

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
  } catch {
    return { pinnacle: null, bet365: null, sbobet: null };
  }
}

async function fetchPinnacleHash() { return (await fetchAllBookHashes()).pinnacle; }
async function fetchBet365Hash()   { return (await fetchAllBookHashes()).bet365; }

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
  if (context.env?.PINNACLE_HASH) PINNACLE_HASH = context.env.PINNACLE_HASH;
  if (context.env?.BET365_HASH)   BET365_HASH   = context.env.BET365_HASH;
  if (context.env?.SBOBET_HASH)   SBOBET_HASH   = context.env.SBOBET_HASH;

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
      JSON.stringify({ pinnacle_hash: PINNACLE_HASH, bet365_hash: BET365_HASH, sbobet_hash: SBOBET_HASH }),
      { headers: cors }
    );
  }

  // ?debug=1 — inspect the raw JS and show extraction results (Bet365 hash,
  // since that's the primary source now — see constant comments above)
  if (isDebug) {
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
    const discovered = await fetchBet365Hash();
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
      }),
      { headers: cors }
    );
  }

  // ── Fetch tablenext + secondary (reference) book odds in parallel ───────
  // Pinnacle/Sbobet are best-effort only now — fetchLiveOddsMap silently
  // returns an empty map on any failure, so a delisted/stale Pinnacle hash
  // just means no reference odds for that book, not a broken response.
  const [nextMatches, pinnacleMap, sboMap] = await Promise.all([
    tryNextComboData(BET365_HASH, GS_PRIMARY).then(r => r ?? []),
    fetchLiveOddsMap(PINNACLE_HASH, timestamp),
    fetchLiveOddsMap(SBOBET_HASH, timestamp),
  ]);

  // Attach reference odds to each Bet365 match by shared matchId
  for (const m of liveResult.matches) {
    if (!m.id) continue;
    if (pinnacleMap.has(m.id)) m.pinnacle_odds = pinnacleMap.get(m.id);
    if (sboMap.has(m.id))      m.sbobet_odds   = sboMap.get(m.id);
    // Alias for consumers that expect this field name (e.g. telegram/
    // notify.js's L123 reads match.bet365_odds from its own livescore.js —
    // unrelated to this function, but kept consistent).
    m.bet365_odds = m.odds;
  }

  return new Response(
    JSON.stringify({
      matches:      liveResult.matches,
      next_matches: nextMatches,
      gS:           GS_PRIMARY,
      book:         BET365_HASH,
      pinnacle_book: PINNACLE_HASH,
      sbobet_book:  SBOBET_HASH,
      method:       liveResult.method,
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
 * Parse all `match2text += getData2(...)` calls.
 * Returns array of { matchId, odds }.
 */
/**
 * Parse "ah_hc,ah_ho_tl_c,tl_o|..." encoded string from getData1/getData2none args[3].
 * Confirmed format across all observed matches:
 *   "ah_hc,ah_ho_tl_c,tl_o|<direction codes>"
 */
function parseEncodedOdds(encoded) {
  if (!encoded || typeof encoded !== 'string') return {};
  const core  = encoded.split('|')[0];
  const parts = core.split('_');
  if (parts.length < 2) return {};
  const ah = parts[0].split(',').map(parseFloat);
  const tl = parts[1].split(',').map(parseFloat);
  return {
    ah_hc: isNaN(ah[0]) ? null : ah[0],
    ah_ho: isNaN(ah[1]) ? null : ah[1],
    tl_c:  isNaN(tl[0]) ? null : tl[0],
    tl_o:  isNaN(tl[1]) ? null : tl[1],
  };
}

function parseGetData2Calls(jsText) {
  // Match getData2 and any variant (getData2none, getData2live, etc.)
  const re = /\bmatch2text\s*\+=\s*getData2\w*\s*\(/g;
  const results = [];
  let m;

  while ((m = re.exec(jsText)) !== null) {
    const args = extractCallArgs(jsText, m.index + m[0].length);

    const pf = v => {
      const n = (typeof v === 'number') ? v : parseFloat(v);
      return isNaN(n) ? null : n;
    };

    // Detect format:
    // Normal (getData2):     [..., encodedStr, matchId, ah_hc, ah_ho, ...]   matchId at [4]
    // Variant (getData2none): [..., encodedStr, 'R', matchId, 'U', ah_hc, ah_ho, ...]  matchId at [5]
    //
    // For the variant, args after ah_ho use an interleaved string-code format that differs
    // from getData2 — we cannot apply a simple offset. Instead we extract ah_hc/ah_ho from
    // args[7]/[8] and tl_c/tl_o from the encoded string in args[3].
    if (typeof args[4] === 'string' && args[4].length >= 20) {
      // ── Normal getData2 ──────────────────────────────────────────────────
      if (args.length < 31) continue;
      const matchId = args[4];
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
    } else if (typeof args[5] === 'string' && args[5].length >= 20) {
      // ── Variant getData2none: 'R' at [4], matchId at [5], 'U' at [6] ───
      // ah_hc=[7], ah_ho=[8] confirmed. Remaining odds use interleaved codes —
      // parse tl_c/tl_o from the encoded string in args[3] instead.
      if (args.length < 9) continue;
      const matchId = args[5];
      const enc     = parseEncodedOdds(args[3]);
      results.push({
        matchId,
        odds: {
          ah_hc: pf(args[7]) ?? enc.ah_hc,
          ah_ho: pf(args[8]) ?? enc.ah_ho,
          ho_c:  null,
          ho_o:  null,
          ao_c:  null,
          ao_o:  null,
          tl_c:  enc.tl_c,
          tl_o:  enc.tl_o,
          ov_c:  null,
          ov_o:  null,
          un_c:  null,
          un_o:  null,
        },
      });
    }
    // else: can't locate matchId — skip
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

    results.push({ matchId, homeTeam, awayTeam, league, minute, kickoffTime, score });
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

    results.push({ matchId, homeTeam, awayTeam, score });
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
