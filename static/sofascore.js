/* ══════════════════════════════════════════════════════════════════════
   sofascore.js — Bet365 in-play prices from Sofascore, fetched by the
   viewer's own browser. Fallback for the MATCH tab when asianbetsoccer's
   "Bet365 Live" feed has nothing for the match (stale hash, blackout, or
   the match simply isn't on it).

   Why in the browser: api.sofascore.com answers any origin
   (Access-Control-Allow-Origin: *) but refuses server-side fetches
   (403 to Node/Workers fetch, checked 2026-10-04) — a real browser on the
   viewer's connection is what it expects.

   What it is (checked 2026-10-04): Sofascore's odds provider 1 is bet365
   for both pre-match and live (odds/providers/IT and /GB → oddsFrom and
   liveOddsFrom = bet365). Live markets include "Asian handicap" (same line
   and prices as asianbetsoccer's Bet365 Live: goals from now), "Match goals"
   (Bet365's .5-line goals market on the FULL-match total — not the Asian
   goal line asianbetsoccer shows), and "Full time" 1X2.

   Output has the same shape as /api/livematch's live_odds, so the MATCH
   tab's buildLiveValueRows uses it unchanged:
     { ah_hc, ho_c, ao_c, tl_c, ov_c, un_c, x2_h, x2_x, x2_a }
   ══════════════════════════════════════════════════════════════════════ */

const Sofa = (() => {
  const API = 'https://api.sofascore.com/api/v1';
  const LIVE_TTL_MS = 50000;
  let liveCache = { at: 0, events: null, pending: null };

  // Team-name similarity: accents, punctuation and common club tokens removed,
  // then a bigram Dice coefficient (handles "Celta vigo b" vs "Celta Vigo B",
  // "Sporting Gijon" vs "Sporting Gijón").
  const STOP = /\b(fc|cf|cd|sc|ud|ac|afc|club|de|del|la|the|fk|sk|nk|if|bk|sv|calcio|w|women|femenil)\b/g;
  const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/\(w\)/g, ' w ').replace(STOP, ' ').replace(/[^a-z0-9]/g, '');
  const grams = s => { const g = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); g.set(k, (g.get(k) || 0) + 1); } return g; };
  function dice(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const ga = grams(a), gb = grams(b);
    let hit = 0;
    for (const [k, n] of ga) hit += Math.min(n, gb.get(k) || 0);
    return (2 * hit) / (a.length - 1 + b.length - 1);
  }
  const isWomen = s => /\(w\)|\bwomen\b|\bfemenil\b|\bw$/i.test(String(s || ''));

  async function getJson(path) {
    const resp = await fetch(API + path, { headers: { Accept: 'application/json' } });
    if (!resp.ok) throw new Error(`Sofascore HTTP ${resp.status}`);
    return resp.json();
  }

  async function liveEvents() {
    if (liveCache.events && Date.now() - liveCache.at < LIVE_TTL_MS) return liveCache.events;
    if (liveCache.pending) return liveCache.pending;
    liveCache.pending = getJson('/sport/football/events/live')
      .then(d => { liveCache = { at: Date.now(), events: d.events || [], pending: null }; return liveCache.events; })
      .catch(e => { liveCache.pending = null; throw e; });
    return liveCache.pending;
  }

  // Best in-play Sofascore event for these teams. Both names must be close,
  // the women's/men's flag must agree, and the current score (when known)
  // breaks ties and rejects a weak name match.
  async function findLiveEvent(home, away, score) {
    const events = await liveEvents();
    let best = null;
    for (const e of events) {
      if (e.status?.type !== 'inprogress') continue;
      const h = e.homeTeam?.name, a = e.awayTeam?.name;
      if (isWomen(h) !== isWomen(home)) continue;
      const sh = dice(h, home), sa = dice(a, away);
      if (Math.min(sh, sa) < 0.4) continue;
      let s = (sh + sa) / 2;
      const sameScore = score && e.homeScore?.current === score.home && e.awayScore?.current === score.away;
      if (score) s += sameScore ? 0.15 : -0.25;
      if (!best || s > best.s) best = { e, s };
    }
    return best && best.s >= 0.7 ? best.e : null;
  }

  const frac = f => {
    const m = String(f || '').match(/^(\d+)\/(\d+)$/);
    return m ? 1 + (+m[1]) / (+m[2]) : null;
  };
  // "-0.5" | "+0.75" | "0, -0.5" (split line) → number
  const lineOf = g => {
    const parts = String(g || '').split(',').map(x => parseFloat(x)).filter(Number.isFinite);
    return parts.length ? parts.reduce((a, b) => a + b, 0) / parts.length : null;
  };

  // Bet365 live prices for one event → live_odds shape, or null if none are open.
  async function liveOdds(eventId) {
    const d = await getJson(`/event/${eventId}/odds/1/all`);
    const live = (d.markets || []).filter(m => m.isLive && !m.suspended);
    const out = {};
    const x = live.find(m => m.marketName === 'Full time' && m.choices?.length === 3);
    if (x) {
      const by = n => frac(x.choices.find(c => c.name === n)?.fractionalValue);
      out.x2_h = by('1'); out.x2_x = by('X'); out.x2_a = by('2');
    }
    const ah = live.find(m => m.marketName === 'Asian handicap' && m.choices?.length === 2);
    if (ah) {
      // choices[0] is the home side, named like "(+0.5) Kosovo"; the group
      // label is the other side's line, so it's the fallback with its sign flipped.
      const nm = String(ah.choices[0].name).match(/^\(([+-]?[\d.]+(?:\s*,\s*[+-]?[\d.]+)?)\)/);
      const hl = nm ? lineOf(nm[1]) : (lineOf(ah.choiceGroup) != null ? -lineOf(ah.choiceGroup) : null);
      if (hl != null) { out.ah_hc = hl; out.ho_c = frac(ah.choices[0].fractionalValue); out.ao_c = frac(ah.choices[1].fractionalValue); }
    }
    const ou = live.find(m => m.marketName === 'Match goals' && m.choices?.length === 2);
    if (ou) {
      const tl = lineOf(ou.choiceGroup);
      if (tl != null) {
        out.tl_c = tl;
        out.ov_c = frac(ou.choices.find(c => /^over$/i.test(c.name))?.fractionalValue);
        out.un_c = frac(ou.choices.find(c => /^under$/i.test(c.name))?.fractionalValue);
      }
    }
    return Object.values(out).some(v => v > 1) ? out : null;
  }

  const eventUrl = e => e?.slug && e?.customId ? `https://www.sofascore.com/${e.slug}/${e.customId}` : null;

  return { findLiveEvent, liveOdds, eventUrl, dice };
})();
