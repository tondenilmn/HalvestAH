'use strict';
/**
 * Tests for alerts_report.js + the match-page settlement of every alert strategy
 * (track_record.settleFromMatchPages) — made-up log, no network (notify.js not required).
 */
const assert = require('assert');
const fs = require('fs'), os = require('os'), path = require('path');
const R = require('./alerts_report');

assert.strictEqual(R.plAt(1, 2.1), 1.1); assert.strictEqual(R.plAt(0.5, 2), 0.5); assert.strictEqual(R.plAt(0, 2), 0);
assert.strictEqual(R.plAt(-0.5, 2), -0.5); assert.strictEqual(R.plAt(-1, 2), -1);

const T = Date.UTC(2026, 9, 10, 15);
const log = [
  { strategy: 'LATEGOAL', timestamp: T, matchId: 'a', homeTeam: 'A', awayTeam: 'B', betKey: 'over05_2H', betLabel: 'Over 0.5 2H', priceAtAlert: null, minOdds: 1.6, pModel: 70, sent: true, settled: true, fraction: 1, result: 'WIN', finalScore: '1-1 (HT 0-1)', minute: 70, equivalent: 'Over 1.5 FT' },
  { strategy: 'LATEGOAL', timestamp: T + 1, matchId: 'b', homeTeam: 'C', awayTeam: 'D', betKey: 'over05_2H', priceAtAlert: 1.8, minOdds: 1.6, pModel: 70, sent: true, settled: true, fraction: -1, result: 'LOSS', finalScore: '0-0 (HT 0-0)' },
  { strategy: 'CROSSDOG', timestamp: T + 2, matchId: 'c', homeTeam: 'E', awayTeam: 'F', betKey: 'dogCover', priceAtAlert: 2.0, minOdds: 1.9, pModel: 52, sent: true, settled: true, fraction: 0.5, result: 'HALF-WIN', finalScore: '1-1' },
  { strategy: 'FOCUS', timestamp: T + 3, matchId: 'd', homeTeam: 'G', awayTeam: 'H', betKey: 'over05_1H', priceAtAlert: null, minOdds: 1.4, sent: false, settled: false },
  { strategy: 'L123', timestamp: T + 4, matchId: 'e', settled: false },          // not one of the report's strategies
  { strategy: 'CROSSDOG', timestamp: T - 9e8, matchId: 'f', settled: false },    // before the counting date
];
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alerts-')), file = path.join(dir, 'alert_log.json');
fs.writeFileSync(file, JSON.stringify(log));
const all = R.buildReport({ tz: 'UTC', logFile: file });
assert(/everything in the log · 5 alerts recorded/.test(all) && /\? v \? · \?/.test(all), 'whole log by default; missing names shown as ?');
const txt = R.buildReport({ tz: 'UTC', logFile: file, since: Date.UTC(2026, 9, 10) });
assert(/4 alerts recorded/.test(txt), txt);
assert(/LATEGOAL\s+2 alerts \(2 sent, 0 silent\) · settled\s+2 \(1 won, 0 half won, 0 void, 1 lost\) · hit 50% vs model 70% · at the price shown -1\.00u → ROI -100\.0% \(1 priced\) · at the target odds -0\.40u → ROI -20\.0%/.test(txt), txt);
assert(/CROSSDOG\s+1 alerts .* at the price shown \+0\.50u → ROI \+50\.0% \(1 priced\)/.test(txt));
assert(/FOCUS\s+1 alerts \(0 sent, 1 silent\) · settled\s+0 · waiting 1/.test(txt));
assert(/FOCUS \[silent\] · G v H/.test(txt) && /Over 0\.5 2H \(= Over 1\.5 FT\) · no price, target @1\.60/.test(txt));
fs.rmSync(dir, { recursive: true });

// Match-page settlement covers the in-play strategies: LATEGOAL over05_2H needs the HT score.
const TR = require('./track_record');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tr-'));
const real = TR.LOG_FILE;
const src = fs.readFileSync(require.resolve('./track_record'), 'utf8');
assert(/settleFromMatchPages/.test(src) && real.endsWith('alert_log.json'));
assert.strictEqual(TR.settleBetKey('over05_2H', { ftH: 1, ftA: 1, htH: 0, htA: 1 }), 1);
assert.strictEqual(TR.settleBetKey('over05_2H', { ftH: 0, ftA: 1, htH: 0, htA: 1 }), -1);
assert.strictEqual(TR.settleBetKey('dogCover', { ftH: 1, ftA: 1, favSide: 'HOME', favLine: 0.25 }), 0.5);
fs.rmSync(tmp, { recursive: true });
console.log('alerts report: all tests passed');
