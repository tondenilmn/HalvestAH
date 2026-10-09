'use strict';
/** OPENLINE settlement from match pages + report — made-up data, nothing fetched or sent. */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'openline-'));
// track_record writes to its own data dir; point a copy at a temp dir
const src = fs.readFileSync(path.join(__dirname, 'track_record.js'), 'utf8').replace("path.join(__dirname, 'data')", JSON.stringify(dir));
const modPath = path.join(__dirname, '.tmp_track_record_test.js');
fs.writeFileSync(modPath, src);
(async () => {
  try {
    const TR = require(modPath);
    const KO = Date.UTC(2026, 9, 10, 18);
    const base = { strategy: 'OPENLINE', betKey: 'awayWinsFT', betLabel: 'Away wins FT', favSide: 'HOME', favLine: 0.5, priceAtAlert: 4.2, mo_lo: 3.8, tier: 'OTHER', league: 'L', daysToKickoff: 6.5 };
    TR.recordAlert({ ...base, matchId: 'a', homeTeam: 'A', awayTeam: 'B', kickoff_time: new Date(KO).toISOString() });
    TR.recordAlert({ ...base, matchId: 'b', homeTeam: 'C', awayTeam: 'D', betKey: 'homeWinsFT', priceAtAlert: 1.9, mo_lo: 1.8, kickoff_time: new Date(KO).toISOString() });
    TR.recordAlert({ ...base, matchId: 'c', homeTeam: 'E', awayTeam: 'F', kickoff_time: new Date(KO).toISOString() });
    const pages = { a: { status: 'FT', score: '0-2', ht: '0-1' }, b: { status: 'FT', score: '1-1', ht: '0-0' }, c: { status: 'PRE' } };
    let r = await TR.settleFromMatchPages(async id => pages[id], { now: KO + 60 * 60000 });
    assert.strictEqual(r.checked, 0, 'not before KO + 1 h 50');
    r = await TR.settleFromMatchPages(async id => pages[id], { now: KO + 120 * 60000 });
    assert.deepStrictEqual(r, { checked: 3, settled: 2 });
    r = await TR.settleFromMatchPages(async id => pages[id], { now: KO + 125 * 60000 });
    assert.strictEqual(r.checked, 0, 'pending page re-checked only every 20 min');
    const txt = require('./openline_report').buildReport(path.join(dir, 'alert_log.json'), { tz: 'UTC' });
    assert(/3 alerts .* settled 2 · waiting for FT 1/.test(txt));
    assert(/all\s+3 alerts · settled\s+2 · won 1 ·\s+\+2\.20u → ROI\s+\+110\.0% · at min odds \+90\.0% · vs blind/.test(txt), 'away @4.2 won (+3.2), home @1.9 lost (−1)');
    assert(/WIN \(FT 0-2 \(HT 0-1\)\) \+3\.20u/.test(txt) && /LOSS \(FT 1-1/.test(txt) && /waiting for FT/.test(txt));
    console.log('openline report: all tests passed');
  } finally { fs.rmSync(modPath, { force: true }); fs.rmSync(dir, { recursive: true, force: true }); }
})().catch(e => { console.error(e); process.exit(1); });
