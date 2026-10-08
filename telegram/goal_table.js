'use strict';
/**
 * Precomputed fair_model table for backtests that fit hundreds of thousands
 * of matches: the Dixon-Coles scoreline grid (static/fair_model.js) over a
 * grid of total goals μ × supremacy s, storing for every cell the 1X2
 * probabilities and, for every AH line (home handicap) and goal line, the
 * full-win share A and refund share B — so the expected return at price q is
 * A·q + B − 1 exactly (quarter lines split) and the fair price is (1 − B)/A.
 * Matches are fitted by alternating μ (goal line) and s (AH or 1X2) by
 * bisection on the table, like FairModel.solve / solveFrom1x2. At the default
 * 0.0125 step the 1X2 probabilities stay within ~0.14pp of FairModel.solve
 * (checked on a sample in backtest_crossmarket.js). Building takes ~20 s.
 */
const FM = require('../static/fair_model.js');

const AH_LINES = []; for (let l = -3.5; l <= 3.5 + 1e-9; l += 0.25) AH_LINES.push(+l.toFixed(2));
const TL_LINES = []; for (let t = 0.5; t <= 6.0 + 1e-9; t += 0.25) TL_LINES.push(+t.toFixed(2));
const idx = (arr, v) => (v == null ? -1 : arr.findIndex(x => Math.abs(x - v) < 1e-6));

// Return at price q for margin m vs line L as a·q + b (quarter lines split).
function ret(m, L) {
  const one = x => (x > 1e-9 ? { a: 1, b: 0 } : x < -1e-9 ? { a: 0, b: 0 } : { a: 0, b: 1 });
  if (Math.abs(Math.abs(L * 4) % 2 - 1) < 1e-6) { const u = one(m + L - 0.25), v = one(m + L + 0.25); return { a: (u.a + v.a) / 2, b: (u.b + v.b) / 2 }; }
  return one(m + L);
}

function buildTable({ step = 0.0125, mu0 = 0.4, mu1 = 6.0, s0 = -4.5, s1 = 4.5, rho = FM.DEFAULT_RHO } = {}) {
  const NMU = Math.round((mu1 - mu0) / step) + 1, NS = Math.round((s1 - s0) / step) + 1, cells = NMU * NS;
  const nA = AH_LINES.length, nT = TL_LINES.length;
  const T = { step, mu0, s0, NMU, NS, x12: new Float32Array(cells * 3),
    ahA: new Float32Array(cells * nA), ahB: new Float32Array(cells * nA), ouA: new Float32Array(cells * nT), ouB: new Float32Array(cells * nT) };
  for (let i = 0; i < NMU; i++) for (let j = 0; j < NS; j++) {
    const mu = mu0 + i * step, s = s0 + j * step, c = i * NS + j;
    const P = FM.scoreGrid(Math.max((mu + s) / 2, 0.02), Math.max((mu - s) / 2, 0.02), rho);
    const dDiff = new Map(), dTot = new Map(); let pH = 0, pD = 0;
    for (let h = 0; h < P.length; h++) for (let a = 0; a < P[h].length; a++) {
      const p = P[h][a]; if (!p) continue;
      dDiff.set(h - a, (dDiff.get(h - a) || 0) + p); dTot.set(h + a, (dTot.get(h + a) || 0) + p);
      if (h > a) pH += p; else if (h === a) pD += p;
    }
    T.x12[c * 3] = pH; T.x12[c * 3 + 1] = pD; T.x12[c * 3 + 2] = 1 - pH - pD;
    for (let k = 0; k < nA; k++) { let A = 0, B = 0; for (const [d, p] of dDiff) { const r = ret(d, AH_LINES[k]); A += p * r.a; B += p * r.b; } T.ahA[c * nA + k] = A; T.ahB[c * nA + k] = B; }
    for (let k = 0; k < nT; k++) { let A = 0, B = 0; for (const [g, p] of dTot) { const r = ret(g, -TL_LINES[k]); A += p * r.a; B += p * r.b; } T.ouA[c * nT + k] = A; T.ouB[c * nT + k] = B; }
  }
  return T;
}

const fairOf = (A, B) => (A > 1e-9 ? (1 - B) / A : Infinity);

// Shares {A, B} for a side in a cell. AH: side 'home' at home line L, 'away'
// at away line −L (mirror cell s → −s). OU: 'over' / 'under' at goal line t.
function ahShares(T, c, homeLine, side) {
  const nA = AH_LINES.length;
  if (side === 'home') { const k = idx(AH_LINES, homeLine); return k < 0 ? null : { A: T.ahA[c * nA + k], B: T.ahB[c * nA + k] }; }
  const i = Math.floor(c / T.NS), jm = (T.NS - 1) - (c % T.NS), k = idx(AH_LINES, -homeLine);
  return k < 0 ? null : { A: T.ahA[(i * T.NS + jm) * nA + k], B: T.ahB[(i * T.NS + jm) * nA + k] };
}
function ouShares(T, c, tl, side) {
  const nT = TL_LINES.length, k = idx(TL_LINES, tl);
  if (k < 0) return null;
  const A = T.ouA[c * nT + k], B = T.ouB[c * nT + k];
  return side === 'over' ? { A, B } : { A: 1 - A - B, B }; // under wins = over loses; refunds equal
}

function fit(T, tl, overFair, sideFn) {
  const tlK = idx(TL_LINES, tl);
  if (tlK < 0) return -1;
  const nT = TL_LINES.length, { NMU, NS } = T;
  const ouFair = c => fairOf(T.ouA[c * nT + tlK], T.ouB[c * nT + tlK]);
  let i = Math.round((2.6 - T.mu0) / T.step), j = Math.round((0 - T.s0) / T.step);
  for (let it = 0; it < 12; it++) {
    const pi = i, pj = j;
    let lo = 0, hi = NMU - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ouFair(m * NS + j) > overFair) lo = m + 1; else hi = m; }
    i = lo; lo = 0; hi = NS - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sideFn(i * NS + m) < 0) lo = m + 1; else hi = m; }
    j = lo;
    if (i === pi && j === pj) break;
  }
  return i * NS + j;
}
// Cell from Bet365's AH (home fair odds at home line) + goal line (over fair odds).
function cellFromAH(T, homeLine, ahHomeFair, tl, overFair) {
  if (idx(AH_LINES, homeLine) < 0) return -1;
  return fit(T, tl, overFair, c => { const s = ahShares(T, c, homeLine, 'home'); return ahHomeFair - fairOf(s.A, s.B); });
}
// Cell from 1X2 probabilities + goal line.
function cellFrom1x2(T, pH, pA, tl, overFair) {
  return fit(T, tl, overFair, c => (T.x12[c * 3] - T.x12[c * 3 + 2]) - (pH - pA));
}

module.exports = { AH_LINES, TL_LINES, idx, ret, buildTable, fairOf, ahShares, ouShares, cellFromAH, cellFrom1x2 };
