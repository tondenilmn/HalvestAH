'use strict';
/**
 * Tests for Strategy LIVEMODEL (livemodel.js) and its report — pure logic on a
 * made-up dataset (notify.js is not required: it runs the real scheduler).
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const M = require('./livemodel');
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ── Remaining share of a half's goal mass
assert(close(M.remainingShare(1, 0), 1) && close(M.remainingShare(2, 0), 1));
assert(M.remainingShare(1, 30) < M.remainingShare(1, 15) && M.remainingShare(1, 15) < 1);
assert(M.remainingShare(2, 45) > 0 && M.remainingShare(2, 45) < 0.2, 'stoppage time still to come at 90\'');
assert(close(M.remainingShare(2, 50), 0), 'nothing left after stoppage');

// ── Favourite from Bet365's closing AH
assert.deepStrictEqual(M.favOf({ ah_hc: -0.5 }), { line: 0.5, side: 'HOME' });
assert.deepStrictEqual(M.favOf({ ah_hc: 0.75 }), { line: 0.75, side: 'AWAY' });
assert.deepStrictEqual(M.favOf({ ah_hc: 0, ho_c: 2.1, ao_c: 1.8 }), { line: 0, side: 'AWAY' });

// ── Synthetic pool: home favourites −0.5, TL 2.5. Each pattern repeated.
const row = (fh, dh, ff, df) => ({ fav_line: 0.5, fav_side: 'HOME', tl_c: 2.5, fav_ht: fh, dog_ht: dh, fav_ft: ff, dog_ft: df });
const db = [];
for (let i = 0; i < 200; i++) db.push(row(0, 0, 0, 0)); // 0-0 / 0-0
for (let i = 0; i < 200; i++) db.push(row(1, 0, 2, 0)); // 1-0 / 2-0
for (let i = 0; i < 200; i++) db.push(row(0, 0, 1, 1)); // 0-0 / 1-1
const odds = { ah_hc: -0.5, tl_c: 2.5 };

// Kick-off: the distribution is the pool's own FT scores.
let d = M.remainingDist(db, odds, { minute: 0, score: { home: 0, away: 0 } });
assert(!d.error && d.level === 'line+TL' && close(d.neff, 600));
const pOf = (dist, f) => dist.outcomes.filter(f).reduce((s, o) => s + o.w, 0);
assert(close(pOf(d, o => o.rh === 2 && o.ra === 0), 1 / 3));

// Half-time 0-0: only rows with HT 0-0; remaining = their 2nd-half goals.
d = M.remainingDist(db, odds, { minute: 45, isHT: true, score: { home: 0, away: 0 }, ht: { home: 0, away: 0 } });
assert(close(d.neff, 400) && close(pOf(d, o => o.rh === 1 && o.ra === 1), 0.5));
// 2nd half needs the HT score.
assert(M.remainingDist(db, odds, { minute: 60, score: { home: 0, away: 0 } }).error);

// Mid-1st-half 0-0: a row whose 1st-half goal came later is still possible,
// weighted by the chance the goal hadn't happened yet.
const r = M.remainingShare(1, 30);
d = M.remainingDist(db, odds, { minute: 30, score: { home: 0, away: 0 } });
const w10 = r; // row 1-0/2-0: P(its 1 first-half goal is still to come)
assert(close(pOf(d, o => o.rh === 2 && o.ra === 0), w10 * 200 / (400 + w10 * 200)));

// ── Pricing: at HT 0-0 the pool says 50% 0-0, 50% 1-1.
d = M.remainingDist(db, odds, { minute: 45, isHT: true, score: { home: 0, away: 0 }, ht: { home: 0, away: 0 } });
const live = { x2_h: 3, x2_x: 2.2, x2_a: 5, ah_hc: 0, ho_c: 1.9, ao_c: 1.9, tl_c: 1.75, ov_c: 2.1, un_c: 1.7 };
const rows = M.priceSides(d, live, { home: 0, away: 0 });
const by = k => rows.find(x => x.key === k);
assert(close(by('1X2|draw|').fair, 1) && close(by('1X2|draw|').edge, 1.2), 'draw certain → fair 1.00, edge +120%');
assert(!by('1X2|home|'), 'home never wins → no fair price');
assert(!by('AH|home|0'), 'level from now with no goals possible = always a push → no fair price');
// Over 1.75 on the FT total: 0 goals → lost; 2 goals → half won (Over 1.5 wins, Over 2 void).
// E(price) = 0.5·(price + 1)/2 → fair 3.00; at 2.10 → −22.5%.
assert(close(by('OU|over|1.75').fair, 3) && close(by('OU|over|1.75').edge, 0.5 * 3.1 / 2 - 1));
// Under 1.75: 0 goals → won; 2 goals → half lost. E = 0.5·1.7 + 0.5·0.5
assert(close(by('OU|under|1.75').edge, 0.5 * 1.7 + 0.5 * 0.5 - 1));
assert(by('OU|over|1.75').se > 0);

// ── Pinnacle fair lookup (livegap.gapRows shape)
assert.strictEqual(M.pinnacleFairOf([{ market: 'OU', side: 'over', line: 1.75, fair: 1.95 }], by('OU|over|1.75')), 1.95);
assert.strictEqual(M.pinnacleFairOf([{ market: 'OU', side: 'over', line: 2, fair: 1.95 }], by('OU|over|1.75')), null);

// ── Report on recorded rows + confirmed results
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livemodel-'));
const T = Date.UTC(2026, 9, 7, 15);
const rec = (id, t, k, mk, side, line, p, e, extra = {}) => ({ t, id, min: 60, sc: '0-0', ht: '0-0', k, mk, side, line, p, f: 1.9, e, se: 1, ne: 500, lv: 'line+TL', pf: null, m: id, lg: 'L', ...extra });
const lines = [
  rec('a', T, 'OU|over|1.5', 'OU', 'over', 1.5, 2.0, 6),           // first ≥5 in a → FT 1-1 → won
  rec('a', T + 60000, 'OU|under|1.5', 'OU', 'under', 1.5, 2.0, 8), // later in a → ignored by first-bet
  rec('b', T, '1X2|home|', '1X2', 'home', null, 2.2, 12, { pf: 2.0 }), // b → FT 0-0 → lost; Pinnacle agrees
  rec('c', T, 'OU|over|0.5', 'OU', 'over', 0.5, 1.8, 4),           // c → no result yet
  rec('a', T, 'AH|home|0', 'AH', 'home', 0, 1.9, -8),
  { t: T + 9e6, id: 'a', res: '1-1', ht: '0-0', m: 'a' },
  { t: T + 9e6, id: 'b', res: '0-0', ht: '0-0', m: 'b' },
];
fs.writeFileSync(path.join(dir, '2026-10-07.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
const text = require('./livemodel_report').buildReport(dir, { tz: 'UTC' });
assert(/3 matches .* 2 with a confirmed FT score/.test(text));
assert(/Edge ≥ 5%:\n\s+any price\s+2 bets · settled\s+2 · \s*\+0\.00u · ROI\s+\+0\.0% · 1 won, 1 lost/.test(text), 'first bet per match: a won +1, b lost −1');
assert(/Edge ≥ 3%:\n\s+any price\s+3 bets · settled\s+2 .* · waiting 1/.test(text), 'c waiting');
assert(/Pinnacle also above fair\s+1 bets · settled\s+1 · \s*-1\.00u/.test(text));
fs.rmSync(dir, { recursive: true });
console.log('livemodel: all tests passed');
