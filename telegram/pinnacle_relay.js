'use strict';
/**
 * Pinnacle live relay — keeps Pinnacle's cached live lists warm around the
 * clock from this server, so the web app gets fresh prices the moment the
 * MATCHES tab is opened instead of after a ~15-minute warm-up.
 *
 * Why: Pinnacle's guest API sits behind a CDN cache that keeps each URL's
 * copy ~905 s and only refills it on the first request after it expires
 * (see functions/api/pinnacle.js's FRESHNESS / STAGGERING notes). Each CDN
 * data centre keeps its own copies, and almost nobody else requests these
 * URLs near the app's users, so the copies there are cold whenever the tab
 * opens. This process requests the same variants in the same rotation every
 * minute, 24/7, through the data centre near Railway, and serves the latest
 * copies at GET /pinnacle on the relay server (notify.js).
 *
 * Keep MARKET_PATHS / MATCHUP_PATHS / the slot lengths in sync with
 * functions/api/pinnacle.js.
 *
 * Pinnacle refuses origin refills from some countries (from the US:
 * "403 Access from United States is prohibited", reason "location"). If it
 * refuses this server, the relay reports the error and the web app simply
 * keeps fetching Pinnacle itself, as before.
 */

const API = 'https://guest.api.arcadia.pinnacle.com/0.1/sports/29/';
const GUEST_KEY = process.env.PINNACLE_GUEST_KEY || 'CmX2KcMrXuFmNg6YFbmTxE0y9CIrOi0R';
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
const MARKET_SLOT_S = 125;
const MATCHUP_SLOT_S = 330;
const HEADERS = {
  'X-API-Key': GUEST_KEY,
  Accept: 'application/json',
  Referer: 'https://www.pinnacle.com/',
  Origin: 'https://www.pinnacle.com',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
};

async function fetchVariant(v) {
  const { path, partial } = typeof v === 'string' ? { path: v, partial: false } : v;
  try {
    const r = await fetch(API + path, { headers: HEADERS, signal: AbortSignal.timeout(15000) });
    const text = await r.text();
    if (r.status !== 200) {
      let reason = '';
      try { const j = JSON.parse(text); reason = j.reason || j.detail || ''; } catch (_) {}
      return { path, ok: false, status: r.status, reason };
    }
    const data = JSON.parse(text);
    if (!Array.isArray(data)) return { path, ok: false, status: r.status };
    return { path, partial, ok: true, data, age: parseInt(r.headers.get('age') || '0', 10) || 0, at: Date.now() };
  } catch (e) { return { path, ok: false, status: 0, reason: e.message }; }
}

// This slot's variant + the previous slot's (see functions/api/pinnacle.js).
async function staggered(paths, slotS, now = Date.now()) {
  const n = paths.length;
  const k = Math.floor(now / 1000 / slotS) % n;
  const res = await Promise.all([paths[k], paths[(k + n - 1) % n]].map(fetchVariant));
  const good = res.filter(r => r.ok).sort((a, b) => (a.age + (a.partial ? 30 : 0)) - (b.age + (b.partial ? 30 : 0)));
  return { good, failed: res.filter(r => !r.ok) };
}

// Latest copies kept: the youngest market list, and the two latest match lists.
const state = { markets: null, matchups: [], lastError: null, lastOkAt: 0, polls: 0 };
const ageNow = c => (c ? c.age + (Date.now() - c.at) / 1000 : null);

async function pollPinnacle() {
  state.polls++;
  const [mk, mu] = await Promise.all([staggered(MARKET_PATHS, MARKET_SLOT_S), staggered(MATCHUP_PATHS, MATCHUP_SLOT_S)]);
  if (mk.good.length && (!state.markets || ageNow(mk.good[0]) <= ageNow(state.markets))) state.markets = mk.good[0];
  if (mu.good.length) {
    state.matchups = [...mu.good, ...state.matchups].sort((a, b) => ageNow(a) - ageNow(b)).slice(0, 2);
  }
  const fail = [...mk.failed, ...mu.failed][0];
  if (mk.good.length) { state.lastOkAt = Date.now(); state.lastError = null; }
  else if (fail) state.lastError = `HTTP ${fail.status}${fail.reason ? ` (${fail.reason})` : ''}`;
  // A line every 10 polls (and the first one), so the log shows whether it works.
  if (state.polls === 1 || state.polls % 10 === 0) {
    console.log(state.markets
      ? `Pinnacle relay: prices ${Math.round(ageNow(state.markets))} s old (${state.markets.data.length} markets)${state.lastError ? ` · last poll failed: ${state.lastError}` : ''}`
      : `Pinnacle relay: no prices yet — ${state.lastError || 'no answer'}${/location/i.test(state.lastError || '') ? ' — Pinnacle refuses this server\'s country; the web app keeps fetching Pinnacle itself' : ''}`);
  }
}

// What GET /pinnacle serves: the raw lists + how old they are now.
function relayPayload() {
  const seen = new Set(), matchups = [];
  for (const c of state.matchups) for (const g of c.data) if (!seen.has(g.id)) { seen.add(g.id); matchups.push(g); }
  return {
    ok: !!state.markets && matchups.length > 0,
    markets: state.markets ? state.markets.data : [],
    matchups,
    age: { markets: state.markets ? Math.round(ageNow(state.markets)) : null, matchups: state.matchups[0] ? Math.round(ageNow(state.matchups[0])) : null },
    error: state.lastError,
    servedAt: new Date().toISOString(),
  };
}

// ── Pre-match lists (added 2026-10-09, for Strategy PINNGAP) ───────────────────
// Same CDN caching (~905 s per URL variant, checked 2026-10-09), so the same
// staggered rotation, polled every 2 min. With compression the lists are small
// (markets with alternate lines ~1.2 MB, main lines only ~245 KB, match list
// ~257 KB). Market variants: 3 with alternate lines + 1 main-lines-only (a
// fallback, only used when > 30 s younger). 4 × 260 s = 1040 s > 905 s + one
// 120-s poll, so each variant refills at the start of its slot. The match list
// only carries names and kick-off times, so one fetch every 10 min is enough.
const PRE_MARKET_PATHS = [
  'markets/straight?primaryOnly=false&withSpecials=false',
  'markets/straight?withSpecials=false&primaryOnly=false',
  'markets/straight?withSpecials=false',
  { path: 'markets/straight?primaryOnly=true&withSpecials=false', partial: true },
];
const PRE_MATCHUP_PATHS = ['matchups?withSpecials=false', 'matchups?withSpecials=false&brandId=0'];
const PRE_MARKET_SLOT_S = 260;
const PRE_MATCHUP_EVERY_MS = 10 * 60000;
const pre = { markets: null, matchups: null, lastError: null, polls: 0 };

async function pollPinnaclePrematch() {
  pre.polls++;
  const mk = await staggered(PRE_MARKET_PATHS, PRE_MARKET_SLOT_S);
  if (mk.good.length && (!pre.markets || ageNow(mk.good[0]) <= ageNow(pre.markets))) pre.markets = mk.good[0];
  if (!pre.matchups || Date.now() - pre.matchups.at >= PRE_MATCHUP_EVERY_MS) {
    const v = await fetchVariant(PRE_MATCHUP_PATHS[pre.polls % PRE_MATCHUP_PATHS.length]);
    if (v.ok) pre.matchups = v; else pre.lastError = `matchups HTTP ${v.status}${v.reason ? ` (${v.reason})` : ''}`;
  }
  if (!mk.good.length && mk.failed[0]) pre.lastError = `markets HTTP ${mk.failed[0].status}${mk.failed[0].reason ? ` (${mk.failed[0].reason})` : ''}`;
  else if (mk.good.length) pre.lastError = null;
  if (pre.polls === 1 || pre.polls % 15 === 0) {
    console.log(pre.markets
      ? `Pinnacle pre-match: ${pre.markets.data.length} markets, ${Math.round(ageNow(pre.markets))} s old · ${pre.matchups ? pre.matchups.data.length : 0} matchups${pre.lastError ? ` · last poll failed: ${pre.lastError}` : ''}`
      : `Pinnacle pre-match: no prices yet — ${pre.lastError || 'no answer'}`);
  }
}
const prematchPayload = () => ({
  ok: !!pre.markets && !!pre.matchups,
  markets: pre.markets ? pre.markets.data : [], matchups: pre.matchups ? pre.matchups.data : [],
  age: pre.markets ? Math.round(ageNow(pre.markets)) : null, partial: !!pre.markets?.partial,
});

module.exports = { pollPinnacle, relayPayload, pollPinnaclePrematch, prematchPayload, _state: state, _pre: pre };
