'use strict';
/**
 * Tests for Strategy CROSSMARKET (crossmarket.js) and its report — made-up
 * prices, nothing fetched or sent (notify.js is not required).
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const FM = require('./fair_model.js');
const X = require('./crossmarket');

// Prices generated from one scoreline model, with a margin: every market agrees.
const lh = 1.6, la = 1.1, P = FM.scoreGrid(lh, la);
const fairAH = s => FM.fairOddsFromDist(FM.ahDist(P, -0.5, s));
const fairOU = s => FM.fairOddsFromDist(FM.ouDist(P, 2.5, s));
const res = FM.markets(lh, la).result.map(r => r.fair);
const vig = (o, m) => +(o / (1 + m)).toFixed(3);
const odds = { ah_hc: -0.5, ho_c: vig(fairAH('home'), 0.025), ao_c: vig(fairAH('away'), 0.025), tl_c: 2.5, ov_c: vig(fairOU('over'), 0.025), un_c: vig(fairOU('under'), 0.025) };
Object.assign(odds, { ah_ho: odds.ah_hc, ho_o: odds.ho_c, ao_o: odds.ao_c, tl_o: odds.tl_c, ov_o: odds.ov_c, un_o: odds.un_c });
const x2 = { home_c: vig(res[0], 0.05), draw_c: vig(res[1], 0.05), away_c: vig(res[2], 0.05) };
Object.assign(x2, { home_o: x2.home_c, draw_o: x2.draw_c, away_o: x2.away_c });

let rows = X.analyse(odds, x2);
assert.strictEqual(rows.length, 5, '3 × 1X2 + 2 × AH');
for (const r of rows) assert(r.edge < 0 && r.edge > -0.08, `consistent markets → only the margin (${r.ty} ${r.side} ${(r.edge * 100).toFixed(1)}%)`);
assert(rows.every(r => r.unmoved), 'nothing moved since opening');
const A = rows.find(r => r.ty === 'A' && r.side === 'home');
assert(Math.abs(A.fair - res[0]) / res[0] < 0.01, '1X2 fair from the AH ≈ the generating model');

// Bet365 1X2 home 10% too long → A home edge ≈ +10% − margin; B now prices from a 1X2 that favours away
rows = X.analyse(odds, { ...x2, home_c: +(x2.home_c * 1.10).toFixed(3) });
const Ah = rows.find(r => r.ty === 'A' && r.side === 'home');
assert(Ah.edge > 0.03 && Ah.edge < 0.08, `1X2 home long → A edge ${(Ah.edge * 100).toFixed(1)}%`);
assert(!rows[0].unmoved, '1X2 moved from its opening');
const Bh = rows.find(r => r.ty === 'B' && r.side === 'home');
assert(rows.find(r => r.ty === 'B' && r.side === 'away').edge > Bh.edge, 'a longer 1X2 home = the 1X2 rates home less likely → Bet365 AH away looks better');

// Quarter line: exact expected return, not price/fair − 1
const q = X.analyse({ ...odds, ah_hc: -0.75, ah_ho: -0.75 }, x2).find(r => r.ty === 'B' && r.side === 'home');
assert(q && isFinite(q.fair));

// Unusable snapshots
assert.deepStrictEqual(X.analyse({ ...odds, ho_c: null }, x2), []);
assert.deepStrictEqual(X.analyse(odds, { ...x2, draw_c: 1.0 }), []);
assert.deepStrictEqual(X.analyse({ ...odds, ah_hc: -0.3 }, x2), [], 'not a quarter line');

// "Lagged": the other market moved toward the side, this one followed < half
assert(X.lagged({ ty: 'B', side: 'home', mvX: 0.06, mvAH: 0.01 }));
assert(!X.lagged({ ty: 'B', side: 'home', mvX: 0.06, mvAH: 0.04 }));
assert(X.lagged({ ty: 'A', side: 'away', mvAH: -0.05, mvX: 0 }));
assert(!X.lagged({ ty: 'A', side: 'draw', mvAH: 0.1, mvX: 0 }));

// Settlement queue: checked from KO + 1h50, recovered after a restart
const ko = Date.UTC(2026, 9, 8, 18);
const pend = new Map(); X.queue(pend, 'm1', 'A v B', ko);
assert.strictEqual(pend.get('m1').nextCheck, ko + 110 * 60000);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'crossmarket-'));
const base = { t: ko - 3600000, ko, kmin: 60, sc: '0-0', lg: 'L', f: 1.9, un: false, lag: false, mvAH: 0, mvX: 0 };
const lines = [
  { ...base, id: 'w', k: 'B|AH|home|-0.5', ty: 'B', mk: 'AH', side: 'home', line: -0.5, p: 2.0, e: 6, cl: true, m: 'w' },
  { ...base, id: 'l', k: 'B|AH|away|0.5', ty: 'B', mk: 'AH', side: 'away', line: 0.5, p: 2.0, e: 7, cl: true, lag: true, m: 'l' },
  { ...base, id: 'o', k: 'A|1X2|draw|', ty: 'A', mk: '1X2', side: 'draw', line: null, p: 3.4, e: 9, un: true, cl: false, m: 'o' },
  { t: ko + 9e6, id: 'w', res: '2-0', m: 'w' }, { t: ko + 9e6, id: 'l', res: '2-0', m: 'l' },
];
fs.writeFileSync(path.join(dir, '2026-10-08.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
assert.deepStrictEqual([...X.recoverPending(dir).keys()], ['o'], 'only the unsettled fixture re-queued');
const text = require('./crossmarket_report').buildReport(dir, { tz: 'UTC' });
assert(/B — AH[\s\S]*Edge ≥ 5%:[\s\S]*?closing \(last 30 min\)\s+2 bets · settled\s+2 · \s*\+0\.00u/.test(text), 'B closing: one won (+1), one lost (−1)');
assert(/closing, other market moved, this lagged\s+1 bets · settled\s+1 · \s*-1\.00u/.test(text));
assert(/A — 1X2[\s\S]*Edge ≥ 5%:[\s\S]*?both still at opening\s+1 bets · settled\s+0 · waiting 1/.test(text));
fs.rmSync(dir, { recursive: true });
// The bot's copy of fair_model.js must match the app's (Railway can't reach ../static).
const local = fs.readFileSync(path.join(__dirname, 'fair_model.js'), 'utf8'), app = fs.readFileSync(path.join(__dirname, '../static/fair_model.js'), 'utf8');
assert.strictEqual(local.slice(local.indexOf('*/\n') + 3), app, 'telegram/fair_model.js out of sync with static/fair_model.js — copy it again (keep the header)');
console.log('crossmarket: all tests passed');
