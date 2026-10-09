'use strict';
/**
 * Builds telegram/blind_baseline.json — what betting EVERY side blind at
 * Bet365's closing price returned, by market and price band, on the Bet365
 * dataset (static/data/Bet365, ~250k matches). The reports (blind.js) compare
 * a strategy's ROI with this, bet by bet at the same market and price: picks
 * at 3.50 losing 4% beat the market by ~8 points, picks at 1.30 losing 4% are
 * worse than blind. The margin sits mostly on long prices (the favourite–
 * longshot bias — Pinnacle's own outcome tables show the same, smaller).
 * Railway builds telegram/ alone, so the table is committed, not built there.
 *
 *   node build_blind_baseline.js [--data ../static/data/Bet365]
 */
const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const { BANDS, bandOf } = require('./blind');

const arg = (n, d) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : d; };
const dir = path.resolve(__dirname, arg('--data', '../static/data/Bet365'));
const num = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };
const part = (x, q) => (x > 1e-9 ? q : x < -1e-9 ? 0 : 1);
const settle = (margin, line, q) => (Math.abs(Math.abs(line * 4) % 2 - 1) < 1e-6
  ? (part(margin + line - 0.25, q) + part(margin + line + 0.25, q)) / 2 : part(margin + line, q));

const acc = {};
const add = (key, price, ret) => {
  const b = bandOf(price); if (b < 0) return;
  const k = `${key}|${b}`; const s = acc[k] || (acc[k] = { n: 0, pl: 0, mo: new Map() });
  s.n++; s.pl += ret - 1;
};
let matches = 0;
for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.csv')).sort()) {
  for (const r of Papa.parse(fs.readFileSync(path.join(dir, f), 'utf8'), { header: true, skipEmptyLines: true }).data) {
    const m = String(r['FT Result'] || '').match(/^(\d+)-(\d+)$/); if (!m) continue;
    const h = +m[1], a = +m[2]; matches++;
    const ah = num(r['Home AH Closing']), ho = num(r['Home Odds Closing']), ao = num(r['Away Odds Closing']);
    if (ah != null && ho > 1 && ao > 1) { add('AH', ho, settle(h - a, ah, ho)); add('AH', ao, settle(a - h, -ah, ao)); }
    const tl = num(r['Total Line Closing']), ov = num(r['Over Odds Closing']), un = num(r['Under Odds Closing']);
    if (tl != null && ov > 1 && un > 1) { add('OU', ov, settle(h + a, -tl, ov)); add('OU', un, settle(-(h + a), tl, un)); }
    const x = [num(r['1X2 Home Closing']), num(r['1X2 Draw Closing']), num(r['1X2 Away Closing'])];
    if (x.every(v => v > 1)) {
      const res = h > a ? 0 : h === a ? 1 : 2;
      ['home', 'draw', 'away'].forEach((side, i) => add(`1X2|${side}`, x[i], res === i ? x[i] : 0));
    }
  }
}
const table = { built: new Date().toISOString().slice(0, 10), source: 'Bet365 closing prices', matches, bands: BANDS, cells: {} };
for (const [k, s] of Object.entries(acc)) table.cells[k] = { n: s.n, roi: +(s.pl / s.n).toFixed(4) };
fs.writeFileSync(path.join(__dirname, 'blind_baseline.json'), JSON.stringify(table, null, 1) + '\n');
console.log(`${matches} matches → ${Object.keys(table.cells).length} cells`);
for (const key of ['AH', 'OU', '1X2|home', '1X2|draw', '1X2|away'])
  console.log(key.padEnd(9), BANDS.map((b, i) => { const c = table.cells[`${key}|${i}`]; return c ? `${b[0]}-${b[1] === Infinity ? '' : b[1]} ${(c.roi * 100).toFixed(1)}% (${c.n})` : null; }).filter(Boolean).join(' · '));
