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
assert(/below 1\.7/.test(G.blockReason(over, s, 63, t, { ...opts, minOdds: 1.7, maxOdds: 2.5, }) || '') === false, 'Over @2.20 inside 1.70-2.50');
assert(/above 2\.1/.test(G.blockReason(over, s, 63, t, { ...opts, minOdds: 1.7, maxOdds: 2.1 })), 'price above max blocks');
assert(/below 2\.3/.test(G.blockReason(over, s, 63, t, { ...opts, minOdds: 2.3, maxOdds: 2.5 })), 'price below min blocks');
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
assert(/Alpha FC v Beta United/.test(msg) && /Over 2\.5 — Goal Line \(FT total\)/.test(msg) && !/backtested/i.test(msg));
assert(new RegExp(`BET AT ${(over.fair * 1.05).toFixed(2)} OR HIGHER`).test(msg), 'min odds = fair × 1.05');
assert(/now 2\.20 → room 0\.05/.test(msg), 'room to the minimum');
assert(/📊 Bet365 2\.20 vs fair 2\.05 \(Pinnacle 2\.00\) → \+7\.4%/.test(msg), 'evidence line');
assert(/Pinnacle fresh/.test(msg));
const tight = G.formatAlert({ home_team: 'A', away_team: 'B', score: '1-0' }, "68'", [{ ...over, price: 1.9, fair: 1.8, pin: 1.67, edge: 1.9 / 1.8 - 1 }], 0, x => x, { threshold: 5, bankroll: 1000 });
assert(/bet immediately, no room/.test(tight), 'no-room verdict');
assert(/Stake €\d+\.\d\d \(\d\.\d\d%\)/.test(tight), 'stake in € with a bankroll');
const two = G.formatAlert({ home_team: 'A', away_team: 'B', score: '1-0' }, "68'", [
  { ...over, price: 1.9, fair: 1.8, pin: 1.67, edge: 1.9 / 1.8 - 1 },
  { key: 'AH|x', market: 'AH', side: 'away', line: 0.25, price: 2.0, fair: 1.88, pin: 1.84, edge: 2 / 1.88 - 1 }], 0, x => x, { threshold: 5 });
assert(two.indexOf('Asian Handicap (from now)') < two.indexOf('Goal Line'), 'biggest edge first');
assert(/B \+0\.25 — Asian Handicap \(from now\)/.test(two));
// ── Settlement: confirmed FT from the match page (livegap_result.js)
const R = require('./livegap_result');
const hdr = (tv, live, ht, hg, ag) => `<tr><td colspan='9'>L</td></tr><tr${live ? " class='live'" : ''}><td>H</td><td class='name' colspan='2'>Home</td><td rowspan='2' colspan='2' id='timeval' value=${tv}></td><td colspan='2'>${hg}</td><td class='info'>ht</td><td>${ht}</td></tr><tr${live ? " class='live'" : ''}><td>A</td><td class='name' colspan='2'>Away</td><td colspan='2'>${ag}</td><td class='info'>ck</td><td class='corner'>1 - 2</td></tr>`;
assert.deepStrictEqual(R.parseResult(hdr('2026-10-07T11:30:00Z', false, '1 - 1', 1, 4)), { status: 'FT', score: '1-4', ht: '1-1' }, 'finished page');
assert.strictEqual(R.parseResult(hdr("67'", true, '1 - 0', 2, 0)).status, 'LIVE');
assert.strictEqual(R.parseResult(hdr("90'+", true, '1 - 0', 2, 0)).status, 'LIVE');
assert.strictEqual(R.parseResult(hdr('HT', true, '1 - 0', 1, 0)).status, 'LIVE');
assert.strictEqual(R.parseResult(hdr('OT', true, '0 - 0', 1, 1)).status, 'ET', 'extra time');
assert.strictEqual(R.parseResult(hdr('2026-10-07T18:00:00Z', false, '', 0, 0).replace(/<td class='info'>ht<\/td><td><\/td>/, "<td class='info'>ht</td><td></td>")).status, 'PRE', 'not started');
const pageJs = `$("#tablematch1").html("${hdr('2026-10-07T11:30:00Z', false, '0 - 0', 0, 1).replace(/'/g, "\\'")}");`;
assert.deepStrictEqual(R.parseResult(R.tablematch1(pageJs)), { status: 'FT', score: '0-1', ht: '0-0' }, 'escaped JS string');

(async () => {
  const pend = new Map(); let now = 1e12;
  R.noteSeen(pend, 'a', 'A v B', '1-0', 60, now);
  R.noteSeen(pend, 'e', 'C v D', '1-1', 90, now);
  const page = { a: { status: 'LIVE', score: '1-0' }, e: { status: 'ET', score: '1-1' } };
  const fetcher = async id => page[id];
  assert.deepStrictEqual(await R.settleDue(pend, now + 60000, fetcher), [], 'still listed → not checked');
  R.markGone(pend, 'a', now + 5 * 60000); R.markGone(pend, 'e', now + 5 * 60000);
  assert.deepStrictEqual(await R.settleDue(pend, now + 5 * 60000, fetcher), [], 'page still live / extra time → wait');
  assert(pend.get('e').et, 'extra time noted');
  R.noteSeen(pend, 'a', 'A v B', '1-0', 62, now + 6 * 60000); // reappeared after a blackout
  assert(!pend.get('a').gone, 'reappearing match tracked again');
  page.a = { status: 'FT', score: '2-0', ht: '1-0' }; page.e = { status: 'FT', score: '2-1', ht: '0-0' };
  assert.deepStrictEqual(await R.settleDue(pend, now + 9 * 60000, fetcher), [], 'listed again → not checked; e not due yet');
  const done = await R.settleDue(pend, now + 16 * 60000, fetcher);
  assert.deepStrictEqual(done.map(l => [l.id, l.res, l.et, l.reg]), [['a', '2-0', undefined, undefined], ['e', '2-1', true, '1-1']], 'a unseen 10 min → checked; e settled with its 90\' score');
  assert.strictEqual(pend.size, 0);
  R.noteSeen(pend, 'x', 'X v Y', '0-0', 30, now); R.markGone(pend, 'x', now);
  const gaveUp = await R.settleDue(pend, now + 7 * 3600000, async () => ({ status: 'PRE' }));
  assert(gaveUp[0].nores && gaveUp[0].status === 'PRE', 'no result after 6 h');

  // Restart recovery + report statuses
  const os = require('os'), fs = require('fs'), path = require('path');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'livegap-'));
  const T = Date.UTC(2026, 9, 7, 13);
  const row = (id, t, sc, min, extra = {}) => ({ t, id, min, sc, k: 'OU|Over 2.5 (match total)', mk: 'OU', side: 'over', line: 2.5, p: 2, pin: 1.85, f: 1.9, e: 5.3, pa: 20, m: id + ' match', lg: 'L', ...extra });
  G.appendRecords(dir, T, [
    { hb: { t: T } },
    row('won', T, '1-1', 60), { alert: { ...row('won', T, '1-1', 61), mo: 1.995 } },
    row('wait', T, '0-0', 70), { alert: { ...row('wait', T, '0-0', 71), mo: 1.995 } },
    row('gone', T, '0-0', 50), { alert: { ...row('gone', T, '0-0', 51), mo: 1.995 } },
    { t: T + 1, id: 'won', fin: '0-0', final: true }, // old-style live-list line: never settled on
    { t: T + 2, id: 'won', res: '2-1', ht: '1-0', m: 'won match' },
    { t: T + 3, id: 'gone', nores: true, status: 'PRE', m: 'gone match' },
  ]);
  const rec = R.recoverPending(dir, T + 3600000);
  assert.deepStrictEqual([...rec.keys()], ['wait'], 'only the unresolved match is re-queued');
  const text = require('./livegap_report').buildReport(dir, { tz: 'UTC' });
  assert(/WON · settled \(confirmed FT 2-1\)/.test(text), 'settled on the confirmed score, not the live-list line');
  assert(/waiting for FT/.test(text) && /no result found/.test(text));
  assert(/Settled 1 \(confirmed FT\): 1 won · waiting for FT 1 · no result found 1/.test(text));
  fs.rmSync(dir, { recursive: true });
  console.log('livegap settlement: all tests passed');
})().catch(e => { console.error(e); process.exit(1); });
console.log('livegap: all tests passed');
console.log('\n--- example alert ---\n' + two.replace(/<[^>]+>/g, ''));
