'use strict';
/**
 * PRICEGAP alerts, settled. Reads telegram/data/pricegap_bets/*.jsonl (written
 * by notify.js's runPriceGapScan since 2026-10-09): every alert sent (`alert`),
 * a closing snapshot of the same side in the last 30 min before kick-off
 * (`cl`, same line — or `moved` when the line changed) and the confirmed FT
 * score (`res`, livegap_result.js).
 *
 *   node pricegap_bets_report.js [--dir data/pricegap_bets]
 *   GET <bot>/pricegap/report
 *
 * Profit/loss is 1 unit per alerted side, at the Bet365 price shown and at the
 * minimum odds the alert gave (fair × 1.05). Closing-line value = the price
 * shown vs Sbobet's de-vigged fair in the closing snapshot — the low-noise
 * check of the backtest (+6.2-6.4% at opening; Bet365 moves toward Sbobet
 * ~75-80% of the time), readable long before the results are.
 */
const fs = require('fs');
const path = require('path');
const { payout } = require('./livegap_report');
const blind = require('./blind');

const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const units = x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}u`;

function load(dir) {
  if (!fs.existsSync(dir)) return null;
  const alerts = [], cl = new Map(), fin = new Map(), noRes = new Set();
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.ev === 'alert') alerts.push(o);
      else if (o.ev === 'cl') cl.set(o.pk, o);
      else if (o.res !== undefined) fin.set(o.id, o.et ? o.reg : o.res);
      else if (o.nores) noRes.add(o.id);
    }
  }
  return { alerts: alerts.sort((a, b) => a.t - b.t), cl, fin, noRes };
}

function summarize(list, fin) {
  let n = 0, plP = 0, plM = 0; const settled = [];
  for (const a of list) { const f = fin.get(a.id); if (f == null) continue; const rp = payout(a, f, a.p), rm = payout(a, f, a.mo); if (rp == null) continue; n++; plP += rp - 1; plM += rm - 1; settled.push({ ...a, ret: rp }); }
  return { n, plP, plM, vs: blind.vsBlind(blind.prematchTable(), settled) };
}

function buildReport(dir, opts = {}) {
  const tz = opts.tz || 'Europe/Rome';
  const d = load(dir);
  if (!d || !d.alerts.length) return `No PRICEGAP alerts tracked yet (${dir}).`;
  const { alerts, cl, fin, noRes } = d;
  const when = t => new Date(t).toLocaleString('it-IT', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const out = [`PRICEGAP report · ${alerts.length} alerted sides from ${when(alerts[0].t)} to ${when(alerts[alerts.length - 1].t)}`];

  const all = summarize(alerts, fin);
  const waiting = alerts.filter(a => !fin.has(a.id) && !noRes.has(a.id)).length;
  out.push('', `RESULT (1 unit per alerted side): settled ${all.n}${all.n ? ` · at the Bet365 price shown ${units(all.plP)} → ROI ${pct(all.plP / all.n)} · at the minimum odds ${units(all.plM)} → ROI ${pct(all.plM / all.n)}${blind.fmtVs(all.vs, all.n)}` : ''} · waiting for FT ${waiting}${noRes.size ? ` · no result ${alerts.filter(a => noRes.has(a.id)).length}` : ''}`);
  for (const [label, key] of [['by backtest bucket', 'b'], ['by market', 'mk']]) {
    out.push(`  ${label}:`);
    for (const v of [...new Set(alerts.map(a => a[key]))]) {
      const L = alerts.filter(a => a[key] === v), s = summarize(L, fin);
      out.push(`    ${String(v).padEnd(14)} ${String(L.length).padStart(4)} sides · settled ${String(s.n).padStart(4)}${s.n ? ` · ${units(s.plP).padStart(8)} · ROI ${pct(s.plP / s.n).padStart(7)}${blind.fmtVs(s.vs, s.n)}` : ''}`);
    }
  }

  // Closing-line value
  const withCl = alerts.map(a => ({ a, c: cl.get(a.pk) })).filter(x => x.c);
  const same = withCl.filter(x => !x.c.moved && x.c.f > 1);
  if (withCl.length) {
    const clv = same.reduce((s, x) => s + (x.a.p / x.c.f - 1), 0) / Math.max(1, same.length);
    const b365down = same.filter(x => x.c.p < x.a.p).length, b365up = same.filter(x => x.c.p > x.a.p).length;
    out.push('', `CLOSING-LINE VALUE (closing snapshot ≤ 30 min before kick-off): ${withCl.length} sides · line changed ${withCl.length - same.length}`,
      `  same line ${same.length}: price shown vs Sbobet's closing fair → ${pct(clv)} on average · Bet365's price later lower ${b365down}, higher ${b365up}`,
      `  (the backtest's edge lives in this number: positive = the alerts beat the close)`);
  }

  out.push('', 'Vs blind = ROI at the price shown minus what betting every side blind at Bet365\'s closing price returned at the same market and price band.');
  out.push('', 'ALERTED SIDES:');
  for (const a of alerts.slice(-80)) {
    const f = fin.get(a.id), c = cl.get(a.pk);
    const r = f != null ? payout(a, f, a.p) : null;
    const res = r == null ? (noRes.has(a.id) ? 'no result found' : 'waiting for FT')
      : `${r > 1.001 ? (r < a.p - 1e-9 ? 'HALF WON' : 'WON') : r < 0.999 ? (r > 1e-9 ? 'HALF LOST' : 'LOST') : 'VOID'} (FT ${f}) ${units(r - 1)}`;
    out.push(`  ${when(a.t)}  ${a.m} · ${a.k} · Bet365 ${a.p} (min ${(+a.mo).toFixed(2)}, +${a.e}%, ${a.b}, ${Math.round(a.kmin / 60)} h before KO)${c ? (c.moved ? ' · close: line moved' : ` · close: Bet365 ${c.p}, Sbobet fair ${c.f}`) : ''}\n      → ${res}`);
  }
  if (alerts.length > 80) out.push(`  … ${alerts.length - 80} earlier`);
  return out.join('\n');
}

module.exports = { buildReport };

if (require.main === module) {
  const arg = (n, dflt) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : dflt; };
  console.log(buildReport(path.resolve(__dirname, arg('--dir', 'data/pricegap_bets'))));
}
