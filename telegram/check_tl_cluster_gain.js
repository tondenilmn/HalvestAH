'use strict';
// Quantifies the actual pool-size gain from switching Live Games' TL filter
// from exact tl_c (±0.13) to TL_CLUSTERS band membership.
const path = require('path');
const { loadDatasetDir } = require('./engine');

const BET365_DIR = path.resolve(__dirname, '../static/data/Bet365');
const db = loadDatasetDir(BET365_DIR).filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');

const TL_CLUSTERS = {
  '<2': [null, 2.0], '2-2.5': [2.0, 2.5], '2.5-3': [2.5, 3.0], '>3': [3.0, null],
};

function inBand(v, band) {
  const [lo, hi] = band;
  return (lo == null || v >= lo) && (hi == null || v < hi);
}

// A handful of representative (fav_line, fav_side, tl_c) combos, spanning
// common and less-common favourite lines.
const samples = [
  { favLine: 0.25, favSide: 'HOME', tlC: 2.6 },
  { favLine: 0.5, favSide: 'HOME', tlC: 2.4 },
  { favLine: 0.75, favSide: 'AWAY', tlC: 2.75 },
  { favLine: 1.0, favSide: 'HOME', tlC: 1.8 },
  { favLine: 1.25, favSide: 'HOME', tlC: 3.2 },
  { favLine: 1.5, favSide: 'AWAY', tlC: 2.9 },
];

console.log(`Historical pool (TOP+MAJOR): ${db.length} rows\n`);
console.log('fav_line | fav_side | tl_c  | exact ±0.13 n | cluster n | gain');
console.log('-'.repeat(70));
for (const { favLine, favSide, tlC } of samples) {
  const base = db.filter(r => Math.abs(r.fav_line - favLine) < 0.13 && r.fav_side === favSide);
  const exactN = base.filter(r => r.tl_c != null && Math.abs(r.tl_c - tlC) < 0.13).length;
  const band = Object.values(TL_CLUSTERS).find(b => inBand(tlC, b));
  const clusterN = base.filter(r => r.tl_c != null && inBand(r.tl_c, band)).length;
  const gain = exactN > 0 ? ((clusterN / exactN - 1) * 100).toFixed(0) : 'n/a';
  console.log(`${favLine.toFixed(2).padEnd(8)} | ${favSide.padEnd(8)} | ${tlC.toFixed(2)}  | ${String(exactN).padEnd(13)} | ${String(clusterN).padEnd(9)} | ${gain === 'n/a' ? 'n/a' : '+' + gain + '%'}`);
}
