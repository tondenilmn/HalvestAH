/* ══════════════════════════════════════════════════════════════════════
   pinnacle.js — Pinnacle's live prices (via /api/pinnacle) as the sharp
   reference for Bet365's in-play prices, in the MATCH and MATCHES tabs.

   buildPinnacleRows(odds, pm) compares Bet365's live price with Pinnacle's
   de-vigged price on the SAME line — 1X2, Asian handicap (goals from now,
   both books) and the goal line (full-match total, both books). Same-line,
   same-moment, sharp-book comparison: the in-play analogue of the
   pre-match Bet365-vs-Sbobet setup that backtested, but itself NOT
   backtested (no in-play price history).

   Depends on: fair_model.js (FairModel.devig/kelly), match.js (_mt prefs,
   fLine, sameLine, num), sofascore.js (Sofa.dice for team names).
   ══════════════════════════════════════════════════════════════════════ */

// Pinnacle's guest API sits behind a shared CDN cache (copies up to ~15 min
// old, not refreshed when prices move — see functions/api/pinnacle.js).
// /api/pinnacle uses the youngest copy and reports its age; above this many
// seconds the prices are not used at all (model instead).
const PINN_MAX_AGE_S = 120;

const Pinn = (() => {
  const TTL_MS = 25000;
  let cache = { at: 0, data: null, pending: null };

  async function get() {
    if (cache.data && Date.now() - cache.at < TTL_MS) return cache.data;
    if (cache.pending) return cache.pending;
    cache.pending = fetch('/api/pinnacle').then(r => r.json())
      .then(d => { d._recv = Date.now(); cache = { at: Date.now(), data: d, pending: null }; return d; })
      .catch(e => { cache.pending = null; throw e; });
    return cache.pending;
  }

  const sim = (a, b) => (typeof Sofa !== 'undefined' ? Sofa.dice(a, b) : (String(a).toLowerCase() === String(b).toLowerCase() ? 1 : 0));

  // Pinnacle match for these teams: both names close, current score agreeing
  // when known (it breaks ties and sinks a weak name match).
  function find(matches, home, away, score) {
    let best = null;
    for (const m of matches || []) {
      const sh = sim(m.home, home), sa = sim(m.away, away);
      if (Math.min(sh, sa) < 0.4) continue;
      let s = (sh + sa) / 2;
      // Different score = Pinnacle's copy is from before a goal (or another
      // match): its prices can't be compared, so never match it.
      if (score && m.score?.home != null) {
        if (m.score.home !== score.home || m.score.away !== score.away) continue;
        s += 0.15;
      }
      if (!best || s > best.s) best = { m, s };
    }
    return best && best.s >= 0.7 ? best.m : null;
  }

  // How old the prices are now (copy age at fetch + time since), and
  // whether that is fresh enough to use.
  function ageOf(d) {
    const a = d?.age?.markets;
    if (!Number.isFinite(a)) return null;
    return a + (d._recv ? (Date.now() - d._recv) / 1000 : 0);
  }
  function usable(d) {
    if (!d || d.error) return { ok: false, age: null, why: d?.error || 'Pinnacle unavailable' };
    const age = ageOf(d);
    if (age == null) return { ok: false, age: null, why: 'Pinnacle prices of unknown age — not used' };
    if (age > PINN_MAX_AGE_S) return { ok: false, age, why: `Pinnacle prices ${fmtAge(age)} old — not used (cached copy; over ${PINN_MAX_AGE_S / 60} min)` };
    return { ok: true, age, why: null };
  }
  const fmtAge = s => (s < 90 ? `${Math.round(s)} s` : `${(s / 60).toFixed(s < 600 ? 1 : 0)} min`);

  return { get, find, usable, ageOf, fmtAge };
})();

// Bet365 live price vs Pinnacle's de-vigged live price, same line only.
// Rows have the same shape as buildLiveValueRows (match.js) plus method 'pinnacle'.
function buildPinnacleRows(odds, pm) {
  if (!odds || !pm?.ft) return [];
  const rows = [];
  const push = (market, label, price, fair, pinPrice) => {
    if (!(price > 1) || !(fair > 1) || !isFinite(fair)) return;
    const p = 1 / fair;
    rows.push({ market, label, price, fair, p, pinPrice, method: 'pinnacle', edge: price / fair - 1,
      minOdds: fair * (1 + _mt.threshold / 100), kelly: FairModel.kelly(p, price, _mt.kellyFrac) });
  };
  const ml = pm.ft.ml;
  if (ml?.h && ml?.d && ml?.a) {
    const dv = FairModel.devig([ml.h, ml.d, ml.a]);
    if (dv) ['x2_h', 'x2_x', 'x2_a'].forEach((k, i) => push('1X2', ['Home win', 'Draw', 'Away win'][i], odds[k], dv.fair[i], [ml.h, ml.d, ml.a][i]));
  }
  if (num(odds.ah_hc) != null) {
    const ah = pm.ft.ah.find(x => sameLine(x.line, odds.ah_hc));
    const dv = ah && FairModel.devig([ah.h, ah.a]);
    if (dv) {
      push('AH', `Home ${fLine(odds.ah_hc)} (from now)`, odds.ho_c, dv.fair[0], ah.h);
      push('AH', `Away ${fLine(-odds.ah_hc)} (from now)`, odds.ao_c, dv.fair[1], ah.a);
    }
  }
  if (num(odds.tl_c) != null) {
    const ou = pm.ft.ou.find(x => sameLine(x.line, odds.tl_c));
    const dv = ou && FairModel.devig([ou.o, ou.u]);
    if (dv) {
      push('OU', `Over ${odds.tl_c}`, odds.ov_c, dv.fair[0], ou.o);
      push('OU', `Under ${odds.tl_c}`, odds.un_c, dv.fair[1], ou.u);
    }
  }
  return rows.sort((a, b) => b.edge - a.edge);
}
