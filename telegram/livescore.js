'use strict';
// ── Live match fetcher ────────────────────────────────────────────────────────
// Adapted from functions/api/livescore.js for Node.js (no Cloudflare runtime).
// Uses built-in fetch (Node >= 18).

let PINNACLE_HASH = process.env.PINNACLE_HASH || 'ef0e4d72dbf5e72ec109077d824e881b0ac06110';
let BET365_HASH   = process.env.BET365_HASH   || 'e2e5205f68530c12b66f8e9045fe2fbcc68f5905';
let SBOBET_HASH   = process.env.SBOBET_HASH   || '99a40a72b62e4a8fb8a6019d1176a882e7ddea30';
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

async function tryNextCombo(hash, gS, timestamp) {
  const url = `https://botbot3.space/tables/v4/${gS}/tablenext/day0/${hash}.js?date=${timestamp}&_=${timestamp + 1}`;
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

// Fetch live odds for any bookmaker by hash → Map<matchId, odds>.
// hashInvalid = true only on HTTP 404 (stale hash).
async function fetchLiveOddsMap(hash, bookLabel, timestamp) {
  if (!hash) return { map: new Map(), hashInvalid: false };
  const url = `https://botbot3.space/tables/v4/${GS_PRIMARY}/livegame/${hash}.js?date=${timestamp}&_=${timestamp + 1}`;
  try {
    const resp = await fetch(url, { headers: makeBotbotHeaders(GS_PRIMARY, hash) });
    if (!resp.ok) {
      console.log(`  ${bookLabel}/${hash.slice(0, 8)}… livegame → HTTP ${resp.status}`);
      return { map: new Map(), hashInvalid: resp.status === 404 };
    }
    const jsText   = await resp.text();
    const oddsRows = parseGetData2Calls(jsText);
    console.log(`  ${bookLabel}/${hash.slice(0, 8)}… livegame → ${oddsRows.length} rows`);
    const map = new Map();
    for (const row of oddsRows) {
      if (row.matchId) map.set(row.matchId, row.odds);
    }
    return { map, hashInvalid: false };
  } catch (e) {
    console.log(`  ${bookLabel} livegame fetch error: ${e.message}`);
    return { map: new Map(), hashInvalid: false };
  }
}

async function fetchLiveMatches() {
  const timestamp = Date.now();

  console.log(`Livescore: trying Pinnacle hash=${PINNACLE_HASH.slice(0,8)}…`);
  const { matches, hashInvalid } = await tryCombo(PINNACLE_HASH, GS_PRIMARY, timestamp);
  if (!matches) {
    if (hashInvalid) console.log('Livescore: Pinnacle hash invalid (404) — update PINNACLE_HASH in livescore.js');
    else             console.log('Livescore: hash failed — update PINNACLE_HASH in livescore.js');
    return { matches: [], pinnacleHashFailed: hashInvalid, pinnacleHash: PINNACLE_HASH };
  }

  // Fetch Bet365 and Sbobet live odds in parallel (non-fatal — Pinnacle is the primary source)
  const [b365Result, sboResult] = await Promise.all([
    fetchLiveOddsMap(BET365_HASH, 'bet365', timestamp),
    fetchLiveOddsMap(SBOBET_HASH, 'sbobet', timestamp),
  ]);

  // Attach multi-book odds to each Pinnacle match by shared matchId
  let b365Attached = 0, sboAttached = 0;
  for (const m of matches) {
    if (!m.id) continue;
    if (b365Result.map.has(m.id)) { m.bet365_odds = b365Result.map.get(m.id); b365Attached++; }
    if (sboResult.map.has(m.id))  { m.sbobet_odds  = sboResult.map.get(m.id);  sboAttached++; }
  }
  if (BET365_HASH) console.log(`  bet365 live: attached to ${b365Attached}/${matches.length} matches`);
  if (SBOBET_HASH) console.log(`  sbobet live: attached to ${sboAttached}/${matches.length} matches`);

  return {
    matches,
    pinnacleHashFailed: false,
    pinnacleHash:       PINNACLE_HASH,
    bet365HashFailed:   b365Result.hashInvalid,
    bet365Hash:         BET365_HASH,
    sbobetHashFailed:   sboResult.hashInvalid,
    sbobetHash:         SBOBET_HASH,
  };
}

// Fetch Bet365 AH odds from a tablenext JS file and return { map, hashFailed }.
// hashFailed = true only on HTTP 404 (stale hash), not on other errors.
async function fetchBet365OddsMap(timestamp) {
  if (!BET365_HASH) return { map: new Map(), hashFailed: false };
  const url = `https://botbot3.space/tables/v4/${GS_PRIMARY}/tablenext/day0/${BET365_HASH}.js?date=${timestamp}&_=${timestamp + 1}`;
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

async function fetchNextMatches() {
  const timestamp = Date.now();
  console.log(`NextGame: trying hash=${PINNACLE_HASH.slice(0,8)}…`);
  const { matches, hashInvalid: pinHashInvalid } = await tryNextCombo(PINNACLE_HASH, GS_PRIMARY, timestamp);

  if (!matches) {
    if (pinHashInvalid) console.log('NextGame: Pinnacle hash invalid (404) — update PINNACLE_HASH in livescore.js');
    else console.log('NextGame: hash failed — update PINNACLE_HASH in livescore.js');
    return { matches: [], pinnacleHashFailed: pinHashInvalid, pinnacleHash: PINNACLE_HASH, bet365HashFailed: false, bet365Hash: BET365_HASH };
  }

  // Attach Bet365 AH odds to each match (non-fatal if unavailable)
  const { map: b365Map, hashFailed: b365HashFailed } = await fetchBet365OddsMap(timestamp);
  if (b365Map.size > 0) {
    let attached = 0;
    for (const m of matches) {
      if (m.id && b365Map.has(m.id)) {
        m.bet365_odds = b365Map.get(m.id);
        attached++;
      }
    }
    console.log(`  bet365: attached to ${attached}/${matches.length} next matches`);
  }

  return { matches, pinnacleHashFailed: false, pinnacleHash: PINNACLE_HASH, bet365HashFailed: b365HashFailed, bet365Hash: BET365_HASH };
}

module.exports = { fetchLiveMatches, fetchNextMatches };
