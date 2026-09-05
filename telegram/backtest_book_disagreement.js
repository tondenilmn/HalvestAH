'use strict';
// ── Book-disagreement backtest (Bet365 vs Sbobet) ─────────────────────────────
// Both CSV sets come from the same underlying scrape source (identical Date/
// Time/League/Home Team/Away Team columns, no fuzzy matching needed — user
// confirmed 2026-09-05), so this joins on an exact key rather than
// focus_lib's fuzzy normTeam() fallback.
//
// Question: within a Bet365-conditioned historical cell (fav_line, fav_side,
// closing-TL band, league tier) — the same bucketing L123/openingOddsSignal
// use — does Sbobet's closing line/TL disagreeing with Bet365's tell you
// anything ABOVE what Bet365's own cell rate already implies? If yes, that's
// a usable live signal (compare live Bet365 vs Sbobet prices); if the
// direction isn't walk-forward consistent, it's noise.
//
// Two disagreement dimensions, each mapped to the bet families it's
// plausibly informative for:
//   - lineDelta = sbo.fav_line - b365.fav_line  → AH-cover / match-dominance
//     bets (ahCover, dogCover, *WinsFT, *Wins2H/1H, *Scored2H/1H, favWins*)
//   - tlDelta   = sbo.tl_c - b365.tl_c          → total-goals bets
//     (overTL/underTL, over*/under* half & FT, btts, noBtts, draw*)
//
// Walk-forward: last WF_MONTHS months, train = strictly-earlier months only.
// A bet only gets a verdict if both UP and DOWN buckets clear MIN_N in a
// majority of comparable months — anything thinner is reported but flagged
// insufficient, not verdicted, matching focus_crossbook.js's discipline.
//
// Usage: node backtest_book_disagreement.js [--months=8] [--minn=20]

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const {
  processRow, BETS, wilsonCI,
} = require('./engine');
const { normTeam, walkForward } = require('./focus_lib');

const MONTHS_ARG = (process.argv.find(a => a.startsWith('--months=')) || '').split('=')[1];
const WF_MONTHS = MONTHS_ARG ? parseInt(MONTHS_ARG, 10) : 8;
const MINN_ARG = (process.argv.find(a => a.startsWith('--minn=')) || '').split('=')[1];
const MIN_N = MINN_ARG ? parseInt(MINN_ARG, 10) : 20;
const DELTA_THRESH = 0.13; // same tolerance engine.js uses for fav_line/tl_c matching

const DATA_DIR = path.resolve(__dirname, '../static/data');

// ── Loading (static/data, NOT the stale CrossBooks copy) ───────────────────
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

function matchKey(r) {
  return `${r.date}|${normTeam(r.home_team)}|${normTeam(r.away_team)}`;
}

function tierBucket(tier) { return tier === 'OTHER' ? 'OTHER' : 'TOP_MAJOR'; }
// TL-delta bets condition on Bet365's own EXACT closing TL (quarter-goal
// quantized — see backtest_book_disagreement notes), not the coarse 4-band
// TL_CLUSTERS: conditioning on the coarse band would let "sbo TL higher than
// b365 TL" partly just re-detect where b365's own line sits within that wide
// band, information already visible without Sbobet at all. Exact-TL
// conditioning isolates the genuinely-Sbobet-only signal. lineDelta bets
// don't have this problem — fav_line is already an exact quoted value.
function cellKey(r) {
  return `${r.fav_line}|${r.fav_side}|${r.tl_c}|${tierBucket(r.league_tier)}`;
}

function deltaBucket(d) {
  if (d == null || isNaN(d)) return null;
  if (d >= DELTA_THRESH) return 'UP';
  if (d <= -DELTA_THRESH) return 'DOWN';
  return 'SAME';
}

// Which delta dimension is informative for which bet family.
const TOTALS_RE = /^(over|under|btts|noBtts|draw)/;
function deltaDimFor(betKey) {
  return TOTALS_RE.test(betKey) ? 'tlDelta' : 'lineDelta';
}

function main() {
  console.log('Loading Bet365...');
  const b365 = loadBook('Bet365');
  console.log(`  ${b365.length} rows`);
  console.log('Loading Sbobet...');
  const sbo = loadBook('Sbobet');
  console.log(`  ${sbo.length} rows`);

  const sboMap = new Map();
  for (const r of sbo) sboMap.set(matchKey(r), r);

  let matched = 0;
  let orientationAgree = 0;
  const pairedRows = [];
  for (const r of b365) {
    const s = sboMap.get(matchKey(r));
    if (!s) continue;
    matched++;
    if (r.fav_side !== s.fav_side) continue; // can't compare fav_line meaningfully
    orientationAgree++;
    const lineDelta = s.fav_line - r.fav_line;
    const tlDelta = (r.tl_c != null && s.tl_c != null) ? s.tl_c - r.tl_c : null;
    pairedRows.push({
      ...r,
      lineDeltaBucket: deltaBucket(lineDelta),
      tlDeltaBucket: deltaBucket(tlDelta),
      cell: cellKey(r),
    });
  }
  console.log(`\nMatched pairs: ${matched} / ${b365.length} (${(matched / b365.length * 100).toFixed(1)}%)`);
  console.log(`Fav-side-agreeing pairs (usable): ${orientationAgree} (${(orientationAgree / matched * 100).toFixed(1)}% of matched)`);

  const results = [];
  for (const bet of BETS) {
    const key = bet.k;
    const dim = deltaDimFor(key);
    const rows = pairedRows.filter(r => r[dim + 'Bucket'] != null && r[key] !== undefined && r[key] !== null);
    if (!rows.length) continue;

    const perMonth = walkForward(rows, (trainRows, testRows) => {
      // cell baseline from train rows only
      const trainByCell = new Map();
      for (const r of trainRows) {
        if (!trainByCell.has(r.cell)) trainByCell.set(r.cell, { hits: 0, n: 0 });
        const c = trainByCell.get(r.cell);
        c.n++; if (r[key]) c.hits++;
      }
      const baselineOf = (cell) => {
        const c = trainByCell.get(cell);
        return c && c.n >= 10 ? c.hits / c.n : null;
      };

      const up = { hits: 0, n: 0, edgeSum: 0, edgeN: 0 };
      const down = { hits: 0, n: 0, edgeSum: 0, edgeN: 0 };
      for (const r of testRows) {
        const bucket = r[dim + 'Bucket'];
        if (bucket !== 'UP' && bucket !== 'DOWN') continue;
        const bl = baselineOf(r.cell);
        const target = bucket === 'UP' ? up : down;
        target.n++;
        if (r[key]) target.hits++;
        if (bl != null) { target.edgeSum += ((r[key] ? 1 : 0) - bl); target.edgeN++; }
      }
      return { up, down };
    }, WF_MONTHS);

    // Ranking/consistency is decided on the CELL-BASELINE-ADJUSTED edge
    // (edgeSum/edgeN), NOT the raw up.hits/up.n rate — the raw rate is
    // pooled across every (fav_line, fav_side, tl_c, tier) cell a bucket
    // happens to contain, so it mostly just reflects which cells disagree
    // in which direction (e.g. UP-tlDelta rows skew toward matches that
    // were always going to have more goals), not any real incremental
    // information from Sbobet. The edge fields subtract each row's own
    // cell's train-only baseline first, which is the actual test of
    // "does disagreement add anything beyond what Bet365's own price says."
    let monthsCompared = 0, upBetterMonths = 0, downBetterMonths = 0;
    let upN = 0, upHits = 0, upEdgeSum = 0, upEdgeN = 0;
    let downN = 0, downHits = 0, downEdgeSum = 0, downEdgeN = 0;
    for (const { result } of perMonth) {
      const { up, down } = result;
      if (up.edgeN < MIN_N || down.edgeN < MIN_N) continue;
      monthsCompared++;
      const upEdgeRate = up.edgeSum / up.edgeN, downEdgeRate = down.edgeSum / down.edgeN;
      if (upEdgeRate > downEdgeRate) upBetterMonths++; else downBetterMonths++;
      upN += up.n; upHits += up.hits; upEdgeSum += up.edgeSum; upEdgeN += up.edgeN;
      downN += down.n; downHits += down.hits; downEdgeSum += down.edgeSum; downEdgeN += down.edgeN;
    }
    if (!monthsCompared) continue;

    const upPct = upN ? upHits / upN * 100 : null;
    const downPct = downN ? downHits / downN * 100 : null;
    const upEdgePp = upEdgeN ? upEdgeSum / upEdgeN * 100 : null;
    const downEdgePp = downEdgeN ? downEdgeSum / downEdgeN * 100 : null;
    const consistency = Math.max(upBetterMonths, downBetterMonths) / monthsCompared;
    const direction = upBetterMonths >= downBetterMonths ? 'UP' : 'DOWN';
    const wilsonUp = upN ? wilsonCI(upHits / upN * 100, upN) : null;
    const wilsonDown = downN ? wilsonCI(downHits / downN * 100, downN) : null;

    results.push({
      key, dim, monthsCompared, upBetterMonths, downBetterMonths, consistency, direction,
      upN, upPct, upEdgePp, upEdgeN, upLo: wilsonUp ? wilsonUp[0] : null,
      downN, downPct, downEdgePp, downEdgeN, downLo: wilsonDown ? wilsonDown[0] : null,
      deltaPct: (upPct != null && downPct != null) ? upPct - downPct : null,
      edgeDeltaPp: (upEdgePp != null && downEdgePp != null) ? upEdgePp - downEdgePp : null,
    });
  }

  // ── ROI at real Bet365 market price, for bets with a direct 1:1 odds
  // column (marketOddsKey) — the actual test of whether the disagreement
  // signal is bettable, not just a hit-rate-vs-baseline curiosity. Same
  // cell/bucket/walk-forward shape as above, but instead of comparing to a
  // historical baseline rate we compare to "would this bet have made money
  // at the price actually on offer."
  const roiResults = [];
  for (const bet of BETS) {
    if (!bet.marketOddsKey) continue;
    const key = bet.k;
    const dim = deltaDimFor(key);
    const rows = pairedRows.filter(r => r[dim + 'Bucket'] != null && r[key] !== undefined && r[key] !== null && r[bet.marketOddsKey] != null);
    if (!rows.length) continue;

    const perMonth = walkForward(rows, (trainRows, testRows) => {
      const up = { n: 0, profit: 0 };
      const down = { n: 0, profit: 0 };
      for (const r of testRows) {
        const bucket = r[dim + 'Bucket'];
        if (bucket !== 'UP' && bucket !== 'DOWN') continue;
        const odds = r[bet.marketOddsKey];
        if (!odds || odds <= 1) continue;
        const target = bucket === 'UP' ? up : down;
        target.n++;
        target.profit += r[key] ? (odds - 1) : -1;
      }
      return { up, down };
    }, WF_MONTHS);

    let monthsCompared = 0, upBetterMonths = 0, downBetterMonths = 0;
    let upN = 0, upProfit = 0, downN = 0, downProfit = 0;
    for (const { result } of perMonth) {
      const { up, down } = result;
      if (up.n < MIN_N || down.n < MIN_N) continue;
      monthsCompared++;
      const upRoi = up.profit / up.n, downRoi = down.profit / down.n;
      if (upRoi > downRoi) upBetterMonths++; else downBetterMonths++;
      upN += up.n; upProfit += up.profit; downN += down.n; downProfit += down.profit;
    }
    if (!monthsCompared) continue;

    if (process.argv.includes('--debug-months') && key === process.env.DEBUG_KEY) {
      console.log(`\n[debug] ${key} per-month breakdown:`);
      for (const { month, result } of perMonth) {
        const { up, down } = result;
        console.log(`  ${month}: UP n=${up.n} roi=${up.n ? (up.profit / up.n * 100).toFixed(1) : 'n/a'}%  DOWN n=${down.n} roi=${down.n ? (down.profit / down.n * 100).toFixed(1) : 'n/a'}%`);
      }
    }

    const upRoiPct = upN ? upProfit / upN * 100 : null;
    const downRoiPct = downN ? downProfit / downN * 100 : null;
    roiResults.push({
      key, dim, monthsCompared, upBetterMonths, downBetterMonths,
      consistency: Math.max(upBetterMonths, downBetterMonths) / monthsCompared,
      upN, upRoiPct, downN, downRoiPct,
      roiDelta: (upRoiPct != null && downRoiPct != null) ? upRoiPct - downRoiPct : null,
    });
  }

  console.log(`\n═══ ROI at real Bet365 closing price, by disagreement bucket (walk-forward, MIN_N=${MIN_N}) ═══`);
  console.log('(only bets with a direct 1:1 market odds column — ahCover/dogCover/overTL/underTL/*WinsFT/drawFT; ROI%/bet, not annualized)\n');
  console.log(`${'Bet'.padEnd(14)} ${'dim'.padEnd(9)} ${'mo/cmp'.padStart(6)} ${'consist'.padStart(7)} ${'UP n'.padStart(6)} ${'UP ROI%'.padStart(8)} ${'DOWN n'.padStart(7)} ${'DOWN ROI%'.padStart(9)} ${'ΔROI%'.padStart(7)}`);
  for (const r of roiResults.sort((a, b) => Math.abs(b.roiDelta || 0) - Math.abs(a.roiDelta || 0))) {
    console.log(
      `${r.key.padEnd(14)} ${r.dim.padEnd(9)} ${(r.upBetterMonths + '/' + r.monthsCompared).padStart(6)} ` +
      `${(r.consistency * 100).toFixed(0).padStart(6)}% ${String(r.upN).padStart(6)} ${fmtRoi(r.upRoiPct).padStart(8)} ` +
      `${String(r.downN).padStart(7)} ${fmtRoi(r.downRoiPct).padStart(9)} ${fmtRoi(r.roiDelta).padStart(7)}`
    );
  }
  function fmtRoi(v) { return v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(1); }

  results.sort((a, b) => Math.abs(b.edgeDeltaPp || 0) - Math.abs(a.edgeDeltaPp || 0));

  console.log(`\n═══ Book disagreement vs. Bet365-cell baseline (walk-forward, last ${WF_MONTHS} months, MIN_N=${MIN_N}) ═══`);
  console.log(`(edge = hit% minus that row's own train-only cell baseline; this is the number that isolates Sbobet's incremental information — raw%/rawDelta shown for context only)\n`);
  const verdictRows = results.filter(r => r.monthsCompared >= Math.ceil(WF_MONTHS * 0.75));
  const thin = results.filter(r => r.monthsCompared < Math.ceil(WF_MONTHS * 0.75));

  console.log(`${'Bet'.padEnd(16)} ${'dim'.padEnd(9)} ${'mo/cmp'.padStart(6)} ${'consist'.padStart(7)} ${'UP n'.padStart(6)} ${'UP%'.padStart(6)} ${'UPedge'.padStart(7)} ${'DOWN n'.padStart(7)} ${'DOWN%'.padStart(6)} ${'DNedge'.padStart(7)} ${'edgeΔ'.padStart(7)} ${'rawΔ%'.padStart(7)}`);
  for (const r of verdictRows) {
    console.log(
      `${r.key.padEnd(16)} ${r.dim.padEnd(9)} ${(r.upBetterMonths + '/' + r.monthsCompared).padStart(6)} ` +
      `${(r.consistency * 100).toFixed(0).padStart(6)}% ${String(r.upN).padStart(6)} ${fmtPct(r.upPct).padStart(6)} ${fmtPp(r.upEdgePp).padStart(7)} ` +
      `${String(r.downN).padStart(7)} ${fmtPct(r.downPct).padStart(6)} ${fmtPp(r.downEdgePp).padStart(7)} ${fmtPp(r.edgeDeltaPp).padStart(7)} ${fmtPp(r.deltaPct).padStart(7)}`
    );
  }
  function fmtPct(v) { return v == null ? 'n/a' : v.toFixed(1); }
  function fmtPp(v) { return v == null ? 'n/a' : (v >= 0 ? '+' : '') + v.toFixed(1); }

  console.log(`\n(${thin.length} bets skipped — fewer than ${Math.ceil(WF_MONTHS * 0.75)}/${WF_MONTHS} comparable months at MIN_N=${MIN_N})`);

  const strong = verdictRows.filter(r => r.consistency >= 0.75 && Math.abs(r.edgeDeltaPp) >= 2);
  console.log(`\n═══ Candidates worth a closer look (consistency >=75%, |cell-adjusted edge delta| >=2pp) ═══`);
  if (!strong.length) console.log('  none survived at these thresholds.');
  for (const r of strong) {
    console.log(`  ${r.key} (${r.dim}): direction=${r.direction} favors higher cell-adjusted edge, ${(r.consistency * 100).toFixed(0)}% of ${r.monthsCompared} months, edgeDelta=${fmtPp(r.edgeDeltaPp)}pp (raw pooled-rate delta=${fmtPp(r.deltaPct)}pp, context only — NOT cell-adjusted; UP/DOWN raw-rate CI-lo=${fmtPct(r.upLo)}%/${fmtPct(r.downLo)}%, also raw not edge-adjusted)`);
  }

  dogCoverDeepDive(pairedRows);
}

// ── Deep dive on the dogCover/DOWN finding ──────────────────────────────────
// (2) Concentration check: is the +10-16pp ROI uniform, or driven by one
//     fav_line/tier/side slice? A backtest-wide number that's secretly all
//     from OTHER-tier obscure leagues would repeat this codebase's own
//     documented trap (see CLAUDE.md "Legacy Strategies" — low-n obscure-
//     league cells look great in aggregate backtest, fail OOS).
// (3) A real qualifying gate: instead of pooled mean ROI, walk-forward
//     compute each (fav_line, fav_side, tier) cell's DOWN-bucket dog-cover
//     hit-rate from TRAIN rows only, take its Wilson CI LOWER bound (same
//     discipline L123/LIVEWATCH use for mo_lo), and only count a bet as
//     "qualifying" if that conservative implied price is still below the
//     real dog_oc price on offer — i.e. would this actually have cleared a
//     real staking bar, not just beaten a raw mean.
function dogCoverDeepDive(pairedRows) {
  const rows = pairedRows.filter(r => r.lineDeltaBucket === 'DOWN' && r.dogCover != null && r.dog_oc != null);

  console.log(`\n═══ dogCover / DOWN-bucket deep dive (n=${rows.length}) ═══`);

  // (2) Concentration — group by fav_line, fav_side, tier.
  console.log('\n-- by fav_line --');
  const byLine = new Map();
  for (const r of rows) {
    const k = r.fav_line;
    if (!byLine.has(k)) byLine.set(k, { n: 0, hits: 0, profit: 0 });
    const g = byLine.get(k);
    g.n++; if (r.dogCover) g.hits++;
    g.profit += r.dogCover ? (r.dog_oc - 1) : -1;
  }
  console.log(`  ${'fav_line'.padEnd(10)} ${'n'.padStart(6)} ${'hit%'.padStart(6)} ${'ROI%'.padStart(7)}`);
  for (const [k, g] of [...byLine.entries()].sort((a, b) => a[0] - b[0])) {
    console.log(`  ${String(k).padEnd(10)} ${String(g.n).padStart(6)} ${(g.hits / g.n * 100).toFixed(1).padStart(6)} ${(g.profit / g.n * 100).toFixed(1).padStart(7)}`);
  }

  console.log('\n-- by fav_side --');
  for (const side of ['HOME', 'AWAY']) {
    const g = rows.filter(r => r.fav_side === side);
    const hits = g.filter(r => r.dogCover).length;
    const profit = g.reduce((s, r) => s + (r.dogCover ? r.dog_oc - 1 : -1), 0);
    console.log(`  ${side.padEnd(6)} n=${g.length}  hit%=${g.length ? (hits / g.length * 100).toFixed(1) : 'n/a'}  ROI%=${g.length ? (profit / g.length * 100).toFixed(1) : 'n/a'}`);
  }

  console.log('\n-- by league tier --');
  for (const tier of ['TOP', 'MAJOR', 'OTHER']) {
    const g = rows.filter(r => r.league_tier === tier);
    const hits = g.filter(r => r.dogCover).length;
    const profit = g.reduce((s, r) => s + (r.dogCover ? r.dog_oc - 1 : -1), 0);
    console.log(`  ${tier.padEnd(6)} n=${g.length}  hit%=${g.length ? (hits / g.length * 100).toFixed(1) : 'n/a'}  ROI%=${g.length ? (profit / g.length * 100).toFixed(1) : 'n/a'}`);
  }

  // (3) Real qualifying-gate walk-forward test.
  const GATE_MIN_N = 30;
  const perMonth = walkForward(rows, (trainRows, testRows) => {
    const trainByCell = new Map();
    for (const r of trainRows) {
      const k = `${r.fav_line}|${r.fav_side}|${tierBucket(r.league_tier)}`;
      if (!trainByCell.has(k)) trainByCell.set(k, { n: 0, hits: 0 });
      const c = trainByCell.get(k);
      c.n++; if (r.dogCover) c.hits++;
    }
    let qualN = 0, qualProfit = 0, skipN = 0, skipProfit = 0;
    for (const r of testRows) {
      const k = `${r.fav_line}|${r.fav_side}|${tierBucket(r.league_tier)}`;
      const c = trainByCell.get(k);
      const profit = r.dogCover ? (r.dog_oc - 1) : -1;
      if (c && c.n >= GATE_MIN_N) {
        const [ciLo] = wilsonCI(c.hits / c.n * 100, c.n);
        const ciLoImpliedPrice = ciLo > 0 ? 100 / ciLo : Infinity;
        if (ciLoImpliedPrice < r.dog_oc) { qualN++; qualProfit += profit; continue; }
      }
      skipN++; skipProfit += profit;
    }
    return { qualN, qualProfit, skipN, skipProfit };
  }, WF_MONTHS);

  console.log(`\n-- (3) Walk-forward qualifying gate (train-only Wilson CI-lower implied price < real dog_oc, GATE_MIN_N=${GATE_MIN_N}) --`);
  console.log(`  ${'month'.padEnd(9)} ${'qual n'.padStart(7)} ${'qual ROI%'.padStart(10)} ${'skip n'.padStart(7)} ${'skip ROI%'.padStart(10)}`);
  let totalQualN = 0, totalQualProfit = 0, totalSkipN = 0, totalSkipProfit = 0;
  let positiveMonths = 0, comparableMonths = 0;
  for (const { month, result } of perMonth) {
    const { qualN, qualProfit, skipN, skipProfit } = result;
    const qualRoi = qualN ? (qualProfit / qualN * 100) : null;
    const skipRoi = skipN ? (skipProfit / skipN * 100) : null;
    console.log(`  ${month.padEnd(9)} ${String(qualN).padStart(7)} ${(qualRoi == null ? 'n/a' : qualRoi.toFixed(1)).padStart(10)} ${String(skipN).padStart(7)} ${(skipRoi == null ? 'n/a' : skipRoi.toFixed(1)).padStart(10)}`);
    totalQualN += qualN; totalQualProfit += qualProfit;
    totalSkipN += skipN; totalSkipProfit += skipProfit;
    if (qualN >= 10) { comparableMonths++; if (qualRoi > 0) positiveMonths++; }
  }
  console.log(`\n  Pooled qualifying-gate ROI: ${totalQualN ? (totalQualProfit / totalQualN * 100).toFixed(1) : 'n/a'}% over ${totalQualN} bets (coverage: ${(totalQualN / rows.length * 100).toFixed(1)}% of DOWN-bucket dog-cover opportunities)`);
  console.log(`  Pooled non-qualifying ROI: ${totalSkipN ? (totalSkipProfit / totalSkipN * 100).toFixed(1) : 'n/a'}% over ${totalSkipN} bets`);
  console.log(`  Positive months: ${positiveMonths}/${comparableMonths} (months with >=10 qualifying bets)`);
}

main();

