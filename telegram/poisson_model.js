'use strict';
// ══════════════════════════════════════════════════════════════════════════════
// POISSON PRICING MODEL — a genuinely different edge source than anything else
// in telegram/*.js: instead of asking "does this historical filter/league beat
// its own baseline" (league_analysis.js, layer_analysis.js, L123), this builds
// an independent, match-specific fair-odds estimate from each team's own
// attack/defense scoring rates, then checks whether Bet365's price diverges
// from that estimate — and whether bigger divergences actually win more.
//
// Model (standard simplified independent-Poisson goal model, no Dixon-Coles
// low-score correlation adjustment):
//   λ_home = (HomeTeam avg goals scored at home) * (AwayTeam avg goals
//             conceded away) / (league avg home goals)
//   λ_away = (AwayTeam avg goals scored away) * (HomeTeam avg goals
//             conceded at home) / (league avg away goals)
// Team/league rates are WALK-FORWARD: computed only from that team/league's
// matches strictly BEFORE the match being priced (a running per-league,
// per-team accumulator updated match-by-match in chronological order) — this
// is what makes every prediction genuinely out-of-sample by construction,
// unlike a block train/test split. Matches before a team has enough prior
// history (--min-team-home / --min-team-away) are skipped (cold start).
//
// From λ_home/λ_away, a Poisson(h,a) grid gives model probabilities for 1X2,
// the match's actual closing Asian Handicap line (home/away cover, with
// proper push handling incl. quarter lines), and the actual closing Total
// Line (over/under). Comparing those to the market's closing-odds-implied
// probability gives a per-bet "model edge" in pp. Bets are bucketed by edge
// size and their REALIZED hit-rate/ROI at the actual market price is
// reported — if the model carries real information, bigger edge buckets
// should show better ROI; if it's just noise, ROI should be flat/negative
// across buckets regardless of edge size (BETTING_EDGE_ANALYSIS.md §8's core
// question, applied to a model instead of a historical filter).
//
// Usage:
//   node poisson_model.js                       — @ closing price, top+minor leagues
//   node poisson_model.js --price open          — @ OPENING price + Section D
//                                                  (movement-confirmation diagnostic)
//   node poisson_model.js --leagues top          — top 5 + UEFA comps only
//   node poisson_model.js --leagues minor        — minor leagues only
//   node poisson_model.js --markets homeAH,overTL  — narrow reported markets
//   node poisson_model.js --min-team-home 6 --min-team-away 6  — cold-start floor
//   node poisson_model.js --min-league-n 60      — league-average stability floor
//
// --price open is the realistic, actionable version of this question ("if I
// only ever see the opening price, does the model tell me whether it's worth
// betting, and which way the line is about to move") — --price close (the
// default) is the retrospective calibration question ("was Bet365's final
// price wrong"), useful for judging the model's raw accuracy but not
// something you can act on before the event.
// ══════════════════════════════════════════════════════════════════════════════

const path = require('path');
const {
  loadDatasetDir,
  topLeagueGroup,
  TOP_LEAGUE_GROUPS,
  wilsonCI,
} = require('./engine');

// Same curated minor-league set as league_analysis.js (duplicated rather than
// imported — league_analysis.js runs its main() on require, so it isn't a
// clean importable module; this mirrors the existing repo convention of each
// backtest script keeping its own small local constants, e.g. ODDS_BANDS is
// duplicated across layer_analysis.js and league_analysis.js already).
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

function matchGroup(name, groups) {
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
const LEAGUE_SCOPE   = (getArg('--leagues', 'both') || 'both').toLowerCase(); // top|minor|both
const MIN_TEAM_HOME  = parseInt(getArg('--min-team-home', '5'), 10);
const MIN_TEAM_AWAY  = parseInt(getArg('--min-team-away', '5'), 10);
const MIN_LEAGUE_N   = parseInt(getArg('--min-league-n', '40'), 10);
const MARKET_FILTER  = getArg('--markets', null);
// 'close' (default) backtests against the closing price — the original
// calibration question ("was Bet365's final price wrong"). 'open' backtests
// against the OPENING price instead — the realistic, actionable question
// ("if I'd bet the moment lines opened, using only the model, would that
// have worked, and does the model's edge at open predict which way the
// line then moves before kickoff").
const PRICE_SET      = (getArg('--price', 'close') || 'close').toLowerCase();
const MAX_GOALS      = 9;
const LAMBDA_MIN     = 0.15;
const LAMBDA_MAX     = 5.0;

const BET365_DIR = process.env.BET365_DIR || path.resolve(__dirname, '../static/data/Bet365');

function leagueGroupFor(name) {
  if (LEAGUE_SCOPE !== 'minor') {
    const t = topLeagueGroup(name);
    if (t) return t;
  }
  if (LEAGUE_SCOPE !== 'top') {
    const m = matchGroup(name, MINOR_LEAGUE_GROUPS);
    if (m) return m;
  }
  return null;
}

// ── Poisson grid ──────────────────────────────────────────────────────────────
function factorial(n) { let f = 1; for (let i = 2; i <= n; i++) f *= i; return f; }
const FACT = Array.from({ length: MAX_GOALS + 2 }, (_, i) => factorial(i));
function poissonPmf(k, lambda) { return Math.exp(-lambda) * Math.pow(lambda, k) / FACT[k]; }

function buildGrid(lh, la) {
  const grid = [];
  for (let h = 0; h <= MAX_GOALS; h++) {
    const row = new Array(MAX_GOALS + 1);
    const ph = poissonPmf(h, lh);
    for (let a = 0; a <= MAX_GOALS; a++) row[a] = ph * poissonPmf(a, la);
    grid.push(row);
  }
  return grid;
}

// Effective win probability (push mass removed from the denominator) for
// `marginFn(h,a) > line`. `line` must already be a "clean" (integer or .5)
// line — quarter lines are handled one level up by effProb().
function effProbClean(grid, marginFn, line) {
  let win = 0, push = 0;
  for (let h = 0; h <= MAX_GOALS; h++) {
    for (let a = 0; a <= MAX_GOALS; a++) {
      const p = grid[h][a];
      const m = marginFn(h, a) - line;
      if (m > 0.01) win += p;
      else if (m > -0.01) push += p;
    }
  }
  return (1 - push) > 0 ? win / (1 - push) : null;
}

// Handles quarter lines (x.25/x.75) as a 50/50 split between the two
// adjacent half/whole lines — the standard Asian handicap/total quarter-line
// convention (approximated here as an average of the two win probabilities,
// not the exact split-stake payout structure — fine for a value-scan).
function isQuarterLine(line) { return Math.abs(Math.round(line * 4)) % 2 === 1; }
function effProb(grid, marginFn, line) {
  if (!isQuarterLine(line)) return effProbClean(grid, marginFn, line);
  const lo = effProbClean(grid, marginFn, line - 0.25);
  const hi = effProbClean(grid, marginFn, line + 0.25);
  if (lo == null) return hi;
  if (hi == null) return lo;
  return (lo + hi) / 2;
}

// ── Reconstruct home/away-framed fields from engine.js's fav/dog-oriented row ──
// engine.js's processRow reorients everything around the favourite for its
// own bet-scoring purposes and doesn't keep raw home/away odds/goals — but
// they're fully recoverable from fav_side + the fav/dog fields it does keep.
function homeGoals(row) { return row.fav_side === 'HOME' ? row.fav_ft : row.dog_ft; }
function awayGoals(row) { return row.fav_side === 'HOME' ? row.dog_ft : row.fav_ft; }
function homeLineClosing(row) { return row.fav_side === 'HOME' ? row.fav_line : -row.fav_line; }
function homeOddsClosing(row) { return row.fav_side === 'HOME' ? row.fav_oc : row.dog_oc; }
function awayOddsClosing(row) { return row.fav_side === 'HOME' ? row.dog_oc : row.fav_oc; }
// Opening-price equivalents — the only prices actually available at the
// moment you'd place a bet. fav_lo is unsnapped (not restricted to
// VALID_LINES like fav_line), matching what a real opening line looks like.
function homeLineOpening(row) { return row.fav_lo == null ? null : (row.fav_side === 'HOME' ? row.fav_lo : -row.fav_lo); }
function homeOddsOpening(row) { return row.fav_side === 'HOME' ? row.fav_oo : row.dog_oo; }
function awayOddsOpening(row) { return row.fav_side === 'HOME' ? row.dog_oo : row.fav_oo; }
// Home/away-framed odds-movement direction — engine.js's fav_odds_move/
// dog_odds_move are fav/dog-oriented; re-map to home/away so "IN" always
// means "this side's odds shortened between open and close" regardless of
// which side happened to be the pre-match favourite.
function homeOddsMove(row) { return row.fav_side === 'HOME' ? row.fav_odds_move : row.dog_odds_move; }
function awayOddsMove(row) { return row.fav_side === 'HOME' ? row.dog_odds_move : row.fav_odds_move; }

// ── Settlement (mirrors league_analysis.js's approach, home/away-framed) ─────
function settlementFraction(margin) {
  if (margin > 0.49) return 1;
  if (margin > 0.01) return 0.5;
  if (margin > -0.49) return margin > -0.01 ? 0 : -0.5;
  return -1;
}
function hitPoint(f) { return f > 0 ? (f === 1 ? 1 : 0.5) : 0; }

// ── Market definitions: how to get modelProb, marketImplied, the actual
//    settlement fraction, and a movement-confirmation signal for each of the
//    7 markets tested — parameterized by which price snapshot ('open' or
//    'close') is being treated as "the market" to compare/bet against.
//    `confirmMove` is only meaningful for priceSet==='open': did the price
//    subsequently move (open->close) in the direction the model favoured?
function buildMarkets(row, grid, priceSet) {
  const hg = homeGoals(row), ag = awayGoals(row);
  const homeLine = priceSet === 'open' ? homeLineOpening(row) : homeLineClosing(row);
  const tl = priceSet === 'open' ? row.tl_o : row.tl_c;
  const x2Home = priceSet === 'open' ? row.x2_home_o : row.x2_home_c;
  const x2Draw = priceSet === 'open' ? row.x2_draw_o : row.x2_draw_c;
  const x2Away = priceSet === 'open' ? row.x2_away_o : row.x2_away_c;
  const homeOdds = priceSet === 'open' ? homeOddsOpening(row) : homeOddsClosing(row);
  const awayOdds = priceSet === 'open' ? awayOddsOpening(row) : awayOddsClosing(row);
  const ovOdds = priceSet === 'open' ? row.ov_o : row.ov_c;
  const unOdds = priceSet === 'open' ? row.un_o : row.un_c;
  const markets = [];

  markets.push({
    key: 'homeWin', label: 'Home Win',
    model: () => { let s = 0; for (let h = 0; h <= MAX_GOALS; h++) for (let a = 0; a < h; a++) s += grid[h][a]; return s; },
    marketOdds: x2Home,
    fraction: hg > ag ? 1 : -1,
    confirmMove: homeOddsMove(row) === 'IN',
  });
  markets.push({
    key: 'draw', label: 'Draw',
    model: () => { let s = 0; for (let h = 0; h <= MAX_GOALS; h++) s += grid[h][h]; return s; },
    marketOdds: x2Draw,
    fraction: hg === ag ? 1 : -1,
    confirmMove: null, // no clean draw-specific movement field
  });
  markets.push({
    key: 'awayWin', label: 'Away Win',
    model: () => { let s = 0; for (let h = 0; h <= MAX_GOALS; h++) for (let a = h + 1; a <= MAX_GOALS; a++) s += grid[h][a]; return s; },
    marketOdds: x2Away,
    fraction: ag > hg ? 1 : -1,
    confirmMove: awayOddsMove(row) === 'IN',
  });

  if (homeLine != null) {
    markets.push({
      key: 'homeAH', label: 'Home AH Cover',
      model: () => effProb(grid, (h, a) => h - a, homeLine),
      marketOdds: homeOdds,
      fraction: settlementFraction((hg - ag) - homeLine),
      confirmMove: homeOddsMove(row) === 'IN',
    });
    markets.push({
      key: 'awayAH', label: 'Away AH Cover',
      model: () => effProb(grid, (h, a) => a - h, -homeLine),
      marketOdds: awayOdds,
      fraction: settlementFraction((ag - hg) + homeLine),
      confirmMove: awayOddsMove(row) === 'IN',
    });
  }

  if (tl != null) {
    markets.push({
      key: 'overTL', label: 'Over TL',
      model: () => effProb(grid, (h, a) => h + a, tl),
      marketOdds: ovOdds,
      fraction: settlementFraction((hg + ag) - tl),
      confirmMove: row.over_move === 'IN',
    });
    markets.push({
      key: 'underTL', label: 'Under TL',
      model: () => effProb(grid, (h, a) => -(h + a), -tl),
      marketOdds: unOdds,
      fraction: settlementFraction(tl - (hg + ag)),
      confirmMove: row.under_move === 'IN',
    });
  }

  return MARKET_FILTER ? markets.filter(m => MARKET_FILTER.split(',').includes(m.key)) : markets;
}

// ── Walk-forward team/league rolling stats ───────────────────────────────────
function newTeamStats() { return { homeGF: 0, homeGA: 0, homeN: 0, awayGF: 0, awayGA: 0, awayN: 0 }; }
function newLeagueStats() { return { homeGoals: 0, awayGoals: 0, n: 0 }; }

function clampLambda(l) { return Math.max(LAMBDA_MIN, Math.min(LAMBDA_MAX, l)); }

// Processes one league's matches (already sorted chronologically), returning
// a flat list of { market, edge, fraction, odds, date } entries — one per
// (match, market) pair where a prediction was possible.
function runLeagueWalkForward(leagueRows) {
  const teams = new Map();
  const league = newLeagueStats();
  const entries = [];

  const teamKey = (name) => name; // already scoped to one league's row pool

  for (const row of leagueRows) {
    const home = teamKey(row.home_team), away = teamKey(row.away_team);
    if (!teams.has(home)) teams.set(home, newTeamStats());
    if (!teams.has(away)) teams.set(away, newTeamStats());
    const hs = teams.get(home), as = teams.get(away);

    const ready = hs.homeN >= MIN_TEAM_HOME && as.awayN >= MIN_TEAM_AWAY && league.n >= MIN_LEAGUE_N;

    if (ready) {
      const avgHomeGoals = league.homeGoals / league.n;
      const avgAwayGoals = league.awayGoals / league.n;
      const homeAttack = hs.homeGF / hs.homeN;   // this team's own avg home goals scored
      const awayDefense = as.awayGA / as.awayN;  // away team's avg goals conceded while away
      const awayAttack = as.awayGF / as.awayN;
      const homeDefense = hs.homeGA / hs.homeN;

      const lh = clampLambda((homeAttack * awayDefense) / (avgHomeGoals || 1));
      const la = clampLambda((awayAttack * homeDefense) / (avgAwayGoals || 1));
      const grid = buildGrid(lh, la);

      for (const m of buildMarkets(row, grid, PRICE_SET)) {
        if (m.marketOdds == null || m.marketOdds <= 1) continue;
        const modelP = m.model();
        if (modelP == null) continue;
        const marketP = 100 / m.marketOdds;
        const edge = modelP * 100 - marketP;
        entries.push({ market: m.key, label: m.label, edge, fraction: m.fraction, odds: m.marketOdds, date: row.date, confirmMove: m.confirmMove });
      }
    }

    // Update rolling stats AFTER prediction — this row's own result must not
    // leak into the prediction it was just used to evaluate.
    const hg = homeGoals(row), ag = awayGoals(row);
    hs.homeGF += hg; hs.homeGA += ag; hs.homeN += 1;
    as.awayGF += ag; as.awayGA += hg; as.awayN += 1;
    league.homeGoals += hg; league.awayGoals += ag; league.n += 1;
  }

  return entries;
}

// ── Bucketing & reporting ─────────────────────────────────────────────────────
const EDGE_BUCKETS = [
  { label: '<0 (model dislikes)', test: e => e < 0 },
  { label: '0-3pp',  test: e => e >= 0 && e < 3 },
  { label: '3-6pp',  test: e => e >= 3 && e < 6 },
  { label: '6-10pp', test: e => e >= 6 && e < 10 },
  { label: '10-15pp', test: e => e >= 10 && e < 15 },
  { label: '15pp+',  test: e => e >= 15 },
];

function tally(entries) {
  const nonPush = entries.filter(e => e.fraction !== 0);
  const hitPts = nonPush.reduce((s, e) => s + hitPoint(e.fraction), 0);
  const hitRate = nonPush.length ? hitPts / nonPush.length * 100 : 0;
  const pnl = nonPush.reduce((s, e) => s + (
    e.fraction === 1 ? e.odds - 1 :
    e.fraction === 0.5 ? (e.odds - 1) / 2 :
    e.fraction === -0.5 ? -0.5 : -1
  ), 0);
  const roi = nonPush.length ? pnl / nonPush.length * 100 : 0;
  const [lo, hi] = wilsonCI(hitRate, nonPush.length);
  return { n: entries.length, nonPush: nonPush.length, hitRate, roi, lo, hi };
}

function fmt(n, d = 1) { return n == null ? '—' : n.toFixed(d); }
function pad(v, w, right = false) { const s = v == null ? '—' : String(v); return right ? s.padStart(w) : s.padEnd(w); }

// Only meaningful when PRICE_SET==='open': of the matches where the model
// liked a side at the opening price, what fraction of the time did the
// price actually move toward that side (odds shortened) before closing?
// Compared against the unconditional base rate of "odds shortened" across
// ALL matches with a movement signal (not just model-flagged ones) — if the
// model has real information about where smart money will push the line,
// the flagged-bucket rate should clear that base rate, and should climb
// with edge size.
function printMovementConfirmation(entries) {
  const withSignal = entries.filter(e => e.confirmMove != null);
  const baseline = withSignal.length ? withSignal.filter(e => e.confirmMove).length / withSignal.length * 100 : 0;

  console.log('═'.repeat(100));
  console.log(`SECTION D — does the model's edge AT OPEN predict which way the price moves?`);
  console.log(`Unconditional base rate of "odds shortened toward this side" across all matches: ${fmt(baseline)}%`);
  console.log('═'.repeat(100));
  console.log(`  ${pad('Edge bucket', 22)} ${pad('n', 6, true)} ${pad('% moved toward model side', 26, true)}`);
  for (const bucket of EDGE_BUCKETS) {
    const bucketEntries = withSignal.filter(e => bucket.test(e.edge));
    const rate = bucketEntries.length ? bucketEntries.filter(e => e.confirmMove).length / bucketEntries.length * 100 : null;
    const [lo] = bucketEntries.length ? wilsonCI(rate, bucketEntries.length) : [null];
    console.log(`  ${pad(bucket.label, 22)} ${pad(bucketEntries.length, 6, true)} ${pad(fmt(rate) + '%  (CIlo ' + fmt(lo) + '%)', 26, true)}`);
  }
  console.log();
}

function printBucketTable(title, entries) {
  console.log('═'.repeat(100));
  console.log(title);
  console.log('═'.repeat(100));
  console.log(`  ${pad('Edge bucket', 22)} ${pad('n', 6, true)} ${pad('nonPush', 8, true)} ${pad('hit%', 6, true)} ${pad('CIlo', 6, true)} ${pad('ROI', 8, true)}`);
  for (const bucket of EDGE_BUCKETS) {
    const bucketEntries = entries.filter(e => bucket.test(e.edge));
    const t = tally(bucketEntries);
    console.log(`  ${pad(bucket.label, 22)} ${pad(t.n, 6, true)} ${pad(t.nonPush, 8, true)} ${pad(fmt(t.hitRate), 6, true)} ${pad(fmt(t.lo), 6, true)} ${pad(fmt(t.roi) + '%', 8, true)}`);
  }
  console.log();
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  console.log(`Loading Bet365 dataset from ${BET365_DIR}…`);
  const rows = loadDatasetDir(BET365_DIR);
  console.log(`Total rows: ${rows.length}`);
  console.log(`League scope: ${LEAGUE_SCOPE}   Cold-start floor: home>=${MIN_TEAM_HOME} away>=${MIN_TEAM_AWAY}   League-avg floor: n>=${MIN_LEAGUE_N}\n`);

  const byLeague = new Map();
  for (const r of rows) {
    const g = leagueGroupFor(r.league);
    if (!g) continue;
    if (!byLeague.has(g)) byLeague.set(g, []);
    byLeague.get(g).push(r);
  }

  const allEntries = [];
  const perLeague = [];

  for (const [league, leagueRows] of byLeague) {
    leagueRows.sort((a, b) => a.date.localeCompare(b.date));
    const entries = runLeagueWalkForward(leagueRows);
    perLeague.push({ league, n: leagueRows.length, predictions: entries.length });
    allEntries.push(...entries);
  }

  console.log('═'.repeat(100));
  console.log('SECTION A — per-league match counts and predictions made (after cold-start burn-in)');
  console.log('═'.repeat(100));
  for (const { league, n, predictions } of perLeague.sort((a, b) => b.n - a.n)) {
    console.log(`  ${pad(league, 26)} matches=${String(n).padStart(4)}   predictions(all markets)=${predictions}`);
  }
  console.log();

  printBucketTable(`SECTION B — POOLED: model edge bucket vs realized hit-rate/ROI @ ${PRICE_SET} price (all markets, all leagues)`, allEntries);

  const marketKeys = [...new Set(allEntries.map(e => e.market))];
  for (const mk of marketKeys) {
    const label = allEntries.find(e => e.market === mk).label;
    printBucketTable(`SECTION C — by market: ${label} @ ${PRICE_SET} price`, allEntries.filter(e => e.market === mk));
  }

  if (PRICE_SET === 'open') printMovementConfirmation(allEntries);

  console.log('Reading this: if the model carries real information, ROI should climb as the edge');
  console.log('bucket rises (0-3pp -> 15pp+). If ROI is flat or negative across every bucket');
  console.log(`regardless of edge size, the model's "edge" over Bet365's ${PRICE_SET} price is not`);
  console.log('predictive — it is just estimation noise in the Poisson ratings, and the market');
  console.log('price is already a better estimate than our own model, consistent with');
  console.log('BETTING_EDGE_ANALYSIS.md\'s skepticism about beating a closing line pre-match.');
  if (PRICE_SET === 'open') {
    console.log('Section D answers a different question: even if ROI@open is flat, does a bigger');
    console.log('model edge at least predict which way the price will move before kickoff? If the');
    console.log('"% moved toward model side" climbs with edge size above the baseline rate, the');
    console.log('model has real CLV-timing information even where straight ROI@open doesn\'t show it —');
    console.log('worth acting on for entry timing even without a full edge-priced value bet.');
  }
}

main();
