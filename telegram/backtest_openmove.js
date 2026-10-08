'use strict';
/**
 * Idea #1 — predict the line move from what is known at opening, bet at the
 * opening price. Walk-forward on the Bet365 dataset.
 *
 *   node backtest_openmove.js [--dir ../static/data/Bet365] [--detail] [--no-cross]
 *
 * Bets: every AH side (Bet365's opening line) and every goal-line side
 * (opening total), priced at Bet365's OPENING price.
 * Target (CLV): the expected return of that bet judged by the CLOSING market —
 *   Bet365's closing AH + goal line, de-vigged, fitted to expected goals
 *   (goal_table.js) and evaluated at the opening line (so a line move counts
 *   fully, quarter lines exact). This is what a bet "beats the close" by; it
 *   is far less noisy than win/loss and is the target the model learns.
 * Features (opening only, oriented to the side):
 *   price tilt (de-vigged side prob − 0.5), market margin, line type (quarter/
 *   half/whole), favourite/dog and |line|, goal-line tilt, the AH side's value
 *   under the opening 1X2 + goal line (cross-market, see --no-cross), home
 *   side, weekend, and league history (shrunk mean CLV of that side in the
 *   league, training months only).
 * Model: ridge regression per market, refitted each month on all earlier
 *   months (first 6 months training only). Bet a match's best side when the
 *   predicted CLV ≥ threshold. Reported on the held-out months: n, predicted
 *   vs realized CLV, ROI from real results, months positive.
 *
 * Caveats: the dataset's "opening" price is the very first one; live, the far
 * scan first sees a fixture after it may already have moved, so these
 * numbers are an upper bound for what is executable. The 1X2 and the AH may
 * be recorded at different moments (see backtest_crossmarket.js) — run with
 * --no-cross to see how much rests on the cross-market feature.
 */
const fs = require('fs');
const path = require('path');
const FM = require('./fair_model.js');
const G = require('./goal_table');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const DIR = path.resolve(__dirname, arg('--dir', '../static/data/Bet365'));
const DETAIL = process.argv.includes('--detail');
const NO_CROSS = process.argv.includes('--no-cross');
const MIN_TRAIN_MONTHS = 6;
const THRESHOLDS = [0, 0.01, 0.02, 0.03, 0.05];

const num = v => { const x = parseFloat(v); return isFinite(x) ? x : null; };
const ok2 = (p, q) => p > 1.01 && q > 1.01 && 1 / p + 1 / q > 1.0 && 1 / p + 1 / q < 1.15;
const ok3 = x => x.every(v => v > 1.01) && x.reduce((s, v) => s + 1 / v, 0) > 1.0 && x.reduce((s, v) => s + 1 / v, 0) < 1.25;

function loadRows() {
  const out = [];
  for (const f of fs.readdirSync(DIR).filter(f => /\.csv$/i.test(f)).sort()) {
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/);
    const head = lines[0].split(',').map(s => s.trim());
    const ix = n => head.indexOf(n);
    for (let k = 1; k < lines.length; k++) {
      const c = lines[k].split(',');
      if (c.length < head.length - 2) continue;
      const g = n => num(c[ix(n)]);
      const ft = /^(\d+)-(\d+)$/.exec((c[ix('FT Result')] || '').trim()); if (!ft) continue;
      const snap = w => ({ ah: g(`Home AH ${w}`), ho: g(`Home Odds ${w}`), ao: g(`Away Odds ${w}`), tl: g(`Total Line ${w}`), ov: g(`Over Odds ${w}`), un: g(`Under Odds ${w}`),
        x: [g(`1X2 Home ${w}`), g(`1X2 Draw ${w}`), g(`1X2 Away ${w}`)] });
      const date = c[ix('Date')] || '';
      out.push({ month: date.slice(0, 7), dow: new Date(date + 'T12:00:00Z').getUTCDay(), league: c[ix('League')] || '', h: +ft[1], a: +ft[2], O: snap('Opening'), C: snap('Closing') });
    }
  }
  return out;
}

// One candidate bet per side: features, CLV target, realized return.
function candidates(T, r) {
  const O = r.O, C = r.C;
  if (!ok2(O.ho, O.ao) || !ok2(O.ov, O.un) || !ok2(C.ho, C.ao) || !ok2(C.ov, C.un)) return [];
  const cC = G.cellFromAH(T, C.ah, FM.devig([C.ho, C.ao]).fair[0], C.tl, FM.devig([C.ov, C.un]).fair[0]);
  if (cC < 0) return [];
  const ahP = FM.devig([O.ho, O.ao]).probs, ouP = FM.devig([O.ov, O.un]).probs;
  const ahMargin = 1 / O.ho + 1 / O.ao - 1, ouMargin = 1 / O.ov + 1 / O.un - 1;
  const q4 = Math.abs(Math.abs(O.ah * 4) % 2 - 1) < 1e-6, half = !q4 && Math.abs(Math.abs(O.ah * 2) % 2 - 1) < 1e-6;
  const tq4 = Math.abs(Math.abs(O.tl * 4) % 2 - 1) < 1e-6;
  // Cross-market: AH side value at the opening price under the opening 1X2 + goal line.
  let cX = -1;
  if (!NO_CROSS && ok3(O.x)) { const xp = FM.devigPower(O.x).probs; cX = G.cellFrom1x2(T, xp[0], xp[2], O.tl, FM.devig([O.ov, O.un]).fair[0]); }
  const weekend = r.dow === 0 || r.dow === 6 ? 1 : 0;
  const out = [];
  for (const [side, k, price] of [['home', 0, O.ho], ['away', 1, O.ao]]) {
    const sh = G.ahShares(T, cC, O.ah, side); if (!sh) continue;
    const sideLine = side === 'home' ? O.ah : -O.ah;
    let cross = 0;
    if (cX >= 0) { const s2 = G.ahShares(T, cX, O.ah, side); if (s2) cross = s2.A * price + s2.B - 1; }
    const ret = G.ret(side === 'home' ? r.h - r.a : r.a - r.h, sideLine);
    out.push({ mk: 'AH', side, key: `AH|${side}`, price, clv: sh.A * price + sh.B - 1, real: ret.a * price + ret.b - 1,
      x: [ahP[k] - 0.5, ahMargin, q4 ? 1 : 0, half ? 1 : 0, sideLine < 0 ? 1 : 0, Math.abs(O.ah), (ouP[0] - 0.5) * (sideLine < 0 ? 1 : -1), cross, side === 'home' ? 1 : 0, weekend] });
  }
  for (const [side, k, price] of [['over', 0, O.ov], ['under', 1, O.un]]) {
    const sh = G.ouShares(T, cC, O.tl, side); if (!sh) continue;
    const goals = r.h + r.a, ret = side === 'over' ? G.ret(goals, -O.tl) : G.ret(-goals, O.tl);
    out.push({ mk: 'OU', side, key: `OU|${side}`, price, clv: sh.A * price + sh.B - 1, real: ret.a * price + ret.b - 1,
      x: [ouP[k] - 0.5, ouMargin, tq4 ? 1 : 0, O.tl, Math.abs(O.ah), (ahP[0] - 0.5) * (side === 'over' ? 1 : -1), side === 'over' ? 1 : 0, weekend] });
  }
  return out;
}

// Ridge regression via normal equations (features standardized on train).
function ridge(X, y, lambda = 1) {
  const n = X.length, p = X[0].length;
  const mu = new Array(p).fill(0), sd = new Array(p).fill(0);
  for (const r of X) r.forEach((v, j) => (mu[j] += v / n));
  for (const r of X) r.forEach((v, j) => (sd[j] += (v - mu[j]) ** 2 / n));
  for (let j = 0; j < p; j++) sd[j] = Math.sqrt(sd[j]) || 1;
  const q = p + 1, A = Array.from({ length: q }, () => new Array(q).fill(0)), b = new Array(q).fill(0);
  for (let i = 0; i < n; i++) {
    const z = [1, ...X[i].map((v, j) => (v - mu[j]) / sd[j])];
    for (let a = 0; a < q; a++) { b[a] += z[a] * y[i]; for (let c = a; c < q; c++) A[a][c] += z[a] * z[c]; }
  }
  for (let a = 0; a < q; a++) { for (let c = 0; c < a; c++) A[a][c] = A[c][a]; if (a) A[a][a] += lambda; }
  // Gaussian elimination
  for (let col = 0; col < q; col++) {
    let piv = col; for (let r = col + 1; r < q; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]]; [b[col], b[piv]] = [b[piv], b[col]];
    for (let r = 0; r < q; r++) if (r !== col) { const f = A[r][col] / A[col][col]; for (let c = col; c < q; c++) A[r][c] -= f * A[col][c]; b[r] -= f * b[col]; }
  }
  const w = b.map((v, i) => v / A[i][i]);
  return { predict: x => w[0] + x.reduce((s, v, j) => s + w[j + 1] * (v - mu[j]) / sd[j], 0), w, names: null };
}

function main() {
  const t0 = Date.now();
  const T = G.buildTable();
  const rows = loadRows();
  const months = [...new Set(rows.map(r => r.month))].sort();
  // League history needs the side's CLV per league: built per test month from training rows only.
  const cands = [];
  rows.forEach((r, rid) => { for (const c of candidates(T, r)) cands.push({ ...c, month: r.month, league: r.league, rid }); });
  console.log(`${rows.length} matches, ${cands.length} sides, ${months.length} months · built in ${((Date.now() - t0) / 1000).toFixed(0)} s${NO_CROSS ? ' · cross-market feature OFF' : ''}`);

  // Baselines over the test months.
  const testMonths = months.slice(MIN_TRAIN_MONTHS);
  for (const mk of ['AH', 'OU']) {
    const b = cands.filter(c => c.mk === mk && testMonths.includes(c.month));
    console.log(`control ${mk}: every side at the opening price — ${b.length} bets · avg CLV ${(b.reduce((s, c) => s + c.clv, 0) / b.length * 100).toFixed(2)}% · ROI ${(b.reduce((s, c) => s + c.real, 0) / b.length * 100).toFixed(2)}%`);
  }

  const results = new Map(); // `${mk} ≥T` → per month {n, clv, real, pred}
  const coefs = {};
  for (const mk of ['AH', 'OU']) {
    const all = cands.filter(c => c.mk === mk);
    for (const m of testMonths) {
      const train = all.filter(c => c.month < m), test = all.filter(c => c.month === m);
      // League history (shrunk mean CLV of this side in this league, train only)
      const lg = new Map(); let gsum = 0;
      for (const c of train) { const k = `${c.league}|${c.side}`; const v = lg.get(k) || { s: 0, n: 0 }; v.s += c.clv; v.n++; lg.set(k, v); gsum += c.clv; }
      const gmean = gsum / train.length, K = 300;
      const lgf = c => { const v = lg.get(`${c.league}|${c.side}`); return v ? (v.s + K * gmean) / (v.n + K) - gmean : 0; };
      const X = train.map(c => [...c.x, lgf(c)]), y = train.map(c => Math.max(-0.5, Math.min(0.5, c.clv)));
      const model = ridge(X, y, 10);
      coefs[mk] = model.w;
      // Best side per match per market
      const best = new Map();
      for (const c of test) {
        const pred = model.predict([...c.x, lgf(c)]);
        const k = c.rid;
        if (!best.has(k) || pred > best.get(k).pred) best.set(k, { ...c, pred });
      }
      for (const c of best.values()) for (const Th of THRESHOLDS) if (c.pred >= Th) {
        const key = `${mk} predicted CLV ≥ ${(Th * 100).toFixed(0)}%`;
        if (!results.has(key)) results.set(key, new Map());
        const mm = results.get(key); const v = mm.get(m) || { n: 0, clv: 0, real: 0, pred: 0 };
        v.n++; v.clv += c.clv; v.real += c.real; v.pred += c.pred; mm.set(m, v);
      }
    }
  }
  console.log(`\nWalk-forward, held-out months ${testMonths[0]} … ${testMonths[testMonths.length - 1]} (${testMonths.length}), one bet per match per market, at Bet365's OPENING price:`);
  console.log(`${'rule'.padEnd(30)} ${'bets'.padStart(7)} ${'pred CLV'.padStart(9)} ${'real CLV'.padStart(9)} ${'ROI'.padStart(7)} ${'CLV>0 mo'.padStart(9)} ${'ROI>0 mo'.padStart(9)}`);
  for (const [key, mm] of results) {
    let n = 0, clv = 0, real = 0, pred = 0, pc = 0, pr = 0;
    for (const v of mm.values()) { n += v.n; clv += v.clv; real += v.real; pred += v.pred; if (v.clv > 0) pc++; if (v.real > 0) pr++; }
    console.log(`${key.padEnd(30)} ${String(n).padStart(7)} ${(pred / n * 100).toFixed(2).padStart(8)}% ${(clv / n * 100).toFixed(2).padStart(8)}% ${(real / n * 100).toFixed(1).padStart(6)}% ${`${pc}/${mm.size}`.padStart(9)} ${`${pr}/${mm.size}`.padStart(9)}`);
    if (DETAIL) for (const [m, v] of [...mm].sort()) console.log(`    ${m} ${String(v.n).padStart(6)} CLV ${(v.clv / v.n * 100).toFixed(2).padStart(6)}% ROI ${(v.real / v.n * 100).toFixed(1).padStart(6)}%`);
  }
  const names = { AH: ['tilt', 'margin', 'quarter', 'half', 'fav', '|line|', 'TL tilt', 'cross 1X2', 'home', 'weekend', 'league'], OU: ['tilt', 'margin', 'quarter', 'TL', '|AH line|', 'AH tilt', 'over', 'weekend', 'league'] };
  for (const mk of ['AH', 'OU']) console.log(`\n${mk} weights (last fit, per 1 s.d.): ` + coefs[mk].slice(1).map((w, j) => `${names[mk][j]} ${(w * 100).toFixed(2)}`).join(' · ') + ` (intercept ${(coefs[mk][0] * 100).toFixed(2)}%)`);
}

main();
