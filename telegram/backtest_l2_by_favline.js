'use strict';
// Segments the L2 (movement) standalone signal (see
// backtest_l2_standalone_pricing.js) by favourite strength (AH closing
// line magnitude) — does movement carry the same (lack of) real-market edge
// on a weak favourite (e.g. -0.25, near-toss-up) as on a strong favourite
// (e.g. -1.50)? Pools multiple held-out months together (walk-forward per
// month — each month's own file excluded from its own historical pool) so
// each favLine bucket has a usable sample size.
//
// Usage: node backtest_l2_by_favline.js [comma-separated test labels] [tier]
//   e.g. node backtest_l2_by_favline.js Bet365_05_26,Bet365_11_25,Bet365_02_26,Bet365_08_25 TOP+MAJOR

const fs = require('fs');
const path = require('path');
const {
  loadDatasetDir, applyConfig, applyBaselineConfig, mergeCrossFit,
  pct, zScore, wilsonCI, minOdds, BETS,
} = require('./engine');

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');
const TEST_LABELS = (process.argv[2] || 'Bet365_05_26,Bet365_11_25,Bet365_02_26,Bet365_08_25').split(',');
const TIER = (process.argv[3] || 'TOP+MAJOR').toUpperCase();

const MIN_N = 15;
const MIN_Z = 1.5;
const MIN_EDGE = 0;

const DASHBOARD_BET_KEYS = new Set([
  'homeWinsFT', 'drawFT', 'awayWinsFT',
  'over15FT', 'over25FT', 'under15FT', 'under25FT',
  'btts', 'noBtts',
  'homeOver05FT', 'homeOver15FT', 'awayOver05FT', 'awayOver15FT',
]);
const DASH_BETS = BETS.filter(b => DASHBOARD_BET_KEYS.has(b.k));

const MARKET_KEY = { homeWinsFT: 'x2_home_c', awayWinsFT: 'x2_away_c', drawFT: 'x2_draw_c' };
const TL_EXACT_TOL = 0.01;
function getMarketOdds(row, betKey) {
  const flat = MARKET_KEY[betKey];
  if (flat) return row[flat];
  if (betKey === 'over25FT' && row.tl_c != null && Math.abs(row.tl_c - 2.5) < TL_EXACT_TOL) return row.ov_c;
  if (betKey === 'under25FT' && row.tl_c != null && Math.abs(row.tl_c - 2.5) < TL_EXACT_TOL) return row.un_c;
  return null;
}

function qualifiesBet(b) {
  return !!b && b.z >= MIN_Z && (b.lo - b.bl) >= MIN_EDGE;
}
function rank(b) { return b.z * (b.lo / 100); }

function applyTier(rows) {
  if (TIER === 'ALL') return rows;
  if (TIER === 'OTHER') return rows.filter(r => r.league_tier === 'OTHER');
  return rows.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
}

function scoreDashboard(cfgRows, baseRows) {
  if (cfgRows.length < MIN_N || baseRows.length < MIN_N) return [];
  const n = cfgRows.length;
  const results = [];
  for (const b of DASH_BETS) {
    const p = pct(cfgRows, b.k);
    const bl = pct(baseRows, b.k);
    const z = zScore(cfgRows, baseRows, b.k);
    const [lo, hi] = wilsonCI(p, n);
    results.push({ ...b, n, p, bl, z, edge: p - bl, lo, hi, mo: minOdds(p), mo_lo: minOdds(lo) });
  }
  return results;
}

// favLine bucket — VALID_LINES are 0, 0.25, 0.5, 0.75, 1.0, 1.25, 1.5.
// WEAK = near-toss-up favourite, STRONG = heavily favoured.
function favLineBucket(favLine) {
  if (favLine <= 0.25) return 'WEAK (0 - 0.25)';
  if (favLine <= 0.75) return 'MEDIUM (0.5 - 0.75)';
  return 'STRONG (1.0 - 1.5)';
}

// TL (Total Line) bucket — same named clusters static/app.js's TL_CLUSTERS
// uses. Low TL = low-scoring expectation, high TL = high-scoring.
function tlBucket(tlC) {
  if (tlC == null) return 'UNKNOWN';
  if (tlC < 2.0) return '<2';
  if (tlC < 2.5) return '2-2.5';
  if (tlC < 3.0) return '2.5-3';
  return '>3';
}

function main() {
  const files = fs.readdirSync(BET365_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  const allLabels = files.map(f => path.basename(f, '.csv'));
  for (const label of TEST_LABELS) {
    if (!allLabels.includes(label)) {
      console.error(`Unknown test month "${label}". Available: ${allLabels.join(', ')}`);
      process.exit(1);
    }
  }

  const raw = loadDatasetDir(BET365_DIR);
  const full = applyTier(raw);
  console.log(`Loaded ${raw.length} rows total, tier=${TIER}: ${full.length} rows`);
  console.log(`Test months (walk-forward, each excluded from its own historical pool): ${TEST_LABELS.join(', ')}\n`);

  const entries = [];       // all L2 qualifying picks, tagged with favLine bucket
  const marketEntries = []; // subset with a real bookmaker price, tagged with favLine bucket

  for (const label of TEST_LABELS) {
    const histDb = full.filter(r => r.file_label !== label);
    const testDb = full.filter(r => r.file_label === label);
    const poolA = histDb.filter(r => r.fold === 'A');
    const poolB = histDb.filter(r => r.fold === 'B');

    // Fresh caches per month — histDb differs per excluded month, so a
    // stale cache from the previous month's pool would be wrong here.
    const baseCache = new Map();
    const scoreCache = new Map();
    function getBase(pool, tag, favLine, favSide) {
      const key = `${tag}|${favLine}|${favSide}`;
      let base = baseCache.get(key);
      if (base === undefined) {
        base = applyBaselineConfig(pool, { fav_line: favLine, fav_side: favSide });
        baseCache.set(key, base);
      }
      return base;
    }
    function scoreLayer2(pool, tag, row) {
      const lineStable = row.line_move === 'STABLE';
      const tlStable = row.tl_move === 'STABLE';
      const favOddsMove = lineStable ? row.fav_odds_move : 'ANY';
      const dogOddsMove = lineStable ? row.dog_odds_move : 'ANY';
      const overMove = tlStable ? row.over_move : 'ANY';
      const underMove = tlStable ? row.under_move : 'ANY';
      const key = `${tag}|${row.fav_line}|${row.fav_side}|${row.line_move}|${row.tl_move}|${favOddsMove}|${dogOddsMove}|${overMove}|${underMove}`;
      let scored = scoreCache.get(key);
      if (scored !== undefined) return scored;
      const base = getBase(pool, tag, row.fav_line, row.fav_side);
      const moveCfg = {
        fav_line: row.fav_line, fav_side: row.fav_side,
        line_move: row.line_move, tl_move: row.tl_move,
        fav_odds_move: favOddsMove, dog_odds_move: dogOddsMove,
        over_move: overMove, under_move: underMove,
      };
      const cfgRows = applyConfig(pool, moveCfg);
      scored = scoreDashboard(cfgRows, base);
      scoreCache.set(key, scored);
      return scored;
    }
    function crossFitL2(row) {
      const scoredA = scoreLayer2(poolA, 'A', row);
      const scoredB = scoreLayer2(poolB, 'B', row);
      const crossFit = (scoredA.length && scoredB.length) ? mergeCrossFit(scoredA, scoredB, DASH_BETS, qualifiesBet) : [];
      if (crossFit.length) return crossFit.slice().sort((a, b) => rank(b) - rank(a))[0];
      const scored = scoreLayer2(histDb, 'full', row);
      if (!scored.length) return null;
      const qualifying = scored.filter(qualifiesBet).sort((a, b) => rank(b) - rank(a));
      return qualifying[0] || null;
    }

    let monthCount = 0;
    for (const row of testDb) {
      const bet = crossFitL2(row);
      if (!bet) continue;
      monthCount++;
      const bucket = favLineBucket(row.fav_line);
      const tlB = tlBucket(row.tl_c);
      const hit = row[bet.k] === true;
      entries.push({ hit, mo: parseFloat(bet.mo), mo_lo: parseFloat(bet.mo_lo), p: bet.p, bucket, tlB, favLine: row.fav_line, k: bet.k, month: label, n: bet.n });

      const marketOdds = getMarketOdds(row, bet.k);
      if (marketOdds != null && marketOdds > 1) {
        marketEntries.push({ hit, marketOdds, p: bet.p, mo: parseFloat(bet.mo), bucket, tlB, favLine: row.fav_line, k: bet.k, month: label });
      }
    }
    console.log(`  ${label}: ${monthCount} L2 qualifying picks`);
  }

  console.log(`\nTotal L2 qualifying picks pooled: ${entries.length}\n`);

  function tally(list, priceKey) {
    const n = list.length;
    if (!n) return { n: 0, hitRate: 0, roi: 0, avgClaimedP: 0 };
    const hits = list.filter(e => e.hit).length;
    const hitRate = hits / n * 100;
    const pnl = list.reduce((s, e) => s + (e.hit ? e[priceKey] - 1 : -1), 0);
    const roi = pnl / n * 100;
    const avgClaimedP = list.reduce((s, e) => s + e.p, 0) / n;
    return { n, hitRate, roi, avgClaimedP };
  }

  console.log('═'.repeat(100));
  console.log('SAMPLE SIZE (n) DISTRIBUTION — historical pool size behind each L2 pick');
  console.log('═'.repeat(100));
  const ns = entries.map(e => e.n).sort((a, b) => a - b);
  const pct = (p) => ns[Math.min(ns.length - 1, Math.floor(p * ns.length))];
  const ge = (x) => (ns.filter(v => v >= x).length / ns.length * 100).toFixed(1);
  console.log(`  n picks=${ns.length}  min=${ns[0]}  p10=${pct(0.10)}  p25=${pct(0.25)}  median=${pct(0.50)}  p75=${pct(0.75)}  p90=${pct(0.90)}  max=${ns[ns.length - 1]}`);
  console.log(`  share with n>=50: ${ge(50)}%   n>=100: ${ge(100)}%   n>=200: ${ge(200)}%\n`);

  function printBreakdown(dimLabel, dimField, buckets) {
    console.log('═'.repeat(100));
    console.log(`INTERNAL BACKTEST BY ${dimLabel} (own historical pool — hit rate & claimed odds)`);
    console.log('═'.repeat(100));
    for (const b of buckets) {
      const list = entries.filter(e => e[dimField] === b);
      const atMo = tally(list, 'mo');
      const atLo = tally(list, 'mo_lo');
      const gap = atMo.avgClaimedP - atMo.hitRate;
      console.log(`  ${b}:`);
      console.log(`    n=${atMo.n}  realized hit%=${atMo.hitRate.toFixed(1)}%  claimed avg p=${atMo.avgClaimedP.toFixed(1)}%  calibration gap=${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pp`);
      console.log(`    ROI@mo=${(atMo.roi >= 0 ? '+' : '') + atMo.roi.toFixed(1)}%   ROI@mo_lo=${(atLo.roi >= 0 ? '+' : '') + atLo.roi.toFixed(1)}%\n`);
    }

    console.log('═'.repeat(100));
    console.log(`REAL BOOKMAKER PRICE CHECK BY ${dimLabel} (this match's own actual closing odds, vig included)`);
    console.log('═'.repeat(100));
    for (const b of buckets) {
      const list = marketEntries.filter(e => e[dimField] === b);
      const n = list.length;
      if (!n) { console.log(`  ${b}: no market-checkable picks\n`); continue; }
      const avgMarketOdds = list.reduce((s, e) => s + e.marketOdds, 0) / n;
      const avgMarketImpliedP = list.reduce((s, e) => s + 100 / e.marketOdds, 0) / n;
      const avgClaimedP = list.reduce((s, e) => s + e.p, 0) / n;
      const clearsMarket = list.filter(e => e.marketOdds >= e.mo);
      const pnlAtMarket = list.reduce((s, e) => s + (e.hit ? e.marketOdds - 1 : -1), 0);
      const roiAtMarket = pnlAtMarket / n * 100;
      const pnlGated = clearsMarket.reduce((s, e) => s + (e.hit ? e.marketOdds - 1 : -1), 0);
      const roiGated = clearsMarket.length ? pnlGated / clearsMarket.length * 100 : 0;
      console.log(`  ${b}:`);
      console.log(`    n=${n}  avg market odds=${avgMarketOdds.toFixed(2)} (implied ${avgMarketImpliedP.toFixed(1)}%)  our claimed p=${avgClaimedP.toFixed(1)}%  edge vs market=${(avgClaimedP - avgMarketImpliedP >= 0 ? '+' : '') + (avgClaimedP - avgMarketImpliedP).toFixed(1)}pp`);
      console.log(`    market clears our min-odds: ${clearsMarket.length}/${n} (${(clearsMarket.length / n * 100).toFixed(1)}%)`);
      console.log(`    ROI always-bet-market=${(roiAtMarket >= 0 ? '+' : '') + roiAtMarket.toFixed(1)}%   ROI gated=${(roiGated >= 0 ? '+' : '') + roiGated.toFixed(1)}%  (n=${clearsMarket.length})\n`);
    }
  }

  printBreakdown('FAVOURITE STRENGTH', 'bucket', ['WEAK (0 - 0.25)', 'MEDIUM (0.5 - 0.75)', 'STRONG (1.0 - 1.5)']);
  printBreakdown('TOTAL LINE (TL)', 'tlB', ['<2', '2-2.5', '2.5-3', '>3']);

  // Per-month stability check for the two buckets flagged as promising
  // earlier (STRONG favourite, TL 2.5-3) — a real effect should hold up
  // month to month, not just look good pooled.
  console.log('═'.repeat(100));
  console.log('STABILITY — STRONG favourite bucket, real market check, month by month');
  console.log('═'.repeat(100));
  for (const label of TEST_LABELS) {
    const list = marketEntries.filter(e => e.bucket === 'STRONG (1.0 - 1.5)' && e.month === label);
    const n = list.length;
    if (!n) { console.log(`  ${label}: no checkable STRONG-favourite picks`); continue; }
    const avgMarketImpliedP = list.reduce((s, e) => s + 100 / e.marketOdds, 0) / n;
    const avgClaimedP = list.reduce((s, e) => s + e.p, 0) / n;
    const clearsMarket = list.filter(e => e.marketOdds >= e.mo);
    const pnlAtMarket = list.reduce((s, e) => s + (e.hit ? e.marketOdds - 1 : -1), 0);
    const roiAtMarket = pnlAtMarket / n * 100;
    const pnlGated = clearsMarket.reduce((s, e) => s + (e.hit ? e.marketOdds - 1 : -1), 0);
    const roiGated = clearsMarket.length ? pnlGated / clearsMarket.length * 100 : 0;
    console.log(`  ${label}: n=${n}  edge=${(avgClaimedP - avgMarketImpliedP >= 0 ? '+' : '') + (avgClaimedP - avgMarketImpliedP).toFixed(1)}pp  ROI always=${(roiAtMarket >= 0 ? '+' : '') + roiAtMarket.toFixed(1)}%  ROI gated=${(roiGated >= 0 ? '+' : '') + roiGated.toFixed(1)}% (n=${clearsMarket.length})`);
  }

  console.log('\n' + '═'.repeat(100));
  console.log('STABILITY — TL 2.5-3 bucket, real market check, month by month');
  console.log('═'.repeat(100));
  for (const label of TEST_LABELS) {
    const list = marketEntries.filter(e => e.tlB === '2.5-3' && e.month === label);
    const n = list.length;
    if (!n) { console.log(`  ${label}: no checkable TL 2.5-3 picks`); continue; }
    const avgMarketImpliedP = list.reduce((s, e) => s + 100 / e.marketOdds, 0) / n;
    const avgClaimedP = list.reduce((s, e) => s + e.p, 0) / n;
    const clearsMarket = list.filter(e => e.marketOdds >= e.mo);
    const pnlAtMarket = list.reduce((s, e) => s + (e.hit ? e.marketOdds - 1 : -1), 0);
    const roiAtMarket = pnlAtMarket / n * 100;
    const pnlGated = clearsMarket.reduce((s, e) => s + (e.hit ? e.marketOdds - 1 : -1), 0);
    const roiGated = clearsMarket.length ? pnlGated / clearsMarket.length * 100 : 0;
    console.log(`  ${label}: n=${n}  edge=${(avgClaimedP - avgMarketImpliedP >= 0 ? '+' : '') + (avgClaimedP - avgMarketImpliedP).toFixed(1)}pp  ROI always=${(roiAtMarket >= 0 ? '+' : '') + roiAtMarket.toFixed(1)}%  ROI gated=${(roiGated >= 0 ? '+' : '') + roiGated.toFixed(1)}% (n=${clearsMarket.length})`);
  }

  console.log('═'.repeat(100));
  console.log('DISTRIBUTION — exact favLine values within each bucket (all L2 picks, pooled)');
  console.log('═'.repeat(100));
  const lineCounts = {};
  for (const e of entries) lineCounts[e.favLine] = (lineCounts[e.favLine] || 0) + 1;
  for (const [line, c] of Object.entries(lineCounts).sort((a, b) => parseFloat(a[0]) - parseFloat(b[0]))) {
    console.log(`  fav_line=${line}: ${c}`);
  }

  console.log('\n' + '═'.repeat(100));
  console.log('BET-TYPE MIX — which markets L2 actually picks, and their typical (real market) odds');
  console.log('═'.repeat(100));
  const keyCounts = {};
  for (const e of entries) keyCounts[e.k] = (keyCounts[e.k] || 0) + 1;
  const sortedKeys = Object.entries(keyCounts).sort((a, b) => b[1] - a[1]);
  for (const [k, c] of sortedKeys) {
    const list = marketEntries.filter(e => e.k === k);
    const pct = (c / entries.length * 100).toFixed(1);
    if (list.length) {
      const avgOdds = list.reduce((s, e) => s + e.marketOdds, 0) / list.length;
      console.log(`  ${k}: ${c} picks (${pct}%)  —  real market odds n=${list.length}, avg=${avgOdds.toFixed(2)}`);
    } else {
      console.log(`  ${k}: ${c} picks (${pct}%)  —  no real market odds available for this key`);
    }
  }
}

main();
