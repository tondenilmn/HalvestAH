/**
 * Cloudflare Pages Function: GET /api/livematch?id=<40-hex match id>
 *
 * One in-play match for the MATCH tab's live refresh: minute, score, HT
 * score (from the plain Bet365 livegame feed) and Bet365's CURRENT in-play
 * prices (from the separate "Bet365 Live" feed — see livescore.js's
 * BET365_LIVE_HASH / parseGetData2NoneCalls). The match page itself
 * (/api/scrape) only carries pre-match prices.
 *
 * In-play quoting (checked on the live feed 2026-10-03): the goal line is on
 * the full-match total, the Asian handicap on goals from now.
 *
 * Returns:
 *   { found, id, minute: "67'"|"45'+"|"HT"|null, score: {home, away}|null,
 *     htScore: {home, away}|null,
 *     live_odds: { ah_hc, ah_ac, ho_c, ao_c, tl_c, ov_c, un_c, x2_h, x2_x, x2_a } | null,
 *     notes: [] }
 * 2 subrequests normally, a few more when a hash has rotated.
 */
import {
  GS_PRIMARY, makeBotbotHeaders, parseGetData1Calls, parseGetData2NoneCalls,
  fetchAllBookHashes, fetchHashesViaRailwayRelay, currentHashes,
} from './livescore.js';

let _discovered = { bet365: null, bet365live: null };

async function fetchLivegame(hash, ts) {
  const url = `https://botbot3.space/tables/v4/${GS_PRIMARY}/livegame/${hash}.js?date=${ts}&_=${ts + 1}`;
  try {
    const resp = await fetch(url, { headers: makeBotbotHeaders(GS_PRIMARY, hash) });
    return { status: resp.status, text: resp.ok ? await resp.text() : '' };
  } catch (e) {
    return { status: 0, text: '', error: e.message };
  }
}

const parseScore = s => {
  const m = typeof s === 'string' && s.match(/^(\d+)-(\d+)$/);
  return m ? { home: +m[1], away: +m[2] } : null;
};

export async function onRequest(context) {
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type':                 'application/json',
    'Cache-Control':                'no-store',
  };
  if (context.request.method === 'OPTIONS') return new Response(null, { headers: cors });

  const env = context.env || {};
  const id = (new URL(context.request.url).searchParams.get('id') || '').toLowerCase();
  if (!/^[a-f0-9]{20,}$/.test(id)) {
    return new Response(JSON.stringify({ found: false, error: 'Missing or invalid ?id=' }), { status: 400, headers: cors });
  }
  const defaults = currentHashes();
  const hashes = {
    bet365:     _discovered.bet365     || env.BET365_HASH      || defaults.bet365,
    bet365live: _discovered.bet365live || env.BET365_LIVE_HASH || defaults.bet365live,
  };
  const notes = [];
  const ts = Date.now();

  const read = (b, l) => ({
    meta: b.status === 200 ? parseGetData1Calls(b.text).find(m => m.matchId === id) : null,
    liveRows: l.status === 200 ? parseGetData2NoneCalls(l.text) : [],
  });
  let [b, l] = await Promise.all([fetchLivegame(hashes.bet365, ts), fetchLivegame(hashes.bet365live, ts)]);
  let r = read(b, l);

  // A rotated hash either 404s or keeps answering 200 with an empty table
  // for a while (see telegram/livescore.js's stale-hash heuristic) — treat
  // "no live rows at all" the same as a 404.
  const b365Stale = b.status === 404;
  const liveStale = l.status === 404 || (l.status === 200 && r.liveRows.length === 0);
  if (b365Stale || liveStale) {
    let found = await fetchAllBookHashes();
    if (!found.bet365 && !found.bet365live) found = await fetchHashesViaRailwayRelay(env.RAILWAY_RELAY_URL || null);
    if (b365Stale && found.bet365 && found.bet365 !== hashes.bet365) {
      hashes.bet365 = _discovered.bet365 = found.bet365;
      b = await fetchLivegame(hashes.bet365, ts);
    }
    if (liveStale && found.bet365live && found.bet365live !== hashes.bet365live) {
      hashes.bet365live = _discovered.bet365live = found.bet365live;
      l = await fetchLivegame(hashes.bet365live, ts);
    }
    r = read(b, l);
  }
  if (b.status !== 200) notes.push(`Bet365 live feed unavailable (HTTP ${b.status}) — minute/score come from the match page only.`);
  if (!r.liveRows.length) notes.push('Bet365 in-play prices unavailable (Bet365 Live hash stale?) — set BET365_LIVE_HASH or RAILWAY_RELAY_URL.');

  const liveRow = r.liveRows.find(x => x.matchId === id);
  // 0 = not offered right now (suspended market).
  const odds = liveRow ? Object.fromEntries(Object.entries(liveRow.live_odds).map(([k, v]) => [k, (k.startsWith('ah_') || k === 'tl_c') ? v : (v > 1 ? v : null)])) : null;
  const m = r.meta;
  return new Response(JSON.stringify({
    found: !!(m || liveRow), id,
    minute: m?.minute || null,
    score: parseScore(m?.score),
    htScore: parseScore(m?.htScore),
    live_odds: odds,
    notes,
  }), { headers: cors });
}
