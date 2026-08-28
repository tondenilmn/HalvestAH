// telegram/research/residual_regression.js
//
// Part E2 of LIVE_BETTING_PLAN.md — the decisive question: does anything
// pre-match (opening odds, movement, tier, day/time) predict actual goals
// beyond what the CLOSING-line-implied (lambda_h, lambda_a) already says?
//
// Fits two regularised (L2/ridge) Poisson regressions — one for home goals,
// one for away goals — of the form:
//
//   log E[goals_side] = log(lambda_side_closing)      <- fixed offset (coef=1)
//                      + b1*movement_side
//                      + b2*tier_MAJOR + b3*tier_OTHER
//                      + b4*ah_line_moved (side's own AH line, closing-opening)
//                      + b5*tl_moved (closing-opening)
//                      + b6*weekend
//                      + b7..b9*kickoff_hour_bucket dummies
//
// Estimated via IRLS (Newton-Raphson for the Poisson canonical link) with a
// ridge penalty on the non-intercept, standardised coefficients. Offset's
// coefficient is fixed at exactly 1 (never estimated) so every other
// coefficient is a RESIDUAL effect on top of the closing line.
//
// Fit pooled (all 240k rows) AND independently on 3 chronological thirds
// (walk-forward-lite, per the task's explicitly-allowed simpler variant).
// Decision rule (LIVE_BETTING_PLAN.md E.5): keep a coefficient only if its
// 95% CI excludes 0 in >= 2 of the 3 slices, with a consistent sign.
//
// Also fits the half-split s_tier = sum(HT goals)/sum(FT goals) per tier,
// with a bootstrap CI, joining HT Result + kickoff Time back from the raw
// Bet365 CSVs (E1's JSONL output doesn't carry them).
//
// Run: node telegram/research/residual_regression.js

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');

const REPORT_DIR = path.resolve(__dirname, 'reports');
const E1_JSONL = path.resolve(REPORT_DIR, 'implied_lambda_2026-08-28.jsonl');
const DATA_DIR = path.resolve(__dirname, '../../static/data/Bet365');
const TIERS = ['TOP', 'MAJOR', 'OTHER'];
const FIT_RESIDUAL_MAX = 1e-4;
const RIDGE_LAMBDA = 1.0; // weak ridge on standardised, non-intercept coefficients
const N_SLICES = 3;
const BOOTSTRAP_N = 1000;

function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// ── small stats helpers ─────────────────────────────────────────────────
function mean(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = mean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + (b - m) * (b - m), 0) / (arr.length - 1)) || 1;
}

// ── tiny dense linear algebra (Gauss-Jordan, p is small: ~10) ─────────────
function solveLinearSystem(A, b) {
  // A: p x p array-of-arrays, b: length-p array. Returns x s.t. Ax = b.
  // Also usable to invert A by calling once per unit basis vector.
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    // partial pivot
    let piv = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    if (piv !== col) { const tmp = M[col]; M[col] = M[piv]; M[piv] = tmp; }
    const pivVal = M[col][col];
    if (Math.abs(pivVal) < 1e-300) continue; // singular-ish; leave as is
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
  // inv[i] is column i's solution -> transpose to get the actual inverse
  const out = [];
  for (let r = 0; r < n; r++) {
    out.push(inv.map((col) => col[r]));
  }
  return out;
}

// ── Poisson IRLS with fixed offset + ridge ────────────────────────────────
// X: n x p Float64Array-of-arrays (col 0 = intercept, never penalised).
// y: n goals, offset: n log(lambda_closing).
function fitPoissonRidge(X, y, offset, featureNames) {
  const n = X.length;
  const p = X[0].length;
  let beta = new Array(p).fill(0);
  beta[0] = mean(y.map((yi, i) => Math.log(Math.max(yi, 0.05)) - offset[i])); // rough intercept start

  const penalty = new Array(p).fill(RIDGE_LAMBDA);
  penalty[0] = 0; // never penalise intercept

  let prevObj = -Infinity;
  let iter = 0;
  const maxIter = 60;
  const tol = 1e-10;
  let converged = false;

  for (iter = 1; iter <= maxIter; iter++) {
    const eta = new Array(n);
    const mu = new Array(n);
    for (let i = 0; i < n; i++) {
      let e = offset[i];
      for (let j = 0; j < p; j++) e += X[i][j] * beta[j];
      e = Math.max(-30, Math.min(30, e)); // guard exp overflow
      eta[i] = e;
      mu[i] = Math.exp(e);
    }

    // penalised Poisson log-likelihood (up to the y! constant, which doesn't
    // depend on beta and is dropped) — must be non-decreasing at convergence
    let loglik = 0;
    for (let i = 0; i < n; i++) loglik += y[i] * eta[i] - mu[i];
    let pen = 0;
    for (let j = 0; j < p; j++) pen += 0.5 * penalty[j] * beta[j] * beta[j];
    const obj = loglik - pen;

    // Build weighted normal equations: (X'WX + diag(penalty)) beta_new = X'Wz
    // z = eta - offset + (y - mu) / mu   (linear predictor scale, offset excluded)
    const XtWX = Array.from({ length: p }, () => new Array(p).fill(0));
    const XtWz = new Array(p).fill(0);
    for (let i = 0; i < n; i++) {
      const w = Math.max(mu[i], 1e-8);
      const z = (eta[i] - offset[i]) + (y[i] - mu[i]) / w;
      const xi = X[i];
      for (let a = 0; a < p; a++) {
        const wxa = w * xi[a];
        XtWz[a] += wxa * z;
        for (let b = a; b < p; b++) {
          XtWX[a][b] += wxa * xi[b];
        }
      }
    }
    for (let a = 0; a < p; a++) {
      for (let b = a; b < p; b++) { XtWX[b][a] = XtWX[a][b]; }
      XtWX[a][a] += penalty[a];
    }

    const betaNew = solveLinearSystem(XtWX, XtWz);

    const delta = betaNew.reduce((s, v, j) => s + Math.abs(v - beta[j]), 0);
    beta = betaNew;

    if (obj < prevObj - 1e-6 && iter > 1) {
      // Should not happen for a correctly-implemented Poisson IRLS+ridge
      // step (Newton step on a concave penalised log-lik); flag loudly if it
      // ever does rather than silently continuing.
      console.warn(`  [warn] penalised log-lik decreased at iter ${iter}: ${prevObj.toFixed(3)} -> ${obj.toFixed(3)}`);
    }
    prevObj = obj;

    if (delta < tol) { converged = true; break; }
  }

  // Final mu/W for SE (unpenalised Fisher information at the converged beta
  // — standard practice for ridge-fit GLM SEs when a full sandwich/ridge-
  // adjusted covariance isn't implemented; slightly optimistic vs. the true
  // ridge-adjusted SE, noted as a caveat in the report).
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

  let cov;
  let seOk = true;
  try {
    cov = invertMatrix(XtWX);
  } catch (e) {
    seOk = false;
    cov = Array.from({ length: p }, () => new Array(p).fill(NaN));
  }

  const se = cov.map((row, j) => Math.sqrt(Math.max(row[j], 0)));

  const coefficients = featureNames.map((name, j) => {
    const b = beta[j];
    const s = se[j];
    const lo = b - 1.96 * s;
    const hi = b + 1.96 * s;
    return { name, estimate: b, se: s, ci_lo: lo, ci_hi: hi, excludes_zero: (lo > 0 || hi < 0) };
  });

  let finalLoglik = 0;
  for (let i = 0; i < n; i++) finalLoglik += y[i] * Math.log(Math.max(mu[i], 1e-12)) - mu[i];

  return {
    n, p, iterations: iter, converged, final_penalized_objective: prevObj,
    final_loglik: finalLoglik, se_ok: seOk, coefficients,
  };
}

// ── feature engineering ────────────────────────────────────────────────
function hourBucket(timeStr) {
  if (!timeStr) return 'MID';
  const m = /^(\d{1,2}):(\d{2})/.exec(timeStr.trim());
  if (!m) return 'MID';
  const h = parseInt(m[1], 10);
  if (h < 15) return 'EARLY';
  if (h < 19) return 'MID';
  if (h < 22) return 'EVENING';
  return 'LATE';
}

function dayOfWeekUTC(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  return d.getUTCDay(); // 0=Sun ... 6=Sat
}

// Continuous feature raw values, standardised later.
function rawFeatures(rec, side) {
  const movement = side === 'home'
    ? Math.log(rec.lambda_h) - Math.log(rec.lambda_h0)
    : Math.log(rec.lambda_a) - Math.log(rec.lambda_a0);
  const ahLineMoved = side === 'home'
    ? (rec.ah_home_closing - rec.ah_home_opening)
    : (rec.ah_away_closing - rec.ah_away_opening);
  const tlMoved = rec.tl_closing - rec.tl_opening;
  return { movement, ahLineMoved, tlMoved };
}

const FEATURE_NAMES = [
  'intercept', 'movement', 'tier_MAJOR', 'tier_OTHER', 'ah_line_moved',
  'tl_moved', 'weekend', 'hour_EARLY', 'hour_EVENING', 'hour_LATE',
];

function buildDesignMatrix(records, side, scale) {
  const n = records.length;
  const p = FEATURE_NAMES.length;
  const X = new Array(n);
  const y = new Array(n);
  const offset = new Array(n);
  for (let i = 0; i < n; i++) {
    const rec = records[i];
    const rf = rawFeatures(rec, side);
    const dow = dayOfWeekUTC(rec.date);
    const weekend = (dow === 0 || dow === 6) ? 1 : 0;
    const hb = hourBucket(rec.time);
    const row = new Array(p).fill(0);
    row[0] = 1; // intercept
    row[1] = (rf.movement - scale.movement.mean) / scale.movement.std;
    row[2] = rec.tier === 'MAJOR' ? 1 : 0;
    row[3] = rec.tier === 'OTHER' ? 1 : 0;
    row[4] = (rf.ahLineMoved - scale.ahLineMoved.mean) / scale.ahLineMoved.std;
    row[5] = (rf.tlMoved - scale.tlMoved.mean) / scale.tlMoved.std;
    row[6] = weekend;
    row[7] = hb === 'EARLY' ? 1 : 0;
    row[8] = hb === 'EVENING' ? 1 : 0;
    row[9] = hb === 'LATE' ? 1 : 0;
    X[i] = row;
    y[i] = side === 'home' ? rec.ft_home_goals : rec.ft_away_goals;
    offset[i] = Math.log(Math.max(side === 'home' ? rec.lambda_h : rec.lambda_a, 1e-6));
  }
  return { X, y, offset };
}

function computeScale(records, side) {
  const vals = { movement: [], ahLineMoved: [], tlMoved: [] };
  for (const rec of records) {
    const rf = rawFeatures(rec, side);
    vals.movement.push(rf.movement);
    vals.ahLineMoved.push(rf.ahLineMoved);
    vals.tlMoved.push(rf.tlMoved);
  }
  return {
    movement: { mean: mean(vals.movement), std: std(vals.movement) },
    ahLineMoved: { mean: mean(vals.ahLineMoved), std: std(vals.ahLineMoved) },
    tlMoved: { mean: mean(vals.tlMoved), std: std(vals.tlMoved) },
  };
}

// ── decision rule across slices ────────────────────────────────────────
function decisionRule(sliceFits) {
  // sliceFits: array of {coefficients} for the N_SLICES chronological slices
  const byName = {};
  for (const name of FEATURE_NAMES) {
    const entries = sliceFits.map((f) => f.coefficients.find((c) => c.name === name));
    const excludingZero = entries.filter((e) => e.excludes_zero);
    let consistentSign = false;
    if (excludingZero.length >= 2) {
      const signs = excludingZero.map((e) => Math.sign(e.estimate));
      consistentSign = signs.every((s) => s === signs[0] && s !== 0);
    }
    const survives = excludingZero.length >= 2 && consistentSign;
    byName[name] = {
      slices_excluding_zero: excludingZero.length,
      total_slices: sliceFits.length,
      consistent_sign: consistentSign,
      survives,
    };
  }
  return byName;
}

// ── load E1 JSONL ─────────────────────────────────────────────────────
function loadE1() {
  const lines = fs.readFileSync(E1_JSONL, 'utf8').split('\n').filter((l) => l.trim());
  const records = [];
  let dropped_fit_residual = 0;
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch (e) { continue; }
    const maxResid = Math.max(rec.fit_residual || 0, rec.fit_residual_opening || 0);
    if (!(maxResid <= FIT_RESIDUAL_MAX)) { dropped_fit_residual++; continue; }
    if (!Number.isFinite(rec.lambda_h0) || !Number.isFinite(rec.lambda_a0)) { dropped_fit_residual++; continue; }
    records.push(rec);
  }
  records.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return { records, dropped_fit_residual, total_lines: lines.length };
}

// ── join Time + HT Result back from raw CSVs ───────────────────────────
function loadRawJoinIndex() {
  const files = fs.readdirSync(DATA_DIR).filter((f) => f.toLowerCase().endsWith('.csv'));
  const index = new Map();
  for (const f of files) {
    const csv = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
    const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true });
    for (const r of data) {
      const date = (r['Date'] || '').trim();
      const league = (r['League'] || '').trim();
      const home = (r['Home Team'] || '').trim();
      const away = (r['Away Team'] || '').trim();
      if (!date || !home || !away) continue;
      const key = `${date}|${league}|${home}|${away}`;
      if (index.has(key)) continue; // keep first occurrence on duplicate keys
      index.set(key, { time: (r['Time'] || '').trim(), htResult: (r['HT Result'] || '').trim() });
    }
  }
  return index;
}

function joinRecords(records, index) {
  let joined = 0, missed = 0;
  for (const rec of records) {
    const key = `${rec.date}|${rec.league}|${rec.home}|${rec.away}`;
    const hit = index.get(key);
    if (hit) {
      rec.time = hit.time;
      rec.ht_result = hit.htResult;
      joined++;
    } else {
      rec.time = '';
      rec.ht_result = '';
      missed++;
    }
  }
  return { joined, missed };
}

// ── chronological thirds ───────────────────────────────────────────────
function chronologicalSlices(records, k) {
  const n = records.length;
  const slices = [];
  for (let s = 0; s < k; s++) {
    const start = Math.floor((s / k) * n);
    const end = Math.floor(((s + 1) / k) * n);
    const slice = records.slice(start, end);
    slices.push({
      index: s,
      records: slice,
      date_min: slice[0] ? slice[0].date : null,
      date_max: slice.length ? slice[slice.length - 1].date : null,
      n: slice.length,
    });
  }
  return slices;
}

// ── half-split s_tier ───────────────────────────────────────────────────
function parseScore(str) {
  const m = /^(\d+)\s*-\s*(\d+)$/.exec((str || '').trim());
  if (!m) return null;
  return { h: parseInt(m[1], 10), a: parseInt(m[2], 10) };
}

function halfSplitByTier(records) {
  const out = {};
  for (const tier of TIERS) {
    const rows = records.filter((r) => r.tier === tier);
    const pairs = [];
    for (const r of rows) {
      const ht = parseScore(r.ht_result);
      if (!ht) continue;
      const ftTotal = r.ft_home_goals + r.ft_away_goals;
      const htTotal = ht.h + ht.a;
      if (htTotal > ftTotal) continue; // data error guard (HT can't exceed FT)
      pairs.push({ ht: htTotal, ft: ftTotal });
    }
    const usable = pairs.filter((p) => p.ft > 0 || p.ht > 0); // both-0 pairs contribute 0/0, skip from ratio but count n
    const sumHt = pairs.reduce((s, p) => s + p.ht, 0);
    const sumFt = pairs.reduce((s, p) => s + p.ft, 0);
    const sPoint = sumFt > 0 ? sumHt / sumFt : null;

    // bootstrap CI over matches (percentile method)
    const boot = [];
    if (pairs.length >= 30) {
      for (let b = 0; b < BOOTSTRAP_N; b++) {
        let bh = 0, bf = 0;
        for (let i = 0; i < pairs.length; i++) {
          const idx = Math.floor(Math.random() * pairs.length);
          bh += pairs[idx].ht;
          bf += pairs[idx].ft;
        }
        if (bf > 0) boot.push(bh / bf);
      }
      boot.sort((a, b) => a - b);
    }
    const ciLo = boot.length ? boot[Math.floor(0.025 * boot.length)] : null;
    const ciHi = boot.length ? boot[Math.min(boot.length - 1, Math.floor(0.975 * boot.length))] : null;

    out[tier] = {
      n_matches_with_ht: pairs.length,
      sum_ht_goals: sumHt,
      sum_ft_goals: sumFt,
      s: sPoint,
      bootstrap_ci_lo: ciLo,
      bootstrap_ci_hi: ciHi,
      bootstrap_n: boot.length,
    };
  }
  return out;
}

// ── fit one side across pooled + slices ───────────────────────────────
function fitSide(side, allRecords, slices) {
  const scale = computeScale(allRecords, side); // pooled scaling, reused everywhere for comparability

  const { X, y, offset } = buildDesignMatrix(allRecords, side, scale);
  console.log(`  [${side}] pooled fit: n=${allRecords.length} ...`);
  const pooled = fitPoissonRidge(X, y, offset, FEATURE_NAMES);
  console.log(`  [${side}] pooled: converged=${pooled.converged} iters=${pooled.iterations} loglik=${pooled.final_loglik.toFixed(1)}`);

  const sliceFits = slices.map((sl, idx) => {
    const dm = buildDesignMatrix(sl.records, side, scale);
    console.log(`  [${side}] slice ${idx} (${sl.date_min}..${sl.date_max}, n=${sl.n}) ...`);
    const fit = fitPoissonRidge(dm.X, dm.y, dm.offset, FEATURE_NAMES);
    console.log(`  [${side}] slice ${idx}: converged=${fit.converged} iters=${fit.iterations} loglik=${fit.final_loglik.toFixed(1)}`);
    return { ...fit, date_min: sl.date_min, date_max: sl.date_max };
  });

  const decision = decisionRule(sliceFits);

  return { side, scale, pooled, slices: sliceFits, decision };
}

// ── main ──────────────────────────────────────────────────────────────
function main() {
  const t0 = Date.now();
  console.log(`Loading E1 output from ${E1_JSONL} ...`);
  const { records, dropped_fit_residual, total_lines } = loadE1();
  console.log(`Loaded ${records.length} usable rows (of ${total_lines} lines). Dropped ${dropped_fit_residual} for fit_residual>${FIT_RESIDUAL_MAX} or missing opening fit.`);

  console.log(`Joining Time + HT Result back from raw Bet365 CSVs in ${DATA_DIR} ...`);
  const index = loadRawJoinIndex();
  const { joined, missed } = joinRecords(records, index);
  console.log(`Join: ${joined} matched, ${missed} missed (date+league+home+away key).`);

  const slices = chronologicalSlices(records, N_SLICES);
  for (const sl of slices) console.log(`  slice ${sl.index}: n=${sl.n}, ${sl.date_min} .. ${sl.date_max}`);

  console.log('\nFitting home-goals regression ...');
  const homeFit = fitSide('home', records, slices);
  console.log('\nFitting away-goals regression ...');
  const awayFit = fitSide('away', records, slices);

  console.log('\nComputing half-split s_tier ...');
  const halfSplit = halfSplitByTier(records);

  // ── console report ─────────────────────────────────────────────────
  function printCoeffTable(fitResult) {
    console.log(`\n=== ${fitResult.side.toUpperCase()} GOALS — pooled (n=${fitResult.pooled.n}) ===`);
    for (const c of fitResult.pooled.coefficients) {
      console.log(`  ${c.name.padEnd(14)} b=${c.estimate.toFixed(4).padStart(8)}  SE=${c.se.toFixed(4).padStart(7)}  CI=[${c.ci_lo.toFixed(4)}, ${c.ci_hi.toFixed(4)}]  ${c.excludes_zero ? '*' : ''}`);
    }
    fitResult.slices.forEach((sl, idx) => {
      console.log(`\n  -- slice ${idx} (${sl.date_min}..${sl.date_max}, n=${sl.n}) --`);
      for (const c of sl.coefficients) {
        console.log(`  ${c.name.padEnd(14)} b=${c.estimate.toFixed(4).padStart(8)}  SE=${c.se.toFixed(4).padStart(7)}  CI=[${c.ci_lo.toFixed(4)}, ${c.ci_hi.toFixed(4)}]  ${c.excludes_zero ? '*' : ''}`);
      }
    });
    console.log(`\n  -- decision rule (>=2/3 slices exclude 0, consistent sign) --`);
    for (const name of FEATURE_NAMES) {
      const d = fitResult.decision[name];
      console.log(`  ${name.padEnd(14)} slices_excl0=${d.slices_excluding_zero}/${d.total_slices}  consistent_sign=${d.consistent_sign}  SURVIVES=${d.survives}`);
    }
  }
  printCoeffTable(homeFit);
  printCoeffTable(awayFit);

  console.log('\n=== HALF-SPLIT s_tier (sum HT goals / sum FT goals) ===');
  for (const t of TIERS) {
    const h = halfSplit[t];
    console.log(`  ${t.padEnd(6)} n=${h.n_matches_with_ht}  s=${h.s == null ? 'n/a' : h.s.toFixed(4)}  bootstrap 95% CI=[${h.bootstrap_ci_lo == null ? 'n/a' : h.bootstrap_ci_lo.toFixed(4)}, ${h.bootstrap_ci_hi == null ? 'n/a' : h.bootstrap_ci_hi.toFixed(4)}] (n_boot=${h.bootstrap_n})`);
  }

  const elapsedS = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\nDone in ${elapsedS}s.`);

  // ── JSON report ────────────────────────────────────────────────────
  function serializeFit(fitResult) {
    return {
      side: fitResult.side,
      scale: fitResult.scale,
      pooled: {
        n: fitResult.pooled.n, iterations: fitResult.pooled.iterations,
        converged: fitResult.pooled.converged, final_loglik: fitResult.pooled.final_loglik,
        se_ok: fitResult.pooled.se_ok, coefficients: fitResult.pooled.coefficients,
      },
      slices: fitResult.slices.map((sl) => ({
        date_min: sl.date_min, date_max: sl.date_max, n: sl.n,
        iterations: sl.iterations, converged: sl.converged, final_loglik: sl.final_loglik,
        se_ok: sl.se_ok, coefficients: sl.coefficients,
      })),
      decision: fitResult.decision,
    };
  }

  const outPath = path.join(REPORT_DIR, `residual_regression_${todayStr()}.json`);
  const out = {
    generated_at: new Date().toISOString(),
    source_jsonl: E1_JSONL,
    fit_residual_max: FIT_RESIDUAL_MAX,
    ridge_lambda: RIDGE_LAMBDA,
    n_total_lines: total_lines,
    n_usable_rows: records.length,
    n_dropped_fit_residual: dropped_fit_residual,
    raw_csv_join: { joined, missed },
    n_slices: N_SLICES,
    slices_meta: slices.map((s) => ({ index: s.index, n: s.n, date_min: s.date_min, date_max: s.date_max })),
    feature_names: FEATURE_NAMES,
    home: serializeFit(homeFit),
    away: serializeFit(awayFit),
    half_split_s_by_tier: halfSplit,
    elapsed_seconds: parseFloat(elapsedS),
  };
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nJSON report written to ${outPath}`);
}

main();
