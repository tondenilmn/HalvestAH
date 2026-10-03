/**
 * Cloudflare Pages Function: GET /api/upcoming[?days=0-7]
 *
 * Every upcoming fixture asianbetsoccer lists (tablenext/day0 … day7 — day0 =
 * today, dayN = today+N; day8 404s, confirmed 2026-10-03) with Bet365's and
 * Sbobet's AH / Total Line prices, current + opening, paired by match id.
 * Feeds the SCANNER tab (static/scan.js), which flags Bet365 prices above
 * Sbobet's de-vigged fair price.
 *
 * Match ids are shared between the two books' tablenext files (checked
 * 2026-10-03: every Sbobet day0/day3 id and 103/111 day7 ids matched a
 * Bet365 id, all with identical team names / kick-off) — so no fuzzy
 * team-name join is needed. Sbobet lists far fewer fixtures than Bet365
 * (≈30-60%), so many matches come back with sbobet: null.
 *
 * Cost: 2 books × (days+1) subrequests (16 for a full week) + at most a
 * couple for hash rediscovery — well under the 50-subrequest limit.
 *
 * Returns:
 *   { matches: [{ id, url, home_team, away_team, league, kickoff_time,
 *                 bet365: {ah_hc, ah_ho, ho_c, ho_o, ao_c, ao_o, tl_c, tl_o, ov_c, ov_o, un_c, un_o},
 *                 sbobet: {…same…} | null }],
 *     days, counts: { bet365: [perDay], sbobet: [perDay] }, hashes, notes: [] }
 */
import {
  GS_PRIMARY, makeBotbotHeaders, parseGetData2Calls, parseGetDatanext1Calls,
  mergeMatchData, fetchAllBookHashes, fetchHashesViaRailwayRelay, currentHashes,
} from './livescore.js';

const MAX_DAY = 7;

// Hashes discovered by an earlier request in this isolate — botbot3 rotates
// them daily, and env vars are only a manual stopgap.
let _discovered = { bet365: null, sbobet: null };

async function fetchDay(hash, day, ts) {
  const url = `https://botbot3.space/tables/v4/${GS_PRIMARY}/tablenext/day${day}/${hash}.js?date=${ts}&_=${ts + 1}`;
  try {
    const resp = await fetch(url, { headers: makeBotbotHeaders(GS_PRIMARY, hash) });
    if (!resp.ok) return { status: resp.status, matches: [] };
    const js = await resp.text();
    return { status: 200, matches: mergeMatchData(parseGetData2Calls(js), parseGetDatanext1Calls(js)) };
  } catch (e) {
    return { status: 0, error: e.message, matches: [] };
  }
}

export async function onRequest(context) {
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type':                 'application/json',
    'Cache-Control':                'no-store',
  };
  if (context.request.method === 'OPTIONS') return new Response(null, { headers: cors });

  const env = context.env || {};
  const reqUrl = new URL(context.request.url);
  const days = Math.max(0, Math.min(MAX_DAY, parseInt(reqUrl.searchParams.get('days') ?? MAX_DAY, 10) || 0));
  const defaults = currentHashes();
  const hashes = {
    bet365: _discovered.bet365 || env.BET365_HASH || defaults.bet365,
    sbobet: _discovered.sbobet || env.SBOBET_HASH || defaults.sbobet,
  };
  const notes = [];
  const ts = Date.now();

  // day0 first for both books — it validates the hashes before spending
  // subrequests on the other days.
  let [b0, s0] = await Promise.all([fetchDay(hashes.bet365, 0, ts), fetchDay(hashes.sbobet, 0, ts)]);
  if (b0.status === 404 || s0.status === 404) {
    // Direct discovery is usually WAF-blocked from Cloudflare's edge; the
    // Railway relay (telegram/notify.js GET /hashes) is the path that works.
    let found = await fetchAllBookHashes();
    if (!found.bet365 && !found.sbobet) found = await fetchHashesViaRailwayRelay(env.RAILWAY_RELAY_URL || null);
    if (b0.status === 404 && found.bet365 && found.bet365 !== hashes.bet365) {
      hashes.bet365 = _discovered.bet365 = found.bet365;
      b0 = await fetchDay(hashes.bet365, 0, ts);
      notes.push('Bet365 hash rotated — rediscovered');
    }
    if (s0.status === 404 && found.sbobet && found.sbobet !== hashes.sbobet) {
      hashes.sbobet = _discovered.sbobet = found.sbobet;
      s0 = await fetchDay(hashes.sbobet, 0, ts);
      notes.push('Sbobet hash rotated — rediscovered');
    }
  }
  if (b0.status !== 200) {
    return new Response(JSON.stringify({
      matches: [], days, hashes,
      error: `Bet365 fixture list unavailable (HTTP ${b0.status}${b0.error ? ' ' + b0.error : ''}) — the Bet365 hash is probably stale. Set BET365_HASH or RAILWAY_RELAY_URL.`,
    }), { headers: cors });
  }
  if (s0.status !== 200) notes.push(`Sbobet fixture list unavailable (HTTP ${s0.status}) — the Sbobet hash is probably stale, so nothing can be compared. Set SBOBET_HASH or RAILWAY_RELAY_URL.`);

  const rest = [];
  for (let d = 1; d <= days; d++) {
    rest.push(fetchDay(hashes.bet365, d, ts));
    rest.push(s0.status === 200 ? fetchDay(hashes.sbobet, d, ts) : Promise.resolve({ status: 0, matches: [] }));
  }
  const restRes = await Promise.all(rest);
  const bDays = [b0, ...restRes.filter((_, i) => i % 2 === 0)];
  const sDays = [s0, ...restRes.filter((_, i) => i % 2 === 1)];

  const sbo = new Map();
  for (const r of sDays) for (const m of r.matches) if (m.id && !sbo.has(m.id)) sbo.set(m.id, m.odds);
  const seen = new Set();
  const matches = [];
  for (const r of bDays) for (const m of r.matches) {
    if (!m.id || seen.has(m.id)) continue;
    seen.add(m.id);
    matches.push({
      id: m.id, url: m.url, home_team: m.home_team, away_team: m.away_team,
      league: m.league, kickoff_time: m.kickoff_time,
      bet365: m.odds, sbobet: sbo.get(m.id) || null,
    });
  }

  return new Response(JSON.stringify({
    matches, days, hashes,
    counts: { bet365: bDays.map(r => r.matches.length), sbobet: sDays.map(r => r.matches.length) },
    notes,
  }), { headers: cors });
}
