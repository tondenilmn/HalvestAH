// telegram/research/backtest_newmodel_ou_v2.js
//
// v2 of backtest_newmodel_ou.js — rebuilt to use EXACTLY the same reduced
// information a live match actually has, now that notify.js's
// runStrategyNewModel has been fixed to stop relying on lambda_lookup.json's
// bucket-median fallback (see MEMORY.md / LIVE_BETTING_PLAN.md task notes,
// 2026-08-28 fix).
//
// v1 (backtest_newmodel_ou.js) replicated the ORIGINAL bug faithfully: no
// lambda_h/lambda_a passed into LiveModel's state, so _normState() fell back
// to lambdaFromLookup() — a bucket MEDIAN over thousands of historical
// matches sharing the (line, TL, tier) cell. Checking that bucket-average
// price against individual draws FROM THE SAME POPULATION is close to
// circular and produced an absurd 87.9% hit rate / 61.4% ROI.
//
// v2 instead computes each historical match's own (lambda_h, lambda_a) with
// telegram/live_lambda_solver.js — the SAME AH+O/U-only solver now wired
// into production — fed that match's own closing AH line/odds + Total
// Line/O-U odds. This is NOT a join against telegram/research/implied_lambda.js's
// 1X2-informed E1 report (that would leak information the live feed doesn't
// have) and NOT the lambda_lookup.json bucket (that's the circularity being
// removed). A row whose solver call doesn't converge/fails is EXCLUDED from
// pricing (counted as a pricing failure) rather than silently falling back
// to the bucket — falling back here would just reintroduce the same
// circularity this rebuild exists to remove.
//
// IMPORTANT STRUCTURAL CAVEAT (expected, not a bug): the solver fits
// (lambda_h, lambda_a) so the model's Over probability at the real TL
// reproduces the de-vigged closing Over/Under market probability almost
// exactly (residual ~0, see live_lambda_solver.js's own convergence test).
// That means the model's point-probability for Over/Under is, by
// construction, ~equal to this match's own de-vigged closing O/U price —
// so an "edge" over the RAW (vig-included) market price mostly just
// reflects the vig itself (raw implied > de-vigged ≈ model p), and should
// be small/negative on average unless the Wilson/MC lower-bound shrinkage
// happens to still clear it. A low/near-zero edge-qualifying coverage here
// is the CORRECT, honest result of removing the circularity — see the
// `caveats` field in the emitted report.
//
// Run: node telegram/research/backtest_newmodel_ou_v2.js

'use strict';

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const { classifyLeague } = require('../engine.js');
const LM = require('../../static/live_model.js');
const cfg = require('../config.js');
const { solveLambdaFromOdds } = require('../live_lambda_solver.js');

const DATA_DIR = path.resolve(__dirname, '../../static/data/Bet365');
const REPORT_DIR = path.resolve(__dirname, 'reports');
const Z = 1.96;
const THRESHOLDS = [3, 5, 8, 12];
const DEFAULT_EDGE_PP = cfg.NEWMODEL_MIN_EDGE_PP;
const MC_SAMPLES = cfg.NEWMODEL_MC_SAMPLES;
const TIERS = ['TOP', 'MAJOR', 'OTHER'];

// ── numeric parse helper (same convention as bias_scan.js) ────────────────
function sf(v) {
  const f = parseFloat(String(v == null ? '' : v).trim());
  return Number.isFinite(f) ? f : null;
}

// ── AH / Totals settlement (verbatim from bias_scan.js) ───────────────────
function subReturn(adj, odds) {
  if (adj > 1e-9) return odds - 1;
  if (adj < -1e-9) return -1;
  return 0; // push
}
function lineReturn(margin, line, odds) {
  const quarterish = Math.abs(Math.abs(line * 4) % 2) > 1e-6;
  if (quarterish) {
    const lo = line - 0.25, hi = line + 0.25;
    return (subReturn(margin + lo, odds) + subReturn(margin + hi, odds)) / 2;
  }
  return subReturn(margin + line, odds);
}

// ── stats helpers ───────────────────────────────────────────────────────
function meanCI(returns) {
  const n = returns.length;
  if (n === 0) return { n: 0, roi: null, lo: null, hi: null };
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1 ? returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1) : 0;
  const se = Math.sqrt(variance / n);
  return { n, roi: mean, lo: mean - Z * se, hi: mean + Z * se };
}
function wilsonCI(wins, total) {
  if (total === 0) return { n: 0, p: null, lo: null, hi: null };
  const p = wins / total;
  const denom = 1 + (Z * Z) / total;
  const center = p + (Z * Z) / (2 * total);
  const margin = Z * Math.sqrt((p * (1 - p)) / total + (Z * Z) / (4 * total * total));
  return { n: total, p, lo: (center - margin) / denom, hi: (center + margin) / denom };
}

// deterministic per-row seed (>>> 0'd for mulberry32) from date+home+away
function seedFor(dateStr, home, away) {
  const s = `${dateStr}|${home}|${away}`;
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// ── production's edge helper, verbatim (telegram/notify.js) ───────────────
function newModelEdge(pct, marketOdds) {
  if (marketOdds == null || !(marketOdds > 1)) return { edgePp: null, marketImpliedPct: null };
  const marketImpliedPct = 100 / marketOdds;
  return { edgePp: pct - marketImpliedPct, marketImpliedPct };
}

// ── data loading (mirrors bias_scan.js's loadRows conventions) ────────────
function loadRows() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  const rows = [];
  const drop = {
    totalCsvRows: 0,
    badDate: 0,
    htParseFail: 0,
    ftParseFail: 0,
    noTotalLine: 0,
    badOverUnderOdds: 0,
    badAhLine: 0,
    badAhOdds: 0,
    lambdaSolveFailed: 0,
  };

  for (const f of files) {
    const csv = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
    const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true });
    for (const r of data) {
      drop.totalCsvRows++;

      const dateStr = (r['Date'] || '').trim();
      const d = dateStr ? new Date(dateStr + 'T00:00:00Z') : null;
      if (!d || isNaN(d.getTime())) { drop.badDate++; continue; }

      const htRaw = (r['HT Result'] || '').trim();
      const htm = /^(\d+)\s*-\s*(\d+)$/.exec(htRaw);
      if (!htm) { drop.htParseFail++; continue; }
      const htH = parseInt(htm[1], 10), htA = parseInt(htm[2], 10);

      const ftRaw = (r['FT Result'] || '').trim();
      const ftm = /^(\d+)\s*-\s*(\d+)$/.exec(ftRaw);
      if (!ftm) { drop.ftParseFail++; continue; }
      const ftH = parseInt(ftm[1], 10), ftA = parseInt(ftm[2], 10);

      const tlC = sf(r['Total Line Closing']), tlO = sf(r['Total Line Opening']);
      const ouLine = tlC != null ? tlC : tlO;
      if (ouLine == null) { drop.noTotalLine++; continue; }

      const ovC = sf(r['Over Odds Closing']), unC = sf(r['Under Odds Closing']);
      if (ovC == null || unC == null || !(ovC > 1) || !(unC > 1)) { drop.badOverUnderOdds++; continue; }

      const ahHc = sf(r['Home AH Closing']);
      if (ahHc == null) { drop.badAhLine++; continue; }

      // Needed by the AH+O/U-only solver (v2 only — v1 never needed these
      // since it never fit a per-match lambda): the AH market's own home/
      // away prices, so the solver can de-vig a real AH-cover target instead
      // of relying on 1X2 (which the live feed doesn't have either).
      const hoC = sf(r['Home Odds Closing']), aoC = sf(r['Away Odds Closing']);
      if (!(hoC > 1) || !(aoC > 1)) { drop.badAhOdds++; continue; }

      const league = r['League'] || '';
      const tier = classifyLeague(league);
      const home = r['Home Team'] || '';
      const away = r['Away Team'] || '';

      rows.push({
        date: d, dateStr, league, tier, home, away,
        htH, htA, ftH, ftA,
        ahHc, hoC, aoC, ouLine, ovC, unC,
      });
    }
  }

  rows.sort((a, b) => a.date - b.date);
  rows.forEach((r, i) => {
    r.monthKey = `${r.date.getUTCFullYear()}-${String(r.date.getUTCMonth() + 1).padStart(2, '0')}`;
    r.slice = Math.min(2, Math.floor((i / rows.length) * 3));
  });

  return { rows, drop };
}

// ── price every usable match ONCE (both Over and Under 'lo'), reused for
// all four edge thresholds ─────────────────────────────────────────────
function priceAll(rows) {
  const boot = LM.init();
  if (!boot.hazardLoaded) throw new Error('goal_hazard.json failed to load');
  console.log(`LiveModel.init() -> hazardLoaded=${boot.hazardLoaded} lookupLoaded=${boot.lookupLoaded}`);

  const priced = [];
  let failures = 0;
  let lambdaSolveFailures = 0;
  const t0 = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];

    // v2: solve this match's own (lambda_h, lambda_a) from ONLY its closing
    // AH + O/U prices — the same reduced information the live feed has, and
    // the same solver now wired into production's runStrategyNewModel. A row
    // whose solve fails is skipped entirely (NOT bucket-fallback) so the
    // circularity this rebuild targets can't sneak back in.
    const solved = solveLambdaFromOdds({
      ahLine: r.ahHc, ahHomeOdds: r.hoC, ahAwayOdds: r.aoC,
      tl: r.ouLine, overOdds: r.ovC, underOdds: r.unC, tier: r.tier,
    });
    if (!solved.ok) {
      lambdaSolveFailures++;
      if (lambdaSolveFailures <= 5) console.error(`  lambda solve failed for row ${i} (${r.home} v ${r.away}, ${r.dateStr}): ${solved.error}`);
      continue;
    }

    const state = {
      ah_line: r.ahHc,
      tl: r.ouLine,
      tier: r.tier,
      lambda_h: solved.lambda_h, lambda_a: solved.lambda_a, rho: solved.rho,
      home_goals: r.htH, away_goals: r.htA,
      ht_home_goals: r.htH, ht_away_goals: r.htA,
      red_h: 0, red_a: 0,
    };
    const specs = [
      { type: 'over', line: r.ouLine, scope: 'match' },
      { type: 'under', line: r.ouLine, scope: 'match' },
    ];
    const seed = seedFor(r.dateStr, r.home, r.away);
    try {
      const [rOver, rUnder] = LM.priceLadder(specs, state, 'HT', { samples: MC_SAMPLES, seed });
      priced.push({ r, overLo: rOver.lo, underLo: rUnder.lo });
    } catch (e) {
      failures++;
      if (failures <= 5) console.error(`  pricing failed for row ${i} (${r.home} v ${r.away}, ${r.dateStr}): ${e.message}`);
    }
    if ((i + 1) % 20000 === 0) {
      const elapsed = (Date.now() - t0) / 1000;
      console.log(`  priced ${i + 1}/${rows.length} (${elapsed.toFixed(1)}s elapsed, ${(elapsed / (i + 1) * 1000).toFixed(2)}s/1000 rows)`);
    }
  }
  const elapsed = (Date.now() - t0) / 1000;
  console.log(`Pricing pass done: ${priced.length} priced, ${failures} LiveModel pricing failures, ${lambdaSolveFailures} lambda-solve failures, ${elapsed.toFixed(1)}s total.`);
  return { priced, failures, lambdaSolveFailures };
}

// ── evaluate one edge threshold against already-priced rows ───────────────
function evaluateThreshold(priced, edgePp) {
  const bets = [];
  for (const { r, overLo, underLo } of priced) {
    const overEdge = newModelEdge(overLo * 100, r.ovC);
    const underEdge = newModelEdge(underLo * 100, r.unC);
    const candidates = [
      { side: 'over', odds: r.ovC, edgePp: overEdge.edgePp },
      { side: 'under', odds: r.unC, edgePp: underEdge.edgePp },
    ].filter(c => c.edgePp != null);
    candidates.sort((a, b) => b.edgePp - a.edgePp);
    if (!candidates.length || candidates[0].edgePp < edgePp) continue;

    const chosen = candidates[0];
    const totalGoals = r.ftH + r.ftA;
    let ret;
    if (chosen.side === 'over') {
      ret = lineReturn(totalGoals, -r.ouLine, r.ovC);
    } else {
      ret = lineReturn(-totalGoals, r.ouLine, r.unC);
    }
    const win = ret > 1e-9;
    const push = Math.abs(ret) <= 1e-9;
    bets.push({ r, side: chosen.side, ret, win, push });
  }
  return bets;
}

function hitRateStats(bets) {
  const decided = bets.filter(b => !b.push);
  const wins = decided.filter(b => b.win).length;
  const wc = wilsonCI(wins, decided.length);
  return { nDecided: decided.length, nPush: bets.length - decided.length, wins, ...wc };
}

function summariseBets(bets) {
  const roiStats = meanCI(bets.map(b => b.ret));
  const hr = hitRateStats(bets);
  return { n: bets.length, roi: roiStats, hitRate: hr };
}

function bySlice(bets) {
  const out = [[], [], []];
  for (const b of bets) out[b.r.slice].push(b);
  return out.map(summariseBets);
}
function byMonth(bets) {
  const map = new Map();
  for (const b of bets) {
    if (!map.has(b.r.monthKey)) map.set(b.r.monthKey, []);
    map.get(b.r.monthKey).push(b);
  }
  const out = {};
  for (const [mk, arr] of [...map.entries()].sort()) out[mk] = summariseBets(arr);
  return out;
}
function byTier(bets) {
  const out = {};
  for (const t of TIERS) out[t] = summariseBets(bets.filter(b => b.r.tier === t));
  return out;
}
function bySide(bets) {
  return {
    over: summariseBets(bets.filter(b => b.side === 'over')),
    under: summariseBets(bets.filter(b => b.side === 'under')),
  };
}

function pct(x) { return x == null ? 'n/a' : (x * 100).toFixed(2) + '%'; }

function printSummaryBlock(label, s, nUsable) {
  const cov = nUsable ? (s.n / nUsable * 100).toFixed(2) + '%' : 'n/a';
  console.log(`  ${label}: n=${s.n} coverage=${cov} hitRate=${pct(s.hitRate.p)} [${pct(s.hitRate.lo)}, ${pct(s.hitRate.hi)}] (${s.hitRate.wins}/${s.hitRate.nDecided}, ${s.hitRate.nPush} push) ROI=${pct(s.roi.roi)} [${pct(s.roi.lo)}, ${pct(s.roi.hi)}]`);
}

async function main() {
  console.log('================================================================');
  console.log(' Strategy NEWMODEL v2 — Over/Under backtest (AH+O/U-only per-match lambda, circularity fix)');
  console.log('================================================================');
  console.log(`NEWMODEL_MIN_EDGE_PP (default threshold) = ${DEFAULT_EDGE_PP}`);
  console.log(`NEWMODEL_MC_SAMPLES = ${MC_SAMPLES}`);
  console.log(`NEWMODEL_TIER (production default gate) = ${cfg.NEWMODEL_TIER}`);
  console.log('');

  console.log('Loading rows from static/data/Bet365/*.csv ...');
  const { rows, drop } = loadRows();
  console.log(`Usable rows: ${rows.length} / ${drop.totalCsvRows} CSV rows scanned.`);
  console.log('Drop reasons:', JSON.stringify(drop, null, 2));
  console.log('');

  // ── benchmark on a small slice first ─────────────────────────────────
  const benchN = Math.min(2000, rows.length);
  console.log(`Benchmarking pricing on first ${benchN} usable rows...`);
  const benchT0 = Date.now();
  const benchResult = priceAll(rows.slice(0, benchN));
  const benchElapsed = (Date.now() - benchT0) / 1000;
  const perRow = benchElapsed / benchN;
  const estTotalMin = (perRow * rows.length) / 60;
  console.log(`Benchmark: ${benchElapsed.toFixed(1)}s for ${benchN} rows (${(perRow * 1000).toFixed(2)}ms/row).`);
  console.log(`Estimated full run (${rows.length} rows): ~${estTotalMin.toFixed(1)} minutes.`);
  console.log('');

  console.log('Running full pricing pass over all usable rows...');
  const { priced, failures, lambdaSolveFailures } = priceAll(rows);
  console.log('');

  // ── default threshold breakdowns ─────────────────────────────────────
  console.log(`=== Default threshold (${DEFAULT_EDGE_PP}pp) breakdowns ===`);
  const defaultBets = evaluateThreshold(priced, DEFAULT_EDGE_PP);
  const overall = summariseBets(defaultBets);
  printSummaryBlock('Overall', overall, priced.length);

  console.log('  -- by chronological third --');
  const slices = bySlice(defaultBets);
  slices.forEach((s, i) => printSummaryBlock(`  slice ${i}`, s, priced.filter(p => p.r.slice === i).length));

  console.log('  -- by month --');
  const months = byMonth(defaultBets);
  const priceCountByMonth = {};
  for (const p of priced) priceCountByMonth[p.r.monthKey] = (priceCountByMonth[p.r.monthKey] || 0) + 1;
  for (const [mk, s] of Object.entries(months)) printSummaryBlock(`  ${mk}`, s, priceCountByMonth[mk]);

  console.log('  -- by tier --');
  const tiers = byTier(defaultBets);
  for (const t of TIERS) printSummaryBlock(`  ${t}`, tiers[t], priced.filter(p => p.r.tier === t).length);

  console.log('  -- by side chosen --');
  const sides = bySide(defaultBets);
  printSummaryBlock('  over-side', sides.over, null);
  printSummaryBlock('  under-side', sides.under, null);

  console.log('  -- TOP+MAJOR only (production NEWMODEL_TIER default) --');
  const topMajorBets = defaultBets.filter(b => b.r.tier === 'TOP' || b.r.tier === 'MAJOR');
  const topMajorPool = priced.filter(p => p.r.tier === 'TOP' || p.r.tier === 'MAJOR').length;
  const topMajorSummary = summariseBets(topMajorBets);
  printSummaryBlock('  TOP+MAJOR', topMajorSummary, topMajorPool);
  console.log('');

  // ── sensitivity sweep ─────────────────────────────────────────────────
  console.log('=== Edge-threshold sensitivity sweep (pooled) ===');
  const sweep = {};
  for (const th of THRESHOLDS) {
    const bets = evaluateThreshold(priced, th);
    const s = summariseBets(bets);
    sweep[th] = s;
    printSummaryBlock(`  ${th}pp`, s, priced.length);
  }
  console.log('');

  // ── caveats ─────────────────────────────────────────────────────────
  const caveats = [
    'Fix applied: production (telegram/notify.js runStrategyNewModel) and this v2 backtest both now compute each match\'s own (lambda_h, lambda_a) via telegram/live_lambda_solver.js, fed ONLY that match\'s closing AH line/odds + Total Line/O-U odds — the same information the live Bet365 feed actually has. This replaces the v1/original bug where LiveModel state only carried ah_line+tl, silently falling back to lambda_lookup.json\'s bucket MEDIAN (an average over thousands of matches sharing the cell) — a near-tautological comparison against v1\'s own reported 87.9% hit rate / 61.4% ROI.',
    'Residual circularity (structural, expected): the solver fits (lambda_h, lambda_a) so the model\'s Over probability at the real TL reproduces this match\'s own DE-VIGGED closing O/U price almost exactly (by construction — see live_lambda_solver.js\'s convergence test, ~0.000pp residual in all tested cases). So the model\'s point probability is not an independent estimate — it is (up to CI shrinkage) the market\'s own price. Any "edge" measured against the RAW (vig-included) market price is therefore expected to be small or negative on average (raw implied > de-vigged ~= model p), NOT a manufactured artifact of bucket-averaging like v1\'s. A near-zero or negative edge-qualifying coverage here should be read as "no real information beyond the market\'s own closing O/U price survives", which is the honest, correct answer this rebuild exists to surface — not a sign of a bug.',
    'Non-de-vig edge check unchanged from v1: production still compares model lo against the RAW (vig-included) market-implied probability (100/odds), not a de-vigged one — see the point above for why this matters even more now that the model\'s own p is anchored to the de-vigged price.',
    'Rows where the AH+O/U-only solver does not converge/fails are EXCLUDED from pricing entirely (see rowCounts.pricingFailures/lambdaSolveFailures below) rather than falling back to the lambda_lookup.json bucket — falling back would reintroduce exactly the circularity being removed.',
    'Conclusion scope: this validates "does NEWMODEL\'s rule, as coded and now fixed, ever fire and would it have settled favorably on this historical data, using only the information a live match actually has" — coverage/ROI here are the closest available proxy to a genuine live edge check this dataset allows, but still not a true independent in-play price (the O/U price used is this match\'s own closing line, which CLAUDE.md notes is effectively what the live feed shows by HT).',
  ];
  console.log('=== Caveats ===');
  caveats.forEach(c => console.log('- ' + c));
  console.log('');

  // ── write JSON report ──────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(REPORT_DIR, `backtest_newmodel_ou_v2_${today}.json`);
  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      NEWMODEL_MIN_EDGE_PP: DEFAULT_EDGE_PP,
      NEWMODEL_MC_SAMPLES: MC_SAMPLES,
      NEWMODEL_TIER: cfg.NEWMODEL_TIER,
    },
    scaleSourceFinding: 'v2: production and this backtest both now solve a per-match (lambda_h, lambda_a) via telegram/live_lambda_solver.js from ONLY this match\'s closing AH + O/U prices (fixed rho by tier) — NOT the lambda_lookup.json bucket median (that was the v1 bug/circularity) and NOT a join against the 1X2-informed implied_lambda.js report (that would leak information the live feed does not have).',
    rowCounts: {
      totalCsvRowsScanned: drop.totalCsvRows,
      usableRows: rows.length,
      dropReasons: drop,
      pricingFailures: failures,
      lambdaSolveFailures,
      pricedRows: priced.length,
    },
    benchmark: {
      benchRows: benchN,
      benchElapsedSec: benchElapsed,
      msPerRow: perRow * 1000,
      estimatedFullRunMinutes: estTotalMin,
    },
    defaultThreshold: {
      edgePp: DEFAULT_EDGE_PP,
      overall,
      bySlice: slices,
      byMonth: months,
      byTier: tiers,
      bySide: sides,
      topMajorOnly: topMajorSummary,
    },
    sensitivitySweep: sweep,
    caveats,
  };
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));
  console.log(`Report written: ${reportPath}`);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
