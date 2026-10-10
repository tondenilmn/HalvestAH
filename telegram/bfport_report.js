'use strict';
/**
 * BFPORT report — the paper Betfair 1X2 portfolio (bfport.js) and the exchange's
 * own blind returns. Reads telegram/data/bfport/*.jsonl.
 *
 *   node bfport_report.js [--dir data/bfport] [--start 1000]
 *   GET <bot>/bfport/report
 *
 * 1. PORTFOLIO — the paper bets: bankroll, P/L, ROI on money staked, flat 1-unit
 *    ROI with a 95% interval, max drawdown, losing streak; by side, price, tier.
 * 2. CLOSING-LINE VALUE — the net price taken vs Pinnacle's closing fair and vs
 *    Betfair's closing back price (both needing no result; judge on this first).
 * 3. OTHER THRESHOLDS — the first sighting per fixture at net edge ≥ 1/2/3/5%
 *    with the same other gates, flat 1 unit.
 * 4. BETFAIR BLIND — every paired side at its closing Betfair price (net of
 *    commission): what an "index" of favourites / draws / underdogs returns.
 * All prices net of the commission on winnings; settled on confirmed FT scores.
 */
const fs = require('fs');
const path = require('path');
const { payout } = require('./livegap_report');
const { classifyLeague } = require('./engine');
const B = require('./bfport');

const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const units = x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}u`;
const money = x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}`;

function load(dir) {
  if (!fs.existsSync(dir)) return null;
  const rows = [], bets = [], fin = new Map(), noRes = new Set();
  let scans = 0, first = null, last = null, paired = 0;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.hb) { scans++; first = first ?? o.hb.t; last = o.hb.t; paired += o.hb.paired || 0; }
      else if (o.res !== undefined) fin.set(o.id, o.et ? o.reg : o.res);
      else if (o.nores) noRes.add(o.id);
      else if (o.ev === 'bet') bets.push(o);
      else if (o.ev) rows.push(o);
    }
  }
  return { rows: rows.sort((a, b) => a.t - b.t), bets: bets.sort((a, b) => a.t - b.t), fin, noRes, scans, first, last, paired };
}

// Flat 1-unit returns → "n settled · P/L · ROI ± 95%".
function flat(list, fin) {
  const r = [];
  for (const o of list) { const f = fin.get(o.id); if (f != null) { const x = payout(o, f, o.p); if (x != null) r.push(x - 1); } }
  if (!r.length) return { n: 0, text: '' };
  const n = r.length, m = r.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1 ? Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (n - 1)) : 0;
  return { n, pl: m * n, roi: m, text: `settled ${String(n).padStart(4)} · ${units(m * n).padStart(8)} · ROI ${pct(m).padStart(7)} ± ${(1.96 * sd / Math.sqrt(n) * 100).toFixed(1)}%` };
}

function buildReport(dir, opts = {}) {
  const tz = opts.tz || 'Europe/Rome', start = opts.start ?? 1000;
  const d = load(dir);
  if (!d || !d.scans) return `No BFPORT data yet (${dir}).`;
  const { rows, bets, fin, noRes } = d;
  const when = t => new Date(t).toLocaleString('it-IT', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const cl = new Map(rows.filter(o => o.ev === 'cl').map(o => [`${o.id}|${o.k}`, o]));
  const out = [`BFPORT — paper portfolio on Betfair Exchange 1X2 (no real bets) · ${d.scans} scans from ${when(d.first)} to ${when(d.last)} · ${Math.round(d.paired / d.scans)} fixtures paired per scan on average`,
    'Prices are net of Betfair\'s commission on winnings; fair = Pinnacle pre-match, power de-vig, same moment.'];

  // ── 1. Portfolio ──
  const settled = bets.filter(b => fin.get(b.id) != null);
  let bank = start, peak = start, maxDd = 0, streak = 0, worst = 0, staked = 0, pl = 0;
  for (const b of settled) {
    const x = B.settleBet(b, fin.get(b.id)); if (x == null) continue;
    bank += x; pl += x; staked += b.stake;
    peak = Math.max(peak, bank); maxDd = Math.max(maxDd, (peak - bank) / peak);
    streak = x < 0 ? streak + 1 : 0; worst = Math.max(worst, streak);
  }
  const open = bets.filter(b => fin.get(b.id) == null && !noRes.has(b.id));
  const won = settled.filter(b => B.settleBet(b, fin.get(b.id)) > 0).length;
  out.push('', `PORTFOLIO (start ${start}; stake = ⅛ Kelly at the net price on the bankroll when placed, capped):`,
    `  ${bets.length} bets · settled ${settled.length} (${won} won) · open ${open.length} (${open.reduce((s, b) => s + b.stake, 0).toFixed(2)} at stake)${noRes.size ? ` · no result ${bets.filter(b => noRes.has(b.id)).length}` : ''}`,
    `  bankroll ${bank.toFixed(2)} (${money(pl)}, ${pct(pl / start)} of start) · ROI on money staked ${staked ? pct(pl / staked) : '—'} · max drawdown ${(maxDd * 100).toFixed(1)}% · longest losing run ${worst}`);
  const fl = flat(bets, fin);
  if (fl.n) out.push(`  flat 1 unit per bet: ${fl.text}`);
  const by = (label, f) => { const L = bets.filter(f); if (!L.length) return; const r = flat(L, fin); out.push(`    ${label.padEnd(20)} ${String(L.length).padStart(4)} bets${r.n ? ` · ${r.text}` : ''}`); };
  if (bets.length) {
    for (const s of B.SIDES) by(s, b => b.side === s);
    for (const [lab, lo, hi] of [['price 1.50–2.00', 0, 2], ['price 2.00–3.00', 2, 3], ['price 3.00+', 3, 99]]) by(lab, b => b.bf >= lo && b.bf < hi);
    for (const t of ['TOP', 'MAJOR', 'OTHER']) by(`tier ${t}`, b => classifyLeague(b.lg || '') === t);
  }

  // ── 2. CLV ──
  const clvOf = list => {
    let n = 0, vp = 0, vb = 0, nb = 0;
    for (const o of list) {
      const c = cl.get(`${o.id}|${o.k}`); if (!c) continue;
      if (c.f > 1) { n++; vp += o.p / c.f - 1; }
      if (c.bf > 1) { nb++; vb += o.bf / c.bf - 1; }
    }
    return n ? `vs Pinnacle's closing fair ${pct(vp / n)} (${n}) · vs Betfair's closing back ${nb ? pct(vb / nb) : '—'} (${nb})` : 'no closing snapshot yet';
  };
  out.push('', `CLOSING-LINE VALUE of the paper bets: ${clvOf(bets)}`, '  (positive = bought above where the market closed — the test that needs no results)');

  // ── 3. Other thresholds (same gates except the edge) ──
  const cand = rows.filter(o => o.ev === 'c' && o.ok);
  out.push('', 'OTHER THRESHOLDS — first sighting per fixture, flat 1 unit, same other gates:');
  for (const X of [1, 2, 3, 5]) {
    const first = new Map();
    for (const o of cand) if (o.e >= X && !first.has(o.id)) first.set(o.id, o);
    const L = [...first.values()], r = flat(L, fin);
    out.push(`  net edge ≥ ${X}%`.padEnd(20) + ` ${String(L.length).padStart(4)} bets${r.n ? ` · ${r.text}` : ''} · CLV ${clvOf(L)}`);
  }

  // ── 4. Betfair blind ──
  const cls = [...cl.values()];
  out.push('', 'BETFAIR BLIND — every paired side at its closing Betfair price (net of commission), flat 1 unit — the "index" return:');
  const byId = new Map(); for (const o of cls) { if (!byId.has(o.id)) byId.set(o.id, []); byId.get(o.id).push(o); }
  const role = o => { const L = byId.get(o.id); if (!L || L.length < 3) return null; if (o.side === 'draw') return 'draw'; const other = L.find(x => x.side !== 'draw' && x.side !== o.side); return other && o.bf < other.bf ? 'favourite' : 'underdog'; };
  for (const [lab, f] of [['all sides', () => true], ['favourites', o => role(o) === 'favourite'], ['draws', o => role(o) === 'draw'], ['underdogs', o => role(o) === 'underdog'],
    ['price < 1.50', o => o.bf < 1.5], ['price 1.50–2.00', o => o.bf >= 1.5 && o.bf < 2], ['price 2.00–3.00', o => o.bf >= 2 && o.bf < 3], ['price 3.00–5.00', o => o.bf >= 3 && o.bf < 5], ['price 5.00+', o => o.bf >= 5]]) {
    const L = cls.filter(f), r = flat(L, fin);
    out.push(`  ${lab.padEnd(18)} ${String(L.length).padStart(5)} sides${r.n ? ` · ${r.text}` : ''}`);
  }

  // ── Latest bets ──
  if (bets.length) {
    out.push('', 'PAPER BETS (latest 40):');
    for (const b of bets.slice(-40).reverse()) {
      const f = fin.get(b.id), x = f != null ? B.settleBet(b, f) : null;
      out.push(`  ${when(b.t)}  ${b.m} (${b.lg}) · ${b.side} · Betfair ${b.bf} (net ${b.p.toFixed(3)}) vs fair ${b.f} → +${b.e}% · stake ${b.stake.toFixed(2)} · ${Math.round(b.kmin / 60)} h before KO${b.b3 ? ` · Bet365 ${b.b3}` : ''}\n      → ${x != null ? `FT ${f} ${money(x)}` : noRes.has(b.id) ? 'no result found' : 'waiting for FT'}`);
    }
  }
  out.push('', 'Judge on closing-line value first, on P/L only after several hundred settled bets (± is the 95% interval of the flat ROI).');
  return out.join('\n');
}

module.exports = { buildReport, load };

if (require.main === module) {
  const arg = (n, dflt) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : dflt; };
  console.log(buildReport(path.resolve(__dirname, arg('--dir', 'data/bfport')), { start: +arg('--start', 1000) }));
}
