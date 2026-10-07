'use strict';
/**
 * Does Bet365's in-play price beat the similar-matches model? Reads the
 * LIVEMODEL shadow recorder (telegram/data/livemodel/*.jsonl, written by
 * notify.js's runLiveGapScan via livemodel.js). Nothing here was ever alerted.
 *
 *   node livemodel_report.js [--dir data/livemodel]
 *   GET <bot>/livemodel/report  (notify.js's relay server — same text)
 *
 * 1. CALIBRATION — every logged side (one per match+side per 15 min), by the
 *    model's edge at Bet365's price: if the model is right, the actual ROI in
 *    each bucket matches the model's edge. Rows are correlated within a match.
 * 2. FIRST BET PER MATCH — the first side of each match to reach an edge
 *    threshold, settled 1 unit at Bet365's price; also only Bet365 1.70–2.50,
 *    only when the edge clears the threshold by one standard error, by half,
 *    and only when Pinnacle (same line, de-vigged) also had Bet365 above fair.
 * 3. PINNACLE CHECK — how often Pinnacle agrees when the model sees value.
 * Settlement: confirmed FT scores only (livegap_result.js `res` lines), AH on
 * goals after the row, quarter lines split; extra time on the 90' score.
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
  if (!d || !d.rows.length) return `No LIVEMODEL data yet (${dir}). It needs the Railway volume mounted at /app/data.`;
  const { rows, fin, noRes } = d;
  const when = t => new Date(t).toLocaleString('it-IT', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const ret = o => { const f = fin.get(o.id); return f != null ? payout(o, f, o.p) : null; };
  const ids = new Set(rows.map(o => o.id));
  const out = [`LIVEMODEL report (shadow — no alerts sent) · ${rows.length} rows · ${ids.size} matches from ${when(rows[0].t)} to ${when(rows[rows.length - 1].t)} · ${[...ids].filter(i => fin.get(i) != null).length} with a confirmed FT score · ${[...ids].filter(i => noRes.has(i)).length} no result found`];

  // ── 1. Calibration ──
  const seen = new Set(), cal = [];
  for (const o of rows) { const k = `${o.id}|${o.k}|${Math.floor(o.t / 900000)}`; if (!seen.has(k)) { seen.add(k); cal.push(o); } }
  const buckets = [[-Infinity, -15], [-15, -5], [-5, 0], [0, 3], [3, 5], [5, 10], [10, 20], [20, Infinity]];
  out.push('', 'CALIBRATION — model edge at Bet365\'s live price vs actual return (1 row per match+side per 15 min, settled only):');
  out.push(`  ${'model edge'.padEnd(12)} ${'rows'.padStart(6)} ${'matches'.padStart(8)} ${'avg model'.padStart(10)} ${'actual ROI'.padStart(11)}`);
  for (const [lo, hi] of buckets) {
    const b = cal.filter(o => o.e >= lo && o.e < hi && ret(o) != null);
    if (!b.length) continue;
    const roi = b.reduce((s, o) => s + ret(o) - 1, 0) / b.length;
    const label = lo === -Infinity ? `< ${hi}%` : hi === Infinity ? `≥ ${lo}%` : `${lo}…${hi}%`;
    out.push(`  ${label.padEnd(12)} ${String(b.length).padStart(6)} ${String(new Set(b.map(o => o.id)).size).padStart(8)} ${pct(b.reduce((s, o) => s + o.e / 100, 0) / b.length).padStart(10)} ${pct(roi).padStart(11)}`);
  }

  // ── 2. First bet per match ──
  out.push('', 'FIRST BET PER MATCH — first side of each match to reach the edge, 1 unit at Bet365\'s price:');
  const strat = (label, pick) => {
    const first = new Map();
    for (const o of rows) if (!first.has(o.id) && pick(o)) first.set(o.id, o);
    const bets = [...first.values()];
    let n = 0, pl = 0, waiting = 0, nr = 0;
    const tally = { won: 0, 'half won': 0, void: 0, 'half lost': 0, lost: 0 };
    for (const o of bets) {
      const r = ret(o);
      if (r == null) { noRes.has(o.id) ? nr++ : waiting++; continue; }
      n++; pl += r - 1;
      tally[r > 1.001 ? (r < o.p - 1e-9 ? 'half won' : 'won') : r < 0.999 ? (r > 1e-9 ? 'half lost' : 'lost') : 'void']++;
    }
    out.push(`  ${label.padEnd(44)} ${String(bets.length).padStart(4)} bets · settled ${String(n).padStart(4)}${n ? ` · ${units(pl).padStart(8)} · ROI ${pct(pl / n).padStart(7)} · ${Object.entries(tally).filter(([, c]) => c).map(([k, c]) => `${c} ${k}`).join(', ')}` : ''}${waiting ? ` · waiting ${waiting}` : ''}${nr ? ` · no result ${nr}` : ''}`);
  };
  const inRange = o => o.p >= 1.7 && o.p <= 2.5;
  const pinAgrees = o => o.pf && o.p / o.pf - 1 >= 0;
  for (const X of [3, 5, 10]) {
    out.push(`  Edge ≥ ${X}%:`);
    strat('  any price', o => o.e >= X);
    strat('  Bet365 1.70–2.50', o => o.e >= X && inRange(o));
    strat('  1.70–2.50, edge − 1 s.e. ≥ threshold', o => o.e - o.se >= X && inRange(o));
    strat('  1.70–2.50, 1st half', o => o.e >= X && inRange(o) && o.min <= 45 && !o.ht);
    strat('  1.70–2.50, half-time / 2nd half', o => o.e >= X && inRange(o) && (o.min > 45 || o.ht));
    strat('  1.70–2.50, Pinnacle also above fair', o => o.e >= X && inRange(o) && pinAgrees(o));
  }

  // ── 3. Pinnacle check ──
  const withPin = cal.filter(o => o.pf && o.e >= 5);
  if (withPin.length) {
    const agree = withPin.filter(pinAgrees);
    const roiOf = l => { const s = l.filter(o => ret(o) != null); return s.length ? `${s.length} settled, ROI ${pct(s.reduce((a, o) => a + ret(o) - 1, 0) / s.length)}` : 'none settled'; };
    out.push('', `PINNACLE CHECK — model edge ≥ 5% with a same-line Pinnacle price: ${withPin.length} rows; Pinnacle also had Bet365 above its fair in ${agree.length} (${Math.round(agree.length / withPin.length * 100)}%).`,
      `  Pinnacle agrees:    ${roiOf(agree)}`, `  Pinnacle disagrees: ${roiOf(withPin.filter(o => !pinAgrees(o)))}`);
  }
  out.push('', 'Large model edges usually mean Bet365 knows something the model does not (red card, line-ups, pressure). Judge only on settled rows across many matches.');
  return out.join('\n');
}

module.exports = { buildReport };

if (require.main === module) {
  const arg = (n, dflt) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : dflt; };
  console.log(buildReport(path.resolve(__dirname, arg('--dir', 'data/livemodel'))));
}
