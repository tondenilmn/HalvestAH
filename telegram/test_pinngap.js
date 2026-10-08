'use strict';
/**
 * Tests for Strategy PINNGAP (pinngap.js + pinngap_report.js) and the PRICEGAP
 * alert report (pricegap_bets_report.js) — made-up data, nothing fetched or
 * sent (notify.js is not required).
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const G = require('./pinngap');
const LG = require('./livegap');

// ── Pinnacle raw lists → pre-match index; pairing by kick-off + names + kind
const KO = Date.UTC(2026, 9, 10, 18, 0);
const team = (alignment, name) => ({ alignment, name });
const mu = (id, h, a, start, league = 'Spain - La Liga') => ({ id, units: 'Regular', startTime: new Date(start).toISOString(), league: { name: league }, participants: [team('home', h), team('away', a)] });
const mk = (matchupId, type, prices) => ({ matchupId, type, period: 0, status: 'open', prices });
const matchups = [mu(1, 'Real Betis', 'Sevilla', KO), mu(2, 'Andorra', 'Faroe Islands', KO, 'FIFA - World Cup Qualifiers Europe Women'), mu(3, 'Old Match', 'Done', KO - 3 * 3600000)];
const markets = [
  mk(1, 'spread', [{ designation: 'home', points: -0.25, price: -105 }, { designation: 'away', points: 0.25, price: -105 }]),
  mk(1, 'total', [{ designation: 'over', points: 2.5, price: 105 }, { designation: 'under', points: 2.5, price: -115 }]),
  mk(1, 'moneyline', [{ designation: 'home', price: 140 }, { designation: 'draw', price: 230 }, { designation: 'away', price: 210 }]),
  mk(2, 'moneyline', [{ designation: 'home', price: 400 }, { designation: 'draw', price: 300 }, { designation: 'away', price: -150 }]),
  mk(3, 'moneyline', [{ designation: 'home', price: 100 }, { designation: 'draw', price: 300 }, { designation: 'away', price: 200 }]),
];
const idx = G.prematchIndex(markets, matchups, KO - 3600000);
assert.strictEqual([...idx.values()].flat().length, 2, 'started fixture dropped');
assert.strictEqual(G.findPrematch(idx, 'Real Betis', 'Sevilla FC', KO + 10 * 60000, 'Spain La Liga')?.id, 1, 'same fixture within 20 min');
assert.strictEqual(G.findPrematch(idx, 'Real Betis', 'Sevilla', KO + 45 * 60000), null, 'kick-off too far apart');
assert.strictEqual(G.findPrematch(idx, 'Andorra (W)', 'Faroe Islands (W)', KO, 'European Women')?.id, 2, 'women: Bet365 (W) ↔ Pinnacle "Women" league');
assert.strictEqual(G.findPrematch(idx, 'Andorra', 'Faroe Islands', KO, 'International Friendlies'), null, 'men never paired with a women\'s fixture');
assert.strictEqual(G.kindOf('Arsenal U21', 'England PL2'), G.kindOf('Arsenal', 'England - Premier League Cup U21'));
assert.notStrictEqual(G.kindOf('Real Madrid II', ''), G.kindOf('Real Madrid', 'Spain - La Liga'));

// ── Same-line rows: AH and goal line proportional, 1X2 power
const pm = G.findPrematch(idx, 'Real Betis', 'Sevilla', KO);
const odds = { ah_hc: -0.25, ho_c: 2.05, ao_c: 1.83, tl_c: 2.5, ov_c: 2.10, un_c: 1.80 };
const x2 = { home_c: 2.5, draw_c: 3.4, away_c: 3.0 };
let rows = G.gapRows(odds, x2, pm);
const by = k => rows.find(r => r.key === k);
const ahF = LG.devig([pm.ft.ah[0].h, pm.ft.ah[0].a]);
assert(Math.abs(by('AH|home|-0.25').fair - ahF[0]) < 1e-12 && Math.abs(by('AH|home|-0.25').edge - (2.05 / ahF[0] - 1)) < 1e-12);
assert.strictEqual(by('AH|away|0.25').line, 0.25, 'the side\'s own line (for settlement)');
assert(by('OU|over|2.5') && by('1X2|draw|'));
const FM = require('./fair_model.js');
assert(Math.abs(by('1X2|home|').fair - FM.devigPower([2.4, 3.3, 3.1]).fair[0]) < 1e-9, '1X2 de-vigged with power');
assert.deepStrictEqual(G.gapRows({ ...odds, ah_hc: -0.5, tl_c: 3 }, null, pm), [], 'different lines → no comparison');

// ── Lifecycle: open → tick → closed (who moved) → closing snapshot
const st = new Map(); let t = KO - 5 * 3600000;
const row = (price, fair) => [{ key: 'AH|home|-0.25', mk: 'AH', side: 'home', line: -0.25, price, fair, pin: 1.95, edge: price / fair - 1 }];
let ev = G.track(st, 'm', row(2.05, 1.95), t, 300); assert.deepStrictEqual(ev.map(e => e.ev), ['open']);
ev = G.track(st, 'm', row(2.05, 1.95), t += 60000, 299); assert.deepStrictEqual(ev, [], 'unchanged → nothing');
ev = G.track(st, 'm', row(2.03, 1.95), t += 60000, 298); assert.deepStrictEqual(ev.map(e => e.ev), ['tick']);
ev = G.track(st, 'm', row(2.00, 1.99), t += 60000, 297);
assert.strictEqual(ev[0].ev, 'closed'); assert.strictEqual(ev[0].mins, 3);
assert(ev[0].byB365 > 0 && ev[0].byPin > 0 && Math.abs(ev[0].byB365 - Math.log(2.05 / 2.00)) < 1e-4);
ev = G.track(st, 'm', row(2.00, 1.99), t += 60000, 25); assert.deepStrictEqual(ev.map(e => e.ev), ['cl'], 'closing snapshot once for a side that was open');
ev = G.track(st, 'm', row(2.00, 1.99), t += 60000, 24); assert.deepStrictEqual(ev, []);
assert.deepStrictEqual(G.track(new Map(), 'z', row(2.6, 1.95), t, 300), [], 'edge ≥ 25% (stale/mismatch) ignored');

// ── Reports on synthetic recordings
const tmp = p => fs.mkdtempSync(path.join(os.tmpdir(), p));
const match = { id: 'w', home_team: 'Real Betis', away_team: 'Sevilla', league: 'La Liga' };
{
  const dir = tmp('pinngap-');
  const o1 = G.recordRow(KO - 3 * 3600000, match, KO, { ev: 'open', r: row(2.05, 1.95)[0] }, 45);
  const c1 = G.recordRow(KO - 20 * 60000, match, KO, { ev: 'cl', r: row(1.98, 1.97)[0] }, 30);
  const cz = G.recordRow(KO - 2 * 3600000, match, KO, { ev: 'closed', r: row(2.0, 1.99)[0], mins: 60, byB365: 0.024, byPin: 0.02 }, 40);
  const lines = [{ hb: { t: KO - 4 * 3600000, paired: 10, fresh: true } }, o1, cz, c1, { t: KO + 2 * 3600000, id: 'w', res: '2-0', m: 'w' }];
  fs.writeFileSync(path.join(dir, '2026-10-10.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const txt = require('./pinngap_report').buildReport(dir, { tz: 'UTC' });
  assert(/Edge ≥ 3%:\n\s+all\s+1 bets · settled\s+1 · \s*\+1\.05u · ROI\s+\+105\.0% · CLV \+4\.1% \(1\)/.test(txt), 'won at 2.05, CLV 2.05/1.97');
  assert(/median 60/.test(txt) && /Bet365's price coming down: 1 \(100%\)/.test(txt));
  fs.rmSync(dir, { recursive: true });
}
{
  const dir = tmp('pricegap-bets-');
  const a = { t: KO - 3 * 3600000, ev: 'alert', id: 'x', ko: KO, kmin: 180, pk: 'x|AH|away|-0.5', k: 'AH|away|-0.5', mk: 'AH', side: 'away', line: 0.5, p: 2.1, f: 1.95, e: 7.7, mo: 2.05, b: 'moved', u: 0, sc: '0-0', m: 'x match', lg: 'L' };
  const lines = [a, { ...a, t: KO - 15 * 60000, ev: 'cl', p: 1.95, f: 2.0 }, { t: KO + 9e6, id: 'x', res: '1-1', m: 'x' }];
  fs.writeFileSync(path.join(dir, '2026-10-10.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  const txt = require('./pricegap_bets_report').buildReport(dir, { tz: 'UTC' });
  assert(/settled 1 · at the Bet365 price shown \+1\.10u → ROI \+110\.0% · at the minimum odds \+1\.05u/.test(txt), 'away +0.5 at 1-1 wins');
  assert(/price shown vs Sbobet's closing fair → \+5\.0%/.test(txt) && /later lower 1, higher 0/.test(txt));
  fs.rmSync(dir, { recursive: true });
}
console.log('pinngap + pricegap alerts: all tests passed');
