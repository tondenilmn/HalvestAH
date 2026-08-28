'use strict';
// Walk-forward test of the Dashboard's L123-style near-kickoff consensus
// PRICING method (static/app.js's l123ConsensusSignal + averageAgreeingBet,
// added 2026-08-27) — specifically: once >=2 of the 3 layers (opening,
// movement, closing) agree on the same bet key, is it better to show the
// AVERAGE of the agreeing layers' p/lo/mo, or the OLD behavior of just
// showing whichever agreeing layer happened to sort first (always L1 if it
// was part of the agreeing set, else L2)?
//
// Each test row's own opening/movement/closing fields stand in for what the
// three layers would have seen live, near kickoff — same assumption
// l123ConsensusSignal itself makes (current odds treated as a closing-line
// proxy inside NEAR_KICKOFF_MIN). Layers 1/2/3 are each cross-fit corrected
// (row.fold A/B, price from the OTHER fold), mirroring the current
// openingOddsSignal/movementSignal/closingOddsSignal in static/app.js.
//
// Usage: node backtest_l123_consensus_pricing.js [testFileLabel] [tier]
//   e.g. node backtest_l123_consensus_pricing.js Bet365_05_26 TOP+MAJOR

const fs = require('fs');
const path = require('path');
const {
  loadDatasetDir, applyConfig, applyBaselineConfig, mergeCrossFit,
  pct, zScore, wilsonCI, minOdds, BETS,
} = require('./engine');

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');
const TEST_LABEL = process.argv[2] || 'Bet365_05_26';
const TIER = (process.argv[3] || 'TOP+MAJOR').toUpperCase();

const MIN_N = 15;   // DEFAULT_MIN_N in app.js
const MIN_Z = 1.5;
const MIN_EDGE = 0;

// Mirrors static/app.js's DASHBOARD_ODDS_BANDS / TL_CLUSTERS / _DASHBOARD_BET_KEYS.
const ODDS_BANDS = [
  [null, 1.60], [1.60, 1.75], [1.75, 1.90], [1.90, 2.05],
  [2.05, 2.30], [2.30, 2.70], [2.70, null],
];
const TL_CLUSTERS = {
  '<2': [null, 2.0], '2-2.5': [2.0, 2.5], '2.5-3': [2.5, 3.0], '>3': [3.0, null],
};
const DASHBOARD_BET_KEYS = new Set([
  'homeWinsFT', 'drawFT', 'awayWinsFT',
  'over15FT', 'over25FT', 'under15FT', 'under25FT',
  'btts', 'noBtts',
  'homeOver05FT', 'homeOver15FT', 'awayOver05FT', 'awayOver15FT',
]);
const DASH_BETS = BETS.filter(b => DASHBOARD_BET_KEYS.has(b.k));

// Of the 13 dashboard bet keys, these three have a 1:1 CSV column carrying
// the bookmaker's own (vig-included) closing price for that exact outcome
// unconditionally.
const MARKET_KEY = { homeWinsFT: 'x2_home_c', awayWinsFT: 'x2_away_c', drawFT: 'x2_draw_c' };

// over25FT/under25FT get a real market price too, but only conditionally:
// ov_c/un_c are the closing Asian Total Line's Over/Under price for
// whatever line the market actually quoted (tl_c), not fixed at 2.5. When
// tl_c happens to sit exactly at 2.5 (no half-line straddling), "Over the
// closing Total Line" IS "Over 2.5 FT" — same market, same price, no
// equivalence trick needed. At any other tl_c this doesn't hold (e.g.
// tl_c=2.75 quotes Over 2.75, not Over 2.5), so it's excluded there.
const TL_EXACT_TOL = 0.01;
function getMarketOdds(row, betKey) {
  const flat = MARKET_KEY[betKey];
  if (flat) return row[flat];
  if (betKey === 'over25FT' && row.tl_c != null && Math.abs(row.tl_c - 2.5) < TL_EXACT_TOL) return row.ov_c;
  if (betKey === 'under25FT' && row.tl_c != null && Math.abs(row.tl_c - 2.5) < TL_EXACT_TOL) return row.un_c;
  return null;
}

function inBand(v, band) {
  if (v == null || !band) return false;
  const [lo, hi] = band;
  return (lo == null || v >= lo) && (hi == null || v < hi);
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

// Memoized like static/app.js's _dashBaseCache/_dashBaseCacheFold and
// backtest_dashboard_split_sample.js's _baseCache/_scoreCache — without this,
// re-filtering the full historical pool (176k rows for OTHER tier) from
// scratch per fixture x per layer x per fold is far too slow to run at
// scale. The (fav_line, fav_side, odds band, tl band) / movement-combo space
// is tiny compared to the number of test fixtures sharing them.
const _baseCache = new Map();   // `${tag}|${favLine}|${favSide}` -> baseRows
const _scoreCache = new Map();  // layer-specific key -> scored[] (DASH_BETS output)

function getBase(pool, tag, favLine, favSide) {
  const key = `${tag}|${favLine}|${favSide}`;
  let base = _baseCache.get(key);
  if (base === undefined) {
    base = applyBaselineConfig(pool, { fav_line: favLine, fav_side: favSide });
    _baseCache.set(key, base);
  }
  return base;
}

// Layer 1 — opening odds band + opening TL band.
function scoreLayer1(pool, tag, favLine, favSide, favOo, tlO) {
  const oddsIdx = ODDS_BANDS.findIndex(b => inBand(favOo, b));
  const tlKey = Object.keys(TL_CLUSTERS).find(k => inBand(tlO, TL_CLUSTERS[k])) ?? 'none';
  const key = `L1|${tag}|${favLine}|${favSide}|${oddsIdx}|${tlKey}`;
  let scored = _scoreCache.get(key);
  if (scored !== undefined) return scored;
  const base = getBase(pool, tag, favLine, favSide);
  const oddsBand = oddsIdx >= 0 ? ODDS_BANDS[oddsIdx] : null;
  const tlBand = tlKey !== 'none' ? TL_CLUSTERS[tlKey] : null;
  const cfgRows = base.filter(r => inBand(r.fav_oo, oddsBand) && (tlBand ? inBand(r.tl_o, tlBand) : true));
  scored = scoreDashboard(cfgRows, base);
  _scoreCache.set(key, scored);
  return scored;
}

// Layer 3 — closing/current odds band + closing/current TL band.
function scoreLayer3(pool, tag, favLine, favSide, favOc, tlC) {
  const oddsIdx = ODDS_BANDS.findIndex(b => inBand(favOc, b));
  const tlKey = Object.keys(TL_CLUSTERS).find(k => inBand(tlC, TL_CLUSTERS[k])) ?? 'none';
  const key = `L3|${tag}|${favLine}|${favSide}|${oddsIdx}|${tlKey}`;
  let scored = _scoreCache.get(key);
  if (scored !== undefined) return scored;
  const base = getBase(pool, tag, favLine, favSide);
  const oddsBand = oddsIdx >= 0 ? ODDS_BANDS[oddsIdx] : null;
  const tlBand = tlKey !== 'none' ? TL_CLUSTERS[tlKey] : null;
  const cfgRows = base.filter(r => inBand(r.fav_oc, oddsBand) && (tlBand ? inBand(r.tl_c, tlBand) : true));
  scored = scoreDashboard(cfgRows, base);
  _scoreCache.set(key, scored);
  return scored;
}

// Layer 2 — movement only. Tier-2 dims (fav/dog odds move, over/under move)
// only activate when their Tier-1 counterpart (line/TL move) is STABLE —
// mirrors buildRawCfgFromLiveOdds's gating in static/app.js. Cache key is
// the exact discrete movement combo (bounded space) per fold/pool tag.
function scoreLayer2(pool, tag, row) {
  const lineStable = row.line_move === 'STABLE';
  const tlStable = row.tl_move === 'STABLE';
  const favOddsMove = lineStable ? row.fav_odds_move : 'ANY';
  const dogOddsMove = lineStable ? row.dog_odds_move : 'ANY';
  const overMove = tlStable ? row.over_move : 'ANY';
  const underMove = tlStable ? row.under_move : 'ANY';
  const key = `L2|${tag}|${row.fav_line}|${row.fav_side}|${row.line_move}|${row.tl_move}|${favOddsMove}|${dogOddsMove}|${overMove}|${underMove}`;
  let scored = _scoreCache.get(key);
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
  _scoreCache.set(key, scored);
  return scored;
}

// Generic cross-fit combiner: scoreFnA/B/Full each return a scored[] array
// (already narrowed + cached for that pool/tag). Returns { bet, qualifies }
// (L1-style, with a non-qualifying best-positive-edge fallback) when
// allowFallback is true, else just the qualifying bet or null (L2/L3-style
// — matches movementSignal/closingOddsSignal, which never surface a
// non-qualifying pick).
function crossFitGeneric(scoredA, scoredB, scoredFullFn, allowFallback) {
  const crossFit = (scoredA.length && scoredB.length) ? mergeCrossFit(scoredA, scoredB, DASH_BETS, qualifiesBet) : [];
  if (crossFit.length) {
    const sorted = crossFit.slice().sort((a, b) => rank(b) - rank(a));
    return allowFallback ? { bet: sorted[0], qualifies: true } : sorted[0];
  }
  const scored = scoredFullFn();
  if (!scored.length) return null;
  const qualifying = scored.filter(qualifiesBet).sort((a, b) => rank(b) - rank(a));
  if (qualifying.length) return allowFallback ? { bet: qualifying[0], qualifies: true } : qualifying[0];
  if (!allowFallback) return null;
  const posEdge = scored.filter(b => b.edge > 0 && b.n >= MIN_N).sort((a, b) => rank(b) - rank(a))[0];
  return posEdge ? { bet: posEdge, qualifies: false } : null;
}

// OLD pricing: whichever agreeing layer sorts first in [L1, L2, L3] order.
function oldPrice(agreeing) {
  return agreeing[0].rec;
}

// L3-PRIORITY pricing: prefer the closing-odds layer when it's part of the
// agreeing set (closest thing this dashboard has to CLV — the closing line
// is the standard sharpest reference point in betting theory), falling back
// to L1 then L2 otherwise.
function l3PriorityPrice(agreeing) {
  return (agreeing.find(x => x.name === 'L3(close)')
       || agreeing.find(x => x.name === 'L1(open)')
       || agreeing[0]).rec;
}

// NEW pricing: equal-weight mean of p/lo/hi/bl/z/n across agreeing layers,
// mo/mo_lo/mo_mid recomputed from the averaged p/lo — port of
// static/app.js's averageAgreeingBet.
function averagedPrice(agreeing) {
  const n = agreeing.length;
  const mean = (f) => agreeing.reduce((s, x) => s + f(x.rec), 0) / n;
  const p = mean(r => r.p), lo = mean(r => r.lo), hi = mean(r => r.hi), bl = mean(r => r.bl), z = mean(r => r.z);
  const sampleN = Math.round(mean(r => r.n));
  return { ...agreeing[0].rec, n: sampleN, p, bl, z, edge: p - bl, lo, hi, mo: minOdds(p), mo_lo: minOdds(lo) };
}

function tally(entries, priceKey) {
  const n = entries.length;
  if (!n) return { n: 0, hitRate: 0, roi: 0, avgClaimedP: 0 };
  const hits = entries.filter(e => e.hit).length;
  const hitRate = hits / n * 100;
  const pnl = entries.reduce((s, e) => s + (e.hit ? e[priceKey] - 1 : -1), 0);
  const roi = pnl / n * 100;
  const avgClaimedP = entries.reduce((s, e) => s + e.p, 0) / n;
  return { n, hits, hitRate, roi, avgClaimedP };
}

function main() {
  const files = fs.readdirSync(BET365_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  const allLabels = files.map(f => path.basename(f, '.csv'));
  if (!allLabels.includes(TEST_LABEL)) {
    console.error(`Unknown test month "${TEST_LABEL}". Available: ${allLabels.join(', ')}`);
    process.exit(1);
  }

  const raw = loadDatasetDir(BET365_DIR);
  const full = applyTier(raw);
  console.log(`Loaded ${raw.length} rows total, tier=${TIER}: ${full.length} rows`);
  console.log(`Test month: ${TEST_LABEL}  (walk-forward — excluded from the historical pool)\n`);

  const histDb = full.filter(r => r.file_label !== TEST_LABEL);
  const testDb = full.filter(r => r.file_label === TEST_LABEL);
  const poolA = histDb.filter(r => r.fold === 'A');
  const poolB = histDb.filter(r => r.fold === 'B');
  console.log(`Historical pool split by row.fold: A=${poolA.length} rows, B=${poolB.length} rows`);
  console.log(`Test matches (tier=${TIER}, ${TEST_LABEL}): ${testDb.length} rows\n`);

  const oldEntries = [];
  const newEntries = [];
  const l3Entries = [];
  const marketEntries = [];
  let consensusCount = 0, agree3 = 0, agree2 = 0;
  let keyCounts = {};
  let keyMarketableCounts = {};

  for (const row of testDb) {
    const p1 = crossFitGeneric(
      scoreLayer1(poolA, 'A', row.fav_line, row.fav_side, row.fav_oo, row.tl_o),
      scoreLayer1(poolB, 'B', row.fav_line, row.fav_side, row.fav_oo, row.tl_o),
      () => scoreLayer1(histDb, 'full', row.fav_line, row.fav_side, row.fav_oo, row.tl_o),
      true,
    );
    const p2 = crossFitGeneric(
      scoreLayer2(poolA, 'A', row),
      scoreLayer2(poolB, 'B', row),
      () => scoreLayer2(histDb, 'full', row),
      false,
    );
    const p3 = crossFitGeneric(
      scoreLayer3(poolA, 'A', row.fav_line, row.fav_side, row.fav_oc, row.tl_c),
      scoreLayer3(poolB, 'B', row.fav_line, row.fav_side, row.fav_oc, row.tl_c),
      () => scoreLayer3(histDb, 'full', row.fav_line, row.fav_side, row.fav_oc, row.tl_c),
      false,
    );

    const r1 = (p1 && p1.qualifies) ? p1.bet : null;
    const r2 = p2;
    const r3 = p3;

    const recs = [
      r1 && { rec: r1, name: 'L1(open)' },
      r2 && { rec: r2, name: 'L2(move)' },
      r3 && { rec: r3, name: 'L3(close)' },
    ].filter(Boolean);
    if (recs.length < 2) continue;

    const counts = {};
    for (const { rec } of recs) counts[rec.k] = (counts[rec.k] || 0) + 1;
    const [topKey, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
    if (topCount < 2) continue;

    const agreeing = recs.filter(x => x.rec.k === topKey);
    consensusCount++;
    if (topCount === 3) agree3++; else agree2++;
    keyCounts[topKey] = (keyCounts[topKey] || 0) + 1;

    const hit = row[topKey] === true;
    const oldBet = oldPrice(agreeing);
    const newBet = averagedPrice(agreeing);
    const l3Bet = l3PriorityPrice(agreeing);

    oldEntries.push({ hit, mo: parseFloat(oldBet.mo), mo_lo: parseFloat(oldBet.mo_lo), p: oldBet.p });
    newEntries.push({ hit, mo: parseFloat(newBet.mo), mo_lo: parseFloat(newBet.mo_lo), p: newBet.p });
    l3Entries.push({ hit, mo: parseFloat(l3Bet.mo), mo_lo: parseFloat(l3Bet.mo_lo), p: l3Bet.p });

    // Real bookmaker (vig-included) closing price check — only possible for
    // bet keys with a directly-quotable market price (see getMarketOdds).
    // marketOdds is THIS match's own actual closing price, not a pool average.
    const marketOdds = getMarketOdds(row, topKey);
    if (marketOdds != null && marketOdds > 1) {
      keyMarketableCounts[topKey] = (keyMarketableCounts[topKey] || 0) + 1;
      marketEntries.push({
        hit, marketOdds,
        old: { p: oldBet.p, mo: parseFloat(oldBet.mo) },
        new: { p: newBet.p, mo: parseFloat(newBet.mo) },
        l3: { p: l3Bet.p, mo: parseFloat(l3Bet.mo) },
      });
    }
  }

  console.log(`Consensus fixtures (>=2/3 layers agree): ${consensusCount}  (3/3: ${agree3}, 2/3: ${agree2})\n`);

  for (const [label, entries] of [
    ['OLD — first agreeing layer, [L1,L2,L3] order (previous behavior)', oldEntries],
    ['NEW — average of agreeing layers', newEntries],
    ['L3-PRIORITY — prefer closing-odds layer when it agreed', l3Entries],
  ]) {
    const atMo = tally(entries, 'mo');
    const atLo = tally(entries, 'mo_lo');
    const gap = atMo.avgClaimedP - atMo.hitRate;
    console.log('═'.repeat(90));
    console.log(label);
    console.log('═'.repeat(90));
    console.log(`  n=${atMo.n}  realized hit%=${atMo.hitRate.toFixed(1)}%  claimed avg p=${atMo.avgClaimedP.toFixed(1)}%  calibration gap=${gap >= 0 ? '+' : ''}${gap.toFixed(1)}pp`);
    console.log(`  ROI@mo (fair)          =${(atMo.roi >= 0 ? '+' : '') + atMo.roi.toFixed(1)}%`);
    console.log(`  ROI@mo_lo (conservative)=${(atLo.roi >= 0 ? '+' : '') + atLo.roi.toFixed(1)}%\n`);
  }

  console.log('═'.repeat(90));
  console.log('COVERAGE — which bet keys the consensus actually picked');
  console.log('═'.repeat(90));
  const sortedKeys = Object.entries(keyCounts).sort((a, b) => b[1] - a[1]);
  for (const [k, c] of sortedKeys) {
    const mCount = keyMarketableCounts[k] || 0;
    const tag = mCount === 0 ? '[no market column — model-only]'
      : mCount === c ? '[real market price available]'
      : `[real market price for ${mCount}/${c} — only when tl_c=2.5]`;
    console.log(`  ${tag}  ${k}: ${c}`);
  }
  const marketableCount = marketEntries.length;
  console.log(`\n  ${marketableCount}/${consensusCount} consensus picks (${(marketableCount / consensusCount * 100).toFixed(1)}%) had a real bookmaker price directly checkable in this dataset.\n`);

  if (marketEntries.length) {
    console.log('═'.repeat(90));
    console.log(`REAL BOOKMAKER PRICE CHECK — homeWinsFT/awayWinsFT/drawFT (always) + over25FT/under25FT when tl_c=2.5 (this match's own actual closing odds, vig included)`);
    console.log('═'.repeat(90));
    for (const [label, sel] of [['OLD', 'old'], ['NEW (average)', 'new'], ['L3-PRIORITY', 'l3']]) {
      const n = marketEntries.length;
      const avgMarketOdds = marketEntries.reduce((s, e) => s + e.marketOdds, 0) / n;
      const avgMarketImpliedP = marketEntries.reduce((s, e) => s + 100 / e.marketOdds, 0) / n;
      const avgClaimedP = marketEntries.reduce((s, e) => s + e[sel].p, 0) / n;
      const clearsMarket = marketEntries.filter(e => e.marketOdds >= e[sel].mo);
      const pnlAtMarket = marketEntries.reduce((s, e) => s + (e.hit ? e.marketOdds - 1 : -1), 0);
      const roiAtMarket = pnlAtMarket / n * 100;
      const pnlGated = clearsMarket.reduce((s, e) => s + (e.hit ? e.marketOdds - 1 : -1), 0);
      const roiGated = clearsMarket.length ? pnlGated / clearsMarket.length * 100 : 0;
      console.log(`  ${label}:`);
      console.log(`    n=${n}  avg market odds=${avgMarketOdds.toFixed(2)} (implied ${avgMarketImpliedP.toFixed(1)}%)  our claimed p=${avgClaimedP.toFixed(1)}%  edge vs market=${(avgClaimedP - avgMarketImpliedP >= 0 ? '+' : '') + (avgClaimedP - avgMarketImpliedP).toFixed(1)}pp`);
      console.log(`    market odds actually clear our min-odds requirement: ${clearsMarket.length}/${n} (${(clearsMarket.length / n * 100).toFixed(1)}%)`);
      console.log(`    ROI if you always bet at the real market price          =${(roiAtMarket >= 0 ? '+' : '') + roiAtMarket.toFixed(1)}%`);
      console.log(`    ROI only when the real market price clears our min-odds =${(roiGated >= 0 ? '+' : '') + roiGated.toFixed(1)}%  (n=${clearsMarket.length})\n`);
    }
  }
}

main();
