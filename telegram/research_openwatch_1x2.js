'use strict';
/**
 * OPENWATCH on Bet365's 1X2 (research, added 2026-10-18, user question).
 *
 * OPENWATCH predicts Pinnacle's closing expected goals μ and supremacy s from
 * the books' openings (research_books.js) and prices Bet365's Asian handicap /
 * goal line against it. This asks whether the same predicted close, turned into
 * a fair 1X2 by the scoreline model (fair_model.js grid, Dixon-Coles), finds
 * value in Bet365's 1X2 too.
 *
 * Data: static/data/Bet365 (Bet365 with 1X2 opening + closing) joined to
 * CrossBooks/{Pinnacle,Sbobet}_Data_months (same Date|Time|Home|Away keys).
 * Walk-forward by month: the close-prediction weights are fitted on earlier
 * months only (≥ 3), then each test month's Bet365 OPENING 1X2 side is bet when
 * price × p(predicted close) − 1 ≥ X. Controls: the same picks at Bet365's
 * CLOSING price, Bet365 opening blind, and a calibration check of the model's
 * 1X2 against results at Pinnacle's actual close (the model's own bias).
 *
 *   node research_openwatch_1x2.js [--min 3,5,8]
 */
const fs = require('fs');
const path = require('path');
const MF = require('./market_fit');
const FM = require('./fair_model.js');

const ROOT = path.join(__dirname, '..');
const MINS = (process.argv.includes('--min') ? process.argv[process.argv.indexOf('--min') + 1] : '3,5,8').split(',').map(Number);

function load(dir) {
  const m = new Map();
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
const fit = (o, w) => MF.fitPrices({ ah: num(o[`Home AH ${w}`]), ho: num(o[`Home Odds ${w}`]), ao: num(o[`Away Odds ${w}`]), tl: num(o[`Total Line ${w}`]), ov: num(o[`Over Odds ${w}`]), un: num(o[`Under Odds ${w}`]) });
function x12Of(mu, s) {
  const [lh, la] = MF.lam(mu, s), P = FM.scoreGrid(lh, la);
  let h = 0, d = 0;
  for (let i = 0; i < P.length; i++) for (let j = 0; j < P[i].length; j++) { if (i > j) h += P[i][j]; else if (i === j) d += P[i][j]; }
  return [h, d, 1 - h - d];
}
function ols(X, y) {
  const k = X[0].length, A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
  for (let r = 0; r < X.length; r++) for (let i = 0; i < k; i++) { b[i] += X[r][i] * y[r]; for (let j = 0; j < k; j++) A[i][j] += X[r][i] * X[r][j]; }
  for (let i = 0; i < k; i++) A[i][i] += 1e-6;
  for (let i = 0; i < k; i++) {
    let p = i; for (let r = i + 1; r < k; r++) if (Math.abs(A[r][i]) > Math.abs(A[p][i])) p = r;
    [A[i], A[p]] = [A[p], A[i]]; [b[i], b[p]] = [b[p], b[i]];
    for (let r = 0; r < k; r++) if (r !== i) { const f = A[r][i] / A[i][i]; for (let c = i; c < k; c++) A[r][c] -= f * A[i][c]; b[r] -= f * b[i]; }
  }
  return b.map((v, i) => v / A[i][i]);
}
const dot = (w, x) => w.reduce((t, v, i) => t + v * x[i], 0);
const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const SIDES = ['home', 'draw', 'away'];
const won = (side, ft) => (side === 0 ? ft[0] > ft[1] : side === 1 ? ft[0] === ft[1] : ft[0] < ft[1]);

function main() {
  const t0 = Date.now();
  const B = load(path.join(ROOT, 'static', 'data', 'Bet365'));
  const P = load(path.join(ROOT, 'CrossBooks', 'Pinnacle_Data_months'));
  const S = load(path.join(ROOT, 'CrossBooks', 'Sbobet_Data_months'));
  const rows = [];
  for (const [k, b] of B) {
    const p = P.get(k); if (!p) continue;
    const ft = score(b['FT Result']); if (!ft) continue;
    const xo = ['Home', 'Draw', 'Away'].map(s => num(b[`1X2 ${s} Opening`])), xc = ['Home', 'Draw', 'Away'].map(s => num(b[`1X2 ${s} Closing`]));
    if (xo.some(v => !(v > 1)) || xc.some(v => !(v > 1))) continue;
    const Bo = fit(b, 'Opening'), Po = fit(p, 'Opening'), Pc = fit(p, 'Closing');
    if (!Bo || !Po || !Pc) continue;
    const s = S.get(k), So = s ? fit(s, 'Opening') : null;
    rows.push({ month: b.Date.slice(0, 7), ft, xo, xc, Bo, Po, Pc, So, lg: b.League });
  }
  const months = [...new Set(rows.map(r => r.month))].sort();
  console.log(`OPENWATCH ON BET365 1X2 — ${rows.length} matches with Bet365 1X2 open+close and Bet365 + Pinnacle AH/TL (${rows.filter(r => r.So).length} with Sbobet too), ${months[0]}…${months[months.length - 1]} · ${((Date.now() - t0) / 1000).toFixed(0)} s`);

  // Model calibration at Pinnacle's actual close: does the scoreline 1X2 match results?
  const cal = [0, 1, 2].map(() => ({ p: 0, w: 0 }));
  for (const r of rows) { const q = x12Of(r.Pc.mu, r.Pc.s); for (let i = 0; i < 3; i++) { cal[i].p += q[i]; cal[i].w += won(i, r.ft) ? 1 : 0; } }
  console.log(`\nMODEL CHECK — 1X2 from Pinnacle's closing μ/s vs results: ${SIDES.map((sd, i) => `${sd} ${(cal[i].p / rows.length * 100).toFixed(1)}% vs ${(cal[i].w / rows.length * 100).toFixed(1)}% actual`).join(' · ')}`);

  // Walk-forward
  const bets = [];
  for (let mi = 3; mi < months.length; mi++) {
    const train = rows.filter(r => r.month < months[mi]), test = rows.filter(r => r.month === months[mi]);
    const tS = train.filter(r => r.So);
    const W = {
      muS: ols(tS.map(r => [1, r.Bo.mu, r.Po.mu, r.So.mu]), tS.map(r => r.Pc.mu)), sS: ols(tS.map(r => [1, r.Bo.s, r.Po.s, r.So.s]), tS.map(r => r.Pc.s)),
      mu: ols(train.map(r => [1, r.Bo.mu, r.Po.mu]), train.map(r => r.Pc.mu)), s: ols(train.map(r => [1, r.Bo.s, r.Po.s]), train.map(r => r.Pc.s)),
    };
    for (const r of test) {
      const hs = !!r.So && tS.length > 500;
      const mu = hs ? dot(W.muS, [1, r.Bo.mu, r.Po.mu, r.So.mu]) : dot(W.mu, [1, r.Bo.mu, r.Po.mu]);
      const s = hs ? dot(W.sS, [1, r.Bo.s, r.Po.s, r.So.s]) : dot(W.s, [1, r.Bo.s, r.Po.s]);
      const q = x12Of(mu, s), qc = x12Of(r.Pc.mu, r.Pc.s);
      for (let i = 0; i < 3; i++) {
        const e = r.xo[i] * q[i] - 1;
        bets.push({ month: r.month, side: i, e, po: r.xo[i], pc: r.xc[i], win: won(i, r.ft), clv: r.xo[i] * qc[i] - 1, hs, lg: r.lg, blind: true });
      }
    }
  }
  const line = (lab, L, priceKey = 'po') => {
    if (!L.length) return `  ${lab.padEnd(34)}     0`;
    const pl = L.reduce((t, b) => t + (b.win ? b[priceKey] - 1 : -1), 0), clv = L.reduce((t, b) => t + b.clv, 0) / L.length;
    const byM = {}; for (const b of L) { byM[b.month] = (byM[b.month] || 0) + (b.win ? b[priceKey] - 1 : -1); }
    const pos = Object.values(byM).filter(v => v > 0).length;
    const p = L.filter(b => b.win).length / L.length, avg = L.reduce((t, b) => t + b[priceKey], 0) / L.length;
    return `  ${lab.padEnd(34)} ${String(L.length).padStart(6)} · ROI ${pct(pl / L.length).padStart(7)} · ${pos}/${Object.keys(byM).length} months + · hit ${(p * 100).toFixed(1)}% at avg ${avg.toFixed(2)} · CLV vs Pinnacle close ${pct(clv)}`;
  };
  const tm = months.slice(3);
  console.log(`\nWALK-FORWARD — ${tm.length} test months (${tm[0]}…${tm[tm.length - 1]}), weights fitted on earlier months only; one unit per side at Bet365's OPENING 1X2 price:`);
  console.log(line('blind (every side)', bets));
  for (const sd of [0, 1, 2]) console.log(line(`  blind ${SIDES[sd]}`, bets.filter(b => b.side === sd)));
  for (const X of MINS) {
    const L = bets.filter(b => b.e * 100 >= X && b.e < 0.5);
    console.log(`\n Bet365 opening ≥ ${X}% above the predicted close:`);
    console.log(line('all', L));
    console.log(line('  same picks at Bet365 CLOSING price', L, 'pc'));
    for (const sd of [0, 1, 2]) console.log(line(`  ${SIDES[sd]}`, L.filter(b => b.side === sd)));
    for (const [lab, lo, hi] of [['  price < 2', 0, 2], ['  2–3', 2, 3], ['  3–5', 3, 5], ['  ≥ 5', 5, 1e9]]) console.log(line(lab, L.filter(b => b.po >= lo && b.po < hi)));
    console.log(line('  Sbobet listed', L.filter(b => b.hs)));
    console.log(line('  no Sbobet', L.filter(b => !b.hs)));
  }
  console.log('\nCLV = Bet365 opening price × p(Pinnacle\'s actual closing μ/s, same model) − 1: how far the price beat where the sharp market closed. The model check above shows the model\'s own 1X2 bias at the close.');
}
main();
