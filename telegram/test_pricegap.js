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

// Message renders the min odds (fair × 1.05) and stake.
const msg = pg.formatAlert({ home_team: 'Alpha', away_team: 'Beta', league: 'Test League', url: 'https://x/m' }, [home], 120, s => s, { threshold: 5, kellyFraction: 0.25 });
assert(/≥ <b>2\.10<\/b>/.test(msg), 'min odds = 2.00 × 1.05 = 2.10');
assert(/kick-off in 2\.0 h/.test(msg));
console.log('pricegap: unit tests passed');

if (process.argv.includes('--live')) {
  (async () => {
    const { fetchOpenlineMatches, fetchSbobetDays } = require('./livescore');
    const [b, s] = await Promise.all([fetchOpenlineMatches(1), fetchSbobetDays(1)]);
    const sById = new Map(s.matches.filter(m => m.id).map(m => [m.id, m]));
    let paired = 0, compared = 0;
    const all = [];
    for (const m of b.matches) {
      const o = sById.get(m.id); if (!o) continue;
      paired++;
      const ko = m.kickoff_time ? (Date.parse(m.kickoff_time) - Date.now()) / 60000 : null;
      if (ko == null || ko <= 0 || ko > 24 * 60) continue;
      const g = pg.findGaps(m.odds, o.odds, { home: m.home_team, away: m.away_team });
      compared += g.length;
      for (const r of pg.qualifyingGaps(g, 5, 15)) all.push({ m, r, ko });
    }
    console.log(`live: ${b.matches.length} Bet365 / ${s.matches.length} Sbobet fixtures, ${paired} paired by id, ${compared} same-line comparisons, ${all.length} gaps ≥5% (<15%)`);
    const first = all[0];
    if (first) console.log('\n--- example alert ---\n' + pg.formatAlert(first.m, [first.r], first.ko, x => x, { threshold: 5, kellyFraction: 0.25 }).replace(/<[^>]+>/g, ''));
  })().catch(e => { console.error(e); process.exit(1); });
}
