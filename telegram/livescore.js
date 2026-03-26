'use strict';
// ── Live match fetcher ────────────────────────────────────────────────────────
// Adapted from functions/api/livescore.js for Node.js (no Cloudflare runtime).
// Uses built-in fetch (Node >= 18).

let PINNACLE_HASH = '555a04df41c008dbb9fae7894ff184cfe09692ec';
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

async function fetchPinnacleHash() {
  try {
    const resp = await fetch('https://www.asianbetsoccer.com/it/livescore.html', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
    if (!resp.ok) {
      console.log(`  hashDiscovery: asianbetsoccer HTTP ${resp.status}`);
      return null;
    }
    const html = await resp.text();
    console.log(`  hashDiscovery: got HTML (${html.length} bytes)`);
    const m1 = html.match(/value="([a-f0-9]{40})"[^>]*>\s*Pinnacle/i);
    if (m1) return m1[1];
    const m2 = html.match(/botbot3\.space\/tables\/v4\/[^/]+\/livegame\/([a-f0-9]{40})\.js/);
    if (m2) return m2[1];
    console.log(`  hashDiscovery: HTML received but no hash pattern matched`);
    // Log a snippet to help debug the page structure
    const snippet = html.slice(0, 500).replace(/\s+/g, ' ');
    console.log(`  hashDiscovery: HTML snippet: ${snippet}`);
    return null;
  } catch (e) {
    console.log(`  hashDiscovery: fetch error — ${e.message}`);
    return null;
  }
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
    const rawTime  = typeof args[10] === 'string' ? args[10].replace(/\\'/g, "'") : null;
    const isHT     = rawTime === 'HT';
    const minute   = rawTime && (isHT || !rawTime.includes('T')) ? rawTime : null;
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

async function tryCombo(hash, gS, timestamp) {
  const url = `https://botbot3.space/tables/v4/${gS}/livegame/${hash}.js?date=${timestamp}&_=${timestamp + 1}`;
  let jsText;
  try {
    const resp = await fetch(url, { headers: makeBotbotHeaders(gS, hash) });
    if (!resp.ok) {
      console.log(`  botbot3 ${gS}/${hash.slice(0,8)}… → HTTP ${resp.status}`);
      return null;
    }
    jsText = await resp.text();
  } catch (e) {
    console.log(`  botbot3 ${gS}/${hash.slice(0,8)}… → fetch error: ${e.message}`);
    return null;
  }

  const oddsRows = parseGetData2Calls(jsText);
  if (oddsRows.length === 0) {
    console.log(`  botbot3 ${gS}/${hash.slice(0,8)}… → OK but 0 getData2 calls (${jsText.length} bytes)`);
    return null;
  }

  const metaRows = parseGetData1Calls(jsText);
  const matches  = mergeMatchData(oddsRows, metaRows);
  console.log(`  botbot3 ${gS}/${hash.slice(0,8)}… → OK  odds:${oddsRows.length}  meta:${metaRows.length}  merged:${matches.length}`);
  return matches;
}

async function fetchLiveMatches() {
  const timestamp = Date.now();

  // Step 1: fast path
  console.log(`Livescore: trying fast path (hash=${PINNACLE_HASH.slice(0,8)}…)`);
  let matches = await tryCombo(PINNACLE_HASH, GS_PRIMARY, timestamp);
  if (matches) return matches;

  // Step 2: auto-discover hash
  console.log('Livescore: fast path failed — fetching hash from asianbetsoccer…');
  const discovered = await fetchPinnacleHash();
  if (discovered) {
    console.log(`Livescore: discovered hash=${discovered.slice(0,8)}… (${discovered === PINNACLE_HASH ? 'same' : 'NEW'})`);
    PINNACLE_HASH = discovered;
    matches = await tryCombo(discovered, GS_PRIMARY, timestamp);
    if (matches) return matches;
  } else {
    console.log('Livescore: hash discovery failed (asianbetsoccer unreachable or structure changed)');
  }

  // Step 3: sweep
  console.log('Livescore: sweeping all gS candidates…');
  const hashesToTry = [...new Set([PINNACLE_HASH, ...(discovered ? [discovered] : [])])];
  for (const hash of hashesToTry) {
    for (const gS of GS_CANDIDATES) {
      if (gS === GS_PRIMARY && hash === PINNACLE_HASH) continue;
      matches = await tryCombo(hash, gS, timestamp);
      if (matches) return matches;
    }
  }

  console.log('Livescore: all attempts failed — returning empty');
  return [];
}

module.exports = { fetchLiveMatches };
