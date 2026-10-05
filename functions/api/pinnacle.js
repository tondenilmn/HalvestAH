/**
 * Cloudflare Pages Function: GET /api/pinnacle
 *
 * Every live football match Pinnacle prices, with its live 1X2, Asian
 * handicap and goal-line markets (main + alternate lines), full match and
 * 1st half — the sharp reference the MATCH and MATCHES tabs compare
 * Bet365's in-play prices against.
 *
 * Source: Pinnacle's own website API (guest.api.arcadia.pinnacle.com), the
 * same calls pinnacle.com makes for a logged-out visitor, with the public
 * guest key its site ships (override with PINNACLE_GUEST_KEY if it changes).
 * Unofficial — Pinnacle can change or close it; the official API needs an
 * account. Checked 2026-10-04: ~100 live matches across ~30 leagues incl.
 * lower ones (Tercera División, NB III, Serie C); plain server-side fetch
 * works and CORS is open.
 *
 * In-play conventions match Bet365's live lines (checked 2026-10-04: a side
 * 1-0 up early in the 2nd half at 1.25 to win was −0.25 on the handicap, and
 * the main total sat around current goals + what's left): the handicap counts
 * goals FROM NOW, the total is on the FULL-match score.
 *
 * Returns:
 *   { matches: [{ id, league, home, away, score: {home, away}, red: {home, away},
 *                 minutes, liveState,
 *                 ft: { ml: {h, d, a} | null, ah: [{line, h, a, main}], ou: [{line, o, u, main}] },
 *                 h1: { …same… } }],
 *     fetchedAt, notes }
 *   Prices are decimal; AH `line` is the HOME side's handicap (−0.25 = home gives 0.25).
 *   Also `age: { markets, matchups }` — seconds old of the copies used (see below).
 *
 * FRESHNESS (checked 2026-10-05): these endpoints sit behind a shared CDN
 * cache (`Cache-Control: max-age≈900`, `cf-cache-status: HIT`) — each URL is
 * one shared copy that is NOT refreshed when prices move: polled every 20 s
 * for 3 minutes, a copy kept identical prices and market versions while its
 * `Age` climbed 589 → 735 s, and missed a match that had kicked off after it
 * was saved. Each valid query-string variant is its own copy with its own age
 * (seen 23 s … 868 s at the same moment). The variants are requested in
 * rotation (see STAGGERING) and the youngest copy is used; `age` reports how
 * old it is.
 * Unknown parameters don't make a fresh copy (they get 204/403), so these
 * are the only addresses. Callers must treat old copies as stale — static/
 * pinnacle.js stops using Pinnacle above PINN_MAX_AGE_S.
 *   4 subrequests (2 market + 2 matchup variants; all 11 only if both fail),
 *   plus 1 to the Railway bot's warm copies when RAILWAY_RELAY_URL is set —
 *   its lists are used whenever they are younger (telegram/pinnacle_relay.js).
 */

const API = 'https://guest.api.arcadia.pinnacle.com/0.1';
const GUEST_KEY = 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';
const SOCCER = 29;

// Every address that returns the live lists (see FRESHNESS above). The
// primaryOnly=true ones lack alternate lines (`partial`), spread out so the
// previous slot's fallback is usually a full copy.
const MARKET_PATHS = [
  'markets/live/straight?primaryOnly=false&withSpecials=false',
  'markets/live/straight?withSpecials=false&primaryOnly=false',
  { path: 'markets/live/straight?primaryOnly=true', partial: true },
  'markets/live/straight?primaryOnly=false',
  'markets/live/straight',
  { path: 'markets/live/straight?primaryOnly=true&withSpecials=false', partial: true },
  'markets/live/straight?withSpecials=false',
  { path: 'markets/live/straight?withSpecials=false&primaryOnly=true', partial: true },
];
const MATCHUP_PATHS = ['matchups/live?withSpecials=false', 'matchups/live', 'matchups/live?withSpecials=true'];

// STAGGERING (2026-10-05). Fetching every variant on every request made the
// first request after a quiet spell refill all expired copies at once; they
// then aged together and were all > 2 min old for ~13 of every 15 minutes.
// Instead each variant owns a time slot and is only requested in its own
// slot (and as the fallback in the next one): a copy is refilled the first
// time it is requested after it expired, so the current slot's copy is
// normally seconds old. One full cycle (variants × slot) must exceed the
// cache lifetime (~905 s) plus one poll interval (60 s), or a variant would
// be revisited while its old copy is still served: 8 × 125 s = 1000 s for
// markets, 3 × 330 s = 990 s for matchups (≤ ~6 min old — only the match
// list and scores, which the app checks against the live feed anyway).
const MARKET_SLOT_S = 125;
const MATCHUP_SLOT_S = 330;

// The Railway bot's warm copies (GET <RAILWAY_RELAY_URL>/pinnacle), or null.
async function fetchRelay(base) {
  if (!base) return null;
  try {
    const r = await fetch(`${base.replace(/\/$/, '')}/pinnacle`, { signal: AbortSignal.timeout(5000) });
    if (!r.ok) return null;
    const d = await r.json();
    return d.ok && Array.isArray(d.markets) && Array.isArray(d.matchups) && Number.isFinite(d.age?.markets) ? d : null;
  } catch (_) { return null; }
}

async function fetchVariant(v, headers) {
  const { path, partial } = typeof v === 'string' ? { path: v, partial: false } : v;
  try {
    const r = await fetch(`${API}/sports/${SOCCER}/${path}`, { headers });
    if (r.status !== 200) return { path, ok: false, status: r.status };
    const data = await r.json();
    if (!Array.isArray(data)) return { path, ok: false, status: r.status };
    return { path, partial, ok: true, status: 200, data, age: parseInt(r.headers.get('age') || '0', 10) || 0 };
  } catch (e) { return { path, ok: false, status: 0, error: e.message }; }
}

// This slot's variant + the previous slot's (refilled ≤ 2 slots ago, so
// requesting it is a cache hit and doesn't disturb the rotation). Only if
// both fail is every variant tried.
async function staggered(paths, slotS, headers, now = Date.now()) {
  const n = paths.length;
  const k = Math.floor(now / 1000 / slotS) % n;
  let res = await Promise.all([paths[k], paths[(k + n - 1) % n]].map(v => fetchVariant(v, headers)));
  if (!res.some(r => r.ok)) res = await Promise.all(paths.map(v => fetchVariant(v, headers)));
  const good = res.filter(r => r.ok);
  if (!good.length) return { ok: false, status: res.map(r => r.status).join(','), copies: [] };
  const score = r => r.age + (r.partial ? 30 : 0);
  good.sort((a, b) => score(a) - score(b));
  return { ...good[0], copies: good, slot: k };
}

const dec = p => (typeof p === 'number' && p !== 0) ? +(p > 0 ? 1 + p / 100 : 1 + 100 / -p).toFixed(3) : null;

export async function onRequest(context) {
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type':                 'application/json',
    'Cache-Control':                'no-store',
  };
  if (context.request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });

  const headers = {
    'X-API-Key': context.env?.PINNACLE_GUEST_KEY || GUEST_KEY,
    Accept: 'application/json',
    Referer: 'https://www.pinnacle.com/',
    Origin: 'https://www.pinnacle.com',
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  };
  let matchups, markets, age;
  try {
    const [mk, mu, relay] = await Promise.all([
      staggered(MARKET_PATHS, MARKET_SLOT_S, headers),
      staggered(MATCHUP_PATHS, MATCHUP_SLOT_S, headers),
      fetchRelay(context.env?.RAILWAY_RELAY_URL),
    ]);
    // The Railway bot keeps its own copies warm around the clock
    // (telegram/pinnacle_relay.js) — use its lists when they are younger.
    const useRelay = relay && (!mk.ok || relay.age.markets < mk.age);
    if (!useRelay && (!mk.ok || !mu.ok)) return json({ matches: [], error: `Pinnacle answered HTTP ${mu.status}/${mk.status} — blocked from this network, or the guest key changed (set PINNACLE_GUEST_KEY).` });
    markets = useRelay ? relay.markets : mk.data;
    // Match list: the younger copy first, plus any match only an older one has.
    const lists = [...(mu.ok ? mu.copies.map(c => ({ age: c.age, data: c.data })) : []), ...(relay ? [{ age: relay.age.matchups ?? 9999, data: relay.matchups }] : [])]
      .sort((x, y) => x.age - y.age);
    const seen = new Set();
    matchups = [];
    for (const c of lists) for (const g of c.data) if (!seen.has(g.id)) { seen.add(g.id); matchups.push(g); }
    age = useRelay
      ? { markets: relay.age.markets, matchups: lists[0]?.age ?? null, source: 'relay', own: mk.ok ? mk.age : null }
      : { markets: mk.age, matchups: lists[0]?.age ?? null, source: 'direct', relay: relay ? relay.age.markets : null, marketsPath: mk.path, copies: mk.copies.map(c => c.age), slot: mk.slot };
  } catch (e) {
    return json({ matches: [], error: `Pinnacle unreachable: ${e.message}` });
  }

  // Open markets by matchup id → period → type.
  const byMatchup = new Map();
  for (const m of Array.isArray(markets) ? markets : []) {
    if (m.status !== 'open' || ![0, 1].includes(m.period) || !['moneyline', 'spread', 'total'].includes(m.type)) continue;
    if (!byMatchup.has(m.matchupId)) byMatchup.set(m.matchupId, []);
    byMatchup.get(m.matchupId).push(m);
  }
  const sheet = (list, period) => {
    const out = { ml: null, ah: [], ou: [] };
    for (const m of list.filter(x => x.period === period)) {
      const p = d => m.prices.find(x => x.designation === d);
      if (m.type === 'moneyline') {
        const h = dec(p('home')?.price), d = dec(p('draw')?.price), a = dec(p('away')?.price);
        if (h && a) out.ml = { h, d, a };
      } else if (m.type === 'spread') {
        const h = p('home'), a = p('away');
        if (h && a && typeof h.points === 'number') out.ah.push({ line: h.points, h: dec(h.price), a: dec(a.price), main: !m.isAlternate });
      } else if (m.type === 'total') {
        const o = p('over'), u = p('under');
        if (o && u && typeof o.points === 'number') out.ou.push({ line: o.points, o: dec(o.price), u: dec(u.price), main: !m.isAlternate });
      }
    }
    out.ah.sort((x, y) => x.line - y.line);
    out.ou.sort((x, y) => x.line - y.line);
    return out;
  };

  // The live list carries some matches twice (different live modes, different
  // ids) — keep, per pair of teams, the entry with the most open markets.
  const best = new Map();
  for (const g of Array.isArray(matchups) ? matchups : []) {
    if (g.units !== 'Regular' || g.participants?.length !== 2) continue;
    const list = byMatchup.get(g.id) || [];
    if (!list.length) continue;
    const [h, a] = ['home', 'away'].map(s => g.participants.find(p => p.alignment === s));
    if (!h || !a) continue;
    const key = `${h.name}|${a.name}`;
    if (best.has(key) && best.get(key).n >= list.length) continue;
    best.set(key, {
      n: list.length,
      m: {
        id: g.id, league: g.league?.name || '', home: h.name, away: a.name,
        score: { home: h.state?.score ?? null, away: a.state?.score ?? null },
        red: { home: h.state?.redCards ?? 0, away: a.state?.redCards ?? 0 },
        minutes: g.state?.minutes ?? null, liveState: g.state?.state ?? null,
        ft: sheet(list, 0), h1: sheet(list, 1),
      },
    });
  }
  return json({ matches: [...best.values()].map(v => v.m), fetchedAt: new Date().toISOString(), age, notes: [] });
}
