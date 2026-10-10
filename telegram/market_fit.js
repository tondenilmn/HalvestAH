'use strict';
/**
 * Prices → expected goals (added 2026-10-10). Turns a book's AH (line + home/away
 * prices) and goal line (line + over/under prices) into the same two numbers —
 * expected total goals μ and supremacy s (home − away) — with fair_model.js's
 * scoreline model (proportional de-vig, Dixon-Coles), so books on different
 * lines can be compared, averaged or regressed. A lookup table over (μ, s)
 * (built once, ~3 s) makes each fit fast. Used by research_books.js (history)
 * and openwatch.js (live).
 */
const FM = require('./fair_model.js');

// ── (μ, s) lookup table of win-equivalent probabilities (1 / fair odds) ──
const MU0 = 0.3, MU1 = 6.5, DMU = 0.05, S0 = -4.5, S1 = 4.5, DS = 0.05;
const NMU = Math.round((MU1 - MU0) / DMU) + 1, NS = Math.round((S1 - S0) / DS) + 1;
const AH_LINES = []; for (let x = -4.5; x <= 4.5001; x += 0.25) AH_LINES.push(+x.toFixed(2));
const TL_LINES = []; for (let x = 0.5; x <= 6.5001; x += 0.25) TL_LINES.push(+x.toFixed(2));
const ahIdx = l => Math.round((l + 4.5) * 4), tlIdx = l => Math.round((l - 0.5) * 4);
const lam = (mu, s) => [Math.max((mu + s) / 2, 0.02), Math.max((mu - s) / 2, 0.02)];
const TAB_AH = new Float32Array(NMU * NS * AH_LINES.length), TAB_OU = new Float32Array(NMU * NS * TL_LINES.length);
let _built = false;
function buildTables() {
  if (_built) return; _built = true;
  for (let i = 0; i < NMU; i++) for (let j = 0; j < NS; j++) {
    const [lh, la] = lam(MU0 + i * DMU, S0 + j * DS), P = FM.scoreGrid(lh, la);
    const b = i * NS + j;
    AH_LINES.forEach((l, k) => { TAB_AH[b * AH_LINES.length + k] = 1 / FM.fairOddsFromDist(FM.ahDist(P, l, 'home')); });
    TL_LINES.forEach((l, k) => { TAB_OU[b * TL_LINES.length + k] = 1 / FM.fairOddsFromDist(FM.ouDist(P, l, 'over')); });
  }
}
function interp(tab, nl, k, mu, s) {
  const x = Math.min(Math.max((mu - MU0) / DMU, 0), NMU - 1.001), y = Math.min(Math.max((s - S0) / DS, 0), NS - 1.001);
  const i = Math.floor(x), j = Math.floor(y), fx = x - i, fy = y - j;
  const g = (a, b) => tab[(a * NS + b) * nl + k];
  return g(i, j) * (1 - fx) * (1 - fy) + g(i + 1, j) * fx * (1 - fy) + g(i, j + 1) * (1 - fx) * fy + g(i + 1, j + 1) * fx * fy;
}
const pAH = (mu, s, l) => interp(TAB_AH, AH_LINES.length, ahIdx(l), mu, s);
const pOU = (mu, s, l) => interp(TAB_OU, TL_LINES.length, tlIdx(l), mu, s);
const bis = (lo, hi, f) => { for (let i = 0; i < 40; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; } return (lo + hi) / 2; };
// AH home line + de-vigged home win-equivalent prob, goal line + over prob → (μ, s).
function fit(ahLine, pHome, tl, pOver) {
  buildTables();
  let mu = 2.6, s = 0;
  for (let it = 0; it < 6; it++) {
    mu = bis(MU0, MU1, m => pOU(m, s, tl) - pOver);           // p(over) rises with μ
    s = bis(S0, S1, x => pAH(mu, x, ahLine) - pHome);          // p(home covers) rises with s
  }
  return { mu, s };
}
// {ah, ho, ao, tl, ov, un} (AH home line + prices, goal line + prices) → { mu, s, margins } or null.
function fitPrices({ ah, ho, ao, tl, ov, un }) {
  if ([ah, ho, ao, tl, ov, un].some(v => v == null || !isFinite(v)) || ho <= 1 || ao <= 1 || ov <= 1 || un <= 1) return null;
  if (Math.abs(ah) > 4.5 || tl < 0.5 || tl > 6.5 || Math.abs(ah * 4 - Math.round(ah * 4)) > 1e-6 || Math.abs(tl * 4 - Math.round(tl * 4)) > 1e-6) return null;
  const a = FM.devig([ho, ao]), t = FM.devig([ov, un]);
  return { ...fit(ah, a.probs[0], tl, t.probs[0]), mAH: a.margin, mOU: t.margin };
}

// Return of 1 unit at price o on a handicap-style bet (value + line > 0 wins; quarter lines split).
function ret(value, line, o) {
  let r = 0; const parts = FM.splitLine(line);
  for (const ln of parts) { const v = value + ln; r += v > 0 ? o : v < 0 ? 0 : 1; }
  return r / parts.length;
}
// Expected return of that bet under (μ, s).
function evOf(mu, s, kind, side, line, o) {
  const [lh, la] = lam(mu, s), P = FM.scoreGrid(lh, la);
  const d = kind === 'AH' ? FM.ahDist(P, line, side) : FM.ouDist(P, line, side);
  return d.w * o + d.hw * (1 + o) / 2 + d.p + d.hl * 0.5;
}

module.exports = { fit, fitPrices, evOf, ret, lam, buildTables };
