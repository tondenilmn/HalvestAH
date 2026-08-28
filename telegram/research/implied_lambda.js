// telegram/research/implied_lambda.js
//
// Part E1 of LIVE_BETTING_PLAN.md — de-vig every Bet365 row's 1X2 and O/U
// markets with the POWER method (corrects for favourite-longshot bias, which
// bias_scan.js already confirmed is real and strong in this dataset), then
// solve for a per-match Dixon-Coles bivariate Poisson (lambda_home,
// lambda_away, rho) whose implied P(home)/P(draw)/P(away)/P(over TL)
// reproduce the de-vigged market probabilities. The AH price is then used as
// an independent 5th observation (never fit against) to sanity-check the
// whole pipeline.
//
// Run: node telegram/research/implied_lambda.js
//
// Exploratory/research script — correctness of the math is the priority,
// class hierarchy is not. Follows the CSV-loading + league-tier conventions
// of telegram/research/bias_scan.js (same repo, same dataset).

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const { classifyLeague } = require('../engine.js');

const DATA_DIR = path.resolve(__dirname, '../../static/data/Bet365');
const REPORT_DIR = path.resolve(__dirname, 'reports');
const TIERS = ['TOP', 'MAJOR', 'OTHER'];

// Cap on full-run wall-clock: if the full dataset looks like it will blow
// this budget (estimated from a timed sample before the real run), fall back
// to a stratified sample spread across date range + tier, per the task's
// explicit fallback instruction.
const MAX_ROWS_BEFORE_SAMPLING = 240000; // effectively "try the full run first"
const SAMPLE_TARGET = 35000;

// ── numeric helpers ────────────────────────────────────────────────────────
function sf(v) {
  const f = parseFloat(String(v == null ? '' : v).trim());
  return Number.isFinite(f) ? f : null;
}

// ── Step 1: power-method de-vig ────────────────────────────────────────────
// Given raw implied probabilities r_i = 1/odds_i (sum > 1, the overround),
// solve for k such that sum(r_i ^ (1/k)) = 1, then de-vigged p_i = r_i ^ (1/k).
// f(k) = sum(r_i^(1/k)) is strictly increasing in k for r_i in (0,1) (since
// d/dk[x^(1/k)] = x^(1/k) * (-ln(x)/k^2) > 0 when ln(x) < 0), so this is a
// well-behaved monotonic 1D root-find — bisection with an auto-widened
// bracket (typical solved k is a bit below 1 for realistic overrounds, but
// we don't hard-assume that).
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
    // Degenerate (shouldn't happen with valid odds >1) — fall back to
    // proportional normalisation rather than crash a whole row.
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

// ── Dixon-Coles bivariate Poisson ──────────────────────────────────────────
const MAX_GOALS = 10; // Poisson tail beyond this is negligible for lambda <= 6

function poissonPmfArray(lambda, maxN) {
  const arr = new Array(maxN + 1);
  arr[0] = Math.exp(-lambda);
  for (let k = 1; k <= maxN; k++) arr[k] = (arr[k - 1] * lambda) / k;
  return arr;
}

// Standard Dixon & Coles (1997) low-score correction tau(i,j).
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

// P(home win), P(draw), P(away win) from the joint matrix.
function resultProbs(P) {
  let pHome = 0, pDraw = 0, pAway = 0;
  const n = P.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const p = P[i][j];
      if (i > j) pHome += p; else if (i === j) pDraw += p; else pAway += p;
    }
  }
  return { pHome, pDraw, pAway };
}

// P(total goals > x), x may be a half-integer (.5, clean) or a whole integer
// (push possible at total===x; excluded from both over/under mass here, the
// same simplification implicit in de-vigging a 2-way over/under price with
// no explicit push leg — noted, not hidden).
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

// Quarter-line handling identical in spirit to bias_scan.js's lineReturn:
// a quarter line (e.g. 2.25) settles as the average of the two adjacent
// clean sub-lines (2.0 and 2.5) — applied here to probabilities rather than
// returns, per LIVE_BETTING_PLAN.md's explicit instruction to reuse/adapt
// that logic.
function isQuarterLine(line) {
  return Math.abs(Math.abs(line * 4) % 2) > 1e-6;
}
function totalOverProb(P, tl) {
  if (isQuarterLine(tl)) {
    return (subOverProb(P, tl - 0.25) + subOverProb(P, tl + 0.25)) / 2;
  }
  return subOverProb(P, tl);
}

// AH cover probability for a given side, mirroring the same quarter-line
// halving. `margin` = backedSideGoals - oppGoals as a function of (i,j) is
// supplied via `signIsHome` (true => margin = i-j, false => margin = j-i).
// `line` is that side's own signed AH line (e.g. home favourite => negative).
function subCoverProb(P, marginFn, line) {
  let cover = 0;
  const n = P.length;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      const adj = marginFn(i, j) + line;
      if (adj > 1e-9) cover += P[i][j];
      // push (adj ~ 0) and loss both excluded from "cover" mass, same
      // simplification as totalOverProb above.
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

// ── Step 2: fit (lambda_h, lambda_a, rho) via Nelder-Mead ──────────────────
// Targets: [pHome, pDraw, pAway, pOver] from de-vigged market probs.
// Minimise sum of squared errors. Gradient-free, 3 params, cheap objective.
const BOUNDS = { lam: [0.1, 6], rho: [-0.3, 0.3] };

function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function objective(params, targets, tl) {
  const lh = clamp(params[0], BOUNDS.lam[0], BOUNDS.lam[1]);
  const la = clamp(params[1], BOUNDS.lam[0], BOUNDS.lam[1]);
  const rho = clamp(params[2], BOUNDS.rho[0], BOUNDS.rho[1]);
  const P = buildJoint(lh, la, rho);
  const { pHome, pDraw, pAway } = resultProbs(P);
  const pOver = totalOverProb(P, tl);
  const dH = pHome - targets[0];
  const dD = pDraw - targets[1];
  const dA = pAway - targets[2];
  const dO = pOver - targets[3];
  // small penalty pushing params back inside bounds if the raw (unclamped)
  // values wandered out, so the simplex doesn't get "stuck" flat outside range
  const rawLh = params[0], rawLa = params[1], rawRho = params[2];
  let penalty = 0;
  if (rawLh < BOUNDS.lam[0] || rawLh > BOUNDS.lam[1]) penalty += (rawLh - lh) ** 2;
  if (rawLa < BOUNDS.lam[0] || rawLa > BOUNDS.lam[1]) penalty += (rawLa - la) ** 2;
  if (rawRho < BOUNDS.rho[0] || rawRho > BOUNDS.rho[1]) penalty += (rawRho - rho) ** 2;
  return dH * dH + dD * dD + dA * dA + dO * dO + penalty;
}

// Compact, generic Nelder-Mead for n=3.
function nelderMead(fn, x0, opts = {}) {
  const n = x0.length;
  const alpha = 1, gamma = 2, rho_ = 0.5, sigma = 0.5;
  const step = opts.step || 0.3;
  const maxIter = opts.maxIter || 120;
  const tol = opts.tol || 1e-9;

  let simplex = [x0.slice()];
  for (let i = 0; i < n; i++) {
    const p = x0.slice();
    p[i] += p[i] !== 0 ? step * Math.abs(p[i]) : step;
    simplex.push(p);
  }
  let fvals = simplex.map(fn);

  for (let iter = 0; iter < maxIter; iter++) {
    // sort by fval asc
    const idx = fvals.map((f, i) => i).sort((a, b) => fvals[a] - fvals[b]);
    simplex = idx.map((i) => simplex[i]);
    fvals = idx.map((i) => fvals[i]);

    if (fvals[n] - fvals[0] < tol) break;

    // centroid of all but worst
    const centroid = new Array(n).fill(0);
    for (let i = 0; i < n; i++) {
      for (let d = 0; d < n; d++) centroid[d] += simplex[i][d] / n;
    }

    const worst = simplex[n];
    const reflected = centroid.map((c, d) => c + alpha * (c - worst[d]));
    const fRef = fn(reflected);

    if (fRef < fvals[0]) {
      const expanded = centroid.map((c, d) => c + gamma * (reflected[d] - c));
      const fExp = fn(expanded);
      if (fExp < fRef) { simplex[n] = expanded; fvals[n] = fExp; }
      else { simplex[n] = reflected; fvals[n] = fRef; }
    } else if (fRef < fvals[n - 1]) {
      simplex[n] = reflected; fvals[n] = fRef;
    } else {
      const contracted = centroid.map((c, d) => c + rho_ * (worst[d] - c));
      const fCon = fn(contracted);
      if (fCon < fvals[n]) { simplex[n] = contracted; fvals[n] = fCon; }
      else {
        // shrink
        for (let i = 1; i <= n; i++) {
          simplex[i] = simplex[i].map((v, d) => simplex[0][d] + sigma * (v - simplex[0][d]));
          fvals[i] = fn(simplex[i]);
        }
      }
    }
  }

  const idx = fvals.map((f, i) => i).sort((a, b) => fvals[a] - fvals[b]);
  return { x: simplex[idx[0]], fval: fvals[idx[0]] };
}

function fitMatch(targets, tl, x0) {
  const fn = (p) => objective(p, targets, tl);
  const { x, fval } = nelderMead(fn, x0, { step: 0.3, maxIter: 150 });
  return {
    lh: clamp(x[0], BOUNDS.lam[0], BOUNDS.lam[1]),
    la: clamp(x[1], BOUNDS.lam[0], BOUNDS.lam[1]),
    rho: clamp(x[2], BOUNDS.rho[0], BOUNDS.rho[1]),
    fval,
  };
}

// ── load rows ───────────────────────────────────────────────────────────
function loadRows() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.toLowerCase().endsWith('.csv'));
  const rows = [];
  const skipped = { badDate: 0, badFtResult: 0, badAh: 0, badTotals: 0, bad1x2: 0, total: 0, missingAny: 0 };

  for (const f of files) {
    const csv = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
    const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true });
    for (const r of data) {
      skipped.total++;
      const dateStr = (r['Date'] || '').trim();
      const d = dateStr ? new Date(dateStr + 'T00:00:00Z') : null;
      if (!d || isNaN(d.getTime())) { skipped.badDate++; continue; }

      const ftRaw = (r['FT Result'] || '').trim();
      const m = /^(\d+)\s*-\s*(\d+)$/.exec(ftRaw);
      if (!m) { skipped.badFtResult++; continue; }
      const homeG = parseInt(m[1], 10), awayG = parseInt(m[2], 10);

      const league = r['League'] || '';
      const tier = classifyLeague(league);

      const ahHc = sf(r['Home AH Closing']), ahHo = sf(r['Home AH Opening']);
      const ahAc = sf(r['Away AH Closing']), ahAo = sf(r['Away AH Opening']);
      const hoC = sf(r['Home Odds Closing']), hoO = sf(r['Home Odds Opening']);
      const aoC = sf(r['Away Odds Closing']), aoO = sf(r['Away Odds Opening']);
      const ahOk = [ahHc, ahHo, ahAc, ahAo, hoC, hoO, aoC, aoO].every((v) => v != null) &&
        hoC > 1 && hoO > 1 && aoC > 1 && aoO > 1;
      if (!ahOk) skipped.badAh++;

      const tlC = sf(r['Total Line Closing']), tlO = sf(r['Total Line Opening']);
      const ovC = sf(r['Over Odds Closing']), ovO = sf(r['Over Odds Opening']);
      const unC = sf(r['Under Odds Closing']), unO = sf(r['Under Odds Opening']);
      const totOk = [tlC, tlO, ovC, ovO, unC, unO].every((v) => v != null) &&
        ovC > 1 && ovO > 1 && unC > 1 && unO > 1;
      if (!totOk) skipped.badTotals++;

      const x1hc = sf(r['1X2 Home Closing']), x1dc = sf(r['1X2 Draw Closing']), x1ac = sf(r['1X2 Away Closing']);
      const x1ho = sf(r['1X2 Home Opening']), x1do = sf(r['1X2 Draw Opening']), x1ao = sf(r['1X2 Away Opening']);
      const x1Ok = [x1hc, x1dc, x1ac, x1ho, x1do, x1ao].every((v) => v != null) &&
        x1hc > 1 && x1dc > 1 && x1ac > 1 && x1ho > 1 && x1do > 1 && x1ao > 1;
      if (!x1Ok) skipped.bad1x2++;

      // E1 needs 1X2 + O/U + AH all present and valid (closing AND opening)
      // to run steps 1-3 in full — a row missing any of them can't produce a
      // usable record, so it's dropped rather than half-filled.
      if (!(ahOk && totOk && x1Ok)) { skipped.missingAny++; continue; }

      rows.push({
        date: d, dateStr, tier, league,
        home: r['Home Team'] || '', away: r['Away Team'] || '',
        homeG, awayG,
        ahHc, ahHo, ahAc, ahAo, hoC, hoO, aoC, aoO,
        tlC, tlO, ovC, ovO, unC, unO,
        x1hc, x1dc, x1ac, x1ho, x1do, x1ao,
      });
    }
  }

  rows.sort((a, b) => a.date - b.date);
  return { rows, skipped };
}

// ── stratified sample (spread across date range + tier) ───────────────────
function stratifiedSample(rows, target) {
  const byTier = { TOP: [], MAJOR: [], OTHER: [] };
  for (const r of rows) (byTier[r.tier] || byTier.OTHER).push(r);
  const totalN = rows.length;
  const out = [];
  for (const t of TIERS) {
    const pool = byTier[t];
    const want = Math.round((pool.length / totalN) * target);
    // even stride across chronological order within the tier => spread across
    // the whole date range, not just a random cluster
    const stride = Math.max(1, Math.floor(pool.length / Math.max(1, want)));
    for (let i = 0; i < pool.length; i += stride) out.push(pool[i]);
  }
  out.sort((a, b) => a.date - b.date);
  return out;
}

// ── main per-row processing ────────────────────────────────────────────────
function processRow(r) {
  // Step 1: de-vig 1X2 and O/U, closing and opening.
  const x1cRaw = [1 / r.x1hc, 1 / r.x1dc, 1 / r.x1ac];
  const x1oRaw = [1 / r.x1ho, 1 / r.x1do, 1 / r.x1ao];
  const ouCRaw = [1 / r.ovC, 1 / r.unC];
  const ouORaw = [1 / r.ovO, 1 / r.unO];

  const x1cDv = solveDevigPower(x1cRaw);
  const x1oDv = solveDevigPower(x1oRaw);
  const ouCDv = solveDevigPower(ouCRaw);
  const ouODv = solveDevigPower(ouORaw);

  // Step 2: fit closing (lh, la, rho) against de-vigged closing 1X2 + O/U.
  const targetsC = [x1cDv.probs[0], x1cDv.probs[1], x1cDv.probs[2], ouCDv.probs[0]];
  const fitC = fitMatch(targetsC, r.tlC, [1.35, 1.35, -0.1]);

  // Opening fit, seeded from the closing solution's neighbourhood-agnostic
  // default (opening and closing can differ a lot after 24h+ of drift).
  const targetsO = [x1oDv.probs[0], x1oDv.probs[1], x1oDv.probs[2], ouODv.probs[0]];
  const fitO = fitMatch(targetsO, r.tlO, [1.35, 1.35, -0.1]);

  // Step 3: AH check (never fit) — using the CLOSING fit against the closing
  // AH price, the same odds vintage. favourite/level-ball convention mirrors
  // CLAUDE.md's "Level Ball (0.00 Line)" + bias_scan.js's favIsHome rule.
  const favIsHome = r.ahHc < 0 || (Math.abs(r.ahHc) < 1e-9 && r.hoC <= r.aoC);
  const homeLine = r.ahHc, awayLine = r.ahAc;
  const ahRaw = [1 / r.hoC, 1 / r.aoC];
  const ahDv = solveDevigPower(ahRaw);
  const P = buildJoint(fitC.lh, fitC.la, fitC.rho);
  const modelHomeCover = ahCoverProb(P, true, homeLine);
  const modelAwayCover = ahCoverProb(P, false, awayLine);
  const modelFavCover = favIsHome ? modelHomeCover : modelAwayCover;
  const mktFavCover = favIsHome ? ahDv.probs[0] : ahDv.probs[1];
  const ahDiscrepancy = modelFavCover - mktFavCover;

  // Reproduction-accuracy check (acceptance criterion a): recompute
  // 1X2/O/U from the fitted closing params and compare to the de-vigged
  // closing inputs (the fit target).
  const { pHome, pDraw, pAway } = resultProbs(P);
  const pOver = totalOverProb(P, r.tlC);
  const errHome = Math.abs(pHome - targetsC[0]);
  const errDraw = Math.abs(pDraw - targetsC[1]);
  const errAway = Math.abs(pAway - targetsC[2]);
  const errOver = Math.abs(pOver - targetsC[3]);
  const err1x2Max = Math.max(errHome, errDraw, errAway);

  return {
    date: r.dateStr, league: r.league, tier: r.tier, home: r.home, away: r.away,
    lambda_h: fitC.lh, lambda_a: fitC.la, rho: fitC.rho,
    lambda_h0: fitO.lh, lambda_a0: fitO.la, rho0: fitO.rho,
    ft_home_goals: r.homeG, ft_away_goals: r.awayG,
    ah_discrepancy: ahDiscrepancy,
    fit_residual: fitC.fval,
    fit_residual_opening: fitO.fval,
    // pass-through raw columns for E2's later regression
    ah_home_closing: r.ahHc, ah_home_opening: r.ahHo,
    ah_away_closing: r.ahAc, ah_away_opening: r.ahAo,
    home_odds_closing: r.hoC, home_odds_opening: r.hoO,
    away_odds_closing: r.aoC, away_odds_opening: r.aoO,
    tl_closing: r.tlC, tl_opening: r.tlO,
    over_odds_closing: r.ovC, over_odds_opening: r.ovO,
    under_odds_closing: r.unC, under_odds_opening: r.unO,
    // diagnostics for acceptance-criteria reporting (not needed downstream,
    // cheap to keep alongside the rest)
    _repro: { errHome, errDraw, errAway, err1x2Max, errOver, favIsHome, pHomeWinModel: pHome },
    _devigK: { x1c: x1cDv.k, x1o: x1oDv.k, ouc: ouCDv.k, ouo: ouODv.k, ah: ahDv.k },
  };
}

// ── summary / acceptance-criteria report ───────────────────────────────────
function pct1(x) { return x == null || !Number.isFinite(x) ? 'n/a' : (x * 100).toFixed(2) + '%'; }

// Plain loop, not Math.max(...arr) — spreading a 240k-element array as call
// arguments blows V8's call stack (confirmed the hard way on the full run).
function arrMax(arr) {
  let m = -Infinity;
  for (const v of arr) if (v > m) m = v;
  return m;
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function std(arr) {
  if (arr.length < 2) return null;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1));
}

function buildSummary(results) {
  const n = results.length;

  // (a) reproduction accuracy
  const err1x2 = results.map((r) => r._repro.err1x2Max);
  const errOver = results.map((r) => r._repro.errOver);
  const within1x2 = err1x2.filter((e) => e <= 0.003).length;
  const withinOver = errOver.filter((e) => e <= 0.005).length;
  const reproduction = {
    n,
    pct_within_0_3pp_1x2: (within1x2 / n) * 100,
    pct_within_0_5pp_over: (withinOver / n) * 100,
    err_1x2_mean_pp: mean(err1x2) * 100,
    err_1x2_p95_pp: percentile(err1x2, 0.95) * 100,
    err_1x2_max_pp: arrMax(err1x2) * 100,
    err_over_mean_pp: mean(errOver) * 100,
    err_over_p95_pp: percentile(errOver, 0.95) * 100,
    err_over_max_pp: arrMax(errOver) * 100,
    fit_residual_mean: mean(results.map((r) => r.fit_residual)),
    fit_residual_p95: percentile(results.map((r) => r.fit_residual), 0.95),
  };

  // (b) calibration: decile-bucket model-implied P(home win) vs realised
  const withP = results.map((r) => ({ p: r._repro.pHomeWinModel, win: r.ft_home_goals > r.ft_away_goals ? 1 : 0 }))
    .sort((a, b) => a.p - b.p);
  const deciles = [];
  const bucketSize = Math.floor(withP.length / 10);
  for (let d = 0; d < 10; d++) {
    const start = d * bucketSize;
    const end = d === 9 ? withP.length : start + bucketSize;
    const slice = withP.slice(start, end);
    if (!slice.length) continue;
    const predicted = mean(slice.map((s) => s.p));
    const realised = mean(slice.map((s) => s.win));
    deciles.push({ decile: d + 1, n: slice.length, predicted_p_home: predicted, realised_p_home: realised, gap_pp: (realised - predicted) * 100 });
  }

  // (c) AH discrepancy by tier
  const ahByTier = {};
  for (const t of TIERS) {
    const vals = results.filter((r) => r.tier === t).map((r) => r.ah_discrepancy);
    ahByTier[t] = {
      n: vals.length,
      mean_pp: vals.length ? mean(vals) * 100 : null,
      std_pp: vals.length ? std(vals) * 100 : null,
      abs_mean_pp: vals.length ? mean(vals.map(Math.abs)) * 100 : null,
    };
  }
  const allAh = results.map((r) => r.ah_discrepancy);
  ahByTier.ALL = {
    n: allAh.length,
    mean_pp: mean(allAh) * 100,
    std_pp: std(allAh) * 100,
    abs_mean_pp: mean(allAh.map(Math.abs)) * 100,
  };

  return { reproduction, calibration_deciles: deciles, ah_discrepancy_by_tier: ahByTier };
}

function percentile(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  const idx = Math.min(s.length - 1, Math.floor(p * s.length));
  return s[idx];
}

// ── main ───────────────────────────────────────────────────────────────
function main() {
  const t0 = Date.now();
  console.log(`Loading Bet365 CSVs from ${DATA_DIR} ...`);
  const { rows, skipped } = loadRows();
  console.log(`Loaded ${rows.length} usable rows (of ${skipped.total} scanned). Skipped: ${JSON.stringify(skipped)}`);

  // Time a small sample first to estimate full-run wall clock.
  const probe = rows.slice(0, 300);
  const tp0 = Date.now();
  for (const r of probe) processRow(r);
  const probeMs = Date.now() - tp0;
  const perRowMs = probeMs / probe.length;
  const estFullMs = perRowMs * rows.length;
  console.log(`Probe: ${probe.length} rows in ${probeMs}ms (${perRowMs.toFixed(3)}ms/row). Estimated full run: ${(estFullMs / 1000).toFixed(1)}s (${(estFullMs / 60000).toFixed(1)} min).`);

  let workRows = rows;
  let sampled = false;
  // Budget: keep this session's run under ~25 min wall clock; sample if the
  // estimate blows well past that (task explicitly permits sampling as a
  // documented fallback).
  const BUDGET_MS = 25 * 60 * 1000;
  if (estFullMs > BUDGET_MS) {
    workRows = stratifiedSample(rows, SAMPLE_TARGET);
    sampled = true;
    console.log(`Estimated full run exceeds budget — using a stratified sample of ${workRows.length} rows spread across date range and tier instead.`);
  } else {
    console.log(`Estimated full run within budget — processing all ${rows.length} rows.`);
  }

  const results = [];
  const t1 = Date.now();
  const PROGRESS_EVERY = 5000;
  for (let i = 0; i < workRows.length; i++) {
    results.push(processRow(workRows[i]));
    if ((i + 1) % PROGRESS_EVERY === 0) {
      const elapsed = (Date.now() - t1) / 1000;
      const rate = (i + 1) / elapsed;
      const etaS = (workRows.length - (i + 1)) / rate;
      console.log(`  ${i + 1}/${workRows.length} (${elapsed.toFixed(0)}s elapsed, ~${etaS.toFixed(0)}s remaining)`);
    }
  }
  const fitMs = Date.now() - t1;
  console.log(`Fit ${results.length} matches in ${(fitMs / 1000).toFixed(1)}s (${(fitMs / results.length).toFixed(2)}ms/match).`);

  // ── write JSONL (drop the internal-only _repro/_devigK diagnostics from
  // the persisted per-row record; they're folded into the summary instead) ──
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const jsonlPath = path.join(REPORT_DIR, `implied_lambda_${today}.jsonl`);
  const stream = fs.createWriteStream(jsonlPath, { encoding: 'utf8' });
  for (const r of results) {
    const { _repro, _devigK, ...record } = r;
    stream.write(JSON.stringify(record) + '\n');
  }
  stream.end();

  const summary = buildSummary(results);
  const totalMs = Date.now() - t0;

  console.log('\n=== Reproduction accuracy (Step 2 fit vs de-vigged closing inputs) ===');
  console.log(`n=${summary.reproduction.n}`);
  console.log(`1X2 within 0.3pp: ${summary.reproduction.pct_within_0_3pp_1x2.toFixed(2)}% (target >= 99%)`);
  console.log(`O/U within 0.5pp: ${summary.reproduction.pct_within_0_5pp_over.toFixed(2)}% (target >= 99%)`);
  console.log(`1X2 err mean=${summary.reproduction.err_1x2_mean_pp.toFixed(3)}pp p95=${summary.reproduction.err_1x2_p95_pp.toFixed(3)}pp max=${summary.reproduction.err_1x2_max_pp.toFixed(3)}pp`);
  console.log(`O/U err mean=${summary.reproduction.err_over_mean_pp.toFixed(3)}pp p95=${summary.reproduction.err_over_p95_pp.toFixed(3)}pp max=${summary.reproduction.err_over_max_pp.toFixed(3)}pp`);

  console.log('\n=== Calibration: model P(home win) decile vs realised ===');
  for (const d of summary.calibration_deciles) {
    console.log(`decile ${d.decile}: n=${d.n} predicted=${pct1(d.predicted_p_home)} realised=${pct1(d.realised_p_home)} gap=${d.gap_pp.toFixed(2)}pp`);
  }

  console.log('\n=== AH discrepancy (Step 3, independent check) by tier ===');
  for (const t of [...TIERS, 'ALL']) {
    const s = summary.ah_discrepancy_by_tier[t];
    console.log(`${t}: n=${s.n} mean=${s.mean_pp == null ? 'n/a' : s.mean_pp.toFixed(3) + 'pp'} std=${s.std_pp == null ? 'n/a' : s.std_pp.toFixed(3) + 'pp'} |mean|=${s.abs_mean_pp == null ? 'n/a' : s.abs_mean_pp.toFixed(3) + 'pp'}`);
  }

  const summaryOut = {
    generatedAt: new Date().toISOString(),
    dataDir: DATA_DIR,
    totalRowsInDataset: rows.length,
    rowsSkipped: skipped,
    rowsProcessed: results.length,
    sampled,
    sampleTarget: sampled ? SAMPLE_TARGET : null,
    wallClockMs: totalMs,
    wallClockSec: totalMs / 1000,
    fitMsPerMatch: fitMs / results.length,
    reproduction: summary.reproduction,
    calibration_deciles: summary.calibration_deciles,
    ah_discrepancy_by_tier: summary.ah_discrepancy_by_tier,
    jsonlPath,
  };
  const summaryPath = path.join(REPORT_DIR, `implied_lambda_summary_${today}.json`);
  fs.writeFileSync(summaryPath, JSON.stringify(summaryOut, null, 2));

  console.log(`\nWrote ${results.length} match records to ${jsonlPath}`);
  console.log(`Wrote summary report to ${summaryPath}`);
  console.log(`Total wall clock: ${(totalMs / 1000).toFixed(1)}s (${(totalMs / 60000).toFixed(2)} min)`);
}

main();
