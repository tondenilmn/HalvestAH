'use strict';
/**
 * PROPOSAL: livescore.js with Cloudflare KV hash persistence
 * -----------------------------------------------------------
 * Problem: Cloudflare Workers are stateless. After a hash rotation every request
 * re-discovers the hash (2 extra subrequests each time) until code is redeployed.
 *
 * Solution: store the discovered hash in Cloudflare Workers KV.
 * - On each request: read hash from KV (fast, ~1ms) instead of using hardcoded value
 * - On 404: discover new hash from asianbetsoccer page, write it back to KV
 * - Next request reads the fresh hash → no 404, no extra subrequests
 *
 * Setup required in Cloudflare dashboard:
 * 1. Workers & Pages → KV → Create namespace → name it e.g. "HALVEST_HASHES"
 * 2. Pages project → Settings → Functions → KV namespace bindings:
 *      Variable name: HASHES_KV
 *      KV namespace:  HALVEST_HASHES
 *
 * KV keys used:
 *   "pinnacle_hash" → 40-char hex string
 *
 * Cost: KV reads are free up to 10M/day. Writes (on hash rotation) are rare.
 * Subrequest budget per request:
 *   - Normal:   1 (livegame fetch) + 1 (KV read) = 2
 *   - On 404:   1 (livegame 404) + 1 (page fetch) + 1 (livegame retry) + 1 (KV write) = 4
 *   Well under the 50-subrequest cap.
 */

// Fallback hardcoded hash — used only if KV is unavailable and env var not set
let PINNACLE_HASH = '641eb4d7706d368c11d7795a565a55518d2a63da';
const GS_PRIMARY    = 'Q';
const GS_CANDIDATES = ['Q', '1', '2', '3', 'AH', 'S', 'EU', 'A', 'ah', 's', '4', '5', '10', '6', '7', '8', 'B', 'F'];
const KV_PINNACLE_KEY = 'pinnacle_hash';
const KV_TTL_SECONDS  = 60 * 60 * 24; // 1 day — KV expiration safety net

/**
 * Load hash from KV. Returns null if KV binding not available or key missing.
 * @param {KVNamespace} kv
 */
async function loadHashFromKV(kv) {
  if (!kv) return null;
  try {
    return await kv.get(KV_PINNACLE_KEY);
  } catch {
    return null;
  }
}

/**
 * Persist hash to KV so the next request skips discovery.
 * @param {KVNamespace} kv
 * @param {string} hash
 */
async function saveHashToKV(kv, hash) {
  if (!kv) return;
  try {
    await kv.put(KV_PINNACLE_KEY, hash, { expirationTtl: KV_TTL_SECONDS });
  } catch (e) {
    console.error('KV write failed:', e.message);
  }
}

/**
 * Fetch the asianbetsoccer livescore page and extract Pinnacle's current book hash
 * from the #book_filter <select> options.
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

    const m1 = html.match(/value="([a-f0-9]{40})"[^>]*>\s*Pinnacle/i);
    if (m1) return m1[1];

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
  // Priority: env var > KV > hardcoded fallback
  if (context.env?.PINNACLE_HASH) {
    PINNACLE_HASH = context.env.PINNACLE_HASH;
  } else {
    const kv = context.env?.HASHES_KV ?? null;
    const kvHash = await loadHashFromKV(kv);
    if (kvHash) PINNACLE_HASH = kvHash;
  }

  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type':                 'application/json',
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: cors });
  }

  const kv     = context.env?.HASHES_KV ?? null;
  const reqUrl = new URL(context.request.url);
  const isDebug = reqUrl.searchParams.get('debug') === '1';

  if (isDebug) {
    const ts  = Date.now();
    const url = `https://botbot3.space/tables/v4/Q/livegame/${PINNACLE_HASH}.js?date=${ts}&_=${ts + 1}`;
    const r   = await fetch(url, { headers: makeBotbotHeaders('Q', PINNACLE_HASH) })
      .catch(e => ({ ok: false, status: 0, text: async () => e.message }));
    const body = await r.text();

    const oddsRows = parseGetData2Calls(body);
    let   metaRows = parseGetData1Calls(body);
    if (metaRows.length === 0) {
      const tm1Html = extractHtmlFromJs(body, 'tablematch1') ?? extractVarFromJs(body, 'match1text');
      if (tm1Html) metaRows = parseMatch1HtmlForMeta(tm1Html);
    }
    const matches = mergeMatchData(oddsRows, metaRows);

    const getData1Parsed = [];
    const re1 = /\bmatch1text\s*\+=\s*getData(?:live|last)1\s*\(/g;
    let rm1;
    while ((rm1 = re1.exec(body)) !== null) {
      getData1Parsed.push(extractCallArgs(body, rm1.index + rm1[0].length));
    }

    return new Response(
      JSON.stringify({
        status: r.status, ok: r.ok, url,
        raw_len: body.length,
        getData2_count: oddsRows.length,
        getData1_count: metaRows.length,
        match_count: matches.length,
        matches_preview: matches,
        getData1_parsed: getData1Parsed,
        pinnacle_hash: PINNACLE_HASH,
        hash_source: context.env?.PINNACLE_HASH ? 'env' : (kv ? 'kv' : 'hardcoded'),
      }),
      { headers: cors }
    );
  }

  const timestamp = Date.now();
  let lastError   = '';

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
      if (tm1Html && tm2Html) return { matches: parseLivegameTables(tm1Html, tm2Html), method: 'html' };
      lastError = `200 OK but no getData2() calls (gS=${gS}, book=${hash.slice(0, 8)}…)`;
      return null;
    }

    let metaRows = parseGetData1Calls(jsText);
    if (metaRows.length === 0) {
      const tm1Html = extractHtmlFromJs(jsText, 'tablematch1') ?? extractVarFromJs(jsText, 'match1text');
      if (tm1Html) metaRows = parseMatch1HtmlForMeta(tm1Html);
    }
    return { matches: mergeMatchData(oddsRows, metaRows), method: 'args' };
  }

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

  // ── Try stored hash (from KV, env, or hardcoded fallback) ──
  let liveResult = await tryComboData(PINNACLE_HASH, GS_PRIMARY);

  // ── On 404: auto-discover, write new hash to KV, retry ──
  if (!liveResult && lastError.includes('404')) {
    const discovered = await fetchPinnacleHash();
    if (discovered && discovered !== PINNACLE_HASH) {
      PINNACLE_HASH = discovered;
      lastError = '';
      // Persist to KV so next request uses it directly (skip 404 + re-discovery)
      await saveHashToKV(kv, discovered);
      liveResult = await tryComboData(PINNACLE_HASH, GS_PRIMARY);
    }
  }

  if (!liveResult) {
    return new Response(
      JSON.stringify({ matches: [], note: `Hash ${PINNACLE_HASH.slice(0,8)}… failed. ${lastError}` }),
      { headers: cors }
    );
  }

  const nextMatches = await tryNextComboData(PINNACLE_HASH, GS_PRIMARY) ?? [];

  return new Response(
    JSON.stringify({
      matches:      liveResult.matches,
      next_matches: nextMatches,
      gS:           GS_PRIMARY,
      book:         PINNACLE_HASH,
      method:       liveResult.method,
    }),
    { headers: cors }
  );
}

// ── All parsing functions below are identical to livescore.js ────────────────
// (copy from livescore.js — kept separate here to avoid touching production file)

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
    const pf = v => { const n = (typeof v === 'number') ? v : parseFloat(v); return isNaN(n) ? null : n; };
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
    const matchId   = (typeof args[5] === 'string' && /^[a-f0-9]{20,}$/i.test(args[5])) ? args[5] : null;
    const homeTeam  = typeof args[9]  === 'string' ? args[9]  : '';
    const awayTeam  = typeof args[22] === 'string' ? args[22] : '';
    const league    = typeof args[6]  === 'string' ? args[6]  : '';
    const rawTime   = typeof args[10] === 'string' ? args[10].replace(/\\'/g, "'") : null;
    const isHT      = rawTime === 'HT';
    const minute    = rawTime && (isHT || !rawTime.includes('T')) ? rawTime : null;
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

function parseGetDatanext1Calls(jsText) {
  const re = /\bmatch1text\s*\+=\s*getDatanext1\s*\(/g;
  const results = [];
  let m;
  while ((m = re.exec(jsText)) !== null) {
    const args      = extractCallArgs(jsText, m.index + m[0].length);
    const matchId   = (typeof args[5] === 'string' && /^[a-f0-9]{20,}$/i.test(args[5])) ? args[5] : null;
    const league    = typeof args[6]  === 'string' ? args[6]  : '';
    const homeTeam  = typeof args[7]  === 'string' ? args[7]  : '';
    const kickoffTime = typeof args[8] === 'string' ? args[8] : null;
    const awayTeam  = typeof args[15] === 'string' ? args[15] : '';
    results.push({ matchId, homeTeam, awayTeam, league, minute: null, kickoffTime, score: null });
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
    const meta = (matchId && metaByMatchId.has(matchId)) ? metaByMatchId.get(matchId) : (metaRows[i] || {});
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

function parseMatch1HtmlForMeta(tm1Html) {
  const H_ROW = /<tr[^>]+class=['"][^'"]*tr\d+[^'"]*['"][^>]*>\s*<td[^>]*>H<\/td>([\s\S]*?)<\/tr>/gi;
  const A_ROW = /<tr[^>]+class=['"][^'"]*tr\d+[^'"]*['"][^>]*>\s*<td[^>]*>A<\/td>([\s\S]*?)<\/tr>/gi;
  const hRows = [...tm1Html.matchAll(H_ROW)].map(m => m[1]);
  const aRows = [...tm1Html.matchAll(A_ROW)].map(m => m[1]);
  const count = Math.min(hRows.length, aRows.length);
  const results = [];
  for (let i = 0; i < count; i++) {
    const h1 = parseTds(hRows[i]);
    const a1 = parseTds(aRows[i]);
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
      chars.push(ch); i++;
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
      chars.push(ch); i++;
    }
  }
  return chars.join('');
}

function extractVarFromJs(jsText, varName) {
  const appendRe = new RegExp(`\\b${varName}\\s*\\+=\\s*["']`, 'g');
  const parts = [];
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
  const count  = Math.min(hRows1.length, aRows1.length, hRows2.length, aRows2.length);
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
    const rowText  = (hRows1[i] + aRows1[i]).replace(/<[^>]+>/g, ' ');
    const scoreM   = rowText.match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/);
    const score    = scoreM ? `${scoreM[1]}-${scoreM[2]}` : null;
    const odds = {
      ah_hc: pfHtml(h2[0]), ah_ho: pfHtml(h2[1]),
      ho_c:  pfHtml(h2[3]), ho_o:  pfHtml(h2[4]),
      ao_c:  pfHtml(a2[3]), ao_o:  pfHtml(a2[4]),
      tl_c:  pfHtml(h2[5]), tl_o:  pfHtml(h2[6]),
      ov_c:  pfHtml(h2[9]), ov_o:  pfHtml(h2[10]),
      un_c:  pfHtml(a2[7]), un_o:  pfHtml(a2[8]),
    };
    if (!homeName && !awayName) continue;
    if (odds.ah_hc === null && odds.ho_c === null) continue;
    matches.push({ id, url, home_team: homeName, away_team: awayName, score, odds });
  }
  return matches;
}
