/* telegram/live_model.js — E5 unified in-play pricing engine (HAND-MIRRORED
 * COPY of static/live_model.js — see "Sync requirement" below)
 * ==========================================================================
 * Part E5 of LIVE_BETTING_PLAN.md. One coherent joint score distribution
 * prices EVERY market at ANY minute and ANY in-play state, replacing the
 * old "invert one bucket hit-rate into a single flat lambda per bet" path in
 * `computeLiveOdd` (static/app.js) / `telegram/live_odds.js`.
 *
 * ── Sync requirement (added 2026-08-29 — Railway MODULE_NOT_FOUND fix) ───
 * This file was ORIGINALLY meant to be a single canonical copy living only
 * in static/, required directly from telegram/notify.js via
 * `require('../static/live_model.js')` — that worked in every local/dev
 * environment (whole repo checked out together) but broke in production:
 * Railway's Docker build (telegram/Dockerfile, `COPY . .`) has its build
 * context scoped to the telegram/ directory ONLY (Railway's project Root
 * Directory is set to telegram/) — `../static/` does not exist inside that
 * build context at all, so the deployed container threw
 * `Cannot find module '../static/live_model.js'` at startup. This is
 * exactly the same constraint `telegram/live_odds.js` already documents as
 * its own reason for being a hand-mirrored copy of app.js code rather than
 * a shared require — this file now follows that same established pattern.
 * If you change the pricing model in static/live_model.js, copy the change
 * into this file too (and vice versa) — there is no build step that does
 * this automatically. Data files: this copy reads
 * `telegram/live_model_data/{goal_hazard,lambda_lookup}.json` (a separate,
 * git-tracked copy — NOT telegram/data/, which is gitignored runtime state
 * for track_record.js) instead of static/data/ for the same reason.
 *
 * ── Dual usage (browser + Node) ────────────────────────────────────────
 * Vanilla script, no ES modules. In Node: `require('./live_model.js')` from
 * telegram/ — auto-loads the two JSON files above from disk on first use.
 * In the browser (static/live_model.js only): `<script src="live_model.js">`
 * exposes `window.LiveModel`; call `LiveModel.init({hazard, lambdaLookup})`
 * once with the two fetched JSON blobs before pricing.
 *
 * ── The model ──────────────────────────────────────────────────────────
 *
 *  SCALE (E1) — per-match (lambda_h, lambda_a): full-match expected goals
 *      per side, solved by `telegram/research/implied_lambda.js` from the
 *      de-vigged closing Bet365 1X2 + Over/Under prices (Dixon-Coles). Pass
 *      them in `state.lambda_h/lambda_a`; if absent, `lambdaFromLookup()`
 *      supplies the (AH line, TL, tier) bucket median from
 *      `static/data/lambda_lookup.json`.
 *
 *  HALF SPLIT (E2) — s = fraction of a side's full-match lambda that falls
 *      in the 1st half, estimated per tier from HT scores by
 *      `telegram/research/residual_regression.js`:
 *      TOP 0.44045, MAJOR 0.44467, OTHER 0.44630 (all ~0.44, bootstrap CIs
 *      well away from 0.5 — first halves really are quieter).
 *
 *  SHAPE + STATE (E4) — `static/data/goal_hazard.json`:
 *      `hazard.regular[1..90]`  per-minute per-match TOTAL goal rate
 *      `hazard.stoppage_1h/2h`  flat added-minute rate + avg added minutes
 *      `state_effects`          log-scale multipliers: margin bucket (that
 *                               side's own goal difference), total-goals
 *                               bucket, red cards (own-down x0.604,
 *                               opponent-down x1.628), half.
 *      `dispersion.half1/half2` fitted gamma-Poisson alpha per side-half
 *                               (1H 23.34, 2H 13.45).
 *
 *  STEP 1 — remaining-time integral. `remainingHalfMass(clock)` integrates
 *      the fitted per-minute curve from the current minute to the end of
 *      the half, INCLUDING proportional stoppage-time consumption: the
 *      half's stoppage mass is `flat_rate * avg_added_minutes` at minute
 *      45'00 / 90'00 and decays linearly to zero as the real added minutes
 *      are played (same fix as Phase 0.4 in app.js, which previously froze
 *      the whole stoppage mass at minute 90 forever).
 *
 *  STEP 2 — per-side remaining lambda.
 *      lambda_side_remaining = lambda_side_fullmatch
 *                            * (half==1 ? s : 1-s)
 *                            * remainingHalfMass / baseHalfMass
 *                            * S(state)
 *      S(state) = exp(margin_coef + total_coef + red_coef) relative to the
 *      E4 baseline cell (margin 0, total 0, 11-v-11). The E4 `intercept`
 *      (which is really just the log(1/2) that turns a both-sides hazard
 *      into a per-side one) and the `half2` coefficient are DELIBERATELY
 *      EXCLUDED: they are constants within a half and would double-count
 *      the E2 half split, which already allocates lambda between the two
 *      halves from real HT-score data.
 *
 *  STEP 3 — gamma-Poisson update from goals already scored THIS HALF.
 *      Per side and half, with exposure measured in units of "one whole
 *      half's hazard mass" (so the full half is exposure 1.0):
 *          prior   R ~ Gamma(alpha, beta),  beta = alpha / lambda_side_half
 *                  => E[R] = lambda_side_half, as required.
 *          observe k goals by that side over elapsed exposure m = 1 - f
 *                  (f = remaining mass fraction)
 *          post    R ~ Gamma(alpha + k, beta + m)
 *          remaining count over exposure e = f * S(state):
 *                  N | R ~ Poisson(R e)  =>  N ~ NegBinomial
 *                  r = alpha + k,  mean mu = r*e/(beta + m)
 *                  P(N=n) = C(n+r-1, n) (1-q)^r q^n,  q = mu/(r+mu)
 *      k = 0, m = 0 recovers exactly the un-updated mean, and 2 goals
 *      already scored by a side raise its remaining mean by (alpha+2)/alpha
 *      (x1.15 in the 2nd half) — the "3 goals by 60' should raise, not
 *      lower, the expectation" blind spot of the old model (A.3).
 *
 *  STEP 4 — price any market by convolving/enumerating the joint. Home and
 *      away counts are treated as INDEPENDENT negative binomials. See
 *      "Known simplifications" below.
 *
 *  CONFIDENCE INTERVALS — real Monte Carlo (default 500 samples), not the
 *      old "run the same function twice at the Wilson lower bound" trick:
 *        (a) SCALE uncertainty: resample a joint (lambda_h, lambda_a) pair
 *            from the match's (line, TL, tier) bucket in lambda_lookup.json
 *            and apply it as a MULTIPLICATIVE ratio vs. the bucket median,
 *            so the match's own point lambda is preserved and only the
 *            bucket's empirical spread is borrowed. Falls back to an
 *            independent lognormal (sd 0.18 on the log scale) when the
 *            bucket is too thin to carry pairs.
 *        (b) RATE uncertainty: draw R from each segment's posterior
 *            Gamma(alpha+k, beta+m), then price that sample's market from
 *            Poisson counts at that R. Averaging over draws reproduces the
 *            analytic negative binomial exactly, so this adds spread
 *            WITHOUT double-counting the dispersion already in the point
 *            estimate.
 *      lo/hi are the 5th/95th percentiles of the market probability across
 *      samples. `p` stays the analytic (exact) value; `p_mc` is the MC mean
 *      and should sit within MC noise of `p` — a built-in self-check.
 *
 * ── Known simplifications (be honest about them) ───────────────────────
 *  1. HOME/AWAY INDEPENDENCE. The remaining-goal counts of the two sides
 *     are convolved as independent. E1's Dixon-Coles rho is carried on the
 *     state for reference but is NOT applied in-play: rho is a low-score
 *     correction fitted on FULL-MATCH 0-0/1-0/0-1/1-1 frequencies and there
 *     is no fitted equivalent for a remainder-of-match distribution. It
 *     mostly matters for exact low scores (draw / correct score / BTTS at
 *     kickoff) and shrinks as the remaining window shrinks.
 *  2. ELAPSED EXPOSURE IS STATE-BLIND. The gamma-Poisson denominator uses
 *     pure timing mass (1 - f); we don't replay the state multipliers the
 *     match actually passed through (we usually don't have the history). A
 *     side that spent 40 minutes a man up therefore gets a slightly
 *     understated exposure, mildly inflating its posterior.
 *  3. FUTURE-HALF STATE. When pricing a match-scope market during the 1st
 *     half, the not-yet-played 2nd half carries the RED-CARD multiplier
 *     (a sending-off persists) but resets margin/total to baseline (the
 *     score at minute 46 is unknown and is exactly what the model is
 *     integrating over).
 *  4. HT SCORE DEFAULT. In the 2nd half, `goals this half` needs the HT
 *     score. If neither `ht_home_goals/ht_away_goals` nor
 *     `goals_this_half_h/a` is supplied, we assume HT == the current score
 *     (i.e. k = 0, no gamma update) — the conservative choice, matching the
 *     old model rather than silently inventing an update.
 *  5. NEXT-GOAL SIDE SPLIT. P(no goal in window) is exact under the model
 *     (product of the two sides' NB zero-probabilities over the window
 *     exposure); the split of the remainder between home-first and
 *     away-first is done proportionally to the sides' posterior mean window
 *     rates, which is exact for homogeneous Poisson and a very good
 *     approximation here.
 *  6. E4's hazard/state layer is pooled across the 12 goals_time2 leagues
 *     and carries NO strength conditioning (no Elo signal in that data) —
 *     all strength information enters through E1's lambda.
 *
 * ── Public API ─────────────────────────────────────────────────────────
 *   init({hazard, lambdaLookup})            (browser; Node auto-loads)
 *   parseClock(minute)                      -> {half, reg, stop, played, label}
 *   lambdaFromLookup({ah_line, tl, tier})   -> {lambda_h, lambda_a, key, n, level}
 *   priceMarket(spec, state, minute, opts)  -> {p, lo, hi, fair_odds, ...}
 *   priceLadder(specs, state, minute, opts) -> [results...]   (shared MC draws)
 *   simulateMatch(state, minute, opts)      -> sampled final-score summary
 *   scoreDistribution(state, minute, opts)  -> raw pmfs (diagnostics)
 * ========================================================================== */
'use strict';

(function (root, factory) {
  var api = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.LiveModel = api;
}(typeof globalThis !== 'undefined' ? globalThis : this, function () {

  // ── E2: half split (fraction of full-match lambda falling in the 1H) ────
  // telegram/research/reports/residual_regression_2026-08-28.json
  // -> half_split_s_by_tier (bootstrap CIs: TOP ±0.008, MAJOR/OTHER ±0.003)
  var HALF_SPLIT_S = { TOP: 0.44045, MAJOR: 0.44467, OTHER: 0.44630 };
  var HALF_SPLIT_DEFAULT = 0.4463;

  // Per side, per scope. The pmfs are truncated here, so any market that is
// mathematically certain prices at 1 - O(1e-8) rather than exactly 1, and
// mutually-exclusive sets (1X2, over+under) sum to 1 - O(1e-8). 20 keeps
// that residual below 1e-7 even at kickoff with a high-lambda match; the
// cost is a 21x21 joint grid, which is nothing.
var MAX_GOALS = 20;
  var DEFAULT_MC_SAMPLES = 500;
  var LOGNORMAL_FALLBACK_SD = 0.18; // log-scale sd when a bucket has no pairs
  var DEFAULT_SEED = 0x5eed1a3;

  var _hazard = null;
  var _lookup = null;
  var _coefMap = null;

  // ── Data loading ────────────────────────────────────────────────────────
  function init(opts) {
    opts = opts || {};
    if (opts.hazard) _hazard = opts.hazard;
    if (opts.lambdaLookup) _lookup = opts.lambdaLookup;
    if (!_hazard || !_lookup) _autoLoadNode();
    if (_hazard && !_coefMap) _buildCoefMap();
    return { hazardLoaded: !!_hazard, lookupLoaded: !!_lookup };
  }

  function _autoLoadNode() {
    if (typeof module === 'undefined' || typeof require === 'undefined') return;
    try {
      var fs = require('fs');
      var path = require('path');
      var dir = path.resolve(__dirname, 'live_model_data'); // telegram/ copy — see header "Sync requirement"
      if (!_hazard) _hazard = JSON.parse(fs.readFileSync(path.join(dir, 'goal_hazard.json'), 'utf8'));
      if (!_lookup) {
        var lp = path.join(dir, 'lambda_lookup.json');
        if (fs.existsSync(lp)) _lookup = JSON.parse(fs.readFileSync(lp, 'utf8'));
      }
    } catch (e) { /* browser or missing files — init() must be called */ }
  }

  function _ensure() {
    if (!_hazard) _autoLoadNode();
    if (!_hazard) throw new Error('LiveModel: goal_hazard.json not loaded — call LiveModel.init({hazard, lambdaLookup})');
    if (!_coefMap) _buildCoefMap();
  }

  function _buildCoefMap() {
    _coefMap = {};
    var cs = _hazard.state_effects.coefficients;
    for (var i = 0; i < cs.length; i++) _coefMap[cs[i].name] = cs[i].estimate;
  }

  // ── Small numerics ──────────────────────────────────────────────────────
  var _LANCZOS = [
    676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012,
    9.9843695780195716e-6, 1.5056327351493116e-7
  ];
  function lgamma(z) {
    if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lgamma(1 - z);
    z -= 1;
    var x = 0.99999999999980993;
    for (var i = 0; i < _LANCZOS.length; i++) x += _LANCZOS[i] / (z + i + 1);
    var t = z + _LANCZOS.length - 0.5;
    return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x);
  }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function randNormal(rng) {
    var u = 0, v = 0;
    while (u === 0) u = rng();
    while (v === 0) v = rng();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }
  // Marsaglia-Tsang. shape > 0, rate > 0 (mean = shape/rate).
  function randGamma(shape, rate, rng) {
    if (shape < 1) return randGamma(shape + 1, rate, rng) * Math.pow(rng(), 1 / shape);
    var d = shape - 1 / 3, c = 1 / Math.sqrt(9 * d);
    for (;;) {
      var x = randNormal(rng);
      var v = 1 + c * x;
      if (v <= 0) continue;
      v = v * v * v;
      var u = rng();
      if (u < 1 - 0.0331 * x * x * x * x) return (d * v) / rate;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return (d * v) / rate;
    }
  }

  function poissonPmf(mean, maxN) {
    var out = new Array(maxN + 1).fill(0);
    if (!(mean > 0)) { out[0] = 1; return out; }
    var p = Math.exp(-mean);
    out[0] = p;
    for (var n = 1; n <= maxN; n++) { p = p * mean / n; out[n] = p; }
    return out;
  }
  // NegBinomial with real shape r and mean mu.
  function nbPmf(r, mu, maxN) {
    var out = new Array(maxN + 1).fill(0);
    if (!(mu > 0)) { out[0] = 1; return out; }
    if (!(r > 0)) return poissonPmf(mu, maxN);
    var q = mu / (r + mu);
    var log1mq = Math.log(1 - q), logq = Math.log(q);
    for (var n = 0; n <= maxN; n++) {
      out[n] = Math.exp(lgamma(n + r) - lgamma(r) - lgamma(n + 1) + r * log1mq + n * logq);
    }
    return out;
  }
  function convolve(a, b, maxN) {
    var out = new Array(maxN + 1).fill(0);
    for (var i = 0; i <= maxN; i++) {
      if (!a[i]) continue;
      for (var j = 0; i + j <= maxN; j++) out[i + j] += a[i] * b[j];
    }
    return out;
  }
  function percentile(sortedArr, q) {
    if (!sortedArr.length) return null;
    var idx = Math.max(0, Math.min(sortedArr.length - 1, Math.floor(q * (sortedArr.length - 1))));
    return sortedArr[idx];
  }

  // ── Clock ───────────────────────────────────────────────────────────────
  // Real minutes PLAYED, with stoppage kept separate (Phase 0.4's lesson:
  // '90+4' must not collapse to 94 == "minute 94 of regular time").
  //   number m : m<=45 -> 1H reg m ; 45<m<=90 -> 2H reg m-45 ; m>90 -> 2H stoppage m-90
  //   string   : '67', '45+2', '90+4', 'HT', 'FT'
  //   object   : {half, reg, stop}
  function parseClock(minute) {
    if (minute && typeof minute === 'object' && minute.half) {
      var h = minute.half === 2 ? 2 : 1;
      return _mkClock(h, Math.max(0, Math.min(45, minute.reg || 0)), Math.max(0, minute.stop || 0));
    }
    if (typeof minute === 'string') {
      var s = minute.trim().toUpperCase().replace(/'/g, '');
      if (s === 'HT') return _mkClock(2, 0, 0);
      if (s === 'FT') return _mkClock(2, 45, 99);
      var m = s.match(/^(\d+)\s*\+\s*(\d+)$/);
      if (m) {
        var base = parseInt(m[1], 10), extra = parseInt(m[2], 10);
        return base <= 45 ? _mkClock(1, 45, extra) : _mkClock(2, 45, extra);
      }
      var num = parseFloat(s);
      if (!isNaN(num)) return parseClock(num);
      throw new Error('LiveModel.parseClock: unparseable minute "' + minute + '"');
    }
    var v = Number(minute);
    if (!isFinite(v)) throw new Error('LiveModel.parseClock: bad minute ' + minute);
    if (v <= 45) return _mkClock(1, Math.max(0, v), 0);
    if (v <= 90) return _mkClock(2, v - 45, 0);
    return _mkClock(2, 45, v - 90);
  }
  function _mkClock(half, reg, stop) {
    return {
      half: half, reg: reg, stop: stop,
      played: (half === 1 ? reg : 45 + reg) + stop,
      label: stop > 0 ? ((half === 1 ? 45 : 90) + "+" + Math.round(stop) + "'")
                      : ((half === 1 ? reg : 45 + reg).toFixed(0) + "'")
    };
  }

  // ── Hazard mass integrals (step 1) ──────────────────────────────────────
  function _stopSpec(half) {
    return half === 1 ? _hazard.hazard.stoppage_1h : _hazard.hazard.stoppage_2h;
  }
  // Integral of the fitted per-minute curve over regular-time minutes
  // [fromReg, toReg] of `half` (both in 0..45). Minute index i covers the
  // interval [i-1, i], so partial minutes are pro-rated linearly.
  function regularMass(half, fromReg, toReg) {
    _ensure();
    var arr = _hazard.hazard.regular;
    var base = half === 1 ? 0 : 45;
    var a = Math.max(0, Math.min(45, fromReg)), b = Math.max(0, Math.min(45, toReg));
    if (b <= a) return 0;
    var total = 0;
    for (var i = Math.floor(a) + 1; i <= Math.ceil(b); i++) {
      var lo = Math.max(a, i - 1), hi = Math.min(b, i);
      if (hi > lo) total += arr[base + i] * (hi - lo);
    }
    return total;
  }
  function stoppageMassTotal(half) {
    var sp = _stopSpec(half);
    return sp.flat_rate_per_minute * sp.avg_added_minutes;
  }
  function stoppageMassRemaining(half, stopPlayed) {
    var sp = _stopSpec(half);
    return sp.flat_rate_per_minute * Math.max(0, sp.avg_added_minutes - (stopPlayed || 0));
  }
  function baseHalfMass(half) { _ensure(); return regularMass(half, 0, 45) + stoppageMassTotal(half); }
  function remainingHalfMass(clock) {
    _ensure();
    return regularMass(clock.half, clock.reg, 45) + stoppageMassRemaining(clock.half, clock.stop);
  }
  // Fraction of the current half's total goal mass still to be played.
  function remainingFraction(clock) {
    var b = baseHalfMass(clock.half);
    return b > 0 ? Math.max(0, Math.min(1, remainingHalfMass(clock) / b)) : 0;
  }

  // Mass fraction of each half consumed by a window of `win` real minutes
  // starting at `clock`. Returns {h1, h2} fractions (of that half's base).
  function windowFractions(clock, win) {
    var out = { h1: 0, h2: 0 };
    var w = Math.max(0, win);
    var half = clock.half;
    var sp = _stopSpec(half);
    var regAvail = 45 - clock.reg;
    var base = baseHalfMass(half);
    var key = half === 1 ? 'h1' : 'h2';
    var regUse = Math.min(w, regAvail);
    var mass = regularMass(half, clock.reg, clock.reg + regUse);
    w -= regUse;
    if (w > 0) {
      var stopAvail = Math.max(0, sp.avg_added_minutes - clock.stop);
      var stopUse = Math.min(w, stopAvail);
      mass += sp.flat_rate_per_minute * stopUse;
      w -= stopAvail; // consuming the whole stoppage window ends the half
    }
    out[key] = base > 0 ? mass / base : 0;
    if (w > 0 && half === 1) {
      var b2 = baseHalfMass(2);
      var sp2 = _stopSpec(2);
      var reg2 = Math.min(w, 45);
      var mass2 = regularMass(2, 0, reg2);
      var w2 = w - reg2;
      if (w2 > 0) mass2 += sp2.flat_rate_per_minute * Math.min(w2, sp2.avg_added_minutes);
      out.h2 = b2 > 0 ? Math.min(1, mass2 / b2) : 0;
    }
    return out;
  }

  // ── State multipliers (step 2) ──────────────────────────────────────────
  function _marginKey(d) {
    if (d <= -2) return 'margin_m2';
    if (d === -1) return 'margin_m1';
    if (d === 0) return null;      // baseline
    if (d === 1) return 'margin_p1';
    return 'margin_p2';
  }
  function _totalKey(t) {
    if (t <= 0) return null;       // baseline
    if (t === 1) return 'total_t1';
    if (t === 2) return 'total_t2';
    return 'total_t3p';
  }
  // S(state) for ONE side, relative to E4's baseline cell.
  // `intercept` and `half2` are excluded on purpose — see the header.
  function stateMultiplier(opts) {
    _ensure();
    var log = 0;
    if (!opts.ignoreScoreState) {
      var mk = _marginKey(opts.margin | 0);
      if (mk) log += _coefMap[mk];
      var tk = _totalKey(opts.totalGoals | 0);
      if (tk) log += _coefMap[tk];
    }
    var own = opts.ownReds || 0, opp = opts.oppReds || 0;
    if (own > opp) log += _coefMap.red_own_down * Math.min(2, own - opp);
    else if (opp > own) log += _coefMap.red_opp_down * Math.min(2, opp - own);
    return Math.exp(log);
  }

  // ── Scale lookup ────────────────────────────────────────────────────────
  function _bucketKeys(ctx) {
    var L = Math.max(-4, Math.min(4, Math.round((ctx.ah_line || 0) / 0.25) * 0.25));
    var T = Math.max(1.5, Math.min(5.5, Math.round((ctx.tl || 2.5) / 0.5) * 0.5));
    var tier = ctx.tier || 'OTHER';
    return [L + '|' + T + '|' + tier, L + '|' + T + '|ANY', L + '|ANY|ANY', 'GLOBAL'];
  }
  function _lookupCell(ctx, needPairs) {
    if (!_lookup) _autoLoadNode();
    if (!_lookup) return null;
    var keys = _bucketKeys(ctx);
    for (var i = 0; i < keys.length; i++) {
      var c = _lookup.cells[keys[i]];
      if (c && (!needPairs || (c.pairs && c.pairs.length >= 2))) {
        return { cell: c, key: keys[i], level: i };
      }
    }
    return null;
  }
  // Bucket-median fallback scale when a match's own implied lambdas are absent.
  function lambdaFromLookup(ctx) {
    var f = _lookupCell(ctx, false);
    if (!f) return null;
    return { lambda_h: f.cell.mh, lambda_a: f.cell.ma, n: f.cell.n, key: f.key, level: f.level };
  }

  // ── Segments (step 2 + 3) ───────────────────────────────────────────────
  // A "segment" is one side's remaining exposure inside one half, with its
  // own gamma-Poisson posterior.
  function _mkSegment(alpha, lamHalf, k, m, remFrac, S) {
    var lam = Math.max(1e-6, lamHalf);
    var beta = alpha / lam;
    var r = alpha + k;
    var betaPost = beta + m;
    var eRem = Math.max(0, remFrac) * S;
    return {
      r: r, betaPost: betaPost, eRem: eRem, mu: (r * eRem) / betaPost,
      alpha: alpha, k: k, m: m, remFrac: remFrac, S: S, lamHalf: lam
    };
  }

  function _halfSplit(tier) {
    var s = HALF_SPLIT_S[tier];
    return (typeof s === 'number') ? s : HALF_SPLIT_DEFAULT;
  }

  function _normState(state) {
    var hg = state.home_goals || 0, ag = state.away_goals || 0;
    var s = {
      lambda_h: state.lambda_h, lambda_a: state.lambda_a,
      rho: state.rho,
      home_goals: hg, away_goals: ag,
      red_h: state.red_h || 0, red_a: state.red_a || 0,
      tier: state.tier || 'OTHER',
      ah_line: state.ah_line, tl: state.tl,
      lookup_source: null
    };
    if (!(s.lambda_h > 0) || !(s.lambda_a > 0)) {
      var f = lambdaFromLookup({ ah_line: state.ah_line, tl: state.tl, tier: s.tier });
      if (!f) throw new Error('LiveModel: no lambda_h/lambda_a given and lambda_lookup.json unavailable');
      s.lambda_h = f.lambda_h; s.lambda_a = f.lambda_a;
      s.lookup_source = { key: f.key, level: f.level, n: f.n };
    }
    // Goals scored in the CURRENT half, per side.
    if (typeof state.goals_this_half_h === 'number' && typeof state.goals_this_half_a === 'number') {
      s.gh_h = state.goals_this_half_h; s.gh_a = state.goals_this_half_a;
    } else if (typeof state.ht_home_goals === 'number' && typeof state.ht_away_goals === 'number') {
      s.ht_h = state.ht_home_goals; s.ht_a = state.ht_away_goals;
    }
    return s;
  }

  function _thisHalfGoals(s, clock) {
    if (typeof s.gh_h === 'number') return [Math.max(0, s.gh_h), Math.max(0, s.gh_a)];
    if (clock.half === 1) return [s.home_goals, s.away_goals];
    if (typeof s.ht_h === 'number') {
      return [Math.max(0, s.home_goals - s.ht_h), Math.max(0, s.away_goals - s.ht_a)];
    }
    return [0, 0]; // simplification 4: assume HT == current score
  }

  // Build both sides' segment lists. `scopeAllHalves` includes the not-yet-
  // played 2nd half when we are still in the 1st.
  function buildSegments(s, clock, scopeAllHalves, lamH, lamA) {
    _ensure();
    var alpha1 = _hazard.dispersion.half1.alpha;
    var alpha2 = _hazard.dispersion.half2.alpha;
    var split = _halfSplit(s.tier);
    var f = remainingFraction(clock);
    var thg = _thisHalfGoals(s, clock);
    var totalGoals = s.home_goals + s.away_goals;

    function side(isHome) {
      var lamFull = isHome ? lamH : lamA;
      var g = isHome ? s.home_goals : s.away_goals;
      var og = isHome ? s.away_goals : s.home_goals;
      var ownR = isHome ? s.red_h : s.red_a;
      var oppR = isHome ? s.red_a : s.red_h;
      var S = stateMultiplier({ margin: g - og, totalGoals: totalGoals, ownReds: ownR, oppReds: oppR });
      var Sfuture = stateMultiplier({ ignoreScoreState: true, ownReds: ownR, oppReds: oppR });
      var k = isHome ? thg[0] : thg[1];
      var segs = [];
      var lamThisHalf = lamFull * (clock.half === 1 ? split : (1 - split));
      var alphaThis = clock.half === 1 ? alpha1 : alpha2;
      segs.push(_mkSegment(alphaThis, lamThisHalf, k, 1 - f, f, S));
      if (scopeAllHalves && clock.half === 1) {
        segs.push(_mkSegment(alpha2, lamFull * (1 - split), 0, 0, 1, Sfuture));
      }
      return segs;
    }
    return { home: side(true), away: side(false), remFrac: f, split: split };
  }

  // Analytic pmf of a side's remaining goals: convolution of its segments' NBs.
  function _sidePmf(segs, maxN) {
    var out = nbPmf(segs[0].r, segs[0].mu, maxN);
    for (var i = 1; i < segs.length; i++) out = convolve(out, nbPmf(segs[i].r, segs[i].mu, maxN), maxN);
    return out;
  }
  // One MC draw for a side: sample R per segment from its posterior Gamma,
  // sum the Poisson means. Returns BOTH the current-half-only pmf and the
  // all-remaining-halves pmf from the SAME draws, so half-scoped and
  // match-scoped markets stay mutually consistent within one sample.
  function _sidePmfSampled(segs, maxN, rng) {
    var meanHalf = 0, meanAll = 0;
    for (var i = 0; i < segs.length; i++) {
      var R = randGamma(segs[i].r, segs[i].betaPost, rng);
      var m = R * segs[i].eRem;
      meanAll += m;
      if (i === 0) meanHalf = m;
    }
    var all = poissonPmf(meanAll, maxN);
    return { all: all, half: segs.length > 1 ? poissonPmf(meanHalf, maxN) : all };
  }

  // ── Market evaluation from a joint pmf pair ─────────────────────────────
  // spec.scope: 'match'           FT market, includes goals already scored
  //             'half'            whole current half, incl. this half's goals
  //             'remainder'       future goals only, rest of match
  //             'half_remainder'  future goals only, rest of current half
  function _scopeInfo(spec, s, clock) {
    var scope = spec.scope || 'match';
    var allHalves = (scope === 'match' || scope === 'remainder');
    var thg = _thisHalfGoals(s, clock);
    var offH = 0, offA = 0;
    if (scope === 'match') { offH = s.home_goals; offA = s.away_goals; }
    else if (scope === 'half') { offH = thg[0]; offA = thg[1]; }
    return { scope: scope, allHalves: allHalves, offH: offH, offA: offA };
  }

  function _evalMarket(spec, pmfH, pmfA, info, maxN) {
    var i, j, p = 0;
    switch (spec.type) {
      case 'over':
      case 'under': {
        var line = spec.line;
        // total = offset + future goals; over line <=> total > line
        var tot = convolve(pmfH, pmfA, maxN);
        var over = 0;
        for (i = 0; i <= maxN; i++) if (info.offH + info.offA + i > line) over += tot[i];
        p = (spec.type === 'over') ? over : 1 - over;
        break;
      }
      case 'btts': {
        // P(home total >= 1 AND away total >= 1)
        var pH = info.offH >= 1 ? 1 : 1 - pmfH[0];
        var pA = info.offA >= 1 ? 1 : 1 - pmfA[0];
        p = pH * pA;
        var yes = spec.yes === false ? false : true;
        p = yes ? p : 1 - p;
        break;
      }
      case 'result': {
        var ph = 0, pd = 0, pa = 0;
        for (i = 0; i <= maxN; i++) {
          if (!pmfH[i]) continue;
          for (j = 0; j <= maxN; j++) {
            if (!pmfA[j]) continue;
            var w = pmfH[i] * pmfA[j];
            var d = (info.offH + i) - (info.offA + j);
            if (d > 0) ph += w; else if (d < 0) pa += w; else pd += w;
          }
        }
        p = spec.side === 'home' ? ph : (spec.side === 'away' ? pa : pd);
        break;
      }
      case 'correct_score': {
        var needH = spec.home - info.offH, needA = spec.away - info.offA;
        p = (needH >= 0 && needA >= 0 && needH <= maxN && needA <= maxN)
          ? pmfH[needH] * pmfA[needA] : 0;
        break;
      }
      default:
        throw new Error('LiveModel: unknown market type "' + spec.type + '"');
    }
    return Math.max(0, Math.min(1, p));
  }

  // ── Next-goal market (competing hazards over a window) ──────────────────
  function _nextGoalProbs(s, clock, win, lamH, lamA) {
    var wf = windowFractions(clock, win);
    var alpha1 = _hazard.dispersion.half1.alpha;
    var alpha2 = _hazard.dispersion.half2.alpha;
    var split = _halfSplit(s.tier);
    var f = remainingFraction(clock);
    var thg = _thisHalfGoals(s, clock);
    var totalGoals = s.home_goals + s.away_goals;

    function side(isHome) {
      var lamFull = isHome ? lamH : lamA;
      var g = isHome ? s.home_goals : s.away_goals;
      var og = isHome ? s.away_goals : s.home_goals;
      var ownR = isHome ? s.red_h : s.red_a;
      var oppR = isHome ? s.red_a : s.red_h;
      var S = stateMultiplier({ margin: g - og, totalGoals: totalGoals, ownReds: ownR, oppReds: oppR });
      var Sf = stateMultiplier({ ignoreScoreState: true, ownReds: ownR, oppReds: oppR });
      var k = isHome ? thg[0] : thg[1];
      var out = [];
      var wCur = clock.half === 1 ? wf.h1 : wf.h2;
      out.push(_mkSegment(clock.half === 1 ? alpha1 : alpha2,
        lamFull * (clock.half === 1 ? split : (1 - split)), k, 1 - f, Math.min(wCur, f), S));
      if (clock.half === 1 && wf.h2 > 0) {
        out.push(_mkSegment(alpha2, lamFull * (1 - split), 0, 0, wf.h2, Sf));
      }
      return out;
    }
    var sh = side(true), sa = side(false);
    function p0(segs) {
      var v = 1;
      for (var i = 0; i < segs.length; i++) {
        v *= Math.pow(segs[i].betaPost / (segs[i].betaPost + segs[i].eRem), segs[i].r);
      }
      return v;
    }
    function mean(segs) {
      var v = 0;
      for (var i = 0; i < segs.length; i++) v += segs[i].mu;
      return v;
    }
    var pNone = p0(sh) * p0(sa);
    var mh = mean(sh), ma = mean(sa);
    var shr = (mh + ma) > 0 ? mh / (mh + ma) : 0.5;
    return { none: pNone, home: (1 - pNone) * shr, away: (1 - pNone) * (1 - shr), meanH: mh, meanA: ma };
  }

  // ── Scale resampling for the CI ─────────────────────────────────────────
  function _scaleSampler(s, rng) {
    var f = _lookupCell({ ah_line: s.ah_line, tl: s.tl, tier: s.tier }, true);
    if (f && f.cell.pairs && f.cell.mh > 0 && f.cell.ma > 0) {
      var pairs = f.cell.pairs, mh = f.cell.mh, ma = f.cell.ma;
      var sampler = function () {
        var pr = pairs[Math.floor(rng() * pairs.length) % pairs.length];
        return [s.lambda_h * (pr[0] / mh), s.lambda_a * (pr[1] / ma)];
      };
      sampler.source = { key: f.key, level: f.level, n: f.cell.n, mode: 'bucket_pairs' };
      return sampler;
    }
    var sampler2 = function () {
      return [
        s.lambda_h * Math.exp(LOGNORMAL_FALLBACK_SD * randNormal(rng)),
        s.lambda_a * Math.exp(LOGNORMAL_FALLBACK_SD * randNormal(rng))
      ];
    };
    sampler2.source = { mode: 'lognormal_fallback', sd: LOGNORMAL_FALLBACK_SD };
    return sampler2;
  }

  // ── Public: price one market ────────────────────────────────────────────
  function priceMarket(spec, state, minute, opts) {
    return priceLadder([spec], state, minute, opts)[0];
  }

  // Price several markets from ONE set of Monte-Carlo draws — every market
  // in the ladder is then guaranteed internally consistent sample by sample
  // (an over-0.5 CI can never contradict an over-1.5 CI).
  function priceLadder(specs, state, minute, opts) {
    _ensure();
    opts = opts || {};
    var samples = opts.samples == null ? DEFAULT_MC_SAMPLES : opts.samples;
    var maxN = opts.maxGoals || MAX_GOALS;
    var rng = mulberry32(opts.seed == null ? DEFAULT_SEED : opts.seed);
    // Exchange commission (e.g. Betfair ~2-5%), taken as a fraction of NET
    // winnings on both sides of the book, not of turnover. 0 = no commission
    // (soft-bookmaker / Bet365 pricing — the historical default, unchanged).
    var commission = opts.commission || 0;
    var s = _normState(state);
    var clock = parseClock(minute);

    // ---- analytic point estimates -------------------------------------
    var segCacheAll = buildSegments(s, clock, true, s.lambda_h, s.lambda_a);
    var segCacheHalf = { home: [segCacheAll.home[0]], away: [segCacheAll.away[0]] };
    var pmfAll = { h: _sidePmf(segCacheAll.home, maxN), a: _sidePmf(segCacheAll.away, maxN) };
    var pmfHalf = (segCacheAll.home.length > 1)
      ? { h: _sidePmf(segCacheHalf.home, maxN), a: _sidePmf(segCacheHalf.away, maxN) }
      : pmfAll;

    var results = specs.map(function (spec) {
      var info = _scopeInfo(spec, s, clock);
      var p;
      if (spec.type === 'nextgoal') {
        var ng = _nextGoalProbs(s, clock, spec.window == null ? 15 : spec.window, s.lambda_h, s.lambda_a);
        p = spec.side === 'home' ? ng.home : (spec.side === 'away' ? ng.away : ng.none);
      } else {
        var P = info.allHalves ? pmfAll : pmfHalf;
        p = _evalMarket(spec, P.h, P.a, info, maxN);
      }
      return { spec: spec, info: info, p: p, samples: [] };
    });

    // ---- Monte-Carlo CI ------------------------------------------------
    var scaleSampler = _scaleSampler(s, rng);
    var mcSum = results.map(function () { return 0; });
    if (samples > 0) {
      for (var t = 0; t < samples; t++) {
        var lam = scaleSampler();
        var segs = buildSegments(s, clock, true, lam[0], lam[1]);
        var dh = _sidePmfSampled(segs.home, maxN, rng);
        var da = _sidePmfSampled(segs.away, maxN, rng);
        var sh = dh.all, sa = da.all, shHalf = dh.half, saHalf = da.half;
        for (var i = 0; i < results.length; i++) {
          var R = results[i], v;
          if (R.spec.type === 'nextgoal') {
            var ng2 = _nextGoalProbs(s, clock, R.spec.window == null ? 15 : R.spec.window, lam[0], lam[1]);
            v = R.spec.side === 'home' ? ng2.home : (R.spec.side === 'away' ? ng2.away : ng2.none);
          } else {
            v = _evalMarket(R.spec, R.info.allHalves ? sh : shHalf, R.info.allHalves ? sa : saHalf, R.info, maxN);
          }
          R.samples.push(v);
          mcSum[i] += v;
        }
      }
    }

    return results.map(function (R, i) {
      var lo = null, hi = null, pmc = null;
      if (R.samples.length) {
        R.samples.sort(function (x, y) { return x - y; });
        lo = percentile(R.samples, 0.05);
        hi = percentile(R.samples, 0.95);
        pmc = mcSum[i] / R.samples.length;
        // The analytic p is the exact mean of the MC distribution; with a
        // very skewed distribution a percentile can still cross it, so we
        // widen (never narrow) to keep lo <= p <= hi an invariant callers
        // can rely on.
        lo = Math.min(lo, R.p); hi = Math.max(hi, R.p);
      }
      return {
        market: _describe(R.spec),
        spec: R.spec,
        minute: clock.label,
        clock: clock,
        p: R.p,
        lo: lo, hi: hi, p_mc: pmc,
        fair_odds: R.p > 0 ? 1 / R.p : null,
        // Zero-commission breakeven prices (soft-bookmaker convention —
        // unchanged from before commission support was added).
        min_back_odds: (lo != null && lo > 0) ? 1 / lo : null,
        max_lay_odds: (hi != null && hi > 0) ? 1 / hi : null,
        // Commission-adjusted breakeven prices for exchange trading (Betfair
        // etc.): commission is deducted from NET winnings on the winning
        // side of the bet, so the breakeven back price must be pushed OUT
        // (you need a bigger gross win to net the same amount) and the
        // breakeven lay price must be pushed IN (your net win if the
        // selection loses is also shaved by commission). At commission=0
        // these collapse to min_back_odds/max_lay_odds exactly.
        //   back breakeven: p(o-1)(1-c) = (1-p)  =>  o = 1 + (1-p)/(p(1-c))
        //   lay  breakeven: (1-p)(1-c) = p(o-1)  =>  o = 1 + (1-p)(1-c)/p
        commission: commission,
        min_back_odds_net: (lo != null && lo > 0 && lo < 1)
          ? 1 + (1 - lo) / (lo * (1 - commission)) : null,
        max_lay_odds_net: (hi != null && hi > 0)
          ? 1 + (1 - hi) * (1 - commission) / hi : null,
        scale: {
          lambda_h: s.lambda_h, lambda_a: s.lambda_a,
          lookup_source: s.lookup_source, mc_scale_source: scaleSampler.source
        },
        detail: {
          remaining_fraction: segCacheAll.remFrac,
          half_split_s: segCacheAll.split,
          mu_home_remaining: segCacheAll.home.reduce(function (a, x) { return a + x.mu; }, 0),
          mu_away_remaining: segCacheAll.away.reduce(function (a, x) { return a + x.mu; }, 0),
          state_mult_home: segCacheAll.home[0].S,
          state_mult_away: segCacheAll.away[0].S,
          gamma_posterior_home: { r: segCacheAll.home[0].r, beta: segCacheAll.home[0].betaPost, k: segCacheAll.home[0].k },
          gamma_posterior_away: { r: segCacheAll.away[0].r, beta: segCacheAll.away[0].betaPost, k: segCacheAll.away[0].k },
          mc_samples: R.samples.length
        }
      };
    });
  }

  function _describe(spec) {
    switch (spec.type) {
      case 'over': return 'Over ' + spec.line + ' (' + (spec.scope || 'match') + ')';
      case 'under': return 'Under ' + spec.line + ' (' + (spec.scope || 'match') + ')';
      case 'btts': return 'BTTS ' + (spec.yes === false ? 'No' : 'Yes') + ' (' + (spec.scope || 'match') + ')';
      case 'result': return 'Result ' + spec.side + ' (' + (spec.scope || 'match') + ')';
      case 'correct_score': return 'Correct score ' + spec.home + '-' + spec.away + ' (' + (spec.scope || 'match') + ')';
      case 'nextgoal': return 'Next ' + (spec.window == null ? 15 : spec.window) + ' min: ' +
        (spec.side === 'none' ? 'no goal' : spec.side + ' scores first');
      default: return spec.type;
    }
  }

  // ── Diagnostics / simulation ────────────────────────────────────────────
  function scoreDistribution(state, minute, opts) {
    _ensure();
    opts = opts || {};
    var maxN = opts.maxGoals || MAX_GOALS;
    var s = _normState(state);
    var clock = parseClock(minute);
    var segs = buildSegments(s, clock, true, s.lambda_h, s.lambda_a);
    return {
      clock: clock, segments: segs,
      pmf_home_remaining: _sidePmf(segs.home, maxN),
      pmf_away_remaining: _sidePmf(segs.away, maxN),
      current_score: [s.home_goals, s.away_goals]
    };
  }

  function simulateMatch(state, minute, opts) {
    _ensure();
    opts = opts || {};
    var n = opts.sims || 5000;
    var maxN = opts.maxGoals || MAX_GOALS;
    var rng = mulberry32(opts.seed == null ? DEFAULT_SEED : opts.seed);
    var s = _normState(state);
    var clock = parseClock(minute);
    var scaleSampler = _scaleSampler(s, rng);
    var scores = {};
    var sumH = 0, sumA = 0, hw = 0, d = 0, aw = 0;
    for (var t = 0; t < n; t++) {
      var lam = scaleSampler();
      var segs = buildSegments(s, clock, true, lam[0], lam[1]);
      var gh = _drawCount(segs.home, rng, maxN), ga = _drawCount(segs.away, rng, maxN);
      var fh = s.home_goals + gh, fa = s.away_goals + ga;
      sumH += fh; sumA += fa;
      if (fh > fa) hw++; else if (fh < fa) aw++; else d++;
      var k = fh + '-' + fa;
      scores[k] = (scores[k] || 0) + 1;
    }
    var top = Object.keys(scores).sort(function (a, b) { return scores[b] - scores[a]; }).slice(0, 8)
      .map(function (k) { return { score: k, p: scores[k] / n }; });
    return {
      sims: n, clock: clock,
      mean_ft_home: sumH / n, mean_ft_away: sumA / n,
      p_home: hw / n, p_draw: d / n, p_away: aw / n,
      top_scores: top
    };
  }
  function _drawCount(segs, rng, maxN) {
    var mean = 0;
    for (var i = 0; i < segs.length; i++) mean += randGamma(segs[i].r, segs[i].betaPost, rng) * segs[i].eRem;
    // inverse-CDF Poisson draw
    var u = rng(), cum = 0, p = Math.exp(-mean);
    for (var nn = 0; nn <= maxN; nn++) {
      cum += p;
      if (u <= cum) return nn;
      p = p * mean / (nn + 1);
    }
    return maxN;
  }

  return {
    init: init,
    parseClock: parseClock,
    lambdaFromLookup: lambdaFromLookup,
    stateMultiplier: stateMultiplier,
    regularMass: regularMass,
    baseHalfMass: baseHalfMass,
    remainingHalfMass: remainingHalfMass,
    remainingFraction: remainingFraction,
    windowFractions: windowFractions,
    buildSegments: buildSegments,
    scoreDistribution: scoreDistribution,
    priceMarket: priceMarket,
    priceLadder: priceLadder,
    simulateMatch: simulateMatch,
    HALF_SPLIT_S: HALF_SPLIT_S,
    _internals: { lgamma: lgamma, nbPmf: nbPmf, poissonPmf: poissonPmf, convolve: convolve, randGamma: randGamma, mulberry32: mulberry32 }
  };
}));
