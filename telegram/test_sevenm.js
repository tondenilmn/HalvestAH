'use strict';
// Tests for sevenm.js (7msport Bet365 check before PRICEGAP alerts) — no network.
const assert = require('assert');
const S = require('./sevenm');

// Fixture page: GMT+8 kick-off → UTC
const fx = S.parseFixtures(`var live_bh_Arr = [ 5181232,5190228 ];
var Start_time_Arr = [ '2026,10,12,13,00,0','2026,10,12,23,30,0' ];
var Team_A_Arr = [ 'Real Valladolid','Moldova Women\\'s' ];
var Team_B_Arr = [ 'Albacete Balompie','Georgia Women\\'s' ];`);
assert.strictEqual(fx.length, 2);
assert.strictEqual(fx[0].ko, Date.UTC(2026, 9, 12, 5, 0));
assert.strictEqual(fx[1].rawH, "Moldova Women's");
// Livescore page: ids + names from the analyse links
const lp = S.parseLivePage(`<a href="//analyse.7msport.com/5073337/index.shtml" class="ana" title="Club Libertad vs Club Guarani" rel="nofollow"></a>
<a href="//analyse.7msport.com/5073338/index.shtml" class="ana" title="O&#39;Connor Knights(U23) vs Cooma Tigers(U23)" rel="nofollow"></a>`);
assert.deepStrictEqual(lp.map(e => [e.id, e.rawH, e.rawA]), [['5073337', 'Club Libertad', 'Club Guarani'], ['5073338', "O'Connor Knights(U23)", 'Cooma Tigers(U23)']]);

// Index entries as refreshIndex builds them
const { kindOf } = require('./pinngap');
const mk = e => ({ ...e, home: S.norm(e.rawH), away: S.norm(e.rawA), kind: [kindOf(e.rawH, ''), kindOf(e.rawA, '')] });
const idx = [...fx, ...lp].map(mk).concat(mk({ id: '9', rawH: 'Moldova', rawA: 'Georgia', ko: Date.UTC(2026, 9, 12, 15, 30) }));
const ko = Date.UTC(2026, 9, 12, 15, 30);
assert.strictEqual(S.findMatch(idx, 'Real Valladolid', 'Albacete', Date.UTC(2026, 9, 12, 5, 0))?.id, '5181232');
assert.strictEqual(S.findMatch(idx, 'Real Valladolid', 'Albacete', Date.UTC(2026, 9, 12, 9, 0)), null, 'kick-off 4 h apart');
assert.strictEqual(S.findMatch(idx, 'Moldova (W)', 'Georgia (W)', ko)?.id, '5190228', "women's side, not the men's match");
assert.strictEqual(S.findMatch(idx, 'Moldova', 'Georgia', ko)?.id, '9', "men's side, not the women's match");
assert.strictEqual(S.findMatch(idx, 'Club Libertad', 'Guarani CA', Date.UTC(2026, 9, 11, 22, 20))?.id, '5073337', 'livescore entry, no kick-off');

// Verdicts (pricegap.js AH line = home handicap for both sides)
const b = { line: -0.25, p1: 2.02, p3: 1.85, t: Date.now() - 60000, lock: false };
const ah = side => ({ market: 'AH', side, line: -0.25, price: 2.05, fair: 1.9 });
assert.strictEqual(S.verdict(ah('home'), b, 1.995).st, 'adj', '2.02 < 2.05 but ≥ min 1.995 → sent at 2.02');
assert.strictEqual(S.verdict({ ...ah('home'), price: 2.03 }, b, 1.995).st, 'ok', 'within 0.02');
assert.strictEqual(S.verdict(ah('home'), b, 2.04).st, 'lower', 'below the minimum → blocked');
assert.strictEqual(S.verdict(ah('away'), b, 1.8).p7, 1.85, 'away price is p_3');
assert.strictEqual(S.verdict(ah('home'), { ...b, line: -0.5 }, 1.995).st, 'line', 'Bet365 moved line → blocked');
assert.strictEqual(S.verdict(ah('home'), null, 1.995).st, 'nf');
assert.strictEqual(S.verdict({ market: 'OU', side: 'under', line: 2.5, price: 1.95, fair: 1.8 }, { line: 2.5, p1: 1.9, p3: 1.95, t: Date.now() }, 1.89).st, 'ok', 'under = p_3');

// Report: blocked alerts are counted apart and settled as if sent
(() => {
  const fs = require('fs'), os = require('os'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pg7-'));
  const T = Date.UTC(2026, 9, 12, 12), row = (ev, id, x = {}) => ({ t: T, ev, id, ko: T + 3600e3, kmin: 60, pk: `${id}|AH|home|-0.25`, k: 'AH|home|-0.25', mk: 'AH', side: 'home', line: -0.25, p: 2.05, f: 1.9, e: 7.9, u: 0, sc: '0-0', ref: 'sbo', mo: 1.995, b: 'moved', m: `${id} match`, lg: 'L', ...x });
  fs.writeFileSync(path.join(dir, '2026-10-12.jsonl'), [row('alert', 'a', { v7: 'ok', p7: 2.05 }), row('blk7', 'b', { v7: 'line', line7: -0.5 }), { t: T + 9e6, id: 'a', res: '1-0' }, { t: T + 9e6, id: 'b', res: '0-0' }].map(l => JSON.stringify(l)).join('\n') + '\n');
  const txt = require('./pricegap_bets_report').buildReport(dir, { tz: 'UTC' });
  assert(/7MSPORT CHECK/.test(txt) && /confirmed by 7msport\s+1 sides · settled\s+1 ·\s+\+1\.05u/.test(txt), txt);
  assert(/BLOCKED — Bet365 on another line\s+1 sides · settled\s+1 · if sent at our price\s+-0\.50u/.test(txt), txt);
  assert(/RESULT \(1 unit per alerted side\): settled 1 /.test(txt), 'blocked rows are not in the main result');
  fs.rmSync(dir, { recursive: true });
})();
console.log('sevenm: all tests passed');
