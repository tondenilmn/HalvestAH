// telegram/research/hazard_fit.js
//
// Part E4 of LIVE_BETTING_PLAN.md — fits the per-minute goal hazard shape
// h(u) and in-play state-effect multipliers S(state) from the goals_time2
// match timelines (telegram/research/reports/timelines_2026-08-28.jsonl,
// produced by E3's loader). This is the "timing/state shape" layer of the
// live pricing model; E1's Bet365-derived lambda supplies the SCALE
// (favourite/dog strength) in a later phase — this script deliberately does
// NOT condition on strength (the Elo join referenced in the plan failed;
// goals_time2 carries no favourite/odds signal of its own).
//
// ── Data filter ────────────────────────────────────────────────────────
// - date >= 2004-08-01 (earlier seasons have severe FT-score mismatches,
//   up to 87% in 2000-01 — excluded per E3's own caveat).
// - a match is also dropped if its own timeline is internally inconsistent
//   (last event's running score != ft_home/ft_away, or ht > ft componentwise)
//   — a cheap defensive filter beyond the documented pre-2004 issue.
//
// ── Hazard shape h(u) ─────────────────────────────────────────────────
// Regular time (minute 1-45 for 1H, 46-90 for 2H) uses 1-MINUTE buckets:
// every surviving match plays every regular minute (no abandonments seen),
// so the exposure denominator is simply N_matches for every regular minute
// — trivial and exact, no censoring problem.
//
// Stoppage time is the hard part: goals_time2 has no "added time allotted"
// field, so we cannot observe, for a match with NO recorded incident in
// added time, how long the referee actually played. Per-added-minute
// exposure is therefore NOT separably observable from this data alone.
// We use the same style of approximation already established in this
// codebase (see CLAUDE.md's `_IT_1H`/`_IT_2H` note: "solved so that mass's
// share of the whole half matches the real share of goals recorded during
// that half's actual stoppage time"), extended with one explicit modelling
// assumption: the per-minute hazard WITHIN stoppage is flat (no reason to
// think it changes from added-minute 1 to 4 for the subset of matches still
// being played). Under that assumption the ratio of consecutive
// added-minute goal counts equals the ratio of consecutive "still playing"
// survival fractions S(k)/S(k-1) (the flat hazard cancels), which lets us
// back out a survival curve S(k) purely from the observed goal-count decay,
// anchored at S(1)=1 (virtually every match gets >=1 added minute in
// practice). This gives:
//   - a SINGLE aggregate flat stoppage hazard per half (the headline output
//     used by the hazard curve / integration), plus
//   - the derived S(k) shape and implied average added-time length, kept as
//     a diagnostic (mirrors the CLAUDE.md "avg N.NN added min when it
//     happens" style number) — NOT decomposed into independently-exposed
//     per-minute buckets, since that would silently smuggle in more
//     precision than the data supports.
// Resolution actually used: 1-minute for regular time (1..45, 46..90);
// ONE aggregated bucket each for 1H stoppage ("45+") and 2H stoppage
// ("90+"). This is exactly the "otherwise fall back to wider buckets" case
// the task anticipates, and the reason is the missing-exposure problem
// above, not a sample-size problem (stoppage has plenty of goals).
//
// ── State-effect regression S(state) ──────────────────────────────────
// Poisson regression with an offset, IRLS-fit — architecture ported from
// telegram/research/residual_regression.js's fitPoissonRidge (same Newton/
// IRLS-on-the-canonical-link + ridge penalty + sandwich-free Fisher-info SE
// approach), adapted here for a GROUPED/aggregated Poisson fit: because the
// predictors are all categorical and the offset (log h(u)) only varies by
// minute, all team-minutes sharing (minute, margin bucket, total-goals
// bucket, red-card state) are pooled into one aggregated row with
// exposure_n = count of team-minutes in that cell and y = goals in that
// cell. This is algebraically identical to fitting one row per team-minute
// (Poisson sufficient statistics for a saturated-in-those-covariates GLM)
// but collapses ~65k matches x ~90 minutes x 2 sides into a few thousand
// cells, which is both far cheaper and avoids materialising ~12M rows.
// Regression is fit on REGULAR-time team-minutes only (stoppage excluded —
// see above: state can't be reliably tied to a specific stoppage minute
// either, so S(state) is assumed to carry over unchanged into the flat
// stoppage hazard when the pricing engine integrates over it later).
//
// Predictors (categorical, dummy-coded, baseline in [] excluded from design):
//   margin (that side's own goal difference): [<=-2], -1, [0], +1, >=+2
//   total goals so far (both teams):          [0], 1, 2, 3+
//   men on pitch (own team's red cards vs opponent's, cumulative so far):
//                                              own_down, opp_down, [even]
//   half:                                      [1], 2
//
// ── Dispersion (gamma-Poisson) ──────────────────────────────────────────
// For each half separately: pool (home-goals-in-that-half, away-goals-in-
// that-half) across all matches into one sample of half-goal-counts per
// side, fit a Negative-Binomial(alpha, alpha/mean) by 1-D numerical MLE on
// alpha (mean fixed at the sample mean — the MLE for the NB mean given iid
// count data is the sample mean regardless of alpha), and report the NB
// vs. Poisson log-likelihood on the same data.
//
// ── Validation (walk-forward by season) ─────────────────────────────────
// Hold out seasons 2022-2023, 2023-2024, 2024-2025 entirely; fit everything
// above on strictly-earlier seasons (>= 2004-08-01 filter still applies).
// For the held-out matches, at 2nd-half checkpoint minutes 60/70/80,
// reconstruct the match's REAL state at that minute from its own events,
// predict P(>=1 more goal in the remainder of that half) two ways — the
// fitted shape+state model, and a naive flat-hazard/no-state baseline (a
// single pooled average per-side-per-minute rate, applied uniformly with no
// shape and no state conditioning) — and compare both to the realized
// outcome via decile reliability tables, Brier score and log-loss.
//
// Run: node telegram/research/hazard_fit.js

const fs = require('fs');
const path = require('path');

const REPORT_DIR = path.resolve(__dirname, 'reports');
const TIMELINES_JSONL = path.resolve(REPORT_DIR, 'timelines_2026-08-28.jsonl');
const DATE_MIN = '2004-08-01';
const HOLDOUT_SEASONS = new Set(['2022-2023', '2023-2024', '2024-2025']);
const STOPPAGE_MAX_1H = 15; // added-minute cap considered for the 1H stoppage bucket
const STOPPAGE_MAX_2H = 15; // added-minute cap considered for the 2H stoppage bucket
const MIN_BUCKET_N = 300; // per-plan aggregation-fallback rule (goal-event count)
const RIDGE_LAMBDA = 0.5;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── tiny linear algebra (ported from residual_regression.js) ────────────
function solveLinearSystem(A, b) {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (piv !== col) { const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp; }
    const pivVal = M[col][col];
    if (Math.abs(pivVal) < 1e-300) continue;
    for (let c = col; c <= n; c++) M[col][c] /= pivVal;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col];
      if (factor === 0) continue;
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  return M.map((row) => row[n]);
}

function invertMatrix(A) {
  const n = A.length;
  const inv = [];
  for (let i = 0; i < n; i++) {
    const e = new Array(n).fill(0);
    e[i] = 1;
    inv.push(solveLinearSystem(A, e));
  }
  const out = [];
  for (let r = 0; r < n; r++) out.push(inv.map((col) => col[r]));
  return out;
}

// ── Poisson IRLS with fixed offset + ridge, GROUPED-count variant ───────
// Same math as residual_regression.js's fitPoissonRidge; y/offset here are
// per-CELL aggregates (y = goal count in cell, offset already includes
// log(exposure_n) for that cell) rather than per-row 0/1 — the Poisson IRLS
// update is identical either way.
function fitPoissonRidge(X, y, offset, featureNames, ridgeLambda) {
  const n = X.length;
  const p = X[0].length;
  let beta = new Array(p).fill(0);
  const meanLogRate = mean(y.map((yi, i) => Math.log(Math.max(yi, 0.05)) - offset[i]));
  beta[0] = meanLogRate;

  const penalty = new Array(p).fill(ridgeLambda);
  penalty[0] = 0;

  let prevObj = -Infinity;
  let iter = 0;
  const maxIter = 80;
  const tol = 1e-10;
  let converged = false;

  for (iter = 1; iter <= maxIter; iter++) {
    const eta = new Array(n);
    const mu = new Array(n);
    for (let i = 0; i < n; i++) {
      let e = offset[i];
      for (let j = 0; j < p; j++) e += X[i][j] * beta[j];
      e = Math.max(-30, Math.min(30, e));
      eta[i] = e;
      mu[i] = Math.exp(e);
    }

    let loglik = 0;
    for (let i = 0; i < n; i++) loglik += y[i] * eta[i] - mu[i];
    let pen = 0;
    for (let j = 0; j < p; j++) pen += 0.5 * penalty[j] * beta[j] * beta[j];
    const obj = loglik - pen;

    const XtWX = Array.from({ length: p }, () => new Array(p).fill(0));
    const XtWz = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      const w = Math.max(mu[i], 1e-8);
      const z = (eta[i] - offset[i]) + (y[i] - mu[i]) / w;
      const xi = X[i];
      for (let a = 0; a < p; a++) {
        const wxa = w * xi[a];
        XtWz[a] += wxa * z;
        for (let b = a; b < p; b++) XtWX[a][b] += wxa * xi[b];
      }
    }
    for (let a = 0; a < p; a++) {
      for (let b = a; b < p; b++) XtWX[b][a] = XtWX[a][b];
      XtWX[a][a] += penalty[a];
    }

    const betaNew = solveLinearSystem(XtWX, XtWz);
    const delta = betaNew.reduce((s, v, j) => s + Math.abs(v - beta[j]), 0);
    beta = betaNew;

    if (obj < prevObj - 1e-6 && iter > 1) {
      console.warn(`  [warn] penalised log-lik decreased at iter ${iter}: ${prevObj.toFixed(3)} -> ${obj.toFixed(3)}`);
    }
    prevObj = obj;
    if (delta < tol) { converged = true; break; }
  }

  const mu = new Array(n);
  for (let i = 0; i < n; i++) {
    let e = offset[i];
    for (let j = 0; j < p; j++) e += X[i][j] * beta[j];
    mu[i] = Math.exp(Math.max(-30, Math.min(30, e)));
  }
  const XtWX = Array.from({ length: p }, () => new Array(p).fill(0));
  for (let i = 0; i < n; i++) {
    const w = mu[i];
    const xi = X[i];
    for (let a = 0; a < p; a++) {
      const wxa = w * xi[a];
      for (let b = a; b < p; b++) XtWX[a][b] += wxa * xi[b];
    }
  }
  for (let a = 0; a < p; a++) for (let b = a; b < p; b++) XtWX[b][a] = XtWX[a][b];

  let cov, seOk = true;
  try { cov = invertMatrix(XtWX); } catch (e) { seOk = false; cov = Array.from({ length: p }, () => new Array(p).fill(NaN)); }
  const se = cov.map((row, j) => Math.sqrt(Math.max(row[j], 0)));

  const coefficients = featureNames.map((name, j) => {
    const b = beta[j], s = se[j];
    const lo = b - 1.96 * s, hi = b + 1.96 * s;
    return { name, estimate: b, se: s, ci_lo: lo, ci_hi: hi, excludes_zero: (lo > 0 || hi < 0) };
  });

  let finalLoglik = 0;
  for (let i = 0; i < n; i++) finalLoglik += y[i] * Math.log(Math.max(mu[i], 1e-12)) - mu[i];

  return { n, p, iterations: iter, converged, final_loglik: finalLoglik, se_ok: seOk, coefficients, beta };
}

function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }

// ── lgamma (Lanczos approximation) for NB MLE ────────────────────────────
const LANCZOS_G = 7;
const LANCZOS_COEF = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028,
  771.32342877765313, -176.61502916214059, 12.507343278686905,
  -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
];
function lgamma(x) {
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - lgamma(1 - x);
  x -= 1;
  let a = LANCZOS_COEF[0];
  const t = x + LANCZOS_G + 0.5;
  for (let i = 1; i < LANCZOS_G + 2; i++) a += LANCZOS_COEF[i] / (x + i);
  return 0.5 * Math.log(2 * Math.PI) + (x + 0.5) * Math.log(t) - t + Math.log(a);
}

// ── data loading ──────────────────────────────────────────────────────
function loadMatches() {
  const lines = fs.readFileSync(TIMELINES_JSONL, 'utf8').split('\n').filter((l) => l.trim());
  const all = [];
  let dropped_date = 0, dropped_consistency = 0, dropped_parse = 0;
  for (const line of lines) {
    let r;
    try { r = JSON.parse(line); } catch (e) { dropped_parse++; continue; }
    if (!(r.date >= DATE_MIN)) { dropped_date++; continue; }
    if (!(r.ht_home <= r.ft_home && r.ht_away <= r.ft_away)) { dropped_consistency++; continue; }
    // running-score consistency check against the last recorded event
    let lastH = 0, lastA = 0;
    for (const e of r.events) { lastH = e.homeScoreAfter; lastA = e.awayScoreAfter; }
    if (r.events.length > 0 && (lastH !== r.ft_home || lastA !== r.ft_away)) { dropped_consistency++; continue; }
    if (r.events.length === 0 && (r.ft_home !== 0 || r.ft_away !== 0)) { dropped_consistency++; continue; }
    all.push(r);
  }
  return { all, total_lines: lines.length, dropped_date, dropped_consistency, dropped_parse };
}

function splitEventsByHalf(rec) {
  const goalsH1 = rec.events.filter((e) => e.half === 1).sort((a, b) => a.minuteTotal - b.minuteTotal);
  const goalsH2 = rec.events.filter((e) => e.half === 2).sort((a, b) => a.minuteTotal - b.minuteTotal);
  const redH1 = rec.redCards.filter((c) => c.half === 1).sort((a, b) => a.minuteTotal - b.minuteTotal);
  const redH2 = rec.redCards.filter((c) => c.half === 2).sort((a, b) => a.minuteTotal - b.minuteTotal);
  return { goalsH1, goalsH2, redH1, redH2 };
}

// ── Step 1: hazard shape h(u) ─────────────────────────────────────────
function fitHazardShape(matches) {
  const N = matches.length;
  const goalsAt1 = new Array(46).fill(0); // index 1..45
  const goalsAt2 = new Array(91).fill(0); // index 46..90
  const stop1 = new Array(STOPPAGE_MAX_1H + 1).fill(0); // index 1..15 (added minute)
  const stop2 = new Array(STOPPAGE_MAX_2H + 1).fill(0);

  for (const rec of matches) {
    for (const e of rec.events) {
      if (e.half === 1) {
        if (e.minuteTotal >= 1 && e.minuteTotal <= 45) goalsAt1[e.minuteTotal]++;
        else if (e.minuteTotal > 45) {
          const k = e.minuteTotal - 45;
          if (k >= 1 && k <= STOPPAGE_MAX_1H) stop1[k]++;
        }
      } else if (e.half === 2) {
        if (e.minuteTotal >= 46 && e.minuteTotal <= 90) goalsAt2[e.minuteTotal]++;
        else if (e.minuteTotal > 90) {
          const k = e.minuteTotal - 90;
          if (k >= 1 && k <= STOPPAGE_MAX_2H) stop2[k]++;
        }
      }
    }
  }

  // regular-minute rate: exact, exposure = N for every regular minute
  const regular1H = [];
  for (let u = 1; u <= 45; u++) regular1H.push({ minute: u, goals: goalsAt1[u], exposure: N, rate: goalsAt1[u] / N });
  const regular2H = [];
  for (let u = 46; u <= 90; u++) regular2H.push({ minute: u, goals: goalsAt2[u], exposure: N, rate: goalsAt2[u] / N });

  // stoppage: derive survival curve S(k) from the ratio of consecutive
  // added-minute goal counts (flat-intra-stoppage-hazard assumption; see
  // header comment), anchored S(1)=1, only over the range with n>=1 goals.
  function survivalAndFlatRate(stopArr, label) {
    const k_detail = [];
    let S = 1;
    let sumS = 0; // implied avg added minutes
    const raw = [];
    for (let k = 1; k < stopArr.length; k++) {
      const c = stopArr[k];
      const cPrev = k === 1 ? null : stopArr[k - 1];
      if (k > 1) {
        if (cPrev > 0) S = S * (c / cPrev);
        else S = 0; // no goals at all in previous added-minute -> treat as fully decayed
      }
      raw.push({ addedMinute: k, goals: c, survival_S: S });
      sumS += S;
    }
    const totalGoals = stopArr.slice(1).reduce((a, b) => a + b, 0);
    const flatRatePerMinute = sumS > 0 ? totalGoals / (N * sumS) : 0;
    return { label, raw, avg_added_minutes_implied: sumS, total_goals: totalGoals, flat_rate_per_minute: flatRatePerMinute };
  }

  const stoppage1H = survivalAndFlatRate(stop1, '1H stoppage (45+)');
  const stoppage2H = survivalAndFlatRate(stop2, '2H stoppage (90+)');

  return { N, regular1H, regular2H, stoppage1H, stoppage2H };
}

// lookup regular hazard rate at minute u (1..90); returns 0 if out of range
// (shouldn't happen for regular-time usage)
function makeHazardLookup(shape) {
  const arr = new Array(91).fill(0);
  for (const r of shape.regular1H) arr[r.minute] = r.rate;
  for (const r of shape.regular2H) arr[r.minute] = r.rate;
  return (u) => (u >= 1 && u <= 90 ? Math.max(arr[u], 1e-9) : Math.max(shape.stoppage2H.flat_rate_per_minute, 1e-9));
}

// ── Step 2: state-effect regression ──────────────────────────────────
function marginBucket(diff) {
  if (diff <= -2) return 'm2';
  if (diff === -1) return 'm1';
  if (diff === 0) return 'z';
  if (diff === 1) return 'p1';
  return 'p2';
}
function totalBucket(total) {
  if (total === 0) return 't0';
  if (total === 1) return 't1';
  if (total === 2) return 't2';
  return 't3p';
}
function redState(ownRed, oppRed) {
  if (ownRed > oppRed) return 'own_down';
  if (oppRed > ownRed) return 'opp_down';
  return 'even';
}

const STATE_FEATURE_NAMES = [
  'intercept',
  'margin_m2', 'margin_m1', 'margin_p1', 'margin_p2', // baseline margin=0
  'total_t1', 'total_t2', 'total_t3p', // baseline total=0
  'red_own_down', 'red_opp_down', // baseline even
  'half2', // baseline half1
];

function buildStateCellsFast(matches) {
  const cells = new Map();
  function addExposure(minute, margin, total, red, half, scored) {
    const key = `${minute}|${margin}|${total}|${red}`;
    let c = cells.get(key);
    if (!c) { c = { y: 0, n: 0, minute, margin, total, red, half }; cells.set(key, c); }
    c.n += 1;
    if (scored) c.y += 1;
  }

  for (const rec of matches) {
    const { goalsH1, goalsH2, redH1, redH2 } = splitEventsByHalf(rec);

    for (const side of ['home', 'away']) {
      const scoreMinutesH1 = new Set(goalsH1.filter((e) => e.scoringTeam === side && e.minuteTotal <= 45).map((e) => e.minuteTotal));
      const scoreMinutesH2 = new Set(goalsH2.filter((e) => e.scoringTeam === side && e.minuteTotal <= 90).map((e) => e.minuteTotal));

      let ownG = 0, oppG = 0, ownR = 0, oppR = 0;
      let gi = 0, ri = 0;
      for (let u = 1; u <= 45; u++) {
        while (gi < goalsH1.length && goalsH1[gi].minuteTotal < u) {
          if (goalsH1[gi].scoringTeam === side) ownG++; else oppG++;
          gi++;
        }
        while (ri < redH1.length && redH1[ri].minuteTotal < u) {
          if (redH1[ri].team === side) ownR++; else oppR++;
          ri++;
        }
        addExposure(u, marginBucket(ownG - oppG), totalBucket(ownG + oppG), redState(ownR, oppR), 1, scoreMinutesH1.has(u));
      }
      while (gi < goalsH1.length) { if (goalsH1[gi].scoringTeam === side) ownG++; else oppG++; gi++; }
      while (ri < redH1.length) { if (redH1[ri].team === side) ownR++; else oppR++; ri++; }

      gi = 0; ri = 0;
      for (let u = 46; u <= 90; u++) {
        while (gi < goalsH2.length && goalsH2[gi].minuteTotal < u) {
          if (goalsH2[gi].scoringTeam === side) ownG++; else oppG++;
          gi++;
        }
        while (ri < redH2.length && redH2[ri].minuteTotal < u) {
          if (redH2[ri].team === side) ownR++; else oppR++;
          ri++;
        }
        addExposure(u, marginBucket(ownG - oppG), totalBucket(ownG + oppG), redState(ownR, oppR), 2, scoreMinutesH2.has(u));
      }
    }
  }
  return cells;
}

function fitStateRegression(matches, hazardLookup) {
  console.log('  building state-exposure cells ...');
  const cells = buildStateCellsFast(matches);
  console.log(`  ${cells.size} distinct (minute,margin,total,red) cells`);

  const rows = [...cells.values()];
  const p = STATE_FEATURE_NAMES.length;
  const X = new Array(rows.length);
  const y = new Array(rows.length);
  const offset = new Array(rows.length);

  rows.forEach((c, i) => {
    const row = new Array(p).fill(0);
    row[0] = 1;
    if (c.margin === 'm2') row[1] = 1;
    if (c.margin === 'm1') row[2] = 1;
    if (c.margin === 'p1') row[3] = 1;
    if (c.margin === 'p2') row[4] = 1;
    if (c.total === 't1') row[5] = 1;
    if (c.total === 't2') row[6] = 1;
    if (c.total === 't3p') row[7] = 1;
    if (c.red === 'own_down') row[8] = 1;
    if (c.red === 'opp_down') row[9] = 1;
    if (c.half === 2) row[10] = 1;
    X[i] = row;
    y[i] = c.y;
    offset[i] = Math.log(hazardLookup(c.minute)) + Math.log(c.n);
  });

  console.log(`  fitting Poisson IRLS on ${rows.length} aggregated cells ...`);
  const fit = fitPoissonRidge(X, y, offset, STATE_FEATURE_NAMES, RIDGE_LAMBDA);
  console.log(`  converged=${fit.converged} iters=${fit.iterations} loglik=${fit.final_loglik.toFixed(1)}`);
  return fit;
}

// ── Step 3: gamma-Poisson dispersion per half ────────────────────────
function nbLogLik(counts, mu, alpha) {
  // NB parametrised by mean mu and shape alpha: r=alpha, p = alpha/(alpha+mu)
  const r = alpha;
  const p = alpha / (alpha + mu);
  let ll = 0;
  for (const k of counts) {
    ll += lgamma(k + r) - lgamma(r) - lgamma(k + 1) + r * Math.log(p) + k * Math.log(1 - p);
  }
  return ll;
}
function poissonLogLik(counts, mu) {
  let ll = 0;
  for (const k of counts) ll += k * Math.log(mu) - mu - lgamma(k + 1);
  return ll;
}
function fitAlphaMLE(counts) {
  const mu = mean(counts);
  // 1-D search over alpha via golden-section on log(alpha) in [-3, 6] i.e. alpha in [0.05, 400]
  function negLL(logAlpha) { return -nbLogLik(counts, mu, Math.exp(logAlpha)); }
  const gr = (Math.sqrt(5) - 1) / 2;
  let a = -3, b = 6;
  let c = b - gr * (b - a), d = a + gr * (b - a);
  let fc = negLL(c), fd = negLL(d);
  for (let iter = 0; iter < 100; iter++) {
    if (fc < fd) { b = d; d = c; fd = fc; c = b - gr * (b - a); fc = negLL(c); }
    else { a = c; c = d; fc = fd; d = a + gr * (b - a); fd = negLL(d); }
    if (Math.abs(b - a) < 1e-6) break;
  }
  const logAlphaHat = (a + b) / 2;
  const alphaHat = Math.exp(logAlphaHat);
  const ll_nb = nbLogLik(counts, mu, alphaHat);
  const ll_poisson = poissonLogLik(counts, mu);
  return { alpha: alphaHat, mean: mu, n: counts.length, loglik_nb: ll_nb, loglik_poisson: ll_poisson, nb_wins: ll_nb > ll_poisson };
}

function fitDispersion(matches) {
  const half1counts = [], half2counts = [];
  for (const rec of matches) {
    half1counts.push(rec.ht_home, rec.ht_away);
    const h2h = rec.ft_home - rec.ht_home;
    const h2a = rec.ft_away - rec.ht_away;
    half2counts.push(h2h, h2a);
  }
  return {
    half1: fitAlphaMLE(half1counts),
    half2: fitAlphaMLE(half2counts),
  };
}

// ── Step 6: validation ──────────────────────────────────────────────
function reconstructStateAt(rec, side, checkpointMinute) {
  // checkpointMinute in [46,90] range (2H checkpoints only, per task).
  const { goalsH1, goalsH2, redH1, redH2 } = splitEventsByHalf(rec);
  let ownG = 0, oppG = 0, ownR = 0, oppR = 0;
  for (const e of goalsH1) { if (e.scoringTeam === side) ownG++; else oppG++; }
  for (const c of redH1) { if (c.team === side) ownR++; else oppR++; }
  for (const e of goalsH2) {
    if (e.minuteTotal >= checkpointMinute) break;
    if (e.scoringTeam === side) ownG++; else oppG++;
  }
  for (const c of redH2) {
    if (c.minuteTotal >= checkpointMinute) break;
    if (c.team === side) ownR++; else oppR++;
  }
  return { margin: marginBucket(ownG - oppG), total: totalBucket(ownG + oppG), red: redState(ownR, oppR) };
}

function stateMultiplier(stateFit, state, half) {
  let eta = 0;
  const b = stateFit.beta;
  eta += b[0];
  if (state.margin === 'm2') eta += b[1];
  if (state.margin === 'm1') eta += b[2];
  if (state.margin === 'p1') eta += b[3];
  if (state.margin === 'p2') eta += b[4];
  if (state.total === 't1') eta += b[5];
  if (state.total === 't2') eta += b[6];
  if (state.total === 't3p') eta += b[7];
  if (state.red === 'own_down') eta += b[8];
  if (state.red === 'opp_down') eta += b[9];
  if (half === 2) eta += b[10];
  return Math.exp(eta); // this includes the intercept, i.e. S(state) already baked with baseline level
}

// predicted P(>=1 more goal in remainder of 2H, for a given side) using
// fitted shape (hazardLookup) + state multiplier, integrating regular
// minutes [checkpoint,90] plus the flat 2H-stoppage tail.
function predictRemainderProb(hazardLookup, stateFit, stateHome, stateAway, checkpointMinute, stoppageFlatRate, avgAddedMinutes) {
  let cumHaz = 0;
  for (let u = checkpointMinute; u <= 90; u++) {
    const base = hazardLookup(u);
    cumHaz += base * stateMultiplier(stateFit, stateHome, 2);
    cumHaz += base * stateMultiplier(stateFit, stateAway, 2);
  }
  // stoppage tail: flat hazard, state multiplier at the state as of minute 90
  cumHaz += stoppageFlatRate * stateMultiplier(stateFit, stateHome, 2) * avgAddedMinutes;
  cumHaz += stoppageFlatRate * stateMultiplier(stateFit, stateAway, 2) * avgAddedMinutes;
  return 1 - Math.exp(-cumHaz);
}

function predictRemainderProbFlat(flatRatePerSidePerMinute, checkpointMinute, avgAddedMinutes) {
  const minutesRemaining = (90 - checkpointMinute + 1) + avgAddedMinutes;
  const cumHaz = 2 * flatRatePerSidePerMinute * minutesRemaining;
  return 1 - Math.exp(-cumHaz);
}

function realizedGoalInRemainder(rec, checkpointMinute) {
  const { goalsH2 } = splitEventsByHalf(rec);
  return goalsH2.some((e) => e.minuteTotal >= checkpointMinute) ? 1 : 0;
}

function decileTable(preds, outcomes) {
  const idx = preds.map((p, i) => i).sort((a, b) => preds[a] - preds[b]);
  const n = preds.length;
  const deciles = [];
  for (let d = 0; d < 10; d++) {
    const lo = Math.floor((d / 10) * n);
    const hi = Math.floor(((d + 1) / 10) * n);
    const idxs = idx.slice(lo, hi);
    if (!idxs.length) continue;
    const avgPred = mean(idxs.map((i) => preds[i]));
    const avgReal = mean(idxs.map((i) => outcomes[i]));
    deciles.push({ decile: d + 1, n: idxs.length, avg_predicted: avgPred, realized_rate: avgReal, gap_pp: (avgReal - avgPred) * 100 });
  }
  return deciles;
}

function brierScore(preds, outcomes) {
  return mean(preds.map((p, i) => (p - outcomes[i]) ** 2));
}
function logLoss(preds, outcomes) {
  const eps = 1e-9;
  return -mean(preds.map((p, i) => {
    const pc = Math.min(1 - eps, Math.max(eps, p));
    return outcomes[i] * Math.log(pc) + (1 - outcomes[i]) * Math.log(1 - pc);
  }));
}

function runValidation(trainMatches, holdoutMatches, hazardShape, stateFit) {
  const hazardLookup = makeHazardLookup(hazardShape);
  const avgAdded2H = hazardShape.stoppage2H.avg_added_minutes_implied;
  const stopFlat2H = hazardShape.stoppage2H.flat_rate_per_minute;

  // naive flat baseline rate, computed from the TRAINING set only
  let totalGoalsSide = 0, totalSideMinutes = 0;
  for (const r of trainMatches) {
    totalGoalsSide += r.ft_home + r.ft_away;
    totalSideMinutes += 90 * 2; // 2 sides x 90 regular minutes
  }
  const flatRatePerSidePerMinute = totalGoalsSide / totalSideMinutes;

  const checkpoints = [60, 70, 80];
  const results = {};
  for (const cp of checkpoints) {
    const predsFit = [], predsFlat = [], outs = [];
    for (const rec of holdoutMatches) {
      const stateHome = reconstructStateAt(rec, 'home', cp);
      const stateAway = reconstructStateAt(rec, 'away', cp);
      const pFit = predictRemainderProb(hazardLookup, stateFit, stateHome, stateAway, cp, stopFlat2H, avgAdded2H);
      const pFlat = predictRemainderProbFlat(flatRatePerSidePerMinute, cp, avgAdded2H);
      const y = realizedGoalInRemainder(rec, cp);
      predsFit.push(pFit); predsFlat.push(pFlat); outs.push(y);
    }
    results[cp] = {
      n: holdoutMatches.length,
      fitted_model: {
        brier: brierScore(predsFit, outs),
        log_loss: logLoss(predsFit, outs),
        decile_table: decileTable(predsFit, outs),
      },
      flat_baseline: {
        brier: brierScore(predsFlat, outs),
        log_loss: logLoss(predsFlat, outs),
        decile_table: decileTable(predsFlat, outs),
      },
      realized_rate_overall: mean(outs),
    };
  }
  return { checkpoints, flat_rate_per_side_per_minute: flatRatePerSidePerMinute, results };
}

// ── main ──────────────────────────────────────────────────────────────
function main() {
  const t0 = Date.now();
  console.log(`Loading timelines from ${TIMELINES_JSONL} ...`);
  const { all, total_lines, dropped_date, dropped_consistency, dropped_parse } = loadMatches();
  console.log(`Loaded ${all.length} usable matches (of ${total_lines} lines). Dropped: date<${DATE_MIN}=${dropped_date}, consistency=${dropped_consistency}, parse=${dropped_parse}`);

  const trainMatches = all.filter((r) => !HOLDOUT_SEASONS.has(r.season));
  const holdoutMatches = all.filter((r) => HOLDOUT_SEASONS.has(r.season));
  console.log(`Train: ${trainMatches.length} matches. Holdout (${[...HOLDOUT_SEASONS].join(', ')}): ${holdoutMatches.length} matches.`);

  console.log('\n[1/4] Fitting hazard shape h(u) on TRAINING matches ...');
  const hazardShape = fitHazardShape(trainMatches);
  const hazardLookup = makeHazardLookup(hazardShape);

  console.log('\n[2/4] Fitting state-effect regression S(state) on TRAINING matches ...');
  const stateFit = fitStateRegression(trainMatches, hazardLookup);

  console.log('\n[3/4] Fitting gamma-Poisson dispersion (per half) on TRAINING matches ...');
  const dispersion = fitDispersion(trainMatches);
  console.log(`  1H: alpha=${dispersion.half1.alpha.toFixed(3)} mean=${dispersion.half1.mean.toFixed(4)} loglik_nb=${dispersion.half1.loglik_nb.toFixed(1)} loglik_poisson=${dispersion.half1.loglik_poisson.toFixed(1)} NB_wins=${dispersion.half1.nb_wins}`);
  console.log(`  2H: alpha=${dispersion.half2.alpha.toFixed(3)} mean=${dispersion.half2.mean.toFixed(4)} loglik_nb=${dispersion.half2.loglik_nb.toFixed(1)} loglik_poisson=${dispersion.half2.loglik_poisson.toFixed(1)} NB_wins=${dispersion.half2.nb_wins}`);

  console.log('\n[4/4] Walk-forward validation on held-out seasons ...');
  const validation = runValidation(trainMatches, holdoutMatches, hazardShape, stateFit);

  // ── console summary ───────────────────────────────────────────────
  function windowAvgRate(shape, lo, hi) {
    const rows = [...shape.regular1H, ...shape.regular2H].filter((r) => r.minute >= lo && r.minute <= hi);
    return mean(rows.map((r) => r.rate));
  }
  console.log('\n=== HAZARD SHAPE SUMMARY (per-minute-per-match total-goal rate) ===');
  console.log(`  0-15:    ${windowAvgRate(hazardShape, 1, 15).toFixed(5)}`);
  console.log(`  15-30:   ${windowAvgRate(hazardShape, 16, 30).toFixed(5)}`);
  console.log(`  30-45:   ${windowAvgRate(hazardShape, 31, 45).toFixed(5)}`);
  console.log(`  45+stop: flat=${hazardShape.stoppage1H.flat_rate_per_minute.toFixed(5)} (avg added min implied=${hazardShape.stoppage1H.avg_added_minutes_implied.toFixed(2)}, n_goals=${hazardShape.stoppage1H.total_goals})`);
  console.log(`  46-60:   ${windowAvgRate(hazardShape, 46, 60).toFixed(5)}`);
  console.log(`  60-75:   ${windowAvgRate(hazardShape, 61, 75).toFixed(5)}`);
  console.log(`  75-90:   ${windowAvgRate(hazardShape, 76, 90).toFixed(5)}`);
  console.log(`  90+stop: flat=${hazardShape.stoppage2H.flat_rate_per_minute.toFixed(5)} (avg added min implied=${hazardShape.stoppage2H.avg_added_minutes_implied.toFixed(2)}, n_goals=${hazardShape.stoppage2H.total_goals})`);

  console.log('\n=== STATE-EFFECT COEFFICIENTS (S(state), log-scale, IRLS+ridge) ===');
  for (const c of stateFit.coefficients) {
    console.log(`  ${c.name.padEnd(14)} b=${c.estimate.toFixed(4).padStart(8)}  SE=${c.se.toFixed(4).padStart(7)}  CI=[${c.ci_lo.toFixed(4)}, ${c.ci_hi.toFixed(4)}]  mult=${Math.exp(c.estimate).toFixed(3)}  ${c.excludes_zero ? '*' : ''}`);
  }
  console.log('\n  -- RED CARD EFFECT (clean readout) --');
  for (const name of ['red_own_down', 'red_opp_down']) {
    const c = stateFit.coefficients.find((x) => x.name === name);
    console.log(`  ${name}: multiplier=${Math.exp(c.estimate).toFixed(3)}x  95% CI mult=[${Math.exp(c.ci_lo).toFixed(3)}, ${Math.exp(c.ci_hi).toFixed(3)}]  coef=${c.estimate.toFixed(4)} (SE ${c.se.toFixed(4)})  excludes_zero=${c.excludes_zero}`);
  }

  console.log('\n=== VALIDATION (held-out seasons) ===');
  for (const cp of validation.checkpoints) {
    const r = validation.results[cp];
    console.log(`\n  -- checkpoint minute ${cp} (n=${r.n}, realized P(>=1 more goal)=${r.realized_rate_overall.toFixed(4)}) --`);
    console.log(`  fitted:   Brier=${r.fitted_model.brier.toFixed(5)}  LogLoss=${r.fitted_model.log_loss.toFixed(5)}`);
    console.log(`  flat:     Brier=${r.flat_baseline.brier.toFixed(5)}  LogLoss=${r.flat_baseline.log_loss.toFixed(5)}`);
    console.log(`  fitted beats flat: Brier=${r.fitted_model.brier < r.flat_baseline.brier}  LogLoss=${r.fitted_model.log_loss < r.flat_baseline.log_loss}`);
  }

  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsedS}s.`);

  // ── write static/data/goal_hazard.json (small, ships to browser) ───
  const goalHazardOut = {
    _shape_doc: 'E4 (LIVE_BETTING_PLAN.md) fitted timing/state layer. hazard.regular is a 90-entry array (1..90, index 0 unused) of per-minute-per-match total-goal rate (both sides combined; halve for a per-side rate if needed, or use state_effects for per-side conditioning). hazard.stoppage_1h/2h are single flat added-minute rates (see script header for why stoppage is not decomposed per-minute) with an implied average added-minute length. state_effects.coefficients are log-scale multipliers S(state) = exp(sum of applicable dummy coefficients); apply per-SIDE using that side\'s own margin/total/red-card state. dispersion gives the fitted gamma-Poisson alpha per half (mean-field; combine with a live per-match lambda from E1 downstream). NOT conditioned on strength/favourite (no Elo signal available in goals_time2) — combine with E1 lambda for that.',
    generated_at: new Date().toISOString(),
    source: TIMELINES_JSONL,
    n_train_matches: trainMatches.length,
    n_holdout_matches: holdoutMatches.length,
    hazard: {
      regular: (() => { const a = new Array(91).fill(0); for (const r of hazardShape.regular1H) a[r.minute] = r.rate; for (const r of hazardShape.regular2H) a[r.minute] = r.rate; return a; })(),
      stoppage_1h: { flat_rate_per_minute: hazardShape.stoppage1H.flat_rate_per_minute, avg_added_minutes: hazardShape.stoppage1H.avg_added_minutes_implied },
      stoppage_2h: { flat_rate_per_minute: hazardShape.stoppage2H.flat_rate_per_minute, avg_added_minutes: hazardShape.stoppage2H.avg_added_minutes_implied },
    },
    state_effects: {
      feature_names: STATE_FEATURE_NAMES,
      coefficients: stateFit.coefficients.map((c) => ({ name: c.name, estimate: round(c.estimate, 6), se: round(c.se, 6), ci_lo: round(c.ci_lo, 6), ci_hi: round(c.ci_hi, 6), multiplier: round(Math.exp(c.estimate), 4) })),
    },
    dispersion: {
      half1: { alpha: round(dispersion.half1.alpha, 4), mean: round(dispersion.half1.mean, 4) },
      half2: { alpha: round(dispersion.half2.alpha, 4), mean: round(dispersion.half2.mean, 4) },
    },
  };
  const staticOutPath = path.resolve(__dirname, '../../static/data/goal_hazard.json');
  fs.writeFileSync(staticOutPath, JSON.stringify(goalHazardOut));
  const sizeKB = (fs.statSync(staticOutPath).size / 1024).toFixed(1);
  console.log(`\nWrote ${staticOutPath} (${sizeKB} KB)`);

  // ── full report JSON ─────────────────────────────────────────────
  function round(x, d) { return typeof x === 'number' ? Math.round(x * 10 ** d) / 10 ** d : x; }

  const report = {
    generated_at: new Date().toISOString(),
    source_jsonl: TIMELINES_JSONL,
    date_min_filter: DATE_MIN,
    holdout_seasons: [...HOLDOUT_SEASONS],
    n_total_lines: total_lines,
    n_usable_matches: all.length,
    n_train_matches: trainMatches.length,
    n_holdout_matches: holdoutMatches.length,
    dropped: { date: dropped_date, consistency: dropped_consistency, parse: dropped_parse },
    resolution_note: 'Regular time: 1-minute buckets (1..45, 46..90), exposure=N_matches exactly (no censoring). Stoppage time: single aggregated bucket per half (not 1-minute) because goals_time2 has no added-time-length field, so per-added-minute exposure for non-scoring matches is unobservable; a flat-intra-stoppage-hazard assumption is used to back out an implied survival curve / average added-minute length from the goal-count decay, and to convert stoppage goal counts to a single flat per-minute rate. See script header comment for full derivation.',
    hazard_shape: {
      windows: {
        '0-15': windowAvgRate(hazardShape, 1, 15),
        '15-30': windowAvgRate(hazardShape, 16, 30),
        '30-45': windowAvgRate(hazardShape, 31, 45),
        '45+stoppage': hazardShape.stoppage1H.flat_rate_per_minute,
        '46-60': windowAvgRate(hazardShape, 46, 60),
        '60-75': windowAvgRate(hazardShape, 61, 75),
        '75-90': windowAvgRate(hazardShape, 76, 90),
        '90+stoppage': hazardShape.stoppage2H.flat_rate_per_minute,
      },
      regular_1h: hazardShape.regular1H,
      regular_2h: hazardShape.regular2H,
      stoppage_1h: hazardShape.stoppage1H,
      stoppage_2h: hazardShape.stoppage2H,
      min_bucket_n_rule: MIN_BUCKET_N,
    },
    state_effect_regression: {
      feature_names: STATE_FEATURE_NAMES,
      n_cells: stateFit.n,
      converged: stateFit.converged,
      iterations: stateFit.iterations,
      final_loglik: stateFit.final_loglik,
      se_ok: stateFit.se_ok,
      coefficients: stateFit.coefficients,
      red_card_effect: {
        own_team_down_a_man: stateFit.coefficients.find((c) => c.name === 'red_own_down'),
        opponent_down_a_man: stateFit.coefficients.find((c) => c.name === 'red_opp_down'),
      },
      ridge_lambda: RIDGE_LAMBDA,
    },
    dispersion,
    validation,
    elapsed_seconds: parseFloat(elapsedS),
  };

  const outPath = path.join(REPORT_DIR, `hazard_fit_summary_${todayStr()}.json`);
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(report, null, 2));
  console.log(`JSON report written to ${outPath}`);
}

main();
