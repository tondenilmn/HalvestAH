'use strict';
/**
 * Tests for Strategy PRICEGAP (pricegap.js) — pure logic first, then
 * `node test_pricegap.js --live` runs the real comparison against today's
 * Bet365 + Sbobet fixtures and prints the alerts it WOULD send (nothing is
 * sent: notify.js is not required — it runs the real scheduler on load).
 */
const assert = require('assert');
const pg = require('./pricegap');

// devig: 1.90 / 1.90 → fair 2.00 / 2.00
const f = pg.devig2(1.9, 1.9);
assert(Math.abs(f[0] - 2) < 1e-9 && Math.abs(f[1] - 2) < 1e-9, 'devig2 even market');

// Bet365 home 2.10 vs Sbobet 1.90/1.90 on the same line → +5% edge on home.
const b365 = { ah_hc: -0.25, ah_ho: -0.25, ho_c: 2.10, ho_o: 2.10, ao_c: 1.75, ao_o: 1.75, tl_c: 2.5, tl_o: 2.5, ov_c: 1.95, ov_o: 1.95, un_c: 1.85, un_o: 1.85 };
const sbo  = { ah_hc: -0.25, ah_ho: -0.25, ho_c: 1.90, ho_o: 1.90, ao_c: 1.90, ao_o: 1.90, tl_c: 2.75, tl_o: 2.75, ov_c: 1.90, ov_o: 1.90, un_c: 1.90, un_o: 1.90 };
const rows = pg.findGaps(b365, sbo, { home: 'Alpha', away: 'Beta' });
assert.strictEqual(rows.length, 2, 'only the same-line AH is compared (goal lines differ)');
const home = rows.find(r => r.side === 'home');
assert(Math.abs(home.edge - 0.05) < 1e-9, 'home edge = 2.10 / 2.00 − 1 = 5%');
assert.strictEqual(home.unmoved, true, 'both books still at opening');
assert.strictEqual(home.label, 'Alpha -0.25');
assert.deepStrictEqual(pg.qualifyingGaps(rows, 5, 15).map(r => r.side), ['home'], '≥5% keeps only the home side');
assert.deepStrictEqual(pg.qualifyingGaps(rows, 5, 4.9), [], 'edges at/above the max are dropped as stale prices');

// Movement → "moved" bucket; AH ≥5% quotes the AH-only backtest number.
const moved = pg.findGaps({ ...b365, ho_o: 1.95 }, sbo)[0];
assert.strictEqual(moved.unmoved, false);
assert(/9\.3%/.test(pg.bucketOf(moved).note));

// ── 1X2 ──────────────────────────────────────────────────────────────────────
// Sbobet 2.30/3.40/3.00 power-de-vigged; Bet365 2.60 on the home side is well
// above its fair price, the draw and away sides are not.
const bX2 = { home_c: 2.60, draw_c: 3.30, away_c: 2.95, home_o: 2.60, draw_o: 3.30, away_o: 2.95 };
const sX2 = { home_c: 2.30, draw_c: 3.40, away_c: 3.00, home_o: 2.30, draw_o: 3.40, away_o: 3.00 };
const x2rows = pg.findGaps(b365, sbo, { home: 'Alpha', away: 'Beta' }, { b: bX2, s: sX2 })
  .filter(r => r.market === 'X12');
assert.strictEqual(x2rows.length, 3, 'all three 1X2 sides are priced');
assert.strictEqual(x2rows[0].label, 'Alpha');
assert.strictEqual(x2rows[1].label, 'Draw');
assert(x2rows.every(r => r.unmoved), 'both books still at their opening 1X2');
assert(x2rows[0].edge > x2rows[1].edge && x2rows[0].edge > x2rows[2].edge, 'the home side is the flagged one');
// Power de-vig, not proportional: fair odds must be LONGER on the longshot
// than proportional would make them (that is the whole point — see devigPower).
const propFair = (() => { const q = [2.30, 3.40, 3.00].map(o => 1 / o), s = q.reduce((a, b) => a + b, 0); return q.map(x => s / x); })();
const powFair = pg.devigPower([2.30, 3.40, 3.00]);
assert(powFair[1] > propFair[1] && powFair[2] > propFair[2], 'power lengthens the fair price on draw/away');
assert(powFair[0] < propFair[0], 'and shortens it on the favourite');

// A moved 1X2 market is dropped entirely — its backtest bucket paid nothing.
const movedX2 = pg.findGaps(b365, sbo, {}, { b: { ...bX2, home_o: 2.45 }, s: sX2 })
  .filter(r => r.market === 'X12');
assert.strictEqual(movedX2.length, 0, '1X2 is opening-prices-only (X12_OPEN_ONLY)');

// 1X2 keeps its own 5% floor even when the caller asks for less.
assert.deepStrictEqual(
  pg.qualifyingGaps(x2rows, 2, 15).map(r => r.side), ['home'],
  'a 2% threshold still cannot surface a sub-5% 1X2 gap');

// ── message ──────────────────────────────────────────────────────────────────
// Everything the reader has to act on is on its own labelled line.
const msg = pg.formatAlert(
  { home_team: 'Alpha', away_team: 'Beta', league: 'Test League', url: 'https://x/m',
    kickoff_time: '2026-10-04T19:45:00Z' },
  [home, x2rows[0]], 120, s => s,
  { threshold: 5, kellyFraction: 0.25, bankroll: 1000, displayTz: 'Europe/Rome' });
assert(/⚽ <b>Alpha vs Beta<\/b>/.test(msg), 'the match');
assert(/🟢 <b>PRICE GAP<\/b> · Test League/.test(msg), 'the league');
assert(msg.includes('<a href="https://www.bet365.it/#/AX/K%5EAlpha/">🔍 Bet365</a> · <a href="https://x/m">Match page</a>'), 'Bet365 search + match page links');
assert.strictEqual(pg.bet365SearchUrl('Andorra (W)'), 'https://www.bet365.it/#/AX/K%5EAndorra/');
assert.strictEqual(pg.bet365SearchUrl('Arsenal U21'), 'https://www.bet365.it/#/AX/K%5EArsenal/');
assert.strictEqual(pg.bet365SearchUrl('Real Madrid II'), 'https://www.bet365.it/#/AX/K%5EReal%20Madrid/');
assert(/📅 .*04\/10.*21:45.*\(in 2\.0 h\)/.test(msg), 'date + local time + time to kick-off');
assert(/👉 <b>Alpha -0\.25<\/b> \(Asian handicap\) @ <b>2\.10<\/b>/.test(msg), 'what to bet and the Bet365 price');
assert(/👉 <b>Alpha<\/b> \(1X2\) @ /.test(msg), 'the 1X2 bet names the market');
assert(/min 2\.10 · edge \+5\.0% · stake €\d+\.\d\d/.test(msg), 'min odds = 2.00 × 1.05, edge, stake');
assert(!/Fair price|📊|opened/.test(msg), 'no fair price / bucket / opening line any more');
console.log('pricegap: unit tests passed');

if (process.argv.includes('--live')) {
  (async () => {
    // Same fetch runPriceGapScan uses (fetchSbobetDays, named here before,
    // has never existed — this path threw on every --live run until 2026-10-04).
    const { fetchTablenextDays } = require('./livescore');
    const [b, s] = await Promise.all([fetchTablenextDays('bet365', 0, 1), fetchTablenextDays('sbobet', 0, 1)]);
    const sById = new Map(s.matches.filter(m => m.id).map(m => [m.id, m]));
    let paired = 0, compared = 0, x12Pairs = 0;
    const all = [];
    for (const m of b.matches) {
      const o = sById.get(m.id); if (!o) continue;
      paired++;
      const ko = m.kickoff_time ? (Date.parse(m.kickoff_time) - Date.now()) / 60000 : null;
      if (ko == null || ko <= 0 || ko > 24 * 60) continue;
      const g = pg.findGaps(m.odds, o.odds, { home: m.home_team, away: m.away_team },
        { b: m.x2_odds, s: o.x2_odds });
      compared += g.length;
      if (g.some(r => r.market === 'X12')) x12Pairs++;
      for (const r of pg.qualifyingGaps(g, 5, 15)) all.push({ m, r, ko });
    }
    const byMarket = m => all.filter(x => x.r.market === m).length;
    console.log(`live: ${b.matches.length} Bet365 / ${s.matches.length} Sbobet fixtures, ${paired} paired by id, ${compared} comparisons (${x12Pairs} with a comparable 1X2 — both books still at opening), ${all.length} gaps ≥5% (<15%): ${byMarket('AH')} AH, ${byMarket('OU')} O/U, ${byMarket('X12')} 1X2`);
    const first = all.find(x => x.r.market === 'X12') || all[0];
    if (first) console.log('\n--- example alert ---\n' + pg.formatAlert(first.m, [first.r], first.ko, x => x, { threshold: 5, kellyFraction: 0.25, displayTz: 'Europe/Rome' }).replace(/<[^>]+>/g, ''));
  })().catch(e => { console.error(e); process.exit(1); });
}
