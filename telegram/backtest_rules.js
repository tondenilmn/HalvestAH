'use strict';
// ── Rule-based conditional betting system ─────────────────────────────────────
// Defines specific signal+bet rules (no z-score engine).
// For each rule: condition → bet → out-of-sample hit rate per month.
//
// Signal dimensions:
//   AH line range  (expected match margin)
//   HT score state (fav ahead / level / behind)
//   Goals in 1H    (open game or not)
//   TL direction   (line moved up = more goals expected)
//
// Usage:
//   node backtest_rules.js          — TOP+MAJOR filter
//   node backtest_rules.js --all    — all leagues

const path = require('path');
const { loadDatabase } = require('./engine');

const LEAGUE_TIER = process.argv.includes('--all') ? 'ALL' : 'TOP+MAJOR';
const DATA_DIR    = path.resolve(__dirname, '../static/data');

const MONTHS = [
  { label: '_01_25_',      name: 'Jan 2025' },
  { label: '_02_25_',      name: 'Feb 2025' },
  { label: '_03_25_',      name: 'Mar 2025' },
  { label: '_04_25_',      name: 'Apr 2025' },
  { label: '_05_25_',      name: 'May 2025' },
  { label: '_06_25_',      name: 'Jun 2025' },
  { label: '_09_25_',      name: 'Sep 2025' },
  { label: '_10_Pinnacle', name: 'Oct 2025' },
  { label: '_11_Pinnacle', name: 'Nov 2025' },
  { label: '_12_Pinnacle', name: 'Dec 2025' },
  { label: '_01_Pinnacle', name: 'Jan 2026' },
  { label: '_02_26_',      name: 'Feb 2026' },
];

// ── Betting rules ──────────────────────────────────────────────────────────────
// Each rule defines: when the condition fires, what bet to place.
// The engine picks the best odds column and computes P&L at those odds.
//
// fav_lc = fav closing handicap (always positive: 0.25 = fav -0.25)
// fav_ht / dog_ht = goals at half time (fav-normalised perspective)
// tl_c / tl_o = total line closing / opening

const RULES = [
  // ── 1. Moderate favourite (AH 0.5–1.0), not winning at HT ─────────────────
  {
    id: 'mod_fav_level_00',
    name: 'Moderate fav 0-0 HT  (AH 0.50–1.00, 0–0)',
    filter: r =>
      r.fav_lc >= 0.50 && r.fav_lc <= 1.00 &&
      r.fav_ht === 0 && r.dog_ht === 0,
    bets: ['over05_2H', 'favScored2H'],
  },
  {
    id: 'mod_fav_losing',
    name: 'Moderate fav losing HT  (AH 0.50–1.00, fav behind)',
    filter: r =>
      r.fav_lc >= 0.50 && r.fav_lc <= 1.00 &&
      r.fav_ht != null && r.fav_ht < r.dog_ht,
    bets: ['over05_2H', 'favScored2H'],
  },

  // ── 2. Strong favourite (AH ≥ 1.0), not winning or tied ───────────────────
  {
    id: 'strong_fav_00',
    name: 'Strong fav 0-0 HT  (AH ≥ 1.00, 0–0)',
    filter: r =>
      r.fav_lc >= 1.00 &&
      r.fav_ht === 0 && r.dog_ht === 0,
    bets: ['over05_2H', 'favScored2H', 'over15_2H'],
  },
  {
    id: 'strong_fav_losing',
    name: 'Strong fav losing/tied HT  (AH ≥ 1.00, fav not winning)',
    filter: r =>
      r.fav_lc >= 1.00 &&
      r.fav_ht != null && r.fav_ht <= r.dog_ht,
    bets: ['over05_2H', 'favScored2H', 'over15_2H'],
  },

  // ── 3. Close match (AH 0–0.5), fav winning by 1 ───────────────────────────
  {
    id: 'close_fav_winning1',
    name: 'Close match, fav +1 HT  (AH 0–0.50, fav winning by 1)',
    filter: r =>
      r.fav_lc >= 0.00 && r.fav_lc < 0.50 &&
      r.fav_ht != null && r.fav_ht - r.dog_ht === 1,
    bets: ['under15_2H'],
  },

  // ── 4. Close favourite winning by 1, TL ≤ 2.75 (low scoring game) ─────────
  {
    id: 'mod_fav_winning1_low_tl',
    name: 'Fav +1 HT, low TL  (AH 0.25–1.0, fav +1, TL ≤ 2.75)',
    filter: r =>
      r.fav_lc >= 0.25 && r.fav_lc <= 1.00 &&
      r.fav_ht != null && r.fav_ht - r.dog_ht === 1 &&
      r.tl_c != null && r.tl_c <= 2.75,
    bets: ['under15_2H'],
  },

  // ── 5. High-scoring 1H (2+ goals), any fav ────────────────────────────────
  {
    id: 'high_scoring_1H',
    name: 'High-scoring 1H  (AH 0.25–1.0, 2+ goals in 1H)',
    filter: r =>
      r.fav_lc >= 0.25 && r.fav_lc <= 1.00 &&
      r.fav_ht != null && r.dog_ht != null &&
      r.fav_ht + r.dog_ht >= 2,
    bets: ['over05_2H', 'over15_2H'],
  },

  // ── 6. TL moved up (more goals expected), 0-0 at HT ───────────────────────
  {
    id: 'tl_up_00',
    name: 'TL moved up + 0-0 HT  (AH 0.25–1.0, TL rose ≥0.13, 0–0)',
    filter: r =>
      r.fav_lc >= 0.25 && r.fav_lc <= 1.00 &&
      r.tl_c != null && r.tl_o != null && r.tl_c >= r.tl_o + 0.13 &&
      r.fav_ht === 0 && r.dog_ht === 0,
    bets: ['over05_2H', 'over15_2H'],
  },

  // ── 7. AH line moved toward fav (STEAM), 0-0 at HT ───────────────────────
  {
    id: 'steam_00',
    name: 'AH STEAM + 0-0 HT  (AH 0.25–1.0, line deeper, 0–0)',
    filter: r =>
      r.fav_lc >= 0.25 && r.fav_lc <= 1.00 &&
      r.fav_lo != null && r.fav_lc >= r.fav_lo + 0.13 &&
      r.fav_ht === 0 && r.dog_ht === 0,
    bets: ['over05_2H', 'favScored2H'],
  },

  // ── 8. AH STEAM + fav currently losing ────────────────────────────────────
  {
    id: 'steam_losing',
    name: 'AH STEAM + fav losing  (AH 0.25–1.0, line deeper, fav behind)',
    filter: r =>
      r.fav_lc >= 0.25 && r.fav_lc <= 1.00 &&
      r.fav_lo != null && r.fav_lc >= r.fav_lo + 0.13 &&
      r.fav_ht != null && r.fav_ht < r.dog_ht,
    bets: ['over05_2H', 'favScored2H'],
  },

  // ── 9. Underdog scored 1H, close/mod fav ──────────────────────────────────
  {
    id: 'dog_scored_1H',
    name: 'Underdog scored 1H  (AH 0.25–1.25, dog ≥1 at HT, game open)',
    filter: r =>
      r.fav_lc >= 0.25 && r.fav_lc <= 1.25 &&
      r.dog_ht != null && r.dog_ht >= 1 && r.fav_ht != null && r.fav_ht <= r.dog_ht,
    bets: ['over05_2H', 'over15_2H'],
  },

  // ── 10. Both teams scored 1H (1-1 or similar) ────────────────────────────
  {
    id: 'both_scored_1H',
    name: 'Both scored 1H  (any AH, both teams ≥1 goal, fav 0.25–1.0)',
    filter: r =>
      r.fav_lc >= 0.25 && r.fav_lc <= 1.00 &&
      r.fav_ht != null && r.fav_ht >= 1 &&
      r.dog_ht != null && r.dog_ht >= 1,
    bets: ['over05_2H', 'over15_2H'],
  },
];

// ── Helpers ────────────────────────────────────────────────────────────────────
function applyTier(db, tier) {
  if (tier === 'ALL')       return db;
  if (tier === 'TOP+MAJOR') return db.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
  if (tier === 'TOP')       return db.filter(r => r.league_tier === 'TOP');
  if (tier === 'MAJOR')     return db.filter(r => r.league_tier === 'MAJOR');
  return db;
}

function wilsonLower(p, n, z = 1.645) {
  if (!n) return 0;
  const phat = p / n;
  const denom = 1 + z * z / n;
  const centre = phat + z * z / (2 * n);
  const margin = z * Math.sqrt(phat * (1 - phat) / n + z * z / (4 * n * n));
  return (centre - margin) / denom;
}

function avg(arr) { return arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : 0; }
function std(arr) {
  if (arr.length < 2) return 0;
  const m = avg(arr);
  return Math.sqrt(arr.reduce((s, v) => s + (v - m) ** 2, 0) / (arr.length - 1));
}

// ── Evaluate one rule on one month ────────────────────────────────────────────
function evalRule(rule, betKey, testRows, histDb) {
  // Test set: matches satisfying the rule condition in this month
  const testMatches = testRows.filter(rule.filter);
  if (!testMatches.length) return null;

  // Out-of-sample hit rate
  const hits     = testMatches.filter(r => r[betKey] === true).length;
  const hitPct   = hits / testMatches.length * 100;

  // Historical probability (from prior months)
  const histMatches = histDb.filter(rule.filter);
  const histHits    = histMatches.filter(r => r[betKey] === true).length;
  const histPct     = histMatches.length ? histHits / histMatches.length * 100 : 0;

  // Conservative minimum odds = 1/Wilson_lower
  const wl       = wilsonLower(histHits, histMatches.length);
  const moFair   = histPct > 0 ? 100 / histPct : null;    // 1/p
  const moSafe   = wl      > 0 ? 1 / wl        : null;    // 1/CI_lower

  return {
    n:        testMatches.length,
    hits,     hitPct,
    histN:    histMatches.length,
    histPct,
    moFair,   moSafe,
  };
}

// ── Main ───────────────────────────────────────────────────────────────────────
function main() {
  console.log(`\nLoading full database from ${DATA_DIR}…`);
  const rawDb  = loadDatabase(DATA_DIR);
  const fullDb = applyTier(rawDb, LEAGUE_TIER);
  console.log(`Total rows: ${rawDb.length}  (after tier filter: ${fullDb.length})\n`);

  // For each rule, accumulate out-of-sample data per month
  const results = {}; // key = rule.id + ':' + betKey

  for (const rule of RULES) {
    for (const betKey of rule.bets) {
      const key = `${rule.id}:${betKey}`;
      results[key] = {
        rule: rule.name,
        bet:  betKey,
        monthly: [],   // { name, n, hits, hitPct, histPct, moFair, moSafe }
        totN:   0,
        totHits: 0,
      };
    }
  }

  for (const { label, name } of MONTHS) {
    const testRows = fullDb.filter(r =>  r.file_label.includes(label));
    const histDb   = fullDb.filter(r => !r.file_label.includes(label));
    if (!testRows.length) continue;

    for (const rule of RULES) {
      for (const betKey of rule.bets) {
        const key = `${rule.id}:${betKey}`;
        const ev  = evalRule(rule, betKey, testRows, histDb);
        if (!ev) continue;
        results[key].monthly.push({ name, ...ev });
        results[key].totN    += ev.n;
        results[key].totHits += ev.hits;
      }
    }
  }

  // ── Report ─────────────────────────────────────────────────────────────────
  console.log('═'.repeat(100));
  console.log(`RULE-BASED SYSTEM RESULTS  (tier=${LEAGUE_TIER}  ·  12 months out-of-sample)`);
  console.log('  Bet: out-of-sample hit rate over all months combined + month-by-month stability');
  console.log('  Fair odds = 1/hist_p  ·  Safe odds = 1/Wilson_CI_lower');
  console.log('═'.repeat(100));

  // Sort by overall hit rate descending
  const summary = Object.values(results)
    .filter(r => r.totN >= 100)
    .map(r => {
      const hitPct    = r.totN ? r.totHits / r.totN * 100 : 0;
      const monthly   = r.monthly;
      const monthHits = monthly.map(m => m.hitPct);
      const avgHist   = avg(monthly.map(m => m.histPct));
      // Most recent hist-based fair odds (from last month's history)
      const last      = monthly[monthly.length - 1];
      const moFair    = last ? last.moFair  : null;
      const moSafe    = last ? last.moSafe  : null;
      return { ...r, hitPct, stdDev: std(monthHits), avgHist, moFair, moSafe, monthly };
    })
    .sort((a, b) => b.hitPct - a.hitPct);

  for (const s of summary) {
    const edge    = s.hitPct - s.avgHist;
    const beOdds  = s.hitPct > 0 ? (100 / s.hitPct).toFixed(2) : '—';
    const profStr = s.hitPct > 0 && s.moSafe
      ? (1 / (s.hitPct / 100) <= s.moSafe ? '  ← PROFITABLE at safe odds' : '')
      : '';

    console.log(`\n${s.rule}`);
    console.log(`  Bet: ${s.bet.padEnd(20)}  n=${s.totN}  hit=${s.hitPct.toFixed(1)}%  hist=${s.avgHist.toFixed(1)}%  edge=${(edge >= 0 ? '+' : '') + edge.toFixed(1)}pp  σ=${s.stdDev.toFixed(1)}%`);
    console.log(`  Fair odds: ${s.moFair ? s.moFair.toFixed(2) : '—'}   Safe odds: ${s.moSafe ? s.moSafe.toFixed(2) : '—'}   BE odds: ${beOdds}${profStr}`);

    // Month-by-month sparkline
    const monthLine = s.monthly.map(m => {
      const pct = m.hitPct.toFixed(0).padStart(4);
      return `${m.name.slice(0,3).slice(-3)}'${m.name.slice(-2)}:${pct}%`;
    }).join('  ');
    console.log(`  By month:  ${monthLine}`);
  }

  // ── Shortlist: consistently profitable candidates ──────────────────────────
  console.log('\n\n' + '═'.repeat(72));
  console.log('CANDIDATE RULES  (hit% stable ± ≤8%, n ≥ 200, BE odds ≤ safe odds)');
  console.log('═'.repeat(72));

  const candidates = summary.filter(s => {
    if (s.totN < 200)           return false;
    if (s.stdDev > 8)           return false;
    if (!s.moSafe)              return false;
    const beOdds = 100 / s.hitPct;
    return beOdds <= s.moSafe; // profitable at safe odds
  });

  if (!candidates.length) {
    console.log('\n  No rules pass all filters.\n');
    // Show nearest misses
    console.log('  Nearest misses (n≥200, σ≤10%):');
    const nearMiss = summary
      .filter(s => s.totN >= 200 && s.stdDev <= 10)
      .slice(0, 8);
    for (const s of nearMiss) {
      const beOdds = (100 / s.hitPct).toFixed(2);
      const gap    = s.moSafe ? (parseFloat(beOdds) - s.moSafe).toFixed(2) : '—';
      console.log(
        `  ${s.rule.padEnd(60).slice(0,60)}  bet=${s.bet.padEnd(18)}` +
        `  hit=${s.hitPct.toFixed(1)}%  BE=${beOdds}  safe=${s.moSafe ? s.moSafe.toFixed(2) : '—'}  gap=${gap}`
      );
    }
  } else {
    for (const c of candidates) {
      console.log(`\n  ✓ ${c.rule}`);
      console.log(`    Bet          : ${c.bet}`);
      console.log(`    Hit rate     : ${c.hitPct.toFixed(1)}%  (σ = ${c.stdDev.toFixed(1)}%  over ${MONTHS.length} months)`);
      console.log(`    Hist base    : ${c.avgHist.toFixed(1)}%   edge: ${(c.hitPct - c.avgHist) >= 0 ? '+' : ''}${(c.hitPct - c.avgHist).toFixed(1)}pp`);
      console.log(`    Fair odds    : ${c.moFair ? c.moFair.toFixed(2) : '—'}  (1/p)`);
      console.log(`    Safe odds    : ${c.moSafe ? c.moSafe.toFixed(2) : '—'}  (1/Wilson_lower)  ← minimum to accept`);
      console.log(`    Break-even   : ${(100 / c.hitPct).toFixed(2)}`);
      console.log(`    Sample size  : ${c.totN} out-of-sample matches`);
    }
  }
  console.log('');
}

main();
