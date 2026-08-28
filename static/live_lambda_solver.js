// static/live_lambda_solver.js
//
// Live-usable, AH+O/U-only implied-lambda solver. Single canonical copy
// (same pattern as static/live_model.js): required from telegram/notify.js
// via `../static/live_lambda_solver.js`, and served to the browser directly
// as a <script> tag by static/index.html — do not duplicate this file.
//
// Context (see MEMORY / LIVE_BETTING_PLAN.md Part E): `telegram/research/
// implied_lambda.js` (E1) fits a per-match Dixon-Coles bivariate Poisson
// (lambda_h, lambda_a, rho) from de-vigged CLOSING 1X2 + Over/Under (4
// constraints, 3 unknowns). That solver is NOT usable in production because
// `telegram/livescore.js` (the live Bet365 feed `notify.js` actually reads)
// has NO 1X2 market at all — only Asian Handicap (ah line + home/away AH
// odds) and Over/Under on the Total Line. See CLAUDE.md "The Livescore
// Function" for the confirmed field list.
//
// This module solves the SAME kind of bivariate-Poisson fit but from only
// the 2 constraints the live feed actually has:
//   1. AH-cover probability at the real AH line (de-vigged from ho_c/ao_c)
//   2. Over probability at the real Total Line (de-vigged from ov_c/un_c)
// That's 2 equations, 3 unknowns (lambda_h, lambda_a, rho) — underdetermined
// — so rho is FIXED at a tier-specific constant, precomputed as the mean rho
// from E1's already-fitted historical data (rows with fit_residual <= 1e-4
// in telegram/research/reports/implied_lambda_2026-08-28.jsonl):
//   TOP -0.111, MAJOR -0.110, OTHER -0.071, fallback (tier unknown) -0.078.
// With rho fixed, (lambda_h, lambda_a) is exactly determined by the 2
// remaining equations and solved via 2D Newton with a numerical Jacobian,
// falling back to a coordinate-descent grid-refine if Newton fails to
// converge or produces a non-finite/out-of-bounds result.
//
// The de-vig (power method), Dixon-Coles tau correction, and AH/Totals
// settlement-probability math (including quarter-line halving) are ported
// verbatim from telegram/research/implied_lambda.js — do not reinvent them,
// keep in sync if that file's math changes.

'use strict';

// ── Dual usage (browser + Node), same UMD pattern as static/live_model.js —
// `require('./live_lambda_solver.js')` in Node, `<script>` -> window.LiveLambdaSolver
// in the browser. Pure math, no Node built-ins, so this wrapper is the only
// thing needed to make it portable.
(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LiveLambdaSolver = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

// ── tier-specific rho constants (see header + LIVE_BETTING_PLAN task notes)
const RHO_BY_TIER = { TOP: -0.111, MAJOR: -0.110, OTHER: -0.071 };
const RHO_FALLBACK = -0.078;

function rhoForTier(tier) {
  if (tier && Object.prototype.hasOwnProperty.call(RHO_BY_TIER, tier)) return RHO_BY_TIER[tier];
  return RHO_FALLBACK;
}

// ── numeric helpers ────────────────────────────────────────────────────────
function sf(v) {
  const f = parseFloat(String(v == null ? '' : v).trim());
  return Number.isFinite(f) ? f : null;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

// ── power-method de-vig (verbatim port of implied_lambda.js's
// solveDevigPower) — given raw implied probabilities r_i = 1/odds_i
// (sum > 1, the overround), solve for k such that sum(r_i^(1/k)) = 1, then
// de-vigged p_i = r_i^(1/k).
function solveDevigPower(rawProbs) {
  const f = (k) => {
    let s = 0;
    for (const r of rawProbs) s += Math.pow(r, 1 / k);
    return s - 1;
  };
  let lo = 0.05, hi = 8;
  let flo = f(lo), fhi = f(hi);
  let guard = 0;
  while (flo > 0 && lo > 1e-8 && guard++ < 60) { lo /= 2; flo = f(lo); }
  guard = 0;
  while (fhi < 0 && hi < 1e8 && guard++ < 60) { hi *= 2; fhi = f(hi); }
  if (!(flo <= 0 && fhi >= 0)) {
    const s = rawProbs.reduce((a, b) => a + b, 0);
    return { k: null, probs: rawProbs.map((r) => r / s), degenerate: true };
  }
  let mid = (lo + hi) / 2;
  for (let i = 0; i < 100; i++) {
    mid = (lo + hi) / 2;
    const fm = f(mid);
    if (Math.abs(fm) < 1e-10 || hi - lo < 1e-10) break;
    if (fm < 0) lo = mid; else hi = mid;
  }
  const k = mid;
  return { k, probs: rawProbs.map((r) => Math.pow(r, 1 / k)), degenerate: false };
}

// ── Dixon-Coles bivariate Poisson (verbatim port) ─────────────────────────
const MAX_GOALS = 10;

function poissonPmfArray(lambda, maxN) {
  const arr = new Array(maxN + 1);
  arr[0] = Math.exp(-lambda);
  for (let k = 1; k <= maxN; k++) arr[k] = (arr[k - 1] * lambda) / k;
  return arr;
}

function tauCorrect(P, lh, la, rho) {
  P[0][0] *= 1 - lh * la * rho;
  P[1][0] *= 1 + la * rho;
  P[0][1] *= 1 + lh * rho;
  P[1][1] *= 1 - rho;
}

function buildJoint(lh, la, rho, maxN = MAX_GOALS) {
  const ph = poissonPmfArray(lh, maxN);
  const pa = poissonPmfArray(la, maxN);
  const P = new Array(maxN + 1);
  for (let i = 0; i <= maxN; i++) {
    const row = new Array(maxN + 1);
    for (let j = 0; j <= maxN; j++) row[j] = ph[i] * pa[j];
    P[i] = row;
  }
  tauCorrect(P, lh, la, rho);
  return P;
}

function subOverProb(P, x) {
  let over = 0;
  const n = P.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i + j > x) over += P[i][j];
    }
  }
  return over;
}

function isQuarterLine(line) {
  return Math.abs(Math.abs(line * 4) % 2) > 1e-6;
}
function totalOverProb(P, tl) {
  if (isQuarterLine(tl)) {
    return (subOverProb(P, tl - 0.25) + subOverProb(P, tl + 0.25)) / 2;
  }
  return subOverProb(P, tl);
}

function subCoverProb(P, marginFn, line) {
  let cover = 0;
  const n = P.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const adj = marginFn(i, j) + line;
      if (adj > 1e-9) cover += P[i][j];
    }
  }
  return cover;
}
function ahCoverProb(P, isHome, line) {
  const marginFn = isHome ? (i, j) => i - j : (i, j) => j - i;
  if (isQuarterLine(line)) {
    return (subCoverProb(P, marginFn, line - 0.25) + subCoverProb(P, marginFn, line + 0.25)) / 2;
  }
  return subCoverProb(P, marginFn, line);
}

// ── 2D solve for (lambda_h, lambda_a) given fixed rho ─────────────────────
const BOUNDS = { lam: [0.1, 6] };

// residual(lh, la) = [homeCover(lh,la) - targetCover, over(lh,la) - targetOver]
function residual(lh, la, rho, ahLine, tl, targetCover, targetOver) {
  const P = buildJoint(lh, la, rho);
  const cover = ahCoverProb(P, true, ahLine);
  const over = totalOverProb(P, tl);
  return [cover - targetCover, over - targetOver];
}

function norm2(v) { return Math.sqrt(v[0] * v[0] + v[1] * v[1]); }

// 2D Newton with numerical (central-difference) Jacobian, damped + bound-
// clamped step. Falls back to coordinate-descent grid-refine on failure.
function newton2D(rho, ahLine, tl, targetCover, targetOver, x0) {
  const EPS = 1e-4;
  let [lh, la] = x0;
  const [loB, hiB] = BOUNDS.lam;
  let best = { lh, la, res: residual(lh, la, rho, ahLine, tl, targetCover, targetOver) };
  let bestNorm = norm2(best.res);

  for (let iter = 0; iter < 60; iter++) {
    const r0 = residual(lh, la, rho, ahLine, tl, targetCover, targetOver);
    const n0 = norm2(r0);
    if (n0 < bestNorm) { best = { lh, la, res: r0 }; bestNorm = n0; }
    if (n0 < 1e-7) break;

    // Numerical Jacobian
    const hLh = Math.max(1e-5, Math.abs(lh) * EPS);
    const hLa = Math.max(1e-5, Math.abs(la) * EPS);
    const rLhPlus = residual(lh + hLh, la, rho, ahLine, tl, targetCover, targetOver);
    const rLaPlus = residual(lh, la + hLa, rho, ahLine, tl, targetCover, targetOver);
    const J11 = (rLhPlus[0] - r0[0]) / hLh, J12 = (rLaPlus[0] - r0[0]) / hLa;
    const J21 = (rLhPlus[1] - r0[1]) / hLh, J22 = (rLaPlus[1] - r0[1]) / hLa;

    const det = J11 * J22 - J12 * J21;
    if (!Number.isFinite(det) || Math.abs(det) < 1e-10) break; // singular — bail to fallback

    // Solve J * delta = -r0
    const dLh = (-r0[0] * J22 + r0[1] * J12) / det;
    const dLa = (-r0[1] * J11 + r0[0] * J21) / det;
    if (!Number.isFinite(dLh) || !Number.isFinite(dLa)) break;

    // Damped line search along Newton direction
    let damping = 1;
    let accepted = false;
    for (let ls = 0; ls < 8; ls++) {
      const cand_lh = clamp(lh + damping * dLh, loB, hiB);
      const cand_la = clamp(la + damping * dLa, loB, hiB);
      const rc = residual(cand_lh, cand_la, rho, ahLine, tl, targetCover, targetOver);
      const nc = norm2(rc);
      if (nc < n0 || nc < bestNorm) {
        lh = cand_lh; la = cand_la;
        if (nc < bestNorm) { best = { lh, la, res: rc }; bestNorm = nc; }
        accepted = true;
        break;
      }
      damping /= 2;
    }
    if (!accepted) break; // stuck — bail to fallback / return best-so-far
  }

  return { lh: best.lh, la: best.la, residualNorm: bestNorm, res: best.res };
}

// Coordinate-descent / multi-resolution grid-refine fallback — robust but
// slower; only used when Newton fails to converge well.
function gridRefine(rho, ahLine, tl, targetCover, targetOver, x0) {
  const [loB, hiB] = BOUNDS.lam;
  let centerLh = clamp(x0[0], loB, hiB);
  let centerLa = clamp(x0[1], loB, hiB);
  let span = (hiB - loB) / 2;
  let best = { lh: centerLh, la: centerLa, res: residual(centerLh, centerLa, rho, ahLine, tl, targetCover, targetOver) };
  let bestNorm = norm2(best.res);

  for (let level = 0; level < 8; level++) {
    const steps = 12;
    for (let i = 0; i <= steps; i++) {
      const lh = clamp(centerLh - span + (2 * span * i) / steps, loB, hiB);
      for (let j = 0; j <= steps; j++) {
        const la = clamp(centerLa - span + (2 * span * j) / steps, loB, hiB);
        const res = residual(lh, la, rho, ahLine, tl, targetCover, targetOver);
        const n = norm2(res);
        if (n < bestNorm) { bestNorm = n; best = { lh, la, res }; }
      }
    }
    centerLh = best.lh; centerLa = best.la;
    span /= 4;
    if (bestNorm < 1e-7) break;
  }
  return { lh: best.lh, la: best.la, residualNorm: bestNorm, res: best.res };
}

// ── public: raw-probability solve (rho fixed, targets already de-vigged) ──
function solve2D(rho, ahLine, tl, targetCover, targetOver, x0 = [1.35, 1.35]) {
  const nt = newton2D(rho, ahLine, tl, targetCover, targetOver, x0);
  // Convergence tolerance: reproduce inputs within ~0.5pp (0.005) per the
  // task's acceptance bar. If Newton didn't get there, or wandered to a
  // degenerate/out-of-bounds point, fall back to grid-refine.
  if (nt.residualNorm <= 7e-3 && Number.isFinite(nt.lh) && Number.isFinite(nt.la)) {
    return { lambda_h: nt.lh, lambda_a: nt.la, residualNorm: nt.residualNorm, method: 'newton' };
  }
  const gr = gridRefine(rho, ahLine, tl, targetCover, targetOver, x0);
  // Prefer whichever is better if Newton got partway there.
  const finalRes = gr.residualNorm <= nt.residualNorm ? gr : nt;
  return {
    lambda_h: finalRes.lh, lambda_a: finalRes.la, residualNorm: finalRes.residualNorm,
    method: gr.residualNorm <= nt.residualNorm ? 'grid-refine' : 'newton-partial',
  };
}

// ── public: full solve from raw odds ───────────────────────────────────────
// opts: { ahLine, ahHomeOdds, ahAwayOdds, tl, overOdds, underOdds, tier }
// Returns { ok, lambda_h, lambda_a, rho, residualNorm, method, error? }
function solveLambdaFromOdds(opts) {
  const ahLine = sf(opts.ahLine);
  const ahHomeOdds = sf(opts.ahHomeOdds);
  const ahAwayOdds = sf(opts.ahAwayOdds);
  const tl = sf(opts.tl);
  const overOdds = sf(opts.overOdds);
  const underOdds = sf(opts.underOdds);
  const tier = opts.tier;

  if (ahLine == null || tl == null) {
    return { ok: false, error: 'missing ahLine/tl' };
  }
  if (!(ahHomeOdds > 1) || !(ahAwayOdds > 1)) {
    return { ok: false, error: 'missing/invalid AH odds' };
  }
  if (!(overOdds > 1) || !(underOdds > 1)) {
    return { ok: false, error: 'missing/invalid O/U odds' };
  }

  const rho = rhoForTier(tier);

  const ahDv = solveDevigPower([1 / ahHomeOdds, 1 / ahAwayOdds]);
  const ouDv = solveDevigPower([1 / overOdds, 1 / underOdds]);
  const targetCover = ahDv.probs[0]; // home-side AH cover, de-vigged
  const targetOver = ouDv.probs[0];  // over, de-vigged

  let result;
  try {
    result = solve2D(rho, ahLine, tl, targetCover, targetOver, [1.35, 1.35]);
  } catch (e) {
    return { ok: false, error: `solve threw: ${e.message}` };
  }

  if (!Number.isFinite(result.lambda_h) || !Number.isFinite(result.lambda_a) ||
      !(result.lambda_h > 0) || !(result.lambda_a > 0)) {
    return { ok: false, error: 'non-finite/non-positive lambda result' };
  }

  return {
    ok: true,
    lambda_h: result.lambda_h,
    lambda_a: result.lambda_a,
    rho,
    residualNorm: result.residualNorm,
    method: result.method,
    converged: result.residualNorm <= 0.01, // ~1pp combined residual norm
    targetCover, targetOver,
  };
}

return {
  rhoForTier,
  RHO_BY_TIER,
  RHO_FALLBACK,
  solveDevigPower,
  buildJoint,
  totalOverProb,
  ahCoverProb,
  isQuarterLine,
  solve2D,
  solveLambdaFromOdds,
};
}));
