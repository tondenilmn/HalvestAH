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
const blind = require('./blind');
const { classifyLeague } = require('./engine');

const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const units = x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}u`;

function load(dir) {
  if (!fs.existsSync(dir)) return null;
  const rows = [], fin = new Map(), noRes = new Set(), alerts = [];
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.res !== undefined) fin.set(o.id, o.et ? o.reg : o.res);
      else if (o.nores) noRes.add(o.id);
      else if (o.alert) alerts.push(o.alert);
      else if (o.k) rows.push(o);
    }
  }
  rows.sort((a, b) => a.t - b.t);
  alerts.sort((a, b) => a.t - b.t);
  return { rows, fin, noRes, alerts };
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

  // In-play blind baseline from the calibration sample (1 row per match+side per 15 min).
  const seen = new Set(), cal = [];
  for (const o of rows) { const k = `${o.id}|${o.k}|${Math.floor(o.t / 900000)}`; if (!seen.has(k)) { seen.add(k); cal.push(o); } }
  const inplay = blind.inplayTable(cal, ret), BLIND_MIN = 100;
  const vsOf = (list, total) => blind.fmtVs(blind.vsBlind(inplay, list.map(o => ({ ...o, ret: ret(o) })).filter(o => o.ret != null), BLIND_MIN), total);

  // ── 0. Alerts sent (since 2026-10-08) ──
  if (d.alerts.length) {
    let n = 0, plP = 0, plM = 0, waiting = 0, nr = 0;
    const tally = { WON: 0, 'HALF WON': 0, VOID: 0, 'HALF LOST': 0, LOST: 0 };
    out.push('', `ALERTS SENT: ${d.alerts.length} (one per match; settled 1 unit at the Bet365 price shown and at the minimum odds)`);
    for (const a of d.alerts) {
      const f = fin.get(a.id), rp = f != null ? payout(a, f, a.p) : null, rm = f != null ? payout(a, f, a.mo) : null;
      let res;
      if (rp == null) { if (noRes.has(a.id)) { nr++; res = 'no result found'; } else { waiting++; res = 'waiting for FT'; } }
      else {
        n++; plP += rp - 1; plM += rm - 1;
        const oc = rp > 1.001 ? (rp < a.p - 1e-9 ? 'HALF WON' : 'WON') : rp < 0.999 ? (rp > 1e-9 ? 'HALF LOST' : 'LOST') : 'VOID';
        tally[oc]++; res = `${oc} (FT ${f}) ${units(rp - 1)} @${a.p} · ${units(rm - 1)} @${(+a.mo).toFixed(2)}`;
      }
      out.push(`  ${when(a.t)}  ${a.m} · ${a.min ?? '?'}' ${a.sc} · ${a.k} · Bet365 ${a.p} (min ${(+a.mo).toFixed(2)}, edge +${a.e}% ±${a.se})\n      → ${res}`);
    }
    if (n) out.push(`  Settled ${n}: ${Object.entries(tally).filter(([, c]) => c).map(([k, c]) => `${c} ${k.toLowerCase()}`).join(', ')} · waiting ${waiting}${nr ? ` · no result ${nr}` : ''}`,
      `  At the Bet365 price shown: ${units(plP)} → ROI ${pct(plP / n)}${vsOf(d.alerts, n)} · at the minimum odds: ${units(plM)} → ROI ${pct(plM / n)}`);
    // Edges ≥ 20% are blocked since 2026-10-09 (LIVEMODEL_MAX_EDGE_PCT): mostly Bet365
    // Live prices left over from before a goal, so their profit was at a price nobody
    // could get. Shown apart so the current rule's own record is visible.
    for (const [lab, f] of [['edge < 20% (current rule)', a => a.e < 20], ['edge ≥ 20% (blocked since 09/10 — mostly stale prices)', a => a.e >= 20]]) {
      const L = d.alerts.filter(f); let k = 0, pl = 0;
      for (const a of L) { const fr = fin.get(a.id), r = fr != null ? payout(a, fr, a.p) : null; if (r != null) { k++; pl += r - 1; } }
      if (L.length) out.push(`    ${lab.padEnd(54)} ${String(L.length).padStart(4)} alerts · settled ${String(k).padStart(4)}${k ? ` · ${units(pl).padStart(8)} → ROI ${pct(pl / k)}` : ''}`);
    }
  }

  // ── 1. Calibration ──
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
    out.push(`  ${label.padEnd(44)} ${String(bets.length).padStart(4)} bets · settled ${String(n).padStart(4)}${n ? ` · ${units(pl).padStart(8)} · ROI ${pct(pl / n).padStart(7)}${vsOf(bets, n)} · ${Object.entries(tally).filter(([, c]) => c).map(([k, c]) => `${c} ${k}`).join(', ')}` : ''}${waiting ? ` · waiting ${waiting}` : ''}${nr ? ` · no result ${nr}` : ''}`);
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
    strat('  current alert rule (− 1 s.e., < 20%, not stale)', o => o.e - o.se >= X && o.e < 20 && inRange(o) && !o.st);
  }

  // ── By league tier (TOP / MAJOR / OTHER, engine.classifyLeague) ──
  const tierOf = o => classifyLeague(o.lg || '');
  const tally = (list, label, w = 16) => {
    let n = 0, pl = 0, won = 0;
    for (const o of list) { const r = ret(o); if (r == null) continue; n++; pl += r - 1; if (r > 1.001) won++; }
    return `    ${label.padEnd(w)} ${String(list.length).padStart(4)} bets · settled ${String(n).padStart(4)}${n ? ` · ${units(pl).padStart(8)} · ROI ${pct(pl / n).padStart(7)} · won ${Math.round(won / n * 100)}%${vsOf(list, n)}` : ''}`;
  };
  const firstOf = pick => { const f = new Map(); for (const o of rows) if (!f.has(o.id) && pick(o)) f.set(o.id, o); return [...f.values()]; };
  const ruleNow = o => o.e - o.se >= 5 && o.e < 20 && inRange(o) && !o.st;
  out.push('', 'BY LEAGUE TIER (TOP = top-5 leagues + UEFA cups, MAJOR = other strong leagues, OTHER = the rest):');
  for (const [title, list] of [['Alerts sent, edge < 20% (current rule):', d.alerts.filter(a => a.e < 20)], ['Alerts sent, all:', d.alerts],
    ['Recorded first bet per match under the current rule (edge − 1 s.e. ≥ 5%, < 20%, 1.70–2.50, not stale):', firstOf(ruleNow)]]) {
    out.push(`  ${title}`);
    for (const t of ['TOP', 'MAJOR', 'OTHER']) { const L = list.filter(o => tierOf(o) === t); if (L.length) out.push(tally(L, t)); }
  }
  const byLg = new Map(); for (const o of firstOf(ruleNow)) { const k = o.lg || '?'; if (!byLg.has(k)) byLg.set(k, []); byLg.get(k).push(o); }
  const lgRows = [...byLg].filter(([, L]) => L.filter(o => ret(o) != null).length >= 5).sort((a, b) => b[1].length - a[1].length).slice(0, 15);
  if (lgRows.length) {
    out.push('  Leagues with ≥ 5 settled first bets under the current rule (small samples — noise at this size):');
    for (const [lg, L] of lgRows) out.push(tally(L, `${classifyLeague(lg)} · ${lg}`.slice(0, 44), 44));
  }

  // ── In-play blind baseline table ──
  const keys = ['1X2|home', '1X2|draw', '1X2|away', 'AH', 'OU'];
  out.push('', `IN-PLAY BLIND — every recorded side (calibration sample) settled at Bet365's live price, by price band (cells with ≥ ${BLIND_MIN} rows feed "vs blind"):`);
  for (const k of keys) {
    const cells = blind.BANDS.map((_, i) => ({ i, c: inplay[`${k}|${i}`] })).filter(x => x.c);
    if (cells.length) out.push(`  ${k.padEnd(9)} ${cells.map(({ i, c }) => `${blind.bandLabel(i)} ${pct(c.roi)} (${c.n})`).join(' · ')}`);
  }

  // ── 3. Pinnacle check ──
  const withPin = cal.filter(o => o.pf && o.e >= 5);
  if (withPin.length) {
    const agree = withPin.filter(pinAgrees);
    const roiOf = l => { const s = l.filter(o => ret(o) != null); return s.length ? `${s.length} settled, ROI ${pct(s.reduce((a, o) => a + ret(o) - 1, 0) / s.length)}` : 'none settled'; };
    out.push('', `PINNACLE CHECK — model edge ≥ 5% with a same-line Pinnacle price: ${withPin.length} rows; Pinnacle also had Bet365 above its fair in ${agree.length} (${Math.round(agree.length / withPin.length * 100)}%).`,
      `  Pinnacle agrees:    ${roiOf(agree)}`, `  Pinnacle disagrees: ${roiOf(withPin.filter(o => !pinAgrees(o)))}`);
  }
  out.push('', 'Vs blind = ROI minus what betting every recorded side blind returned at the same market and price band (in-play, from this recorder\'s own rows).', 'Large model edges usually mean Bet365 knows something the model does not (red card, line-ups, pressure). Judge only on settled rows across many matches.');
  return out.join('\n');
}

module.exports = { buildReport };

if (require.main === module) {
  const arg = (n, dflt) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : dflt; };
  console.log(buildReport(path.resolve(__dirname, arg('--dir', 'data/livemodel'))));
}
