'use strict';
// ── Strategy CROSSDOG shared library ──────────────────────────────────────────
// Backs "Strategy CROSSDOG" in notify.js — see config.js's CROSSDOG_* block for
// the full validation story (backtest_book_disagreement.js). One place for:
//   - loading + exact-merging the Bet365/Sbobet historical CSVs (both scraped
//     from the same source, same Date/Time/League/Home Team/Away Team columns
//     — confirmed 2026-09-05, no fuzzy team-name matching needed, unlike
//     focus_lib's mergeBooks which guards against a messier cross-source join)
//   - the (fav_line, fav_side, tier) cell key both the offline config search
//     (crossdog_config_search.js) and the live strategy (notify.js) use —
//     kept in exactly one place so a live match's cell key is built by the
//     identical function that built the historical cellKeys in
//     crossdog_cells.json
//   - loading/saving telegram/data/crossdog_cells.json
//
// Run `node crossdog_lib.js --selftest` for a smoke test.

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const { processRow, classifyLeague, wilsonCI } = require('./engine');

const DATA_DIR = path.resolve(__dirname, '../static/data');
const OUT_DIR = path.join(__dirname, 'data');
const CELLS_FILE = 'crossdog_cells.json';

// Same disagreement-direction tolerance engine.js uses for fav_line matching.
const LINE_DELTA_THRESH = 0.13;

function monthOf(dateStr) {
  const m = /^(\d{4})-(\d{2})/.exec(String(dateStr || ''));
  return m ? `${m[1]}-${m[2]}` : null;
}

function loadBook(book) {
  const dir = path.join(DATA_DIR, book);
  if (!fs.existsSync(dir)) return [];
  const rows = [];
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.toLowerCase().endsWith('.csv')) continue;
    const csv = fs.readFileSync(path.join(dir, f), 'utf8');
    const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true });
    const label = path.basename(f, '.csv');
    for (const row of data) {
      const p = processRow(row, label);
      if (!p) continue;
      p.month = monthOf(p.date);
      rows.push(p);
    }
  }
  return rows;
}

// Both CSV sets are scraped from the same underlying source — identical
// Date/Time/League/Home Team/Away Team columns — so an exact key is enough;
// no fuzzy normalization (unlike focus_lib.normTeam, built for a messier
// cross-source join) is needed or wanted here.
function matchKey(r) {
  return `${r.date}|${r.home_team}|${r.away_team}`;
}

function tierBucket(tier) { return tier === 'OTHER' ? 'OTHER' : 'TOP_MAJOR'; }

// Shared cell key — MUST stay identical between crossdog_config_search.js
// (which builds crossdog_cells.json) and notify.js's live lookup, the same
// way focus_lib.compositeKey is shared between focus_config_search.js and
// the live FOCUS strategy.
function cellKey(favLine, favSide, tier) {
  return `${favLine}|${favSide}|${tierBucket(tier)}`;
}

// Merges Bet365 rows with Sbobet rows by exact (date, home, away), keeping
// only pairs where both books agree on which side is the favourite (fav_side
// must match) — otherwise fav_line isn't comparable between the two. Returns
// Bet365 rows augmented with `lineDeltaBucket` ('UP'/'DOWN'/'SAME') where
// DOWN = Sbobet's fav_line is LOWER than Bet365's (Sbobet leans more toward
// the underdog) — the bucket backtest_book_disagreement.js found a real,
// walk-forward-consistent +10-16% ROI backing the dog at Bet365's own price.
function loadAndMergeBooks() {
  const b365 = loadBook('Bet365');
  const sbo = loadBook('Sbobet');
  const sboMap = new Map();
  for (const r of sbo) sboMap.set(matchKey(r), r);

  const pairedRows = [];
  let matched = 0, orientationAgree = 0;
  for (const r of b365) {
    const s = sboMap.get(matchKey(r));
    if (!s) continue;
    matched++;
    if (r.fav_side !== s.fav_side) continue;
    orientationAgree++;
    const lineDelta = s.fav_line - r.fav_line;
    const bucket = lineDelta <= -LINE_DELTA_THRESH ? 'DOWN' : lineDelta >= LINE_DELTA_THRESH ? 'UP' : 'SAME';
    pairedRows.push({ ...r, lineDeltaBucket: bucket });
  }
  return { pairedRows, b365Count: b365.length, sboCount: sbo.length, matched, orientationAgree };
}

// Builds the DOWN-bucket dogCover cell table: n/hits/Wilson-CI-lower hit rate
// per (fav_line, fav_side, tier) cell, using ALL available merged history (not
// walk-forward split — this is the production table, refreshed periodically
// as more months accumulate, same maintenance model as focus_configs.json).
function computeDownBucketCells(pairedRows, minN = 30) {
  const rows = pairedRows.filter(r => r.lineDeltaBucket === 'DOWN' && r.dogCover != null && r.dog_oc != null);
  const byCell = new Map();
  for (const r of rows) {
    const k = cellKey(r.fav_line, r.fav_side, r.league_tier);
    if (!byCell.has(k)) byCell.set(k, { n: 0, hits: 0 });
    const c = byCell.get(k);
    c.n++; if (r.dogCover) c.hits++;
  }
  const cells = {};
  for (const [k, c] of byCell) {
    if (c.n < minN) continue;
    const [ciLo, ciHi] = wilsonCI(c.hits / c.n * 100, c.n);
    cells[k] = { n: c.n, hits: c.hits, hitPct: c.hits / c.n * 100, ciLo, ciHi };
  }
  return cells;
}

function loadCells() {
  const file = path.join(OUT_DIR, CELLS_FILE);
  if (!fs.existsSync(file)) return { cells: {}, generatedAt: null };
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function saveCells(cells, meta) {
  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const file = path.join(OUT_DIR, CELLS_FILE);
  fs.writeFileSync(file, JSON.stringify({ generatedAt: new Date().toISOString(), ...meta, cells }, null, 2));
  return file;
}

module.exports = {
  LINE_DELTA_THRESH,
  loadBook, matchKey, tierBucket, cellKey,
  loadAndMergeBooks, computeDownBucketCells,
  loadCells, saveCells, CELLS_FILE, OUT_DIR,
};

// ── Self-test ──────────────────────────────────────────────────────────────
if (require.main === module && process.argv.includes('--selftest')) {
  const { pairedRows, b365Count, sboCount, matched, orientationAgree } = loadAndMergeBooks();
  console.log(`Bet365 rows: ${b365Count}`);
  console.log(`Sbobet rows: ${sboCount}`);
  console.log(`Matched: ${matched} (${(matched / b365Count * 100).toFixed(1)}%)  orientation-agreeing: ${orientationAgree}`);
  const down = pairedRows.filter(r => r.lineDeltaBucket === 'DOWN').length;
  const up = pairedRows.filter(r => r.lineDeltaBucket === 'UP').length;
  console.log(`DOWN bucket: ${down}   UP bucket: ${up}`);
  const cells = computeDownBucketCells(pairedRows, 30);
  console.log(`\nCells (n>=30):`);
  for (const [k, c] of Object.entries(cells).sort((a, b) => b[1].n - a[1].n)) {
    console.log(`  ${k.padEnd(24)} n=${String(c.n).padStart(5)}  hit%=${c.hitPct.toFixed(1).padStart(5)}  ciLo=${c.ciLo.toFixed(1).padStart(5)}%  impliedPrice=${(100 / c.ciLo).toFixed(2)}`);
  }
}
