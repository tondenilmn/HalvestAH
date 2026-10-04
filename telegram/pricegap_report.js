'use strict';
/**
 * How long do pre-match Bet365-vs-Sbobet gaps last? Reads the PRICEGAP
 * recorder's files (telegram/data/pricegap/*.jsonl, written by notify.js's
 * runPriceGapScan) and prints, per time-to-kick-off bucket, how many gaps
 * reached the alert threshold and how long they stayed open — the evidence
 * for choosing PRICEGAP_SCAN_INTERVAL_MINUTES / PRICEGAP_FAR_SCAN_INTERVAL_MINUTES.
 *
 *   node pricegap_report.js [--min 5] [--dir data/pricegap]
 *
 * A gap "episode" = consecutive scans in which the same match+market+side+line
 * was at or above the recorder's floor. It ends at the first scan covering
 * that match in which it was absent (closed), or when the data / the match's
 * pre-match window runs out (censored — its lifetime is a lower bound).
 * Lifetime = last seen − first seen, so a gap seen once has lifetime 0
 * (it lasted less than one scan interval).
 */
const fs = require('fs');
const path = require('path');

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i > 0 ? process.argv[i + 1] : dflt; };
const MIN = parseFloat(arg('--min', '5'));
const DIR = path.resolve(__dirname, arg('--dir', 'data/pricegap'));

if (!fs.existsSync(DIR)) { console.log(`No recorder data yet (${DIR}). Leave the bot running with PRICEGAP_RECORD on.`); process.exit(0); }
const heartbeats = [], obs = [];
for (const f of fs.readdirSync(DIR).filter(f => f.endsWith('.jsonl')).sort()) {
  for (const line of fs.readFileSync(path.join(DIR, f), 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.hb) { if (o.hb.ok) heartbeats.push(o.hb); } else obs.push(o);
  }
}
heartbeats.sort((a, b) => a.t - b.t);
if (!heartbeats.length) { console.log('No successful scans recorded yet.'); process.exit(0); }

// A scan "covered" a match if the match's time to kick-off at that moment
// fell inside the scan's window.
const covers = (hb, firstT, firstKo) => {
  const ko = firstKo - (hb.t - firstT) / 60000;
  return ko > hb.koMin && ko <= hb.koMax;
};

const byKey = new Map();
for (const o of obs) {
  const key = `${o.id}|${o.k}`;
  if (!byKey.has(key)) byKey.set(key, []);
  byKey.get(key).push(o);
}

const episodes = [];
for (const list of byKey.values()) {
  list.sort((a, b) => a.t - b.t);
  const seen = new Set(list.map(o => o.t));
  let ep = null;
  const close = (endT, censored) => { if (ep) { episodes.push({ ...ep, life: (ep.last - ep.first) / 60000, censored }); ep = null; } };
  const first = list[0];
  for (const hb of heartbeats) {
    if (hb.t < first.t) continue;
    if (!covers(hb, first.t, first.ko)) { if (ep && hb.t > ep.last) { /* out of this scan's window */ } continue; }
    if (seen.has(hb.t)) {
      const o = list.find(x => x.t === hb.t);
      if (!ep) ep = { first: o.t, last: o.t, ko: o.ko, maxE: o.e, unmoved: o.u, m: o.m, k: o.k };
      else { ep.last = o.t; ep.maxE = Math.max(ep.maxE, o.e); }
    } else if (ep) close(hb.t, false);
  }
  close(null, true);
}

const BUCKETS = [['< 2 h', 0, 120], ['2-6 h', 120, 360], ['6-24 h', 360, 1440], ['1-3 days', 1440, 4320], ['3-7+ days', 4320, Infinity]];
const med = a => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const pct = (n, d) => d ? `${Math.round(100 * n / d)}%` : '—';
const span = `${new Date(heartbeats[0].t).toISOString().slice(0, 16)} → ${new Date(heartbeats.at(-1).t).toISOString().slice(0, 16)} UTC`;
console.log(`PRICEGAP recorder: ${heartbeats.length} scans, ${obs.length} gap observations, ${span}`);
console.log(`Episodes reaching ≥ ${MIN}% edge, by time to kick-off when first seen (lifetime in minutes; censored = still open when data/window ended):\n`);
console.log('bucket      episodes  median life  ≥5 min  ≥15 min  ≥60 min  closed  at-opening');
for (const [name, lo, hi] of BUCKETS) {
  const e = episodes.filter(x => x.maxE >= MIN && x.ko > lo && x.ko <= hi);
  const lives = e.map(x => x.life);
  console.log(`${name.padEnd(11)} ${String(e.length).padStart(8)}  ${String(med(lives) == null ? '—' : med(lives).toFixed(1)).padStart(11)}  ${pct(lives.filter(l => l >= 5).length, e.length).padStart(6)}  ${pct(lives.filter(l => l >= 15).length, e.length).padStart(7)}  ${pct(lives.filter(l => l >= 60).length, e.length).padStart(7)}  ${pct(e.filter(x => !x.censored).length, e.length).padStart(6)}  ${pct(e.filter(x => x.unmoved).length, e.length).padStart(10)}`);
}
console.log('\nA median life near 0 means most gaps close within one scan interval — scan that range faster; a long one means a slower scan loses little.');
