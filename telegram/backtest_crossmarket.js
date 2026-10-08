'use strict';
/**
 * Cross-market disagreement inside Bet365 (idea #2): does one of Bet365's own
 * markets lag the others after the price moves?
 *
 *   node backtest_crossmarket.js [--dir ../static/data/Bet365] [--detail]
 *
 * For every match, at the CLOSING prices and again at the OPENING prices:
 *   A. 1X2 vs AH+TL — fit expected goals (fair_model's Dixon-Coles grid) to
 *      Bet365's own Asian handicap + goal line (two-way de-vig), price the 1X2
 *      from it, compare with Bet365's 1X2 price. Bet a 1X2 side ≥ X% above.
 *   B. AH vs 1X2+TL — fit to Bet365's 1X2 (power de-vig) + goal line, price
 *      the Asian handicap at Bet365's own line, compare with Bet365's AH
 *      price. Bet an AH side ≥ X% above.
 * Then split by which market moved (opening → closing, in fair-probability
 * terms): when the AH moved but the 1X2 didn't follow, the 1X2 should be the
 * stale one (A); when the 1X2 moved and the AH didn't, the AH (B).
 * Settled 1 unit at the price compared (FT score; quarter lines split).
 * Reports n, ROI, months positive, and the control (every side, no filter).
 *
 * Nothing is fitted to outcomes — the thresholds are fixed in advance — but
 * many variants are shown, so a winner here still needs the newest months
 * (shown per month with --detail) before it is trusted.
 */
const fs = require('fs');
const path = require('path');
const FM = require('./fair_model.js');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const DIR = path.resolve(__dirname, arg('--dir', '../static/data/Bet365'));
const DETAIL = process.argv.includes('--detail');
const RHO = FM.DEFAULT_RHO;

// ── Precomputed model table over (μ total goals, s supremacy) ──
const MU0 = 0.4, MU1 = 6.0, MUS = 0.0125, S0 = -4.5, S1 = 4.5, SS = 0.0125;
const NMU = Math.round((MU1 - MU0) / MUS) + 1, NS = Math.round((S1 - S0) / SS) + 1;
const AH_LINES = []; for (let l = -3.5; l <= 3.5 + 1e-9; l += 0.25) AH_LINES.push(+l.toFixed(2));
const TL_LINES = []; for (let t = 0.5; t <= 6.0 + 1e-9; t += 0.25) TL_LINES.push(+t.toFixed(2));
const lineIdx = (arr, v) => { const i = arr.findIndex(x => Math.abs(x - v) < 1e-6); return i; };

// For a two-way line market we store A (full-win share) and B (refund share)
// so the fair price is (1 − B)/A and returns at any price are exact.
function buildTable() {
  const t0 = Date.now();
  const cells = NMU * NS;
  const x12 = new Float32Array(cells * 3);
  const ahA = new Float32Array(cells * AH_LINES.length), ahB = new Float32Array(cells * AH_LINES.length);
  const ouA = new Float32Array(cells * TL_LINES.length), ouB = new Float32Array(cells * TL_LINES.length);
  for (let i = 0; i < NMU; i++) {
    const mu = MU0 + i * MUS;
    for (let j = 0; j < NS; j++) {
      const s = S0 + j * SS;
      const c = i * NS + j;
      const lh = Math.max((mu + s) / 2, 0.02), la = Math.max((mu - s) / 2, 0.02);
      const P = FM.scoreGrid(lh, la, RHO);
      // distributions of goal difference and total
      const dDiff = new Map(), dTot = new Map();
      let pH = 0, pD = 0;
      for (let h = 0; h < P.length; h++) for (let a = 0; a < P[h].length; a++) {
        const p = P[h][a]; if (!p) continue;
        dDiff.set(h - a, (dDiff.get(h - a) || 0) + p); dTot.set(h + a, (dTot.get(h + a) || 0) + p);
        if (h > a) pH += p; else if (h === a) pD += p;
      }
      x12[c * 3] = pH; x12[c * 3 + 1] = pD; x12[c * 3 + 2] = 1 - pH - pD;
      AH_LINES.forEach((L, k) => { let A = 0, B = 0; for (const [d, p] of dDiff) { const r = ret(d, L); A += p * r.a; B += p * r.b; } ahA[c * AH_LINES.length + k] = A; ahB[c * AH_LINES.length + k] = B; });
      TL_LINES.forEach((T, k) => { let A = 0, B = 0; for (const [g, p] of dTot) { const r = ret(g, -T); A += p * r.a; B += p * r.b; } ouA[c * TL_LINES.length + k] = A; ouB[c * TL_LINES.length + k] = B; });
    }
  }
  console.error(`model table ${NMU}×${NS} built in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  return { x12, ahA, ahB, ouA, ouB };
}
// Return at price q for margin m vs line L as a·q + b (quarter lines split).
function ret(m, L) {
  const one = x => (x > 1e-9 ? { a: 1, b: 0 } : x < -1e-9 ? { a: 0, b: 0 } : { a: 0, b: 1 });
  if (Math.abs(Math.abs(L * 4) % 2 - 1) < 1e-6) { const u = one(m + L - 0.25), v = one(m + L + 0.25); return { a: (u.a + v.a) / 2, b: (u.b + v.b) / 2 }; }
  return one(m + L);
}
const fairOf = (A, B) => (A > 1e-9 ? (1 - B) / A : Infinity);

// ── Solvers on the table: alternate μ (from the goal line) and s ──
function fit(T, tlK, overFair, sideFn) {
  // sideFn(c) → value that increases with s (goal-difference market) and
  // its target; returns {i, j} best cell.
  let i = Math.round((2.6 - MU0) / MUS), j = Math.round((0 - S0) / SS);
  const ouFair = c => fairOf(T.ouA[c * TL_LINES.length + tlK], T.ouB[c * TL_LINES.length + tlK]);
  for (let it = 0; it < 12; it++) {
    const pi = i, pj = j;
    // over fair odds fall as μ rises: smallest i with ouFair ≤ target
    let lo = 0, hi = NMU - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (ouFair(m * NS + j) > overFair) lo = m + 1; else hi = m; }
    i = lo;
    lo = 0; hi = NS - 1;
    while (lo < hi) { const m = (lo + hi) >> 1; if (sideFn(i * NS + m) < 0) lo = m + 1; else hi = m; }
    j = lo;
    if (i === pi && j === pj) break;
  }
  return i * NS + j;
}
// From AH + TL: home AH fair odds fall as s rises.
function cellFromAH(T, ahK, ahHomeFair, tlK, overFair) {
  return fit(T, tlK, overFair, c => ahHomeFair - fairOf(T.ahA[c * AH_LINES.length + ahK], T.ahB[c * AH_LINES.length + ahK]));
}
// From 1X2 + TL: pH − pA rises with s.
function cellFrom1x2(T, pH, pA, tlK, overFair) {
  return fit(T, tlK, overFair, c => (T.x12[c * 3] - T.x12[c * 3 + 2]) - (pH - pA));
}

// ── Data ──
function loadRows() {
  const out = [];
  for (const f of fs.readdirSync(DIR).filter(f => /\.csv$/i.test(f)).sort()) {
    const lines = fs.readFileSync(path.join(DIR, f), 'utf8').split(/\r?\n/);
    const head = lines[0].split(',').map(s => s.trim());
    const ix = n => head.indexOf(n);
    const I = Object.fromEntries(['Date', 'League', 'Home AH Closing', 'Home AH Opening', 'Home Odds Closing', 'Home Odds Opening', 'Away Odds Closing', 'Away Odds Opening',
      'Total Line Closing', 'Total Line Opening', 'Over Odds Closing', 'Over Odds Opening', 'Under Odds Closing', 'Under Odds Opening', 'FT Result',
      '1X2 Home Closing', '1X2 Draw Closing', '1X2 Away Closing', '1X2 Home Opening', '1X2 Draw Opening', '1X2 Away Opening'].map(n => [n, ix(n)]));
    for (let k = 1; k < lines.length; k++) {
      const c = lines[k].split(',');
      if (c.length < head.length - 2) continue;
      const n = name => { const v = parseFloat(c[I[name]]); return isFinite(v) ? v : null; };
      const ft = /^(\d+)-(\d+)$/.exec((c[I['FT Result']] || '').trim()); if (!ft) continue;
      const snap = w => ({
        ah: n(`Home AH ${w}`), ho: n(`Home Odds ${w}`), ao: n(`Away Odds ${w}`),
        tl: n(`Total Line ${w}`), ov: n(`Over Odds ${w}`), un: n(`Under Odds ${w}`),
        x: [n(`1X2 Home ${w}`), n(`1X2 Draw ${w}`), n(`1X2 Away ${w}`)],
      });
      out.push({ month: (c[I.Date] || '').slice(0, 7), league: c[I.League], h: +ft[1], a: +ft[2], C: snap('Closing'), O: snap('Opening') });
    }
  }
  return out;
}
const ok2 = (p, q) => p > 1.01 && q > 1.01 && (1 / p + 1 / q) > 1.0 && (1 / p + 1 / q) < 1.15;
const ok3 = x => x.every(v => v > 1.01) && x.reduce((s, v) => s + 1 / v, 0) > 1.0 && x.reduce((s, v) => s + 1 / v, 0) < 1.25;

// Fair probabilities of one snapshot, both ways. null if unusable.
function analyse(T, S) {
  if (!ok2(S.ho, S.ao) || !ok2(S.ov, S.un) || !ok3(S.x)) return null;
  const ahK = lineIdx(AH_LINES, S.ah), tlK = lineIdx(TL_LINES, S.tl);
  if (ahK < 0 || tlK < 0) return null;
  const ahF = FM.devig([S.ho, S.ao]).fair, ouF = FM.devig([S.ov, S.un]).fair, xP = FM.devigPower(S.x).probs;
  const cA = cellFromAH(T, ahK, ahF[0], tlK, ouF[0]);
  const cB = cellFrom1x2(T, xP[0], xP[2], tlK, ouF[0]);
  const x12FromAH = [0, 1, 2].map(k => T.x12[cA * 3 + k]);
  return { x12FromAH, xP, ahF, cB, ahK, tlK };
}

// Away AH shares at the home line L, from the same cell (exact for quarter lines).
function awayShares(T, c, L) {
  // away margin = −(home margin); away line = −L → evaluate on the diff dist via table of home at line −(−L)? use mirror:
  // P_away(win | L) over diff d equals P_home(win | −L) over diff −d, which is the home line −L with s → −s.
  const i = Math.floor(c / NS), j = c % NS, jm = (NS - 1) - j; // s → −s
  const k = lineIdx(AH_LINES, -L);
  if (k < 0) return null;
  return { A: T.ahA[(i * NS + jm) * AH_LINES.length + k], B: T.ahB[(i * NS + jm) * AH_LINES.length + k] };
}

function settle(mk, side, line, h, a, price) {
  if (mk === '1X2') return (side === 0 ? h > a : side === 1 ? h === a : a > h) ? price : 0;
  const m = side === 0 ? h - a : a - h; const r = ret(m, side === 0 ? line : -line);
  return r.a * price + r.b;
}

function main() {
  const T = buildTable();
  const rows = loadRows();
  const months = [...new Set(rows.map(r => r.month))].sort();
  console.log(`${rows.length} matches, ${months.length} months (${months[0]} … ${months[months.length - 1]})`);
  const buckets = new Map(); // name → Map(month → {n, pl})
  const add = (name, month, pl) => {
    if (!buckets.has(name)) buckets.set(name, new Map());
    const m = buckets.get(name); const v = m.get(month) || { n: 0, pl: 0 }; v.n++; v.pl += pl; m.set(month, v);
  };
  let used = 0;
  const t0 = Date.now();
  for (const r of rows) {
    const C = analyse(T, r.C), O = analyse(T, r.O);
    if (!C) continue;
    used++;
    // Movement (fair-probability terms, home side): AH-implied vs 1X2-implied
    let mvAH = null, mvX = null;
    if (O) { mvAH = (C.x12FromAH[0] - C.x12FromAH[2]) - (O.x12FromAH[0] - O.x12FromAH[2]); mvX = (C.xP[0] - C.xP[2]) - (O.xP[0] - O.xP[2]); }
    for (const [when, S, R] of [['close', r.C, C], ['open', r.O, O]]) {
      if (!R) continue;
      // A. 1X2 vs AH+TL
      for (let k = 0; k < 3; k++) {
        const price = S.x[k], fair = 1 / R.x12FromAH[k], e = price / fair - 1;
        const pl = settle('1X2', k, null, r.h, r.a, price) - 1;
        add(`${when} A 1X2 control (every side)`, r.month, pl);
        for (const X of [3, 5, 8, 12]) if (e * 100 >= X) {
          add(`${when} A 1X2 ≥${X}% above AH-implied`, r.month, pl);
          if (X === 5) {
            const mg = S.x.reduce((t, v) => t + 1 / v, 0) - 1;
            add(`${when} A 1X2 ≥5% · 1X2 margin ${mg < 0.06 ? '<6%' : mg < 0.09 ? '6-9%' : '≥9%'}`, r.month, pl);
            add(`${when} A 1X2 ≥5% · side ${['home', 'draw', 'away'][k]}`, r.month, pl);
            add(`${when} A 1X2 ≥5% · price ${price < 1.7 ? '<1.70' : price <= 2.5 ? '1.70-2.50' : price <= 4 ? '2.50-4' : '>4'}`, r.month, pl);
          }
          if (when === 'close' && mvAH != null && k !== 1) {
            // AH moved toward this side, 1X2 moved less (lagging)
            const dirAH = k === 0 ? mvAH : -mvAH, dirX = k === 0 ? mvX : -mvX;
            if (dirAH > 0.03 && dirX < dirAH / 2) add(`close A 1X2 ≥${X}%, AH moved this way, 1X2 lagged`, r.month, pl);
            if (Math.abs(mvAH) < 0.01 && Math.abs(mvX) < 0.01) add(`close A 1X2 ≥${X}%, nothing moved`, r.month, pl);
          }
        }
      }
      // B. AH vs 1X2+TL, at Bet365's own line
      const nA = AH_LINES.length;
      const home = { A: T.ahA[R.cB * nA + R.ahK], B: T.ahB[R.cB * nA + R.ahK] }, away = awayShares(T, R.cB, S.ah);
      for (const [side, sh, price] of [[0, home, S.ho], [1, away, S.ao]]) {
        if (!sh) continue;
        const fair = fairOf(sh.A, sh.B), e = (sh.A * price + sh.B) - 1;
        const pl = settle('AH', side, S.ah, r.h, r.a, price) - 1;
        add(`${when} B AH control (every side)`, r.month, pl);
        for (const X of [3, 5, 8, 12]) if (e * 100 >= X && isFinite(fair)) {
          add(`${when} B AH ≥${X}% above 1X2-implied`, r.month, pl);
          if (X === 5) {
            const mg = 1 / S.ho + 1 / S.ao - 1, moved = r.O.ah != null && Math.abs(r.O.ah - r.C.ah) > 0.01;
            add(`${when} B AH ≥5% · AH margin ${mg < 0.04 ? '<4%' : mg < 0.06 ? '4-6%' : '≥6%'}`, r.month, pl);
            add(`${when} B AH ≥5% · AH line ${moved ? 'moved' : 'unchanged'} open→close`, r.month, pl);
            add(`${when} B AH ≥5% · price ${price < 1.7 ? '<1.70' : price <= 2.5 ? '1.70-2.50' : '>2.50'}`, r.month, pl);
            add(`${when} B AH ≥5% · ${/(premier|la liga|serie a|bundesliga|ligue 1|champions|europa)/i.test(r.league) ? 'big league' : 'other league'}`, r.month, pl);
          }
          if (when === 'close' && mvX != null) {
            const dirX = side === 0 ? mvX : -mvX, dirAH = side === 0 ? mvAH : -mvAH;
            if (dirX > 0.03 && dirAH < dirX / 2) add(`close B AH ≥${X}%, 1X2 moved this way, AH lagged`, r.month, pl);
          }
        }
      }
    }
  }
  console.log(`${used} usable at the closing prices · ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  console.log(`\n${'variant'.padEnd(58)} ${'bets'.padStart(7)} ${'ROI'.padStart(7)} ${'months +'.padStart(9)}`);
  for (const [name, m] of [...buckets].sort()) {
    let n = 0, pl = 0, pos = 0, cnt = 0;
    for (const v of m.values()) { n += v.n; pl += v.pl; if (v.n >= 20) { cnt++; if (v.pl > 0) pos++; } }
    console.log(`${name.padEnd(58)} ${String(n).padStart(7)} ${((pl / n) * 100).toFixed(1).padStart(6)}% ${`${pos}/${cnt}`.padStart(9)}`);
    if (DETAIL) for (const mo of months) { const v = m.get(mo); if (v) console.log(`    ${mo} ${String(v.n).padStart(6)} ${((v.pl / v.n) * 100).toFixed(1).padStart(6)}%`); }
  }
}

if (process.argv.includes('--verify')) {
  // Table solver vs fair_model.solve on a sample of closing snapshots.
  const T = buildTable(); const rows = loadRows().filter((_, i) => i % 5000 === 0);
  let n = 0, maxd = 0, sum = 0;
  for (const r of rows) {
    const S = r.C; const R = analyse(T, S); if (!R) continue;
    const ahF = FM.devig([S.ho, S.ao]).fair, ouF = FM.devig([S.ov, S.un]).fair;
    const sol = FM.solve({ ahLine: S.ah, ahHomeFair: ahF[0], tl: S.tl, overFair: ouF[0] });
    const m = FM.markets(sol.lh, sol.la).result.map(x => x.p);
    const d = Math.max(...m.map((p, k) => Math.abs(p - R.x12FromAH[k]))); maxd = Math.max(maxd, d); sum += d; n++;
  }
  console.log(`verify: ${n} matches, 1X2 prob difference table vs solve: mean ${(sum / n * 100).toFixed(2)}pp, max ${(maxd * 100).toFixed(2)}pp`);
} else main();
