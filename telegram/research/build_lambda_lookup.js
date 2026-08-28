// telegram/research/build_lambda_lookup.js
//
// Part E5 support script (LIVE_BETTING_PLAN.md) — builds the SCALE fallback
// table `static/data/lambda_lookup.json` consumed by `static/live_model.js`.
//
// ── Why this file exists ────────────────────────────────────────────────
// The pricing engine's scale layer is E1's per-match implied (lambda_h,
// lambda_a) solved from that match's own de-vigged closing Bet365 1X2 + O/U
// prices. When a caller HAS those numbers (a row of
// `telegram/research/reports/implied_lambda_2026-08-28.jsonl`, or a live
// solve from the current feed odds) it should pass them straight to
// `priceMarket()` and this table is not used for the point estimate at all.
//
// This table serves two other jobs:
//
//   1. FALLBACK SCALE — a live match whose 1X2/O-U prices we cannot de-vig
//      (the livescore feed carries AH + O/U but the app's own historical
//      cfg keys are AH line + total line + tier) still needs a
//      (lambda_h, lambda_a). The bucket median is that fallback.
//
//   2. SCALE UNCERTAINTY for the Monte-Carlo confidence intervals — even
//      when the point (lambda_h, lambda_a) is known exactly from the
//      match's own prices, "exactly" only means "exactly what the market
//      said"; the market itself is not the truth. The empirical spread of
//      real solved lambdas inside the same (AH line, TL, tier) cell is a
//      defensible, data-derived stand-in for how far a match's true rates
//      can sit from its bucket-typical value. `priceMarket()` resamples
//      MULTIPLICATIVE ratios (sampled_pair / bucket_median) from this
//      spread and applies them to whatever point lambda it was given, so
//      the match-specific point estimate is preserved and only the spread
//      comes from the bucket.
//
// ── Build process ───────────────────────────────────────────────────────
// Input : telegram/research/reports/implied_lambda_2026-08-28.jsonl
//         (240,491 rows; one per Bet365 CSV row that E1 could fit)
// Key   : line = ah_home_closing rounded to nearest 0.25, CLIPPED to
//                [-4, +4]  (|line| > 4 is ~0.1% of rows and hopelessly
//                sparse per-cell; clipping keeps them in the nearest real
//                bucket rather than creating 30 singleton cells)
//         tl   = tl_closing rounded to nearest 0.5, CLIPPED to [1.5, 5.5]
//                (the raw data contains a handful of 0.5 and 15.0 values
//                that are clearly feed artefacts)
//         tier = TOP | MAJOR | OTHER, taken verbatim from the jsonl (E1
//                stamped it with the same classifyLeague() the rest of the
//                codebase uses).
// Cell  : { n, mh, ma, pairs }
//         mh/ma  = median lambda_h / lambda_a in the cell
//         pairs  = up to PAIRS_PER_CELL (20) JOINT (lambda_h, lambda_a)
//                  observations, taken as an evenly-spaced stride through
//                  the cell's rows sorted by (lambda_h + lambda_a).
//                  Sorting by the total and striding gives a spread that
//                  spans the cell's quantile range (rather than a random
//                  clump), while keeping each pair's own h/a SPLIT intact
//                  — the split is strongly line-determined and resampling
//                  the two marginals independently would manufacture
//                  impossible matches (e.g. a -1.5 line with lambda_h <
//                  lambda_a). Cells with n < MIN_PAIR_N (20) store no
//                  pairs; the lookup then falls back a level for spread.
// Fallback levels, all precomputed into the same file so the runtime never
// has to aggregate:
//         level 0  `${line}|${tl}|${tier}`
//         level 1  `${line}|${tl}|ANY`     (tiers pooled)
//         level 2  `${line}|ANY|ANY`       (TL pooled too)
//         level 3  `GLOBAL`
//
// Numbers are rounded to 3 decimals to keep the file small (a 0.001-goal
// resolution on a ~1.4-goal rate is ~0.07%, far below any real precision
// this table can claim).
//
// Run: node telegram/research/build_lambda_lookup.js

'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const SRC = path.resolve(__dirname, 'reports', 'implied_lambda_2026-08-28.jsonl');
const OUT = path.resolve(__dirname, '..', '..', 'static', 'data', 'lambda_lookup.json');

const LINE_STEP = 0.25;
const LINE_CLIP = 4.0;
const TL_STEP = 0.5;
const TL_MIN = 1.5;
const TL_MAX = 5.5;
const PAIRS_PER_CELL = 20;
const MIN_PAIR_N = 20;
const ROUND = 3;

function r3(x) { return Math.round(x * 10 ** ROUND) / 10 ** ROUND; }

function bucketLine(x) {
  const v = Math.round(x / LINE_STEP) * LINE_STEP;
  return Math.max(-LINE_CLIP, Math.min(LINE_CLIP, v));
}
function bucketTl(x) {
  const v = Math.round(x / TL_STEP) * TL_STEP;
  return Math.max(TL_MIN, Math.min(TL_MAX, v));
}
function median(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

// Evenly-spaced stride through a list, always including first and last.
function strideSample(list, k) {
  if (list.length <= k) return list.slice();
  const out = [];
  for (let i = 0; i < k; i++) {
    out.push(list[Math.round((i * (list.length - 1)) / (k - 1))]);
  }
  return out;
}

function summarise(rows) {
  const sorted = [...rows].sort((a, b) => (a[0] + a[1]) - (b[0] + b[1]));
  const cell = {
    n: rows.length,
    mh: r3(median(rows.map(r => r[0]))),
    ma: r3(median(rows.map(r => r[1]))),
  };
  if (rows.length >= MIN_PAIR_N) {
    cell.pairs = strideSample(sorted, PAIRS_PER_CELL).map(p => [r3(p[0]), r3(p[1])]);
  }
  return cell;
}

async function main() {
  if (!fs.existsSync(SRC)) {
    console.error(`Missing source jsonl: ${SRC}`);
    process.exit(1);
  }
  const t0 = Date.now();

  // level0 key -> [[lh, la], ...]
  const l0 = new Map();
  const l1 = new Map();
  const l2 = new Map();
  const global = [];

  let nLines = 0, nUsed = 0, nSkipped = 0;

  const rl = readline.createInterface({
    input: fs.createReadStream(SRC, { encoding: 'utf8' }),
    crlfDelay: Infinity,
  });

  for await (const line of rl) {
    if (!line.trim()) continue;
    nLines++;
    let j;
    try { j = JSON.parse(line); } catch { nSkipped++; continue; }
    const lh = j.lambda_h, la = j.lambda_a;
    if (!Number.isFinite(lh) || !Number.isFinite(la) || lh <= 0 || la <= 0) { nSkipped++; continue; }
    if (!Number.isFinite(j.ah_home_closing) || !Number.isFinite(j.tl_closing)) { nSkipped++; continue; }
    const tier = j.tier || 'OTHER';
    const L = bucketLine(j.ah_home_closing);
    const T = bucketTl(j.tl_closing);
    const pair = [lh, la];
    nUsed++;

    const k0 = `${L}|${T}|${tier}`;
    const k1 = `${L}|${T}|ANY`;
    const k2 = `${L}|ANY|ANY`;
    if (!l0.has(k0)) l0.set(k0, []);
    if (!l1.has(k1)) l1.set(k1, []);
    if (!l2.has(k2)) l2.set(k2, []);
    l0.get(k0).push(pair);
    l1.get(k1).push(pair);
    l2.get(k2).push(pair);
    global.push(pair);
  }

  const cells = {};
  let nWithPairs = 0, nSparse = 0;
  for (const [k, rows] of l0) {
    cells[k] = summarise(rows);
    if (cells[k].pairs) nWithPairs++; else nSparse++;
  }
  for (const [k, rows] of l1) cells[k] = summarise(rows);
  for (const [k, rows] of l2) cells[k] = summarise(rows);
  cells['GLOBAL'] = summarise(global);

  const out = {
    _doc: 'E5 scale-fallback table. cells key = `${ahLineRounded0.25}|${tlRounded0.5}|${tier}` with '
        + 'progressively pooled fallbacks `L|T|ANY`, `L|ANY|ANY` and `GLOBAL`. Each cell: '
        + 'n = rows, mh/ma = median lambda_h/lambda_a, pairs = up to 20 joint (lambda_h, lambda_a) '
        + 'observations spanning the cell quantile range (used for Monte-Carlo scale resampling; '
        + 'absent when n < 20). See telegram/research/build_lambda_lookup.js for the full build doc.',
    generated_at: new Date().toISOString(),
    source: SRC,
    params: { LINE_STEP, LINE_CLIP, TL_STEP, TL_MIN, TL_MAX, PAIRS_PER_CELL, MIN_PAIR_N, ROUND },
    stats: {
      lines_read: nLines,
      rows_used: nUsed,
      rows_skipped: nSkipped,
      cells_level0: l0.size,
      cells_level0_with_pairs: nWithPairs,
      cells_level0_sparse_no_pairs: nSparse,
      cells_level1: l1.size,
      cells_level2: l2.size,
      cells_total: Object.keys(cells).length,
    },
    cells,
  };

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out));
  const bytes = fs.statSync(OUT).size;

  console.log('── lambda_lookup build ──────────────────────────────');
  console.log(`source rows read      : ${nLines}`);
  console.log(`rows used             : ${nUsed}`);
  console.log(`rows skipped          : ${nSkipped}`);
  console.log(`level-0 cells         : ${l0.size} (${nWithPairs} with MC pairs, ${nSparse} sparse/median-only)`);
  console.log(`level-1 cells (|ANY)  : ${l1.size}`);
  console.log(`level-2 cells (|ANY|ANY): ${l2.size}`);
  console.log(`total cells written   : ${Object.keys(cells).length}`);
  console.log(`output                : ${OUT}`);
  console.log(`size                  : ${bytes} bytes (${(bytes / 1024).toFixed(1)} KB)`);
  console.log(`elapsed               : ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  if (bytes > 500 * 1024) console.warn('WARNING: file exceeds the 500 KB budget from the E5 spec.');
}

main().catch(e => { console.error(e); process.exit(1); });
