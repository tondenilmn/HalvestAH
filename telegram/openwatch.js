'use strict';
/**
 * Strategy OPENWATCH (shadow — records, never alerts; added 2026-10-10).
 *
 * research_books.js on 14 months of three-book history: the books lead in the
 * order Sbobet → Pinnacle → Bet365 (Bet365 closes 97% of an opening gap to
 * Sbobet, 75% to Pinnacle), and Pinnacle's CLOSING price is predicted from the
 * openings as ≈ 0.91·Sbobet + 0.13·Pinnacle (no Sbobet: 0.78·Pinnacle +
 * 0.21·Bet365) in expected goals. Betting Bet365's OPENING price when it is
 * ≥ 3% above that predicted close returned +8.5% (61k bets, 11/11 test months;
 * +7.3% without Sbobet; ROI ≈ closing-line value). The history has no
 * timestamps, so whether such prices can actually be taken — and for how long —
 * is what this recorder measures.
 *
 * Live, every Bet365 fixture of the PRICEGAP scans (near + far) with a fresh
 * Pinnacle pre-match price: each book's CURRENT AH + goal line (Pinnacle's main
 * lines: prices closest to even) → μ / s (market_fit.js) → predicted Pinnacle
 * close (openwatch_weights.json) → expected return of each Bet365 AH / O-U side
 * at its own line and price. Lines needn't match between books. Rows go through
 * pinngap.track's lifecycle (open / tick / closed / cl) and are tagged `op`
 * (Bet365 still on its opening line + price for that market) and `hs` (Sbobet
 * listed). Settled on confirmed FT scores; GET <bot>/openwatch/report.
 */
const fs = require('fs');
const path = require('path');
const MF = require('./market_fit');
const FM = require('./fair_model.js');

const W = JSON.parse(fs.readFileSync(path.join(__dirname, 'openwatch_weights.json'), 'utf8'));
const dot = (w, x) => w.reduce((s, v, i) => s + v * x[i], 0);

// Pinnacle's main line of a list ({line, h, a} or {line, o, u}): the two prices closest to each other.
function mainLine(list, a, b) {
  let best = null;
  for (const x of list || []) if (x[a] > 1 && x[b] > 1 && (!best || Math.abs(1 / x[a] - 1 / x[b]) < Math.abs(1 / best[a] - 1 / best[b]))) best = x;
  return best;
}
const fromOdds = o => o && MF.fitPrices({ ah: +o.ah_hc, ho: +o.ho_c, ao: +o.ao_c, tl: +o.tl_c, ov: +o.ov_c, un: +o.un_c });
function fromPinnacle(pm) {
  const ah = mainLine(pm?.ft?.ah, 'h', 'a'), ou = mainLine(pm?.ft?.ou, 'o', 'u');
  if (!ah || !ou) return null;
  const f = MF.fitPrices({ ah: ah.line, ho: ah.h, ao: ah.a, tl: ou.line, ov: ou.o, un: ou.u });
  return f && { ...f, lines: [ah.line, ou.line] };
}

// Predicted Pinnacle close (μ, s) from the current prices of the three books.
function predictClose(b, p, s) {
  if (!b || !p) return null;
  return s
    ? { mu: dot(W.mu_withSbobet, [1, b.mu, p.mu, s.mu]), s: dot(W.s_withSbobet, [1, b.s, p.s, s.s]), hs: true }
    : { mu: dot(W.mu_noSbobet, [1, b.mu, p.mu]), s: dot(W.s_noSbobet, [1, b.s, p.s]), hs: false };
}

// Bet365 rows { key, mk, side, line (side's own), price, fair, edge, op } against the predicted close.
function rowsFor(odds, pm, sboOdds) {
  const b = fromOdds(odds), p = fromPinnacle(pm);
  const pred = predictClose(b, p, fromOdds(sboOdds));
  if (!pred) return { rows: [], pred: null };
  const ah = +odds.ah_hc, tl = +odds.tl_c;
  const ahOpen = +odds.ah_ho === ah && +odds.ho_o === +odds.ho_c && +odds.ao_o === +odds.ao_c;
  const ouOpen = +odds.tl_o === tl && +odds.ov_o === +odds.ov_c && +odds.un_o === +odds.un_c;
  const rows = [];
  for (const [mk, side, line, homeLine, price, op] of [['AH', 'home', ah, ah, +odds.ho_c, ahOpen], ['AH', 'away', -ah, ah, +odds.ao_c, ahOpen],
    ['OU', 'over', tl, tl, +odds.ov_c, ouOpen], ['OU', 'under', tl, tl, +odds.un_c, ouOpen]]) {
    if (!(price > 1)) continue;
    const ev = MF.evOf(pred.mu, pred.s, mk, side, homeLine, price);
    rows.push({ key: `${mk}|${side}|${line}`, mk, side, line, price, fair: price / ev, edge: ev - 1, op, pin: null });
  }
  return { rows, pred, pinLines: p.lines };
}

// Exchange leg (added 2026-10-17, user request — a plan for a Bet365 freeze):
// the same predicted Pinnacle close (μ, s) turned into a fair 1X2 by the
// scoreline model, against Betfair's best back price (oddsmonitor event) net of
// the commission on winnings. Only liquid, tight books (o.minMatched, o.maxBook)
// so the price is one that can be matched. Rows: { key 'BF|1X2|side|', mk '1X2',
// price = net, bf, fair, edge, mt, book }.
function exchangeRows(pred, ev, o = {}) {
  const c = o.commission ?? 0.045;
  const bf = [ev?.home_odd, ev?.draw_odd, ev?.away_odd].map(Number);
  if (!pred || bf.some(x => !(x > 1))) return [];
  const book = bf.reduce((t, x) => t + 1 / x, 0), mt = +ev.total_matched || 0;
  if (mt < (o.minMatched ?? 1000) || book > (o.maxBook ?? 1.04)) return [];
  const [lh, la] = MF.lam(pred.mu, pred.s), P = FM.scoreGrid(lh, la);
  let ph = 0, pd = 0;
  for (let i = 0; i < P.length; i++) for (let j = 0; j < P[i].length; j++) { if (i > j) ph += P[i][j]; else if (i === j) pd += P[i][j]; }
  const pr = [ph, pd, 1 - ph - pd];
  return ['home', 'draw', 'away'].map((side, i) => {
    const net = 1 + (bf[i] - 1) * (1 - c);
    return { key: `BF|1X2|${side}|`, mk: '1X2', side, line: null, price: +net.toFixed(4), bf: bf[i], fair: 1 / pr[i], edge: net * pr[i] - 1, pin: null, mt: Math.round(mt), book: +book.toFixed(3) };
  });
}

module.exports = { rowsFor, exchangeRows, predictClose, mainLine, fromOdds, fromPinnacle, W };
