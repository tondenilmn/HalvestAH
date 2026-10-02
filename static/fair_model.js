/* ══════════════════════════════════════════════════════════════════════
   fair_model.js — "what is this match really worth?"

   Turns a reference book's Asian Handicap line + Total Line prices into
   expected goals per team (λ home, λ away), then prices every market from
   the resulting scoreline distribution: 1X2, double chance, draw-no-bet,
   AH at any line (quarter lines settled properly), Over/Under at any line,
   BTTS, team totals, clean sheets, win-to-nil, correct score, 1st half.

   Used by the MATCH tab (static/match.js) for the Fair Prices and Value
   views. Plain script — exposes window.FairModel in the browser and
   module.exports in Node (so telegram/ scripts and calibration checks can
   reuse the exact same code).

   Conventions (same as the CSV dataset and /api/scrape):
   - AH line is the HOME handicap: home covers when (homeGoals - awayGoals + line) > 0.
     line -0.5 = home favourite giving half a goal.
   - All "fair" odds are de-vigged (bookmaker margin removed).
   ══════════════════════════════════════════════════════════════════════ */
(function (root) {
  'use strict';

  const MAX_GOALS = 12;

  // Dixon-Coles low-score correction. Plain independent Poisson under-prices
  // draws (0-0, 1-1) — rho < 0 shifts a little probability onto them.
  // Calibrated against the Bet365 dataset (see CALIBRATION below).
  const DEFAULT_RHO = -0.06;

  // Share of each team's goals scored in the 1st half (dataset average,
  // see CALIBRATION below). 1H markets use λ × this share.
  const FIRST_HALF_SHARE = 0.445;

  /* ── de-vig ─────────────────────────────────────────────────────────── */
  // Proportional normalisation: fair_i = 1 / ((1/o_i) / Σ 1/o_j).
  function devig(odds) {
    if (!odds || odds.some(o => !(o > 1))) return null;
    const inv = odds.map(o => 1 / o);
    const s = inv.reduce((a, b) => a + b, 0);
    return { fair: inv.map(x => s / x), margin: s - 1, probs: inv.map(x => x / s) };
  }

  /* ── scoreline grid ─────────────────────────────────────────────────── */
  function poissonPmf(l) {
    const p = new Array(MAX_GOALS + 1);
    p[0] = Math.exp(-l);
    for (let k = 1; k <= MAX_GOALS; k++) p[k] = p[k - 1] * l / k;
    return p;
  }

  // P[h][a] = probability of final score h-a.
  function scoreGrid(lh, la, rho = DEFAULT_RHO) {
    const ph = poissonPmf(lh), pa = poissonPmf(la);
    const P = [];
    let tot = 0;
    for (let h = 0; h <= MAX_GOALS; h++) {
      P[h] = [];
      for (let a = 0; a <= MAX_GOALS; a++) {
        let v = ph[h] * pa[a];
        if (rho) {
          if (h === 0 && a === 0) v *= 1 - lh * la * rho;
          else if (h === 0 && a === 1) v *= 1 + lh * rho;
          else if (h === 1 && a === 0) v *= 1 + la * rho;
          else if (h === 1 && a === 1) v *= 1 - rho;
        }
        P[h][a] = Math.max(v, 0);
        tot += P[h][a];
      }
    }
    for (let h = 0; h <= MAX_GOALS; h++) for (let a = 0; a <= MAX_GOALS; a++) P[h][a] /= tot;
    return P;
  }

  function sumGrid(P, pred) {
    let s = 0;
    for (let h = 0; h < P.length; h++) for (let a = 0; a < P[h].length; a++) if (pred(h, a)) s += P[h][a];
    return s;
  }

  /* ── handicap-style settlement (AH and O/U share it) ────────────────── */
  // Splits a quarter line into its two half-stakes: -0.75 → [-0.5, -1.0].
  function splitLine(line) {
    const q = Math.round(line * 4);
    return (Math.abs(q) % 2 === 1) ? [(q - 1) / 4, (q + 1) / 4] : [q / 4];
  }

  // Outcome distribution for a bet whose result is decided by (x + line):
  // x = goal margin for AH, x = goals - TL handled by caller.
  // Returns {w, hw, p, hl, l} probabilities (win, half-win, push, half-loss, loss).
  function outcomeDist(P, valueFn, line) {
    const parts = splitLine(line);
    const d = { w: 0, hw: 0, p: 0, hl: 0, l: 0 };
    for (let h = 0; h < P.length; h++) for (let a = 0; a < P[h].length; a++) {
      const pr = P[h][a]; if (!pr) continue;
      let r = 0;
      for (const ln of parts) { const v = valueFn(h, a) + ln; r += v > 0 ? 1 : v < 0 ? -1 : 0; }
      r /= parts.length;
      if (r === 1) d.w += pr; else if (r === 0.5) d.hw += pr; else if (r === 0) d.p += pr;
      else if (r === -0.5) d.hl += pr; else d.l += pr;
    }
    return d;
  }

  // Odds o with zero expected value: P(w)(o-1) + P(hw)(o-1)/2 = P(hl)/2 + P(l).
  function fairOddsFromDist(d) {
    const up = d.w + d.hw / 2, down = d.hl / 2 + d.l;
    if (up <= 1e-12) return Infinity;
    return 1 + down / up;
  }
  // "Win-equivalent" probability: 1 / fair odds — what Kelly sizes against.
  const probFromOdds = o => (o > 1 && isFinite(o)) ? 1 / o : 0;

  function ahDist(P, homeLine, side) {
    return side === 'home'
      ? outcomeDist(P, (h, a) => h - a, homeLine)
      : outcomeDist(P, (h, a) => a - h, -homeLine);
  }
  function ouDist(P, tl, side) {
    return side === 'over'
      ? outcomeDist(P, (h, a) => h + a, -tl)
      : outcomeDist(P, (h, a) => -(h + a), tl);
  }
  // Team total (one team's goals vs a line).
  function teamTotalDist(P, team, tl, side) {
    const g = team === 'home' ? (h, a) => h : (h, a) => a;
    return side === 'over' ? outcomeDist(P, g, -tl) : outcomeDist(P, (h, a) => -g(h, a), tl);
  }

  /* ── solver: prices → (λh, λa) ──────────────────────────────────────── */
  // Fits total goals μ and supremacy s (= λh − λa) so the model reproduces
  // the reference book's de-vigged AH-home and Over prices. O/U mostly
  // depends on μ and AH mostly on s, so alternating 1-D bisections converge
  // fast. Either input may be missing:
  //   - no AH  → s = 0 can't be trusted; caller should pass 1X2 instead (solveFrom1x2)
  //   - no TL  → μ defaults to 2.6 (dataset average-ish)
  function solve({ ahLine, ahHomeFair, tl, overFair, rho = DEFAULT_RHO }) {
    let mu = 2.6, s = 0;
    const haveAH = Number.isFinite(ahLine) && ahHomeFair > 1;
    const haveTL = Number.isFinite(tl) && overFair > 1;
    const lam = (m, x) => [Math.max((m + x) / 2, 0.02), Math.max((m - x) / 2, 0.02)];
    const bisect = (lo, hi, f) => { // f increasing, find f(x)=0
      for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; }
      return (lo + hi) / 2;
    };
    for (let it = 0; it < 25; it++) {
      const prevMu = mu, prevS = s;
      if (haveTL) {
        mu = bisect(0.15, 9, m => {
          const [lh, la] = lam(m, s);
          // over fair odds fall as μ rises → (target − model) rises with μ
          return overFair - fairOddsFromDist(ouDist(scoreGrid(lh, la, rho), tl, 'over'));
        });
      }
      if (haveAH) {
        s = bisect(-Math.min(mu, 6) + 0.04, Math.min(mu, 6) - 0.04, x => {
          const [lh, la] = lam(mu, x);
          return ahHomeFair - fairOddsFromDist(ahDist(scoreGrid(lh, la, rho), ahLine, 'home'));
        });
      }
      if (!haveTL || !haveAH) break;
      if (Math.abs(mu - prevMu) < 1e-4 && Math.abs(s - prevS) < 1e-4) break;
    }
    const [lh, la] = lam(mu, s);
    return { lh, la, mu: lh + la, sup: lh - la };
  }

  // Fallback when only 1X2 is available: fit (λh, λa) to home/away win
  // probabilities, with μ from TL if given.
  function solveFrom1x2({ pHome, pAway, tl, overFair, rho = DEFAULT_RHO }) {
    let mu = 2.6, s = 0;
    const lam = (m, x) => [Math.max((m + x) / 2, 0.02), Math.max((m - x) / 2, 0.02)];
    const bisect = (lo, hi, f) => { for (let i = 0; i < 50; i++) { const m = (lo + hi) / 2; if (f(m) > 0) hi = m; else lo = m; } return (lo + hi) / 2; };
    const target = pHome - pAway;
    for (let it = 0; it < 25; it++) {
      if (Number.isFinite(tl) && overFair > 1) {
        mu = bisect(0.15, 9, m => { const [lh, la] = lam(m, s); return overFair - fairOddsFromDist(ouDist(scoreGrid(lh, la, rho), tl, 'over')); });
      }
      s = bisect(-Math.min(mu, 6) + 0.04, Math.min(mu, 6) - 0.04, x => {
        const [lh, la] = lam(mu, x); const P = scoreGrid(lh, la, rho);
        return (sumGrid(P, (h, a) => h > a) - sumGrid(P, (h, a) => h < a)) - target;
      });
    }
    const [lh, la] = lam(mu, s);
    return { lh, la, mu: lh + la, sup: lh - la };
  }

  /* ── market sheet ───────────────────────────────────────────────────── */
  function mk(label, p, extra) { return Object.assign({ label, p, fair: p > 0 ? 1 / p : Infinity }, extra || {}); }
  function mkDist(label, d, extra) { const o = fairOddsFromDist(d); return Object.assign({ label, p: probFromOdds(o), fair: o, dist: d }, extra || {}); }

  const AH_LINES = [-2.5, -2.25, -2, -1.75, -1.5, -1.25, -1, -0.75, -0.5, -0.25, 0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5];
  const TOTAL_LINES = [0.5, 1, 1.25, 1.5, 1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5, 3.75, 4, 4.5, 5.5];

  function markets(lh, la, { rho = DEFAULT_RHO, firstHalfShare = FIRST_HALF_SHARE } = {}) {
    const P = scoreGrid(lh, la, rho);
    const S = (f) => sumGrid(P, f);
    const pH = S((h, a) => h > a), pD = S((h, a) => h === a), pA = S((h, a) => h < a);

    const out = { lh, la, grid: P };
    out.result = [mk('Home', pH, { key: '1' }), mk('Draw', pD, { key: 'X' }), mk('Away', pA, { key: '2' })];
    out.doubleChance = [mk('Home or Draw (1X)', pH + pD), mk('Home or Away (12)', pH + pA), mk('Draw or Away (X2)', pD + pA)];
    out.dnb = [mk('Home DNB', pH / (pH + pA)), mk('Away DNB', pA / (pH + pA))];

    out.ah = AH_LINES.map(line => ({
      line,
      home: mkDist(`Home ${fmtLine(line)}`, ahDist(P, line, 'home')),
      away: mkDist(`Away ${fmtLine(-line)}`, ahDist(P, line, 'away')),
    }));
    out.totals = TOTAL_LINES.map(line => ({
      line,
      over: mkDist(`Over ${line}`, ouDist(P, line, 'over')),
      under: mkDist(`Under ${line}`, ouDist(P, line, 'under')),
    }));
    out.teamTotals = ['home', 'away'].map(team => ({
      team,
      lines: [0.5, 1.5, 2.5].map(line => ({
        line,
        over: mkDist(`${team === 'home' ? 'Home' : 'Away'} over ${line}`, teamTotalDist(P, team, line, 'over')),
        under: mkDist(`${team === 'home' ? 'Home' : 'Away'} under ${line}`, teamTotalDist(P, team, line, 'under')),
      })),
    }));
    const pBtts = S((h, a) => h > 0 && a > 0);
    out.btts = [mk('BTTS Yes', pBtts), mk('BTTS No', 1 - pBtts)];
    out.specials = [
      mk('Home scores', S((h) => h > 0)), mk('Away scores', S((h, a) => a > 0)),
      mk('Home clean sheet', S((h, a) => a === 0)), mk('Away clean sheet', S((h) => h === 0)),
      mk('Home wins to nil', S((h, a) => h > a && a === 0)), mk('Away wins to nil', S((h, a) => a > h && h === 0)),
      mk('Home wins by 2+', S((h, a) => h - a >= 2)), mk('Away wins by 2+', S((h, a) => a - h >= 2)),
      mk('Draw 0-0', P[0][0]), mk('Score draw', pD - P[0][0]),
    ];
    // Correct score, top 12 most likely.
    const cs = [];
    for (let h = 0; h <= 6; h++) for (let a = 0; a <= 6; a++) cs.push(mk(`${h}-${a}`, P[h][a], { h, a }));
    out.correctScore = cs.sort((x, y) => y.p - x.p).slice(0, 12);

    // 1st half — same model on λ × firstHalfShare (no DC correction: low
    // scores dominate the half anyway, and rho was fitted on full-time).
    const P1 = scoreGrid(lh * firstHalfShare, la * firstHalfShare, 0);
    const S1 = (f) => sumGrid(P1, f);
    out.firstHalf = {
      lh: lh * firstHalfShare, la: la * firstHalfShare,
      result: [mk('1H Home', S1((h, a) => h > a)), mk('1H Draw', S1((h, a) => h === a)), mk('1H Away', S1((h, a) => h < a))],
      totals: [0.5, 1.5, 2.5].map(line => ({
        line,
        over: mkDist(`1H Over ${line}`, ouDist(P1, line, 'over')),
        under: mkDist(`1H Under ${line}`, ouDist(P1, line, 'under')),
      })),
      btts: mk('1H BTTS Yes', S1((h, a) => h > 0 && a > 0)),
    };
    // 2nd half goals (independent of 1H under this model).
    const s2 = 1 - firstHalfShare;
    const P2 = scoreGrid(lh * s2, la * s2, 0);
    out.secondHalf = {
      totals: [0.5, 1.5, 2.5].map(line => ({
        line,
        over: mkDist(`2H Over ${line}`, ouDist(P2, line, 'over')),
        under: mkDist(`2H Under ${line}`, ouDist(P2, line, 'under')),
      })),
    };
    return out;
  }

  // Fair odds for an arbitrary AH / O/U side at a given line, from (λh, λa).
  function priceAH(lh, la, homeLine, side, rho = DEFAULT_RHO) {
    return fairOddsFromDist(ahDist(scoreGrid(lh, la, rho), homeLine, side));
  }
  function priceOU(lh, la, tl, side, rho = DEFAULT_RHO) {
    return fairOddsFromDist(ouDist(scoreGrid(lh, la, rho), tl, side));
  }

  function fmtLine(x) {
    if (!Number.isFinite(x)) return '—';
    if (Math.abs(x) < 1e-9) return '0';
    return (x > 0 ? '+' : '') + x.toFixed(2).replace(/0$/, '').replace(/\.0$/, '');
  }

  // Fractional Kelly for a bet at decimal odds `o` with win-equivalent
  // probability `p` (1 / fair odds). Returns a fraction of bankroll, ≥ 0.
  function kelly(p, o, fraction = 0.25) {
    if (!(o > 1) || !(p > 0)) return 0;
    const b = o - 1;
    const f = (p * b - (1 - p)) / b;
    return Math.max(0, f * fraction);
  }

  const api = {
    DEFAULT_RHO, FIRST_HALF_SHARE, AH_LINES, TOTAL_LINES,
    devig, scoreGrid, splitLine, outcomeDist, fairOddsFromDist, probFromOdds,
    ahDist, ouDist, teamTotalDist, solve, solveFrom1x2, markets, priceAH, priceOU,
    kelly, fmtLine,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.FairModel = api;
})(typeof window !== 'undefined' ? window : this);
