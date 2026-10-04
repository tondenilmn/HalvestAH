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
  parseGetData2Calls, parseGetDatanext1Calls, mergeMatchData,
  resolveHashes, healHashes, fetchBotbotFile, botbotUrl,
} from './livescore.js';

const MAX_DAY = 7;

// One tablenext/dayN file. A rotated hash 404s or (for hours first) answers
// 200 with no rows — `empty` flags the latter after fetchBotbotFile's retry.
async function fetchDay(hash, day, ts) {
  const r = await fetchBotbotFile(botbotUrl(`tablenext/day${day}`, hash, ts), hash);
  if (r.status !== 200) return { status: r.status, error: r.error, matches: [] };
  const matches = mergeMatchData(parseGetData2Calls(r.text), parseGetDatanext1Calls(r.text));
  return { status: 200, matches, empty: matches.length === 0 };
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
  const { hashes } = await resolveHashes(env); // KV (pasted in the app) > env > constant
  const notes = [];
  const ts = Date.now();

  // day0 first for both books — it validates the hashes before spending
  // subrequests on the other days. Every league worldwide has fixtures today,
  // so an empty day0 means a stale hash just as surely as a 404.
  let [b0, s0] = await Promise.all([fetchDay(hashes.bet365, 0, ts), fetchDay(hashes.sbobet, 0, ts)]);
  const bad = r => r.status === 404 || r.empty;
  const failing = {};
  if (bad(b0)) failing.bet365 = hashes.bet365;
  if (bad(s0)) failing.sbobet = hashes.sbobet;
  if (Object.keys(failing).length) {
    const healed = await healHashes(env, failing, async (_, h) => {
      const r = await fetchDay(h, 0, ts);
      return r.status === 200 && !r.empty ? r : null;
    });
    if (healed.bet365) { hashes.bet365 = healed.bet365.hash; b0 = healed.bet365.result; notes.push('Bet365 hash rotated — rediscovered and saved'); }
    if (healed.sbobet) { hashes.sbobet = healed.sbobet.hash; s0 = healed.sbobet.result; notes.push('Sbobet hash rotated — rediscovered and saved'); }
  }
  if (b0.status !== 200 || b0.empty) {
    return new Response(JSON.stringify({
      matches: [], days, hashes,
      error: `Bet365 fixture list unavailable (${b0.empty ? 'empty' : 'HTTP ' + b0.status}${b0.error ? ' ' + b0.error : ''}) — either botbot3 is in one of its short blackouts (retry in a minute) or the Bet365 hash is stale: the MATCHES tab's Feeds card checks and fixes it.`,
    }), { headers: cors });
  }
  if (s0.status !== 200 || s0.empty) notes.push(`Sbobet fixture list unavailable (${s0.empty ? 'empty' : 'HTTP ' + s0.status}) — the Sbobet hash is probably stale, so nothing can be compared. Paste a fresh one in the MATCHES tab's Feeds card.`);

  const rest = [];
  for (let d = 1; d <= days; d++) {
    rest.push(fetchDay(hashes.bet365, d, ts));
    rest.push(s0.status === 200 && !s0.empty ? fetchDay(hashes.sbobet, d, ts) : Promise.resolve({ status: 0, matches: [] }));
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
