'use strict';
/** oddsmonitor.js — pairing, stale check vs Betfair, history save. Made-up data, nothing fetched. */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const OM = require('./oddsmonitor');

const ev = (name, score, h, d, a, extra = {}) => ({ event_slug: name.toLowerCase().replace(/\s+/g, '-'), event_name: name, competition_name: 'Algerian Ligue 1', inplay: true, status_label: '2ND HALF',
  score_text: score, home_odd: h, draw_odd: d, away_odd: a, total_matched: 10060, open_date_raw: '2026-10-09T19:00:00.000Z', ...extra });
const list = [ev('MC Alger v Cr Temouchent', '1-0', 1.06, 15.5, 34), ev('Andorra v Faroe Islands', '0-0', 3, 3, 2.5, { competition_name: 'World Cup Qualifiers Women' })];

// Pairing: Bet365's "CRB Temouchent" ↔ Betfair's "Cr Temouchent", same score only, women only with women.
assert.strictEqual(OM.findEvent(list, 'MC Alger', 'CRB Temouchent', { home: 1, away: 0 })?.event_name, 'MC Alger v Cr Temouchent');
assert.strictEqual(OM.findEvent(list, 'MC Alger', 'CRB Temouchent', { home: 0, away: 0 }), null, 'different score → not paired');
assert.strictEqual(OM.findEvent(list, 'Andorra', 'Faroe Islands', { home: 0, away: 0 }, 'International'), null, "men's match never paired with the women's");
assert(OM.findEvent(list, 'Andorra (W)', 'Faroe Islands (W)', { home: 0, away: 0 }));

// Stale: MC Alger 1-0 at 83' — Bet365 Live still 2.25 / 1.72 / 15 (a 0-0 price), Betfair 1.06 / 15.5 / 34.
const stale = OM.staleVsBetfair({ x2_h: 2.25, x2_x: 1.72, x2_a: 15 }, list[0]);
assert(/Bet365 home 2.25 vs Betfair 1.06/.test(stale), stale);
assert.strictEqual(OM.staleVsBetfair({ x2_h: 1.08, x2_x: 13, x2_a: 29 }, list[0]), null, 'normal margin difference is fine');
assert.strictEqual(OM.staleVsBetfair({ x2_h: 2.25, x2_x: 1.72, x2_a: 15 }, { ...list[0], total_matched: 100 }), null, 'thin Betfair market ignored');
assert.strictEqual(OM.staleVsBetfair({ x2_h: 1.06, x2_x: 15.5, x2_a: 60 }, list[0]), null, 'Betfair price > 10 not used (thin, noisy)');

// History: compact form + save once a match finished.
const chart = { found: true, meta: { event_name: 'MC Alger v Cr Temouchent', competition_name: 'Algerian Ligue 1', event_status: 'Finished', score_text: '1-0', total_matched: 10060 },
  markers: [{ index: 1, type: 'Goal', team: 'home', minute: "76'", update_time: '2026-10-09 20:42:03' }],
  odds: { raw_labels: ['2026-10-09 20:41:03', '2026-10-09 20:42:03'], series: { home: [2.32, 1.06], draw: [1.84, 15.5], away: [26, 34] } },
  money: { raw_labels: [], series: { backing_home: [10, 900], backing_draw: [5, 1], backing_away: [1, 0], laying_home: [2, 3], laying_draw: [1, 400], laying_away: [0, 1] } } };
const c = OM.compactChart({ ...chart, slug: 'mc-alger-v-cr-temouchent' });
assert.deepStrictEqual(c.t, [0, 60]); assert.deepStrictEqual(c.odds.home, [2.32, 1.06]); assert.strictEqual(c.markers[0].type, 'Goal');
(async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'om-'));
  const now = Date.parse('2026-10-09T21:30:00Z');
  OM._st.seen.clear(); OM._st.saved.clear();
  OM._st.seen.set('mc-alger-v-cr-temouchent', { slug: 'mc-alger-v-cr-temouchent', status: 'Finished', live: false, matched: 10060, ko: Date.parse('2026-10-09T19:00:00Z'), lastSeen: now });
  OM._st.seen.set('small-v-tiny', { slug: 'small-v-tiny', status: 'Finished', matched: 50, lastSeen: now });
  OM._st.seen.set('later-v-match', { slug: 'later-v-match', status: 'PRE', matched: 5000, ko: now + 3600000, lastSeen: now });
  let calls = 0; const fetcher = async () => { calls++; return chart; };
  assert.strictEqual(await OM.saveFinished(dir, now, { fetcher }), 1, 'only the finished match with real money');
  assert.strictEqual(await OM.saveFinished(dir, now + 60000, { fetcher }), 0, 'saved once'); assert.strictEqual(calls, 1);
  const f = path.join(dir, '2026-10-09', 'mc-alger-v-cr-temouchent.json.gz');
  assert.strictEqual(OM.readHistory(f).odds.home[1], 1.06);
  OM._st.saved.clear(); OM.loadSaved(dir); assert(OM._st.saved.has('mc-alger-v-cr-temouchent'), 'restart does not refetch');
  fs.rmSync(dir, { recursive: true });
  console.log('oddsmonitor: all tests passed');
})().catch(e => { console.error(e); process.exit(1); });
