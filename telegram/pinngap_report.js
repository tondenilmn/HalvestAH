'use strict';
/**
 * Do Bet365-vs-Pinnacle pre-match gaps pay, and how long do they last? Reads
 * the PINNGAP shadow recorder (telegram/data/pinngap/*.jsonl, written by
 * notify.js's runPriceGapScan via pinngap.js). Nothing was ever alerted.
 *
 *   node pinngap_report.js [--dir data/pinngap]
 *   GET <bot>/pinngap/report
 *
 * 1. FIRST SIGHTING — the first time each fixture side reached the edge, bet 1
 *    unit at Bet365's price then (what an alert would have sent): ROI from the
 *    confirmed FT score, and closing-line value (price vs Pinnacle's fair in
 *    the last 30 min, same line). Also by market, time to kick-off and
 *    Pinnacle copy age.
 * 2. LIFETIME — how long gaps stayed ≥ the floor, and who closed them
 *    (Bet365's price came down vs Pinnacle's fair moved up).
 * Backtest to compare (13 months, opening/closing only): opening ≥ 3% → +3.5%
 * (12/13 months), closing ≥ 5% → +5.1%, AH ≥ 5% → +7.1%.
 */
const fs = require('fs');
const path = require('path');
const { payout } = require('./livegap_report');

const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const units = x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}u`;
const median = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

function load(dir) {
  if (!fs.existsSync(dir)) return null;
  const rows = [], fin = new Map(), noRes = new Set();
  let scans = 0, first = null, last = null, paired = 0, fresh = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.hb) { scans++; first = first ?? o.hb.t; last = o.hb.t; paired += o.hb.paired || 0; if (o.hb.fresh) fresh++; }
      else if (o.res !== undefined) fin.set(o.id, o.et ? o.reg : o.res);
      else if (o.nores) noRes.add(o.id);
      else if (o.ev) rows.push(o);
    }
  }
  return { rows: rows.sort((a, b) => a.t - b.t), fin, noRes, scans, first, last, paired, fresh };
}

function buildReport(dir, opts = {}) {
  const tz = opts.tz || 'Europe/Rome';
  const d = load(dir);
  if (!d || !d.scans) return `No PINNGAP data yet (${dir}).`;
  const { rows, fin, noRes } = d;
  const when = t => new Date(t).toLocaleString('it-IT', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const opens = rows.filter(o => o.ev === 'open');
  const cl = new Map(rows.filter(o => o.ev === 'cl').map(o => [`${o.id}|${o.k}`, o]));
  const out = [`PINNGAP report (shadow — no alerts sent) · ${d.scans} scans from ${when(d.first)} to ${when(d.last)} · Pinnacle fresh on ${Math.round(d.fresh / d.scans * 100)}% of scans · ${opens.length} gaps opened on ${new Set(opens.map(o => o.id)).size} fixtures · ${[...new Set(opens.map(o => o.id))].filter(i => fin.has(i)).length} fixtures with a confirmed FT score`];

  const line = (label, list) => {
    let n = 0, pl = 0, nc = 0, clv = 0;
    for (const o of list) {
      const f = fin.get(o.id), r = f != null ? payout(o, f, o.p) : null;
      if (r != null) { n++; pl += r - 1; }
      const c = cl.get(`${o.id}|${o.k}`); if (c && c.f > 1) { nc++; clv += o.p / c.f - 1; }
    }
    out.push(`  ${label.padEnd(30)} ${String(list.length).padStart(5)} bets · settled ${String(n).padStart(5)}${n ? ` · ${units(pl).padStart(8)} · ROI ${pct(pl / n).padStart(7)}` : ''}${nc ? ` · CLV ${pct(clv / nc)} (${nc})` : ''}`);
  };
  out.push('', 'FIRST SIGHTING — 1 unit at Bet365\'s price when the gap first reached the edge:');
  for (const X of [3, 5, 8]) {
    const L = opens.filter(o => o.e >= X);
    out.push(` Edge ≥ ${X}%:`);
    line('all', L);
    for (const mk of ['AH', 'OU', '1X2']) line(`  ${mk}`, L.filter(o => o.mk === mk));
    for (const [lab, lo, hi] of [['  ≤ 1 h before KO', 0, 60], ['  1–6 h', 60, 360], ['  6–24 h', 360, 1440], ['  > 24 h', 1440, 1e9]]) line(lab, L.filter(o => o.kmin > lo && o.kmin <= hi));
    line('  Pinnacle copy ≤ 2 min old', L.filter(o => o.pa != null && o.pa <= 120));
  }

  // Lifetime
  const closed = rows.filter(o => o.ev === 'closed');
  if (opens.length) {
    const mins = closed.map(o => o.mins);
    const byB = closed.filter(o => o.byB365 > o.byPin).length, byP = closed.filter(o => o.byPin >= o.byB365).length;
    const openKeys = new Set(opens.map(o => `${o.id}|${o.k}`)), closedKeys = new Set(closed.map(o => `${o.id}|${o.k}`));
    const stillAtClose = [...cl.values()].filter(o => openKeys.has(`${o.id}|${o.k}`) && o.e >= 3).length;
    out.push('', ...[`LIFETIME — ${opens.length} gaps ≥ 3% opened · ${closed.length} closed (< 1%) · ${[...openKeys].filter(k => !closedKeys.has(k)).length} never seen to close (line changed, kick-off, or still open)`,
      closed.length ? `  minutes open until closed: median ${median(mins)} · 25% closed within ${[...mins].sort((a, b) => a - b)[Math.floor(mins.length / 4)]} min · 75% within ${[...mins].sort((a, b) => a - b)[Math.floor(mins.length * 3 / 4)]} min` : '  none closed yet',
      closed.length ? `  closed mostly by Bet365's price coming down: ${byB} (${Math.round(byB / closed.length * 100)}%) · by Pinnacle's fair moving up: ${byP} (${Math.round(byP / closed.length * 100)}%)` : '',
      `  still ≥ 3% in the closing snapshot: ${stillAtClose}`].filter(Boolean));
  }
  out.push('', 'Judge on CLV first (it needs no results) and on ROI only after a few hundred settled bets.');
  return out.join('\n');
}

module.exports = { buildReport };

if (require.main === module) {
  const arg = (n, dflt) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : dflt; };
  console.log(buildReport(path.resolve(__dirname, arg('--dir', 'data/pinngap'))));
}
