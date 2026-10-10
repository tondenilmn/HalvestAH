'use strict';
/**
 * One P/L report for every Telegram alert strategy (added 2026-10-10).
 *
 *   node alerts_report.js
 *   GET <bot>/alerts/report
 *
 * 1. From track_record's alert log (data/alert_log.json): LATEGOAL, CROSSDOG,
 *    OPENLINE, FOCUS, LIVEWATCH — every alert (sent or silent; the in-play ones
 *    only when api-football verified the price before 2026-10-10), settled on the confirmed FT score from the match page
 *    (track_record.settleFromMatchPages, every 30 min). 1 unit per alert:
 *      at the price shown — the price in the message (Bet365's live price for
 *        CROSSDOG / OPENLINE; api-football's verified price for the in-play ones,
 *        when it found one);
 *      at the target odds — the minimum / fair price the message asked for
 *        (what betting only at that price would have returned);
 *      hit rate next to the model's average probability.
 * 2. Headlines of the strategies with their own recorders: PRICEGAP, LIVEGAP,
 *    LIVEMODEL (full detail in their own reports).
 */
const fs = require('fs');
const path = require('path');
const { LOG_FILE } = require('./track_record');

const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const units = x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}u`;
const STRATS = ['LATEGOAL', 'CROSSDOG', 'OPENLINE', 'FOCUS', 'LIVEWATCH'];

// Return − 1 of 1 unit at price p for a settlement fraction (1, 0.5, 0, −0.5, −1).
function plAt(fraction, p) {
  if (fraction == null) return null;
  if (fraction === 1) return p - 1;
  if (fraction === 0.5) return (p - 1) / 2;
  if (fraction === 0) return 0;
  if (fraction === -0.5) return -0.5;
  return -1;
}

function summarise(L) {
  const s = { n: L.length, sent: L.filter(e => e.sent !== false && !e.silent).length, settled: 0, won: 0, half: 0, push: 0, lost: 0, waiting: 0, nores: 0,
    nP: 0, plP: 0, nM: 0, plM: 0, hit: 0, nHit: 0, pSum: 0, nPm: 0 };
  for (const e of L) {
    if (!e.settled) { s.waiting++; continue; }
    if (e.result === 'NO RESULT' || e.fraction == null) { s.nores++; continue; }
    s.settled++;
    const f = e.fraction;
    if (f === 1) s.won++; else if (f === 0.5) s.half++; else if (f === 0) s.push++; else s.lost++;
    if (e.priceAtAlert > 1) { s.nP++; s.plP += plAt(f, e.priceAtAlert); }
    const m = e.minOdds > 1 ? e.minOdds : e.mo_lo > 1 ? e.mo_lo : null;
    if (m) { s.nM++; s.plM += plAt(f, m); }
    if (f !== 0) { s.nHit++; s.hit += f > 0 ? (f === 1 ? 1 : 0.5) : 0; }
    if (e.pModel > 0) { s.pSum += e.pModel; s.nPm++; }
  }
  return s;
}
const line = (label, s) => `  ${label.padEnd(12)} ${String(s.n).padStart(4)} alerts (${s.sent} sent, ${s.n - s.sent} silent) · settled ${String(s.settled).padStart(4)}`
  + (s.settled ? ` (${s.won} won, ${s.half} half won, ${s.push} void, ${s.lost} lost) · hit ${(s.hit / Math.max(1, s.nHit) * 100).toFixed(0)}%${s.nPm ? ` vs model ${(s.pSum / s.nPm).toFixed(0)}%` : ''}` : '')
  + (s.nP ? ` · at the price shown ${units(s.plP)} → ROI ${pct(s.plP / s.nP)} (${s.nP} priced)` : s.settled ? ' · no price shown' : '')
  + (s.nM ? ` · at the target odds ${units(s.plM)} → ROI ${pct(s.plM / s.nM)}` : '')
  + `${s.waiting ? ` · waiting ${s.waiting}` : ''}${s.nores ? ` · no result ${s.nores}` : ''}`;

function headline(build, re, label) {
  try { const t = build(); const m = t.match(re); return `  ${label.padEnd(12)} ${m ? m[0].trim() : 'no settled alerts yet'}`; }
  catch (e) { return `  ${label.padEnd(12)} report failed: ${e.message}`; }
}

function buildReport(opts = {}) {
  const tz = opts.tz || 'Europe/Rome', since = opts.since ?? 0;
  const when = t => new Date(t).toLocaleString('it-IT', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  let log = [];
  try { log = JSON.parse(fs.readFileSync(opts.logFile || LOG_FILE, 'utf8')); } catch { /* none yet */ }
  log = log.filter(e => STRATS.includes(e.strategy) && (e.timestamp || 0) >= since);
  const out = [`TELEGRAM ALERTS — P/L by strategy (1 unit per alert) · ${since ? `counting from ${when(since)}` : 'everything in the log'} · ${log.length} alerts recorded`,
    'LATEGOAL, FOCUS and LIVEWATCH were only logged when api-football confirmed the price until 2026-10-10; every alert is logged since then.'];
  out.push('', 'From the alert log (settled on the confirmed FT score from the match page):');
  for (const st of STRATS) out.push(line(st, summarise(log.filter(e => e.strategy === st))));
  out.push(line('ALL', summarise(log)));
  out.push('  (LATEGOAL, CROSSDOG send to Telegram; FOCUS, LIVEWATCH, OPENLINE are silent — their would-be alerts are counted the same way.)',
    '  "at the target odds" = 1 unit at the minimum / fair price the message gave: what betting only at that price would return.');

  if (opts.dirs) {
    out.push('', 'Strategies with their own recorders (headline; full detail in each report):');
    out.push(headline(() => require('./pricegap_bets_report').buildReport(opts.dirs.pricegap, { tz }), /RESULT \(1 unit per alerted side\):[^\n]*/, 'PRICEGAP'));
    out.push(headline(() => require('./livegap_report').buildReport(opts.dirs.livegap, { tz }), /At the Bet365 price shown:[^\n]*/, 'LIVEGAP'));
    out.push(headline(() => require('./livemodel_report').buildReport(opts.dirs.livemodel, { tz }), /At the Bet365 price shown:[^\n]*/, 'LIVEMODEL'));
    out.push('  (PRICEGAP sends; LIVEGAP and LIVEMODEL are silent — logged and settled in their recorders.)');
  }

  const recent = log.slice(-40).reverse();
  if (recent.length) {
    out.push('', 'LATEST ALERTS:');
    for (const e of recent) {
      const price = e.priceAtAlert > 1 ? `@${e.priceAtAlert}` : 'no price';
      const res = !e.settled ? 'waiting for FT' : e.result === 'NO RESULT' ? 'no result' : `${e.result} (FT ${e.finalScore})${e.priceAtAlert > 1 ? ` ${units(plAt(e.fraction, e.priceAtAlert))}` : ''}`;
      out.push(`  ${when(e.timestamp)}  ${e.strategy}${e.sent === false || e.silent ? ' [silent]' : ''} · ${e.homeTeam} v ${e.awayTeam}${e.minute != null ? ` · ${e.minute}'` : ''} · ${e.betLabel || e.betKey}${e.equivalent ? ` (= ${e.equivalent})` : ''} · ${price}${e.minOdds ? `, target @${(+e.minOdds).toFixed(2)}` : ''}\n      → ${res}`);
    }
  }
  out.push('', 'Small samples swing a lot — judge a strategy on a few hundred settled alerts, not a few days.');
  return out.join('\n');
}

module.exports = { buildReport, plAt, summarise };

if (require.main === module) {
  const d = n => path.join(__dirname, 'data', n);
  console.log(buildReport({ dirs: { pricegap: d('pricegap_bets'), livegap: d('livegap'), livemodel: d('livemodel') } }));
}
