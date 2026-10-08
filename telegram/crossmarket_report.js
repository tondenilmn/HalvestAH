'use strict';
/**
 * Does Bet365 misprice one of its own markets against the others? Reads the
 * CROSSMARKET shadow recorder (telegram/data/crossmarket/*.jsonl, written by
 * notify.js's runPriceGapScan via crossmarket.js). Nothing was ever alerted.
 *
 *   node crossmarket_report.js [--dir data/crossmarket]
 *   GET <bot>/crossmarket/report
 *
 * A = 1X2 side vs the 1X2 implied by Bet365's AH + goal line
 * B = AH side (Bet365's line) vs the AH implied by Bet365's 1X2 + goal line
 * Bets, one per fixture per type, 1 unit at the price recorded:
 *   first sighting  — the first side to reach the edge (what an alert would send)
 *   at opening      — first sighting while both markets were still at their opening prices
 *   closing         — the biggest qualifying side in the last 30 min before kick-off
 *   closing, lagged — same, when the other market had moved that way and this one lagged
 * The backtest's claims to compare against (20 months): B closing ≥5% +9.2%,
 * lagged +18.7%; A at opening ≥5% +13.7%; A closing ≥5% −5.1%; B opening ≥5% −3.9%.
 * Calibration: every closing snapshot side by model edge vs actual return.
 * Settlement: confirmed FT scores (livegap_result.js), quarter lines split.
 */
const fs = require('fs');
const path = require('path');
const { payout } = require('./livegap_report');

const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const units = x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}u`;

function load(dir) {
  if (!fs.existsSync(dir)) return null;
  const rows = [], fin = new Map(), noRes = new Set();
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.res !== undefined) fin.set(o.id, o.et ? o.reg : o.res);
      else if (o.nores) noRes.add(o.id);
      else if (o.k) rows.push(o);
    }
  }
  rows.sort((a, b) => a.t - b.t);
  return { rows, fin, noRes };
}

function buildReport(dir, opts = {}) {
  const tz = opts.tz || 'Europe/Rome';
  const d = load(dir);
  if (!d || !d.rows.length) return `No CROSSMARKET data yet (${dir}). It needs the Railway volume mounted at /app/data.`;
  const { rows, fin, noRes } = d;
  const when = t => new Date(t).toLocaleString('it-IT', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const ret = o => { const f = fin.get(o.id); return f != null ? payout(o, f, o.p) : null; };
  const ids = new Set(rows.map(o => o.id));
  const played = [...ids].filter(i => fin.has(i)).length;
  const out = [`CROSSMARKET report (shadow — no alerts sent) · ${rows.length} rows · ${ids.size} fixtures from ${when(rows[0].t)} to ${when(rows[rows.length - 1].t)} · ${played} with a confirmed FT score · ${[...ids].filter(i => noRes.has(i)).length} no result found`];

  const line = (label, bets) => {
    let n = 0, pl = 0, waiting = 0, nr = 0;
    for (const o of bets) { const r = ret(o); if (r == null) { noRes.has(o.id) ? nr++ : waiting++; continue; } n++; pl += r - 1; }
    out.push(`  ${label.padEnd(40)} ${String(bets.length).padStart(5)} bets · settled ${String(n).padStart(5)}${n ? ` · ${units(pl).padStart(9)} · ROI ${pct(pl / n).padStart(7)}` : ''}${waiting ? ` · waiting ${waiting}` : ''}${nr ? ` · no result ${nr}` : ''}`);
  };
  const firstPer = (list, pick) => { const m = new Map(); for (const o of list) if (!m.has(o.id) && pick(o)) m.set(o.id, o); return [...m.values()]; };
  const bestPer = (list, pick) => { const m = new Map(); for (const o of list) if (pick(o) && (!m.has(o.id) || o.e > m.get(o.id).e)) m.set(o.id, o); return [...m.values()]; };
  for (const [ty, name] of [['B', 'B — AH vs the 1X2 + goal line'], ['A', 'A — 1X2 vs the AH + goal line']]) {
    const R = rows.filter(o => o.ty === ty);
    out.push('', `${name}:`);
    for (const X of [3, 5, 8, 12]) {
      out.push(` Edge ≥ ${X}%:`);
      line('first sighting', firstPer(R, o => o.e >= X));
      line('first sighting, both still at opening', firstPer(R, o => o.e >= X && o.un));
      line('closing (last 30 min)', bestPer(R, o => o.cl && o.e >= X));
      line('closing, other market moved, this lagged', bestPer(R, o => o.cl && o.e >= X && o.lag));
      if (ty === 'A') line('closing, 1X2 price ≤ 4.00', bestPer(R, o => o.cl && o.e >= X && o.p <= 4));
    }
  }

  // Calibration on the closing snapshots (one row per fixture+side).
  const seen = new Set(), cal = [];
  for (const o of rows) if (o.cl) { const k = `${o.id}|${o.k}`; if (!seen.has(k)) { seen.add(k); cal.push(o); } }
  out.push('', 'CALIBRATION — every side in the last 30 min, model edge vs actual return (settled only):');
  for (const ty of ['B', 'A']) {
    for (const [lo, hi] of [[-Infinity, -5], [-5, 0], [0, 3], [3, 5], [5, 10], [10, Infinity]]) {
      const b = cal.filter(o => o.ty === ty && o.e >= lo && o.e < hi && ret(o) != null);
      if (!b.length) continue;
      const label = lo === -Infinity ? `< ${hi}%` : hi === Infinity ? `≥ ${lo}%` : `${lo}…${hi}%`;
      out.push(`  ${ty} ${label.padEnd(10)} ${String(b.length).padStart(6)} sides · avg model ${pct(b.reduce((s, o) => s + o.e / 100, 0) / b.length).padStart(7)} · actual ${pct(b.reduce((s, o) => s + ret(o) - 1, 0) / b.length).padStart(7)}`);
    }
  }
  out.push('', 'If the backtest edge is a recording-time artefact, the closing B rows will look like the control (≈ −4.5%) here. ~6-7 qualifying fixtures a day: judge after a few hundred settled.');
  return out.join('\n');
}

module.exports = { buildReport };

if (require.main === module) {
  const arg = (n, dflt) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : dflt; };
  console.log(buildReport(path.resolve(__dirname, arg('--dir', 'data/crossmarket'))));
}
