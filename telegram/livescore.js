'use strict';
// ── Live match fetcher ────────────────────────────────────────────────────────
// Adapted from functions/api/livescore.js for Node.js (no Cloudflare runtime).
// Uses built-in fetch (Node >= 18).

let PINNACLE_HASH = process.env.PINNACLE_HASH || '30e528c380c96b362ffacdc66b2808c8ad59ce9e';
let BET365_HASH   = process.env.BET365_HASH   || '88cb51b3c128c9bde8e975e9dad5bc62625a8bd5';
let SBOBET_HASH   = process.env.SBOBET_HASH   || '3232dc0679a9e90f92c895b626b67d7af6c5f661';
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

// Book name patterns for #book_filter option matching (case-insensitive)
const BOOK_PATTERNS = {
  pinnacle: /pinnacle/i,
  bet365:   /bet\s*365/i,
  sbobet:   /sbo\s*bet/i,
};

/**
 * Fetch the asianbetsoccer livescore page once and extract all three book hashes
 * from the #book_filter <select> options (e.g. <option value="<40-hex>">Pinnacle</option>).
 * Returns { pinnacle, bet365, sbobet } — any value may be null if not found.
 */
async function fetchAllBookHashes() {
  try {
    const resp = await fetch('https://www.asianbetsoccer.com/it/livescore.html', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
      },
    });
    if (!resp.ok) return { pinnacle: null, bet365: null, sbobet: null };
    const html = await resp.text();

    // Extract all <option value="40hex">Label</option> entries from the page
    const result = { pinnacle: null, bet365: null, sbobet: null };
    const optRe = /value="([a-f0-9]{40})"[^>]*>\s*([^<]+)/gi;
    let m;
    while ((m = optRe.exec(html)) !== null) {
      const [, hash, label] = m;
      if (BOOK_PATTERNS.pinnacle.test(label)) result.pinnacle = hash;
      else if (BOOK_PATTERNS.bet365.test(label))   result.bet365   = hash;
      else if (BOOK_PATTERNS.sbobet.test(label))   result.sbobet   = hash;
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

/**
 * Refresh all book hashes from asianbetsoccer in one page fetch.
 * Updates the module-level variables. Logs what changed.
 * Called at startup and daily by the scheduler.
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

async function fetchLiveMatches() {
  const timestamp = Date.now();

  console.log(`Livescore: trying Pinnacle hash=${PINNACLE_HASH.slice(0,8)}…`);
  let { matches, hashInvalid } = await tryCombo(PINNACLE_HASH, GS_PRIMARY, timestamp);

  // Auto-discovery: if hash is stale (404), fetch new hash from asianbetsoccer page
  if (!matches && hashInvalid) {
    console.log('Livescore: hash invalid — auto-discovering new Pinnacle hash…');
    const discovered = await fetchPinnacleHash();
    if (discovered && discovered !== PINNACLE_HASH) {
      console.log(`Livescore: discovered new hash=${discovered.slice(0,8)}… — retrying`);
      PINNACLE_HASH = discovered;
      ({ matches, hashInvalid } = await tryCombo(PINNACLE_HASH, GS_PRIMARY, timestamp));
    } else if (!discovered) {
      console.log('Livescore: auto-discovery failed — update PINNACLE_HASH manually');
    }
  }

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

async function fetchNextMatches() {
  const timestamp = Date.now();
  console.log(`NextGame: trying hash=${PINNACLE_HASH.slice(0,8)}…`);
  let { matches, hashInvalid: pinHashInvalid } = await tryNextCombo(PINNACLE_HASH, GS_PRIMARY, timestamp);

  // Auto-discovery: if hash is stale (404), use the hash already discovered by fetchLiveMatches
  // or fetch it fresh from the page (PINNACLE_HASH may have been updated in-process already).
  if (!matches && pinHashInvalid) {
    console.log('NextGame: hash invalid — auto-discovering new Pinnacle hash…');
    const discovered = await fetchPinnacleHash();
    if (discovered && discovered !== PINNACLE_HASH) {
      console.log(`NextGame: discovered new hash=${discovered.slice(0,8)}… — retrying`);
      PINNACLE_HASH = discovered;
    }
    if (discovered) {
      ({ matches, hashInvalid: pinHashInvalid } = await tryNextCombo(PINNACLE_HASH, GS_PRIMARY, timestamp));
    } else {
      console.log('NextGame: auto-discovery failed — update PINNACLE_HASH manually');
    }
  }

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

// module.exports = { fetchLiveMatches, fetchNextMatches, fetchNextMatchesAllDays, refreshHashes };
module.exports = { fetchLiveMatches, fetchNextMatches, refreshHashes };
