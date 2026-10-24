'use strict';
/**
 * Tests for Strategy OPENWATCH (openwatch.js + market_fit.js + its report via
 * pinngap_report.js) — pure logic, made-up prices (notify.js is not required).
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const OW = require('./openwatch');
const MF = require('./market_fit');
const PG = require('./pinngap');

// Prices → (μ, s): an even AH at −0.5 means the home side is ~0.5 goals better; symmetric over/under at 2.5 → μ ≈ 2.6–2.7
const f = MF.fitPrices({ ah: -0.5, ho: 1.95, ao: 1.95, tl: 2.5, ov: 1.95, un: 1.95 });
assert(f.s > 0.4 && f.s < 0.7 && f.mu > 2.5 && f.mu < 2.8, JSON.stringify(f));
assert.strictEqual(MF.fitPrices({ ah: -0.6, ho: 1.95, ao: 1.95, tl: 2.5, ov: 1.95, un: 1.95 }), null, 'not a quarter line');
// A higher home price on the same line = a weaker home side
assert(MF.fitPrices({ ah: -0.5, ho: 2.2, ao: 1.7, tl: 2.5, ov: 1.95, un: 1.95 }).s < f.s);

// Main line = prices closest to even
assert.strictEqual(OW.mainLine([{ line: -1, h: 2.6, a: 1.5 }, { line: -0.5, h: 1.97, a: 1.93 }, { line: 0, h: 1.5, a: 2.6 }], 'h', 'a').line, -0.5);

// Weights: with Sbobet the prediction leans on Sbobet, without it on Pinnacle
const b = { mu: 2.6, s: 0.2 }, p = { mu: 2.6, s: 0.5 }, s = { mu: 2.6, s: 0.6 };
const withS = OW.predictClose(b, p, s), noS = OW.predictClose(b, p, null);
assert(withS.hs && Math.abs(withS.s - 0.6) < 0.08, `with Sbobet ${withS.s}`);
assert(!noS.hs && noS.s > 0.4 && noS.s < 0.5, `without ${noS.s}`);
assert.strictEqual(OW.predictClose(b, null, s), null, 'Pinnacle needed');

// Rows: Bet365 has the home side too long vs Pinnacle (−0.5 @ 2.20 vs Pinnacle −0.5 even) → home row positive, away negative
const pm = { ft: { ah: [{ line: -0.5, h: 1.95, a: 1.95 }], ou: [{ line: 2.5, o: 1.95, u: 1.95 }] } };
const odds = { ah_hc: -0.5, ah_ho: -0.5, ho_c: 2.2, ho_o: 2.2, ao_c: 1.72, ao_o: 1.75, tl_c: 2.5, tl_o: 2.5, ov_c: 1.95, ov_o: 1.95, un_c: 1.95, un_o: 1.95 };
const { rows, pred } = OW.rowsFor(odds, pm, null);
const by = k => rows.find(r => r.key === k);
assert(pred && rows.length === 4);
assert(by('AH|home|-0.5').edge > 0.05 && by('AH|away|0.5').edge < 0, 'home value, away none');
assert(by('AH|home|-0.5').op === false, 'away price moved → AH not at opening');
assert(by('OU|over|2.5').op === true && Math.abs(by('OU|over|2.5').edge) < 0.06);
// Different lines are fine: Bet365 −0.75 vs Pinnacle −0.5 still priced
assert(OW.rowsFor({ ...odds, ah_hc: -0.75, ah_ho: -0.75 }, pm, null).rows.find(r => r.key === 'AH|home|-0.75'));

// Report: OPENWATCH title and the at-opening / Sbobet splits
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openwatch-'));
const T = Date.UTC(2026, 9, 11, 12), KO = T + 3 * 3600000, match = { id: 'x', home_team: 'A', away_team: 'B', league: 'L' };
const r = by('AH|home|-0.5');
const lines = [{ hb: { t: T, paired: 1, fresh: true } },
  { ...PG.recordRow(T, match, KO, { ev: 'open', r }, 30), op: 1, hs: 0 },
  { ...PG.recordRow(KO - 600000, match, KO, { ev: 'cl', r: { ...r, fair: 2.0 } }, 30), op: 1, hs: 0 },
  { t: KO + 7200000, id: 'x', res: '2-0', ht: '1-0', m: 'A v B' }];
fs.writeFileSync(path.join(dir, '2026-10-11.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
const txt = require('./pinngap_report').buildReport(dir, { tz: 'UTC', title: 'OPENWATCH' });
assert(/^OPENWATCH report/.test(txt), txt);
assert(/Bet365 still at its opening\s+1 bets · settled\s+1 · \s*\+1\.20u/.test(txt), txt);
assert(/CLV \+10\.0% \(1\)/.test(txt), 'CLV 2.20 vs closing fair 2.00');
assert(!/  1X2 /.test(txt), 'no empty 1X2 line');
fs.rmSync(dir, { recursive: true });
// Exchange leg: Betfair 1X2 net of commission vs the 1X2 of the predicted close
(() => {
  const ev = { home_odd: 2.3, draw_odd: 3.4, away_odd: 3.5, total_matched: 5000 };
  const bx = OW.exchangeRows({ mu: 2.5, s: 0.3 }, ev, { commission: 0.045 });
  assert.strictEqual(bx.length, 3);
  assert(Math.abs(bx.reduce((t, r) => t + 1 / r.fair, 0) - 1) < 1e-9, 'fair 1X2 sums to 1');
  assert(Math.abs(bx[0].price - (1 + 1.3 * 0.955)) < 1e-4, 'net of commission');
  assert(bx[0].fair < bx[2].fair, 'home favoured at s > 0');
  assert.strictEqual(OW.exchangeRows({ mu: 2.5, s: 0.3 }, { ...ev, total_matched: 200 }).length, 0, 'illiquid');
  assert.strictEqual(OW.exchangeRows({ mu: 2.5, s: 0.3 }, { ...ev, home_odd: 1.8 }).length, 0, 'wide book');
  const d2 = fs.mkdtempSync(path.join(os.tmpdir(), 'owbf-')), T = Date.UTC(2026, 9, 17, 12);
  const row = { t: T, ev: 'open', id: 'x', ko: T + 7200e3, kmin: 120, k: 'BF|1X2|away|', mk: '1X2', side: 'away', line: null, p: 3.39, f: 3.2, e: 5.9, pa: 60, sc: '0-0', m: 'A v B', lg: 'L', bf: 3.5, hs: 1 };
  fs.writeFileSync(path.join(d2, '2026-10-17.jsonl'), [{ hb: { t: T, paired: 1, fresh: true } }, row, { t: T + 9e6, id: 'x', res: '0-1' }].map(l => JSON.stringify(l)).join('\n') + '\n');
  const t2 = require('./pinngap_report').buildReport(d2, { tz: 'UTC', title: 'OPENWATCH · BETFAIR 1X2', book: 'Betfair (net of commission)', noBlind: true, edges: [2, 3, 5] });
  assert(/at Betfair \(net of commission\)'s price/.test(t2) && /  away\s+1 bets · settled\s+1 · \s*\+2\.39u/.test(t2) && !/vs blind/i.test(t2), t2);
  fs.rmSync(d2, { recursive: true });
})();
// Bet365 1X2 leg: rows vs the predicted close's 1X2, op = still at the opening price
(() => {
  const x2 = { home_c: 2.5, draw_c: 3.4, away_c: 3.0, home_o: 2.5, draw_o: 3.4, away_o: 3.0 };
  const xr = OW.x12Rows({ mu: 2.5, s: 0.3 }, x2), pr = OW.x12Probs({ mu: 2.5, s: 0.3 });
  assert.strictEqual(xr.length, 3);
  assert(Math.abs(xr[0].edge - (2.5 * pr[0] - 1)) < 1e-12 && xr.every(r => r.op), 'edge = price × p − 1, unmoved');
  assert.strictEqual(OW.x12Rows({ mu: 2.5, s: 0.3 }, { ...x2, home_c: 2.45 })[0].op, false, 'moved');
  assert.strictEqual(OW.x12Rows(null, x2).length, 0);
  assert.strictEqual(OW.x12Rows({ mu: 2.5, s: 0.3 }, null).length, 0);
})();
// Alert shape: PRICEGAP's home-handicap line, labels, p
(() => {
  const fl = require('./pricegap').fmtLine, teams = { home: 'Roma', away: 'Lazio' };
  const away = OW.toAlertRow({ mk: 'AH', side: 'away', line: 0.25, price: 2.05, fair: 1.9, edge: 0.079, op: true }, teams, fl);
  assert.deepStrictEqual([away.market, away.line, away.label, away.unmoved], ['AH', -0.25, 'Lazio +0.25', true]);
  const un = OW.toAlertRow({ mk: 'OU', side: 'under', line: 2.75, price: 2.0, fair: 1.88, edge: 0.064, op: false }, teams, fl);
  assert.deepStrictEqual([un.line, un.label], [2.75, 'Under 2.75']);
  assert(Math.abs(un.p - 1 / 1.88) < 1e-12);
  const txt = require('./pricegap').formatAlert({ league: 'Serie A', home_team: 'Roma', away_team: 'Lazio' }, [away], 120, s => s, { header: '🟣 <b>OPENWATCH</b>', edgeNote: 'vs the predicted close', threshold: 5 });
  assert(/OPENWATCH/.test(txt) && /Lazio \+0\.25/.test(txt) && /min 1\.99/.test(txt) && /vs the predicted close/.test(txt), txt);
})();
// Report: ALERTS SENT section settles alert rows at the price shown and at the minimum
(() => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'owa-')), T = Date.UTC(2026, 9, 24, 12);
  const a = { t: T, ev: 'alert', id: 'q', ko: T + 7200e3, kmin: 120, k: 'AH|away|0.25', mk: 'AH', side: 'away', line: 0.25, p: 2.05, f: 1.9, e: 7.9, pa: 60, sc: '0-0', m: 'Roma v Lazio', lg: 'L', mo: 1.995 };
  fs.writeFileSync(path.join(d, '2026-10-24.jsonl'), [{ hb: { t: T, paired: 1, fresh: true } }, a, { t: T + 9e6, id: 'q', res: '1-1' }].map(l => JSON.stringify(l)).join('\n') + '\n');
  const t = require('./pinngap_report').buildReport(d, { tz: 'UTC', title: 'OPENWATCH' });
  assert(/ALERTS SENT — 1 sides alerted on Telegram · settled 1 · at the price shown \+0\.52u/.test(t), t);
  fs.rmSync(d, { recursive: true });
})();
console.log('openwatch: all tests passed');
