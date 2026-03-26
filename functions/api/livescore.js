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

let PINNACLE_HASH = '555a04df41c008dbb9fae7894ff184cfe09692ec';
// gS candidates — 'Q' is the confirmed primary value; rest are fallbacks.
// Auto-discovery (fetchPinnacleHash) is tried before the sweep when the primary hash fails.
// Worst-case subrequest budget: 1 (fast path) + 1 (page fetch) + 1 (Q+discovered) + 18 (sweep) = 21, well under 50.
const GS_PRIMARY    = 'Q';
const GS_CANDIDATES = ['Q', '1', '2', '3', 'AH', 'S', 'EU', 'A', 'ah', 's', '4', '5', '10', '6', '7', '8', 'B', 'F'];

/**
 * Fetch the asianbetsoccer livescore page and extract Pinnacle's current book hash
 * from the #book_filter <select> options (e.g. <option value="<40-hex>">Pinnacle</option>).
 * Falls back to scanning for botbot3.space URLs embedded in any inline scripts.
 * Returns the hash string, or null if not found.
 */
async function fetchPinnacleHash() {
  try {
    const resp = await fetch('https://www.asianbetsoccer.com/it/livescore.html', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    // Primary: #book_filter option with 40-char hex value near "Pinnacle" label
    const m1 = html.match(/value="([a-f0-9]{40})"[^>]*>\s*Pinnacle/i);
    if (m1) return m1[1];

    // Fallback: any botbot3.space livegame URL embedded in the page
    const m2 = html.match(/botbot3\.space\/tables\/v4\/[^/]+\/livegame\/([a-f0-9]{40})\.js/);
    if (m2) return m2[1];

    return null;
  } catch {
    return null;
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

  // ?debug=1 — inspect the raw JS and show extraction results
  if (isDebug) {
    const ts  = Date.now();
    const url = `https://botbot3.space/tables/v4/Q/livegame/${PINNACLE_HASH}.js?date=${ts}&_=${ts + 1}`;
    const r   = await fetch(url, { headers: makeBotbotHeaders('Q', PINNACLE_HASH) })
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
      }),
      { headers: cors }
    );
  }

  const timestamp = Date.now();
  let lastError   = '';

  /**
   * Try a single (hash, gS) combination.
   * Returns a Response if successful, null otherwise.
   * Updates lastError on failure.
   */
  async function tryCombo(hash, gS) {
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
        const matches = parseLivegameTables(tm1Html, tm2Html);
        if (matches.length > 0) {
          return new Response(JSON.stringify({ matches, gS, book: hash, method: 'html' }), { headers: cors });
        }
        return new Response(
          JSON.stringify({ matches: [], note: `No live matches right now (gS=${gS}, book=${hash})` }),
          { headers: cors }
        );
      }
      lastError = `200 OK but no getData2() calls or HTML tables (gS=${gS}, book=${hash.slice(0, 8)}…)`;
      return null;
    }

    let metaRows = parseGetData1Calls(jsText);
    if (metaRows.length === 0) {
      const tm1Html = extractHtmlFromJs(jsText, 'tablematch1') ?? extractVarFromJs(jsText, 'match1text');
      if (tm1Html) metaRows = parseMatch1HtmlForMeta(tm1Html);
    }

    const matches = mergeMatchData(oddsRows, metaRows);
    if (matches.length > 0) {
      return new Response(JSON.stringify({ matches, gS, book: hash, method: 'args' }), { headers: cors });
    }
    return new Response(
      JSON.stringify({ matches: [], note: `No live matches right now (gS=${gS}, book=${hash})` }),
      { headers: cors }
    );
  }

  // ── Step 1: fast path — confirmed combo (1 subrequest) ──────────────────
  const fast = await tryCombo(PINNACLE_HASH, GS_PRIMARY);
  if (fast) return fast;

  // ── Step 2: auto-discover hash from asianbetsoccer livescore page ────────
  // Only runs when the hardcoded hash returns 404, costing 1 extra subrequest.
  const discovered = await fetchPinnacleHash();
  if (discovered && discovered !== PINNACLE_HASH) {
    PINNACLE_HASH = discovered; // update for the sweep below
    const found = await tryCombo(discovered, GS_PRIMARY);
    if (found) return found;
  }

  // ── Step 3: sweep all gS candidates with both hashes ────────────────────
  const hashesToTry = [...new Set([PINNACLE_HASH, ...(discovered ? [discovered] : [])])];
  for (const hash of hashesToTry) {
    for (const gS of GS_CANDIDATES) {
      if (gS === GS_PRIMARY && hash === PINNACLE_HASH) continue; // already tried in step 1
      const result = await tryCombo(hash, gS);
      if (result) return result;
    }
  }

  return new Response(
    JSON.stringify({
      matches: [],
      note: `Could not reach livegame data. ${lastError}. Add ?debug=1 to /api/livescore to diagnose.`,
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
function parseGetData2Calls(jsText) {
  const re = /\bmatch2text\s*\+=\s*getData2\s*\(/g;
  const results = [];
  let m;

  while ((m = re.exec(jsText)) !== null) {
    const args = extractCallArgs(jsText, m.index + m[0].length);
    if (args.length < 31) continue;

    const pf = v => {
      const n = (typeof v === 'number') ? v : parseFloat(v);
      return isNaN(n) ? null : n;
    };

    // args[4] = matchId (40-char hex)
    const matchId = (typeof args[4] === 'string' && args[4].length >= 20) ? args[4] : null;

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
    const rawTime  = typeof args[10] === 'string' ? args[10].replace(/\\'/g, "'") : null;
    const isHT     = rawTime === 'HT';
    const minute   = rawTime && (isHT || !rawTime.includes('T')) ? rawTime : null;

    // Score: args[11] = home goals, args[23] = away goals (confirmed by cross-referencing
    // multiple live matches with known scores — corner kicks are at [24]/[25]).
    // Only set score for live/HT matches (minute present); upcoming matches have 0s here too.
    let score = null;
    if (minute && args.length > 23) {
      const hg = typeof args[11] === 'number' ? args[11] : parseInt(args[11], 10);
      const ag = typeof args[23] === 'number' ? args[23] : parseInt(args[23], 10);
      if (!isNaN(hg) && !isNaN(ag) && hg >= 0 && ag >= 0) score = `${hg}-${ag}`;
    }

    results.push({ matchId, homeTeam, awayTeam, league, minute, score });
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
      home_team: meta.homeTeam || '',
      away_team: meta.awayTeam || '',
      league:    meta.league   || '',
      minute:    meta.minute   || null,
      score:     meta.score    || null,
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
