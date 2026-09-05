'use strict';
// Same Layer 1 (opening-odds-only) pick + settle-at-OPENING-price mechanism
// as backtest_l1_at_opening_price.js, but loops every available month
// in-process (walk-forward, one held-out month at a time) and pools the
// results BY BET KEY and BY TIER, instead of printing one pooled number per
// month — to see whether the pooled +2.1%/-1.0% found across all 19 months
// is a real broad-based edge or just one or two keys/tiers carrying it.
//
// Usage: node backtest_l1_opening_breakdown.js [tier]
//   tier: ALL | TOP+MAJOR | OTHER  (default: runs all three)

const fs = require('fs');
const path = require('path');
const {
  loadDatasetDir, applyBaselineConfig, mergeCrossFit,
  pct, zScore, wilsonCI, minOdds, BETS,
} = require('./engine');

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');
const TIERS = process.argv[2] ? [process.argv[2].toUpperCase()] : ['TOP+MAJOR', 'OTHER', 'ALL'];

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

const MARKET_KEY_OPEN = { homeWinsFT: 'x2_home_o', awayWinsFT: 'x2_away_o', drawFT: 'x2_draw_o' };
const TL_EXACT_TOL = 0.01;
function getMarketOddsOpen(row, betKey) {
  const flat = MARKET_KEY_OPEN[betKey];
  if (flat) return row[flat];
  if (betKey === 'over25FT' && row.tl_o != null && Math.abs(row.tl_o - 2.5) < TL_EXACT_TOL) return row.ov_o;
  if (betKey === 'under25FT' && row.tl_o != null && Math.abs(row.tl_o - 2.5) < TL_EXACT_TOL) return row.un_o;
  return null;
}

function qualifiesBet(b) {
  return !!b && b.z >= MIN_Z && (b.lo - b.bl) >= MIN_EDGE;
}
function rank(b) { return b.z * (b.lo / 100); }

function applyTier(rows, tier) {
  if (tier === 'ALL') return rows;
  if (tier === 'OTHER') return rows.filter(r => r.league_tier === 'OTHER');
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

const ODDS_BANDS = [
  [null, 1.60], [1.60, 1.75], [1.75, 1.90], [1.90, 2.05],
  [2.05, 2.30], [2.30, 2.70], [2.70, null],
];
const TL_BANDS = {
  '<2':    [null, 2.0],
  '2-2.5': [2.0,  2.5],
  '2.5-3': [2.5,  3.0],
  '>3':    [3.0,  null],
};
function inBand(v, band) {
  if (v == null || !band) return false;
  const [lo, hi] = band;
  return (lo == null || v >= lo) && (hi == null || v < hi);
}
function oddsBandOf(v) {
  const b = ODDS_BANDS.find(bb => inBand(v, bb));
  return b ? `${b[0]}-${b[1]}` : null;
}
function tlBandOf(v) {
  return Object.entries(TL_BANDS).find(([, b]) => inBand(v, b))?.[0] ?? null;
}

function runTier(raw, tier) {
  const full = applyTier(raw, tier);
  const labels = [...new Set(full.map(r => r.file_label))];

  // per-key accumulators: { always: [{hit,odds}], gated: [{hit,odds}] }
  const byKey = {};
  function acc(key) {
    if (!byKey[key]) byKey[key] = { always: [], gated: [] };
    return byKey[key];
  }

  for (const testLabel of labels) {
    const histDb = full.filter(r => r.file_label !== testLabel);
    const testDb = full.filter(r => r.file_label === testLabel);
    const poolA = histDb.filter(r => r.fold === 'A');
    const poolB = histDb.filter(r => r.fold === 'B');
    if (!poolA.length || !poolB.length) continue;

    const _baseCache = new Map();
    const _scoreCache = new Map();
    function getBase(pool, tag, favLine, favSide) {
      const key = `${tag}|${favLine}|${favSide}`;
      let base = _baseCache.get(key);
      if (base === undefined) {
        base = applyBaselineConfig(pool, { fav_line: favLine, fav_side: favSide });
        _baseCache.set(key, base);
      }
      return base;
    }
    function scoreLayer1(pool, tag, row) {
      if (row.fav_oo == null) return [];
      const oddsBand = ODDS_BANDS.find(b => inBand(row.fav_oo, b));
      const tlBand = Object.values(TL_BANDS).find(b => inBand(row.tl_o, b));
      const key = `${tag}|${row.fav_line}|${row.fav_side}|${oddsBandOf(row.fav_oo)}|${tlBandOf(row.tl_o)}`;
      let scored = _scoreCache.get(key);
      if (scored !== undefined) return scored;
      const base = getBase(pool, tag, row.fav_line, row.fav_side);
      const cfgRows = base.filter(r => inBand(r.fav_oo, oddsBand) && (tlBand ? inBand(r.tl_o, tlBand) : true));
      scored = scoreDashboard(cfgRows, base);
      _scoreCache.set(key, scored);
      return scored;
    }
    function crossFitL1(row) {
      const scoredA = scoreLayer1(poolA, 'A', row);
      const scoredB = scoreLayer1(poolB, 'B', row);
      const crossFit = (scoredA.length && scoredB.length) ? mergeCrossFit(scoredA, scoredB, DASH_BETS, qualifiesBet) : [];
      if (crossFit.length) return crossFit.slice().sort((a, b) => rank(b) - rank(a))[0];
      const scored = scoreLayer1(histDb, 'full', row);
      if (!scored.length) return null;
      const qualifying = scored.filter(qualifiesBet).sort((a, b) => rank(b) - rank(a));
      return qualifying[0] || null;
    }

    for (const row of testDb) {
      const bet = crossFitL1(row);
      if (!bet) continue;
      const marketOdds = getMarketOddsOpen(row, bet.k);
      if (marketOdds == null || marketOdds <= 1) continue;
      const hit = row[bet.k] === true;
      const a = acc(bet.k);
      a.always.push({ hit, odds: marketOdds });
      if (marketOdds >= bet.mo) a.gated.push({ hit, odds: marketOdds });
    }
  }

  return byKey;
}

function summarize(entries) {
  const n = entries.length;
  if (!n) return null;
  const hits = entries.filter(e => e.hit).length;
  const hitRate = hits / n * 100;
  const pnl = entries.reduce((s, e) => s + (e.hit ? e.odds - 1 : -1), 0);
  const roi = pnl / n * 100;
  return { n, hitRate, roi };
}

function main() {
  const raw = loadDatasetDir(BET365_DIR);

  for (const tier of TIERS) {
    console.log('\n' + '═'.repeat(100));
    console.log(`TIER = ${tier}  —  L1 @ opening price, walk-forward across every available month, by bet key`);
    console.log('═'.repeat(100));
    const byKey = runTier(raw, tier);

    const rows = Object.entries(byKey).map(([key, { always, gated }]) => {
      const sA = summarize(always);
      const sG = summarize(gated);
      return { key, sA, sG };
    }).filter(r => r.sA);
    rows.sort((a, b) => (b.sA.n) - (a.sA.n));

    console.log(
      'key'.padEnd(16),
      'n(always)'.padStart(10), 'hit%'.padStart(7), 'ROI@always'.padStart(11),
      '|', 'n(gated)'.padStart(9), 'hit%'.padStart(7), 'ROI@gated'.padStart(10)
    );
    for (const { key, sA, sG } of rows) {
      const gStr = sG ? [sG.n.toString().padStart(9), sG.hitRate.toFixed(1).padStart(6) + '%', ((sG.roi >= 0 ? '+' : '') + sG.roi.toFixed(1) + '%').padStart(10)]
                       : ['0'.padStart(9), '-'.padStart(7), '-'.padStart(10)];
      console.log(
        key.padEnd(16),
        sA.n.toString().padStart(10),
        (sA.hitRate.toFixed(1) + '%').padStart(7),
        ((sA.roi >= 0 ? '+' : '') + sA.roi.toFixed(1) + '%').padStart(11),
        '|', ...gStr
      );
    }

    // Pooled across all keys
    const allAlways = Object.values(byKey).flatMap(v => v.always);
    const allGated = Object.values(byKey).flatMap(v => v.gated);
    const pA = summarize(allAlways);
    const pG = summarize(allGated);
    console.log('-'.repeat(100));
    if (pA) console.log(`POOLED  n=${pA.n}  hit%=${pA.hitRate.toFixed(1)}%  ROI@always=${(pA.roi >= 0 ? '+' : '') + pA.roi.toFixed(1)}%`);
    if (pG) console.log(`POOLED  n=${pG.n}  hit%=${pG.hitRate.toFixed(1)}%  ROI@gated =${(pG.roi >= 0 ? '+' : '') + pG.roi.toFixed(1)}%`);
  }
}

main();
