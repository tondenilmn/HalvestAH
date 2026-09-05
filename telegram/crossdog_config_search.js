'use strict';
// ── Strategy CROSSDOG — offline cell generation ───────────────────────────────
// Builds telegram/data/crossdog_cells.json: the (fav_line, fav_side, tier)
// cell table notify.js's live CROSSDOG strategy looks up against. See
// crossdog_lib.js for the merge/cell-key logic and config.js's CROSSDOG_*
// block for the full backtest story (backtest_book_disagreement.js).
//
// Re-run this periodically as more months of Bet365+Sbobet data accumulate —
// same maintenance model as focus_config_search.js/focus_configs.json.
//
// Usage: node crossdog_config_search.js [--minn=30]

const lib = require('./crossdog_lib');

const MINN_ARG = (process.argv.find(a => a.startsWith('--minn=')) || '').split('=')[1];
const GATE_MIN_N = MINN_ARG ? parseInt(MINN_ARG, 10) : 30;

function main() {
  console.log('Loading + merging Bet365/Sbobet history...');
  const { pairedRows, b365Count, sboCount, matched, orientationAgree } = lib.loadAndMergeBooks();
  console.log(`  Bet365 rows: ${b365Count}  Sbobet rows: ${sboCount}`);
  console.log(`  Matched: ${matched} (${(matched / b365Count * 100).toFixed(1)}%)  orientation-agreeing: ${orientationAgree}`);

  const cells = lib.computeDownBucketCells(pairedRows, GATE_MIN_N);
  const file = lib.saveCells(cells, {
    minN: GATE_MIN_N,
    sourceRows: { b365Count, sboCount, matched, orientationAgree },
  });

  console.log(`\nWrote ${Object.keys(cells).length} cells (n>=${GATE_MIN_N}) to ${file}`);
  for (const [k, c] of Object.entries(cells).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(24)} n=${String(c.n).padStart(5)}  hit%=${c.hitPct.toFixed(1).padStart(5)}  ciLo=${c.ciLo.toFixed(1).padStart(5)}%  impliedPrice=${(100 / c.ciLo).toFixed(2)}`);
  }
}

main();
