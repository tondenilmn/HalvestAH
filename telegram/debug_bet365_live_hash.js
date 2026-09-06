'use strict';
// Test the "Bet365 Live" book_filter option (hash 56f7105d...) against the
// botbot3.space livegame endpoint, the same way fetchLiveMatches() tests the
// plain "Bet365" hash — see what it returns, and whether its odds move
// between two polls a few minutes apart. Run manually.
//
// FINDINGS SO FAR (2026-09-06 investigation — see debug_live_qualify.js and
// debug_live_price_freshness.js in this same dir for the earlier steps):
// 1. Live Games' "nothing clears baseline" behavior is expected given the
//    current design (cross-fit-halved CI-lower gate vs. an already-informative
//    baseline) — confirmed against 25 real live matches: only 3/25 had any
//    qualifying bet, 0/25 had even a sub-bar positive-edge candidate.
// 2. match.bet365_odds (ah_hc/ho_c/ao_c/tl_c/ov_c/un_c — what Live Games/
//    NEWMODEL use) is confirmed FROZEN at the pre-kickoff closing value:
//    polled 33 live matches twice, 6 min apart — 0/33 had ANY field change,
//    across matches at every stage (10' through HT to 70'+). This matches
//    what the existing code comments already claimed (buildRawCfgFromLiveOdds
//    header in static/app.js; NEWMODEL's comment in notify.js).
// 3. asianbetsoccer.com's #book_filter dropdown has a genuinely separate
//    "Bet365 Live" option (hash 56f7105ddda384f0955acb8ffe874c8b61daec49),
//    distinct from plain "Bet365" (hash 5c0bdaf910e73c60cfc76e264a50c146bc4f7386,
//    what we currently use). BUT: hitting /livegame/<Bet365-Live-hash>.js —
//    the same endpoint fetchLiveMatches() already calls — returns ZERO
//    getData2 (price) rows, only getDatalive1/getDatalast1 (score/minute/
//    team, no prices). This matches the pre-existing warning already in
//    livescore.js's BOOK_PATTERNS comment from an earlier investigation.
//
// NEXT STEP (not yet done): if asianbetsoccer.com's live match PAGE really
// does show updating Bet365 prices when "Bet365 Live" is selected, that data
// must come from a different endpoint/table than /livegame/ — most likely
// something the site's JS only calls on an individual match page, not the
// bulk livescore table. Need to inspect real network traffic (e.g. via
// browser devtools while watching a live match with "Bet365 Live" selected)
// to find the actual URL pattern, since guessing endpoint names blind hasn't
// turned it up. Nothing production-facing has been changed yet — BET365_HASH
// still points at the plain "Bet365" hash throughout the codebase.

const GS_PRIMARY = 'Q';
const BET365_LIVE_HASH = '56f7105ddda384f0955acb8ffe874c8b61daec49'; // "Bet365 Live" from book_filter
const BET365_HASH       = '5c0bdaf910e73c60cfc76e264a50c146bc4f7386'; // plain "Bet365", for comparison

function makeBotbotHeaders(gS, book) {
  return {
    Origin: 'https://www.asianbetsoccer.com',
    Referer: 'https://www.asianbetsoccer.com/it/livescore.html',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: '*/*',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
    'Cache-Control': 'no-cache',
    Pragma: 'no-cache',
    Cookie: `_cookie_Stats=${gS}; _cookie_Book=${book}; _cookie_LAN=it; _cookie_GMT=1`,
  };
}

function extractCallArgs(text, start) {
  let i = start, depth = 0, buf = '', inStr = false, strChar = '';
  const args = [];
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      buf += c;
      if (c === '\\') { buf += text[++i]; continue; }
      if (c === strChar) inStr = false;
      continue;
    }
    if (c === '"' || c === "'") { inStr = true; strChar = c; buf += c; continue; }
    if (c === '(') { depth++; if (depth === 1) continue; buf += c; continue; }
    if (c === ')') { if (depth === 1) { if (buf.trim()) args.push(parseArg(buf)); return args; } depth--; buf += c; continue; }
    if (c === ',' && depth === 1) { args.push(parseArg(buf)); buf = ''; continue; }
    buf += c;
  }
  return args;
}
function parseArg(raw) {
  const s = raw.trim();
  if ((s.startsWith("'") && s.endsWith("'")) || (s.startsWith('"') && s.endsWith('"'))) {
    return s.slice(1, -1).replace(/\\'/g, "'").replace(/\\"/g, '"');
  }
  const n = Number(s);
  return isNaN(n) ? s : n;
}

function countCalls(jsText, fnName) {
  const re = new RegExp(`\\b\\w*text\\s*\\+=\\s*${fnName}\\s*\\(`, 'g');
  let count = 0;
  while (re.exec(jsText) !== null) count++;
  return count;
}

async function fetchLivegame(hash, label) {
  const timestamp = Date.now();
  const url = `https://botbot3.space/tables/v4/${GS_PRIMARY}/livegame/${hash}.js?date=${timestamp}&_=${timestamp + 1}`;
  try {
    const resp = await fetch(url, { headers: makeBotbotHeaders(GS_PRIMARY, hash) });
    console.log(`[${label}] ${url.slice(0, 80)}… -> HTTP ${resp.status}`);
    if (!resp.ok) return null;
    const text = await resp.text();
    console.log(`[${label}] response length: ${text.length}`);
    const data2Count = countCalls(text, 'getData2');
    const live1Count = countCalls(text, 'getDatalive1');
    const last1Count = countCalls(text, 'getDatalast1');
    console.log(`[${label}] getData2 calls: ${data2Count}  getDatalive1: ${live1Count}  getDatalast1: ${last1Count}`);
    return text;
  } catch (e) {
    console.log(`[${label}] fetch threw: ${e.message}`);
    return null;
  }
}

function parseGetData2Sample(jsText, n = 5) {
  const re = /\bmatch2text\s*\+=\s*getData2\s*\(/g;
  const rows = [];
  let m;
  while ((m = re.exec(jsText)) !== null && rows.length < n) {
    const args = extractCallArgs(jsText, m.index + m[0].length);
    if (args.length < 31) continue;
    rows.push({
      matchId: args[4], ah_hc: args[5], ah_ho: args[6],
      ho_c: args[11], ho_o: args[12], ao_c: args[16], ao_o: args[17],
      tl_c: args[21], tl_o: args[22], ov_c: args[24], ov_o: args[25],
      un_c: args[29], un_o: args[30],
    });
  }
  return rows;
}

async function main() {
  console.log('=== Poll #1 ===');
  const live1 = await fetchLivegame(BET365_LIVE_HASH, 'Bet365 Live');
  const plain1 = await fetchLivegame(BET365_HASH, 'Bet365 plain');

  if (live1) {
    const sample = parseGetData2Sample(live1, 8);
    console.log(`\n[Bet365 Live] sample getData2 rows (${sample.length}):`);
    for (const r of sample) console.log(' ', JSON.stringify(r));
  }
  if (plain1) {
    const sample = parseGetData2Sample(plain1, 8);
    console.log(`\n[Bet365 plain] sample getData2 rows (${sample.length}):`);
    for (const r of sample) console.log(' ', JSON.stringify(r));
  }

  console.log('\nWaiting 3 minutes before poll #2…');
  await new Promise(r => setTimeout(r, 3 * 60 * 1000));

  console.log('\n=== Poll #2 ===');
  const live2 = await fetchLivegame(BET365_LIVE_HASH, 'Bet365 Live');
  if (live2) {
    const sample2 = parseGetData2Sample(live2, 8);
    console.log(`\n[Bet365 Live] sample getData2 rows (${sample2.length}) — poll 2:`);
    for (const r of sample2) console.log(' ', JSON.stringify(r));

    if (live1) {
      const sample1 = parseGetData2Sample(live1, 8);
      console.log('\n--- Diff (matched by matchId) ---');
      const map1 = new Map(sample1.map(r => [r.matchId, r]));
      for (const r2 of sample2) {
        const r1 = map1.get(r2.matchId);
        if (!r1) { console.log(`  matchId ${r2.matchId}: not in poll #1`); continue; }
        const diffs = Object.keys(r2).filter(k => k !== 'matchId' && r1[k] !== r2[k]);
        console.log(`  matchId ${r2.matchId}: ${diffs.length ? 'CHANGED -> ' + diffs.map(k => `${k}:${r1[k]}->${r2[k]}`).join(', ') : 'no change'}`);
      }
    }
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
