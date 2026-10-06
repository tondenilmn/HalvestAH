'use strict';
/**
 * Tests for Strategy LIVEGAP (livegap.js) and the Bet365 Live parser
 * (livescore.js parseGetData2NoneCalls) — pure logic, made-up feeds, nothing
 * is fetched or sent (notify.js is not required: it runs the real scheduler).
 */
const assert = require('assert');
const G = require('./livegap');
const { parseGetData2NoneCalls } = require('./livescore');

// ── Bet365 Live parser: indices 5 id, 7 AH, 11/31 AH prices, 15 TL, 19/36 O/U, 45/47/49 1X2
const args = Array.from({ length: 51 }, (_, i) => i);
Object.assign(args, { 5: "'abc123'", 7: '-0.25', 11: '1.95', 31: '1.90', 15: '2.5', 19: '2.10', 36: '1.75', 45: '2.4', 47: '3.1', 49: '3.3' });
const js = `match2text += getData2none(${args.join(',')});`;
const parsed = parseGetData2NoneCalls(js);
assert.strictEqual(parsed.length, 1);
assert.deepStrictEqual(parsed[0], { matchId: 'abc123', live_odds: { ah_hc: -0.25, ho_c: 1.95, ao_c: 1.9, tl_c: 2.5, ov_c: 2.1, un_c: 1.75, x2_h: 2.4, x2_x: 3.1, x2_a: 3.3 } });

// ── Pinnacle raw lists → sheets (American odds → decimal; duplicate live entry dropped)
const team = (alignment, name, score, red = 0) => ({ alignment, name, state: { score, redCards: red } });
const matchups = [
  { id: 1, units: 'Regular', participants: [team('home', 'Alpha FC', 1), team('away', 'Beta United', 1)] },
  { id: 2, units: 'Regular', participants: [team('home', 'Alpha FC', 1), team('away', 'Beta United', 1)] }, // same match, fewer markets
  { id: 3, units: 'Corners', participants: [team('home', 'Alpha FC', 0), team('away', 'Beta United', 0)] },
];
const mk = (matchupId, type, prices, extra = {}) => ({ matchupId, type, period: 0, status: 'open', prices, ...extra });
const markets = [
  mk(1, 'total', [{ designation: 'over', points: 2.5, price: 100 }, { designation: 'under', points: 2.5, price: -110 }]),
  mk(1, 'spread', [{ designation: 'home', points: -0.25, price: -105 }, { designation: 'away', points: 0.25, price: -105 }]),
  mk(1, 'moneyline', [{ designation: 'home', price: 150 }, { designation: 'draw', price: 210 }, { designation: 'away', price: 230 }]),
  mk(2, 'total', [{ designation: 'over', points: 2.5, price: 100 }, { designation: 'under', points: 2.5, price: -110 }]),
  mk(1, 'total', [{ designation: 'over', points: 1.5, price: -300 }, { designation: 'under', points: 1.5, price: 220 }], { period: 1 }),
];
const sheets = G.pinnacleSheets(markets, matchups);
assert.strictEqual(sheets.length, 1, 'duplicate live entry and corners dropped');
assert.strictEqual(sheets[0].id, 1, 'entry with more markets kept');
assert.deepStrictEqual(sheets[0].ft.ou, [{ line: 2.5, o: 2, u: 1.909 }]);
assert.strictEqual(sheets[0].ft.ml.h, 2.5);

// ── Pairing: names + the SAME score
assert.strictEqual(G.findPinnacle(sheets, 'Alpha', 'Beta United', { home: 1, away: 1 })?.id, 1);
assert.strictEqual(G.findPinnacle(sheets, 'Alpha', 'Beta United', { home: 2, away: 1 }), null, 'different score never paired');
assert.strictEqual(G.findPinnacle(sheets, 'Gamma', 'Delta', { home: 1, away: 1 }), null);

// ── Same-line rows: Bet365 Over 2.5 @2.20 vs Pinnacle 2.00/1.909 → fair ≈ 2.048, edge ≈ +7.4%
const live = { tl_c: 2.5, ov_c: 2.2, un_c: 1.65, ah_hc: -0.5, ho_c: 2.0, ao_c: 1.8, x2_h: 2.6, x2_x: 3.2, x2_a: 3.0 };
const rows = G.gapRows(live, sheets[0], { home: 'Alpha FC', away: 'Beta United' });
const over = rows.find(r => r.key === 'OU|Over 2.5 (match total)');
assert(over && Math.abs(over.edge - (2.2 / over.fair - 1)) < 1e-12 && over.edge > 0.07 && over.edge < 0.08);
assert(!rows.some(r => r.market === 'AH'), 'AH −0.5 not compared: Pinnacle only has −0.25');
assert.strictEqual(rows.filter(r => r.market === '1X2').length, 3);

// ── Streaks, quiet window, alert gate
const state = new Map(), opts = { minEdge: 0.05, maxEdge: 0.15, minScans: 2, quietMs: 3 * 60000, maxMinute: 85, pinAgeS: 30, maxPinAgeS: 60 };
let t = 1e12;
let s = G.updateMatchState(state, 'm1', { home: 1, away: 1 }, 0, t); G.trackGaps(s, rows, 0.05, t, 150000);
assert(/quiet|first sight/.test(G.blockReason(over, s, 60, t, opts)), 'first sight blocked');
for (let k = 1; k <= 3; k++) { t += 60000; s = G.updateMatchState(state, 'm1', { home: 1, away: 1 }, 0, t); G.trackGaps(s, rows, 0.05, t, 150000); }
assert.strictEqual(G.blockReason(over, s, 63, t, opts), null, 'held 4 scans, quiet for 3 min → alert');
assert(/Pinnacle prices/.test(G.blockReason(over, s, 63, t, { ...opts, pinAgeS: 95 })), 'stale Pinnacle blocks');
assert(/minute/.test(G.blockReason(over, s, 88, t, opts)), 'late minute blocks');
assert(/too large/.test(G.blockReason({ ...over, edge: 0.2 }, s, 63, t, opts)));
// a goal resets the quiet window and the streaks
t += 60000; s = G.updateMatchState(state, 'm1', { home: 2, away: 1 }, 0, t); G.trackGaps(s, rows, 0.05, t, 150000);
assert(/quiet/.test(G.blockReason(over, s, 64, t, opts)), 'goal → quiet window');
assert.strictEqual(s.gaps.get(over.key).n, 1, 'goal → streak restarts');
// a gap missing for a scan restarts its streak
t += 4 * 60000; s = G.updateMatchState(state, 'm1', { home: 2, away: 1 }, 0, t); G.trackGaps(s, [], 0.05, t, 150000);
t += 60000; G.trackGaps(s, rows, 0.05, t, 150000);
assert(/seen on 1/.test(G.blockReason(over, s, 70, t, opts)), 'gap vanished one scan → needs 2 again');
// a red card (Pinnacle's count) also resets
t += 60000; G.trackGaps(s, rows, 0.05, t, 150000);
assert.strictEqual(G.blockReason(over, s, 71, t, opts), null);
t += 60000; s = G.updateMatchState(state, 'm1', { home: 2, away: 1 }, 1, t);
assert(/quiet/.test(G.blockReason(over, s, 72, t, opts)), 'red card → quiet window');

// ── Message
const msg = G.formatAlert({ home_team: 'Alpha FC', away_team: 'Beta United', league: 'Test', score: '1-1' }, "63'", [over], 30, x => x, { threshold: 5, kellyFraction: 0.125 });
assert(/LIVE GAP/.test(msg) && /Over 2\.5/.test(msg) && /NOT backtested/.test(msg));
assert(new RegExp(`≥ <b>${(over.fair * 1.05).toFixed(2)}</b>`).test(msg), 'min odds = fair × 1.05');
console.log('livegap: all tests passed');
console.log('\n--- example alert ---\n' + msg.replace(/<[^>]+>/g, ''));
