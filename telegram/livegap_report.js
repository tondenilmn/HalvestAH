'use strict';
/**
 * Do live Bet365-vs-Pinnacle gaps pay? Reads the LIVEGAP recorder
 * (telegram/data/livegap/*.jsonl, written by notify.js's runLiveGapScan).
 *
 *   node livegap_report.js [--min 5] [--dir data/livegap]
 *
 * An "entry" is the first scan a match+market+line reached the threshold
 * (and, separately, the first scan it was there for the 2nd time in a row —
 * what the alert waits for). From the rows that follow at the same score
 * (≤ 15 min) it splits how the gap closed: Bet365 coming down to Pinnacle
 * (the price was good) or Pinnacle moving up to Bet365 (the gap was lag).
 * Bets are settled at the entry price from the last score seen at ≥ 85'
 * (AH counted from the score at entry, quarter lines split).
 */
const fs = require('fs');
const path = require('path');
const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const MIN = parseFloat(arg('--min', '5'));
const DIR = path.resolve(__dirname, arg('--dir', 'data/livegap'));
if (!fs.existsSync(DIR)) { console.log(`No recorder data yet (${DIR}).`); process.exit(0); }

const rows = [], fin = new Map();
let scans = 0;
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl')).sort()) {
  for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.hb) scans++;
    else if (o.fin !== undefined) { if (o.final) fin.set(o.id, o.fin); }
    else rows.push(o);
  }
}
const sc = s => { const m = /^(\d+)-(\d+)$/.exec(String(s || '')); return m ? [+m[1], +m[2]] : null; };
const part = (x, price) => (x > 1e-9 ? price : x < -1e-9 ? 0 : 1);
const split = (base, line, price) => (Math.abs(Math.abs(line * 4) % 2 - 1) < 1e-6 ? (part(base + line - 0.25, price) + part(base + line + 0.25, price)) / 2 : part(base + line, price));
function payout(o, final) {
  const g = sc(final), s0 = sc(o.sc); if (!g || !s0) return null;
  if (o.mk === '1X2') { const d = g[0] - g[1]; return (o.side === 'home' ? d > 0 : o.side === 'away' ? d < 0 : d === 0) ? o.p : 0; }
  if (o.mk === 'OU') { const t = g[0] + g[1]; return o.side === 'over' ? split(t, -o.line, o.p) : split(-t, o.line, o.p); }
  if (o.mk === 'AH') { const d = (g[0] - s0[0]) - (g[1] - s0[1]); return split(o.side === 'home' ? d : -d, o.line, o.p); }
  return null;
}

const byKey = new Map();
for (const o of rows) { const k = `${o.id}|${o.k}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(o); }
const report = (label, pickEntry) => {
  let n = 0, settled = 0, pl = 0, byB = 0, byR = 0, open = 0;
  for (const list of byKey.values()) {
    list.sort((a, b) => a.t - b.t);
    const e = pickEntry(list); if (!e) continue;
    n++;
    const later = list.filter(o => o.t > e.t && o.t - e.t <= 15 * 60000 && o.sc === e.sc);
    const last = later[later.length - 1];
    if (last) {
      const bk = Math.log(e.p / last.p), rf = Math.log(last.f / e.f);
      if (last.e >= MIN) open++; else if (bk + rf > 0) (bk >= rf ? byB++ : byR++);
    }
    const final = fin.get(e.id);
    const pay = final != null ? payout(e, final) : null;
    if (pay != null) { settled++; pl += pay - 1; }
  }
  console.log(`${label.padEnd(34)} ${String(n).padStart(5)} gaps · closed by Bet365 ${byB} · by Pinnacle ${byR} · still open ${open} · settled ${settled}${settled ? ` · ROI ${(100 * pl / settled >= 0 ? '+' : '') + (100 * pl / settled).toFixed(1)}%` : ''}`);
};
console.log(`LIVEGAP recorder: ${scans} scans, ${rows.length} rows, ${fin.size} matches with a final score · threshold ${MIN}%\n`);
report('first scan at threshold', l => l.find(o => o.e >= MIN));
report('2nd scan in a row (alert timing)', l => l.find((o, i) => o.e >= MIN && i > 0 && l[i - 1].e >= MIN && o.t - l[i - 1].t <= 150000 && l[i - 1].sc === o.sc));
console.log('\n"Closed by Bet365" = Bet365 came down to Pinnacle (the price was good); "by Pinnacle" = Pinnacle moved up (the gap was lag). Not backtested — this IS the test.');
