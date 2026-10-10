'use strict';
/**
 * Research (2026-10-10), on CrossBooks/{Bet365,Sbobet,Pinnacle}_Data_months:
 *
 * (c) WHERE IS THE CLOSING PRICE BIASED — every AH and O/U side at Pinnacle's
 *     closing line, bet blind: return at Pinnacle's de-vigged fair price (= the
 *     bias itself; 0 if the close is right), at Pinnacle's own price, at
 *     Bet365's price on the same line and at the best price of the three books
 *     on that line (what a bettor with all three accounts could get). By side,
 *     favourite/underdog, line, total, tier, league, calendar month. Each
 *     segment shows both halves of the period separately — a real bias has the
 *     same sign in both.
 *
 * (e) TEAM RATINGS FROM THE MARKET — every team gets a supremacy rating and a
 *     goals rating, updated after each match from Pinnacle's closing price
 *     (μ, s via market_fit.js) — so before any match the ratings only know
 *     earlier prices. Tests: (e1) does the rating predict Pinnacle's close
 *     beyond the openings? (e2) do teams that beat their price keep beating it
 *     (form vs the market)? (e3) are some teams persistently over/under-rated
 *     (first half vs second half of the period)?
 *
 *   node research_bias_ratings.js
 */
const fs = require('fs');
const path = require('path');
const MF = require('./market_fit');
const { bookTime } = require('./research_books');
const { classifyLeague } = require('./engine');

const ROOT = path.join(__dirname, '..', 'CrossBooks');
const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;

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
const devig2 = (a, b) => { const s = 1 / a + 1 / b; return [a * s, b * s]; }; // fair odds
const stats = arr => {
  const n = arr.length; if (!n) return null;
  const m = arr.reduce((a, b) => a + b, 0) / n, sd = Math.sqrt(arr.reduce((a, b) => a + (b - m) ** 2, 0) / Math.max(1, n - 1));
  return { n, m, z: m / (sd / Math.sqrt(n)) };
};

function main() {
  const t0 = Date.now();
  const B = load('Bet365'), S = load('Sbobet'), P = load('Pinnacle');
  const matches = [];
  for (const [k, p] of P) {
    const ft = score(p['FT Result']); if (!ft) continue;
    const [date, time, home, away] = k.split('|');
    matches.push({ k, date, time, home, away, league: p.League, month: date.slice(0, 7), ft, p, b: B.get(k), s: S.get(k) });
  }
  matches.sort((a, b) => (a.date + a.time).localeCompare(b.date + b.time));
  const months = [...new Set(matches.map(m => m.month))].sort();
  const firstHalf = new Set(months.slice(0, Math.floor(months.length / 2)));
  console.log(`${matches.length} Pinnacle matches with a result, ${months.length} months (${months[0]}…${months[months.length - 1]}); halves: ${[...firstHalf][0]}…${[...firstHalf].pop()} / the rest`);

  // ═══ (c) bias map ═══
  const sides = [];
  for (const m of matches) {
    const pl = num(m.p['Home AH Closing']), ph = num(m.p['Home Odds Closing']), pa = num(m.p['Away Odds Closing']);
    const tl = num(m.p['Total Line Closing']), po = num(m.p['Over Odds Closing']), pu = num(m.p['Under Odds Closing']);
    const tier = classifyLeague(m.league || '');
    const half = firstHalf.has(m.month) ? 1 : 2, cm = m.date.slice(5, 7);
    const sameAH = o => o && num(o['Home AH Closing']) === pl ? [num(o['Home Odds Closing']), num(o['Away Odds Closing'])] : null;
    const sameOU = o => o && num(o['Total Line Closing']) === tl ? [num(o['Over Odds Closing']), num(o['Under Odds Closing'])] : null;
    const gd = m.ft[0] - m.ft[1], tot = m.ft[0] + m.ft[1];
    if (pl != null && ph > 1 && pa > 1 && Math.abs(pl * 4 - Math.round(pl * 4)) < 1e-6) {
      const [fh, fa] = devig2(ph, pa), b = sameAH(m.b), s = sameAH(m.s);
      const favHome = pl < 0 || (pl === 0 && ph < pa);
      for (const [side, value, line, fair, pin, b3, sb] of [['home', gd, pl, fh, ph, b?.[0], s?.[0]], ['away', -gd, -pl, fa, pa, b?.[1], s?.[1]]]) {
        const best = Math.max(pin, b3 > 1 ? b3 : 0, sb > 1 ? sb : 0);
        const fav = (side === 'home') === favHome;
        sides.push({ mk: 'AH', side, role: fav ? 'fav' : 'dog', homeFav: favHome, line: Math.abs(pl), tl, tier, league: m.league, half, cm, month: m.month,
          rFair: MF.ret(value, line, fair) - 1, rPin: MF.ret(value, line, pin) - 1, rB: b3 > 1 ? MF.ret(value, line, b3) - 1 : null, rBest: MF.ret(value, line, best) - 1, fair });
      }
    }
    if (tl != null && po > 1 && pu > 1 && Math.abs(tl * 4 - Math.round(tl * 4)) < 1e-6) {
      const [fo, fu] = devig2(po, pu), b = sameOU(m.b), s = sameOU(m.s);
      for (const [side, value, line, fair, pin, b3, sb] of [['over', tot, -tl, fo, po, b?.[0], s?.[0]], ['under', -tot, tl, fu, pu, b?.[1], s?.[1]]]) {
        const best = Math.max(pin, b3 > 1 ? b3 : 0, sb > 1 ? sb : 0);
        sides.push({ mk: 'OU', side, role: side, tl, tier, league: m.league, half, cm, month: m.month,
          rFair: MF.ret(value, line, fair) - 1, rPin: MF.ret(value, line, pin) - 1, rB: b3 > 1 ? MF.ret(value, line, b3) - 1 : null, rBest: MF.ret(value, line, best) - 1, fair });
      }
    }
  }
  const row = (label, L) => {
    const f = stats(L.map(o => o.rFair)); if (!f || f.n < 500) return null;
    const h1 = stats(L.filter(o => o.half === 1).map(o => o.rFair)), h2 = stats(L.filter(o => o.half === 2).map(o => o.rFair));
    const pin = stats(L.map(o => o.rPin)), best = stats(L.map(o => o.rBest)), b3 = stats(L.filter(o => o.rB != null).map(o => o.rB));
    const byM = {}; for (const o of L) (byM[o.month] = byM[o.month] || []).push(o.rBest);
    const posM = Object.values(byM).filter(a => a.reduce((x, y) => x + y, 0) > 0).length;
    const same = h1 && h2 && Math.sign(h1.m) === Math.sign(h2.m);
    return { label, f, h1, h2, pin, best, b3, posM, nM: Object.keys(byM).length, same,
      text: `  ${label.padEnd(34)} ${String(f.n).padStart(7)} · at fair ${pct(f.m).padStart(6)} (z ${f.z.toFixed(1).padStart(5)}; halves ${pct(h1?.m ?? 0)} / ${pct(h2?.m ?? 0)}${same ? '' : ' ✗'}) · Pinnacle ${pct(pin.m).padStart(6)} · Bet365 ${b3 ? pct(b3.m).padStart(6) : '   —  '} · best ${pct(best.m).padStart(6)} (${posM}/${Object.keys(byM).length} mo)` };
  };
  const show = (title, groups) => {
    console.log(`\n${title}`);
    for (const [label, L] of groups) { const r = row(label, L); if (r) console.log(r.text); }
  };
  const AH = sides.filter(o => o.mk === 'AH'), OU = sides.filter(o => o.mk === 'OU');
  console.log(`\n(c) WHERE IS THE CLOSING PRICE BIASED — blind 1 unit on every side at Pinnacle's closing line. "at fair" = Pinnacle's de-vigged price (the bias itself), then Pinnacle's price, Bet365's (same line), best of the 3 books (same line).`);
  show('Overall:', [['AH all sides', AH], ['O/U all sides', OU]]);
  show('AH favourite / underdog:', [['favourite', AH.filter(o => o.role === 'fav')], ['underdog', AH.filter(o => o.role === 'dog')],
    ['home favourite', AH.filter(o => o.role === 'fav' && o.homeFav)], ['away favourite', AH.filter(o => o.role === 'fav' && !o.homeFav)],
    ['home underdog', AH.filter(o => o.role === 'dog' && !o.homeFav)], ['away underdog', AH.filter(o => o.role === 'dog' && o.homeFav)],
    ['home side (any)', AH.filter(o => o.side === 'home')], ['away side (any)', AH.filter(o => o.side === 'away')]]);
  show('AH by favourite\'s line (fav / dog):', [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].flatMap(l => {
    const L = AH.filter(o => (l === 2 ? o.line >= 2 : Math.abs(o.line - l) < 1e-6));
    return [[`line ${l === 2 ? '2+' : l} favourite`, L.filter(o => o.role === 'fav')], [`line ${l === 2 ? '2+' : l} underdog`, L.filter(o => o.role === 'dog')]];
  }));
  show('O/U by goal line:', [1.75, 2, 2.25, 2.5, 2.75, 3, 3.25, 3.5].flatMap(t => {
    const L = OU.filter(o => (t === 1.75 ? o.tl <= 1.75 : t === 3.5 ? o.tl >= 3.5 : o.tl === t));
    const lab = t === 1.75 ? '≤1.75' : t === 3.5 ? '3.5+' : t;
    return [[`TL ${lab} over`, L.filter(o => o.side === 'over')], [`TL ${lab} under`, L.filter(o => o.side === 'under')]];
  }));
  show('By tier:', ['TOP', 'MAJOR', 'OTHER'].flatMap(t => [[`${t} AH fav`, AH.filter(o => o.tier === t && o.role === 'fav')], [`${t} AH dog`, AH.filter(o => o.tier === t && o.role === 'dog')],
    [`${t} over`, OU.filter(o => o.tier === t && o.side === 'over')], [`${t} under`, OU.filter(o => o.tier === t && o.side === 'under')]]));
  show('By calendar month (AH fav / O/U over):', ['01', '02', '03', '04', '05', '06', '07', '08', '09', '10', '11', '12'].flatMap(c =>
    [[`month ${c} AH fav`, AH.filter(o => o.cm === c && o.role === 'fav')], [`month ${c} over`, OU.filter(o => o.cm === c && o.side === 'over')]]));
  // Leagues: every league with enough sides; only show consistent, sizeable biases (many leagues → some look biased by chance)
  const leagues = [...new Set(sides.map(o => o.league))];
  const lgRows = [];
  for (const lg of leagues) for (const [lab, f] of [['AH fav', o => o.mk === 'AH' && o.role === 'fav'], ['AH dog', o => o.mk === 'AH' && o.role === 'dog'], ['over', o => o.side === 'over'], ['under', o => o.side === 'under']]) {
    const L = sides.filter(o => o.league === lg && f(o)); if (L.length < 600) continue;
    const r = row(`${lg.slice(0, 26)} ${lab}`, L); if (r) lgRows.push(r);
  }
  const tested = lgRows.length;
  const strong = lgRows.filter(r => r.same && Math.abs(r.f.z) >= 3).sort((a, b) => b.best.m - a.best.m);
  console.log(`\nLeagues (${tested} league × side segments with ≥ 600 sides; shown: same sign in both halves AND |z| ≥ 3 — about ${(tested * 0.0027).toFixed(1)} would pass |z| ≥ 3 by chance alone):`);
  for (const r of strong) console.log(r.text);
  if (!strong.length) console.log('  none');
  const posBest = lgRows.filter(r => r.best.m > 0 && r.same && r.h1.m > 0).sort((a, b) => b.best.m - a.best.m).slice(0, 12);
  console.log('\nLeague segments with a POSITIVE return at the best price and a positive bias in both halves (top 12 by best-price ROI):');
  for (const r of posBest) console.log(r.text);

  // ═══ (e) team ratings ═══
  console.log(`\n(e) TEAM RATINGS FROM THE MARKET — updated after each match from Pinnacle's closing μ/s; before a match they only know earlier prices.`);
  const K = 0.12, KT = 0.08;          // learning rates (supremacy, goals)
  const R = new Map();                 // team → { r, t, n, res: [] }
  const team = n => { let x = R.get(n); if (!x) R.set(n, x = { r: 0, t: 0, n: 0, resS: [], resT: [], form: 0, formT: 0 }); return x; };
  let hfa = 0.3, base = 2.6;
  const ev = [];                       // per match: rating prediction + market + result
  for (const m of matches) {
    const pc = bookTime(m.p, 'Closing'); if (!pc) continue;
    const po = bookTime(m.p, 'Opening'), bo = m.b && bookTime(m.b, 'Opening'), so = m.s && bookTime(m.s, 'Opening');
    const H = team(m.home), A = team(m.away);
    const sPred = hfa + H.r - A.r, muPred = base + H.t + A.t;
    const gd = m.ft[0] - m.ft[1], tot = m.ft[0] + m.ft[1];
    if (H.n >= 8 && A.n >= 8) ev.push({ m, sPred, muPred, pc, po, bo, so, gd, tot, formH: H.form, formA: A.form, formTH: H.formT, formTA: A.formT, half: firstHalf.has(m.month) ? 1 : 2 });
    // update toward the market's closing view
    const e = pc.s - sPred, et = pc.mu - muPred;
    H.r += K * e; A.r -= K * e; hfa += 0.002 * e;
    H.t += KT * et / 2; A.t += KT * et / 2; base += 0.002 * et;
    H.n++; A.n++;
    // results vs the closing price (form vs the market), exponentially weighted
    const rs = gd - pc.s, rt = tot - pc.mu;
    H.form = 0.85 * H.form + 0.15 * rs; A.form = 0.85 * A.form - 0.15 * rs;
    H.formT = 0.85 * H.formT + 0.15 * rt; A.formT = 0.85 * A.formT + 0.15 * rt;
    H.resS.push({ half: firstHalf.has(m.month) ? 1 : 2, v: rs }); A.resS.push({ half: firstHalf.has(m.month) ? 1 : 2, v: -rs });
  }
  console.log(`  ${R.size} teams, ${ev.length} matches where both teams had ≥ 8 earlier rated matches`);
  const rmse = (L, f) => Math.sqrt(L.reduce((s, o) => s + f(o) ** 2, 0) / L.length);
  console.log(`  how close each guess is to Pinnacle's CLOSING supremacy (RMSE, goals): rating ${rmse(ev, o => o.sPred - o.pc.s).toFixed(3)} · Pinnacle opening ${rmse(ev.filter(o => o.po), o => o.po.s - o.pc.s).toFixed(3)} · Bet365 opening ${rmse(ev.filter(o => o.bo), o => o.bo.s - o.pc.s).toFixed(3)}`);

  // (e1) rating vs the openings: does the close move toward the rating?
  const e1 = ev.filter(o => o.po && o.bo);
  const regress = (L, xs, y) => { // tiny OLS with standard errors
    const X = L.map(xs), Y = L.map(y), k = X[0].length;
    const A = Array.from({ length: k }, () => new Array(k).fill(0)), b = new Array(k).fill(0);
    for (let i = 0; i < X.length; i++) for (let p = 0; p < k; p++) { b[p] += X[i][p] * Y[i]; for (let q = 0; q < k; q++) A[p][q] += X[i][p] * X[i][q]; }
    const inv = A.map((r, i) => [...r, ...r.map((_, j) => (i === j ? 1 : 0))]);
    for (let i = 0; i < k; i++) { let p = i; for (let r = i + 1; r < k; r++) if (Math.abs(inv[r][i]) > Math.abs(inv[p][i])) p = r; [inv[i], inv[p]] = [inv[p], inv[i]];
      const d = inv[i][i]; for (let c = 0; c < 2 * k; c++) inv[i][c] /= d;
      for (let r = 0; r < k; r++) if (r !== i) { const f = inv[r][i]; for (let c = 0; c < 2 * k; c++) inv[r][c] -= f * inv[i][c]; } }
    const Ai = inv.map(r => r.slice(k)), w = Ai.map(r => r.reduce((s, v, j) => s + v * b[j], 0));
    const res = X.map((x, i) => Y[i] - x.reduce((s, v, j) => s + v * w[j], 0)), s2 = res.reduce((s, v) => s + v * v, 0) / (X.length - k);
    return { w, se: Ai.map((r, i) => Math.sqrt(s2 * r[i])), rmse: Math.sqrt(s2) };
  };
  const g1 = regress(e1, o => [1, o.po.s, o.bo.s, o.sPred], o => o.pc.s), g0 = regress(e1, o => [1, o.po.s, o.bo.s], o => o.pc.s);
  console.log(`  (e1) Pinnacle close s ≈ ${g1.w.map(v => v.toFixed(3)).join(' / ')} on [1, Pinnacle open, Bet365 open, RATING] — rating weight ${g1.w[3].toFixed(3)} ± ${g1.se[3].toFixed(3)}; RMSE ${g0.rmse.toFixed(4)} → ${g1.rmse.toFixed(4)} with the rating`);
  const e1s = ev.filter(o => o.po && o.bo && o.so);
  const g1s = regress(e1s, o => [1, o.po.s, o.bo.s, o.so.s, o.sPred], o => o.pc.s);
  console.log(`       with Sbobet's opening too (${e1s.length} matches): rating weight ${g1s.w[4].toFixed(3)} ± ${g1s.se[4].toFixed(3)}`);
  const t1 = regress(e1, o => [1, o.po.mu, o.bo.mu, o.muPred], o => o.pc.mu);
  console.log(`       total goals: rating weight ${t1.w[3].toFixed(3)} ± ${t1.se[3].toFixed(3)}`);

  // (e2) form vs the market: do results above/below the price predict the next one?
  const e2 = regress(ev, o => [1, o.formH - o.formA], o => o.gd - o.pc.s);
  const e2t = regress(ev, o => [1, o.formTH + o.formTA], o => o.tot - o.pc.mu);
  console.log(`  (e2) next match's (goal difference − closing supremacy) on teams' recent (results − price), home − away: slope ${e2.w[1].toFixed(4)} ± ${e2.se[1].toFixed(4)} (0 = the market already prices form)`);
  console.log(`       next match's (goals − closing total) on teams' recent (goals − total): slope ${e2t.w[1].toFixed(4)} ± ${e2t.se[1].toFixed(4)}`);
  // betting it: AH at the best closing price on the side whose form beats the other's by ≥ X
  const bestAH = (o, side) => {
    const pl = num(o.m.p['Home AH Closing']); const same = x => x && num(x['Home AH Closing']) === pl;
    const pr = i => [num(o.m.p[i]), same(o.m.b) ? num(o.m.b[i]) : 0, same(o.m.s) ? num(o.m.s[i]) : 0];
    return { pl, best: Math.max(...pr(side === 'home' ? 'Home Odds Closing' : 'Away Odds Closing').filter(x => x > 1)) };
  };
  for (const X of [0.3, 0.6]) {
    const r = { in: [], out: [] };
    for (const o of ev) {
      const d = o.formH - o.formA; if (Math.abs(d) < X) continue;
      for (const [k, side] of [['in', d > 0 ? 'home' : 'away'], ['out', d > 0 ? 'away' : 'home']]) {
        const { pl, best } = bestAH(o, side);
        if (!(best > 1) || pl == null) continue;
        r[k].push({ half: o.half, v: MF.ret(side === 'home' ? o.gd : -o.gd, side === 'home' ? pl : -pl, best) - 1 });
      }
    }
    const fmt = L => { const s = stats(L.map(x => x.v)), h1 = stats(L.filter(x => x.half === 1).map(x => x.v)), h2 = stats(L.filter(x => x.half === 2).map(x => x.v)); return `${s.n} bets, ROI ${pct(s.m)} (halves ${pct(h1.m)} / ${pct(h2.m)})`; };
    console.log(`       form gap ≥ ${X} goals, AH at the best closing price — in-form side: ${fmt(r.in)} · out-of-form side: ${fmt(r.out)}`);
  }

  // (e3) persistent over/under-rating: team's mean (result − price) in the first half vs the second
  const pairs = [];
  for (const [n, x] of R) {
    const a = x.resS.filter(v => v.half === 1).map(v => v.v), b = x.resS.filter(v => v.half === 2).map(v => v.v);
    if (a.length >= 15 && b.length >= 15) pairs.push([a.reduce((s, v) => s + v, 0) / a.length, b.reduce((s, v) => s + v, 0) / b.length, n, a.length, b.length]);
  }
  const mx = pairs.reduce((s, p) => s + p[0], 0) / pairs.length, my = pairs.reduce((s, p) => s + p[1], 0) / pairs.length;
  const cov = pairs.reduce((s, p) => s + (p[0] - mx) * (p[1] - my), 0), vx = pairs.reduce((s, p) => s + (p[0] - mx) ** 2, 0), vy = pairs.reduce((s, p) => s + (p[1] - my) ** 2, 0);
  const corr = cov / Math.sqrt(vx * vy);
  console.log(`  (e3) ${pairs.length} teams with ≥ 15 matches in each half: correlation of (results − price) between the halves ${corr.toFixed(3)} (≈ ${(2 / Math.sqrt(pairs.length)).toFixed(3)} would be noise)`);
  const top = [...pairs].sort((a, b) => b[0] - a[0]);
  const q = Math.floor(pairs.length / 5);
  const avg = L => L.reduce((s, p) => s + p[1], 0) / L.length;
  console.log(`       teams in the top fifth of the first half beat their price by ${avg(top.slice(0, q)).toFixed(3)} goals/match in the second half; bottom fifth ${avg(top.slice(-q)).toFixed(3)} (first half: ${(top.slice(0, q).reduce((s, p) => s + p[0], 0) / q).toFixed(3)} / ${(top.slice(-q).reduce((s, p) => s + p[0], 0) / q).toFixed(3)})`);
  console.log(`\nDone in ${((Date.now() - t0) / 1000).toFixed(0)} s.`);
}

main();
