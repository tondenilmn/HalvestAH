'use strict';
/**
 * Strategy CROSSMARKET (shadow — records, never alerts): one Bet365 market
 * priced against Bet365's own other markets, on prices seen AT THE SAME
 * MOMENT in the same tablenext file.
 *
 * Why a live test: telegram/backtest_crossmarket.js found, on 20 months of
 * the Bet365 dataset, that the Asian handicap at its closing price ≥ 5% above
 * the price implied by Bet365's own 1X2 + goal line returned +9.2% (17/20
 * months; +18.7% when the 1X2 had moved that way and the AH lagged), and the
 * 1X2 at its opening price ≥ 5% above the AH-implied price +13.7% (20/20).
 * The pattern flips between opening and closing, which is what a dataset
 * recording the 1X2 at a different moment from the AH would produce — so
 * only prices that exist together can tell whether the edge is real.
 *
 *   A  1X2 side vs the 1X2 implied by Bet365's AH + goal line
 *      (fair_model.solve, two-way de-vig)
 *   B  AH side at Bet365's own line vs the AH implied by Bet365's 1X2
 *      (power de-vig) + goal line (fair_model.solveFrom1x2)
 * Each side gets the exact expected return at Bet365's price (quarter lines
 * split), whether both markets are still at their opening prices (the
 * backtest's "opening" bucket), and how far each market's home−away
 * probability has moved since opening (the "1X2 moved, AH lagged" split).
 */
const fs = require('fs');
const path = require('path');
const FM = require('../static/fair_model.js');

const ok2 = (p, q) => p > 1.01 && q > 1.01 && 1 / p + 1 / q > 1.0 && 1 / p + 1 / q < 1.15;
const ok3 = x => x.every(v => v > 1.01) && x.reduce((s, v) => s + 1 / v, 0) > 1.0 && x.reduce((s, v) => s + 1 / v, 0) < 1.25;
const num = v => (v == null || v === '' ? null : (isFinite(+v) ? +v : null));
const quarter = v => v != null && Math.abs(v * 4 - Math.round(v * 4)) < 1e-6;
const expRet = (d, price) => d.w * price + d.hw * (price + 1) / 2 + d.p + d.hl / 2;

// Bet365's snapshot (current or opening) in the shape the model needs, or null.
function snapshot(odds, x2, which) {
  const c = which === 'c';
  const S = {
    ah: num(c ? odds?.ah_hc : odds?.ah_ho), ho: num(c ? odds?.ho_c : odds?.ho_o), ao: num(c ? odds?.ao_c : odds?.ao_o),
    tl: num(c ? odds?.tl_c : odds?.tl_o), ov: num(c ? odds?.ov_c : odds?.ov_o), un: num(c ? odds?.un_c : odds?.un_o),
    x: [num(c ? x2?.home_c : x2?.home_o), num(c ? x2?.draw_c : x2?.draw_o), num(c ? x2?.away_c : x2?.away_o)],
  };
  if (!quarter(S.ah) || !quarter(S.tl) || !ok2(S.ho, S.ao) || !ok2(S.ov, S.un) || !ok3(S.x)) return null;
  return S;
}

// Expected goals fitted both ways for one snapshot.
function fitBoth(S) {
  const ahF = FM.devig([S.ho, S.ao]).fair, ouF = FM.devig([S.ov, S.un]).fair, xP = FM.devigPower(S.x).probs;
  const fromAH = FM.solve({ ahLine: S.ah, ahHomeFair: ahF[0], tl: S.tl, overFair: ouF[0] });
  const from1x2 = FM.solveFrom1x2({ pHome: xP[0], pAway: xP[2], tl: S.tl, overFair: ouF[0] });
  const x12FromAH = FM.markets(fromAH.lh, fromAH.la).result.map(r => r.p);
  return { xP, x12FromAH, from1x2 };
}

/**
 * Rows for one fixture: every 1X2 side (A) and both AH sides (B) with the
 * model's fair price and the exact edge at Bet365's current price.
 */
function analyse(odds, x2) {
  const C = snapshot(odds, x2, 'c');
  if (!C) return [];
  const O = snapshot(odds, x2, 'o');
  const fc = fitBoth(C);
  const fo = O ? fitBoth(O) : null;
  // home − away probability moves since opening, AH-implied and 1X2's own
  const mvAH = fo ? (fc.x12FromAH[0] - fc.x12FromAH[2]) - (fo.x12FromAH[0] - fo.x12FromAH[2]) : null;
  const mvX = fo ? (fc.xP[0] - fc.xP[2]) - (fo.xP[0] - fo.xP[2]) : null;
  const ahOpen = O && C.ah === O.ah && C.ho === O.ho && C.ao === O.ao && C.tl === O.tl && C.ov === O.ov && C.un === O.un;
  const xOpen = O && C.x.every((v, k) => v === O.x[k]);
  const unmoved = !!(ahOpen && xOpen);
  const rows = [];
  ['home', 'draw', 'away'].forEach((side, k) => {
    const p = fc.x12FromAH[k], price = C.x[k];
    if (!(p > 0)) return;
    rows.push({ ty: 'A', mk: '1X2', side, line: null, price, fair: 1 / p, edge: price * p - 1, unmoved, mvAH, mvX });
  });
  const P = FM.scoreGrid(fc.from1x2.lh, fc.from1x2.la);
  for (const [side, line, price] of [['home', C.ah, C.ho], ['away', -C.ah, C.ao]]) {
    const d = FM.ahDist(P, C.ah, side);
    const fair = FM.fairOddsFromDist(d);
    if (!isFinite(fair)) continue;
    rows.push({ ty: 'B', mk: 'AH', side, line, price, fair, edge: expRet(d, price) - 1, unmoved, mvAH, mvX });
  }
  return rows;
}

// Whether a row's market moved the way the backtest's "lagged" split means:
// A — the AH-implied side moved toward it and the 1X2 followed less than half;
// B — the 1X2 moved toward it and the AH followed less than half.
function lagged(r) {
  if (r.mvAH == null || r.mvX == null || r.side === 'draw') return false;
  const sgn = r.side === 'home' ? 1 : -1;
  const lead = sgn * (r.ty === 'A' ? r.mvAH : r.mvX), follow = sgn * (r.ty === 'A' ? r.mvX : r.mvAH);
  return lead > 0.03 && follow < lead / 2;
}

const recordRow = (t, match, koMs, r) => ({
  t, id: match.id, ko: koMs, kmin: Math.round((koMs - t) / 60000), k: `${r.ty}|${r.mk}|${r.side}|${r.line ?? ''}`,
  ty: r.ty, mk: r.mk, side: r.side, line: r.line, p: r.price, f: +r.fair.toFixed(3), e: +(r.edge * 100).toFixed(2),
  un: r.unmoved, lag: lagged(r), mvAH: r.mvAH == null ? null : +r.mvAH.toFixed(3), mvX: r.mvX == null ? null : +r.mvX.toFixed(3),
  sc: '0-0', m: `${match.home_team} v ${match.away_team}`, lg: match.league || '',
});

// ── Settlement queue (livegap_result.settleDue entries), keyed on kick-off ──
// Checked from 1 h 50 min after kick-off; livegap_result gives up 6 h after
// `firstT`, so firstT = kick-off.
function queue(pending, id, label, koMs) {
  if (pending.has(id)) return;
  pending.set(id, { id, m: label, firstT: koMs, lastSeen: 0, gone: true, nextCheck: koMs + 110 * 60000, et: false, reg: null, regMin: null });
}
// After a restart: every recorded fixture of the last `days` files without a result.
function recoverPending(dir, days = 9) {
  const pending = new Map(), done = new Set();
  if (!fs.existsSync(dir)) return pending;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().slice(-days)) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.res !== undefined || o.nores) done.add(o.id);
      else if (o.k && o.ko) queue(pending, o.id, o.m, o.ko);
    }
  }
  for (const id of done) pending.delete(id);
  return pending;
}

module.exports = { analyse, lagged, recordRow, queue, recoverPending, snapshot };
