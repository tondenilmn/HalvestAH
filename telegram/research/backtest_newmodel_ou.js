// telegram/research/backtest_newmodel_ou.js
//
// Faithful backtest of the DEPLOYED Telegram Strategy NEWMODEL's Over/Under
// decision rule (telegram/notify.js `runStrategyNewModel`, ~lines 1305-1413)
// against every historical match in static/data/Bet365/*.csv (~240k rows),
// using each match's own real closing Total Line + Over/Under odds as the
// market price this backtest checks against.
//
// This is NOT a hypothetical improvement — it replays production's exact
// state-building, pricing call, and edge/gate logic verbatim, including a
// known limitation: production does not pass lambda_h/lambda_a into the
// LiveModel state, so static/live_model.js's _normState() falls back
// internally to lambdaFromLookup() (the lambda_lookup.json bucket median),
// NOT a per-match Dixon-Coles fit. This script replicates that exactly —
// it does NOT join against any per-match implied-lambda report.
//
// See the `caveats` field in the emitted JSON report (and the console
// banner below) for the circularity + non-de-vig limitations that mean a
// good result here is necessary but not sufficient evidence of a real,
// exploitable live edge.
//
// Run: node telegram/research/backtest_newmodel_ou.js

'use strict';

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const { classifyLeague } = require('../engine.js');
const LM = require('../../static/live_model.js');
const cfg = require('../config.js');

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

      const league = r['League'] || '';
      const tier = classifyLeague(league);
      const home = r['Home Team'] || '';
      const away = r['Away Team'] || '';

      rows.push({
        date: d, dateStr, league, tier, home, away,
        htH, htA, ftH, ftA,
        ahHc, ouLine, ovC, unC,
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
  const t0 = Date.now();
  for (let i = 0; i < rows.length; i++) {
    const r = rows[i];
    const state = {
      ah_line: r.ahHc,
      tl: r.ouLine,
      tier: r.tier,
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
  console.log(`Pricing pass done: ${priced.length} priced, ${failures} pricing failures, ${elapsed.toFixed(1)}s total.`);
  return { priced, failures };
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
  console.log(' Strategy NEWMODEL — Over/Under backtest (production decision rule)');
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
  const { priced, failures } = priceAll(rows);
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
    'Scale-source finding: production does NOT pass lambda_h/lambda_a into the LiveModel state for NEWMODEL — only ah_line and tl are set, so static/live_model.js\'s _normState() falls back internally to lambdaFromLookup() (the lambda_lookup.json bucket median), NOT a per-match Dixon-Coles fit. This script replicates that exactly (no lambda_h/lambda_a passed, no join against any per-match implied-lambda report).',
    'Circularity: this backtest checks NEWMODEL\'s Over/Under decision against the SAME closing Total Line + closing Over/Under odds that lambda_lookup.json\'s bucket scale was itself built from (aggregated across historical closing-odds-implied fits) — so there is a real risk this looks better than a genuine live edge would be, since the model\'s scale is anchored to buckets of the same closing market it is being checked against, and the "market price" it is compared to is that same match\'s own closing odds (not a truly independent later in-play quote). Per CLAUDE.md, the live feed\'s O/U fields ARE effectively the closing line by the time a match reaches HT, so this part is a faithful replay of what the live strategy actually checks, not an approximation.',
    'Non-de-vig edge check: production compares the model probability against the RAW (vig-included) market-implied probability (100/odds), not a de-vigged one. This sets a lower bar than a properly de-vigged edge check would, separate from the circularity issue above.',
    'Conclusion scope: this validates "does NEWMODEL\'s rule, as coded, ever fire and would it have settled favorably on this historical data" — it does NOT by itself prove a genuine, exploitable live edge, because of the two caveats above.',
  ];
  console.log('=== Caveats ===');
  caveats.forEach(c => console.log('- ' + c));
  console.log('');

  // ── write JSON report ──────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(REPORT_DIR, `backtest_newmodel_ou_${today}.json`);
  const report = {
    generatedAt: new Date().toISOString(),
    config: {
      NEWMODEL_MIN_EDGE_PP: DEFAULT_EDGE_PP,
      NEWMODEL_MC_SAMPLES: MC_SAMPLES,
      NEWMODEL_TIER: cfg.NEWMODEL_TIER,
    },
    scaleSourceFinding: 'Production passes only ah_line + tl into LiveModel state for NEWMODEL; lambda_h/lambda_a are NOT set, so _normState() falls back to lambdaFromLookup() (bucket median), not a per-match Dixon-Coles fit. This backtest replicates that exactly.',
    rowCounts: {
      totalCsvRowsScanned: drop.totalCsvRows,
      usableRows: rows.length,
      dropReasons: drop,
      pricingFailures: failures,
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
