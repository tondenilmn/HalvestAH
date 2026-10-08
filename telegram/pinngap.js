'use strict';
/**
 * Strategy PINNGAP (shadow — records, never alerts): Bet365's pre-match price
 * vs Pinnacle's pre-match price on the same line, at the same moment.
 *
 * Why: on 13 months of history (Pinnacle CSVs from git, paired with the Bet365
 * dataset), Bet365 opening ≥ 3% above Pinnacle's de-vigged fair returned
 * +3.5% (12/13 months), closing ≥ 5% +5.1%, AH ≥ 5% +7.1%. Opening gaps nearly
 * always close by kick-off (97-98% when both books stay on the line; Bet365
 * does ~55-65% of the moving, Pinnacle the rest) — but the history has no
 * timestamps, so how long a gap stays bettable is unknown. This records it.
 *
 * Bet365 = the PRICEGAP scan's tablenext fixtures (current AH / goal line /
 * 1X2); Pinnacle = the pre-match lists kept fresh by pinnacle_relay.js's
 * staggered rotation (CDN copies ~905 s, so a copy's age is logged with every
 * row). Fixtures are paired by kick-off (± 20 min) + team names (Dice).
 * AH and goal line: same line only, Pinnacle de-vigged proportionally (its
 * two-way margin is ~2-4%). 1X2: power de-vig (never proportional — see
 * CLAUDE.md's 1X2 note).
 *
 * Gap lifecycle per fixture + side (`track`): `open` when it first reaches the
 * floor, `tick` while it stays there (price/fair moves or every 10 min),
 * `closed` when it drops under 1% (with who moved: Bet365's price down vs
 * Pinnacle's fair up since `open`), and `cl` once in the last 30 min before
 * kick-off for every side that was ever open (closing-line value).
 */
const LG = require('./livegap');
const FM = require('./fair_model.js');

const sameLine = (a, b) => a != null && b != null && Math.abs(a - b) < 1e-6;
const startMs = s => { const t = Date.parse(s || ''); return isFinite(t) ? t : null; };

// Pinnacle pre-match sheets (only fixtures that haven't started), bucketed by
// kick-off hour for fast pairing.
function prematchIndex(markets, matchups, now = Date.now()) {
  const idx = new Map();
  for (const m of LG.pinnacleSheets(markets, matchups)) {
    const st = startMs(m.start);
    if (st == null || st <= now) continue;
    const b = Math.floor(st / 3600000);
    if (!idx.has(b)) idx.set(b, []);
    idx.get(b).push({ ...m, st });
  }
  return idx;
}

// Team-name dice strips '(W)', 'U21', 'II' etc., so the kind of side is checked
// separately — women / youth age group / reserve side must match. Bet365 marks
// it in the team name ("Andorra (W)", "Arsenal U21"), Pinnacle in the league
// ("... Women", "... U21", "... Reserves") with plain team names — so team and
// league are read together on both books.
const kindOf = (team, league) => {
  const s = `${team || ''} ${league || ''}`.toLowerCase();
  return [/\(w\)|\bwomen\b|\bfemen|\bfemin|\bladies\b|\bwfc\b/.test(s) ? 'W' : '',
    ((s.match(/\bu-?(1[5-9]|2[0-3])\b/) || [])[1]) || '',
    /\b(ii|reserves?)\b|\(r\)|\bres\.|\s+b$/.test(String(team || '').toLowerCase()) || /\breserves?\b/.test(String(league || '').toLowerCase()) ? 'R' : ''].join('|');
};

function findPrematch(idx, home, away, koMs, league = '', tolMs = 20 * 60000) {
  if (!idx || koMs == null) return null;
  const b = Math.floor(koMs / 3600000);
  let best = null;
  for (const k of [b - 1, b, b + 1]) for (const m of idx.get(k) || []) {
    if (Math.abs(m.st - koMs) > tolMs) continue;
    if (kindOf(m.home, m.league) !== kindOf(home, league) || kindOf(m.away, m.league) !== kindOf(away, league)) continue;
    const sh = LG.dice(m.home, home), sa = LG.dice(m.away, away);
    if (Math.min(sh, sa) < 0.4) continue;
    const s = (sh + sa) / 2;
    if (!best || s > best.s) best = { m, s };
  }
  return best && best.s >= 0.7 ? best.m : null;
}

// Same-line rows: { key, mk, side, line (the side's own line), price, fair, pin, edge }.
function gapRows(odds, x2, pm) {
  const rows = [];
  if (!pm?.ft) return rows;
  const add = (mk, side, line, price, fair, pin) => {
    if (!(price > 1) || !(fair > 1)) return;
    rows.push({ key: `${mk}|${side}|${line ?? ''}`, mk, side, line, price, fair, pin, edge: price / fair - 1 });
  };
  if (odds && odds.ah_hc != null) {
    const ah = pm.ft.ah.find(x => sameLine(x.line, +odds.ah_hc));
    const f = ah && LG.devig([ah.h, ah.a]);
    if (f) { add('AH', 'home', +odds.ah_hc, +odds.ho_c, f[0], ah.h); add('AH', 'away', -odds.ah_hc, +odds.ao_c, f[1], ah.a); }
  }
  if (odds && odds.tl_c != null) {
    const ou = pm.ft.ou.find(x => sameLine(x.line, +odds.tl_c));
    const f = ou && LG.devig([ou.o, ou.u]);
    if (f) { add('OU', 'over', +odds.tl_c, +odds.ov_c, f[0], ou.o); add('OU', 'under', +odds.tl_c, +odds.un_c, f[1], ou.u); }
  }
  const ml = pm.ft.ml;
  if (ml && x2) {
    const d = FM.devigPower([ml.h, ml.d, ml.a]);
    if (d) [['home', 'home_c', 0, ml.h], ['draw', 'draw_c', 1, ml.d], ['away', 'away_c', 2, ml.a]]
      .forEach(([side, k, i, pin]) => add('1X2', side, null, +x2[k], d.fair[i], pin));
  }
  return rows;
}

/**
 * Lifecycle events for one fixture's rows this scan. `state` = Map per fixture
 * key → { hot, everHot, open: {t,p,f}, last: {t,p,f}, cl }. Returns events to log.
 */
function track(state, id, rows, now, toKickoffMin, o = {}) {
  const minEdge = o.minEdge ?? 0.03, closeBelow = o.closeBelow ?? 0.01, tickMs = o.tickMs ?? 10 * 60000;
  const out = [];
  for (const r of rows) {
    const sk = `${id}|${r.key}`;
    let s = state.get(sk);
    if (!s) state.set(sk, s = { hot: false, everHot: false, open: null, last: null, cl: false });
    if (r.edge >= minEdge && r.edge < (o.maxEdge ?? 0.25)) {
      if (!s.hot) { s.hot = true; s.everHot = true; s.open = { t: now, p: r.price, f: r.fair }; s.last = { ...s.open }; out.push({ ev: 'open', r }); }
      else if (r.price !== s.last.p || Math.abs(r.fair / s.last.f - 1) > 0.005 || now - s.last.t >= tickMs) { s.last = { t: now, p: r.price, f: r.fair }; out.push({ ev: 'tick', r }); }
    } else if (s.hot && r.edge < closeBelow) {
      s.hot = false;
      out.push({ ev: 'closed', r, mins: Math.round((now - s.open.t) / 60000),
        byB365: +Math.log(s.open.p / r.price).toFixed(4), byPin: +Math.log(r.fair / s.open.f).toFixed(4) });
    }
    if (s.everHot && !s.cl && toKickoffMin != null && toKickoffMin <= 30) { s.cl = true; out.push({ ev: 'cl', r }); }
  }
  return out;
}

const recordRow = (t, match, koMs, ev, pinAgeS) => {
  const r = ev.r;
  return { t, ev: ev.ev, id: match.id, ko: koMs, kmin: Math.round((koMs - t) / 60000), k: r.key, mk: r.mk, side: r.side, line: r.line,
    p: r.price, f: +r.fair.toFixed(3), pin: r.pin, e: +(r.edge * 100).toFixed(2), pa: pinAgeS == null ? null : Math.round(pinAgeS),
    ...(ev.mins != null ? { mins: ev.mins, byB365: ev.byB365, byPin: ev.byPin } : {}),
    sc: '0-0', m: `${match.home_team} v ${match.away_team}`, lg: match.league || '' };
};

module.exports = { prematchIndex, findPrematch, gapRows, track, recordRow, kindOf };
