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
  const alerts = [], blocked = [], cl = new Map(), nx = new Map(), fin = new Map(), noRes = new Set();
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.ev === 'alert') alerts.push(o);
      else if (o.ev === 'blk7') blocked.push(o);
      else if (o.ev === 'cl') cl.set(o.pk, o);
      else if (o.ev === 'nx') nx.set(o.pk, o);
      else if (o.res !== undefined) fin.set(o.id, o.et ? o.reg : o.res);
      else if (o.nores) noRes.add(o.id);
    }
  }
  return { alerts: alerts.sort((a, b) => a.t - b.t), blocked, cl, nx, fin, noRes };
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
  const { alerts, cl, nx, fin, noRes } = d;
  const when = t => new Date(t).toLocaleString('it-IT', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const out = [`PRICEGAP report · ${alerts.length} alerted sides from ${when(alerts[0].t)} to ${when(alerts[alerts.length - 1].t)}`];

  const all = summarize(alerts, fin);
  const waiting = alerts.filter(a => !fin.has(a.id) && !noRes.has(a.id)).length;
  out.push('', `RESULT (1 unit per alerted side): settled ${all.n}${all.n ? ` · at the Bet365 price shown ${units(all.plP)} → ROI ${pct(all.plP / all.n)} · at the minimum odds ${units(all.plM)} → ROI ${pct(all.plM / all.n)}${blind.fmtVs(all.vs, all.n)}` : ''} · waiting for FT ${waiting}${noRes.size ? ` · no result ${alerts.filter(a => noRes.has(a.id)).length}` : ''}`);
  const refName = a => (a.ref === 'pin' ? 'vs Pinnacle' : 'vs Sbobet');
  for (const [label, key] of [['by reference book', refName], ['by backtest bucket', 'b'], ['by market', 'mk']]) {
    const get = typeof key === 'function' ? key : a => a[key];
    out.push(`  ${label}:`);
    for (const v of [...new Set(alerts.map(get))]) {
      const L = alerts.filter(a => get(a) === v), s = summarize(L, fin);
      out.push(`    ${String(v).padEnd(14)} ${String(L.length).padStart(4)} sides · settled ${String(s.n).padStart(4)}${s.n ? ` · ${units(s.plP).padStart(8)} · ROI ${pct(s.plP / s.n).padStart(7)}${blind.fmtVs(s.vs, s.n)}` : ''}`);
    }
  }

  // Detail per market (added 2026-10-17, user request): league tier, line cluster, side, price band.
  // AH lines are the side's own handicap (−0.5 = giving half a goal → favourite side).
  const { classifyLeague } = require('./engine');
  const row = (label, L) => { const s = summarize(L, fin); return `    ${label.padEnd(26)} ${String(L.length).padStart(4)} sides · settled ${String(s.n).padStart(4)}${s.n ? ` · ${units(s.plP).padStart(8)} · ROI ${pct(s.plP / s.n).padStart(7)}${blind.fmtVs(s.vs, s.n)}` : ''}`; };
  const groups = (L, label, key, order) => {
    out.push(`  ${label}:`);
    const vals = [...new Set(L.map(key))].sort((a, b) => (order ? order.indexOf(a) - order.indexOf(b) : String(a).localeCompare(String(b))));
    for (const v of vals) out.push(row(String(v), L.filter(a => key(a) === v)));
  };
  const tierOf = a => classifyLeague(a.lg || '');
  const priceBand = a => (a.p < 1.8 ? 'price < 1.80' : a.p < 2.0 ? 'price 1.80–1.99' : a.p < 2.2 ? 'price 2.00–2.19' : 'price ≥ 2.20');
  const PB = ['price < 1.80', 'price 1.80–1.99', 'price 2.00–2.19', 'price ≥ 2.20'], TIERS = ['TOP', 'MAJOR', 'OTHER'];
  const ah = alerts.filter(a => a.mk === 'AH'), ou = alerts.filter(a => a.mk === 'OU');
  if (ah.length) {
    out.push('', `ASIAN HANDICAP DETAIL (${ah.length} sides):`);
    groups(ah, 'by league tier', tierOf, TIERS);
    const sideType = a => (Math.abs(a.line) < 1e-9 ? 'level (0)' : a.line < 0 ? 'favourite (giving goals)' : 'underdog (getting goals)');
    groups(ah, 'by side', sideType, ['favourite (giving goals)', 'level (0)', 'underdog (getting goals)']);
    const AHC = ['line 0', 'line 0.25', 'line 0.5', 'line 0.75', 'line 1–1.25', 'line ≥ 1.5'];
    const ahCl = a => { const x = Math.abs(a.line); return x < 0.01 ? AHC[0] : x < 0.3 ? AHC[1] : x < 0.6 ? AHC[2] : x < 0.8 ? AHC[3] : x < 1.4 ? AHC[4] : AHC[5]; };
    groups(ah, 'by line (size of the handicap)', ahCl, AHC);
    groups(ah, 'by line and side', a => `${ahCl(a)} ${a.line < -1e-9 ? 'fav' : a.line > 1e-9 ? 'dog' : ''}`.trim(),
      AHC.flatMap(c => [`${c} fav`, c, `${c} dog`]));
    groups(ah, 'by Bet365 price', priceBand, PB);
    groups(ah, 'by tier and reference', a => `${tierOf(a)} ${refName(a)}`, TIERS.flatMap(t => [`${t} vs Sbobet`, `${t} vs Pinnacle`]));
  }
  if (ou.length) {
    out.push('', `GOAL LINE (OVER / UNDER) DETAIL (${ou.length} sides):`);
    groups(ou, 'by league tier', tierOf, TIERS);
    groups(ou, 'by side', a => a.side, ['over', 'under']);
    const OUC = ['total < 2', 'total 2–2.5', 'total 2.75–3', 'total ≥ 3.25'];
    const ouCl = a => (a.line < 1.99 ? OUC[0] : a.line < 2.6 ? OUC[1] : a.line < 3.1 ? OUC[2] : OUC[3]);
    groups(ou, 'by total line', ouCl, OUC);
    groups(ou, 'by total line and side', a => `${ouCl(a)} ${a.side}`, OUC.flatMap(c => [`${c} over`, `${c} under`]));
    groups(ou, 'by Bet365 price', priceBand, PB);
    groups(ou, 'by tier and reference', a => `${tierOf(a)} ${refName(a)}`, TIERS.flatMap(t => [`${t} vs Sbobet`, `${t} vs Pinnacle`]));
  }
  out.push('  (Small cells swing a lot — read cells with a few hundred settled sides, not a few dozen.)');

  // 7msport check (sevenm.js, since 2026-10-11): what it said about the alerts sent, and the
  // alerts it blocked, settled as if sent at our feed's price — blocking pays if those lose.
  if (d.blocked.length || alerts.some(a => a.v7)) {
    const V7 = { ok: 'confirmed by 7msport', adj: 'sent at 7msport\'s lower price', nf: 'not found on 7msport', err: '7msport unreachable' };
    out.push('', '7MSPORT CHECK (Bet365\'s latest price on 7msport before sending):');
    for (const [k, lab] of Object.entries(V7)) {
      const L = alerts.filter(a => a.v7 === k); if (!L.length) continue;
      const s = summarize(L, fin);
      out.push(`  ${lab.padEnd(34)} ${String(L.length).padStart(4)} sides · settled ${String(s.n).padStart(4)}${s.n ? ` · ${units(s.plP).padStart(8)} · ROI ${pct(s.plP / s.n).padStart(7)}` : ''}`);
    }
    for (const [k, lab] of [['line', 'BLOCKED — Bet365 on another line'], ['lower', 'BLOCKED — Bet365 below the minimum']]) {
      const L = d.blocked.filter(a => a.v7 === k); if (!L.length) continue;
      const s = summarize(L, fin);
      out.push(`  ${lab.padEnd(34)} ${String(L.length).padStart(4)} sides · settled ${String(s.n).padStart(4)}${s.n ? ` · if sent at our price ${units(s.plP).padStart(8)} · ROI ${pct(s.plP / s.n).padStart(7)}` : ''}`);
    }
  }

  // Next scan after the alert: was the price still there?
  const checked = alerts.filter(a => nx.has(a.pk));
  if (checked.length) {
    const held = checked.filter(a => nx.get(a.pk).held), gone = checked.filter(a => !nx.get(a.pk).held);
    const sl = (lab, L) => { const s = summarize(L, fin); return `  ${lab.padEnd(40)} ${String(L.length).padStart(4)} sides · settled ${String(s.n).padStart(4)}${s.n ? ` · ${units(s.plP).padStart(8)} · ROI ${pct(s.plP / s.n).padStart(7)}` : ''}`; };
    out.push('', `NEXT SCAN AFTER THE ALERT (~1 min near / ~15 min far): ${checked.length} checked · still ≥ the minimum odds ${held.length} (${Math.round(held.length / checked.length * 100)}%) · gone or below ${gone.length}`,
      sl('price still there', held), sl('gone / below the minimum (not bettable)', gone),
      sl('confirmed on 2+ scans before alerting', alerts.filter(a => (a.scans || 1) >= 2)), sl('alerted on a single scan (before 10/10)', alerts.filter(a => !a.scans || a.scans < 2)));
  }

  // Closing-line value
  const withCl = alerts.map(a => ({ a, c: cl.get(a.pk) })).filter(x => x.c);
  const same = withCl.filter(x => !x.c.moved && x.c.f > 1);
  if (withCl.length) {
    const clv = same.reduce((s, x) => s + (x.a.p / x.c.f - 1), 0) / Math.max(1, same.length);
    const b365down = same.filter(x => x.c.p < x.a.p).length, b365up = same.filter(x => x.c.p > x.a.p).length;
    out.push('', `CLOSING-LINE VALUE (closing snapshot ≤ 30 min before kick-off): ${withCl.length} sides · line changed ${withCl.length - same.length}`,
      `  same line ${same.length}: price shown vs the reference's closing fair (Sbobet, or Pinnacle for its alerts) → ${pct(clv)} on average · Bet365's price later lower ${b365down}, higher ${b365up}`,
      `  (the backtest's edge lives in this number: positive = the alerts beat the close)`);
  }

  out.push('', 'Vs blind = ROI at the price shown minus what betting every side blind at Bet365\'s closing price returned at the same market and price band.');
  out.push('', 'ALERTED SIDES:');
  for (const a of alerts.slice(-80)) {
    const f = fin.get(a.id), c = cl.get(a.pk);
    const r = f != null ? payout(a, f, a.p) : null;
    const res = r == null ? (noRes.has(a.id) ? 'no result found' : 'waiting for FT')
      : `${r > 1.001 ? (r < a.p - 1e-9 ? 'HALF WON' : 'WON') : r < 0.999 ? (r > 1e-9 ? 'HALF LOST' : 'LOST') : 'VOID'} (FT ${f}) ${units(r - 1)}`;
    const x = nx.get(a.pk);
    out.push(`  ${when(a.t)}  ${a.m} · ${a.k} · Bet365 ${a.p} (min ${(+a.mo).toFixed(2)}, +${a.e}%, ${a.b}, ${Math.round(a.kmin / 60)} h before KO${a.scans ? `, ${a.scans} scans` : ''})${x ? ` · next scan: ${x.p == null ? 'gone' : `${x.p}${x.held ? ' ✓' : ' ✗ below min'}`}` : ''}${c ? (c.moved ? ' · close: line moved' : ` · close: Bet365 ${c.p}, ${a.ref === 'pin' ? 'Pinnacle' : 'Sbobet'} fair ${c.f}`) : ''}\n      → ${res}`);
  }
  if (alerts.length > 80) out.push(`  … ${alerts.length - 80} earlier`);
  return out.join('\n');
}

module.exports = { buildReport };

if (require.main === module) {
  const arg = (n, dflt) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : dflt; };
  console.log(buildReport(path.resolve(__dirname, arg('--dir', 'data/pricegap_bets'))));
}
