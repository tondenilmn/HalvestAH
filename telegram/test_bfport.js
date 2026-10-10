'use strict';
/**
 * Tests for BFPORT (bfport.js + bfport_report.js) — pure logic, made-up data
 * (notify.js is not required: it runs the real scheduler).
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const B = require('./bfport');
const close = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// Commission on winnings: 2.00 at 4.5% → 1.955
assert(close(B.netPrice(2, 0.045), 1.955));

// Pairing: kick-off ± 20 min, names, same kind of side, not in play
const KO = Date.UTC(2026, 9, 11, 15);
const ev = (name, ko, extra = {}) => ({ event_name: name, competition_name: 'Serie A', open_date_raw: new Date(ko).toISOString(), inplay: false, home_odd: 2.1, draw_odd: 3.5, away_odd: 3.9, total_matched: 5000, ...extra });
const events = [ev('Juventus v Torino', KO), ev('Juventus (W) v Torino (W)', KO), ev('Milan v Inter', KO), ev('Juventus v Torino', KO + 3 * 3600000)];
assert.strictEqual(B.findPrematchEvent(events, 'Juventus', 'Torino', KO + 5 * 60000), events[0]);
assert.strictEqual(B.findPrematchEvent(events, 'Juventus (W)', 'Torino (W)', KO), events[1], 'women matched to women');
assert.strictEqual(B.findPrematchEvent([{ ...events[0], inplay: true }], 'Juventus', 'Torino', KO), null, 'in play skipped');
assert.strictEqual(B.findPrematchEvent(events, 'Lazio', 'Roma', KO), null);

// Side rows: net Betfair vs Pinnacle's power de-vigged fair
const pm = { ft: { ml: { h: 2.0, d: 3.6, a: 4.0 } } };
const rows = B.sideRows(events[0], pm, 0.045);
assert.strictEqual(rows.length, 3);
const h = rows[0];
assert(close(h.net, 1 + 1.1 * 0.955) && h.fair > 2.0 && close(h.edge, h.net / h.fair - 1));
assert(close(h.book, 1 / 2.1 + 1 / 3.5 + 1 / 3.9));
assert.deepStrictEqual(B.sideRows({ ...events[0], draw_odd: null }, pm), [], 'missing price');

// Gates
const o = { minEdge: 2, maxEdge: 15, minOdds: 1.5, maxOdds: 4, minMatched: 1000, maxBook: 1.04, maxPinAge: 300, kellyFraction: 0.125, maxStakePct: 2 };
const r = { ...h, edge: 0.03, bf: 2.1, matched: 5000, book: 1.02 };
assert.strictEqual(B.blockReason(r, 120, 60, o), null);
assert(/< 2%/.test(B.blockReason({ ...r, edge: 0.01 }, 120, 60, o)));
assert(/stale/.test(B.blockReason({ ...r, edge: 0.2 }, 120, 60, o)));
assert(/outside/.test(B.blockReason({ ...r, bf: 5 }, 120, 60, o)));
assert(/matched/.test(B.blockReason({ ...r, matched: 200 }, 120, 60, o)));
assert(/wide/.test(B.blockReason({ ...r, book: 1.1 }, 120, 60, o)));
assert(/Pinnacle/.test(B.blockReason(r, 120, 900, o)));
assert(/kick-off/.test(B.blockReason(r, 5, 60, o)) && /kick-off/.test(B.blockReason(r, 2000, 60, o)));

// Stake: ⅛ Kelly, capped at 2%
const s = { fair: 2.0, net: 2.1 }; // p 0.5, Kelly = (0.5·2.1 − 1)/1.1 = 0.04545
assert(close(B.stakeFrac(s, o), 0.04545454545 * 0.125, 1e-9));
assert(close(B.stakeFrac({ fair: 1.6, net: 3 }, o), 0.02), 'capped');
assert.strictEqual(B.stakeFrac({ fair: 2.2, net: 2.0 }, o), 0, 'no edge, no stake');

// Settlement + bankroll
const bet = { id: 'x', side: 'home', net: 2.1, stake: 10 };
assert(close(B.settleBet(bet, '2-1'), 11) && B.settleBet(bet, '1-1') === -10 && B.settleBet({ ...bet, side: 'draw' }, '1-1') === 11);
assert(close(B.bankrollOf(1000, [bet, { ...bet, id: 'y' }], new Map([['x', '2-0']])), 1011));

// Report on recorded lines
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bfport-'));
const T = KO - 3 * 3600000;
const match = { id: 'x', home_team: 'Juventus', away_team: 'Torino', league: 'Italy Serie A' };
const row = (t, evName, side, bf, fair, extra = {}) => B.recordRow(t, evName, { ...match, ...(extra.match || {}) }, KO, { key: `1X2|${side}|`, side, bf, net: B.netPrice(bf, 0.045), fair, pin: fair * 0.97, edge: B.netPrice(bf, 0.045) / fair - 1, book: 1.02, matched: 5000 }, 60, { home_c: 2.0 }, extra.x || {});
const lines = [
  { hb: { t: T, paired: 1 } },
  row(T, 'c', 'home', 2.2, 2.05, { x: { ok: true } }),
  row(T, 'bet', 'home', 2.2, 2.05, { x: { stake: 8, bank: 1000 } }),
  row(KO - 20 * 60000, 'cl', 'home', 2.1, 2.0), row(KO - 20 * 60000, 'cl', 'draw', 3.4, 3.5), row(KO - 20 * 60000, 'cl', 'away', 4.0, 4.2),
  { t: KO + 2 * 3600000, id: 'x', res: '2-1', ht: '1-0', m: 'Juventus v Torino' },
];
fs.writeFileSync(path.join(dir, '2026-10-11.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
const txt = require('./bfport_report').buildReport(dir, { tz: 'UTC', start: 1000 });
assert(/1 bets · settled 1 \(1 won\)/.test(txt), txt);
const win = 8 * (B.netPrice(2.2, 0.045) - 1);
assert(txt.includes(`bankroll ${(1000 + win).toFixed(2)}`), 'bankroll after the win');
assert(/vs Pinnacle's closing fair \+\d/.test(txt) && /vs Betfair's closing back \+4\.8% \(1\)/.test(txt), 'CLV: 2.2 vs 2.1');
assert(/favourites\s+1 sides · settled\s+1/.test(txt) && /underdogs\s+1 sides · settled\s+1 · \s*-1\.00u/.test(txt), 'blind by role');
assert(/net edge ≥ 2%\s+1 bets/.test(txt));
fs.rmSync(dir, { recursive: true });
console.log('bfport: all tests passed');
