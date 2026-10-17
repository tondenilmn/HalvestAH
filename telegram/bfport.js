'use strict';
/**
 * BFPORT — paper portfolio on Betfair Exchange 1X2 (added 2026-10-10, user
 * request: bets as a medium/long-term "fund" on the exchange, where the margin
 * is low). Never alerts, never bets: it records what the rule would buy and
 * keeps a paper bankroll.
 *
 * Why Betfair 1X2 (not Over/Under): it is the exchange's most liquid market and
 * the only one we can read for free (oddsmonitor.eu lists Match Odds only — no
 * O/U, no AH). O/U would need Smarkets/Matchbook.
 *
 * The rule (BFPORT_* in config.js): Betfair's best back price, after the
 * commission on winnings (4.5% Italy: net = 1 + (b − 1)(1 − c)), above
 * Pinnacle's de-vigged pre-match fair (power de-vig) by ≥ BFPORT_MIN_EDGE_PCT,
 * same moment (Pinnacle copy ≤ BFPORT_MAX_PIN_AGE_S), Betfair price within
 * BFPORT_MIN_ODDS–BFPORT_MAX_ODDS, ≥ BFPORT_MIN_MATCHED matched, a tight
 * Betfair book (Σ 1/back ≤ BFPORT_MAX_BOOK), kick-off 10 min–24 h away. One bet
 * per fixture (the first side to qualify). Stake = ⅛ Kelly at the net price on
 * the current paper bankroll, capped at BFPORT_MAX_STAKE_PCT.
 *
 * Records (data/bfport/*.jsonl): `c` sides with edge ≥ 1% (first seen, price/
 * fair moves, else every 30 min) — so other thresholds can be tested on the
 * same data; `cl` every paired side once in the last 30 min (closing: the
 * exchange's own blind return by price band, and CLV); `bet` the paper bets.
 * Settled on the confirmed FT score of the paired asianbetsoccer fixture.
 */
const LG = require('./livegap');
const FM = require('./fair_model.js');
const { kindOf } = require('./pinngap');

const SIDES = ['home', 'draw', 'away'];
const netPrice = (b, c) => 1 + (b - 1) * (1 - c);

// Betfair event for a fixture: not in play, kick-off ± tolerance, team names, kind of side.
function findPrematchEvent(events, home, away, koMs, league = '', tolMs = 20 * 60000) {
  let best = null;
  for (const e of events || []) {
    if (e.inplay) continue;
    const ko = Date.parse(e.open_date_raw || '');
    if (!isFinite(ko) || Math.abs(ko - koMs) > tolMs) continue;
    const [h, a] = String(e.event_name || '').split(/\s+v\s+/);
    if (!h || !a) continue;
    if (kindOf(h, e.competition_name) !== kindOf(home, league) || kindOf(a, e.competition_name) !== kindOf(away, league)) continue;
    const sh = LG.dice(h, home), sa = LG.dice(a, away);
    if (Math.min(sh, sa) < 0.4) continue;
    const s = (sh + sa) / 2;
    if (!best || s > best.s) best = { e, s };
  }
  return best && best.s >= 0.7 ? best.e : null;
}

// Three rows, one per side: Betfair back, net of commission, vs Pinnacle's fair.
function sideRows(ev, pm, commission = 0.045) {
  const ml = pm?.ft?.ml;
  const bf = [ev?.home_odd, ev?.draw_odd, ev?.away_odd].map(Number);
  if (!ml || bf.some(x => !(x > 1))) return [];
  const d = FM.devigPower([ml.h, ml.d, ml.a]);
  if (!d) return [];
  const book = bf.reduce((s, x) => s + 1 / x, 0);
  const pin = [ml.h, ml.d, ml.a];
  return SIDES.map((side, i) => {
    const net = netPrice(bf[i], commission);
    return { key: `1X2|${side}|`, mk: '1X2', side, line: null, bf: bf[i], net, fair: d.fair[i], pin: pin[i], edge: net / d.fair[i] - 1, book, matched: +ev.total_matched || 0 };
  });
}

// Why a row may not be bought (null = it may).
function blockReason(r, toKickoffMin, pinAgeS, o) {
  if (!(r.edge * 100 >= o.minEdge)) return `edge ${(r.edge * 100).toFixed(1)}% < ${o.minEdge}%`;
  if (r.edge * 100 >= o.maxEdge) return `edge ≥ ${o.maxEdge}% (likely a stale price)`;
  if (r.bf < o.minOdds || r.bf > o.maxOdds) return `Betfair ${r.bf} outside ${o.minOdds}–${o.maxOdds}`;
  if (r.matched < o.minMatched) return `only ${Math.round(r.matched)} matched`;
  if (r.book > o.maxBook) return `Betfair book ${r.book.toFixed(3)} too wide`;
  if (pinAgeS == null || pinAgeS > o.maxPinAge) return 'Pinnacle copy too old';
  if (toKickoffMin == null || toKickoffMin < 10 || toKickoffMin > 1440) return 'kick-off not 10 min–24 h away';
  return null;
}

// Fractional Kelly at the net price, capped, as a fraction of the bankroll.
function stakeFrac(r, o) {
  const p = 1 / r.fair, b = r.net - 1;
  const k = (p * r.net - 1) / b;
  return Math.max(0, Math.min(o.maxStakePct / 100, k * o.kellyFraction));
}

// Paper bankroll: start + P/L of the settled bets. `bets` = bet records, `fin`
// = id → final score. Stake was fixed when the bet was placed.
function settleBet(b, final) {
  const m = String(final || '').match(/(\d+)\s*-\s*(\d+)/);
  if (!m) return null;
  const d = +m[1] - +m[2];
  const won = b.side === 'home' ? d > 0 : b.side === 'away' ? d < 0 : d === 0;
  return won ? b.stake * ((b.net ?? b.p) - 1) : -b.stake;
}
function bankrollOf(start, bets, fin) {
  let bank = start;
  for (const b of bets) { const f = fin.get(b.id); if (f != null) { const pl = settleBet(b, f); if (pl != null) bank += pl; } }
  return bank;
}

const recordRow = (t, ev, match, koMs, r, pinAgeS, b365x2, extra = {}) => ({
  t, ev, id: match.id, ko: koMs, kmin: Math.round((koMs - t) / 60000), k: r.key, mk: '1X2', side: r.side, line: null,
  p: r.net, bf: r.bf, f: +r.fair.toFixed(3), pin: r.pin, e: +(r.edge * 100).toFixed(2), book: +r.book.toFixed(3), mt: Math.round(r.matched),
  pa: pinAgeS == null ? null : Math.round(pinAgeS),
  ...(b365x2 ? { b3: +b365x2[`${r.side}_c`] || null } : {}),
  sc: '0-0', m: `${match.home_team} v ${match.away_team}`, lg: match.league || '', ...extra,
});

// ── Scalp tracker (added 2026-10-17, research_bf_scalp.js's lead): Betfair 1X2 vs
// Pinnacle's pre-match fair, kick-off ≥ 30 min away, both directions:
//   back first — Betfair back ≥ minPct above fair: back now, lay later;
//   lay first  — Betfair lay (taken as one tick above the back price; the list has
//                no lay price) ≥ minPct below fair: lay now, back later.
// Exits logged 15 / 60 min later and in the last 5 min before kick-off. Green per
// unit: back first entry / lay − 1, lay first 1 − lay / back; commission when
// positive. `gw` = the same with a wider spread on thin markets (ticksFor).
const BANDS = [[2, 0.01], [3, 0.02], [4, 0.05], [6, 0.1], [10, 0.2], [20, 0.5], [30, 1], [50, 2], [100, 5], [1000, 10]];
const tickUp = (p, n = 1) => { for (let k = 0; k < n; k++) { const b = BANDS.find(([hi]) => p < hi - 1e-9); if (!b) break; p = +(p + b[1]).toFixed(2); } return p; };
const ticksFor = matched => (matched >= 2e4 ? 1 : matched >= 5e3 ? 2 : 3);
const netG = (g, c) => (g > 0 ? g * (1 - c) : g);
// Back-first green at entry back price `entry`, lay n ticks above the exit back price.
const scalpGreen = (entry, back, c = 0.045, n = 1) => netG(entry / tickUp(back, n) - 1, c);
// Lay-first green: laid at `lay`, backed later at the exit back price.
const scalpGreenLay = (lay, back, c = 0.045) => netG(1 - lay / back, c);
function scalpTrack(state, id, rows, now, toKickoffMin, o = {}) {
  const minPct = o.minPct ?? 3, c = o.commission ?? 0.045, out = [];
  for (const r of rows) {
    const n = ticksFor(r.matched);
    for (const dir of ['back', 'lay']) {
      const k = `${id}|${r.side}|${dir}`;
      let s = state.get(k);
      if (!s) {
        const lay = tickUp(r.bf), edge = dir === 'back' ? r.bf / r.fair - 1 : r.fair / lay - 1;
        if (edge * 100 < minPct || edge > 0.25 || toKickoffMin == null || toKickoffMin < 30) continue;
        // Entry price: back price (back first) or lay price (lay first); laywide = lay n ticks above the back price.
        state.set(k, s = { t: now, p: dir === 'back' ? r.bf : lay, pw: dir === 'back' ? r.bf : tickUp(r.bf, n), n, done: new Set() });
        out.push({ ev: 'so', side: r.side, dir, bf: r.bf, p: s.p, f: +r.fair.toFixed(3), e: +(edge * 100).toFixed(2), kmin: Math.round(toKickoffMin), mt: Math.round(r.matched), book: +r.book.toFixed(3), ...(o.extra || {}) });
        continue;
      }
      for (const [h, due] of [['15', now - s.t >= 15 * 60000], ['60', now - s.t >= 60 * 60000], ['ko', toKickoffMin != null && toKickoffMin <= 5]]) {
        if (!due || s.done.has(h)) continue;
        s.done.add(h);
        const g = dir === 'back' ? scalpGreen(s.p, r.bf, c) : scalpGreenLay(s.p, r.bf, c);
        const gw = dir === 'back' ? scalpGreen(s.p, r.bf, c, s.n) : scalpGreenLay(s.pw, r.bf, c);
        out.push({ ev: 'sx', side: r.side, dir, h, in: s.p, bf: r.bf, g: +g.toFixed(4), gw: +gw.toFixed(4), mins: Math.round((now - s.t) / 60000) });
      }
    }
  }
  return out;
}

module.exports = { scalpTrack, scalpGreen, scalpGreenLay, tickUp, ticksFor, netPrice, findPrematchEvent, sideRows, blockReason, stakeFrac, settleBet, bankrollOf, recordRow, SIDES };
