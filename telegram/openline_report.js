'use strict';
/**
 * Strategy OPENLINE, settled: every OPENLINE alert recorded in
 * telegram/data/alert_log.json (track_record.js — alerts whose current Bet365
 * price cleared the conservative min odds, which is every OPENLINE alert
 * sent), settled on the confirmed FT score from the match page
 * (track_record.settleFromMatchPages, every 30 min).
 *
 *   node openline_report.js [--file data/alert_log.json]
 *   GET <bot>/openline/report
 *
 * P/L is 1 unit per alert at the Bet365 price shown in the alert, and at the
 * conservative minimum odds (mo_lo). "Vs blind" = ROI minus what betting the
 * same 1X2 side blind at Bet365's closing price returned in the same price
 * band (blind.js) — OPENLINE picks are often long prices, where blind betting
 * loses 12-26%. Backtest to compare: gated at the opening price +25.2%,
 * lock-box +33.8% (19/19 months); at the closing price −5.9%.
 * Before the Railway volume (/app/data, 2026-10-08) the log was wiped by
 * every redeploy, so alerts before that are missing.
 */
const fs = require('fs');
const path = require('path');
const blind = require('./blind');

const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const units = x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}u`;
const retOf = (e, price) => (e.fraction == null ? null : e.fraction === 1 ? price : e.fraction === 0.5 ? 1 + (price - 1) / 2 : e.fraction === 0 ? 1 : e.fraction === -0.5 ? 0.5 : 0);

function buildReport(file, opts = {}) {
  const tz = opts.tz || 'Europe/Rome';
  let log; try { log = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return `No OPENLINE alerts tracked yet (${file}).`; }
  const L = log.filter(e => e.strategy === 'OPENLINE').sort((a, b) => a.timestamp - b.timestamp);
  if (!L.length) return 'No OPENLINE alerts tracked yet.';
  const when = t => new Date(t).toLocaleString('it-IT', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const side = e => (e.betKey === 'homeWinsFT' ? 'home' : 'away');
  const sum = list => {
    let n = 0, plP = 0, plM = 0; const bets = [];
    for (const e of list) { const r = retOf(e, e.priceAtAlert); if (r == null) continue; n++; plP += r - 1; plM += retOf(e, e.mo_lo || e.priceAtAlert) - 1; bets.push({ mk: '1X2', side: side(e), p: e.priceAtAlert, ret: r }); }
    return { n, plP, plM, vs: blind.vsBlind(blind.prematchTable(), bets), won: list.filter(e => e.fraction === 1).length };
  };
  const waiting = L.filter(e => !e.settled).length, nores = L.filter(e => e.result === 'NO RESULT').length;
  const all = sum(L);
  const out = [`OPENLINE report · ${L.length} alerts from ${when(L[0].timestamp)} to ${when(L[L.length - 1].timestamp)} · settled ${all.n} · waiting for FT ${waiting}${nores ? ` · no result ${nores}` : ''}`, ''];
  const line = (label, s, tot) => `  ${label.padEnd(26)} ${String(tot).padStart(4)} alerts · settled ${String(s.n).padStart(4)}${s.n ? ` · won ${s.won} · ${units(s.plP).padStart(8)} → ROI ${pct(s.plP / s.n).padStart(7)} · at min odds ${pct(s.plM / s.n)}${blind.fmtVs(s.vs, s.n)}` : ''}`;
  out.push('RESULT (1 unit per alert, at the Bet365 price shown):', line('all', all, L.length));
  for (const [lab, f] of [['home win', e => e.betKey === 'homeWinsFT'], ['away win', e => e.betKey === 'awayWinsFT'],
    ['price < 2.00', e => e.priceAtAlert < 2], ['price 2.00–3.50', e => e.priceAtAlert >= 2 && e.priceAtAlert < 3.5], ['price ≥ 3.50', e => e.priceAtAlert >= 3.5],
    ['tier TOP/MAJOR', e => e.tier === 'TOP' || e.tier === 'MAJOR'], ['tier OTHER', e => e.tier === 'OTHER'],
    ['≥ 5 days before KO', e => e.daysToKickoff >= 5], ['< 5 days before KO', e => e.daysToKickoff != null && e.daysToKickoff < 5]]) {
    const sub = L.filter(f); if (sub.length) out.push(line(lab, sum(sub), sub.length));
  }
  out.push('', 'ALERTS:');
  for (const e of L.slice(-80)) {
    const r = retOf(e, e.priceAtAlert);
    out.push(`  ${when(e.timestamp)}  ${e.homeTeam} v ${e.awayTeam} (${e.league || '?'}, ${e.tier || '?'}) · ${e.betLabel || e.betKey} @${e.priceAtAlert} (min ${e.mo_lo}${e.openPrice ? `, opening ${e.openPrice}` : ''})${e.kickoff_time ? ` · KO ${when(Date.parse(e.kickoff_time))}` : ''}\n      → ${r != null ? `${e.result} (FT ${e.finalScore}) ${units(r - 1)}` : e.result === 'NO RESULT' ? 'no result found' : 'waiting for FT'}`);
  }
  if (L.length > 80) out.push(`  … ${L.length - 80} earlier`);
  out.push('', 'Long prices dominate OPENLINE, so results swing a lot: judge on "vs blind" and on a few hundred settled alerts, not on a week.');
  return out.join('\n');
}

module.exports = { buildReport };

if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
  console.log(buildReport(path.resolve(__dirname, arg('--file', 'data/alert_log.json'))));
}
