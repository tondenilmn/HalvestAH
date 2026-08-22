'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// LEAGUE ANALYSIS — per-top-league edge search across three passes, ordered by
// how directly each can produce a bankable edge (see quiet-giggling-bird.md):
//
//   Pass A — market calibration: does a league's actual hit rate diverge from
//            its Bet365 closing-odds-implied probability? (BETTING_EDGE_
//            ANALYSIS.md §6's "calibration tool" — the doc's own top pick.)
//   Pass B — opening-price CLV backtest: would betting at the OPENING price
//            in this league have beaten betting at the closing price? A
//            league where ROI@open > ROI@close had a systematically
//            beatable opening line — an edge actionable before kickoff,
//            with no live/in-play timing required.
//   Pass C — per-league signal sweep (secondary, hardened): does a single
//            odds-band/movement-direction dimension raise a bet's hit rate
//            within a league? Kept from the original idea, but constrained
//            to one dimension at a time with stricter gates, since a
//            ~500-row-per-league pool cannot support a full cross-product
//            sweep without drowning in winner's-curse noise.
//
// Scoped to a small, pre-specified set of large-sample league buckets — by
// default the TOP leagues (engine.js's TOP_LEAGUE_GROUPS), or the MINOR
// leagues below via `--scope minor` — unlike the thousands of cells a
// pooled-tier sweep produces. All three passes are walk-forward validated:
// trained on the first ~11-12 months, re-measured (at the SAME segment
// definition, settled at the test rows' own real odds) on the last 3-4
// held-out months.
//
// `--scope minor` tests BETTING_EDGE_ANALYSIS.md §2's claim that soft books
// lag Pinnacle more (and are followed less closely in general) on minor
// leagues — i.e. whether the market-efficiency null result found in the top
// leagues also holds for a curated set of real, decently-sampled second-tier
// competitions (not the ~1,300-entry long tail of reserve/youth/friendly
// strings, which don't have enough rows per league to test standalone).
//
// Usage:
//   node league_analysis.js                    — all 3 passes, TOP leagues
//   node league_analysis.js --scope minor      — all 3 passes, MINOR leagues
//   node league_analysis.js --scope both       — both scopes in one run
//   node league_analysis.js --pass a           — market calibration only
//   node league_analysis.js --pass b           — CLV backtest only
//   node league_analysis.js --pass c           — signal sweep only
//   node league_analysis.js --min-n 100        — Pass C cell-size floor (default 50)
//   node league_analysis.js --min-z 2.0        — Pass C z-score floor (default 2.5)
//   node league_analysis.js --min-edge 3       — Pass C Wilson-CI-lower-bound edge floor (default 0)
//   node league_analysis.js --test-months 4    — how many trailing months to hold out (default 4)
//   node league_analysis.js --bets ahCover,overTL  — narrow Pass C's bet set
//   node league_analysis.js --goal-seasons 2   — how many recent seasons feed Section F
// ══════════════════════════════════════════════════════════════════════════════

const path = require('path');
const {
  loadDatasetDir,
  TOP_LEAGUE_GROUPS,
  pct,
  zScore,
  wilsonCI,
  avgMarketImplied,
  TL_CLUSTERS,
  BETS,
} = require('./engine');
const { buildGoalTimingProfile } = require('./goal_timing');

// Curated second-tier/minor leagues with a decent standalone sample (>=~300
// rows over the dataset's 15 months) — picked from an actual row-count sweep
// of the dataset's MAJOR-tier raw league strings, not guessed. Deliberately
// excludes reserve/youth/women's variants and the very long tail of
// low-liquidity regional leagues (a few hundred rows spread across ~1,300
// distinct raw strings isn't enough to test any of them standalone).
const MINOR_LEAGUE_GROUPS = [
  { inc: 'england championship',   exc: ['women','u21'], name: 'England Championship' },
  { inc: 'england league 1',       exc: ['women'], name: 'England League 1' },
  { inc: 'england league 2',       exc: ['women'], name: 'England League 2' },
  { inc: 'spanish la liga 2',      exc: ['women'], name: 'Spain La Liga 2' },
  { inc: 'italian serie b',        exc: ['women'], name: 'Italy Serie B' },
  { inc: 'italy serie c',          exc: ['women'], name: 'Italy Serie C' },
  { inc: 'german bundesliga 2',    exc: ['women','frauen'], name: 'Germany Bundesliga 2' },
  { inc: 'german 3.liga',          exc: ['women','frauen'], name: 'Germany 3.Liga' },
  { inc: 'france ligue 2',         exc: ['women'], name: 'France Ligue 2' },
  { inc: 'belgian pro league',     exc: ['women'], name: 'Belgium Pro League' },
  { inc: 'holland eredivisie',     exc: ['women'], name: 'Netherlands Eredivisie' },
  { inc: 'liga portugal 1',        exc: ['women'], name: 'Portugal Liga 1' },
  { inc: 'liga portugal 2',        exc: ['women'], name: 'Portugal Liga 2' },
  { inc: 'turkey super lig',       exc: ['women'], name: 'Turkey Super Lig' },
  { inc: 'ekstraklasa',            exc: ['women'], name: 'Poland Ekstraklasa' },
  { inc: 'brazil serie a',         exc: ['women'], name: 'Brazil Serie A' },
  { inc: 'brazil serie b',         exc: ['women'], name: 'Brazil Serie B' },
  { inc: 'argentine division 1',   exc: ['women'], name: 'Argentina Division 1' },
  { inc: 'usa major league soccer', exc: ['women'], name: 'USA MLS' },
  { inc: 'saudi professional league', exc: ['women'], name: 'Saudi Professional League' },
  { inc: 'denmark superliga',      exc: ['women'], name: 'Denmark Superliga' },
  { inc: 'austrian bundesliga',    exc: ['women','frauen'], name: 'Austria Bundesliga' },
  { inc: 'switzerland super league', exc: ['women'], name: 'Switzerland Super League' },
];

// Returns the canonical name from `groups` matching a row's raw league
// string, or null. Same inc/exc substring-matching shape as engine.js's
// topLeagueGroup — duplicated locally since MINOR_LEAGUE_GROUPS is specific
// to this script, not a general classification engine.js needs to expose.
function matchLeagueGroup(name, groups) {
  if (!name) return null;
  const n = name.toLowerCase();
  for (const { inc, exc, name: canonical } of groups) {
    if (n.includes(inc) && !exc.some(e => n.includes(e))) return canonical;
  }
  return null;
}

// ── CLI args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag, def) => {
  const i = args.indexOf(flag);
  return i !== -1 && args[i + 1] ? args[i + 1] : def;
};

const MIN_N_SWEEP   = parseInt(getArg('--min-n', '50'), 10);
const MIN_Z_SWEEP   = parseFloat(getArg('--min-z', '2.5'));
const MIN_EDGE      = parseFloat(getArg('--min-edge', '0'));
const TEST_MONTHS   = parseInt(getArg('--test-months', '4'), 10);
const ONLY_PASS     = (getArg('--pass', 'all') || 'all').toLowerCase();
const BET_FILTER    = getArg('--bets', null);
const GOAL_SEASONS  = parseInt(getArg('--goal-seasons', '3'), 10);
const SCOPE         = (getArg('--scope', 'top') || 'top').toLowerCase(); // 'top' | 'minor' | 'both'

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');

const MARKET_BETS = BETS.filter(b => b.marketOddsKey);
const SWEEP_BETS  = BET_FILTER ? BETS.filter(b => BET_FILTER.split(',').includes(b.k)) : BETS;

// Opening-price odds field for each market-priced bet (mirrors the
// `marketOddsKey` closing-price field already on BETS in engine.js).
const OPEN_ODDS_KEY = {
  ahCover: 'fav_oo', dogCover: 'dog_oo', overTL: 'ov_o', underTL: 'un_o',
  homeWinsFT: 'x2_home_o', awayWinsFT: 'x2_away_o', drawFT: 'x2_draw_o',
};

const LEAGUES_WITH_GOAL_DATA = new Set([
  'England Premier League', 'Spain La Liga', 'Germany Bundesliga',
  'Italy Serie A', 'France Ligue 1',
  'Belgium Pro League', 'Denmark Superliga', 'Netherlands Eredivisie',
  'Austria Bundesliga', 'Poland Ekstraklasa', 'Portugal Liga 1',
  'Switzerland Super League',
]);

// ── Settlement — extends layer_analysis.js's settleBet/tallyBucket pattern to
//    support settling at either the opening or closing line/price ──────────────
//
// IMPORTANT: engine.js's own `ahCover`/`dogCover` row fields are computed from
// SECOND-HALF-ONLY goals against the full-match line (fav_2h - dog_2h -
// fav_line) — correct for HT-conditional live 2H betting elsewhere in this
// app (static/app.js's _2H_BETS_SET treats ahCover as a 2H bet), but wrong
// for this script's blind pre-match / CLV questions, which need the FULL
// MATCH margin (fav_ft - dog_ft - line) — the actual quantity Bet365's AH
// price (fav_oc/fav_oo) settles against. Using the 2H-only figure here
// produced a spurious ~+25% "AH Cover (Dog)" ROI in an earlier run of this
// script, in every league — an artifact of settling a half-match outcome at
// a full-match price, not a real edge. `correctAhFields()` below overwrites
// each loaded row's ahCover/dogCover with the full-match version before any
// pass runs, and `settleBet` uses full-match goals directly.
function settlementFraction(margin) {
  if (margin > 0.49) return 1;
  if (margin > 0.01) return 0.5;
  if (margin > -0.49) return margin > -0.01 ? 0 : -0.5;
  return -1;
}

// Mutates each row in place: replaces the (2H-only) `ahCover`/`dogCover`
// booleans with the full-match version, and stashes the full-match margin at
// both price points for settleBet to reuse without recomputing.
function correctAhFields(rows) {
  for (const row of rows) {
    const marginClose = row.fav_ft - row.dog_ft - row.fav_line;
    const marginOpen = row.fav_lo != null ? row.fav_ft - row.dog_ft - row.fav_lo : null;
    row.ahCover = marginClose > 0.01;
    row.dogCover = marginClose < -0.01;
    row._ahMarginClose = marginClose;
    row._ahMarginOpen = marginOpen;
  }
  return rows;
}

function settleBet(betKey, row, priceSet) {
  if (betKey === 'ahCover' || betKey === 'dogCover') {
    const margin = priceSet === 'open' ? row._ahMarginOpen : row._ahMarginClose;
    if (margin == null) return null;
    return settlementFraction(betKey === 'ahCover' ? margin : -margin);
  }
  if (betKey === 'overTL' || betKey === 'underTL') {
    const tl = priceSet === 'open' ? row.tl_o : row.tl_c;
    if (tl == null) return null;
    const total = row.fav_ft + row.dog_ft;
    return settlementFraction(betKey === 'overTL' ? total - tl : tl - total);
  }
  return row[betKey] === true ? 1 : -1;
}

function priceFor(betKey, row, priceSet) {
  const b = BETS.find(x => x.k === betKey);
  const key = priceSet === 'open' ? OPEN_ODDS_KEY[betKey] : b?.marketOddsKey;
  if (!key) return null;
  const v = row[key];
  return (v != null && v > 1) ? v : null;
}

function hitPoint(f) { return f > 0 ? (f === 1 ? 1 : 0.5) : 0; }

// Settles `rows` on `betKey` at `priceSet` ('open'|'close'). Rows this bet
// can't be priced for (missing odds field, missing TL, etc.) are dropped —
// `priced` reports how many actually contributed.
function tallyBucket(rows, betKey, priceSet) {
  const entries = [];
  for (const r of rows) {
    const fraction = settleBet(betKey, r, priceSet);
    if (fraction == null) continue;
    const odds = priceFor(betKey, r, priceSet);
    if (odds == null) continue;
    entries.push({ fraction, odds });
  }
  const nonPush = entries.filter(e => e.fraction !== 0);
  const hitPts = nonPush.reduce((s, e) => s + hitPoint(e.fraction), 0);
  const hitRate = nonPush.length ? hitPts / nonPush.length * 100 : 0;
  const pnl = nonPush.reduce((s, e) => s + (
    e.fraction === 1 ? e.odds - 1 :
    e.fraction === 0.5 ? (e.odds - 1) / 2 :
    e.fraction === -0.5 ? -0.5 : -1
  ), 0);
  const roi = nonPush.length ? pnl / nonPush.length * 100 : 0;
  return { n: rows.length, priced: entries.length, nonPush: nonPush.length, hitRate, roi };
}

// ── Bands (local, mirroring layer_analysis.js — not exported from engine.js) ──
const ODDS_BANDS = [
  [null, 1.60], [1.60, 1.75], [1.75, 1.90], [1.90, 2.05],
  [2.05, 2.30], [2.30, 2.70], [2.70, null],
];
function bandLabel([lo, hi]) {
  if (lo == null) return `<${hi}`;
  if (hi == null) return `>=${lo}`;
  return `${lo}-${hi}`;
}
function inBand(v, band) {
  if (v == null || !band) return false;
  const [lo, hi] = band;
  return (lo == null || v >= lo) && (hi == null || v < hi);
}

// ── Normal-tail helper — for Pass C's "expected chance survivors" line ────────
function erf(x) {
  const sign = x < 0 ? -1 : 1; x = Math.abs(x);
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return sign * y;
}
function twoSidedTail(z) {
  const phi = 0.5 * (1 + erf(Math.abs(z) / Math.SQRT2));
  return 2 * (1 - phi);
}

// ── Data loading & grouping ───────────────────────────────────────────────────
function loadAll() {
  console.log(`Loading Bet365 dataset from ${BET365_DIR}…`);
  const rows = loadDatasetDir(BET365_DIR);
  correctAhFields(rows); // fix ahCover/dogCover to full-match margin — see note above
  console.log(`Total rows: ${rows.length}\n`);
  return rows;
}

function groupByLeagues(rows, groups) {
  const map = new Map();
  for (const r of rows) {
    const g = matchLeagueGroup(r.league, groups);
    if (!g) continue;
    if (!map.has(g)) map.set(g, []);
    map.get(g).push(r);
  }
  return map;
}

// file_label looks like "Bet365_01_25" (MM_YY) — sort chronologically and
// split off the trailing `TEST_MONTHS` as the held-out test set.
function sortLabels(labels) {
  return [...labels].sort((a, b) => {
    const ma = a.match(/_(\d{2})_(\d{2})$/), mb = b.match(/_(\d{2})_(\d{2})$/);
    if (!ma || !mb) return a.localeCompare(b);
    const ka = ma[2] + ma[1], kb = mb[2] + mb[1]; // YYMM
    return ka.localeCompare(kb);
  });
}

function splitTrainTest(rows) {
  const labels = sortLabels([...new Set(rows.map(r => r.file_label))]);
  const testLabels = new Set(labels.slice(-TEST_MONTHS));
  return {
    train: rows.filter(r => !testLabels.has(r.file_label)),
    test: rows.filter(r => testLabels.has(r.file_label)),
    trainLabels: labels.filter(l => !testLabels.has(l)),
    testLabels: [...testLabels],
  };
}

// ── Pass A — market calibration ───────────────────────────────────────────────
// Every result row carries `test` (a row predicate) so §3's held-out
// validation can re-apply the exact same segment to the test pool.
function passA(leagueRows) {
  const results = [];
  for (const b of MARKET_BETS) {
    const segments = [
      { side: null, rows: leagueRows, test: () => true },
      { side: 'HOME', rows: leagueRows.filter(r => r.fav_side === 'HOME'), test: r => r.fav_side === 'HOME' },
      { side: 'AWAY', rows: leagueRows.filter(r => r.fav_side === 'AWAY'), test: r => r.fav_side === 'AWAY' },
    ];
    for (const seg of segments) {
      const n = seg.rows.length;
      if (n < 30) continue;
      const p = pct(seg.rows, b.k);
      const mkt = avgMarketImplied(seg.rows, b.marketOddsKey);
      const gap = mkt != null ? p - mkt : null;
      const [lo, hi] = wilsonCI(p, n);
      const { roi, priced } = tallyBucket(seg.rows, b.k, 'close');
      results.push({ betKey: b.k, bet: b.label, side: seg.side, n, priced, p, mkt, gap, lo, hi, roi, test: seg.test });
    }
  }
  return results;
}

// ── Pass B — opening-price CLV backtest ───────────────────────────────────────
function passB(leagueRows) {
  const results = [];
  for (const b of MARKET_BETS) {
    const segments = [
      { label: null, test: () => true },
      { label: 'fav=HOME', test: r => r.fav_side === 'HOME' },
      { label: 'fav=AWAY', test: r => r.fav_side === 'AWAY' },
      ...Object.entries(TL_CLUSTERS).map(([label, band]) => ({ label: `TL(open) ${label}`, test: r => inBand(r.tl_o, band) })),
    ];
    for (const seg of segments) {
      const rows = leagueRows.filter(seg.test);
      const n = rows.length;
      if (n < 30) continue;
      const close = tallyBucket(rows, b.k, 'close');
      const open  = tallyBucket(rows, b.k, 'open');
      const mktOpen  = avgMarketImplied(rows, OPEN_ODDS_KEY[b.k]);
      const mktClose = avgMarketImplied(rows, b.marketOddsKey);
      const shift = (mktOpen != null && mktClose != null) ? mktClose - mktOpen : null;
      results.push({
        betKey: b.k, bet: b.label, segment: seg.label, n,
        roiOpen: open.roi, roiClose: close.roi, diff: open.roi - close.roi,
        pricedOpen: open.priced, pricedClose: close.priced, shift, test: seg.test,
      });
    }
  }
  results.sort((a, b) => b.diff - a.diff);
  return results;
}

// ── Pass C — per-league signal sweep (one dimension at a time) ────────────────
function buildDimensions() {
  return [
    { key: 'favClosingOddsBand', values: ODDS_BANDS.map(b => ({ label: bandLabel(b), test: r => inBand(r.fav_oc, b) })) },
    { key: 'tlClosingCluster', values: Object.entries(TL_CLUSTERS).map(([label, band]) => ({ label, test: r => inBand(r.tl_c, band) })) },
    { key: 'line_move', values: ['DEEPER', 'STABLE', 'SHRANK'].map(v => ({ label: v, test: r => r.line_move === v })) },
    { key: 'fav_odds_move', values: ['IN', 'STABLE', 'OUT'].map(v => ({ label: v, test: r => r.fav_odds_move === v })) },
    { key: 'dog_odds_move', values: ['IN', 'STABLE', 'OUT'].map(v => ({ label: v, test: r => r.dog_odds_move === v })) },
    { key: 'tl_move', values: ['UP', 'STABLE', 'DOWN'].map(v => ({ label: v, test: r => r.tl_move === v })) },
  ];
}

function passC(leagueRows) {
  const dims = buildDimensions();
  const results = [];
  let cellsTested = 0;
  for (const dim of dims) {
    for (const val of dim.values) {
      const cell = leagueRows.filter(val.test);
      if (cell.length < MIN_N_SWEEP) continue;
      for (const b of SWEEP_BETS) {
        cellsTested++;
        const n = cell.length;
        const p = pct(cell, b.k), bl = pct(leagueRows, b.k);
        const z = zScore(cell, leagueRows, b.k), edge = p - bl;
        const [lo] = wilsonCI(p, n);
        if (z < MIN_Z_SWEEP || (lo - bl) < MIN_EDGE) continue;
        const mktBl = b.marketOddsKey ? avgMarketImplied(cell, b.marketOddsKey) : null;
        const mktEdge = mktBl != null ? p - mktBl : null;
        results.push({
          dimension: dim.key, cell: val.label, betKey: b.k, bet: b.label,
          n, p, bl, z, edge, lo, mktEdge, test: val.test,
        });
      }
    }
  }
  results.sort((a, b) => b.z - a.z);
  const expectedSurvivors = cellsTested * twoSidedTail(MIN_Z_SWEEP);
  return { results, cellsTested, expectedSurvivors };
}

// ── §3 — held-out validation: re-apply the exact same segment to test rows ────
function validateOnTest(entry, testRows, priceSet) {
  const cell = testRows.filter(entry.test);
  const n = cell.length;
  if (!n) return { n: 0 };
  if (priceSet) {
    const { roi, priced } = tallyBucket(cell, entry.betKey, priceSet);
    return { n, priced, p: pct(cell, entry.betKey), roi };
  }
  const p = pct(cell, entry.betKey);
  const bl = pct(testRows, entry.betKey);
  return { n, p, bl, edge: p - bl };
}

// ── Report printing ────────────────────────────────────────────────────────────
function pad(v, width, right = false) {
  const s = v == null ? '—' : String(v);
  return right ? s.padStart(width) : s.padEnd(width);
}
function fmt(n, d = 1) { return n == null ? '—' : n.toFixed(d); }

function printSectionA(leagueMap, scopeLabel) {
  console.log('═'.repeat(100));
  console.log(`SECTION A — per-league row counts (scope: ${scopeLabel})`);
  console.log('═'.repeat(100));
  for (const [league, rows] of leagueMap) {
    console.log(`  ${pad(league, 28)} n=${rows.length}`);
  }
  console.log();
}

function printSectionB(perLeaguePassA) {
  console.log('═'.repeat(120));
  console.log('SECTION B — Pass A: market calibration (hit rate vs Bet365 closing-odds-implied probability)');
  console.log('Rows are flagged ** when the calibration gap is non-negative (beats the vig) at n>=100.');
  console.log('═'.repeat(120));
  console.log(`  ${pad('League', 22)} ${pad('Bet', 16)} ${pad('Side', 5)} ${pad('n', 5, true)} ${pad('hit%', 6, true)} ${pad('mkt%', 6, true)} ${pad('gap', 6, true)} ${pad('CIlo', 6, true)} ${pad('ROI@close', 9, true)}`);
  for (const { league, results } of perLeaguePassA) {
    for (const r of results) {
      const flag = (r.gap != null && r.gap >= 0 && r.n >= 100) ? ' **' : '';
      console.log(`  ${pad(league, 22)} ${pad(r.bet, 16)} ${pad(r.side || 'ALL', 5)} ${pad(r.n, 5, true)} ${pad(fmt(r.p), 6, true)} ${pad(fmt(r.mkt), 6, true)} ${pad(fmt(r.gap), 6, true)} ${pad(fmt(r.lo), 6, true)} ${pad(fmt(r.roi) + '%', 9, true)}${flag}`);
    }
  }
  console.log();
}

function printSectionC(perLeaguePassB) {
  console.log('═'.repeat(130));
  console.log('SECTION C — Pass B: opening-price CLV backtest (ROI settled at open vs at close)');
  console.log('Rows are flagged ** when ROI@open − ROI@close >= 5pp (opening price was systematically beatable).');
  console.log('═'.repeat(130));
  console.log(`  ${pad('League', 22)} ${pad('Bet', 16)} ${pad('Segment', 16)} ${pad('n', 5, true)} ${pad('ROI@open', 9, true)} ${pad('ROI@close', 9, true)} ${pad('diff', 6, true)} ${pad('shift(pp)', 9, true)}`);
  for (const { league, results } of perLeaguePassB) {
    for (const r of results.slice(0, 15)) {
      const flag = r.diff >= 5 ? ' **' : '';
      console.log(`  ${pad(league, 22)} ${pad(r.bet, 16)} ${pad(r.segment || 'ALL', 16)} ${pad(r.n, 5, true)} ${pad(fmt(r.roiOpen) + '%', 9, true)} ${pad(fmt(r.roiClose) + '%', 9, true)} ${pad(fmt(r.diff), 6, true)} ${pad(fmt(r.shift), 9, true)}${flag}`);
    }
  }
  console.log();
}

function printSectionD(perLeaguePassC) {
  console.log('═'.repeat(140));
  console.log('SECTION D — Pass C: per-league signal sweep (one dimension at a time)');
  console.log('═'.repeat(140));
  for (const { league, cellsTested, expectedSurvivors, results } of perLeaguePassC) {
    console.log(`  ${league} — cells tested: ${cellsTested}, expected chance survivors at z>=${MIN_Z_SWEEP}: ${expectedSurvivors.toFixed(2)}, actual survivors: ${results.length}`);
    console.log(`  ${pad('Dimension', 20)} ${pad('Cell', 12)} ${pad('Bet', 16)} ${pad('n', 5, true)} ${pad('hit%', 6, true)} ${pad('bl%', 6, true)} ${pad('edge', 6, true)} ${pad('z', 6, true)} ${pad('mktEdge', 8, true)}`);
    for (const r of results.slice(0, 15)) {
      console.log(`  ${pad(r.dimension, 20)} ${pad(r.cell, 12)} ${pad(r.bet, 16)} ${pad(r.n, 5, true)} ${pad(fmt(r.p), 6, true)} ${pad(fmt(r.bl), 6, true)} ${pad(fmt(r.edge), 6, true)} ${pad(fmt(r.z, 2), 6, true)} ${pad(fmt(r.mktEdge), 8, true)}`);
    }
    console.log();
  }
}

function printSectionE(validation) {
  console.log('═'.repeat(130));
  console.log('SECTION E — held-out validation (train vs test, settled at the test rows\' own real odds)');
  console.log(`Test window: last ${TEST_MONTHS} months. Pass C survivors are PROVISIONAL — small test-set n.`);
  console.log('═'.repeat(130));
  for (const { league, passAValidated, passBValidated, passCValidated } of validation) {
    console.log(`  ── ${league} ──`);
    if (passAValidated.length) {
      console.log(`  Pass A (calibration):`);
      for (const v of passAValidated) {
        console.log(`    ${pad(v.bet, 16)} ${pad(v.side || 'ALL', 5)} train: n=${v.trainN} ROI=${fmt(v.trainRoi)}%   test: n=${v.testN} ROI=${fmt(v.testRoi)}%  ${v.held ? '✓ held up' : '✗ regressed'}`);
      }
    }
    if (passBValidated.length) {
      console.log(`  Pass B (CLV, top diffs only):`);
      for (const v of passBValidated) {
        console.log(`    ${pad(v.bet, 16)} ${pad(v.segment || 'ALL', 16)} train diff: ${fmt(v.trainDiff)}pp   test: ROI@open=${fmt(v.testRoiOpen)}% ROI@close=${fmt(v.testRoiClose)}% diff=${fmt(v.testDiff)}pp  ${v.held ? '✓ held up' : '✗ regressed'}`);
      }
    }
    if (passCValidated.length) {
      console.log(`  Pass C (sweep survivors, PROVISIONAL):`);
      for (const v of passCValidated) {
        console.log(`    ${pad(v.bet, 16)} ${pad(v.dimension, 20)} ${pad(v.cell, 10)} train: n=${v.trainN} edge=${fmt(v.trainEdge)}pp   test: n=${v.testN} edge=${fmt(v.testEdge)}pp  ${v.held ? '✓ held up' : '✗ regressed'}`);
      }
    }
    console.log();
  }
}

function printSectionF(leagueMap) {
  console.log('═'.repeat(100));
  console.log(`SECTION F — goal-timing distribution (last ${GOAL_SEASONS} seasons, football-data/data/goals_time2)`);
  console.log('═'.repeat(100));
  for (const league of leagueMap.keys()) {
    if (!LEAGUES_WITH_GOAL_DATA.has(league)) {
      console.log(`  ${league}: no domestic goals_time2 file (cup competition) — skipped\n`);
      continue;
    }
    const profile = buildGoalTimingProfile(league, { seasons: GOAL_SEASONS });
    if (!profile) {
      console.log(`  ${league}: no goal-timing data found\n`);
      continue;
    }
    console.log(`  ${league} — seasons: ${profile.seasons.join(', ')}  (${profile.matchCount} matches, ${profile.totalGoals} goals)`);
    console.log(`    1H: ${fmt(profile.half.h1Pct)}%   2H: ${fmt(profile.half.h2Pct)}%`);
    const bucketLine = Object.entries(profile.bucketPct).map(([k, v]) => `${k}': ${fmt(v)}%`).join('   ');
    console.log(`    ${bucketLine}`);
    console.log();
  }
}

function groupsForScope(scope) {
  if (scope === 'minor') return MINOR_LEAGUE_GROUPS;
  if (scope === 'both') return [...TOP_LEAGUE_GROUPS, ...MINOR_LEAGUE_GROUPS];
  return TOP_LEAGUE_GROUPS;
}

// ── Main ──────────────────────────────────────────────────────────────────────
function runScope(allRows, train, test, scopeLabel, groups) {
  const trainByLeague = groupByLeagues(train, groups);
  const testByLeague = groupByLeagues(test, groups);
  const fullByLeague = groupByLeagues(allRows, groups); // for Section A/F, uses whole dataset

  printSectionA(fullByLeague, scopeLabel);

  const perLeaguePassA = [];
  const perLeaguePassB = [];
  const perLeaguePassC = [];
  const validation = [];

  for (const [league] of fullByLeague) {
    const leagueTrain = trainByLeague.get(league) || [];
    const leagueTest = testByLeague.get(league) || [];
    if (leagueTrain.length < 30) continue; // not enough train data to bother

    const runA = ONLY_PASS === 'all' || ONLY_PASS === 'a';
    const runB = ONLY_PASS === 'all' || ONLY_PASS === 'b';
    const runC = ONLY_PASS === 'all' || ONLY_PASS === 'c';

    const aResults = runA ? passA(leagueTrain) : [];
    const bResults = runB ? passB(leagueTrain) : [];
    const cRun = runC ? passC(leagueTrain) : { results: [], cellsTested: 0, expectedSurvivors: 0 };

    if (runA) perLeaguePassA.push({ league, results: aResults });
    if (runB) perLeaguePassB.push({ league, results: bResults });
    if (runC) perLeaguePassC.push({ league, ...cRun });

    if (!leagueTest.length) continue;

    const passAValidated = aResults.map(r => {
      const trainR = tallyBucket(leagueTrain.filter(r.test), r.betKey, 'close');
      const t = validateOnTest(r, leagueTest, 'close');
      return {
        bet: r.bet, side: r.side, trainN: trainR.n, trainRoi: trainR.roi,
        testN: t.n, testRoi: t.roi, held: t.n > 0 && t.roi > 0 === trainR.roi > 0 && t.roi > -5,
      };
    }).filter(v => v.testN >= 15);

    const passBValidated = bResults.filter(r => Math.abs(r.diff) >= 5).slice(0, 10).map(r => {
      const cell = leagueTest.filter(r.test);
      const testClose = tallyBucket(cell, r.betKey, 'close');
      const testOpen = tallyBucket(cell, r.betKey, 'open');
      const testDiff = testOpen.roi - testClose.roi;
      return {
        bet: r.bet, segment: r.segment, trainDiff: r.diff,
        testRoiOpen: testOpen.roi, testRoiClose: testClose.roi, testDiff,
        held: cell.length >= 15 && Math.sign(testDiff) === Math.sign(r.diff) && testDiff >= r.diff * 0.3,
      };
    });

    const passCValidated = cRun.results.slice(0, 10).map(r => {
      const t = validateOnTest(r, leagueTest, null);
      return {
        bet: r.bet, dimension: r.dimension, cell: r.cell,
        trainN: r.n, trainEdge: r.edge, testN: t.n, testEdge: t.edge,
        held: t.n >= 15 && t.edge != null && Math.sign(t.edge) === Math.sign(r.edge) && Math.abs(t.edge) >= Math.abs(r.edge) * 0.3,
      };
    }).filter(v => v.testN >= 5);

    validation.push({ league, passAValidated, passBValidated, passCValidated });
  }

  if (ONLY_PASS === 'all' || ONLY_PASS === 'a') printSectionB(perLeaguePassA);
  if (ONLY_PASS === 'all' || ONLY_PASS === 'b') printSectionC(perLeaguePassB);
  if (ONLY_PASS === 'all' || ONLY_PASS === 'c') printSectionD(perLeaguePassC);
  printSectionE(validation);
  printSectionF(fullByLeague);
}

function main() {
  const allRows = loadAll();
  const { train, test, trainLabels, testLabels } = splitTrainTest(allRows);
  console.log(`Train months: ${trainLabels.join(', ')}`);
  console.log(`Test months (held out): ${testLabels.join(', ')}\n`);

  const scopes = SCOPE === 'both' ? ['top', 'minor'] : [SCOPE];
  for (const scope of scopes) {
    console.log('\n' + '#'.repeat(100));
    console.log(`# SCOPE: ${scope.toUpperCase()}`);
    console.log('#'.repeat(100) + '\n');
    runScope(allRows, train, test, scope, groupsForScope(scope));
  }

  console.log('Reading this: Section B\'s ROI@close is what blindly betting this market at Bet365');
  console.log('closing prices all season would have returned — the honest baseline every other');
  console.log('number should beat. Section C shows whether betting EARLY (opening price) in a');
  console.log('segment beat waiting for the close. Section D is exploratory pattern-mining and');
  console.log('is the most exposed to noise — trust it only where Section E shows it held up');
  console.log('out-of-sample, and even then treat it as provisional given the small test window.');
  console.log('The MINOR scope tests whether market efficiency (or the lack of a validated edge)');
  console.log('also holds outside the top 5 leagues, per BETTING_EDGE_ANALYSIS.md §2\'s claim that');
  console.log('soft books lag more / are followed less closely on minor leagues.');
}

main();
