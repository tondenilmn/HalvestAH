'use strict';
/**
 * Research (2026-10-10): what the three-book history (CrossBooks/{Bet365,Sbobet,
 * Pinnacle}_Data_months — AH + goal line, opening + closing, HT/FT) says about
 *   (b) which book leads and which book's prices predict results best, and
 *   (a) predicting Pinnacle's closing price from every book's opening — then
 *       betting an opening price the predicted close says is too high.
 *
 * Every book-time (AH line + prices, goal line + prices) is turned into the
 * same two numbers — expected total goals μ and supremacy s (home − away) —
 * with fair_model.js's scoreline model (proportional de-vig, Dixon-Coles), so
 * books on different lines are comparable. A lookup table over (μ, s) makes
 * the fits fast.
 *
 *   node research_books.js [--min 3]     (edge threshold for the betting part, %)
 */
const fs = require('fs');
const path = require('path');
const FM = require('./fair_model.js');

const ROOT = path.join(__dirname, '..', 'CrossBooks');
const BOOKS = ['Bet365', 'Sbobet', 'Pinnacle'];
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? +process.argv[i + 1] : d; };

// ── load + merge ──
function load(book) {
  const m = new Map(), dir = path.join(ROOT, `${book}_Data_months`);
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.csv'))) {
    const L = fs.readFileSync(path.join(dir, f), 'utf8').trim().split(/\r?\n/), H = L[0].split(',');
    for (const l of L.slice(1)) {
      const v = l.split(','); if (v.length !== H.length) continue;
      const o = {}; H.forEach((h, i) => { o[h] = v[i]; });
      m.set([o.Date, o.Time, o['Home Team'], o['Away Team']].join('|'), o);
    }
  }
  return m;
}
const num = x => { const v = parseFloat(x); return isFinite(v) ? v : null; };
const score = s => { const m = String(s || '').match(/(\d+)\s*-\s*(\d+)/); return m ? [+m[1], +m[2]] : null; };

// ── (μ, s) lookup table of win-equivalent probabilities (1 / fair odds) ──
const MU0 = 0.3, MU1 = 6.5, DMU = 0.05, S0 = -4.5, S1 = 4.5, DS = 0.05;
const NMU = Math.round((MU1 - MU0) / DMU) + 1, NS = Math.round((S1 - S0) / DS) + 1;
const AH_LINES = []; for (let x = -4.5; x <= 4.5001; x += 0.25) AH_LINES.push(+x.toFixed(2));
const TL_LINES = []; for (let x = 0.5; x <= 6.5001; x += 0.25) TL_LINES.push(+x.toFixed(2));
const ahIdx = l => Math.round((l + 4.5) * 4), tlIdx = l => Math.round((l - 0.5) * 4);
const lam = (mu, s) => [Math.max((mu + s) / 2, 0.02), Math.max((mu - s) / 2, 0.02)];
const TAB_AH = new Float32Array(NMU * NS * AH_LINES.length), TAB_OU = new Float32Array(NMU * NS * TL_LINES.length);
(function buildTables() {
  for (let i = 0; i < NMU; i++) for (let j = 0; j < NS; j++) {
    const [lh, la] = lam(MU0 + i * DMU, S0 + j * DS), P = FM.scoreGrid(lh, la);
    const b = i * NS + j;
    AH_LINES.forEach((l, k) => { TAB_AH[b * AH_LINES.length + k] = 1 / FM.fairOddsFromDist(FM.ahDist(P, l, 'home')); });
    TL_LINES.forEach((l, k) => { TAB_OU[b * TL_LINES.length + k] = 1 / FM.fairOddsFromDist(FM.ouDist(P, l, 'over')); });
  }
})();
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
  let mu = 2.6, s = 0;
  for (let it = 0; it < 6; it++) {
    mu = bis(MU0, MU1, m => pOU(m, s, tl) - pOver);           // p(over) rises with μ
    s = bis(S0, S1, x => pAH(mu, x, ahLine) - pHome);          // p(home covers) rises with s
  }
  return { mu, s };
}
function bookTime(o, when) {
  const ah = num(o[`Home AH ${when}`]), ho = num(o[`Home Odds ${when}`]), ao = num(o[`Away Odds ${when}`]);
  const tl = num(o[`Total Line ${when}`]), ov = num(o[`Over Odds ${when}`]), un = num(o[`Under Odds ${when}`]);
  if ([ah, ho, ao, tl, ov, un].some(v => v == null) || ho <= 1 || ao <= 1 || ov <= 1 || un <= 1) return null;
  if (Math.abs(ah) > 4.5 || tl < 0.5 || tl > 6.5 || Math.abs(ah * 4 - Math.round(ah * 4)) > 1e-6 || Math.abs(tl * 4 - Math.round(tl * 4)) > 1e-6) return null;
  const a = FM.devig([ho, ao]), t = FM.devig([ov, un]);
  const f = fit(ah, a.probs[0], tl, t.probs[0]);
  return { ...f, ah, ho, ao, tl, ov, un, mAH: a.margin, mOU: t.margin };
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

// ── OLS (normal equations, tiny) ──
function ols(X, y) {
  const k = X[0].length, A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (let r = 0; r < X.length; r++) for (let i = 0; i < k; i++) { b[i] += X[r][i] * y[r]; for (let j = 0; j < k; j++) A[i][j] += X[r][i] * X[r][j]; }
  for (let i = 0; i < k; i++) A[i][i] += 1e-6;
  for (let i = 0; i < k; i++) { // Gauss-Jordan
    let p = i; for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = 0; r < k; r++) if (r !== i) { const f = A[r][i] / A[i][i]; for (let c = i; c < k; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  return b.map((v, i) => v / A[i][i]);
}
const dot = (w, x) => w.reduce((s, v, i) => s + v * x[i], 0);
const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

function main() {
  const t0 = Date.now();
  const books = Object.fromEntries(BOOKS.map(b => [b, load(b)]));
  const rows = [];
  for (const [k, p] of books.Pinnacle) {
    const b = books.Bet365.get(k); if (!b) continue;
    const s = books.Sbobet.get(k);
    const ft = score(p['FT Result']), ht = score(p['HT Result']); if (!ft) continue;
    const r = { k, month: p.Date.slice(0, 7), ft, ht, league: p.League };
    for (const [name, o] of [['B', b], ['S', s], ['P', p]]) {
      if (!o) continue;
      const op = bookTime(o, 'Opening'), cl = bookTime(o, 'Closing');
      if (op && cl) { r[name + 'o'] = op; r[name + 'c'] = cl; }
    }
    if (r.Bo && r.Po) rows.push(r);
  }
  const months = [...new Set(rows.map(r => r.month))].sort();
  console.log(`${rows.length} matches with Bet365 + Pinnacle opening and closing (${rows.filter(r => r.So).length} with Sbobet too), ${months.length} months ${months[0]}…${months[months.length - 1]} · fitted in ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  // ── (b1) Which book's prices predict results best: Poisson log-likelihood of the FT score ──
  const llOf = (f, ft) => { const [lh, la] = lam(f.mu, f.s); const lp = (l, g) => -l + g * Math.log(l) - lgam(g); return lp(lh, ft[0]) + lp(la, ft[1]); };
  const lgamT = [0, 0]; for (let i = 2; i < 30; i++) lgamT[i] = lgamT[i - 1] + Math.log(i - 1 + 1) - 0; // log(g!)
  function lgam(g) { let s = 0; for (let i = 2; i <= g; i++) s += Math.log(i); return s; }
  const tri = rows.filter(r => r.So);
  console.log('\n(b1) WHICH PRICES PREDICT RESULTS BEST — mean log-likelihood of the FT score under each book\'s μ/s (higher = better), matches with all three books:');
  const base = tri.reduce((s, r) => s + llOf(r.Pc, r.ft), 0) / tri.length;
  for (const nm of ['Bo', 'So', 'Po', 'Bc', 'Sc', 'Pc']) {
    const ll = tri.reduce((s, r) => s + llOf(r[nm], r.ft), 0) / tri.length;
    console.log(`  ${({ B: 'Bet365', S: 'Sbobet', P: 'Pinnacle' })[nm[0]].padEnd(9)} ${nm[1] === 'o' ? 'opening' : 'closing'}  ${ll.toFixed(5)}  (vs Pinnacle closing ${(ll - base >= 0 ? '+' : '')}${(ll - base).toFixed(5)})`);
  }
  // Consensus of the three openings
  const cons = tri.reduce((s, r) => s + llOf({ mu: (r.Bo.mu + r.So.mu + r.Po.mu) / 3, s: (r.Bo.s + r.So.s + r.Po.s) / 3 }, r.ft), 0) / tri.length;
  console.log(`  average of the 3 openings  ${cons.toFixed(5)}  (vs Pinnacle closing ${(cons - base >= 0 ? '+' : '')}${(cons - base).toFixed(5)})`);

  // ── (b2) Who moves toward whom: share of the opening gap each book closes ──
  console.log('\n(b2) WHO FOLLOWS WHOM — when two books open apart, the share of the gap each one closes by kick-off (supremacy s; total μ in brackets):');
  const nmB = { B: 'Bet365', S: 'Sbobet', P: 'Pinnacle' };
  for (const [A, C] of [['B', 'S'], ['B', 'P'], ['S', 'P']]) {
    const L = rows.filter(r => r[A + 'o'] && r[C + 'o']);
    const share = (X, Y, key) => { // how much X moved toward Y's opening, relative to the gap
      let num = 0, den = 0;
      for (const r of L) { const g = r[Y + 'o'][key] - r[X + 'o'][key]; if (Math.abs(g) < 0.05) continue; num += (r[X + 'c'][key] - r[X + 'o'][key]) * g; den += g * g; }
      return num / den;
    };
    console.log(`  ${nmB[A]} vs ${nmB[C]} (${L.length} matches): ${nmB[A]} closes ${(share(A, C, 's') * 100).toFixed(0)}% (${(share(A, C, 'mu') * 100).toFixed(0)}%) of the gap, ${nmB[C]} closes ${(share(C, A, 's') * 100).toFixed(0)}% (${(share(C, A, 'mu') * 100).toFixed(0)}%)`);
  }
  // Multi-regression: Pinnacle's closing on all three openings
  const fitW = (L, key, withS) => ols(L.map(r => [1, r.Bo[key], r.Po[key], ...(withS ? [r.So[key]] : [])]), L.map(r => r.Pc[key]));
  for (const key of ['s', 'mu']) {
    const w = fitW(tri, key, true);
    console.log(`  Pinnacle's closing ${key === 's' ? 'supremacy' : 'total'} ≈ ${w[0].toFixed(3)} + ${w[1].toFixed(2)}·Bet365 open + ${w[2].toFixed(2)}·Pinnacle open + ${w[3].toFixed(2)}·Sbobet open`);
  }

  // ── (a) Predict Pinnacle's close from the openings (walk-forward by month) and bet the openings ──
  const minEdge = arg('--min', 3) / 100;
  console.log(`\n(a) PREDICTED CLOSE — fit on earlier months only, then bet each book's OPENING price when its expected return under the predicted close is ≥ ${pct(minEdge)} (1 unit, one side per market per match):`);
  const feats = (r, key, withS) => [1, r.Bo[key], r.Po[key], ...(withS ? [r.So[key]] : [])];
  const res = {}; // label → {n, pl, clv, nc, months: {m: pl}}
  const add = (label, m, ret_, clv) => {
    const o = res[label] || (res[label] = { n: 0, pl: 0, clv: 0, months: {} });
    o.n++; o.pl += ret_ - 1; o.clv += clv; o.months[m] = (o.months[m] || 0) + ret_ - 1;
  };
  let rmse = { model: [0, 0], pinOpen: [0, 0], n: 0 };
  for (let mi = 3; mi < months.length; mi++) {
    const train = rows.filter(r => r.month < months[mi]), test = rows.filter(r => r.month === months[mi]);
    const W = {};
    for (const withS of [true, false]) for (const key of ['s', 'mu']) {
      const L = withS ? train.filter(r => r.So) : train;
      W[`${key}${withS}`] = ols(L.map(r => feats(r, key, withS)), L.map(r => r.Pc[key]));
    }
    for (const r of test) {
      const withS = !!r.So;
      const pred = { s: dot(W[`s${withS}`], feats(r, 's', withS)), mu: dot(W[`mu${withS}`], feats(r, 'mu', withS)) };
      const predNoS = { s: dot(W['sfalse'], feats(r, 's', false)), mu: dot(W['mufalse'], feats(r, 'mu', false)) };
      rmse.model[0] += (pred.s - r.Pc.s) ** 2; rmse.model[1] += (pred.mu - r.Pc.mu) ** 2;
      rmse.pinOpen[0] += (r.Po.s - r.Pc.s) ** 2; rmse.pinOpen[1] += (r.Po.mu - r.Pc.mu) ** 2; rmse.n++;
      for (const [nm, refs] of [['B', ['pred', 'predNoS', 'Po']], ['S', ['pred', 'Po']], ['P', ['pred', 'predNoS']]]) {
        const o = r[nm + 'o']; if (!o) continue;
        for (const ref of refs) {
          const R = ref === 'pred' ? pred : ref === 'predNoS' ? predNoS : r.Po;
          // the better side of each market at this book's opening
          const cand = [['AH', 'home', o.ah, o.ho], ['AH', 'away', -o.ah, o.ao], ['OU', 'over', o.tl, o.ov], ['OU', 'under', o.tl, o.un]]
            .map(([kind, side, line, price]) => ({ kind, side, line, price, ev: evOf(R.mu, R.s, kind, side, kind === 'AH' && side === 'away' ? o.ah : line, price) }));
          for (const kind of ['AH', 'OU']) {
            const c = cand.filter(x => x.kind === kind).sort((a, b) => b.ev - a.ev)[0];
            if (c.ev - 1 < minEdge || c.ev - 1 > 0.25) continue;
            const value = kind === 'AH' ? (c.side === 'home' ? r.ft[0] - r.ft[1] : r.ft[1] - r.ft[0]) : (c.side === 'over' ? r.ft[0] + r.ft[1] : -(r.ft[0] + r.ft[1]));
            const line = kind === 'AH' ? c.line : (c.side === 'over' ? -c.line : c.line);
            const rr = ret(value, line, c.price);
            const clv = evOf(r.Pc.mu, r.Pc.s, kind, c.side, kind === 'AH' && c.side === 'away' ? o.ah : c.line, c.price) - 1;
            const label = `${nmB[nm]} opening vs ${ref === 'pred' ? 'PREDICTED Pinnacle close' : ref === 'predNoS' ? 'predicted close, no Sbobet' : 'Pinnacle opening'}`;
            if (ref === 'pred' && nm === 'B') add(`${label} · ${withS ? 'Sbobet listed' : 'no Sbobet listed'}`, r.month, rr, clv);
            if (ref !== 'Po') add(`${label} · edge ${c.ev - 1 >= 0.08 ? '≥8%' : c.ev - 1 >= 0.05 ? '5-8%' : '3-5%'}`, r.month, rr, clv);
            add(`${label} · all`, r.month, rr, clv); add(`${label} · ${kind}`, r.month, rr, clv);
          }
        }
      }
    }
  }
  console.log(`  prediction error (RMSE vs Pinnacle's actual close): model s ${Math.sqrt(rmse.model[0] / rmse.n).toFixed(3)} / μ ${Math.sqrt(rmse.model[1] / rmse.n).toFixed(3)} · Pinnacle's own opening s ${Math.sqrt(rmse.pinOpen[0] / rmse.n).toFixed(3)} / μ ${Math.sqrt(rmse.pinOpen[1] / rmse.n).toFixed(3)} (${rmse.n} test matches, months ${months[3]}…)`);
  for (const [label, o] of Object.entries(res).sort()) {
    const ms = Object.values(o.months), pos = ms.filter(v => v > 0).length;
    console.log(`  ${label.padEnd(62)} ${String(o.n).padStart(6)} bets · ROI ${pct(o.pl / o.n).padStart(7)} · CLV vs Pinnacle close ${pct(o.clv / o.n).padStart(7)} · ${pos}/${ms.length} months positive`);
  }
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
}

if (require.main === module) main();
module.exports = { fit, evOf, ret };
