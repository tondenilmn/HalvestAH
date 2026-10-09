'use strict';
/**
 * Betfair Exchange 1X2 prices from oddsmonitor.eu (added 2026-10-09).
 *
 * oddsmonitor.eu shows Betfair's Match Odds market for ~500 matches a day and
 * serves it from two public JSON endpoints its own page uses (no login):
 *   /wp-json/oddsmonitor/v1/events        — every listed match: Betfair best back
 *        price home/draw/away, matched + available money, minute, score, status
 *        (refreshed about once a minute)
 *   /wp-json/oddsmonitor/v1/chart/<slug>  — one match's history, one point a
 *        minute from ~2 days before kick-off: odds h/d/a, backing/laying money per
 *        side, back-vs-lay delta, and markers (kick-off, goals, cards, half-time).
 * Unofficial — another site's internal data, can change or disappear; read it
 * politely (one list request a minute, as its page does).
 *
 * Uses here:
 *  1. staleVsBetfair(): Bet365 Live sometimes keeps serving a match's pre-goal
 *     prices for minutes after a goal (MC Alger 1-0 at 78'-83': Bet365 "to win"
 *     2.25, Betfair 1.06). If Bet365's live 1X2 is far from Betfair's at the same
 *     score, the whole Bet365 row is stale — no LIVEMODEL/LIVEGAP alert.
 *  2. History: each finished match's chart is saved (compact, gzipped) to
 *     data/oddsmonitor/YYYY-MM-DD/<slug>.json.gz — the exchange price history the
 *     dataset lacks (price moves around goals, pre-match money, closing price).
 * Caveats seen 2026-10-09: event markers run 1-2 min behind the price jump; a
 * snapshot taken during a market suspension can be an outlier (Braga 1.29 for one
 * minute between 3.55 and 1.69). Back prices only — no lay price, no AH/goal lines.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const LG = require('./livegap');
const { kindOf } = require('./pinngap');

const BASE = 'https://oddsmonitor.eu/wp-json/oddsmonitor/v1';
const HEADERS = { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' };

const _st = { events: [], fetchedAt: 0, generatedAt: null, error: null, fails: 0, seen: new Map(), saved: new Set(), stats: { saved: 0, failed: 0 } };

async function getJson(url) {
  const r = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(30000) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

// Live list (every minute). Keeps the previous list on failure.
async function pollEvents(now = Date.now()) {
  try {
    const d = await getJson(`${BASE}/events`);
    if (!Array.isArray(d.events)) throw new Error('no events array');
    _st.events = d.events; _st.fetchedAt = now; _st.generatedAt = d.summary?.generated_at || null; _st.error = null; _st.fails = 0;
    for (const e of d.events) {
      const s = _st.seen.get(e.event_slug) || { slug: e.event_slug, firstSeen: now };
      Object.assign(s, { lastSeen: now, status: e.status_label, live: !!e.inplay, matched: +e.total_matched || 0, ko: Date.parse(e.open_date_raw || '') || null, name: e.event_name });
      _st.seen.set(e.event_slug, s);
    }
  } catch (e) {
    _st.error = e.message; _st.fails++;
    if (_st.fails % 10 === 1) console.error(`oddsmonitor: events fetch failed (${e.message})`);
  }
  return _st;
}

const ageS = (now = Date.now()) => (_st.fetchedAt ? (now - _st.fetchedAt) / 1000 : null);

// The listed match for a Bet365 live match: same score, team names (Dice ≥ 0.4
// each, ≥ 0.7 mean) and kind of side (women / youth / reserves).
function findEvent(events, home, away, score, league = '') {
  let best = null;
  for (const e of events || []) {
    if (!e.inplay) continue;
    const [h, a] = String(e.event_name || '').split(/\s+v\s+/);
    if (!h || !a) continue;
    if (score && e.score_text && e.score_text !== `${score.home}-${score.away}`) continue;
    if (kindOf(h, e.competition_name) !== kindOf(home, league) || kindOf(a, e.competition_name) !== kindOf(away, league)) continue;
    const sh = LG.dice(h, home), sa = LG.dice(a, away);
    if (Math.min(sh, sa) < 0.4) continue;
    const s = (sh + sa) / 2;
    if (!best || s > best.s) best = { e, s };
  }
  return best && best.s >= 0.7 ? best.e : null;
}

// Bet365 live 1X2 vs Betfair back prices at the same moment. A true price
// difference between the two is a few percent; a ratio past `maxRatio` on a
// side Betfair prices ≤ `maxPrice` means one of them hasn't caught up with the
// match — and Bet365 Live is the one that lags (2026-10-09). Returns a reason
// string or null. Needs a fresh list and real money on the Betfair market.
function staleVsBetfair(odds, ev, o = {}) {
  const maxRatio = o.maxRatio ?? 1.35, maxPrice = o.maxPrice ?? 10, minMatched = o.minMatched ?? 500;
  if (!odds || !ev || !(+ev.total_matched >= minMatched)) return null;
  const pairs = [['home', odds.x2_h, ev.home_odd], ['draw', odds.x2_x, ev.draw_odd], ['away', odds.x2_a, ev.away_odd]];
  let worst = null;
  for (const [side, b, f] of pairs) {
    if (!(b > 1) || !(f > 1) || f > maxPrice) continue;
    const r = b / f;
    if (r >= maxRatio || r <= 1 / maxRatio) if (!worst || Math.abs(Math.log(r)) > Math.abs(Math.log(worst.r))) worst = { side, b, f, r };
  }
  return worst ? `Bet365 ${worst.side} ${worst.b} vs Betfair ${worst.f} — Bet365 Live price behind the match` : null;
}

// ── History of finished matches ──
// Compact form: t = seconds since the first point; odds h/d/a; back/lay money per side; markers.
function compactChart(c) {
  const L = c.odds?.raw_labels || [];
  if (!L.length) return null;
  const t0 = Date.parse(L[0].replace(' ', 'T') + 'Z');
  const t = L.map(s => Math.round((Date.parse(s.replace(' ', 'T') + 'Z') - t0) / 1000));
  const pick = (grp, keys) => Object.fromEntries(keys.map(k => [k, (grp?.series?.[k] || []).map(v => (v == null ? null : +v))]));
  return {
    v: 1, slug: c.slug, name: c.meta?.event_name, comp: c.meta?.competition_name, status: c.meta?.event_status, score: c.meta?.score_text,
    matched: c.meta?.total_matched, t0: L[0], t,
    odds: pick(c.odds, ['home', 'draw', 'away']),
    money: pick(c.money, ['backing_home', 'backing_draw', 'backing_away', 'laying_home', 'laying_draw', 'laying_away']),
    markers: (c.markers || []).map(m => ({ i: m.index, type: m.type, team: m.team, min: m.minute, at: m.update_time })),
  };
}

// Saves the history of matches that finished (status "Finished", or gone from
// the list after being live), at most `max` per call, once each. Returns the
// number saved. Only markets with ≥ minMatched money (small ones are noise).
async function saveFinished(dir, now = Date.now(), o = {}) {
  const max = o.max ?? 4, minMatched = o.minMatched ?? 1000, fetcher = o.fetcher || getJson;
  let n = 0;
  for (const s of _st.seen.values()) {
    if (n >= max) break;
    if (s.live) s.wasLive = true;
    if (_st.saved.has(s.slug) || s.matched < minMatched || (s.tries || 0) >= 3) continue;
    const finished = /finish|ended|closed/i.test(s.status || '') || (s.wasLive && now - s.lastSeen > 10 * 60000) || (s.ko && now - s.ko > 3 * 3600000);
    if (!finished || (s.nextTry && now < s.nextTry)) continue;
    s.tries = (s.tries || 0) + 1; s.nextTry = now + 10 * 60000;
    try {
      const c = await fetcher(`${BASE}/chart/${encodeURIComponent(s.slug)}`);
      if (!c || !c.found) throw new Error('not found');
      const rec = compactChart({ ...c, slug: s.slug });
      if (!rec) throw new Error('empty history');
      const day = (s.ko ? new Date(s.ko) : new Date(now)).toISOString().slice(0, 10);
      fs.mkdirSync(path.join(dir, day), { recursive: true });
      fs.writeFileSync(path.join(dir, day, `${s.slug.replace(/[^a-z0-9-]/gi, '_')}.json.gz`), zlib.gzipSync(JSON.stringify(rec)));
      _st.saved.add(s.slug); _st.stats.saved++; n++;
    } catch (e) {
      if (s.tries >= 3) _st.stats.failed++;
    }
  }
  // Forget matches long gone from the list.
  for (const [k, s] of _st.seen) if (now - s.lastSeen > 24 * 3600000) { _st.seen.delete(k); _st.saved.delete(k); }
  return n;
}

// On start-up: matches already saved (so a restart doesn't refetch them).
function loadSaved(dir) {
  try {
    for (const day of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, day))) _st.saved.add(f.replace(/\.json\.gz$/, ''));
  } catch { /* no history yet */ }
}

const readHistory = file => JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString('utf8'));

function statusLine(dir, now = Date.now()) {
  let files = 0, bytes = 0;
  try { for (const day of fs.readdirSync(dir)) for (const f of fs.readdirSync(path.join(dir, day))) { files++; bytes += fs.statSync(path.join(dir, day, f)).size; } } catch { /* none */ }
  const a = ageS(now);
  return `oddsmonitor: ${_st.events.length} matches listed (${_st.events.filter(e => e.inplay).length} live)${a != null ? `, list ${Math.round(a)} s old` : ''}${_st.error ? `, last error: ${_st.error}` : ''} · ${files} match histories saved (${(bytes / 1e6).toFixed(1)} MB)`;
}

module.exports = { pollEvents, findEvent, staleVsBetfair, compactChart, saveFinished, loadSaved, readHistory, statusLine, ageS, _st };
