/* ════════════════════════════════════════════════════════════
   CONSTANTS
   ════════════════════════════════════════════════════════════ */
const LINE_THRESH   = 0.12;
const ODDS_THRESH   = 0.06;
const TL_THRESH     = 0.12;
const DEFAULT_MIN_N = 15;
const MIN_Z         = 1.5;   // Match Analysis
const MIN_Z_DISC    = 2.0;   // Config Discovery (sweeps ~18k combos — higher bar to control false positives)
// Min pp the Wilson CI *lower bound* (conservative hit rate) must clear the
// baseline by — same discipline as telegram/config.js's L123_MIN_EDGE. Gating
// on the raw point estimate alone lets a small-sample bucket "qualify" purely
// from noise (e.g. p=70% on n=20 can pass MIN_Z with a CI so wide the true
// rate could easily be at baseline). Requiring the pessimistic end of the CI
// to still beat baseline is what turned L123's walk-forward ROI from
// negative/flat to positive — see config.js's L123_MIN_EDGE comment.
const MIN_EDGE       = 0;

// A bet only counts as a validated edge if BOTH the raw z-score clears the
// significance bar AND the conservative (Wilson CI lower-bound) hit rate
// still beats baseline by at least MIN_EDGE pp — mirrors telegram/notify.js's
// l123Qualifies. Used to gate Top Pick, the PRE/GS ✓ badges, and what counts
// as "not yet qualifying" for Value Hunting.
function qualifiesBet(b) {
  return !!b && b.z >= MIN_Z && (b.lo - b.bl) >= MIN_EDGE;
}

const VALID_LINES = [0.00, 0.25, 0.50, 0.75, 1.00, 1.25, 1.50];

const TL_CLUSTERS = {
  '<2':    [null, 2.0],
  '2-2.5': [2.0,  2.5],
  '2.5-3': [2.5,  3.0],
  '>3':    [3.0,  null],
};

const ADV_TL_RANGES = {
  '1.5-2':     [1.5,  2.0],
  '2.25-2.75': [2.25, 2.75],
  '3-3.5':     [3.0,  3.5],
};

/* ════════════════════════════════════════════════════════════
   DAILY DASHBOARD — pre-match, opening-odds-only composite scorer
   ════════════════════════════════════════════════════════════
   Deliberately restricted to OPENING odds only (no closing, no movement
   signals) so it works hours ahead of kickoff, unlike Match Analysis which
   needs closing data. Combines three independent signals per fixture:
     1. Opening-odds historical bucket (same idea as telegram/notify.js's
        Layer 1 — fav line/side + opening-odds band + opening-TL band)
     2. League-level market calibration (does this league's own historical
        hit rate diverge from its market-implied probability, for the
        specific bet type Signal 1 landed on)
     3. Goal-timing corroboration (does the league's actual 1H/2H goal-share,
        from football-data/goals_time2 via static/data/goal_timing_summary.json,
        support a 1H/2H-flavoured pick)
   Agreement across independent signals is the same convergence principle
   validated for L123 (layer_analysis.js's convergence study) — this is NOT
   itself re-validated; treat it with the same caution as everything else
   in this codebase until walk-forward tested. */

const TOP_LEAGUE_GROUPS = [
  { inc: 'english premier league',  exc: ['u21','women','reserve','international club'], name: 'England Premier League' },
  { inc: 'spanish la liga',         exc: ['la liga 2','segunda','ladies','women','youth','supercopa','rfef'], name: 'Spain La Liga' },
  { inc: 'german bundesliga',       exc: ['bundesliga 2','2. bundesliga','junioren','frauen','women'], name: 'Germany Bundesliga' },
  { inc: 'italy serie a',           exc: ['serie b','serie c','serie d','women','primavera'], name: 'Italy Serie A' },
  { inc: 'italian serie a',         exc: ['serie b','serie c','women','primavera'], name: 'Italy Serie A' },
  { inc: 'france ligue 1',          exc: ['ligue 2','ligue 3','ligue 5','women','youth'], name: 'France Ligue 1' },
  { inc: 'uefa champions league',   exc: ['afc','qualification','women','youth','u19','u21'], name: 'UEFA Champions League' },
  { inc: 'uefa europa league',      exc: ['conference','qualification','women'], name: 'UEFA Europa League' },
  { inc: 'uefa conference league',  exc: ['qualification','women'], name: 'UEFA Conference League' },
];
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
function matchLeagueGroup(name, groups) {
  if (!name) return null;
  const n = name.toLowerCase();
  for (const { inc, exc, name: canonical } of groups) {
    if (n.includes(inc) && !exc.some(e => n.includes(e))) return canonical;
  }
  return null;
}
function dashboardLeagueGroup(name) {
  return matchLeagueGroup(name, TOP_LEAGUE_GROUPS) || matchLeagueGroup(name, MINOR_LEAGUE_GROUPS);
}

// Per-run memoization for the two full-database scans that would otherwise
// repeat once per fixture (500+ fixtures in the 24h window is common) —
// openingOddsSignal's fav_line/fav_side base pool and leagueCalibration's
// league pool. Reset at the top of runDailyDashboard so a reloaded/refiltered
// db (tier/recency toggle) doesn't serve stale cached rows.
let _dashBaseCache = new Map();
let _dashLeagueCache = new Map();
let _dashBaselineStatsCache = new Map();

const DASHBOARD_ODDS_BANDS = [
  [null, 1.60], [1.60, 1.75], [1.75, 1.90], [1.90, 2.05],
  [2.05, 2.30], [2.30, 2.70], [2.70, null],
];
function inOddsBand(v, band) {
  if (v == null || !band) return false;
  const [lo, hi] = band;
  return (lo == null || v >= lo) && (hi == null || v < hi);
}

let _goalTimingSummary = null;
async function loadGoalTimingSummary() {
  try {
    const res = await fetch('data/goal_timing_summary.json');
    if (res.ok) _goalTimingSummary = await res.json();
  } catch (e) { _goalTimingSummary = null; }
}

// 1H/2H-flavoured bet keys this dashboard can cross-check against a league's
// actual goal-timing shape — anything not in this map has no timing opinion.
const GOAL_TIMING_HALF_HINT = {
  over15_1H: '1H', over05_1H: '1H', favScored1H: '1H', btts1H: '1H', favWins1H: '1H',
  over15_2H: '2H', over05_2H: '2H', favScored2H: '2H', favWins2H: '2H',
  homeScored2H: '2H', awayScored2H: '2H',
};

// Signal 3: does this league's actual 1H/2H goal split support a bet that
// leans on one half producing (or not producing) goals? Purely descriptive
// (no z-score/CI machinery — goal_timing_summary.json has no baseline stat
// infrastructure), returns true/false/null (no opinion for this bet type or
// no data for this league).
function goalTimingCorroborates(leagueGroup, betKey) {
  const half = GOAL_TIMING_HALF_HINT[betKey];
  if (!half || !_goalTimingSummary?.leagues?.[leagueGroup]) return null;
  const pct = _goalTimingSummary.leagues[leagueGroup].half[half === '1H' ? 'h1Pct' : 'h2Pct'];
  const NEUTRAL = half === '1H' ? 45 : 55; // roughly the cross-league average split
  const isUnderKey = betKey.startsWith('under');
  return isUnderKey ? pct < NEUTRAL : pct >= NEUTRAL;
}

// Signal 2: league-level market calibration for a specific market-priced bet
// — does this league's own historical hit rate diverge from what its own
// closing odds imply? (BETTING_EDGE_ANALYSIS.md §6's "calibration" approach,
// computed on the fly from the already-loaded database — same formulas as
// telegram/league_analysis.js's Pass A, just not precomputed/persisted.)
function leagueCalibration(leagueGroup, betKey) {
  const def = BETS.find(b => b.k === betKey);
  if (!def || !def.marketOddsKey) return null;
  let rows = _dashLeagueCache.get(leagueGroup);
  if (!rows) {
    rows = getDb().filter(r => dashboardLeagueGroup(r.league) === leagueGroup);
    _dashLeagueCache.set(leagueGroup, rows);
  }
  if (rows.length < 100) return null; // not enough league-specific sample to trust
  const p = pct(rows, betKey);
  const mkt = avgMarketImplied(rows, def.marketOddsKey);
  if (mkt == null) return null;
  return { n: rows.length, p, mkt, gap: p - mkt };
}

// Baseline hit-counts for every bet key over a (fav_line, fav_side) pool,
// computed once and reused across every fixture that shares the pool.
// scoreBets() re-filters the whole baseline array from scratch for each of
// the 32 bets — fine when called once, but the dashboard calls it once per
// fixture (500+ in a busy 24h window) against the SAME ~14 baseline pools,
// so that redundant re-filtering was the dominant cost even after caching
// the pool lookup itself. This turns O(fixtures × bets × |pool|) into
// O(pools × bets × |pool|), done once per pool regardless of fixture count.
function dashboardBaselineStats(baseKey, base) {
  let stats = _dashBaselineStatsCache.get(baseKey);
  if (stats) return stats;
  stats = new Map();
  for (const b of BETS) stats.set(b.k, base.filter(r => r[b.k]).length);
  _dashBaselineStatsCache.set(baseKey, stats);
  return stats;
}

// Lean stand-in for scoreBets() for the dashboard's fixed baseline==base
// case: only filters the small, already band-narrowed cfgRows per bet — the
// baseline side comes from the precomputed dashboardBaselineStats instead of
// being re-filtered. Same p/bl/z/edge/CI formulas as scoreBets, minus the
// per-match drill-down array (unused here) and market-calibration fields.
function scoreBetsFast(cfgRows, baseKey, base) {
  const n1 = cfgRows.length;
  if (n1 < DEFAULT_MIN_N || base.length < DEFAULT_MIN_N) return [];
  const n2 = base.length;
  const blStats = dashboardBaselineStats(baseKey, base);
  const results = [];
  for (const b of BETS) {
    const hits1 = cfgRows.filter(r => r[b.k]).length;
    const hits2 = blStats.get(b.k);
    const p  = hits1 / n1 * 100;
    const bl = hits2 / n2 * 100;
    let z = 0;
    if (n1 >= 5 && n2 >= 5) {
      const p1 = hits1 / n1, p2 = hits2 / n2;
      const pp = (p1 * n1 + p2 * n2) / (n1 + n2);
      if (pp > 0 && pp < 1) {
        const se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
        z = se > 0 ? (p1 - p2) / se : 0;
      }
    }
    const edge = p - bl;
    const [lo, hi] = wilsonCI(p, n1);
    const mo_mid = minOdds((p + lo) / 2);
    results.push({ ...b, n: n1, p, bl, z, edge, lo, hi, mo: minOdds(p), mo_lo: minOdds(lo), mo_mid });
  }
  results.sort((a, b) => {
    const aPos = a.edge > 0, bPos = b.edge > 0;
    if (aPos !== bPos) return aPos ? -1 : 1;
    return (b.z * (b.lo / 100)) - (a.z * (a.lo / 100));
  });
  return results;
}

// The Daily Dashboard only ever picks from these 13 FT/pre-match markets —
// straight 1X2, FT totals, BTTS, and FT team totals. Everything else BETS
// scores (AH cover, all 1H/2H markets) needs either in-play state or a
// bookmaker line this dashboard doesn't have pre-match, so surfacing them
// here would recommend a bet the fixture list can't actually back up yet.
const _DASHBOARD_BET_KEYS = new Set([
  'homeWinsFT', 'drawFT', 'awayWinsFT',
  'over15FT', 'over25FT', 'under15FT', 'under25FT',
  'btts', 'noBtts',
  'homeOver05FT', 'homeOver15FT', 'awayOver05FT', 'awayOver15FT',
]);

// Signal 1 — opening-odds-only historical bucket, mirrors telegram/notify.js's
// layer1Live but reading from the already-loaded client-side database.
function openingOddsSignal(favLine, favSide, favOo, tlO) {
  const baseKey = `${favLine}|${favSide}`;
  let base = _dashBaseCache.get(baseKey);
  if (!base) {
    base = getDb().filter(r => r.fav_line === favLine && r.fav_side === favSide);
    _dashBaseCache.set(baseKey, base);
  }
  if (base.length < DEFAULT_MIN_N) return null;
  const oddsBand = DASHBOARD_ODDS_BANDS.find(b => inOddsBand(favOo, b));
  const tlBand = Object.values(TL_CLUSTERS).find(b => inOddsBand(tlO, b));
  const cfgRows = base.filter(r => inOddsBand(r.fav_oo, oddsBand) && (tlBand ? inOddsBand(r.tl_o, tlBand) : true));
  if (cfgRows.length < DEFAULT_MIN_N) return null;
  const allBets = scoreBetsFast(cfgRows, baseKey, base).filter(b => _DASHBOARD_BET_KEYS.has(b.k));
  if (!allBets.length) return null;
  const qualifying = allBets.filter(qualifiesBet);
  const best = qualifying[0] || allBets.find(b => b.edge > 0 && b.n >= DEFAULT_MIN_N) || null;
  return best ? { bet: best, qualifies: qualifying.length > 0 } : null;
}

// Reconstructs favSide/favLine/favOo/dogOo/tlO from a live-feed match's
// OPENING odds only (odds.ah_ho / ho_o / ao_o / tl_o) — deliberately ignores
// the "closing"/current fields (ah_hc/ho_c/ao_c/tl_c), even though the feed
// includes them, since this dashboard's whole point is working from what's
// knowable hours before kickoff, not the near-kickoff price.
function deriveOpeningContext(odds) {
  const ahHo = sf(odds.ah_ho);
  if (ahHo === null) return null;
  const hoO = sf(odds.ho_o), aoO = sf(odds.ao_o), tlO = sf(odds.tl_o);
  const favLc = Math.abs(ahHo);
  const favLine = VALID_LINES.find(v => Math.abs(favLc - v) < 0.13);
  if (favLine === undefined) return null;
  let favSide;
  if (ahHo < -0.01) favSide = 'HOME';
  else if (ahHo > 0.01) favSide = 'AWAY';
  else favSide = (hoO != null && aoO != null && hoO <= aoO) ? 'HOME' : 'HOME';
  const favOo = favSide === 'HOME' ? hoO : aoO;
  return { favSide, favLine, favOo, tlO };
}

// Full per-fixture composite score. Returns null if there's nothing to show
// (no opening odds, or no signal at all found for this fixture).
function analyzeFixtureForDashboard(match) {
  const ctx = deriveOpeningContext(match.odds || {});
  if (!ctx || ctx.favOo == null) return null;

  const sig1 = openingOddsSignal(ctx.favLine, ctx.favSide, ctx.favOo, ctx.tlO);
  if (!sig1) return null;

  const leagueGroup = dashboardLeagueGroup(match.league);
  const sig2 = leagueGroup ? leagueCalibration(leagueGroup, sig1.bet.k) : null;
  const sig3 = leagueGroup ? goalTimingCorroborates(leagueGroup, sig1.bet.k) : null;

  let score = sig1.qualifies ? 2 : 1;
  if (sig2 != null && sig2.gap >= 0) score += 1;
  if (sig3 === true) score += 1;

  const tier = score >= 4 ? 'HIGH' : score >= 3 ? 'MEDIUM' : 'LOW';

  return { match, leagueGroup, bet: sig1.bet, qualifies: sig1.qualifies, sig2, sig3, score, tier };
}

async function fetchUpcomingFixtures(hoursAhead) {
  const res = await fetch('/api/livescore');
  if (!res.ok) throw new Error(`livescore fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  // data.matches is the LIVE endpoint's own array — it's dominated by
  // currently-live matches, plus a narrow "about to start / just finished"
  // band from getDatalast1 that goes stale within an hour or two of the
  // scrape. The real forward-looking fixture list (rest of today/next day)
  // is data.next_matches (the separate "tablenext" endpoint) — found via
  // direct testing 2026-08-22 after the dashboard was returning zero
  // matches even once the underlying hash/WAF issue was fixed. Merge both,
  // deduped by id, so a match that happens to appear in both isn't double
  // counted and nothing from either source is silently dropped.
  const combined = [...(data.next_matches || []), ...(data.matches || [])];
  const seen = new Set();
  const now = Date.now();
  const horizon = now + hoursAhead * 60 * 60 * 1000;
  return combined.filter(m => {
    if (m.minute != null) return false; // already live — out of scope for this dashboard
    if (!m.kickoff_time) return false;
    const id = m.id || `${m.home_team}:${m.away_team}:${m.kickoff_time}`;
    if (seen.has(id)) return false;
    seen.add(id);
    const t = new Date(m.kickoff_time).getTime();
    return !isNaN(t) && t > now && t <= horizon;
  });
}

// Populated by renderDashboardWindow — indexed by the row's position in
// `results`, so per-row DOM ids/onclick handlers can reference a match
// without needing to escape its raw id/team names.
let _dashboardFixtures = [];

// Raw fixtures (deduped, future kickoff, within the max 24h fetch horizon)
// cached across window-selector clicks so switching the time window doesn't
// re-hit /api/livescore — only an explicit "DAILY DASHBOARD" click refetches.
let _dashboardAllFixtures = null;
// Default window is intentionally small (not 24h): analyzing every fixture
// in a full 24h span (500+ on a busy day) is real work even after caching
// the DB scans, and almost none of that is actionable yet — the near-term
// window is what's actually useful right now. 24h stays one click away.
let _dashboardWindowHours = 2;
const DASHBOARD_WINDOW_OPTIONS = [0.5, 1, 2, 4, 8, 24];

function dashboardWindowLabel(hours) {
  if (hours < 1) return `${Math.round(hours * 60)}m`;
  return hours === 24 ? '24h' : `${hours}h`;
}

function dashboardWindowButtons() {
  return `<div class="min-n-row" style="margin-bottom:10px">` +
    DASHBOARD_WINDOW_OPTIONS.map(h => {
      const active = h === _dashboardWindowHours ? ' active' : '';
      return `<button class="min-n-preset dash-window-preset${active}" data-hours="${h}" onclick="setDashboardWindow(${h})">${dashboardWindowLabel(h)}</button>`;
    }).join('') +
    `</div>`;
}

// Shared by both the pre-run window picker (left panel, before fixtures are
// even fetched) and the in-dashboard one (rendered inside the results) —
// same state, same buttons kept in sync. Only re-renders the dashboard if
// one is already showing; picking a window before the first run just
// arms it for when "DAILY DASHBOARD" is clicked, no fetch needed yet.
function setDashboardWindow(hours) {
  _dashboardWindowHours = hours;
  document.querySelectorAll('.dash-window-preset').forEach(btn => {
    btn.classList.toggle('active', parseFloat(btn.dataset.hours) === hours);
  });
  if (_dashboardAllFixtures) renderDashboardWindow();
}

async function runDailyDashboard(forceRefresh = true) {
  const right = document.getElementById('right-dashboard');

  if (forceRefresh || !_dashboardAllFixtures) {
    right.innerHTML = `<div class="loader-msg">Loading today's fixtures…</div>`;
    if (!_goalTimingSummary) await loadGoalTimingSummary();
    try {
      _dashboardAllFixtures = await fetchUpcomingFixtures(24);
    } catch (e) {
      _dashboardAllFixtures = null;
      right.innerHTML = `<div class="no-bets"><div class="warn-icon">⚠️</div><p>Could not load today's fixtures: ${e.message}</p></div>`;
      return;
    }
  }

  renderDashboardWindow();
}

/* ── Dashboard fixture league-tier filter ────────────────────────────────
   Restricts which of today's fixtures are scanned, by their OWN league (via
   classifyLeague on match.league) — separate from state.leagueTier, which
   restricts the historical baseline pool instead. Same rationale as Live
   Games' liveTierFilter: obscure leagues have thinner historical pools and
   underperformed out-of-sample in past backtesting (see CLAUDE.md). */
function dashboardFixturePassesTier(match) {
  const t = classifyLeague(match.league);
  if (state.dashboardTierFilter === 'TOP')   return t === 'TOP';
  if (state.dashboardTierFilter === 'MAJOR') return t === 'TOP' || t === 'MAJOR';
  return true;
}

function setDashboardTierFilter(tier) {
  state.dashboardTierFilter = tier;
  ['ALL', 'MAJOR', 'TOP'].forEach(t =>
    document.getElementById(`dash-tier-btn-${t}`)?.classList.toggle('active', t === tier));
  if (_dashboardAllFixtures) renderDashboardWindow();
}

// Filters the cached fixture list down to the selected window and league
// tier, analyzes just that subset (analysis cost now scales with the
// window, not the full 24h fetch), and renders.
function renderDashboardWindow() {
  const right = document.getElementById('right-dashboard');
  if (!_dashboardAllFixtures) return;

  if (!_dashboardAllFixtures.length) {
    right.innerHTML = dashboardWindowButtons() +
      `<div class="no-bets"><div class="warn-icon">⚠️</div><p>No upcoming fixtures found in the next 24h (or the live feed returned nothing).</p></div>`;
    return;
  }

  const now = Date.now();
  const horizon = now + _dashboardWindowHours * 60 * 60 * 1000;
  const timeWindowFixtures = _dashboardAllFixtures.filter(m => {
    const t = new Date(m.kickoff_time).getTime();
    return !isNaN(t) && t <= horizon;
  });
  const windowFixtures = timeWindowFixtures.filter(dashboardFixturePassesTier);

  if (!windowFixtures.length && timeWindowFixtures.length) {
    right.innerHTML = dashboardWindowButtons() +
      `<div class="no-bets"><div class="warn-icon">🏳️</div><p>${timeWindowFixtures.length} fixture${timeWindowFixtures.length !== 1 ? 's' : ''} in this window, but none in the "${state.dashboardTierFilter}" league tier filter — try ALL or MAJOR in the left panel.</p></div>`;
    _dashboardFixtures = [];
    return;
  }

  _dashBaseCache = new Map();
  _dashLeagueCache = new Map();
  _dashBaselineStatsCache = new Map();

  const results = windowFixtures.map(analyzeFixtureForDashboard).filter(Boolean);
  results.sort((a, b) => b.score - a.score || b.bet.z - a.bet.z);
  _dashboardFixtures = results;

  right.innerHTML = renderDailyDashboard(results, windowFixtures.length);
}

// Builds a Match-Analysis-style cfg straight from a live-feed match's
// CLOSING odds (ah_hc/ho_c/ao_c/tl_c etc.) — by the time a match has reached
// HT, kickoff has passed and these fields hold the real closing line/prices,
// unlike deriveOpeningContext() above which deliberately only reads the
// opening fields.
//
// Tier 1 (line_move, tl_move) is always on; Tier 2 (fav/dog odds_move,
// over/under_move) only activates when the matching Tier 1 signal is
// STABLE — same gating buildMatchCfg() uses for Manual Analysis. Odds
// movement is largely redundant with line/TL movement (both are driven by
// the same market action), so stacking all 6 as simultaneous exact-match
// filters on top of fav_line/fav_side/tl_c shrinks the matching historical
// pool for no extra signal when the line already moved. Only the residual,
// finer-grained odds movement is informative once the line itself is quiet.
function buildRawCfgFromLiveOdds(odds, tier2) {
  const hc = sf(odds.ah_hc);
  if (hc === null) return null;
  const favLc = Math.abs(hc);
  const favLine = VALID_LINES.find(v => Math.abs(favLc - v) < 0.13);
  if (favLine === undefined) return null;

  const hoc = sf(odds.ho_c), hoo = sf(odds.ho_o), aoc = sf(odds.ao_c), aoo = sf(odds.ao_o);
  let favSide;
  if (hc < -0.01) favSide = 'HOME';
  else if (hc > 0.01) favSide = 'AWAY';
  else favSide = (hoc != null && aoc != null && hoc <= aoc) ? 'HOME' : 'HOME';
  const favOc = favSide === 'HOME' ? hoc : aoc;
  const favOo = favSide === 'HOME' ? hoo : aoo;
  const dogOc = favSide === 'HOME' ? aoc : hoc;
  const dogOo = favSide === 'HOME' ? aoo : hoo;

  const ho = sf(odds.ah_ho);
  const favLo = ho !== null ? Math.abs(ho) : null;
  let lineMove = 'UNKNOWN';
  if (favLo !== null) {
    const diff = favLc - favLo;
    lineMove = diff > LINE_THRESH ? 'DEEPER' : diff < -LINE_THRESH ? 'SHRANK' : 'STABLE';
  }
  const homMove = oddsDir(hoc, hoo), aomMove = oddsDir(aoc, aoo);
  const favOddsMove = favSide === 'HOME' ? homMove : aomMove;
  const dogOddsMove = favSide === 'HOME' ? aomMove : homMove;

  const ovc = sf(odds.ov_c), ovo = sf(odds.ov_o), unc = sf(odds.un_c), uno = sf(odds.un_o);
  const overMove = oddsDir(ovc, ovo), underMove = oddsDir(unc, uno);
  const tlc = sf(odds.tl_c), tlo = sf(odds.tl_o);
  const tlMove = moveDir(tlc, tlo, TL_THRESH);

  return {
    fav_line: favLine.toFixed(2), fav_side: favSide,
    line_move: lineMove,                          // Tier 1 — always on
    fav_odds_move: tier2 ? favOddsMove : 'ANY',
    dog_odds_move: tier2 ? dogOddsMove : 'ANY',
    over_move:     tier2 ? overMove    : 'ANY',
    under_move:    tier2 ? underMove   : 'ANY',
    tl_c: tlc != null ? tlc.toFixed(2) : null,
    tl_move: tlMove,                               // Tier 1 — always on
    fav_oc: favOc, fav_oo: favOo, dog_oc: dogOc, dog_oo: dogOo,
  };
}

function buildCfgFromLiveOdds(odds) {
  // Pass 1: Tier 1 signals only, to see whether they're STABLE.
  const base = buildRawCfgFromLiveOdds(odds, false);
  if (!base) return null;
  // Pass 2: activate Tier 2 (odds-movement) signals only where the matching
  // Tier 1 signal was STABLE — sharper signal takes priority.
  const lineStable = base.line_move === 'STABLE';
  const tlStable    = base.tl_move   === 'STABLE';
  if (!lineStable && !tlStable) return base;

  const cfg2 = buildRawCfgFromLiveOdds(odds, true);
  if (!lineStable) { cfg2.fav_odds_move = 'ANY'; cfg2.dog_odds_move = 'ANY'; }
  if (!tlStable)    { cfg2.over_move = 'ANY'; cfg2.under_move = 'ANY'; }
  return cfg2;
}

// Team/league names here come from the scraped live-odds feed (external,
// less trusted than the static CSV dataset) — escape before inserting into
// innerHTML.
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function tierBadgeClass(tier) {
  return tier === 'HIGH' ? 'col-badge-pass' : tier === 'MEDIUM' ? 'col-badge-lown' : 'col-badge-weak';
}

// A live match's closing-odds feed sometimes only carries the AH/TL lines
// and no bookmaker prices at all (the "getData2none" feed variant — see
// functions/api/livescore.js) — oddsDir()/moveDir() correctly return
// 'UNKNOWN' for that, but showing the raw enum reads like a parsing bug
// rather than a data-availability gap. Only relabels the display string;
// applyConfig/traceConfig still compare against the raw 'UNKNOWN' value.
function cfgMoveLabel(v) {
  return v === 'UNKNOWN' ? 'no price data' : v;
}

// Tier -> the same strong/good/weak dot color the Bet Dashboard's own
// left-dot column uses (bd-strong/bd-good/bd-weak in style.css), reused here
// so a HIGH/MEDIUM/LOW dashboard fixture reads with the same "status dot"
// language as every other tiered list in the app — the system's own
// documented "status-left" signature pattern, not a one-off for this list.
const _DASH_TIER_DOT_CLS = { HIGH: 'bd-strong', MEDIUM: 'bd-good', LOW: 'bd-weak' };

// The bet name and its advised min odds together, on one row, so the two
// things a user actually needs — what to bet, and the price it's worth
// betting at — aren't separated by other numbers. Shared by every place a
// single pick is surfaced in a scannable card: Dashboard fixture rows, Live
// Games match cards, and the "ALL QUALIFYING BETS" list.
function renderBetPickBlock(bet, qualifies) {
  const flag = qualifies
    ? '<span class="pick-flag pick-flag-pass">✓ QUALIFIES</span>'
    : '<span class="pick-flag pick-flag-value">◆ VALUE HUNT</span>';
  return `
    <div class="pick-row">
      <div class="pick-label">${esc(bet.label)}${flag}</div>
      <div class="pick-odds" title="Bet only if you can get at least this price">
        <span class="pick-odds-value">${bet.mo}</span>
        <span class="pick-odds-label">min odds</span>
      </div>
    </div>
    <div class="col-prob">
      <span class="prob-pct">${bet.p.toFixed(1)}%</span>
      <span class="prob-edge ${bet.edge >= 0 ? 'pos' : 'neg'}">${bet.edge >= 0 ? '+' : ''}${bet.edge.toFixed(1)}pp vs ${bet.bl.toFixed(1)}% baseline</span>
    </div>
    <div class="pick-safer">or ${bet.mo_mid}+ for a safer margin</div>`;
}

// The scannable core of one fixture: team names + tier dot, bet + prob/edge,
// and the one number to act on (min odds) — everything else (why this
// qualifies, sample size, z-score) is supporting evidence and sits behind a
// native <details> disclosure so it costs nothing to skip while scanning a
// list of many fixtures, but is one click away when it's actually needed.
function renderDashboardRowInner(r) {
  const kickoff = new Date(r.match.kickoff_time);
  const kickoffTxt = isNaN(kickoff.getTime()) ? '—' : kickoff.toLocaleString([], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const sig2Txt = r.sig2 != null
    ? `${r.sig2.gap >= 0 ? 'Beats' : 'Trails'} the market by ${Math.abs(r.sig2.gap).toFixed(1)}pp (${r.sig2.n} league matches)`
    : 'Not enough league history to check';
  const sig3Txt = r.sig3 === true ? 'Supports this bet'
    : r.sig3 === false ? 'Works against this bet'
    : 'No goal-timing read for this bet';
  const tierHint = r.tier === 'HIGH' ? 'All 3 checks line up' : r.tier === 'MEDIUM' ? '2 of 3 checks line up' : 'Only the core historical signal qualifies';
  return `
    <div class="scan-card-header">
      <span class="scan-match-name">
        <span class="bd-dot ${_DASH_TIER_DOT_CLS[r.tier] || 'bd-weak'}" style="display:inline-block;vertical-align:middle;margin-right:7px"></span>${esc(r.match.home_team)}<span class="scan-vs">vs</span>${esc(r.match.away_team)}
      </span>
      <span class="${tierBadgeClass(r.tier)}" title="${esc(tierHint)}">${r.tier}</span>
    </div>
    <div class="scan-meta">${esc(r.match.league || '—')} · Kickoff ${kickoffTxt}</div>
    ${renderBetPickBlock(r.bet, r.qualifies)}
    <details class="dash-why">
      <summary>Why this pick</summary>
      <div class="col-stats" style="margin-top:6px">
        <span class="n-stat n-stat-${sampleTier(r.bet.n, DEFAULT_MIN_N)}" title="${_SAMPLE_TIER_TITLE[sampleTier(r.bet.n, DEFAULT_MIN_N)]}">${r.bet.n} similar matches</span>
        <span class="badge-z" title="Z-score — how far above baseline, in standard deviations">z ${r.bet.z.toFixed(2)}</span>
      </div>
      <div class="bet-ci" style="margin-top:6px">📊 Market check: ${sig2Txt}</div>
      <div class="bet-ci">⏱ Timing check: ${sig3Txt}</div>
    </details>`;
}

function renderDashboardRow(r) {
  const tierCls = r.qualifies ? 'scan-card-qualifies' : 'scan-card-value';
  return `<div class="scan-card ${tierCls}" style="cursor:default">${renderDashboardRowInner(r)}</div>`;
}

function renderDailyDashboard(results, totalFixtures) {
  const best = results[0];
  let html = `<h2 class="results-title">DAILY DASHBOARD</h2>`;
  html += dashboardWindowButtons();
  html += `<p style="font-size:11px;color:var(--dim);margin-bottom:10px">${totalFixtures} fixtures in the next ${dashboardWindowLabel(_dashboardWindowHours)} · ${results.length} with an opening-odds signal · opening odds + league stats + goal timing only, no closing/movement data</p>`;

  if (!results.length) {
    html += `<div class="no-bets"><div class="warn-icon">⚠️</div><p>None of today's fixtures in this window matched a historical opening-odds bucket with enough sample. Try a wider window.</p></div>`;
    return html;
  }

  html += `<div class="top-pick-banner"><div class="bet-card tier-strong">
    <div class="bet-stripe"><span class="tier-label">🏆 BET OF THE DAY — ${best.tier} reliability</span></div>
    ${renderDashboardRowInner(best)}
  </div></div>`;

  html += `<div class="section-label" style="margin-top:18px">ALL FIXTURES WITH A SIGNAL</div>`;
  results.forEach(r => { html += renderDashboardRow(r); });
  return html;
}

// UI label → engine value mapping for odds movement in advanced mode
const SIGNAL_UI_TO_ENGINE = { 'STEAM': 'IN', 'DRIFT': 'OUT', 'STABLE': 'STABLE', 'UNKNOWN': 'UNKNOWN' };

const COL_MAP = {
  'date': 'Date', 'event date': 'Date', 'event_date': 'Date', 'match date': 'Match Date',
  'league': 'League', 'competition': 'League', 'tournament': 'League',
  'home team': 'Home Team', 'home_team': 'Home Team', 'home': 'Home Team',
  'away team': 'Away Team', 'away_team': 'Away Team', 'away': 'Away Team',
  'home ah closing': 'Home AH Closing', 'home_ah_closing': 'Home AH Closing',
  'home ah opening': 'Home AH Opening', 'home_ah_opening': 'Home AH Opening',
  'away ah closing': 'Away AH Closing', 'away_ah_closing': 'Away AH Closing',
  'away ah opening': 'Away AH Opening', 'away_ah_opening': 'Away AH Opening',
  'home odds closing': 'Home Odds Closing', 'home_odds_closing': 'Home Odds Closing',
  'home odds opening': 'Home Odds Opening', 'home_odds_opening': 'Home Odds Opening',
  'away odds closing': 'Away Odds Closing', 'away_odds_closing': 'Away Odds Closing',
  'away odds opening': 'Away Odds Opening', 'away_odds_opening': 'Away Odds Opening',
  'total line closing': 'Total Line Closing', 'total_line_closing': 'Total Line Closing',
  'total line opening': 'Total Line Opening', 'total_line_opening': 'Total Line Opening',
  'over odds closing': 'Over Odds Closing', 'over_odds_closing': 'Over Odds Closing',
  'over odds opening': 'Over Odds Opening', 'over_odds_opening': 'Over Odds Opening',
  'under odds closing': 'Under Odds Closing', 'under_odds_closing': 'Under Odds Closing',
  'under odds opening': 'Under Odds Opening', 'under_odds_opening': 'Under Odds Opening',
  'ht result': 'HT Result', 'ht_result': 'HT Result',
  'ft result': 'FT Result', 'ft_result': 'FT Result', 'result': 'FT Result',
  // 1X2 (match-result / "European") odds — optional; present in the bundled
  // Bet365 CSVs, may be absent from other sources. Used to add a market-vs-
  // history comparison for homeWinsFT/drawFT/awayWinsFT (see BETS below).
  '1x2 home closing': '1X2 Home Closing', '1x2_home_closing': '1X2 Home Closing',
  '1x2 draw closing': '1X2 Draw Closing', '1x2_draw_closing': '1X2 Draw Closing',
  '1x2 away closing': '1X2 Away Closing', '1x2_away_closing': '1X2 Away Closing',
  '1x2 home opening': '1X2 Home Opening', '1x2_home_opening': '1X2 Home Opening',
  '1x2 draw opening': '1X2 Draw Opening', '1x2_draw_opening': '1X2 Draw Opening',
  '1x2 away opening': '1X2 Away Opening', '1x2_away_opening': '1X2 Away Opening',
};

const BETS = [
  // AH
  // marketOddsKey: CSV field whose closing odds directly price this bet outcome.
  // Only set where there is a 1:1 correspondence — used for market-calibrated baseline.
  { k: 'ahCover',       label: 'AH Cover (Fav)',           market: 'Asian Handicap — Favourite',        marketOddsKey: 'fav_oc' },
  { k: 'dogCover',      label: 'AH Cover (Dog)',           market: 'Asian Handicap — Underdog',         marketOddsKey: 'dog_oc' },
  // overTL/underTL: outcome vs the closing total line (exactly what ov_c/un_c price)
  { k: 'overTL',        label: 'Over Total Line',          market: 'Over/Under — Closing TL',           marketOddsKey: 'ov_c'   },
  { k: 'underTL',       label: 'Under Total Line',         market: 'Over/Under — Closing TL',           marketOddsKey: 'un_c'   },
  // 2H results — fav-normalised
  { k: 'favWins2H',     label: 'Fav wins 2nd half',        market: '2H Result — Favourite Win' },
  { k: 'favScored2H',   label: 'Fav scores in 2H',         market: 'Team to Score — Fav 2nd Half' },
  { k: 'draw2H',        label: 'Draw 2nd half',            market: '2H Result — Draw' },
  // 2H results — home/away (baseline must split by fav_side)
  { k: 'homeWins2H',    label: 'Home wins 2nd half',       market: '2H Result — Home Win',              favSideBaseline: 'HOME' },
  { k: 'awayWins2H',    label: 'Away wins 2nd half',       market: '2H Result — Away Win',              favSideBaseline: 'AWAY' },
  { k: 'homeScored2H',  label: 'Home scores in 2H',        market: 'Team to Score — Home 2nd Half',     favSideBaseline: 'HOME' },
  { k: 'awayScored2H',  label: 'Away scores in 2H',        market: 'Team to Score — Away 2nd Half',     favSideBaseline: 'AWAY' },
  { k: 'homeOver15_2H', label: 'Home Over 1.5 in 2H',     market: 'Home Goals Over 1.5 — 2nd Half',    favSideBaseline: 'HOME' },
  { k: 'awayOver15_2H', label: 'Away Over 1.5 in 2H',     market: 'Away Goals Over 1.5 — 2nd Half',    favSideBaseline: 'AWAY' },
  // 2H totals (symmetric — no favSideBaseline; no direct market odds proxy)
  { k: 'over05_2H',     label: 'Over 0.5 goals in 2H',    market: 'Over/Under 0.5 — 2nd Half' },
  { k: 'over15_2H',     label: 'Over 1.5 goals in 2H',    market: 'Over/Under 1.5 — 2nd Half' },
  { k: 'under05_2H',    label: 'Under 0.5 goals in 2H',   market: 'Over/Under 0.5 — 2nd Half' },
  { k: 'under15_2H',    label: 'Under 1.5 goals in 2H',   market: 'Over/Under 1.5 — 2nd Half' },
  { k: 'btts2H',        label: 'BTTS 2nd half',           market: 'Both Teams to Score — 2H' },
  // 1H results — fav-normalised
  { k: 'favWins1H',     label: 'Fav wins 1st half',        market: '1H Result — Favourite Win' },
  { k: 'draw1H',        label: 'Draw 1st half',            market: '1H Result — Draw' },
  { k: 'favScored1H',   label: 'Fav scores in 1H',         market: 'Team to Score — Fav 1st Half' },
  // 1H results — home/away
  { k: 'homeWins1H',    label: 'Home wins 1st half',       market: '1H Result — Home Win',   favSideBaseline: 'HOME' },
  { k: 'awayWins1H',    label: 'Away wins 1st half',       market: '1H Result — Away Win',   favSideBaseline: 'AWAY' },
  { k: 'homeScored1H',  label: 'Home scores in 1H',        market: 'Team to Score — Home 1st Half', favSideBaseline: 'HOME' },
  { k: 'awayScored1H',  label: 'Away scores in 1H',        market: 'Team to Score — Away 1st Half', favSideBaseline: 'AWAY' },
  // 1H totals
  { k: 'over05_1H',     label: 'Over 0.5 goals in 1H',    market: 'Over/Under 0.5 — 1st Half' },
  { k: 'over15_1H',     label: 'Over 1.5 goals in 1H',    market: 'Over/Under 1.5 — 1st Half' },
  { k: 'under05_1H',    label: 'Under 0.5 goals in 1H',   market: 'Over/Under 0.5 — 1st Half' },
  { k: 'under15_1H',    label: 'Under 1.5 goals in 1H',   market: 'Over/Under 1.5 — 1st Half' },
  { k: 'btts1H',        label: 'BTTS 1st half',           market: 'Both Teams to Score — 1H' },
  // FT results
  { k: 'homeWinsFT',    label: 'Home wins full time',      market: 'Match Result — Home Win',           favSideBaseline: 'HOME', marketOddsKey: 'x2_home_c' },
  { k: 'awayWinsFT',    label: 'Away wins full time',      market: 'Match Result — Away Win',           favSideBaseline: 'AWAY', marketOddsKey: 'x2_away_c' },
  { k: 'drawFT',        label: 'Draw full time',           market: 'Match Result — Draw',               marketOddsKey: 'x2_draw_c' },
  { k: 'btts',          label: 'BTTS full time',           market: 'Both Teams to Score — FT' },
  { k: 'noBtts',        label: 'BTTS No full time',        market: 'Both Teams to Score — FT' },
  // FT totals — ov_c/un_c price the TL line (typically 2.5), so over25FT/under25FT are direct matches.
  // over15FT and over35FT have no direct proxy (ov_c is calibrated to the TL, not 1.5 or 3.5).
  { k: 'over15FT',      label: 'Over 1.5 goals FT',       market: 'Over/Under 1.5 — Full Time' },
  { k: 'over25FT',      label: 'Over 2.5 goals FT',       market: 'Over/Under 2.5 — Full Time' },
  { k: 'over35FT',      label: 'Over 3.5 goals FT',       market: 'Over/Under 3.5 — Full Time' },
  { k: 'under15FT',     label: 'Under 1.5 goals FT',      market: 'Over/Under 1.5 — Full Time' },
  { k: 'under25FT',     label: 'Under 2.5 goals FT',      market: 'Over/Under 2.5 — Full Time' },
  // FT team totals — home/away goals, independent of who's favourite.
  { k: 'homeOver05FT',  label: 'Home Over 0.5 goals FT',  market: 'Team Total — Home Over 0.5 FT', favSideBaseline: 'HOME' },
  { k: 'homeOver15FT',  label: 'Home Over 1.5 goals FT',  market: 'Team Total — Home Over 1.5 FT', favSideBaseline: 'HOME' },
  { k: 'awayOver05FT',  label: 'Away Over 0.5 goals FT',  market: 'Team Total — Away Over 0.5 FT', favSideBaseline: 'AWAY' },
  { k: 'awayOver15FT',  label: 'Away Over 1.5 goals FT',  market: 'Team Total — Away Over 1.5 FT', favSideBaseline: 'AWAY' },
];

// Fixed bet groups for the always-visible dashboard (order defines display order)
const BET_GROUPS = [
  { label: 'FT RESULT',  keys: ['ahCover', 'homeWinsFT', 'drawFT', 'awayWinsFT', 'btts', 'noBtts'] },
  { label: 'FT TOTALS',  keys: ['over15FT', 'over25FT', 'over35FT', 'under15FT', 'under25FT', 'homeOver05FT', 'homeOver15FT', 'awayOver05FT', 'awayOver15FT'] },
  { label: '2H',         keys: ['favWins2H', 'draw2H', 'homeWins2H', 'awayWins2H', 'favScored2H', 'homeScored2H', 'awayScored2H', 'homeOver15_2H', 'awayOver15_2H', 'over05_2H', 'over15_2H', 'under05_2H', 'under15_2H', 'btts2H'] },
  { label: '1H',         keys: ['favWins1H', 'draw1H', 'favScored1H', 'homeWins1H', 'awayWins1H', 'homeScored1H', 'awayScored1H', 'over05_1H', 'over15_1H', 'under05_1H', 'under15_1H', 'btts1H'] },
];

// Live Games only ever surfaces the 10 home/away/total 2H markets, or (while
// the match is still in 1H) their 10 1H equivalents — never both at once, and
// never the fav-relative/FT/AH bets the full engine also scores. Applied only
// to what's actually displayed/ranked (preBets/gsBets/liveBets) — the
// unfiltered htBets is kept internally so buildLiveAdjustedBet's
// _2H_RESULT_KEYS/btts2H dispatch (which needs favScored2H as an anchor)
// still has it available. The 1H set has no HT-score filter/live-decay of its
// own — it's pre-match/closing-odds signal only, same as preBets always was,
// since there's no "anchor" concept partway through the 1st half.
const _LIVE_SCAN_1H_KEYS = new Set([
  'over05_1H', 'over15_1H', 'under05_1H', 'under15_1H',
  'homeScored1H', 'awayScored1H',
  'homeWins1H', 'awayWins1H', 'draw1H',
  'btts1H',
]);
const _LIVE_SCAN_2H_KEYS = new Set([
  'over05_2H', 'over15_2H', 'under05_2H', 'under15_2H',
  'homeScored2H', 'awayScored2H',
  'homeWins2H', 'awayWins2H', 'draw2H',
  'btts2H',
]);
function filterLiveScanBets(bets, past1H) {
  const keys = past1H ? _LIVE_SCAN_2H_KEYS : _LIVE_SCAN_1H_KEYS;
  return bets ? bets.filter(b => keys.has(b.k)) : bets;
}

// ── GSA Probe outcomes ────────────────────────────────────────────────────────
// Absolute probability targets for GSA-style value betting at HT.
// For each outcome: compare P(signal+state) vs P(state only) to quantify
// how much the pre-match signal adds on top of the game state alone.
const GS_PROBE_OUTCOMES = [
  // 2H totals — highest probability, most achievable live odds
  { k: 'over05_2H',     label: 'Over 0.5 in 2H',   group: '2H Goals' },
  { k: 'over15_2H',     label: 'Over 1.5 in 2H',   group: '2H Goals' },
  { k: 'under05_2H',    label: 'Under 0.5 in 2H',  group: '2H Goals' },
  { k: 'under15_2H',    label: 'Under 1.5 in 2H',  group: '2H Goals' },
  // 2H result markets
  { k: 'favWins2H',     label: 'Fav wins 2H',       group: '2H Result' },
  { k: 'homeWins2H',    label: 'Home wins 2H',      group: '2H Result' },
  { k: 'awayWins2H',    label: 'Away wins 2H',      group: '2H Result' },
  { k: 'draw2H',        label: 'Draw 2H',           group: '2H Result' },
  // 2H scoring markets
  { k: 'favScored2H',   label: 'Fav scores 2H',     group: '2H Scoring' },
  { k: 'homeScored2H',  label: 'Home scores 2H',    group: '2H Scoring' },
  { k: 'awayScored2H',  label: 'Away scores 2H',    group: '2H Scoring' },
  { k: 'homeOver15_2H', label: 'Home over 1.5 2H',  group: '2H Scoring' },
  { k: 'awayOver15_2H', label: 'Away over 1.5 2H',  group: '2H Scoring' },
  // FT remaining — conditional on HT score known
  { k: 'over15FT',      label: 'Over 1.5 FT',       group: 'FT Remaining' },
  { k: 'over25FT',      label: 'Over 2.5 FT',       group: 'FT Remaining' },
  { k: 'over35FT',      label: 'Over 3.5 FT',       group: 'FT Remaining' },
  { k: 'under25FT',     label: 'Under 2.5 FT',      group: 'FT Remaining' },
  { k: 'btts',          label: 'BTTS FT',           group: 'FT Remaining' },
  { k: 'homeWinsFT',    label: 'Home win FT',        group: 'FT Remaining' },
  { k: 'awayWinsFT',    label: 'Away win FT',        group: 'FT Remaining' },
  { k: 'drawFT',        label: 'Draw FT',            group: 'FT Remaining' },
];

/* ── League tier classification ─────────────────────────────────────────
   TOP   = Top 5 European leagues + main UEFA club competitions
   MAJOR = Other strong national/continental leagues
   OTHER = Regional, amateur, youth, women's, lower divisions, etc.
   ───────────────────────────────────────────────────────────────────── */
const _T1_RULES = [
  { inc: 'english premier league',  exc: ['u21','women','reserve','international club'] },
  { inc: 'spanish la liga',         exc: ['la liga 2','segunda','ladies','women','youth','supercopa','rfef'] },
  { inc: 'german bundesliga',       exc: ['bundesliga 2','2. bundesliga','junioren','frauen','women'] },
  { inc: 'italy serie a',           exc: ['serie b','serie c','serie d','women','primavera'] },
  { inc: 'italian serie a',         exc: ['serie b','serie c','women','primavera'] },
  { inc: 'france ligue 1',          exc: ['ligue 2','ligue 3','ligue 5','women','youth'] },
  { inc: 'uefa champions league',   exc: ['afc','qualification','women','youth','u19','u21'] },
  { inc: 'uefa europa league',      exc: ['conference','qualification','women'] },
  { inc: 'uefa conference league',  exc: ['qualification','women'] },
];
const _T2_KEYS = [
  'england championship','england league 1','england league 2',
  'german bundesliga 2','german 3.liga',
  'spanish la liga 2','spain segunda','spain primera division rfef',
  'italy serie b','italian serie b','italy serie c','italian serie c','coppa italia',
  'france ligue 2',
  'liga portugal 1','liga portugal 2',
  'belgian pro league',
  'holland eredivisie',
  'turkey super lig',
  'russia premier league','russian premier league','russian national football league',
  'scottish premiership',
  'brazil serie a','brazil serie b','copa do brasil',
  'argentina primera','argentine division 1',
  'copa libertadores','copa sudamericana','recopa sudamericana',
  'usa major league soccer','major league soccer','mls next pro',
  'concacaf champions league',
  'j1 league','j2 league','j-league cup',
  'k league 1','k league 2','korean fa cup',
  'chinese super league','chinese fa cup',
  'saudi professional league','saudi kings cup',
  'swiss super league',
  'austrian bundesliga',
  'norway eliteserien','norwegian tippeligaen',
  'swedish allsvenskan',
  'denmark superliga','denmark superligaen',
  'greece super league a','greek super league',
  'ekstraklasa',
  'romania liga i','romania liga 1',
  'ukrainian premier league','ukraine premier league',
  'serbia superliga','serbian superliga',
  'croatia 1.division','croatia first league',
  'persian gulf pro league',
  'qatar stars league',
  'uae pro-league',
  'afc champions league elite',
  'caf champions league','caf confederation cup',
  'fifa world cup qualification',
  'uefa nations league','uefa european',
  'concacaf nations league','concacaf gold',
  'israel premier league',
  'primera division liga mx',
  'liga pro ecuador serie a',
  'peru liga 1','peru primera division',
  'uruguay primera division',
  'colombia primera',
  'chile primera division',
  'thai league 1',
  'australia a-league',
  'finland veikkausliga',
  'indonesia liga 1',
  'egyptian premier league',
  'northern ireland premier league','northern ireland premiership',
  'slovenia 1.liga',
  'ceska fotbalova liga','gambrinus liga',
  'bulgaria premier league',
  'bosnia and herzegovina premier league','bosnia erzegovina 1st league',
];

function classifyLeague(name) {
  if (!name) return 'OTHER';
  const n = name.toLowerCase();
  for (const { inc, exc } of _T1_RULES) {
    if (n.includes(inc) && !exc.some(e => n.includes(e))) return 'TOP';
  }
  if (_T2_KEYS.some(k => n.includes(k))) return 'MAJOR';
  return 'OTHER';
}

/* ════════════════════════════════════════════════════════════
   DATA PROCESSING
   ════════════════════════════════════════════════════════════ */
function sf(v) {
  const f = parseFloat(String(v == null ? '' : v).trim());
  return isNaN(f) ? null : f;
}

function normaliseRow(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) {
    const mapped = COL_MAP[k.trim().toLowerCase()];
    out[mapped || k.trim()] = v;
  }
  return out;
}

function parseScore(s) {
  s = String(s || '').trim();
  if (!s.includes('-')) return [null, null];
  const parts = s.split('-');
  const a = parseInt(parts[0], 10), b = parseInt(parts[1], 10);
  if (isNaN(a) || isNaN(b)) return [null, null];
  return [a, b];
}

function oddsDir(c, o) {
  if (c === null || o === null) return 'UNKNOWN';
  const d = c - o;
  if (d < -ODDS_THRESH) return 'IN';
  if (d > ODDS_THRESH)  return 'OUT';
  return 'STABLE';
}

function moveDir(c, o, thresh) {
  if (c === null || o === null) return 'UNKNOWN';
  const d = c - o;
  if (d > thresh)  return 'UP';
  if (d < -thresh) return 'DOWN';
  return 'STABLE';
}

function processRow(row, fileLabel) {
  const nr = normaliseRow(row);
  const [htH, htA] = parseScore(nr['HT Result'] || '');
  const [ftH, ftA] = parseScore(nr['FT Result'] || '');
  if (htH === null || ftH === null) return null;

  const date     = String(nr['Date']      || '').trim();
  const league   = String(nr['League']    || '').trim();
  const homeTeam = String(nr['Home Team'] || '').trim();
  const awayTeam = String(nr['Away Team'] || '').trim();

  const ahHc = sf(nr['Home AH Closing']);
  const ahHo = sf(nr['Home AH Opening']);
  const hoC  = sf(nr['Home Odds Closing']);
  const hoO  = sf(nr['Home Odds Opening']);
  const aoC  = sf(nr['Away Odds Closing']);
  const aoO  = sf(nr['Away Odds Opening']);
  const tlC  = sf(nr['Total Line Closing']);
  const tlO  = sf(nr['Total Line Opening']);
  const ovC  = sf(nr['Over Odds Closing']);
  const ovO  = sf(nr['Over Odds Opening']);
  const unC  = sf(nr['Under Odds Closing']);
  const unO  = sf(nr['Under Odds Opening']);

  // 1X2 odds — optional (absent from some CSV sources); nulls are handled
  // gracefully downstream by avgMarketImplied's min-sample-size guard.
  const x2HomeC = sf(nr['1X2 Home Closing']);
  const x2DrawC = sf(nr['1X2 Draw Closing']);
  const x2AwayC = sf(nr['1X2 Away Closing']);
  const x2HomeO = sf(nr['1X2 Home Opening']);
  const x2DrawO = sf(nr['1X2 Draw Opening']);
  const x2AwayO = sf(nr['1X2 Away Opening']);

  if ([ahHc, ahHo, hoC, hoO, aoC, aoO].some(v => v === null)) return null;

  let favSide, favLc, favLo, favOc, favOo, dogOc, dogOo, favFt, dogFt, favHt, dogHt;
  if (ahHc < -0.01) {
    favSide = 'HOME'; favLc = Math.abs(ahHc); favLo = Math.abs(ahHo);
    favOc = hoC; favOo = hoO; dogOc = aoC; dogOo = aoO;
    favFt = ftH; dogFt = ftA; favHt = htH; dogHt = htA;
  } else if (ahHc > 0.01) {
    favSide = 'AWAY'; favLc = Math.abs(ahHc); favLo = Math.abs(ahHo);
    favOc = aoC; favOo = aoO; dogOc = hoC; dogOo = hoO;
    favFt = ftA; dogFt = ftH; favHt = htA; dogHt = htH;
  } else {
    // Level ball — fav is the team with lower closing odds (more likely to win)
    favSide = hoC <= aoC ? 'HOME' : 'AWAY';
    favLc = 0.0; favLo = Math.abs(ahHo);
    if (favSide === 'HOME') {
      favOc = hoC; favOo = hoO; dogOc = aoC; dogOo = aoO;
      favFt = ftH; dogFt = ftA; favHt = htH; dogHt = htA;
    } else {
      favOc = aoC; favOo = aoO; dogOc = hoC; dogOo = hoO;
      favFt = ftA; dogFt = ftH; favHt = htA; dogHt = htH;
    }
  }

  const favLine = VALID_LINES.find(v => Math.abs(favLc - v) < 0.13);
  if (favLine === undefined) return null;

  const lmDiff = favLc - favLo;
  const lineMove = lmDiff > LINE_THRESH ? 'DEEPER' : lmDiff < -LINE_THRESH ? 'SHRANK' : 'STABLE';

  return {
    file_label:    fileLabel,
    league_tier:   classifyLeague(league),
    date, league,
    home_team:     homeTeam,
    away_team:     awayTeam,
    fav_side:      favSide,
    fav_line:      favLine,
    fav_lc:        favLc,
    fav_lo:        favLo,
    fav_oc:        favOc,
    fav_oo:        favOo,
    dog_oc:        dogOc,
    dog_oo:        dogOo,
    tl_c:          tlC,
    tl_o:          tlO,
    ov_c:          ovC,
    ov_o:          ovO,
    un_c:          unC,
    un_o:          unO,
    x2_home_c:     x2HomeC,
    x2_draw_c:     x2DrawC,
    x2_away_c:     x2AwayC,
    x2_home_o:     x2HomeO,
    x2_draw_o:     x2DrawO,
    x2_away_o:     x2AwayO,
    line_move:     lineMove,
    fav_odds_move: oddsDir(favOc, favOo),
    dog_odds_move: oddsDir(dogOc, dogOo),
    tl_move:       moveDir(tlC, tlO, TL_THRESH),
    over_move:     oddsDir(ovC, ovO),
    under_move:    oddsDir(unC, unO),
    ...deriveOutcomes(favSide, favLine, htH, htA, ftH, ftA, tlC),
  };
}

// Derives every FT/HT/2H-goal-based outcome flag (fav-relative fields +
// every BETS[].k boolean) from a favourite-relative scoreline — the single
// source of truth for CSV row processing (processRow, above).
function deriveOutcomes(favSide, favLine, htH, htA, ftH, ftA, tlC) {
  const favHt = favSide === 'HOME' ? htH : htA;
  const dogHt = favSide === 'HOME' ? htA : htH;
  const favFt = favSide === 'HOME' ? ftH : ftA;
  const dogFt = favSide === 'HOME' ? ftA : ftH;

  const fav2h = favFt - favHt;
  const dog2h = dogFt - dogHt;
  const ah2h  = fav2h - dog2h - favLine;

  const home2h = ftH - htH;
  const away2h = ftA - htA;

  let firstGoal;
  if (favHt > 0)      firstGoal = 'FAV_1H';
  else if (dogHt > 0) firstGoal = 'DOG_1H';
  else if (fav2h > 0) firstGoal = 'FAV_2H';
  else if (dog2h > 0) firstGoal = 'DOG_2H';
  else                firstGoal = 'NO_GOAL';

  return {
    fav_ht:        favHt,
    dog_ht:        dogHt,
    fav_ft:        favFt,
    dog_ft:        dogFt,
    fav_2h:        fav2h,
    dog_2h:        dog2h,
    home_2h:       home2h,
    away_2h:       away2h,
    first_goal:    firstGoal,
    favScored2H:   fav2h >= 1,
    favWins2H:     fav2h > dog2h,
    draw2H:        fav2h === dog2h,
    over05_2H:     (home2h + away2h) >= 1,
    over15_2H:     (home2h + away2h) >= 2,
    over25_2H:     (home2h + away2h) >= 3,
    ahCover:       ah2h > 0.01,
    dogCover:      ah2h < -0.01,
    overTL:        tlC != null && (ftH + ftA) > tlC,
    underTL:       tlC != null && (ftH + ftA) < tlC,
    noDrawFT:      favFt !== dogFt,
    favWinsFT:     favFt > dogFt,
    homeWins2H:    home2h > away2h,
    awayWins2H:    away2h > home2h,
    homeWinsFT:    ftH > ftA,
    awayWinsFT:    ftA > ftH,
    dnbHome:       ftH > ftA,
    dnbAway:       ftA > ftH,
    homeScored2H:  home2h >= 1,
    awayScored2H:  away2h >= 1,
    btts2H:        home2h >= 1 && away2h >= 1,
    homeOver15_2H: home2h >= 2,
    awayOver15_2H: away2h >= 2,
    under05_2H:    (home2h + away2h) === 0,
    under15_2H:    (home2h + away2h) <= 1,
    over25FT:      ftH + ftA >= 3,
    over15FT:      ftH + ftA >= 2,
    over35FT:      ftH + ftA >= 4,
    under15FT:     ftH + ftA <= 1,
    under25FT:     ftH + ftA <= 2,
    drawFT:        ftH === ftA,
    btts:          ftH >= 1 && ftA >= 1,
    noBtts:        !(ftH >= 1 && ftA >= 1),
    homeOver05FT:  ftH >= 1,
    homeOver15FT:  ftH >= 2,
    awayOver05FT:  ftA >= 1,
    awayOver15FT:  ftA >= 2,
    // 1H results
    favWins1H:     favHt > dogHt,
    draw1H:        favHt === dogHt,
    homeWins1H:    htH > htA,
    awayWins1H:    htA > htH,
    favScored1H:   favHt >= 1,
    homeScored1H:  htH >= 1,
    awayScored1H:  htA >= 1,
    btts1H:        htH >= 1 && htA >= 1,
    over05_1H:     htH + htA >= 1,
    over15_1H:     htH + htA >= 2,
    under05_1H:    htH + htA === 0,
    under15_1H:    htH + htA <= 1,
  };
}

/* ════════════════════════════════════════════════════════════
   STATISTICS
   ════════════════════════════════════════════════════════════ */
function pct(rows, key) {
  if (!rows.length) return 0;
  return rows.filter(r => r[key]).length / rows.length * 100;
}

function zScore(a, b, key) {
  const n1 = a.length, n2 = b.length;
  if (n1 < 5 || n2 < 5) return 0;
  const p1 = a.filter(r => r[key]).length / n1;
  const p2 = b.filter(r => r[key]).length / n2;
  const pp = (p1 * n1 + p2 * n2) / (n1 + n2);
  if (pp <= 0 || pp >= 1) return 0;
  const se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
  return se > 0 ? (p1 - p2) / se : 0;
}

function wilsonCI(p100, n) {
  if (!n) return [0, 100];
  const p = p100 / 100, z = 1.96;
  const d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [
    Math.round(Math.max(0, c - m) * 1000) / 10,
    Math.round(Math.min(1, c + m) * 1000) / 10,
  ];
}


function minOdds(p) {
  return p > 0 ? (1 / (p / 100)).toFixed(2) : '—';
}

// Live-odds EV / Kelly-stake check for one bet, given the odds a user can
// actually get right now. bet.mo (fair odds) and bet.mo_mid (CI-blended
// odds) are minOdds()-formatted strings; bet.p/bet.lo are percents.
//   offered <= fair            -> NO_VALUE
//   offered >= mo_mid          -> half-Kelly on the conservative CI-lower prob
//   fair < offered < mo_mid    -> quarter-Kelly on the observed prob, scaled
//                                  by how far between fair and mo_mid we are
function calcKellyStake(bet, offeredOdds, bankroll) {
  const fairOdds = parseFloat(bet.mo);
  const midOdds  = parseFloat(bet.mo_mid);
  if (!isFinite(offeredOdds) || offeredOdds <= 1.0 || !isFinite(fairOdds)) {
    return { status: 'INVALID', kellyPct: 0, stakeAmount: null, edgePct: null };
  }

  const edgePct = (offeredOdds / fairOdds - 1) * 100;
  if (offeredOdds <= fairOdds) {
    return { status: 'NO_VALUE', kellyPct: 0, stakeAmount: null, edgePct };
  }

  const pObs = bet.p / 100;
  const pLo  = bet.lo / 100;
  const b    = offeredOdds - 1;
  let kellyPct, status;

  if (isFinite(midOdds) && offeredOdds >= midOdds) {
    const f = (pLo * b - (1 - pLo)) / b;
    kellyPct = Math.max(0, f / 2 * 100);
    status = 'ABOVE_MIN';
  } else {
    const scale = isFinite(midOdds) && midOdds > fairOdds
      ? (offeredOdds - fairOdds) / (midOdds - fairOdds) : 1;
    const f = (pObs * b - (1 - pObs)) / b;
    kellyPct = Math.max(0, 0.25 * f * scale * 100);
    status = 'BELOW_MIN';
  }

  const stakeAmount = (bankroll != null && bankroll > 0) ? bankroll * (kellyPct / 100) : null;
  return { status, kellyPct, stakeAmount, edgePct };
}

// Average market-implied probability (%) for a set of rows, using a closing
// odds field. Returns null when fewer than 5 rows have valid odds.
// Used to build a market-calibrated baseline: compares the signal-filtered
// hit rate directly against what Pinnacle was pricing for the same matches,
// rather than against a naive population average.
function avgMarketImplied(rows, oddsKey) {
  const valid = rows.filter(r => r[oddsKey] != null && r[oddsKey] > 1);
  if (valid.length < 5) return null;
  const sum = valid.reduce((s, r) => s + (1 / r[oddsKey]), 0);
  return sum / valid.length * 100;
}

// ── GSA Probe ─────────────────────────────────────────────────────────────────
// Computes absolute probability for each GS_PROBE_OUTCOME under two conditions:
//   signal+state : cfgRows filtered by game state (pre-match signal + HT score)
//   state only   : blRows filtered by game state  (no signal — score alone)
// Returns fair odds (1/P) and conservative odds (1/CI_lower) for each outcome.
function computeGsProbe(cfgRows, blRows, gs) {
  if (!cfgRows.length || !blRows.length) return null;
  const sigRows   = applyGameState(cfgRows, gs);
  const stateRows = applyGameState(blRows,  gs);
  const sn = sigRows.length;
  const tn = stateRows.length;
  if (!sn || !tn) return null;

  const outcomes = GS_PROBE_OUTCOMES.map(({ k, label, group }) => {
    const sh = sigRows.filter(r => r[k]).length;
    const sp = sn ? sh / sn * 100 : 0;
    const [slo, shi] = wilsonCI(sp, sn);

    const th = stateRows.filter(r => r[k]).length;
    const tp = tn ? th / tn * 100 : 0;

    const z = zScore(sigRows, stateRows, k);
    return {
      k, label, group,
      sn, sh, sp, slo, shi,
      tn, th, tp, z,
      delta:     sp - tp,
      fairOdds:  sp  > 0 ? (100 / sp)  : null,
      consOdds:  slo > 0 ? (100 / slo) : null,
      stateOdds: tp  > 0 ? (100 / tp)  : null,
    };
  });

  return { sn, tn, outcomes };
}

// FT result distribution for the matched rows vs baseline.
// Used to show full-match context alongside 2H bet signals.
function computeFtDist(stateRows, baselineRows) {
  if (!stateRows.length || !baselineRows.length) return null;
  const stat = key => ({ p: pct(stateRows, key), bl: pct(baselineRows, key) });
  const favWins = stat('favWinsFT');
  const draw    = stat('drawFT');
  return {
    favWins,
    draw,
    dogWins: {
      p:  Math.max(0, 100 - favWins.p  - draw.p),
      bl: Math.max(0, 100 - favWins.bl - draw.bl),
    },
    over15:  stat('over15FT'),
    over25:  stat('over25FT'),
    over35:  stat('over35FT'),
    btts:    stat('btts'),
    under25: stat('under25FT'),
  };
}

/* ════════════════════════════════════════════════════════════
   BAYESIAN ENGINE
   ════════════════════════════════════════════════════════════ */

function htBucket(r) {
  const fh = r.fav_ht, dh = r.dog_ht;
  if (fh == null || dh == null || isNaN(fh) || isNaN(dh)) return 'UNKNOWN';
  if (fh > dh) return 'fav_ahead';    // any margin: 1-0, 2-0, 2-1, 3-0...
  if (dh > fh) return 'dog_ahead';    // any margin: 0-1, 0-2, 1-2...
  if (fh === 0) return 'level_0';     // 0-0
  return 'level_goals';               // 1-1, 2-2
}

function computeBayesLRs(rows, activeHt) {
  const DIMS = [
    { key: 'lm',  field: r => r.line_move      },
    { key: 'om',  field: r => r.fav_odds_move   },
    { key: 'tlm', field: r => r.tl_move         },
    { key: 'ovm', field: r => r.over_move       },
  ];
  if (activeHt) {
    DIMS.push({ key: 'ht', field: r => htBucket(r) });
  }

  const lrTable = {};

  for (const bet of BETS) {
    lrTable[bet.k] = {};

    // rows is already side-filtered (baseRows passed from runBayesian); no need to re-filter
    const pool = rows;

    const hits   = pool.filter(r => r[bet.k] === true);
    const misses = pool.filter(r => r[bet.k] === false);

    for (const dim of DIMS) {
      // Collect distinct values in pool for dynamic Laplace K
      const allVals = new Set(pool.map(dim.field));
      const K = allVals.size || 1;

      lrTable[bet.k][dim.key] = {};

      for (const v of allVals) {
        const hitsWithV   = hits.filter(r => dim.field(r) === v).length;
        const missesWithV = misses.filter(r => dim.field(r) === v).length;

        const pHit  = (hitsWithV   + 1) / (hits.length   + K);
        const pMiss = (missesWithV + 1) / (misses.length  + K);

        lrTable[bet.k][dim.key][v] = pHit / pMiss;
      }
    }
  }

  return { lrTable, n: rows.length };
}

function bayesianPosterior(baselineRate, lrTable, betKey, signals) {
  // baselineRate is a probability in [0, 1], NOT a percentage
  const safe = Math.max(0.001, Math.min(0.999, baselineRate));
  let logOdds = Math.log(safe / (1 - safe));

  const betLRs = lrTable[betKey];
  if (!betLRs) return { posterior: baselineRate, delta: 0 };

  for (const [dim, value] of Object.entries(signals)) {
    if (value == null || value === 'UNKNOWN') continue;
    const lr = betLRs[dim]?.[value];
    if (lr == null || lr <= 0) continue;
    logOdds += Math.log(lr);
  }

  const posterior = 1 / (1 + Math.exp(-logOdds));
  return { posterior, delta: posterior - baselineRate };
}

/* ─── Bayesian Run ─── */

function getBayesDimValue(r, dim) {
  if (dim === 'lm')  return r.line_move;
  if (dim === 'om')  return r.fav_odds_move;
  if (dim === 'tlm') return r.tl_move;
  if (dim === 'ovm') return r.over_move;
  if (dim === 'ht')  return htBucket(r);
  return null;
}

function runBayesian() {
  if (!_db.length) { showError('No database loaded. Please upload CSV files first.'); return; }

  // --- Read AH line (required) ---
  const hcRaw = document.getElementById('ah_hc').value;
  const hc = sf(hcRaw);
  if (hc === null) {
    showError('Enter AH closing line in the Advanced mode inputs first.');
    return;
  }
  const favLc = Math.abs(hc);
  const favLine = VALID_LINES.find(v => Math.abs(favLc - v) < LINE_THRESH);
  if (favLine === undefined) {
    showError('Invalid AH line value.');
    return;
  }

  // Don't call showLoader() here — when invoked from useScanMatch the bet
  // dashboard is already rendered; we append below it.

  // --- Read fav side ---
  const hoc = sf(document.getElementById('ho_c').value);
  const aoc = sf(document.getElementById('ao_c').value);
  let favSide;
  if      (hc < -0.01)                  favSide = 'HOME';
  else if (hc >  0.01)                  favSide = 'AWAY';
  else if (hoc !== null && aoc !== null) favSide = hoc <= aoc ? 'HOME' : 'AWAY';
  else                                   favSide = 'HOME'; // level ball, no odds entered — default HOME

  // --- Filter DB (same as applyBaselineConfig) ---
  const activeDb = getDb();
  let baseRows = activeDb.filter(r => Math.abs(r.fav_line - favLine) < LINE_THRESH);
  baseRows = baseRows.filter(r => r.fav_side === favSide);

  // Optional TL filter (closing value only)
  const tlcRaw = document.getElementById('tl_c').value;
  const tlc = sf(tlcRaw);
  if (tlc !== null) {
    baseRows = baseRows.filter(r => r.tl_c != null && Math.abs(r.tl_c - tlc) < TL_THRESH);
  }

  if (baseRows.length < DEFAULT_MIN_N) {
    showError(`Too few baseline records (${baseRows.length}) — need at least ${DEFAULT_MIN_N}.`);
    return;
  }

  // --- Derive signals from raw form values ---
  const hoo = sf(document.getElementById('ah_ho').value);
  const favLo = hoo !== null ? Math.abs(hoo) : null;
  let lmSignal = null;
  if (favLo !== null) {
    const diff = favLc - favLo;
    lmSignal = diff > LINE_THRESH ? 'DEEPER' : diff < -LINE_THRESH ? 'SHRANK' : 'STABLE';
  }

  const hooOdds = sf(document.getElementById('ho_o').value);
  const aooOdds = sf(document.getElementById('ao_o').value);
  const favOc = favSide === 'AWAY' ? aoc : hoc;
  const favOo = favSide === 'AWAY' ? aooOdds : hooOdds;
  const omSignalRaw = oddsDir(favOc, favOo);
  const omSignal = omSignalRaw === 'UNKNOWN' ? null : omSignalRaw;

  const tlo = sf(document.getElementById('tl_o').value);
  const tlmSignalRaw = moveDir(tlc, tlo, TL_THRESH);
  const tlmSignal = tlmSignalRaw === 'UNKNOWN' ? null : tlmSignalRaw;

  const ovc = sf(document.getElementById('ov_c').value);
  const ovo = sf(document.getElementById('ov_o').value);
  const ovmSignalRaw = oddsDir(ovc, ovo);
  const ovmSignal = ovmSignalRaw === 'UNKNOWN' ? null : ovmSignalRaw;

  // --- HT dimension: only if game state trigger is HT and score is provided ---
  let htSignal = null;
  if (state.gsTrigger === 'HT') {
    const homeGoals = parseInt(document.getElementById('gs-panel-home')?.value, 10);
    const awayGoals = parseInt(document.getElementById('gs-panel-away')?.value, 10);
    if (!isNaN(homeGoals) && !isNaN(awayGoals)) {
      const favHt = favSide === 'AWAY' ? awayGoals : homeGoals;
      const dogHt = favSide === 'AWAY' ? homeGoals : awayGoals;
      if      (favHt > dogHt) htSignal = 'fav_ahead';
      else if (dogHt > favHt) htSignal = 'dog_ahead';
      else if (favHt === 0)   htSignal = 'level_0';
      else                    htSignal = 'level_goals';
    }
  }

  const signals = {
    lm:  lmSignal,
    om:  omSignal,
    tlm: tlmSignal,
    ovm: ovmSignal,
  };
  if (htSignal !== null) signals.ht = htSignal;

  const activeHt = htSignal !== null;

  // --- Compute LRs and posteriors ---
  const { lrTable, n } = computeBayesLRs(baseRows, activeHt);

  const results = BETS.map(bet => {
    // baseRows is already side-filtered; favSideBaseline re-filter would zero out opposite-side bets
    const pool = baseRows;
    const baselineRate = pct(pool, bet.k) / 100;
    const { posterior, delta } = bayesianPosterior(baselineRate, lrTable, bet.k, signals);

    // Flag unreliable: any active signal cell < DEFAULT_MIN_N rows
    let unreliable = false;
    for (const [dim, value] of Object.entries(signals)) {
      if (value == null) continue;
      const hits   = pool.filter(r => r[bet.k] === true  && getBayesDimValue(r, dim) === value).length;
      const misses = pool.filter(r => r[bet.k] === false && getBayesDimValue(r, dim) === value).length;
      if (hits < DEFAULT_MIN_N || misses < DEFAULT_MIN_N) { unreliable = true; break; } // || is intentional: either side sparse → LR unreliable
    }

    return {
      k: bet.k, label: bet.label,
      baseline: baselineRate * 100,
      posterior: posterior * 100,
      delta: delta * 100,
      unreliable,
      poolN: pool.length,
    };
  });

  results.sort((a, b) => {
    if (a.unreliable !== b.unreliable) return a.unreliable ? 1 : -1;
    return b.delta - a.delta;
  });

  renderBayesianScore(results, n, signals, { favLine, favSide, tlc });
}

/* ════════════════════════════════════════════════════════════
   ENGINE
   ════════════════════════════════════════════════════════════ */
function applyConfig(db, cfg) {
  let rows = db;

  if (cfg.fav_line != null && cfg.fav_line !== 'ANY') {
    const fl = parseFloat(cfg.fav_line);
    rows = rows.filter(r => Math.abs(r.fav_line - fl) < 0.13);
  }
  // Deliberately NOT filtering on cfg.fav_lo (exact opening-line match) here.
  // The closing line above is what actually determines the bet's payout;
  // fav_lo's only real signal is captured via cfg.line_move (DEEPER/STABLE/
  // SHRANK), which is filtered separately below. Requiring the opening line
  // to also match almost exactly (±0.13, unsnapped) on top of line_move was
  // pure sample-size loss with no settlement-relevant justification — an
  // empirical check on the Bet365 dataset found it cut a matching pool of
  // 17,368 rows down to 4,098 (76%) despite ~6,500 of the excluded rows
  // sharing the same line_move direction and identical closing-line mechanics.
  if (cfg.fav_side != null && cfg.fav_side !== 'ANY') {
    rows = rows.filter(r => r.fav_side === cfg.fav_side);
  }
  if (cfg.line_move != null && cfg.line_move !== 'ANY' && cfg.line_move !== 'UNKNOWN') {
    rows = rows.filter(r => r.line_move === cfg.line_move);
  }

  const tol = cfg.odds_tolerance;
  if (tol != null) {
    for (const key of ['fav_oc', 'fav_oo', 'dog_oc', 'dog_oo']) {
      const val = cfg[key];
      if (val != null) rows = rows.filter(r => r[key] != null && Math.abs(r[key] - val) <= tol);
    }
  }
  if (cfg.fav_odds_move != null && cfg.fav_odds_move !== 'ANY' && cfg.fav_odds_move !== 'UNKNOWN')
    rows = rows.filter(r => r.fav_odds_move === cfg.fav_odds_move);
  if (cfg.fav_odds_min_delta != null) {
    rows = rows.filter(r =>
      r.fav_oo != null && r.fav_oc != null &&
      Math.abs(r.fav_oo - r.fav_oc) >= cfg.fav_odds_min_delta
    );
  }
  if (cfg.dog_odds_move != null && cfg.dog_odds_move !== 'ANY' && cfg.dog_odds_move !== 'UNKNOWN')
    rows = rows.filter(r => r.dog_odds_move === cfg.dog_odds_move);

  if (cfg.fav_vs_dog === 'GT') rows = rows.filter(r => r.fav_oc != null && r.dog_oc != null && r.fav_oc > r.dog_oc);
  if (cfg.fav_vs_dog === 'LT') rows = rows.filter(r => r.fav_oc != null && r.dog_oc != null && r.fav_oc < r.dog_oc);

  if (cfg.over_move != null && cfg.over_move !== 'ANY' && cfg.over_move !== 'UNKNOWN')
    rows = rows.filter(r => r.over_move === cfg.over_move);

  if (cfg.under_move != null && cfg.under_move !== 'ANY' && cfg.under_move !== 'UNKNOWN')
    rows = rows.filter(r => r.under_move === cfg.under_move);

  // Over odds closing tolerance
  if (cfg.ov_tol != null && cfg.ov_c != null)
    rows = rows.filter(r => r.ov_c != null && Math.abs(r.ov_c - cfg.ov_c) <= cfg.ov_tol);

  // Under odds closing tolerance
  if (cfg.un_tol != null && cfg.un_c != null)
    rows = rows.filter(r => r.un_c != null && Math.abs(r.un_c - cfg.un_c) <= cfg.un_tol);

  // TL exact range takes priority over cluster and exact tl_c
  if (cfg.tl_range != null) {
    const [lo, hi] = cfg.tl_range;
    rows = rows.filter(r => r.tl_c != null && r.tl_c >= lo && r.tl_c <= hi);
  } else {
    const tlCluster = cfg.tl_cluster;
    if (tlCluster != null && tlCluster !== 'ANY' && TL_CLUSTERS[tlCluster]) {
      const [lo, hi] = TL_CLUSTERS[tlCluster];
      rows = rows.filter(r => r.tl_c != null
        && (lo == null || r.tl_c >= lo)
        && (hi == null || r.tl_c < hi));
    } else if (cfg.tl_c != null && cfg.tl_c !== 'ANY') {
      const tlc = parseFloat(cfg.tl_c);
      if (!isNaN(tlc)) rows = rows.filter(r => r.tl_c != null && Math.abs(r.tl_c - tlc) < 0.13);
    }
  }

  // TL opening match
  if (cfg.tl_o != null && cfg.tl_o !== 'ANY') {
    const tlo = parseFloat(cfg.tl_o);
    if (!isNaN(tlo)) rows = rows.filter(r => r.tl_o != null && Math.abs(r.tl_o - tlo) < 0.13);
  }

  if (cfg.tl_move != null && cfg.tl_move !== 'ANY' && cfg.tl_move !== 'UNKNOWN')
    rows = rows.filter(r => r.tl_move === cfg.tl_move);
  if (cfg.tl_max != null)
    rows = rows.filter(r => r.tl_c != null && r.tl_c <= parseFloat(cfg.tl_max));

  return rows;
}

/* Baseline filter: only the closing market values the bookmaker/public sees.
   No movement signals, no opening values, no game state.
   Used as the reference hit-rate against which informational edge is measured. */
function applyBaselineConfig(db, cfg) {
  let rows = db;

  // AH closing line
  if (cfg.fav_line != null && cfg.fav_line !== 'ANY') {
    const fl = parseFloat(cfg.fav_line);
    rows = rows.filter(r => Math.abs(r.fav_line - fl) < 0.13);
  }
  if (cfg.fav_side != null && cfg.fav_side !== 'ANY') {
    rows = rows.filter(r => r.fav_side === cfg.fav_side);
  }

  // AH closing odds only (not opening, not movement direction)
  const tol = cfg.odds_tolerance;
  if (tol != null) {
    for (const key of ['fav_oc', 'dog_oc']) {
      const val = cfg[key];
      if (val != null) rows = rows.filter(r => r[key] != null && Math.abs(r[key] - val) <= tol);
    }
  }

  // TL closing value (range / cluster / exact) — no tl_move, no tl_o
  if (cfg.tl_range != null) {
    const [lo, hi] = cfg.tl_range;
    rows = rows.filter(r => r.tl_c != null && r.tl_c >= lo && r.tl_c <= hi);
  } else {
    const tlCluster = cfg.tl_cluster;
    if (tlCluster != null && tlCluster !== 'ANY' && TL_CLUSTERS[tlCluster]) {
      const [lo, hi] = TL_CLUSTERS[tlCluster];
      rows = rows.filter(r => r.tl_c != null
        && (lo == null || r.tl_c >= lo)
        && (hi == null || r.tl_c < hi));
    } else if (cfg.tl_c != null && cfg.tl_c !== 'ANY') {
      const tlc = parseFloat(cfg.tl_c);
      if (!isNaN(tlc)) rows = rows.filter(r => r.tl_c != null && Math.abs(r.tl_c - tlc) < 0.13);
    }
  }

  return rows;
}

function applyGameState(rows, gs) {
  const trigger = gs.trigger || 'HT';
  if (trigger === 'HT') {
    const homeG = parseInt(gs.home_goals || 0, 10);
    const awayG = parseInt(gs.away_goals || 0, 10);
    return rows.filter(r =>
      r.fav_side === 'HOME'
        ? r.fav_ht === homeG && r.dog_ht === awayG
        : r.fav_ht === awayG && r.dog_ht === homeG
    );
  } else if (trigger === 'FIRST_GOAL') {
    const half     = parseInt(gs.minute || 35, 10) <= 45 ? '1H' : '2H';
    const goalSide = gs.goal_team || 'HOME';
    return rows.filter(r => {
      const team = (r.fav_side === 'HOME') === (goalSide === 'HOME') ? 'FAV' : 'DOG';
      return r.first_goal === `${team}_${half}`;
    });
  } else { // INPLAY_2H
    const home2h = parseInt(gs.home_2h || 0, 10);
    const away2h = parseInt(gs.away_2h || 0, 10);
    return rows.filter(r => r.home_2h >= home2h && r.away_2h >= away2h);
  }
}

// baselineSideRows: baseline pre-filtered to the match's fav_side.
// Used only for home/away-specific bets (those with favSideBaseline set) so
// their reference rate isn't diluted by the opposite-side population.
// If null (e.g. fav_side truly unknown), falls back to baselineRows.
// includeMatches:false skips building the per-row `matches` drill-down array
// (an O(stateRows.length) allocation done for every one of the 32 bets) —
// used by the Daily Dashboard, which only needs the aggregate stats (p/edge/
// z/n/mo) to pick a top bet per fixture and calls this hundreds of times per
// run, where building unused matches arrays was a real cost.
function scoreBets(stateRows, baselineRows, baselineSideRows, minN = DEFAULT_MIN_N, { includeMatches = true } = {}) {
  if (!stateRows.length || !baselineRows.length) return [];
  const n = stateRows.length;
  if (n < minN) return [];
  const results = [];
  for (const b of BETS) {
    const blRows = (b.favSideBaseline && baselineSideRows) ? baselineSideRows : baselineRows;
    const p    = pct(stateRows, b.k);
    const bl   = pct(blRows,   b.k);
    const z    = zScore(stateRows, blRows, b.k);
    const edge = p - bl;
    const [lo, hi] = wilsonCI(p, n);
    const matches = includeMatches ? stateRows.map(r => ({
      date:      r.date      || '',
      league:    r.league    || '',
      home_team: r.home_team || '',
      away_team: r.away_team || '',
      fav_lc:    r.fav_lc,
      fav_side:  r.fav_side,
      tl_c:      r.tl_c,
      ht:        [r.fav_ht, r.dog_ht],
      ft:        [r.fav_ft, r.dog_ft],
      hit:       !!r[b.k],
    })) : [];
    const mo_mid = minOdds((p + lo) / 2);
    // Market-calibrated baseline: avg implied prob from closing odds in the
    // signal-filtered pool. Tells you whether the signal beat what Pinnacle
    // was already pricing for those exact matches — the only meaningful edge.
    const mkt_bl   = b.marketOddsKey ? avgMarketImplied(stateRows, b.marketOddsKey) : null;
    const mkt_edge = mkt_bl != null ? p - mkt_bl : null;
    const mkt_avg_odds = mkt_bl != null ? (100 / mkt_bl).toFixed(2) : null;
    // For TL bets, compute avg closing TL across filtered rows so the card can show the actual line
    const avgTl = (b.k === 'overTL' || b.k === 'underTL')
      ? (() => { const v = stateRows.filter(r => r.tl_c != null); return v.length ? v.reduce((s, r) => s + r.tl_c, 0) / v.length : null; })()
      : null;
    results.push({ ...b, n, p, bl, z, edge, lo, hi, mo: minOdds(p), mo_lo: minOdds(lo), mo_mid, matches, mkt_bl, mkt_edge, mkt_avg_odds, avgTl });
  }
  results.sort((a, b) => {
    const aPos = a.edge > 0, bPos = b.edge > 0;
    if (aPos !== bPos) return aPos ? -1 : 1;
    return (b.z * (b.lo / 100)) - (a.z * (a.lo / 100));
  });
  return results;
}

function traceConfig(db, cfg, gs) {
  const steps = [['Total DB', db.length]];
  let rows = db;

  if (cfg.fav_line != null && cfg.fav_line !== 'ANY') {
    const fl = parseFloat(cfg.fav_line);
    rows = rows.filter(r => Math.abs(r.fav_line - fl) < 0.13);
    steps.push([`AH line ${cfg.fav_line}`, rows.length]);
  }
  // No opening-line exact-match step — see applyConfig()'s comment on why
  // that filter was dropped (line_move already captures the useful signal).
  if (cfg.fav_side != null && cfg.fav_side !== 'ANY') {
    rows = rows.filter(r => r.fav_side === cfg.fav_side);
    steps.push([`Fav side ${cfg.fav_side}`, rows.length]);
  }
  if (cfg.line_move != null && cfg.line_move !== 'ANY' && cfg.line_move !== 'UNKNOWN') {
    rows = rows.filter(r => r.line_move === cfg.line_move);
    steps.push([`Line move ${cfg.line_move}`, rows.length]);
  }

  const tol = cfg.odds_tolerance;
  if (tol != null) {
    for (const key of ['fav_oc', 'fav_oo', 'dog_oc', 'dog_oo']) {
      const val = cfg[key];
      if (val != null) rows = rows.filter(r => r[key] != null && Math.abs(r[key] - val) <= tol);
    }
    steps.push([`AH odds tol ±${tol}`, rows.length]);
  }
  if (cfg.fav_odds_move != null && cfg.fav_odds_move !== 'ANY' && cfg.fav_odds_move !== 'UNKNOWN') {
    rows = rows.filter(r => r.fav_odds_move === cfg.fav_odds_move);
    steps.push([`Fav odds ${cfg.fav_odds_move}`, rows.length]);
  }
  if (cfg.fav_odds_min_delta != null) {
    rows = rows.filter(r =>
      r.fav_oo != null && r.fav_oc != null &&
      Math.abs(r.fav_oo - r.fav_oc) >= cfg.fav_odds_min_delta
    );
    steps.push([`Fav odds Δ ≥${cfg.fav_odds_min_delta}`, rows.length]);
  }
  if (cfg.dog_odds_move != null && cfg.dog_odds_move !== 'ANY' && cfg.dog_odds_move !== 'UNKNOWN') {
    rows = rows.filter(r => r.dog_odds_move === cfg.dog_odds_move);
    steps.push([`Dog odds ${cfg.dog_odds_move}`, rows.length]);
  }

  if (cfg.fav_vs_dog === 'GT') {
    rows = rows.filter(r => r.fav_oc != null && r.dog_oc != null && r.fav_oc > r.dog_oc);
    steps.push([`Fav odds > Dog odds`, rows.length]);
  }
  if (cfg.fav_vs_dog === 'LT') {
    rows = rows.filter(r => r.fav_oc != null && r.dog_oc != null && r.fav_oc < r.dog_oc);
    steps.push([`Fav odds < Dog odds`, rows.length]);
  }

  if (cfg.over_move != null && cfg.over_move !== 'ANY' && cfg.over_move !== 'UNKNOWN') {
    rows = rows.filter(r => r.over_move === cfg.over_move);
    steps.push([`Over odds ${cfg.over_move}`, rows.length]);
  }

  if (cfg.under_move != null && cfg.under_move !== 'ANY' && cfg.under_move !== 'UNKNOWN') {
    rows = rows.filter(r => r.under_move === cfg.under_move);
    steps.push([`Under odds ${cfg.under_move}`, rows.length]);
  }

  if (cfg.ov_tol != null && cfg.ov_c != null) {
    rows = rows.filter(r => r.ov_c != null && Math.abs(r.ov_c - cfg.ov_c) <= cfg.ov_tol);
    steps.push([`Over odds tol ±${cfg.ov_tol}`, rows.length]);
  }
  if (cfg.un_tol != null && cfg.un_c != null) {
    rows = rows.filter(r => r.un_c != null && Math.abs(r.un_c - cfg.un_c) <= cfg.un_tol);
    steps.push([`Under odds tol ±${cfg.un_tol}`, rows.length]);
  }

  if (cfg.tl_range != null) {
    const [lo, hi] = cfg.tl_range;
    rows = rows.filter(r => r.tl_c != null && r.tl_c >= lo && r.tl_c <= hi);
    steps.push([`TL range ${lo}–${hi}`, rows.length]);
  } else {
    const tlCluster = cfg.tl_cluster;
    if (tlCluster != null && tlCluster !== 'ANY' && TL_CLUSTERS[tlCluster]) {
      const [lo, hi] = TL_CLUSTERS[tlCluster];
      rows = rows.filter(r => r.tl_c != null
        && (lo == null || r.tl_c >= lo)
        && (hi == null || r.tl_c < hi));
      steps.push([`TL cluster ${tlCluster}`, rows.length]);
    } else if (cfg.tl_c != null && cfg.tl_c !== 'ANY') {
      const tlc = parseFloat(cfg.tl_c);
      if (!isNaN(tlc)) {
        rows = rows.filter(r => r.tl_c != null && Math.abs(r.tl_c - tlc) < 0.13);
        steps.push([`TL ≈${tlc.toFixed(2)}`, rows.length]);
      }
    }
  }

  if (cfg.tl_o != null && cfg.tl_o !== 'ANY') {
    const tlo = parseFloat(cfg.tl_o);
    if (!isNaN(tlo)) {
      rows = rows.filter(r => r.tl_o != null && Math.abs(r.tl_o - tlo) < 0.13);
      steps.push([`TL opening ≈${tlo.toFixed(2)}`, rows.length]);
    }
  }

  if (cfg.tl_move != null && cfg.tl_move !== 'ANY' && cfg.tl_move !== 'UNKNOWN') {
    rows = rows.filter(r => r.tl_move === cfg.tl_move);
    steps.push([`TL move ${cfg.tl_move}`, rows.length]);
  }

  if (gs) {
    const gsRows  = applyGameState(rows, gs);
    const trigger = gs.trigger || 'HT';
    let gsStepLabel;
    if (trigger === 'HT')
      gsStepLabel = `HT ${gs.home_goals || 0}-${gs.away_goals || 0} (Home-Away)`;
    else if (trigger === 'FIRST_GOAL')
      gsStepLabel = `First goal ${gs.goal_team || '?'} min ${gs.minute || '?'}`;
    else
      gsStepLabel = `In-play 2H score ${gs.home_2h || 0}-${gs.away_2h || 0} (Home-Away)`;
    steps.push([gsStepLabel, gsRows.length]);
  }

  return steps;
}

function deriveConfig(ahHc, ahHo, hoC, hoO, aoC, aoO, tlC, tlO, ovC, ovO) {
  const hc = sf(ahHc);
  if (hc === null) return null;
  const ho = sf(ahHo), hoc = sf(hoC), hoo = sf(hoO);
  const aoc = sf(aoC), aoo = sf(aoO);
  const tlc = sf(tlC), tlo = sf(tlO);
  const ovc = sf(ovC), ovo = sf(ovO);

  let favSide, favLc, favLo, favOc, favOo, dogOc, dogOo;
  if (hc < -0.01) {
    favSide = 'HOME'; favLc = Math.abs(hc); favLo = ho !== null ? Math.abs(ho) : null;
    favOc = hoc; favOo = hoo; dogOc = aoc; dogOo = aoo;
  } else if (hc > 0.01) {
    favSide = 'AWAY'; favLc = Math.abs(hc); favLo = ho !== null ? Math.abs(ho) : null;
    favOc = aoc; favOo = aoo; dogOc = hoc; dogOo = hoo;
  } else {
    favSide = 'HOME'; favLc = 0.0; favLo = ho !== null ? Math.abs(ho) : null;
    favOc = hoc; favOo = hoo; dogOc = aoc; dogOo = aoo;
  }

  const favLine = VALID_LINES.find(v => Math.abs(favLc - v) < 0.13);
  let lineMove = 'UNKNOWN';
  if (favLo !== null) {
    const diff = favLc - favLo;
    lineMove = diff > LINE_THRESH ? 'DEEPER' : diff < -LINE_THRESH ? 'SHRANK' : 'STABLE';
  }

  return {
    fav_side:      favSide,
    fav_line:      favLine !== undefined ? favLine.toFixed(2) : '?',
    fav_lc:        favLc,
    fav_lo:        favLo,
    fav_oc:        favOc,
    fav_oo:        favOo,
    dog_oc:        dogOc,
    dog_oo:        dogOo,
    tl_c:          tlc,
    line_move:     lineMove,
    fav_odds_move: oddsDir(favOc, favOo),
    dog_odds_move: oddsDir(dogOc, dogOo),
    tl_move:       moveDir(tlc, tlo, TL_THRESH),
    over_move:     oddsDir(ovc, ovo),
  };
}

function discover(db, favLine, favSide, inLineMove, inTlMove, gs, minN = DEFAULT_MIN_N, tlC = 'ANY', htAsSignal = false) {
  let base = db;
  if (favLine !== 'ANY') {
    const fl = parseFloat(favLine);
    base = base.filter(r => Math.abs(r.fav_line - fl) < 0.13);
  }
  if (favSide !== 'ANY') {
    base = base.filter(r => r.fav_side === favSide);
  }
  if (tlC != null && tlC !== 'ANY') {
    if (TL_CLUSTERS[tlC]) {
      const [lo, hi] = TL_CLUSTERS[tlC];
      base = base.filter(r => r.tl_c != null
        && (lo == null || r.tl_c >= lo)
        && (hi == null || r.tl_c < hi));
    } else {
      const tlv = parseFloat(tlC);
      if (!isNaN(tlv)) base = base.filter(r => r.tl_c != null && Math.abs(r.tl_c - tlv) < 0.13);
    }
  }

  const baseGs = applyGameState(base, gs);
  if (baseGs.length < minN) return [];

  // Baseline uses baseGs (game-state-filtered) so the reference rate reflects
  // the same HT/first-goal/in-play condition as the signal rows.
  // When favSide is ANY, home/away-specific bets also get a side-filtered baseline.
  const baseHome = favSide === 'ANY' ? baseGs.filter(r => r.fav_side === 'HOME') : null;
  const baseAway = favSide === 'ANY' ? baseGs.filter(r => r.fav_side === 'AWAY') : null;

  const results = [];

  // HT-as-signal mode: compare HT-filtered pool vs full pre-HT base (no signal sweep)
  if (htAsSignal && gs) {
    const blHome = favSide === 'ANY' ? base.filter(r => r.fav_side === 'HOME') : null;
    const blAway = favSide === 'ANY' ? base.filter(r => r.fav_side === 'AWAY') : null;
    for (const b of BETS) {
      const k = b.k;
      if (k.includes('1H')) continue; // 1H bets are expired at HT
      let blPool = base;
      if      (b.favSideBaseline === 'HOME' && blHome) blPool = blHome;
      else if (b.favSideBaseline === 'AWAY' && blAway) blPool = blAway;
      const p    = pct(baseGs, k);
      const bl   = pct(blPool, k);
      const z    = zScore(baseGs, blPool, k);
      const edge = p - bl;
      if (Math.abs(z) < MIN_Z_DISC || edge <= 0) continue;
      const [lo] = wilsonCI(p, baseGs.length);
      results.push({
        cfg: { fav_line: favLine, fav_side: favSide, htAsSignal: true },
        k, n: baseGs.length, p, bl, z, edge, lo,
        mo: minOdds(p), mo_mid: minOdds((p + lo) / 2),
        label:  b.label  || k,
        market: b.market || k,
      });
    }
    results.sort((a, b) => b.z - a.z);
    return results.slice(0, 15);
  }

  const lmOptions  = inLineMove !== 'ANY' ? [inLineMove] : ['DEEPER', 'STABLE', 'SHRANK'];
  const tlmOptions = inTlMove   !== 'ANY' ? [inTlMove]  : ['UP', 'STABLE', 'DOWN', 'ANY'];

  for (const lm of lmOptions) {
    for (const fom of ['IN', 'STABLE', 'OUT', 'ANY']) {
      for (const dom of ['IN', 'STABLE', 'OUT', 'ANY']) {
        for (const tlm of tlmOptions) {
          for (const ovm of ['IN', 'STABLE', 'OUT', 'ANY']) {
            const cfg = {
              fav_line: favLine, fav_side: favSide,
              line_move: lm, fav_odds_move: fom,
              dog_odds_move: dom, over_move: ovm,
              tl_move: tlm, tl_max: null,
            };
            const cfgR = applyConfig(base, cfg);
            const gsR  = applyGameState(cfgR, gs);
            if (gsR.length < minN) continue;
            for (const b of BETS) {
              const k = b.k;
              let blPool = baseGs;
              if      (b.favSideBaseline === 'HOME' && baseHome) blPool = baseHome;
              else if (b.favSideBaseline === 'AWAY' && baseAway) blPool = baseAway;
              const p    = pct(gsR, k);
              const bl   = pct(blPool, k);
              const z    = zScore(gsR, blPool, k);
              const edge = p - bl;
              if (Math.abs(z) < MIN_Z_DISC || edge <= 0) continue;
              const [lo] = wilsonCI(p, gsR.length);
              results.push({
                cfg, k, n: gsR.length, p, bl, z, edge, lo,
                mo: minOdds(p), mo_mid: minOdds((p + lo) / 2),
                label:  b.label  || k,
                market: b.market || k,
              });
            }
          }
        }
      }
    }
  }

  results.sort((a, b) => {
    const aPos = a.edge > 0, bPos = b.edge > 0;
    if (aPos !== bPos) return aPos ? -1 : 1;
    return (b.z * (b.lo / 100)) - (a.z * (a.lo / 100));
  });
  const seen = new Set();
  const deduped = [];
  for (const r of results) {
    const c   = r.cfg;
    const key = `${c.line_move}|${c.fav_odds_move}|${c.dog_odds_move}|${c.tl_move}|${c.over_move}|${r.k}`;
    if (!seen.has(key)) { seen.add(key); deduped.push(r); }
    if (deduped.length >= 15) break;
  }
  return deduped;
}

/* ════════════════════════════════════════════════════════════
   LIVE ODDS ENGINE  (Poisson time-decay, ported from live_odds.py)
   ════════════════════════════════════════════════════════════ */

// Within-half goal-timing shape. Empirically derived (2026-08-22) from
// football-data/data/goals_time2 — real minute-by-minute goal events, 12
// domestic leagues, 3 seasons each, 27,321 total goals (see
// telegram/goal_timing.js's buildTimingCurve / generate_goal_timing_summary.js).
// This REPLACES a previous version sourced from external published research
// (playthepercentage.com/soccerstats.com), which this app's own CSVs
// couldn't validate (no goal-minute timestamps, HT/FT scores only) — that
// blocker is closed now that goals_time2 exists. The old assumed curve
// significantly overstated 1H late-game clustering and got the 2H middle
// bucket's direction backwards (assumed elevated at 15-30min-of-half; real
// data shows it's the LOWEST of the three buckets) — see CLAUDE.md for the
// full comparison. Cross-league standard deviation was small (0.03-0.05 on
// a 0-3 scale) across very different leagues, so a single pooled curve
// (rather than per-league) is used here — computeLiveOdd has no league
// parameter today; per-league granularity is available in
// static/data/goal_timing_summary.json if this is revisited later.
// Normalised to mean 1.0 within each half, same convention as before.
// Buckets are relative elapsed minutes into the half. _FLAT_INTENSITY is the
// user-toggleable "no clustering assumption" alternative (state.useFlatDecay).
const _1H_INTENSITY = [[0,15,0.907],[15,30,0.937],[30,45,1.156]];
const _2H_INTENSITY = [[0,15,0.879],[15,30,0.874],[30,45,1.247]];
const _FLAT_INTENSITY = [[0,45,1.000]];
// _IT_1H/_IT_2H (2026-08-26): calibrated from goals_time2 (12 leagues, last 3
// seasons through 2024-2025) rather than assumed. Each represents "how many
// extra minutes of goal-intensity mass the stoppage-time window adds" in this
// model's own rate-integral terms — solved so that mass's share of the whole
// half matches the real share of goals recorded during that half's actual
// stoppage time ("45+N'"/"90+N'" incident minutes):
//   stoppageShare = stoppageGoals / totalHalfGoals
//   IT = [stoppageShare/(1-stoppageShare) * integral(0..45, half's curve)] / itRate
// 1H: n=12,261 first-half goals, 5.81% in recorded 1H stoppage (avg 2.65 added
// min when it happens) -> IT_1H = 2.40 (previously assumed 2, "roughly half
// of _IT_2H"). 2H: n=15,060 second-half goals, 12.32% in recorded 2H stoppage
// (avg 3.72 added min) -> IT_2H = 5.07 (previously assumed 4, uncalibrated).
// 2H stoppage share running ~2x 1H's matches the general refereeing pattern
// (more subs/treatment/VAR stoppages accumulate by full time) — a sanity
// check the calibration passes, not something it was tuned to hit.
const _IT_2H = 5.07;
const _IT_1H = 2.40;

// Validated against this app's own ~165k-match dataset (AH line vs. average
// 2H goals) — observed ratios landed within ~1-2% of these values, so kept
// unchanged rather than "corrected".
const _LINE_STRENGTH_MOD = {0.25:0.92,0.50:0.96,0.75:1.00,1.00:1.06,1.25:1.12,1.50:1.18};
// The 2H "who wins the half" 3-way market (favWins2H/draw2H/homeWins2H/
// awayWins2H) is deliberately excluded from the generic single-threshold
// path below — unlike every other key here, "who wins/draws the 2nd half"
// depends on the joint evolution of BOTH sides' goal counts, not a single
// count crossing a threshold. Before this exclusion these all silently fell
// through to the generic "at least 1 goal" default, which — for draw2H —
// flipped it to a bogus "✓ Already hit" 100% the moment ANY 2H goal was
// scored by either side (the opposite of what keeps a match level), and for
// homeWins2H/awayWins2H, declared the leading side an already-100%-certain
// winner the instant it took ANY 2H lead, no matter how much time remained.
// These four route through computeLiveResult2H instead (a proper bivariate
// model, see below) via buildLiveAdjustedBet's own dispatch.
const _2H_RESULT_KEYS = new Set(['favWins2H', 'draw2H', 'homeWins2H', 'awayWins2H']);
const _2H_BETS_SET = new Set([
  'over05_2H','over15_2H','over25_2H','favScored2H','ahCover',
  'homeScored2H','awayScored2H',
  'homeOver15_2H','awayOver15_2H','under05_2H','under15_2H',
]);
const _FT_BETS_SET = new Set([
  'noDrawFT','favWinsFT','homeWinsFT','awayWinsFT',
  'over25FT','over15FT','over35FT','under25FT','drawFT','btts',
  'favWins1H','draw1H','favScored1H','homeWins1H','awayWins1H',
  'over05_1H','over15_1H','under05_1H','under15_1H','btts1H',
]);
const _UNDER_BETS = {'under05_2H':[1,0],'under15_2H':[2,1]};
const _BET_GOAL_THRESHOLD = {
  'over05_2H':1,'over15_2H':2,'over25_2H':3,
  'favScored2H':1,'ahCover':1,
  'homeScored2H':1,'awayScored2H':1,
  'homeOver15_2H':2,'awayOver15_2H':2,
};

// 1H mirror of the 2H sets above. "Result" (favWins1H/draw1H/homeWins1H/
// awayWins1H) and btts1H route through their own bivariate/product dispatch
// in buildLive1HAdjustedBet, same reasoning as the 2H versions — see
// _2H_RESULT_KEYS's comment.
const _1H_RESULT_KEYS = new Set(['favWins1H', 'draw1H', 'homeWins1H', 'awayWins1H']);
const _1H_BETS_SET = new Set([
  'over05_1H', 'over15_1H', 'homeScored1H', 'awayScored1H',
  'under05_1H', 'under15_1H',
]);
const _UNDER_BETS_1H = {'under05_1H':[1,0],'under15_1H':[2,1]};
const _BET_GOAL_THRESHOLD_1H = {
  'over05_1H':1,'over15_1H':2,
  'homeScored1H':1,'awayScored1H':1,
};

// Score-state modifiers. FAV/DOG tables: calibrated from this app's own
// dataset (HT margin -> subsequent 2H scoring, n=6,323-63,386 per bucket).
// Keyed by the current in-2H fav-minus-dog goal margin, applied as a
// bet-class-specific multiplier. Caveat unchanged: measured conditioning on
// HT margin -> rest-of-2H scoring (the only thing measurable without
// goal-minute data) and applied here keyed by live in-2H margin-so-far — a
// reasonable proxy, not an exact match to what was measured. goals_time2
// (real minute-level data) can't fix this directly — it has no pre-match
// favourite designation, only home/away, so it can't isolate a
// favourite-specific "presses on when ahead" effect from a generic leading-
// team effect. A goals_time2-based re-derivation (2026-08-22, 12 leagues,
// checkpoints every 5 min through the 2nd half) of the generic LEADING/
// TRAILING-team analogue found a real, notable divergence worth flagging:
// trailing teams generically score LESS as the margin grows (0.99 / 0.95 /
// 0.77 at margin 0/1/2+), not the flat-to-mild-increase this table assumes
// for a trailing favourite (1.08 at -1, 1.08 at -2) — plausibly because a
// true trailing favourite still has more quality to draw on than a generic
// trailing team (which is disproportionately weaker sides losing further),
// but that's unverifiable without linking to pre-match odds. Left as-is
// pending that data; treat the "-1"/"-2" (favourite trailing) entries with
// more caution than the "1"/"2" (favourite leading) ones.
const _FAV_SCORE_MOD   = {'-2':1.08, '-1':1.08, '0':1.00, '1':1.09, '2':1.45};
const _DOG_SCORE_MOD   = {'-2':1.32, '-1':1.09, '0':1.00, '1':1.06, '2':1.04};
// TOTAL table: this one IS a clean, fully rigorous fix — total goals don't
// care which side is the favourite, only the margin's magnitude, so
// goals_time2's home/away-only data is a genuine apples-to-apples measure
// here (unlike the FAV/DOG tables above). Real data (12 leagues, 3 seasons,
// checkpoints every 5 min through the 2nd half): total 2H scoring barely
// responds to the margin — the leading team's own scoring rising ~27% at a
// 2+ margin and the trailing team's falling ~23% almost fully cancel out
// (net +2.6% at 2+, not the +30% the previous table assumed). The previous
// version substantially overstated how much a big margin "opens the game
// up" — Over 2H bets conditioned on a big current margin were getting an
// inflated boost, and Under 2H bets a correspondingly understated one.
const _TOTAL_SCORE_MOD = {'-2':1.035, '-1':1.023, '0':1.00, '1':1.023, '2':1.035};
const _BET_SCORE_MOD_CLASS = {
  favScored2H:'fav', ahCover:'fav',
  homeScored2H:'side', awayScored2H:'side',
  homeOver15_2H:'side', awayOver15_2H:'side',
  over05_2H:'total', over15_2H:'total', over25_2H:'total',
  under05_2H:'total', under15_2H:'total',
};

function _marginBucket(d){
  if(d<=-2)return '-2'; if(d===-1)return '-1'; if(d===0)return '0';
  if(d===1)return '1'; return '2';
}

// Replaces the old single _scoreStateMod(fav2h,dog2h): dispatches to the
// bet-class-appropriate table. `home`/`away`-scoped bets resolve to the fav
// or dog table depending on which side is the favourite (favSide).
function _pickScoreMod(betKey, fav2h, dog2h, favSide){
  const cls = _BET_SCORE_MOD_CLASS[betKey];
  const bucket = _marginBucket(fav2h - dog2h);
  if(cls === 'fav')   return _FAV_SCORE_MOD[bucket];
  if(cls === 'total') return _TOTAL_SCORE_MOD[bucket];
  if(cls === 'side'){
    const isFavBet = (favSide === 'HOME' && (betKey === 'homeScored2H' || betKey === 'homeWins2H' || betKey === 'homeOver15_2H'))
                   || (favSide === 'AWAY' && (betKey === 'awayScored2H' || betKey === 'awayWins2H' || betKey === 'awayOver15_2H'));
    return isFavBet ? _FAV_SCORE_MOD[bucket] : _DOG_SCORE_MOD[bucket];
  }
  return 1.0;
}

function _fac(n){let r=1;for(let i=2;i<=n;i++)r*=i;return r;}

function _goalIntAt(e,half,curve){
  const t = curve || (half===1?_1H_INTENSITY:_2H_INTENSITY);
  for(const[s,en,m]of t)if(e>=s&&e<en)return m;
  return t[t.length-1][2];
}

function _integrateInt(from,to,half,curve){
  if(to<=from)return 0;
  const steps=Math.max(1,Math.round((to-from)*4));
  const step=(to-from)/steps;
  let total=0;
  for(let i=0;i<steps;i++)total+=_goalIntAt(from+(i+0.5)*step,half,curve)*step;
  return total;
}

function _baseInt2h(curve){
  const c = curve || _2H_INTENSITY;
  return _integrateInt(0,45,2,c)+c[c.length-1][2]*_IT_2H;
}

function _baseInt1h(curve){
  const c = curve || _1H_INTENSITY;
  return _integrateInt(0,45,1,c)+c[c.length-1][2]*_IT_1H;
}

function _solveLam(p,k,lo=0,hi=50,iters=60){
  for(let i=0;i<iters;i++){
    const mid=(lo+hi)/2;
    let prob=0;
    for(let j=0;j<k;j++)prob+=Math.exp(-mid)*Math.pow(mid,j)/_fac(j);
    if(1-prob<p)lo=mid;else hi=mid;
  }
  return(lo+hi)/2;
}

function _poissonAtLeast(lam,k){
  if(lam<=0)return 0;
  if(k<=0)return 1;
  let cum=0;
  for(let i=0;i<Math.min(k,30);i++)cum+=Math.exp(-lam)*Math.pow(lam,i)/_fac(i);
  return Math.max(0,Math.min(1,1-cum));
}

function computeLiveOdd(pHtPct,betKey,matchMinute,favLine=0.75,
                        favGoals2h=0,dogGoals2h=0,favSide='HOME',useFlatDecay=false){
  if(_FT_BETS_SET.has(betKey))
    return{live_p:null,fair_odd:null,note:'Full-time bet — HT reference only'};
  if(!_2H_BETS_SET.has(betKey))
    return{live_p:null,fair_odd:null,note:'—'};

  const curve=useFlatDecay?_FLAT_INTENSITY:_2H_INTENSITY;
  const homeG2h=favSide==='HOME'?favGoals2h:dogGoals2h;
  const awayG2h=favSide==='HOME'?dogGoals2h:favGoals2h;
  const p=Math.max(0.001,Math.min(0.999,pHtPct/100));

  let lam;
  if(_UNDER_BETS[betKey]){
    const[kl]=_UNDER_BETS[betKey];
    const po=Math.max(0.001,Math.min(0.999,1-p));
    lam=kl===1?-Math.log(1-po):_solveLam(po,kl);
  }else{
    const k=_BET_GOAL_THRESHOLD[betKey]||1;
    lam=k===1?-Math.log(1-p):_solveLam(p,k);
  }

  const lineKeys=Object.keys(_LINE_STRENGTH_MOD).map(Number);
  const closest=lineKeys.reduce((a,b)=>Math.abs(b-favLine)<Math.abs(a-favLine)?b:a);
  lam*=_LINE_STRENGTH_MOD[closest];

  const baseInt=_baseInt2h(curve);
  let elapsed2h,remaining2h,note,fg2h=favGoals2h,dg2h=dogGoals2h;
  if(matchMinute<=45){
    elapsed2h=0;remaining2h=45;fg2h=0;dg2h=0;
    note=`1H min ${matchMinute} — full 2H ahead`;
  }else{
    elapsed2h=Math.min(45,matchMinute-45);
    remaining2h=Math.max(0,45-elapsed2h);
    note=`Min ${matchMinute} — ${Math.round(remaining2h)} min left in 2H`;
  }

  // NOTE: previously this short-circuited to a hardcoded live_p:100 whenever
  // remaining2h<=0 ("match over"), which was wrong whenever the bet's
  // condition hadn't actually been met (e.g. Over 1.5 2H, still 0-0, no time
  // left, would have incorrectly shown 100%). Removed — the Poisson math
  // below already resolves this correctly and deterministically via the
  // "already hit"/"already busted" checks and remLam naturally -> ~0 as
  // remaining time -> 0 (injury-time allowance aside).

  const itRate=curve[curve.length-1][2];
  const remInt=_integrateInt(elapsed2h,45,2,curve)+itRate*_IT_2H;
  const intFrac=remInt/baseInt;
  const bayMod=1-(elapsed2h/45)*0.05;
  let remLam=lam*intFrac*bayMod*_pickScoreMod(betKey,fg2h,dg2h,favSide);

  const goalsScored=fg2h+dg2h;
  let liveP;

  if(_UNDER_BETS[betKey]){
    const[,maxG]=_UNDER_BETS[betKey];
    if(goalsScored>maxG)return{live_p:0,fair_odd:99,note:note+' ✗ Already busted',alreadyDecided:true};
    const allowed=maxG-goalsScored;
    let prob=0;
    for(let i=0;i<=allowed;i++)prob+=Math.exp(-remLam)*Math.pow(remLam,i)/_fac(i);
    liveP=prob*100;
  }else{
    let need;
    if(betKey==='homeScored2H')      need=Math.max(0,1-homeG2h);
    else if(betKey==='awayScored2H') need=Math.max(0,1-awayG2h);
    else if(betKey==='homeOver15_2H')need=Math.max(0,2-homeG2h);
    else if(betKey==='awayOver15_2H')need=Math.max(0,2-awayG2h);
    else need=Math.max(0,(_BET_GOAL_THRESHOLD[betKey]||1)-goalsScored);

    if(need===0)return{live_p:100,fair_odd:1.01,note:note+' ✓ Already hit',alreadyDecided:true};
    liveP=_poissonAtLeast(remLam,need)*100;
  }

  return{
    live_p:Math.round(liveP*10)/10,
    fair_odd:Math.round(1/Math.max(liveP/100,0.001)*100)/100,
    note,
  };
}

// 1H mirror of computeLiveOdd. Anchored at kickoff instead of HT — kickoff is
// always 0-0, so unlike the 2H version there's no anchor-goal snapshot to
// subtract; homeG1h/awayG1h are just the match's current score directly.
// Deliberately has NO score-state modifier (_pickScoreMod equivalent): the 2H
// tables are calibrated from HT-margin -> rest-of-2H scoring, a different
// question ("does trailing/leading at the *half break* change the next
// half's pace") than "does the score-so-far *within* the same half change
// the rest of that half" — applying the 2H tables here would misrepresent a
// relationship that was never measured. The goal-distribution model (Poisson
// anchored on the historical rate) and the calibrated _1H_INTENSITY timing
// curve are the two things this shares with the 2H version; the margin
// multiplier is intentionally left at 1.0 pending real 1H-specific data.
function computeLive1HOdd(pKickoffPct,betKey,matchMinute,favLine=0.75,
                          homeGoals1h=0,awayGoals1h=0,useFlatDecay=false){
  if(!_1H_BETS_SET.has(betKey))
    return{live_p:null,fair_odd:null,note:'—'};

  const curve=useFlatDecay?_FLAT_INTENSITY:_1H_INTENSITY;
  const p=Math.max(0.001,Math.min(0.999,pKickoffPct/100));

  let lam;
  if(_UNDER_BETS_1H[betKey]){
    const[kl]=_UNDER_BETS_1H[betKey];
    const po=Math.max(0.001,Math.min(0.999,1-p));
    lam=kl===1?-Math.log(1-po):_solveLam(po,kl);
  }else{
    const k=_BET_GOAL_THRESHOLD_1H[betKey]||1;
    lam=k===1?-Math.log(1-p):_solveLam(p,k);
  }

  const lineKeys=Object.keys(_LINE_STRENGTH_MOD).map(Number);
  const closest=lineKeys.reduce((a,b)=>Math.abs(b-favLine)<Math.abs(a-favLine)?b:a);
  lam*=_LINE_STRENGTH_MOD[closest];

  const baseInt=_baseInt1h(curve);
  const elapsed1h=Math.min(45,Math.max(0,matchMinute));
  const remaining1h=Math.max(0,45-elapsed1h);
  const note=`Min ${matchMinute} — ${Math.round(remaining1h)} min left in 1H`;

  const itRate=curve[curve.length-1][2];
  const remInt=_integrateInt(elapsed1h,45,1,curve)+itRate*_IT_1H;
  const intFrac=remInt/baseInt;
  const bayMod=1-(elapsed1h/45)*0.05;
  let remLam=lam*intFrac*bayMod;

  const goalsScored=homeGoals1h+awayGoals1h;
  let liveP;

  if(_UNDER_BETS_1H[betKey]){
    const[,maxG]=_UNDER_BETS_1H[betKey];
    if(goalsScored>maxG)return{live_p:0,fair_odd:99,note:note+' ✗ Already busted',alreadyDecided:true};
    const allowed=maxG-goalsScored;
    let prob=0;
    for(let i=0;i<=allowed;i++)prob+=Math.exp(-remLam)*Math.pow(remLam,i)/_fac(i);
    liveP=prob*100;
  }else{
    let need;
    if(betKey==='homeScored1H')      need=Math.max(0,1-homeGoals1h);
    else if(betKey==='awayScored1H') need=Math.max(0,1-awayGoals1h);
    else need=Math.max(0,(_BET_GOAL_THRESHOLD_1H[betKey]||1)-goalsScored);

    if(need===0)return{live_p:100,fair_odd:1.01,note:note+' ✓ Already hit',alreadyDecided:true};
    liveP=_poissonAtLeast(remLam,need)*100;
  }

  return{
    live_p:Math.round(liveP*10)/10,
    fair_odd:Math.round(1/Math.max(liveP/100,0.001)*100)/100,
    note,
  };
}

// Bivariate live decay for the 2H "who wins the half" 3-way market
// (favWins2H/draw2H/homeWins2H/awayWins2H — see _2H_RESULT_KEYS above for
// why these can't go through computeLiveOdd's single-threshold path). Models
// each side's remaining-2H goals as independent Poisson processes — rates
// derived the same way computeLiveOdd converts any "at least 1 goal"
// anchor rate to a Poisson lambda, decayed by the same time-remaining
// curve/line-strength/score-state machinery — then enumerates the joint
// outcome space directly (a manual convolution; numerically equivalent to
// a closed-form Skellam PMF for the goal difference, without needing a
// Bessel function) and buckets by final margin: >0 fav win, =0 draw, <0 dog
// win. favAnchorP/dogAnchorP are each side's own HT-conditioned "scores in
// 2H" anchor rate (favScored2H, and whichever of homeScored2H/awayScored2H
// is the underdog).
function computeLiveResult2H(favAnchorP, dogAnchorP, matchMinute, favLine, favGoals2h, dogGoals2h, useFlatDecay) {
  const curve = useFlatDecay ? _FLAT_INTENSITY : _2H_INTENSITY;
  const toLam = p => -Math.log(1 - Math.max(0.001, Math.min(0.999, p / 100)));
  let lamFav = toLam(favAnchorP), lamDog = toLam(dogAnchorP);

  const lineKeys = Object.keys(_LINE_STRENGTH_MOD).map(Number);
  const closest = lineKeys.reduce((a, b) => Math.abs(b - favLine) < Math.abs(a - favLine) ? b : a);
  lamFav *= _LINE_STRENGTH_MOD[closest];

  const baseInt = _baseInt2h(curve);
  let elapsed2h, fg2h = favGoals2h, dg2h = dogGoals2h;
  if (matchMinute <= 45) { elapsed2h = 0; fg2h = 0; dg2h = 0; }
  else { elapsed2h = Math.min(45, matchMinute - 45); }
  const itRate = curve[curve.length - 1][2];
  const remInt = _integrateInt(elapsed2h, 45, 2, curve) + itRate * _IT_2H;
  const intFrac = remInt / baseInt;
  const bayMod = 1 - (elapsed2h / 45) * 0.05;

  const bucket = _marginBucket(fg2h - dg2h);
  const remLamFav = lamFav * intFrac * bayMod * _FAV_SCORE_MOD[bucket];
  const remLamDog = lamDog * intFrac * bayMod * _DOG_SCORE_MOD[bucket];

  const CAP = 10; // 2H goal counts beyond this are negligible at any realistic lambda
  let favWinP = 0, drawP = 0, dogWinP = 0;
  for (let i = 0; i <= CAP; i++) {
    const pi = Math.exp(-remLamFav) * Math.pow(remLamFav, i) / _fac(i);
    for (let j = 0; j <= CAP; j++) {
      const pj = Math.exp(-remLamDog) * Math.pow(remLamDog, j) / _fac(j);
      const p = pi * pj;
      const finalMargin = (fg2h + i) - (dg2h + j);
      if (finalMargin > 0) favWinP += p;
      else if (finalMargin === 0) drawP += p;
      else dogWinP += p;
    }
  }
  const total = favWinP + drawP + dogWinP; // ~1 minus CAP truncation — renormalize
  return total > 0
    ? { fav_win_p: favWinP / total * 100, draw_p: drawP / total * 100, dog_win_p: dogWinP / total * 100 }
    : { fav_win_p: 0, draw_p: 0, dog_win_p: 0 };
}

// BTTS 2H ("both home and away score in the 2nd half") also can't go
// through computeLiveOdd's single-threshold path — it's a joint condition on
// two sides, not a single goal count. Modeled as the product of each side's
// own live "scores in 2H" probability (homeScored2H/awayScored2H, which
// already resolve to 100% the instant that side has scored) — an
// independence assumption, same simplifying spirit as the rest of this
// engine's live-decay math (no joint home/away goal-timing data exists to
// calibrate a true correlation against).
function computeLiveBtts2H(homeAnchorP, awayAnchorP, minute, favLine, favG2h, dogG2h, favSide, useFlatDecay) {
  const homeRes = computeLiveOdd(homeAnchorP, 'homeScored2H', minute, favLine, favG2h, dogG2h, favSide, useFlatDecay);
  const awayRes = computeLiveOdd(awayAnchorP, 'awayScored2H', minute, favLine, favG2h, dogG2h, favSide, useFlatDecay);
  if (homeRes.live_p == null || awayRes.live_p == null) return null;
  return Math.round(homeRes.live_p * awayRes.live_p) / 100;
}

// Which computeLiveResult2H output field each of the 4 "2H Result" keys
// reads, given which side is the favourite.
function _2hResultField(betKey, favSide) {
  if (betKey === 'draw2H') return 'draw_p';
  if (betKey === 'favWins2H') return 'fav_win_p';
  const isHomeKey = betKey === 'homeWins2H';
  const homeIsFav = favSide === 'HOME';
  return (isHomeKey === homeIsFav) ? 'fav_win_p' : 'dog_win_p';
}

// Wraps computeLiveOdd's (or, for the 2H Result 3-way market,
// computeLiveResult2H's) output back into a scoreBets()-shaped bet object so
// it drops straight into the existing buildBetCol/renderOddsKellyWidget/
// calcKellyStake pipeline unchanged. anchorBet must be the HT-conditioned
// (minute-agnostic) historical bet — never the coarse INPLAY_2H-bucket one,
// to avoid double-counting "goals scored since HT" in both the historical
// pool match AND the Poisson time-decay. htBetsMap: Map of k -> HT-
// conditioned bet from the same scoreBets() pass, needed only for the 2H
// Result keys (to read the underdog's own "scores in 2H" anchor rate).
//
// Sentinel distinct from `null` — `null` means "no live-decay function
// exists for this bet key, fall back to the plain anchor bet"; this means
// "the condition is already fully decided (already happened, or already
// impossible), so there is no live bet left to place at all — drop it from
// the list entirely rather than show a bookmaker-can't-offer-this 100%/0%".
// e.g. "Over 0.5 in 2H" once a goal has already gone in this half.
const _ALREADY_DECIDED = Symbol('bet-already-decided');

function buildLiveAdjustedBet(anchorBet, minute, favG2h, dogG2h, favSide, favLine, useFlatDecay, htBetsMap) {
  const favLineNum = parseFloat(favLine) || 0.75;

  if (_2H_RESULT_KEYS.has(anchorBet.k)) {
    if (!htBetsMap) return null;
    const favAnchor = htBetsMap.get('favScored2H');
    const dogAnchor = htBetsMap.get(favSide === 'HOME' ? 'awayScored2H' : 'homeScored2H');
    if (!favAnchor || !dogAnchor) return null;
    const field = _2hResultField(anchorBet.k, favSide);
    const point = computeLiveResult2H(favAnchor.p,  dogAnchor.p,  minute, favLineNum, favG2h, dogG2h, useFlatDecay);
    const loRes = computeLiveResult2H(favAnchor.lo, dogAnchor.lo, minute, favLineNum, favG2h, dogG2h, useFlatDecay);
    const p  = point[field];
    const lo = Math.min(p, loRes[field]);
    return {
      ...anchorBet,
      p, lo,
      edge: p - anchorBet.bl,
      mo: minOdds(p),
      mo_mid: minOdds((p + lo) / 2),
      matches: [],
      _liveDecayed: true,
      _liveLabel: `LIVE @ ${minute}'`,
    };
  }

  if (anchorBet.k === 'btts2H') {
    if (!htBetsMap) return null;
    const homeAnchor = htBetsMap.get('homeScored2H');
    const awayAnchor = htBetsMap.get('awayScored2H');
    if (!homeAnchor || !awayAnchor) return null;
    const p  = computeLiveBtts2H(homeAnchor.p,  awayAnchor.p,  minute, favLineNum, favG2h, dogG2h, favSide, useFlatDecay);
    const loRaw = computeLiveBtts2H(homeAnchor.lo, awayAnchor.lo, minute, favLineNum, favG2h, dogG2h, favSide, useFlatDecay);
    if (p == null) return null;
    if (p >= 100) return _ALREADY_DECIDED; // both sides have already scored
    const lo = Math.min(p, loRaw != null ? loRaw : p);
    return {
      ...anchorBet,
      p, lo,
      edge: p - anchorBet.bl,
      mo: minOdds(p),
      mo_mid: minOdds((p + lo) / 2),
      matches: [],
      _liveDecayed: true,
      _liveLabel: `LIVE @ ${minute}'`,
    };
  }

  if (!_BET_SCORE_MOD_CLASS.hasOwnProperty(anchorBet.k)) return null;

  const pointRes = computeLiveOdd(anchorBet.p,  anchorBet.k, minute, favLineNum, favG2h, dogG2h, favSide, useFlatDecay);
  if (pointRes.live_p == null) return null;
  if (pointRes.alreadyDecided) return _ALREADY_DECIDED;
  const loRes = computeLiveOdd(anchorBet.lo, anchorBet.k, minute, favLineNum, favG2h, dogG2h, favSide, useFlatDecay);

  const p  = pointRes.live_p;
  const lo = Math.min(p, loRes.live_p != null ? loRes.live_p : p);

  return {
    ...anchorBet,
    p, lo,
    edge: p - anchorBet.bl,
    mo: minOdds(p),
    mo_mid: minOdds((p + lo) / 2),
    matches: [], // historical match list belongs to the (undecayed) anchor rate — drop it rather than show stale detail
    _liveDecayed: true,
    _liveLabel: `LIVE @ ${minute}'`,
  };
}

// 1H mirror of computeLiveResult2H — bivariate live decay for the 1H "who
// wins the half" 3-way market (favWins1H/draw1H/homeWins1H/awayWins1H).
// Anchored at kickoff: favGoals1h/dogGoals1h are the current score directly
// (no HT-style anchor subtraction), and there is no score-state margin
// modifier (see computeLive1HOdd's comment for why).
function computeLiveResult1H(favAnchorP, dogAnchorP, matchMinute, favLine, favGoals1h, dogGoals1h, useFlatDecay) {
  const curve = useFlatDecay ? _FLAT_INTENSITY : _1H_INTENSITY;
  const toLam = p => -Math.log(1 - Math.max(0.001, Math.min(0.999, p / 100)));
  let lamFav = toLam(favAnchorP), lamDog = toLam(dogAnchorP);

  const lineKeys = Object.keys(_LINE_STRENGTH_MOD).map(Number);
  const closest = lineKeys.reduce((a, b) => Math.abs(b - favLine) < Math.abs(a - favLine) ? b : a);
  lamFav *= _LINE_STRENGTH_MOD[closest];

  const baseInt = _baseInt1h(curve);
  const elapsed1h = Math.min(45, Math.max(0, matchMinute));
  const itRate = curve[curve.length - 1][2];
  const remInt = _integrateInt(elapsed1h, 45, 1, curve) + itRate * _IT_1H;
  const intFrac = remInt / baseInt;
  const bayMod = 1 - (elapsed1h / 45) * 0.05;

  const remLamFav = lamFav * intFrac * bayMod;
  const remLamDog = lamDog * intFrac * bayMod;

  const CAP = 10;
  let favWinP = 0, drawP = 0, dogWinP = 0;
  for (let i = 0; i <= CAP; i++) {
    const pi = Math.exp(-remLamFav) * Math.pow(remLamFav, i) / _fac(i);
    for (let j = 0; j <= CAP; j++) {
      const pj = Math.exp(-remLamDog) * Math.pow(remLamDog, j) / _fac(j);
      const p = pi * pj;
      const finalMargin = (favGoals1h + i) - (dogGoals1h + j);
      if (finalMargin > 0) favWinP += p;
      else if (finalMargin === 0) drawP += p;
      else dogWinP += p;
    }
  }
  const total = favWinP + drawP + dogWinP;
  return total > 0
    ? { fav_win_p: favWinP / total * 100, draw_p: drawP / total * 100, dog_win_p: dogWinP / total * 100 }
    : { fav_win_p: 0, draw_p: 0, dog_win_p: 0 };
}

// 1H mirror of computeLiveBtts2H — product of each side's own live "scores
// in 1H" probability.
function computeLiveBtts1H(homeAnchorP, awayAnchorP, minute, favLine, homeG1h, awayG1h, useFlatDecay) {
  const homeRes = computeLive1HOdd(homeAnchorP, 'homeScored1H', minute, favLine, homeG1h, awayG1h, useFlatDecay);
  const awayRes = computeLive1HOdd(awayAnchorP, 'awayScored1H', minute, favLine, homeG1h, awayG1h, useFlatDecay);
  if (homeRes.live_p == null || awayRes.live_p == null) return null;
  return Math.round(homeRes.live_p * awayRes.live_p) / 100;
}

// Which computeLiveResult1H output field each of the 4 "1H Result" keys reads.
function _1hResultField(betKey, favSide) {
  if (betKey === 'draw1H') return 'draw_p';
  if (betKey === 'favWins1H') return 'fav_win_p';
  const isHomeKey = betKey === 'homeWins1H';
  const homeIsFav = favSide === 'HOME';
  return (isHomeKey === homeIsFav) ? 'fav_win_p' : 'dog_win_p';
}

// 1H mirror of buildLiveAdjustedBet. anchorBet must be the pre-match
// (closing-odds) historical bet — the same preBets scoreBets() pass Live
// Games already computes, since there's no HT-style conditioning step for
// 1H. anchorBetsMap: Map of k -> that same pre-match bet, needed for the 1H
// Result keys (favScored1H) and btts1H (homeScored1H/awayScored1H), neither
// of which is itself in Live Games' displayed 1H set.
function buildLive1HAdjustedBet(anchorBet, minute, homeG1h, awayG1h, favSide, favLine, useFlatDecay, anchorBetsMap) {
  const favLineNum = parseFloat(favLine) || 0.75;
  const favG1h = favSide === 'HOME' ? homeG1h : awayG1h;
  const dogG1h = favSide === 'HOME' ? awayG1h : homeG1h;

  if (_1H_RESULT_KEYS.has(anchorBet.k)) {
    if (!anchorBetsMap) return null;
    const favAnchor = anchorBetsMap.get('favScored1H');
    const dogAnchor = anchorBetsMap.get(favSide === 'HOME' ? 'awayScored1H' : 'homeScored1H');
    if (!favAnchor || !dogAnchor) return null;
    const field = _1hResultField(anchorBet.k, favSide);
    const point = computeLiveResult1H(favAnchor.p,  dogAnchor.p,  minute, favLineNum, favG1h, dogG1h, useFlatDecay);
    const loRes = computeLiveResult1H(favAnchor.lo, dogAnchor.lo, minute, favLineNum, favG1h, dogG1h, useFlatDecay);
    const p  = point[field];
    const lo = Math.min(p, loRes[field]);
    return {
      ...anchorBet,
      p, lo,
      edge: p - anchorBet.bl,
      mo: minOdds(p),
      mo_mid: minOdds((p + lo) / 2),
      matches: [],
      _liveDecayed: true,
      _liveLabel: `LIVE @ ${minute}'`,
    };
  }

  if (anchorBet.k === 'btts1H') {
    if (!anchorBetsMap) return null;
    const homeAnchor = anchorBetsMap.get('homeScored1H');
    const awayAnchor = anchorBetsMap.get('awayScored1H');
    if (!homeAnchor || !awayAnchor) return null;
    const p  = computeLiveBtts1H(homeAnchor.p,  awayAnchor.p,  minute, favLineNum, homeG1h, awayG1h, useFlatDecay);
    const loRaw = computeLiveBtts1H(homeAnchor.lo, awayAnchor.lo, minute, favLineNum, homeG1h, awayG1h, useFlatDecay);
    if (p == null) return null;
    if (p >= 100) return _ALREADY_DECIDED; // both sides have already scored
    const lo = Math.min(p, loRaw != null ? loRaw : p);
    return {
      ...anchorBet,
      p, lo,
      edge: p - anchorBet.bl,
      mo: minOdds(p),
      mo_mid: minOdds((p + lo) / 2),
      matches: [],
      _liveDecayed: true,
      _liveLabel: `LIVE @ ${minute}'`,
    };
  }

  if (!_1H_BETS_SET.has(anchorBet.k)) return null;

  const pointRes = computeLive1HOdd(anchorBet.p,  anchorBet.k, minute, favLineNum, homeG1h, awayG1h, useFlatDecay);
  if (pointRes.live_p == null) return null;
  if (pointRes.alreadyDecided) return _ALREADY_DECIDED;
  const loRes = computeLive1HOdd(anchorBet.lo, anchorBet.k, minute, favLineNum, homeG1h, awayG1h, useFlatDecay);

  const p  = pointRes.live_p;
  const lo = Math.min(p, loRes.live_p != null ? loRes.live_p : p);

  return {
    ...anchorBet,
    p, lo,
    edge: p - anchorBet.bl,
    mo: minOdds(p),
    mo_mid: minOdds((p + lo) / 2),
    matches: [],
    _liveDecayed: true,
    _liveLabel: `LIVE @ ${minute}'`,
  };
}

/* ════════════════════════════════════════════════════════════
   APP STATE & DB
   ════════════════════════════════════════════════════════════ */
let _db       = [];
let _fileInfo = [];

// Maps a rendered odds-widget id -> the bet object it was rendered for, so
// onOddsInput() can look it up without recomputing scoreBets(). Cleared and
// repopulated at the top of every renderMatchResults() call.
let _lastBetsByWidget = new Map();

const state = {
  leagueTier: 'MAJOR',
  bankroll: null,       // session-only, plain number, no persistence
  recencyMonths: null,  // null = all time, else 3|6|12
  selectedLeague: '',   // for the league-coverage sample-relevance stat
  lastImportedUrl: null, // last successfully imported match link, for Refresh
  useFlatDecay: false,   // live 2H odds: shaped (literature-sourced) vs flat time-decay
  liveTierFilter: 'MAJOR', // which live matches are shown, by their OWN league tier (Live Games only)
  dashboardTierFilter: 'MAJOR', // which fixtures are shown, by their OWN league tier (Dashboard only)
};

// Bundled CSVs use ISO "YYYY-MM-DD" dates (confirmed across all 15 files in
// static/data/) — Date() parses that natively. Never throws; returns null
// for anything else so unparseable rows can be kept rather than dropped.
function parseRowDate(dateStr) {
  if (!dateStr) return null;
  const d = new Date(dateStr);
  return isNaN(d.getTime()) ? null : d;
}

function getDb() {
  let rows = _db;
  if (state.leagueTier === 'TOP')   rows = rows.filter(r => r.league_tier === 'TOP');
  else if (state.leagueTier === 'MAJOR') rows = rows.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');

  if (state.recencyMonths != null) {
    const cutoff = new Date();
    cutoff.setMonth(cutoff.getMonth() - state.recencyMonths);
    // Rows with an unparseable date are kept, not dropped — a format
    // mismatch should never silently shrink the pool to near-empty.
    rows = rows.filter(r => {
      const d = parseRowDate(r.date);
      return !d || d >= cutoff;
    });
  }

  return rows;
}

/* ════════════════════════════════════════════════════════════
   INIT
   ════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  setupUpload();
  updateDbUI({ total: 0, files: [] });
  autoLoadData();
});

/* ════════════════════════════════════════════════════════════
   AUTO-LOAD BUNDLED DATASET  (static/data/manifest.json)
   ════════════════════════════════════════════════════════════ */
async function autoLoadData() {
  let resp;
  try { resp = await fetch('./data/manifest.json'); } catch { return; }
  if (!resp.ok) return;

  let manifest;
  try { manifest = await resp.json(); } catch { return; }
  const files = manifest.files;
  if (!files || !files.length) return;

  const status = document.getElementById('db-status');
  status.textContent = `Loading dataset (${files.length} file${files.length !== 1 ? 's' : ''})…`;
  status.className = 'db-status';

  await Promise.all(files.map(async (filename) => {
    try {
      const r = await fetch(`./data/${filename}`);
      if (!r.ok) return;
      const text = await r.text();
      const label = filename.replace(/\.csv$/i, '');
      const result = Papa.parse(text, { header: true, skipEmptyLines: true });
      let loaded = 0;
      for (const row of result.data) {
        const rec = processRow(row, label);
        if (rec) { _db.push(rec); loaded++; }
      }
      if (loaded > 0) _fileInfo.push({ name: filename, loaded });
    } catch { /* skip unreadable file */ }
  }));

  updateDbUI({ total: _db.length, files: _fileInfo });
}

/* ════════════════════════════════════════════════════════════
   FILE UPLOAD (client-side via PapaParse)
   ════════════════════════════════════════════════════════════ */
function setupUpload() {
  const area  = document.getElementById('upload-area');
  const input = document.getElementById('file-input');

  area.addEventListener('click', () => input.click());
  area.addEventListener('dragover',  e => { e.preventDefault(); area.classList.add('dragover'); });
  area.addEventListener('dragleave', () => area.classList.remove('dragover'));
  area.addEventListener('drop', e => {
    e.preventDefault(); area.classList.remove('dragover');
    processFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', () => { processFiles(input.files); input.value = ''; });
}

function processFiles(files) {
  let pending = files.length;
  if (!pending) return;
  for (const file of files) {
    const label = file.name.replace(/\.csv$/i, '');
    Papa.parse(file, {
      header:          true,
      skipEmptyLines:  true,
      complete: (result) => {
        let loaded = 0;
        for (const row of result.data) {
          const rec = processRow(row, label);
          if (rec) { _db.push(rec); loaded++; }
        }
        if (loaded > 0) _fileInfo.push({ name: file.name, loaded });
        else alert(`No valid records found in "${file.name}". Check CSV format.`);
        pending--;
        if (pending === 0) updateDbUI({ total: _db.length, files: _fileInfo });
      },
      error: (err) => {
        alert(`Parse error in "${file.name}": ${err.message}`);
        pending--;
        if (pending === 0) updateDbUI({ total: _db.length, files: _fileInfo });
      },
    });
  }
}

function clearDb() {
  if (!confirm('Clear all loaded data?')) return;
  _db = []; _fileInfo = [];
  updateDbUI({ total: 0, files: [] });
}

function setLeagueTier(tier) {
  state.leagueTier = tier;
  ['ALL','MAJOR','TOP'].forEach(t => {
    document.getElementById(`tier-btn-${t}`)?.classList.toggle('active', t === tier);
  });
  renderLeagueCoverage();
}

/* ════════════════════════════════════════════════════════════
   RECENCY FILTER
   ════════════════════════════════════════════════════════════ */
function setRecency(months) {
  state.recencyMonths = months;
  ['ALL', 3, 6, 12].forEach(m => {
    document.getElementById(`recency-btn-${m === 'ALL' ? 'ALL' : m}`)
      ?.classList.toggle('active', m === (months ?? 'ALL'));
  });

  const note = document.getElementById('recency-note');
  if (note) {
    if (months == null) {
      note.textContent = '';
    } else {
      const total = getDb().length;
      note.textContent = `${total.toLocaleString()} rows in the last ${months} month${months !== 1 ? 's' : ''}`;
    }
  }
  renderLeagueCoverage();
}

/* ════════════════════════════════════════════════════════════
   LEAGUE COVERAGE (sample-relevance check)
   ════════════════════════════════════════════════════════════ */
function populateLeagueOptions() {
  const sel = document.getElementById('match-league');
  if (!sel) return;
  const leagues = [...new Set(_db.map(r => r.league).filter(Boolean))].sort();
  const current = sel.value;
  sel.innerHTML = '<option value="">— not set —</option>' +
    leagues.map(l => `<option value="${l.replace(/"/g, '&quot;')}">${l}</option>`).join('');
  if (leagues.includes(current)) sel.value = current;
}

function onLeagueSelectChange() {
  state.selectedLeague = document.getElementById('match-league')?.value || '';
  renderLeagueCoverage();
}

function getLeagueCoverage(leagueName) {
  return getDb().filter(r => r.league === leagueName).length;
}

function renderLeagueCoverage() {
  const el = document.getElementById('league-coverage');
  if (!el) return;
  if (!state.selectedLeague) { el.textContent = ''; return; }
  const total = getDb().length;
  const n = getLeagueCoverage(state.selectedLeague);
  const pct = total > 0 ? (n / total * 100) : 0;
  el.textContent = `${n.toLocaleString()} of ${total.toLocaleString()} rows in the current pool are from ${state.selectedLeague} (${pct.toFixed(1)}%)`;
}

function updateDbUI(data) {
  const status = document.getElementById('db-status');
  const breakdown = document.getElementById('tier-breakdown');

  if (data.total === 0) {
    status.textContent = 'No database loaded';
    status.className   = 'db-status';
    if (breakdown) breakdown.textContent = '';
  } else {
    status.textContent = `✓  ${data.total.toLocaleString()} records  ·  ${data.files.length} file${data.files.length !== 1 ? 's' : ''}`;
    status.className   = 'db-status loaded';
    // Auto-collapse the upload area once DB is loaded
    const expandArea = document.getElementById('db-expand-area');
    const expandBtn  = document.getElementById('db-expand-btn');
    if (expandArea) expandArea.style.display = 'none';
    if (expandBtn)  expandBtn.textContent = '▶';
    if (breakdown) {
      const nTop   = _db.filter(r => r.league_tier === 'TOP').length;
      const nMajor = _db.filter(r => r.league_tier === 'MAJOR').length;
      const nOther = data.total - nTop - nMajor;
      breakdown.textContent = `TOP 5+UCL: ${nTop.toLocaleString()}  ·  MAJOR: ${nMajor.toLocaleString()}  ·  Other: ${nOther.toLocaleString()}`;
    }
    populateLeagueOptions();
    renderLeagueCoverage();
  }
}

function toggleDbExpand() {
  const area = document.getElementById('db-expand-area');
  const btn  = document.getElementById('db-expand-btn');
  if (!area) return;
  const open = area.style.display !== 'none';
  area.style.display = open ? 'none' : '';
  btn.textContent    = open ? '▶' : '▼';
}

/* ════════════════════════════════════════════════════════════
   INPUT MIRRORING & SIGNAL PREVIEW
   ════════════════════════════════════════════════════════════ */
function onInputChange() {
  mirrorMarket();
  updateSignalPreview();
}

function mirrorMarket() {
  const hc = parseFloat(document.getElementById('ah_hc').value);
  const ho = parseFloat(document.getElementById('ah_ho').value);
  const acEl = document.getElementById('ah_ac');
  const aoEl = document.getElementById('ah_ao');

  if (!isNaN(hc)) acEl.value = (Math.abs(hc) < 0.001 ? 0 : -hc).toFixed(2);
  else acEl.value = '';
  if (!isNaN(ho)) aoEl.value = (Math.abs(ho) < 0.001 ? 0 : -ho).toFixed(2);
  else aoEl.value = '';
}

// Map engine signal (IN/OUT/STABLE/UNKNOWN) to display label for odds direction
function engineToUiLabel(sig) {
  if (sig === 'IN')  return 'STEAM';
  if (sig === 'OUT') return 'DRIFT';
  return sig;
}

function setSigVal(id, text, colorClass) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = 'sdrow-val ' + colorClass;
}

function updateSignalPreview() {
  const hc  = parseFloat(document.getElementById('ah_hc').value);
  const ho  = parseFloat(document.getElementById('ah_ho').value);
  const hoc = parseFloat(document.getElementById('ho_c').value);
  const hoo = parseFloat(document.getElementById('ho_o').value);
  const aoc = parseFloat(document.getElementById('ao_c').value);
  const aoo = parseFloat(document.getElementById('ao_o').value);
  const tlc = parseFloat(document.getElementById('tl_c').value);
  const tlo = parseFloat(document.getElementById('tl_o').value);
  const ovc = parseFloat(document.getElementById('ov_c').value);
  const ovo = parseFloat(document.getElementById('ov_o').value);
  const unc = parseFloat(document.getElementById('un_c').value);
  const uno = parseFloat(document.getElementById('un_o').value);

  // Line move
  let lineMove = 'UNKNOWN';
  if (!isNaN(hc) && !isNaN(ho)) {
    const favLc = Math.abs(hc);
    const favLo = Math.abs(ho);
    const diff = favLc - favLo;
    lineMove = diff > LINE_THRESH ? 'DEEPER' : diff < -LINE_THRESH ? 'SHRANK' : 'STABLE';
  }
  setSigVal('sig-lm', lineMove, lineMove);

  // AH direction label
  const dirEl = document.getElementById('ah-dir-label');
  if (dirEl) {
    if (!isNaN(hc) && hc < -0.01) {
      dirEl.textContent = 'HOME gives ' + Math.abs(hc).toFixed(2);
      dirEl.style.color = 'var(--green)';
    } else if (!isNaN(hc) && hc > 0.01) {
      dirEl.textContent = 'AWAY gives ' + hc.toFixed(2);
      dirEl.style.color = 'var(--yellow)';
    } else if (!isNaN(hc)) {
      dirEl.textContent = 'Level ball (0.00)';
      dirEl.style.color = 'var(--dim)';
    } else {
      dirEl.textContent = 'e.g. −0.75 = Home gives';
      dirEl.style.color = 'var(--dim)';
    }
  }

  // Favourite/dog odds movement (mapped from home/away)
  const favSide = !isNaN(hc) && hc < -0.01 ? 'HOME'
                : !isNaN(hc) && hc > 0.01  ? 'AWAY'
                : (!isNaN(hoc) && !isNaN(aoc) && hoc <= aoc) ? 'HOME' : 'AWAY';
  const homMove = oddsDir(isNaN(hoc) ? null : hoc, isNaN(hoo) ? null : hoo);
  const aomMove = oddsDir(isNaN(aoc) ? null : aoc, isNaN(aoo) ? null : aoo);
  const favMove = favSide === 'HOME' ? homMove : aomMove;
  const dogMove = favSide === 'HOME' ? aomMove : homMove;
  setSigVal('sig-hom', engineToUiLabel(favMove), favMove);
  setSigVal('sig-aom', engineToUiLabel(dogMove), dogMove);

  // TL movement
  const tlMove = moveDir(isNaN(tlc) ? null : tlc, isNaN(tlo) ? null : tlo, TL_THRESH);
  setSigVal('sig-tlm', tlMove, tlMove);

  // Over/under odds movement
  const ovMove = oddsDir(isNaN(ovc) ? null : ovc, isNaN(ovo) ? null : ovo);
  setSigVal('sig-ovm', engineToUiLabel(ovMove), ovMove);
  const unMove = oddsDir(isNaN(unc) ? null : unc, isNaN(uno) ? null : uno);
  setSigVal('sig-unm', engineToUiLabel(unMove), unMove);
}

/* ════════════════════════════════════════════════════════════
   URL IMPORT  (asianbetsoccer.com → auto-fill inputs)
   ════════════════════════════════════════════════════════════ */
async function importFromUrl() {
  const input = document.getElementById('url-import-input');
  const url = (input.value || '').trim();
  if (!url) return;
  await doImport(url, 'Import');
}

// Shared fetch+fill logic for both the manual Import button and the
// Refresh button. Never touches the game-state fields (HT score, minute,
// current score) — only fillFromScraped's market inputs.
async function doImport(url, btnIdleLabel) {
  const btn    = document.getElementById('url-import-btn');
  const status = document.getElementById('url-import-status');

  btn.disabled    = true;
  btn.textContent = '…';
  status.textContent = 'Fetching…';
  status.className   = 'url-import-status loading';

  let ok = false;
  try {
    const resp = await fetch('/api/scrape?url=' + encodeURIComponent(url));
    const data = await resp.json();

    if (data.error) {
      status.textContent = '✗ ' + data.error;
      status.className   = 'url-import-status error';
    } else {
      fillFromScraped(data);
      const sourceLabel = data.source === 'pinnacle' ? 'Pinnacle' : 'Bet365';
      status.textContent = `✓ Imported (${sourceLabel}) — check fields and analyze`;
      status.className   = 'url-import-status ok';
      state.lastImportedUrl = url;
      const refreshBtn = document.getElementById('url-refresh-btn');
      if (refreshBtn) refreshBtn.style.display = '';
      ok = true;
    }
  } catch (e) {
    status.textContent = '✗ ' + e.message;
    status.className   = 'url-import-status error';
  } finally {
    btn.disabled    = false;
    btn.textContent = btnIdleLabel;
  }
  return ok;
}

// One-click re-check for an already-imported live match: re-fetches the
// same URL and re-runs the analysis, without touching the manually-typed
// HT score / minute / current score fields.
async function refreshMatch() {
  if (!state.lastImportedUrl) return;
  const ok = await doImport(state.lastImportedUrl, 'Import');
  if (ok && _db.length) analyzeMatch();
}

function fillFromScraped(data) {
  const set = (id, v) => {
    if (v == null) return;
    const el = document.getElementById(id);
    if (el && !el.readOnly) el.value = Number.isFinite(v) ? v.toFixed(2) : String(v);
  };

  set('ah_hc', data.ah_hc);
  set('ah_ho', data.ah_ho);
  set('ho_c',  data.ho_c);
  set('ho_o',  data.ho_o);
  set('ao_c',  data.ao_c);
  set('ao_o',  data.ao_o);
  set('tl_c',  data.tl_c);
  set('tl_o',  data.tl_o);
  set('ov_c',  data.ov_c);
  set('ov_o',  data.ov_o);
  set('un_c',  data.un_c);
  set('un_o',  data.un_o);

  // The primary market fields above are Bet365 odds (matches the bundled
  // historical dataset, static/data/Bet365/*.csv) whenever Bet365 is listed
  // on the match page, falling back to Pinnacle only if it isn't. Whichever
  // one *wasn't* used for the main fields is shown as a reference-only strip.
  if (data.source === 'pinnacle' && data.bet365) {
    renderOddsRef(data.bet365, 'BET365 (reference)');
  } else if (data.source === 'bet365' && data.pinnacle) {
    renderOddsRef(data.pinnacle, 'PINNACLE (reference)');
  } else {
    renderOddsRef(null);
  }

  onInputChange();
}

// Secondary-bookmaker reference odds — display only, never fed into the
// analysis engine. Useful to see what another book is pricing the same
// match at, or what you'd get at execution time if it differs from the
// dataset-matching bookmaker used for the main fields.
function renderOddsRef(ref, label) {
  const el = document.getElementById('bet365-ref');
  if (!el) return;
  if (!ref) { el.style.display = 'none'; el.innerHTML = ''; return; }

  const f = v => v != null ? v.toFixed(2) : '—';
  el.style.display = '';
  el.innerHTML = `
    <span class="bet365-ref-label">${label}</span>
    <span>AH ${f(ref.ah_hc)}</span>
    <span>Home ${f(ref.ho_c)}</span>
    <span>Away ${f(ref.ao_c)}</span>
    <span>TL ${f(ref.tl_c)}</span>
    <span>O ${f(ref.ov_c)}</span>
    <span>U ${f(ref.un_c)}</span>
  `;
}

/* ════════════════════════════════════════════════════════════
   MIN N
   ════════════════════════════════════════════════════════════ */
function setMinN(v) {
  const el = document.getElementById('min-n');
  if (el) el.value = v;
}

function getMinN() {
  const v = parseInt(document.getElementById('min-n')?.value, 10);
  return isNaN(v) || v < 1 ? 15 : v;
}

/* ════════════════════════════════════════════════════════════
   LIVE-ODDS EV / KELLY STAKING WIDGET
   ════════════════════════════════════════════════════════════ */
function setBankroll(v) {
  const n = parseFloat(v);
  state.bankroll = isFinite(n) && n > 0 ? n : null;
}

function setUseFlatDecay(checked) {
  state.useFlatDecay = !!checked;
  if (_db.length && document.getElementById('right-manual')?.querySelector('.results-title')) {
    analyzeMatch();
  }
}

// Reusable "YOUR ODDS" input + edge%/Kelly% readout, appended after a bet
// column's existing min-odds block. widgetId must be unique per rendered
// instance (e.g. `${rank}-${colId}`, or 'top' for the Top Pick banner).
function renderOddsKellyWidget(widgetId) {
  return `<div class="col-your-odds">
    <span class="col-min-odds-label">YOUR ODDS</span>
    <input type="text" class="your-odds-input" placeholder="e.g. 1.95"
           oninput="onOddsInput('${widgetId}', this.value)">
    <span class="odds-edge" id="odds-edge-${widgetId}">—</span>
    <span class="odds-kelly" id="odds-kelly-${widgetId}">—</span>
  </div>`;
}

function onOddsInput(widgetId, rawValue) {
  const bet     = _lastBetsByWidget.get(widgetId);
  const edgeEl  = document.getElementById(`odds-edge-${widgetId}`);
  const kellyEl = document.getElementById(`odds-kelly-${widgetId}`);
  if (!edgeEl || !kellyEl) return;

  const offered = parseFloat(rawValue);
  if (!bet || !isFinite(offered)) {
    edgeEl.textContent = '—';
    kellyEl.textContent = '—';
    kellyEl.className = 'odds-kelly';
    return;
  }

  const r = calcKellyStake(bet, offered, state.bankroll);

  if (r.status === 'INVALID') {
    edgeEl.textContent = '—';
    kellyEl.textContent = '—';
    kellyEl.className = 'odds-kelly';
    return;
  }

  edgeEl.textContent = (r.edgePct >= 0 ? '+' : '') + r.edgePct.toFixed(1) + '% edge';
  edgeEl.className = 'odds-edge ' + (r.edgePct >= 0 ? 'pos' : 'neg');

  if (r.status === 'NO_VALUE') {
    kellyEl.textContent = 'NO VALUE';
    kellyEl.className = 'odds-kelly kelly-none';
    return;
  }

  const stakeTxt = r.stakeAmount != null ? ` (${r.stakeAmount.toFixed(2)})` : '';
  kellyEl.textContent = `Kelly ${r.kellyPct.toFixed(1)}%${stakeTxt}`;
  kellyEl.className = 'odds-kelly ' + (r.status === 'ABOVE_MIN' ? 'kelly-strong' : 'kelly-grey');
}

/* ════════════════════════════════════════════════════════════
   GAME STATE (simplified — HT score, optional live 2H score)
   ════════════════════════════════════════════════════════════ */
function readGameState() {
  const v = id => { const t = (document.getElementById(id)?.value || '').trim(); return t === '' ? null : t; };
  const htH = v('gs_ht_home'), htA = v('gs_ht_away');
  if (htH == null || htA == null) return null;

  const minuteRaw = v('gs_minute');
  const minuteParsed = minuteRaw != null ? parseInt(minuteRaw, 10) : null;
  const minute = (minuteParsed != null && !isNaN(minuteParsed)) ? minuteParsed : null;
  const curH = v('gs_cur_home'), curA = v('gs_cur_away');

  // HT score (home_goals/away_goals), minute, and (when a current score is
  // typed) goals-scored-in-2H-so-far are always included, regardless of
  // trigger, so analyzeMatch() can derive the HT-conditioned anchor + live
  // time-decay inputs independent of which bucket trigger below ends up
  // being the "displayed" fallback for non-2H-eligible bets.
  const base = { home_goals: htH, away_goals: htA, minute };
  if (curH != null && curA != null) {
    base.cur_home_2h = Math.max(0, parseInt(curH, 10) - parseInt(htH, 10));
    base.cur_away_2h = Math.max(0, parseInt(curA, 10) - parseInt(htA, 10));
  }

  if (minute != null && minute > 56 && curH != null && curA != null) {
    const home2h = Math.max(0, parseInt(curH, 10) - parseInt(htH, 10));
    const away2h = Math.max(0, parseInt(curA, 10) - parseInt(htA, 10));
    return {
      ...base,
      trigger: 'INPLAY_2H',
      home_2h: String(home2h),
      away_2h: String(away2h),
      label: `2H in-play ${home2h}-${away2h} (HT ${htH}-${htA})`,
    };
  }

  return {
    ...base,
    trigger: 'HT',
    label: `HT ${htH}-${htA}`,
  };
}

/* ════════════════════════════════════════════════════════════
   BUILD CONFIG FROM MARKET INPUTS
   Signals auto-detected — Tier 1 (line move, TL move) always on;
   Tier 2 (fav/dog odds move, over/under odds move) auto-activates
   only when the corresponding Tier 1 signal is STABLE, matching the
   Pinnacle signal-strength guide (sharper signal takes priority).
   ════════════════════════════════════════════════════════════ */
function buildRawCfg(tier2) {
  const hcRaw = document.getElementById('ah_hc').value;
  const hoRaw = document.getElementById('ah_ho').value;
  const hc    = sf(hcRaw);
  if (hc === null) return null;

  const favLc   = Math.abs(hc);
  const favLine = VALID_LINES.find(v => Math.abs(favLc - v) < 0.13);
  if (favLine === undefined) return null;

  const hoc = sf(document.getElementById('ho_c').value);
  const hoo = sf(document.getElementById('ho_o').value);
  const aoc = sf(document.getElementById('ao_c').value);
  const aoo = sf(document.getElementById('ao_o').value);

  let favSide;
  if      (hc < -0.01)                   favSide = 'HOME';
  else if (hc >  0.01)                   favSide = 'AWAY';
  else if (hoc !== null && aoc !== null) favSide = hoc <= aoc ? 'HOME' : 'AWAY';
  else                                   favSide = 'HOME';
  const favOc = favSide === 'HOME' ? hoc : aoc;
  const favOo = favSide === 'HOME' ? hoo : aoo;
  const dogOc = favSide === 'HOME' ? aoc : hoc;
  const dogOo = favSide === 'HOME' ? aoo : hoo;

  const ho    = sf(hoRaw);
  const favLo = ho !== null ? Math.abs(ho) : null;
  let lineMove = 'UNKNOWN';
  if (favLo !== null) {
    const diff = favLc - favLo;
    lineMove = diff > LINE_THRESH ? 'DEEPER' : diff < -LINE_THRESH ? 'SHRANK' : 'STABLE';
  }

  const homMoveEngine = oddsDir(hoc, hoo);
  const aomMoveEngine = oddsDir(aoc, aoo);
  const favOddsMove = favSide === 'HOME' ? homMoveEngine : aomMoveEngine;
  const dogOddsMove = favSide === 'HOME' ? aomMoveEngine : homMoveEngine;

  const ovc = sf(document.getElementById('ov_c').value);
  const ovo = sf(document.getElementById('ov_o').value);
  const unc = sf(document.getElementById('un_c').value);
  const uno = sf(document.getElementById('un_o').value);
  const overMove  = oddsDir(ovc, ovo);
  const underMove = oddsDir(unc, uno);

  const tlc = sf(document.getElementById('tl_c').value);
  const tlo = sf(document.getElementById('tl_o').value);
  const tlMove = moveDir(tlc, tlo, TL_THRESH);

  return {
    fav_line:           favLine.toFixed(2),
    fav_lo:             favLo,
    fav_side:           favSide,
    line_move:          lineMove,                    // Tier 1 — always on
    fav_odds_move:      tier2 ? favOddsMove : 'ANY',
    fav_odds_min_delta: null,
    dog_odds_move:      tier2 ? dogOddsMove : 'ANY',
    over_move:          tier2 ? overMove    : 'ANY',
    under_move:         tier2 ? underMove   : 'ANY',
    tl_range:           null,
    tl_c:               tlc != null ? tlc.toFixed(2) : null,
    tl_cluster:         null,
    tl_move:            tlMove,                       // Tier 1 — always on
    tl_max:             null,
    odds_tolerance:     null,
    fav_oc:             favOc,
    fav_oo:             favOo,
    dog_oc:             dogOc,
    dog_oo:             dogOo,
    ov_c:               null,
    ov_tol:             null,
    un_c:               null,
    un_tol:             null,
  };
}

function buildMatchCfg() {
  // Pass 1: Tier 1 signals only, to see whether they're STABLE.
  const base = buildRawCfg(false);
  if (!base) return null;
  // Pass 2: activate Tier 2 (odds-movement) signals only where the
  // matching Tier 1 signal was STABLE — sharper signal takes priority.
  const lineStable = base.line_move === 'STABLE';
  const tlStable    = base.tl_move   === 'STABLE';
  if (!lineStable && !tlStable) return base;

  const cfg2 = buildRawCfg(true);
  if (!lineStable) { cfg2.fav_odds_move = 'ANY'; cfg2.dog_odds_move = 'ANY'; }
  if (!tlStable)    { cfg2.over_move = 'ANY'; cfg2.under_move = 'ANY'; }
  return cfg2;
}

/* ════════════════════════════════════════════════════════════
   ANALYZE — the single entry point
   ════════════════════════════════════════════════════════════ */
function analyzeMatch() {
  if (!_db.length) { showError('No database loaded. Please upload CSV files first.'); return; }

  const cfg = buildMatchCfg();
  if (!cfg) { showError('Invalid AH line — enter a valid Asian Handicap value.'); return; }

  showLoader();

  setTimeout(() => {
    try {
      const minN     = getMinN();
      const activeDb = getDb();

      const cfgRows      = applyConfig(activeDb, cfg);
      const baselineRows = applyBaselineConfig(activeDb, cfg);
      const blSide        = baselineRows.filter(r => r.fav_side === cfg.fav_side);

      const allBets = scoreBets(cfgRows, baselineRows, blSide, minN);
      const bets    = allBets.filter(b => Math.abs(b.z) >= MIN_Z);

      const gs = readGameState();
      let gsAllBets = [];
      if (gs) {
        const gsSigRows = applyGameState(cfgRows,      gs);
        const gsBlRows  = applyGameState(baselineRows, gs);
        const gsBlSide  = applyGameState(blSide,        gs);
        gsAllBets = scoreBets(gsSigRows, gsBlRows, gsBlSide, minN);

        // Live time-decay for 2H-eligible bets once the match is into the
        // 2nd half: replaces the coarse bucket-matched numbers above, for
        // just those bet keys, with a minute-aware Poisson estimate anchored
        // on the (always minute-agnostic) HT-conditioned historical rate —
        // never the INPLAY_2H bucket, to avoid double-counting.
        if (gs.minute != null && gs.minute > 45) {
          const htGs     = { trigger: 'HT', home_goals: gs.home_goals, away_goals: gs.away_goals };
          const htRows   = applyGameState(cfgRows,      htGs);
          const htBlRows = applyGameState(baselineRows, htGs);
          const htBlSide = applyGameState(blSide,        htGs);
          const htAnchorBets = scoreBets(htRows, htBlRows, htBlSide, minN);
          const htAnchorMap  = new Map(htAnchorBets.map(b => [b.k, b]));

          const favG2h = cfg.fav_side === 'HOME' ? (gs.cur_home_2h || 0) : (gs.cur_away_2h || 0);
          const dogG2h = cfg.fav_side === 'HOME' ? (gs.cur_away_2h || 0) : (gs.cur_home_2h || 0);

          const liveMap = new Map(gsAllBets.map(b => [b.k, b]));
          for (const anchor of htAnchorBets) {
            const live = buildLiveAdjustedBet(anchor, gs.minute, favG2h, dogG2h, cfg.fav_side, cfg.fav_line, state.useFlatDecay, htAnchorMap);
            // Already-decided bets (e.g. "Over 0.5 in 2H" once a goal has
            // already gone in) are dropped entirely — no bookmaker still
            // offers this once it's already happened, so it's not a bet
            // left to show, not even at its old pre-live number.
            if (live === _ALREADY_DECIDED) liveMap.delete(anchor.k);
            else if (live) liveMap.set(anchor.k, live);
          }
          gsAllBets = [...liveMap.values()];
        }
      }

      const ftrace = traceConfig(activeDb, cfg, gs);

      renderMatchResults({
        cfg_n:    cfgRows.length,
        allBets,
        bets,
        gsAllBets,
        gsLabelText: gs ? gs.label : null,
        ftrace,
        min_n:    minN,
        cfg,
      });
    } catch (e) {
      showError(e.message);
    }
  }, 20);
}

/* ════════════════════════════════════════════════════════════
   RENDER HELPERS
   ════════════════════════════════════════════════════════════ */
function showLoader() {
  document.getElementById('right-manual').innerHTML =
    `<div class="loader visible"><div class="spinner"></div> Analysing…</div>`;
}

function showError(msg) {
  document.getElementById('right-manual').innerHTML =
    `<div class="no-bets"><div class="warn-icon">⚠️</div><p>${msg}</p></div>`;
}

function tierClass(z) {
  const az = Math.abs(z);
  if (az >= 2.5) return 'strong';
  if (az >= 2.0) return 'good';
  return 'marginal';
}

function tierLabel(tier) {
  return { strong: '★★ STRONG', good: '★ GOOD', marginal: '~ MARGINAL' }[tier];
}

function barColor(p, bl) {
  const e = p - bl;
  if (e >= 15) return 'var(--green)';
  if (e >= 8)  return '#00cc88';
  if (e >= 4)  return 'var(--blue)';
  if (e >= 0)  return 'var(--dim)';
  return 'var(--red)';
}

function buildTraceHtml(ftrace, title) {
  if (!ftrace || !ftrace.length) return '';
  const total = ftrace[0][1];
  const final = ftrace[ftrace.length - 1][1];
  const esc   = title.replace(/'/g, "\\'");
  let html = `<div class="ftrace">
    <div class="ftrace-hdr" onclick="this.nextElementSibling.classList.toggle('open');this.querySelector('.ftrace-toggle').textContent=this.nextElementSibling.classList.contains('open')?'▼ ${esc}':'▶ ${esc}'">
      <span class="ftrace-toggle">▶ ${title}</span>
      <span class="ftrace-summary">${total.toLocaleString()} → ${final.toLocaleString()}</span>
    </div>
    <div class="ftrace-body">`;
  let prev = total;
  for (const [label, count] of ftrace) {
    const drop = prev - count;
    let dropHtml = '';
    if (label !== ftrace[0][0] && drop > 0) {
      const pctDrop = prev > 0 ? drop / prev * 100 : 0;
      const cls = pctDrop > 70 ? 'drop-danger' : pctDrop > 35 ? 'drop-warn' : '';
      dropHtml = `<span class="drop ${cls}">${cls ? '−' + pctDrop.toFixed(0) + '%' : ''}</span>`;
    }
    html += `<div class="ftrace-row">
      <span class="step">${label}</span>
      <div style="display:flex;gap:20px">${dropHtml}<span class="count">${count.toLocaleString()}</span></div>
    </div>`;
    prev = count;
  }
  html += `</div></div>`;
  return html;
}

// Sample-size reliability, three tiers instead of the old binary "n>=50 is
// green, everything else is yellow" — that made a 45-match cell and a
// 5-match cell look identically trustworthy. `minN` is the "MINIMUM
// MATCHING RECORDS" bar (user-set for Manual/Live, DEFAULT_MIN_N for
// Dashboard, which has no min-n control of its own) — below it a bet
// wouldn't even have scored in the first place, so "low" here really means
// "just barely cleared the bar, treat cautiously," not "invalid."
function sampleTier(n, minN) {
  const bar = minN != null ? minN : DEFAULT_MIN_N;
  if (n < bar) return 'low';
  if (n < 50)  return 'mid';
  return 'high';
}
const _SAMPLE_TIER_TITLE = {
  low:  'Small sample — close to the minimum-matching-records bar, treat with caution',
  mid:  'Moderate sample',
  high: 'Solid sample (n ≥ 50)',
};
function sampleBadge(n, minN, extraClass) {
  const tier = sampleTier(n, minN);
  return `<span class="n-stat n-stat-${tier}${extraClass ? ' ' + extraClass : ''}" title="${_SAMPLE_TIER_TITLE[tier]}">n=${n}</span>`;
}

function buildBetCol(bet, passes, title, subtitle, rank, colId, minN) {
  if (!bet) {
    return `<div class="bet-col bet-col-empty">
      <div class="col-hdr"><span class="col-title">${title}</span><span class="col-sub">${subtitle}</span></div>
      <div class="col-na">—</div>
    </div>`;
  }
  _lastBetsByWidget.set(`${rank}-${colId}`, bet);
  if (bet._liveDecayed) subtitle = bet._liveLabel;

  const lowN     = minN != null && bet.n < minN;
  const hasMkt   = bet.mkt_bl != null;
  const betLabel = bet.avgTl != null
    ? bet.label.replace('Total Line', 'TL ' + bet.avgTl.toFixed(2))
    : bet.label;
  const edgeSign = bet.edge >= 0 ? '+' : '';
  const edgeCls  = bet.edge >= 0 ? 'pos' : 'neg';
  const fill     = Math.min(100, Math.max(0, bet.p));
  const bColor   = hasMkt ? barColor(bet.p, bet.mkt_bl) : barColor(bet.p, bet.bl);
  const passCls  = (passes && !lowN) ? '' : 'col-weak';
  const mktCls   = hasMkt ? ' bet-col-market' : '';
  // colId is 'pre' for the PRE-MATCH column, 'gs' for IN-PLAY — used (not the
  // title text, which varies) so live/HT-conditioned columns get a distinct
  // look from the static PRE-MATCH column across every card that reuses this
  // function (Dashboard, Manual, Live Games banner + detail modal).
  const liveCls  = bet._liveDecayed ? ' bet-col-live' : (colId === 'gs' ? ' bet-col-inplay' : '');

  const moRange  = `<b>${bet.mo}</b>`;
  const moLabel  = 'BET ≥ (FAIR ODDS)';
  const moFloor  = hasMkt ? `Pinnacle avg ${bet.mkt_avg_odds}  ·  CI ${bet.mo_mid}` : `CI range ${bet.mo} – ${bet.mo_mid}`;

  let matchesHtml = '';
  if (bet.matches && bet.matches.length) {
    const nHit = bet.matches.filter(m => m.hit).length;
    const uid  = `matches-${rank}-${colId}`;
    const rows = bet.matches.map(m => {
      const htHome = m.fav_side === 'HOME' ? m.ht[0] : m.ht[1];
      const htAway = m.fav_side === 'HOME' ? m.ht[1] : m.ht[0];
      const ftHome = m.fav_side === 'HOME' ? m.ft[0] : m.ft[1];
      const ftAway = m.fav_side === 'HOME' ? m.ft[1] : m.ft[0];
      const tl = m.tl_c != null ? m.tl_c.toFixed(2) : '—';
      const d  = (m.date      || '—').slice(0, 10);
      const lg = (m.league    || '—').slice(0, 14);
      const hm = (m.home_team || '—').slice(0, 14);
      const aw = (m.away_team || '—').slice(0, 14);
      const icon = m.hit ? '<span class="match-hit">✓</span>' : '<span class="match-miss">✗</span>';
      return `<div class="match-row">${icon}
        <span class="match-score">HT${htHome}-${htAway} FT${ftHome}-${ftAway}</span>
        <span class="match-meta">${d}  ${lg}  ${hm} v ${aw}  AH-${m.fav_lc.toFixed(2)}  TL${tl}</span>
      </div>`;
    }).join('');
    matchesHtml = `
      <button class="matches-toggle" onclick="toggleMatches('${uid}')">▶ ${bet.matches.length} matches  (${nHit} hits)</button>
      <div class="matches-box" id="${uid}">${rows}</div>`;
  }

  return `<div class="bet-col ${passCls}${mktCls}${liveCls}">
    <div class="col-hdr">
      <span class="col-title">${title}</span>
      <span class="col-sub">${subtitle}</span>
      ${bet._liveDecayed ? '<span class="col-badge-live" title="Poisson time-decay model at the current live minute, not a historical bucket match">🔴 LIVE</span>' : ''}
      ${!bet._liveDecayed && colId === 'gs' ? '<span class="col-badge-ht">HT</span>' : ''}
      ${hasMkt ? '<span class="col-badge-mkt">MKT</span>' : ''}
      ${lowN ? '<span class="col-badge-lown">⚠ low n</span>' : passes ? '<span class="col-badge-pass">✓</span>' : '<span class="col-badge-weak">z&lt;1.5</span>'}
    </div>
    <div class="col-bet-label">${betLabel}</div>
    <div class="col-min-odds">
      <span class="col-min-odds-label">${moLabel}</span>
      <span class="col-min-odds-value">${moRange}</span>
      <span class="col-min-odds-floor">${moFloor}</span>
    </div>
    <div class="col-prob">
      <span class="prob-pct">${bet.p.toFixed(1)}%</span>
      <span class="prob-edge ${edgeCls}">${edgeSign}${bet.edge.toFixed(1)}pp</span>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width:${fill}%;background:${bColor}"></div></div>
    <div class="col-stats">
      ${sampleBadge(bet.n, minN)}
      <span class="badge-z">z=${bet.z.toFixed(2)}</span>
      <span class="col-baseline">bl ${bet.bl.toFixed(1)}%</span>
    </div>
    <div class="bet-ci">CI [${bet.lo}%–${bet.hi}%]</div>
    ${bet.mkt_bl != null ? (() => {
      const meCls = bet.mkt_edge >= 0 ? 'mkt-edge-pos' : 'mkt-edge-neg';
      const meSign = bet.mkt_edge >= 0 ? '+' : '';
      return `<div class="mkt-calibration">
        <span class="mkt-label">vs market</span>
        <span class="${meCls}">${meSign}${bet.mkt_edge.toFixed(1)}pp</span>
        <span class="mkt-sub">mkt implied ${bet.mkt_bl.toFixed(1)}% · avg odds ${bet.mkt_avg_odds}</span>
      </div>`;
    })() : ''}
    ${renderOddsKellyWidget(`${rank}-${colId}`)}
    ${matchesHtml}
  </div>`;
}

// Plain-English summary of a bet's historical edge, in the currently active
// signal configuration. Pure template — no new data, just cfg + bet fields.
function explainBet(bet, cfg) {
  const side = cfg.fav_side === 'AWAY' ? 'away' : 'home';
  const lineTxt = (cfg.line_move && !['STABLE', 'UNKNOWN', 'ANY'].includes(cfg.line_move))
    ? ` (line ${cfg.line_move.toLowerCase()})` : '';
  const tlTxt = (cfg.tl_move && !['UNKNOWN', 'ANY'].includes(cfg.tl_move))
    ? `TL ${cfg.tl_move.toLowerCase()}` : 'TL unmoved';
  return `Historically, when a ${side} favourite's AH line moves like this${lineTxt} with ${tlTxt}, ` +
    `${bet.label} hits ${bet.p.toFixed(0)}% vs ${bet.bl.toFixed(0)}% baseline across ${bet.n} similar matches.`;
}

function renderMergedBetCard(merged, rank, label, stripeLabel, cfg) {
  const { pre, gs, prePass, gsPass } = merged;
  const anchor = (gsPass && gs) ? gs : pre;
  const tier = tierClass(anchor.z);
  const tl   = tierLabel(tier);

  const preColHtml = buildBetCol(pre, prePass, 'PRE-MATCH', 'no score filter', rank, 'pre', merged.minN);
  const gsColHtml  = buildBetCol(gs,  gsPass,  'IN-PLAY',   label,             rank, 'gs',  merged.minN);
  const explainHtml = cfg ? `<div class="bet-explain">${explainBet(anchor, cfg)}</div>` : '';

  return `<div class="bet-card tier-${tier}">
    <div class="bet-stripe">
      <span class="tier-label">${stripeLabel || `BET #${rank}`}  ·  ${tl}</span>
      <div class="badges">
        ${prePass ? '<span class="badge-scenario-pass">PRE ✓</span>' : '<span class="badge-scenario-miss">PRE —</span>'}
        ${gsPass  ? '<span class="badge-scenario-pass">GS ✓</span>'  : '<span class="badge-scenario-miss">GS —</span>'}
      </div>
    </div>
    <div class="bet-merged-header">
      <h3>${anchor.label}</h3>
      <div class="market">${anchor.market}</div>
    </div>
    ${explainHtml}
    <div class="bet-scenarios">
      ${preColHtml}
      ${gsColHtml}
    </div>
  </div>`;
}

// Headline card for the single strongest qualifying bet, so a user can get
// an actionable answer (odds check + Kelly stake) without reading the rest
// of the dashboard. Reuses renderMergedBetCard's markup with a distinct
// widget-id namespace ('top') and wrapper class.
function renderTopPickBanner(qualifying, gsLabelText, cfg) {
  if (!qualifying.length) return '';
  const card = renderMergedBetCard(qualifying[0], 'top', gsLabelText || 'in-play', '🏆 TOP PICK', cfg);
  return `<div class="top-pick-banner">${card}</div>`;
}

// Headline card for the single best value bet (no strong historical edge
// yet, but positive edge and the best fair-odds opportunity) — the other
// actionable answer alongside the Top Pick, surfaced without needing to
// open the collapsed Value Hunting section further down. Reuses
// renderValueHuntCard's markup (also used in the full list).
function renderTopValueBanner(bet, minN) {
  if (!bet) return '';
  return `<div class="top-value-banner">
    <div class="tv-label">💎 BEST VALUE BET  ·  no edge vs baseline yet — best fair-odds watch</div>
    ${renderValueHuntCard(bet, minN)}
  </div>`;
}

function renderBetDashboard(preMap, gsMap, minN) {
  const betDefMap = new Map(BETS.map(b => [b.k, b]));

  const fmtCol = (b) => {
    if (!b) return '<span class="bd-col-na">—</span>';
    const zCls = b.z >= MIN_Z ? 'bd-z-pass' : b.z >= 0 ? 'bd-z-ok' : 'bd-z-neg';
    const eCls = b.edge >= 0 ? 'bd-e-pos' : 'bd-e-neg';
    const sign = b.z >= 0 ? '+' : '';
    return `<span class="${zCls}">z${sign}${b.z.toFixed(1)}</span><span class="bd-sep">·</span><span class="${eCls}">${b.p.toFixed(0)}%</span><span class="bd-bl">vs ${b.bl.toFixed(0)}%</span>`;
  };

  let html = `<div class="bd-col-headers">
    <span class="bd-ch-dot"></span>
    <span class="bd-ch-label">BET</span>
    <span class="bd-ch-scenarios"><span>PRE-MATCH</span><span>IN-PLAY</span></span>
    <span class="bd-ch-n">N</span>
    <span class="bd-ch-mo">MIN ODDS</span>
  </div>
  <div class="bet-dashboard">`;

  for (const group of BET_GROUPS) {
    let rowsHtml = '';
    let groupHasPass = false;
    for (const k of group.keys) {
      const def = betDefMap.get(k);
      if (!def) continue;
      const pre = preMap.get(k) || null;
      const gs  = gsMap.get(k)  || null;
      const bestZ   = Math.max(pre?.z ?? -99, gs?.z ?? -99);
      if (qualifiesBet(pre) || qualifiesBet(gs)) groupHasPass = true;
      const hasData = pre !== null || gs !== null;
      let tierCls;
      if (!hasData)          tierCls = 'bd-nodata';
      else if (bestZ >= 2.5) tierCls = 'bd-strong';
      else if (bestZ >= 2.0) tierCls = 'bd-good';
      else if (bestZ >= 1.5) tierCls = 'bd-marginal';
      else if (bestZ >= 0)   tierCls = 'bd-weak';
      else                   tierCls = 'bd-negative';
      const mo = (pre ?? gs) ? `${(pre ?? gs).mo}–${(pre ?? gs).mo_mid}` : '—';
      const n  = pre?.n ?? gs?.n ?? null;
      const nHtml = n != null ? sampleBadge(n, minN, 'bd-n') : '<span class="bd-n">n=—</span>';
      rowsHtml += `<div class="bd-row ${tierCls}">
        <span class="bd-dot"></span>
        <span class="bd-label">${def.label}</span>
        <span class="bd-scenarios"><span class="bd-pre">${fmtCol(pre)}</span><span class="bd-scen-sep">│</span><span class="bd-gs">${fmtCol(gs)}</span></span>
        ${nHtml}
        <span class="bd-mo">${mo}</span>
      </div>`;
    }
    const badge = groupHasPass ? `<span class="bd-group-badge">●</span>` : '';
    html += `<details class="bd-group" open>
      <summary class="bd-group-hdr">${badge}${group.label}<span class="bd-group-arrow">▸</span></summary>
      <div class="bd-group-body">${rowsHtml}</div>
    </details>`;
  }
  html += '</div>';
  return html;
}

function renderValueHuntSection(valueBets, minN) {
  const cards = valueBets.map(bet => renderValueHuntCard(bet, minN)).join('');
  return `<div class="value-hunt-section">
    <div class="value-hunt-hdr" onclick="
      const b = this.nextElementSibling;
      b.classList.toggle('open');
      this.querySelector('.vh-toggle').textContent =
        b.classList.contains('open')
          ? '▼ VALUE HUNTING  (${valueBets.length} bets)'
          : '▶ VALUE HUNTING  (${valueBets.length} bets)'">
      <span class="vh-toggle">▼ VALUE HUNTING  (${valueBets.length} bets)</span>
      <span class="vh-sub">no edge vs baseline — look for soft books above safe min odds</span>
    </div>
    <div class="value-hunt-body open">${cards}</div>
  </div>`;
}

function renderValueHuntCard(bet, minN) {
  return `<div class="vh-card">
    <div class="vh-body">
      <div class="vh-left">
        <div class="vh-label">${bet.label}</div>
        <div class="vh-market">${bet.market}</div>
        <div class="vh-info">
          <span class="vh-p">p=${bet.p.toFixed(1)}%</span>
          ${sampleBadge(bet.n, minN)}
          <span class="vh-ci">  CI [${bet.lo}%–${bet.hi}%]</span>
        </div>
      </div>
      <div class="vh-right">
        <div class="mo-label">FAIR ODDS</div>
        <div class="vh-mo-value"><b>${bet.mo}</b></div>
        <div class="mo-sub">target odds at bookmaker</div>
        <div class="mo-lo-ref">CI range ${bet.mo} – ${bet.mo_mid}</div>
      </div>
    </div>
  </div>`;
}

function toggleMatches(id) {
  const box = document.getElementById(id);
  const btn = box.previousElementSibling;
  if (!box) return;
  box.classList.toggle('open');
  btn.textContent = (box.classList.contains('open') ? '▼' : '▶') + btn.textContent.slice(1);
}

/* ════════════════════════════════════════════════════════════
   RENDER MATCH RESULTS
   ════════════════════════════════════════════════════════════ */
// Qualifying bets — full detail cards, merging pre-match + in-play.
// qualifiesBet() requires both z >= MIN_Z AND the Wilson CI lower bound to
// still clear baseline by MIN_EDGE — see qualifiesBet() for why raw z alone
// isn't enough. Shared by Match Analysis and Live Games (same merge logic,
// different source of preMap/gsMap).
function buildQualifyingList(preMap, gsMap, minN) {
  const qualifying = [];
  for (const def of BETS) {
    const pre = preMap.get(def.k) || null;
    const gs  = gsMap.get(def.k)  || null;
    const prePass = qualifiesBet(pre);
    const gsPass  = qualifiesBet(gs);
    if (prePass || gsPass) {
      const bestZ = Math.max(pre?.z ?? -99, gs?.z ?? -99);
      // Ranking among already-qualified bets uses the same CI-discounted
      // score scoreBets() itself sorts by (z * lo/100) — bigger z alone can
      // still favour a thinner-sample bet over a more robust one.
      const score = (b) => b ? b.z * (b.lo / 100) : -Infinity;
      const bestScore = Math.max(score(prePass ? pre : null), score(gsPass ? gs : null));
      qualifying.push({ pre, gs, prePass, gsPass, bestZ, bestScore, minN });
    }
  }
  qualifying.sort((a, b) => b.bestScore - a.bestScore);
  return qualifying;
}

// Value hunt — positive edge but not (yet) a qualifying bet in either the
// pre-match or in-play/live tier — i.e. fails qualifiesBet() (raw z and/or
// the CI-lower-bound-vs-baseline check) on both, but still shows a positive
// point-estimate edge with enough sample to be worth a fair-odds watch.
// Mirrors buildQualifyingList's pre/gs merge, and for the same reason: a
// live match's value-hunt bet should reflect the minute-decayed live number
// once one exists, not silently fall back to a stale pre-match figure just
// because pre-match happened to be checked first (which is what a plain
// preBets-only filter did previously — over05_2H-style bets in particular
// could sit at a pre-match fair price for an entire match even once live
// decay data was available).
function buildValueHuntList(preMap, gsMap, minN) {
  const usable = (b) => b && b.edge > 0 && b.n >= minN;
  const score  = (b) => b ? b.z * (b.lo / 100) : -Infinity;
  const vh = [];
  for (const def of BETS) {
    const pre = preMap.get(def.k) || null;
    const gs  = gsMap.get(def.k)  || null;
    if (qualifiesBet(pre) || qualifiesBet(gs)) continue; // already surfaced as a qualifying bet
    const preOk = usable(pre);
    const gsOk  = usable(gs);
    if (!preOk && !gsOk) continue;
    // Prefer the in-play/live figure when it clears the same bar — more
    // current once a match is in 2H — falling back to pre-match otherwise.
    vh.push(gsOk ? gs : pre);
  }
  vh.sort((a, b) => score(b) - score(a));
  return vh;
}

function renderMatchResults({ cfg_n, allBets, bets, gsAllBets, gsLabelText, ftrace, min_n, cfg }) {
  const right = document.getElementById('right-manual');
  _lastBetsByWidget = new Map();

  const ahSide = cfg.fav_side === 'AWAY' ? 'Away' : 'Home';
  const cfgSummary = `<div class="cfg-summary">${ahSide} AH −${cfg.fav_line} · ${cfg_n} matching records${gsLabelText ? ' · ' + gsLabelText : ''}</div>`;

  const preMap = new Map(allBets.map(b => [b.k, b]));
  const gsMap  = new Map((gsAllBets || []).map(b => [b.k, b]));

  const qualifying = buildQualifyingList(preMap, gsMap, min_n);
  const vhBets = buildValueHuntList(preMap, gsMap, min_n);

  // Page order: (1) Qualifying Bets — headline Top Pick banner immediately
  // followed by the full ranked list, so the strongest, statistically-
  // validated bets are the very first thing visible; (2) Value Bets — same
  // headline+full-list pattern for the positive-edge-but-not-yet-qualifying
  // bets; (3) everything else (title, bankroll, config summary, filter
  // trace, the full pre-match/in-play dashboard) last, since those are
  // context/tools rather than the actionable answer itself.
  let html = renderTopPickBanner(qualifying, gsLabelText, cfg);
  if (qualifying.length) {
    html += `<div class="section-label" style="margin-top:18px">QUALIFYING BETS</div>`;
    html += `<p style="font-size:11px;color:var(--dim);margin-bottom:10px">${qualifying.length} bet${qualifying.length !== 1 ? 's' : ''} · z ≥ ${MIN_Z} and CI lower bound clears baseline · sorted by strength</p>`;
    qualifying.forEach((m, i) => { html += renderMergedBetCard(m, i + 1, gsLabelText || 'in-play', null, cfg); });
  } else {
    html += `<div class="no-bets" style="margin-top:20px"><div class="warn-icon">⚠</div>
      <p>No bets clear the statistical bar (z ≥ ${MIN_Z} AND the conservative CI-lower-bound hit rate still beats baseline) yet.<br>Try a different AH line, or add the HT / current score once available.</p></div>`;
  }

  html += renderTopValueBanner(vhBets[0], min_n);
  if (vhBets.length) html += renderValueHuntSection(vhBets, min_n);

  html += `<h2 class="results-title">BEST BETS</h2>`;
  html += `<div class="bankroll-row">
    <span class="col-min-odds-label">BANKROLL (optional)</span>
    <input type="text" class="bankroll-input" placeholder="e.g. 500" value="${state.bankroll ?? ''}" oninput="setBankroll(this.value)">
  </div>`;
  html += cfgSummary;
  html += buildTraceHtml(ftrace, 'FILTER TRACE');

  // All bets dashboard — pre-match vs in-play, colour-coded
  html += renderBetDashboard(preMap, gsMap, min_n);

  right.innerHTML = html;
}

/* ════════════════════════════════════════════════════════════
   TABS
   ════════════════════════════════════════════════════════════ */
const TABS = ['dashboard', 'live', 'manual'];
let _activeTab = 'dashboard';

function switchTab(name) {
  if (!TABS.includes(name)) return;
  _activeTab = name;
  TABS.forEach(t => {
    document.getElementById(`tabbtn-${t}`)?.classList.toggle('active', t === name);
    document.getElementById(`tab-${t}-controls`)?.classList.toggle('active', t === name);
    document.getElementById(`right-${t}`)?.classList.toggle('active', t === name);
  });
  if (name === 'live') startLivePolling();
  else stopLivePolling();
}

/* ════════════════════════════════════════════════════════════
   LIVE GAMES
   ════════════════════════════════════════════════════════════ */
const LIVE_POLL_MS = 60000;
const HT_ANCHOR_STORAGE_KEY = 'halvest_ht_anchors';
// Long enough to cover a match plus stoppage time, short enough that a
// closed-and-reopened browser tab doesn't accumulate stale entries forever.
const HT_ANCHOR_MAX_AGE_MS = 6 * 60 * 60 * 1000;

let _liveMatchesAll = [];       // last analyzed batch, before the live-tier display filter
let _liveMatches    = [];       // _liveMatchesAll filtered by state.liveTierFilter — what's actually rendered/indexed
let _liveHtAnchors = new Map(); // matchId -> {home, away, ts}
let _livePollTimer = null;
let _liveAutoRefresh = true;
let _liveLastUpdated = null;

function matchKey(m) {
  return m.id || `${m.home_team}:${m.away_team}`;
}

// "23'" -> 23, "45+2'" -> 45, "HT" -> 45 (HT itself is treated as the
// anchor-capture moment, same as the rest of 2H-start handling below).
function parseLiveMinute(raw) {
  if (raw == null) return null;
  if (raw === 'HT') return 45;
  const m = String(raw).match(/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

function loadHtAnchors() {
  try {
    const raw = localStorage.getItem(HT_ANCHOR_STORAGE_KEY);
    if (!raw) { _liveHtAnchors = new Map(); return; }
    const obj = JSON.parse(raw);
    const now = Date.now();
    _liveHtAnchors = new Map(
      Object.entries(obj).filter(([, v]) => v && now - v.ts < HT_ANCHOR_MAX_AGE_MS)
    );
  } catch { _liveHtAnchors = new Map(); }
}

function saveHtAnchors() {
  try {
    localStorage.setItem(HT_ANCHOR_STORAGE_KEY, JSON.stringify(Object.fromEntries(_liveHtAnchors)));
  } catch { /* localStorage unavailable — anchors stay in-memory only for this session */ }
}

// Snapshots the score the first time a match is observed crossing into 2H
// (minute 44-50, or the "HT" sentinel) — this is what lets live 2H fair odds
// compute automatically, with no manual HT entry.
function updateHtAnchor(match, minute) {
  const id = matchKey(match);
  if (_liveHtAnchors.has(id)) return;
  if (minute < 44 || minute > 50) return;
  if (!match.score) return;
  const [h, a] = match.score.split('-').map(Number);
  if (isNaN(h) || isNaN(a)) return;
  _liveHtAnchors.set(id, { home: h, away: a, ts: Date.now() });
  saveHtAnchors();
}

async function fetchLiveMatches() {
  const res = await fetch('/api/livescore');
  if (!res.ok) throw new Error(`livescore fetch failed: HTTP ${res.status}`);
  const data = await res.json();
  const seen = new Set();
  return (data.matches || []).filter(m => {
    if (m.minute == null) return false; // not yet kicked off — Live Games only covers in-play matches
    const id = matchKey(m);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
}

// Scores one live match against the historical dataset using the match's
// own real closing-odds signal pattern (buildCfgFromLiveOdds), then layers
// HT-conditioned and (once an HT anchor is known) minute-decayed live 2H
// bets on top — same pipeline analyzeMatch() uses, just driven by the live
// feed instead of manual input.
function analyzeLiveMatch(match, minute) {
  // The live match's OWN league tier — independent of state.leagueTier,
  // which restricts the historical baseline pool instead. This is what
  // state.liveTierFilter (Live Games tab) filters the match list by.
  const leagueTier = classifyLeague(match.league);

  const cfg = buildCfgFromLiveOdds(match.odds || {});
  if (!cfg) return { match, minute, cfg: null, status: 'no-odds', leagueTier };

  const db = getDb();
  const cfgRows = applyConfig(db, cfg);
  const baselineRows = applyBaselineConfig(db, cfg);
  const blSide = baselineRows.filter(r => r.fav_side === cfg.fav_side);
  const minN = getMinN();
  if (!cfgRows.length || !baselineRows.length || cfgRows.length < minN) {
    return { match, minute, cfg, status: 'no-history', leagueTier };
  }

  // 1H bets are meaningless once the half they describe is already over — a
  // match still in 1H only ever shows 1H markets, a match at HT/in 2H only
  // ever shows 2H markets (never both at once, never mid-transition).
  const past1H = minute >= 45;
  const preBetsAll = scoreBets(cfgRows, baselineRows, blSide, minN);
  let preBets = filterLiveScanBets(preBetsAll, past1H);

  let gsBets = null, htBets = null, liveBets = null, gsForTrace = null;
  let anchorStatus = minute < 44 ? '1h' : 'unknown';

  // Resolved once, up front, so the two branches below are mutually
  // exclusive: a match that already has an HT anchor always takes the
  // 2H-conditioned path, even at the exact minute (44) where an anchor can
  // just have been captured on this same poll while past1H is still false.
  const anchor = minute < 44 ? null : _liveHtAnchors.get(matchKey(match));

  // Still in 1H with no HT anchor yet — live-decay the 1H bets straight from
  // kickoff (always 0-0 at minute 0, so there's no anchor snapshot to wait
  // for, unlike 2H's HT anchor). preBets stays the plain closing-odds rate
  // ("PRE-MATCH", no time info); the live-decayed numbers go in
  // gsBets/liveBets ("IN-PLAY"), same pre/gs split the HT-anchored 2H branch
  // below uses.
  if (!anchor && match.score) {
    const [curH, curA] = match.score.split('-').map(Number);
    if (!isNaN(curH) && !isNaN(curA)) {
      const preBetsMap = new Map(preBetsAll.map(b => [b.k, b]));
      // Already-decided bets (e.g. "Over 0.5 in 1H" once a goal has already
      // gone in this half) are dropped entirely, not shown at a bogus
      // 100%/0% — there's no bookmaker still offering that once it's
      // already happened.
      liveBets = [];
      for (const b of filterLiveScanBets(preBetsAll, false)) {
        const live = buildLive1HAdjustedBet(b, minute, curH, curA, cfg.fav_side, cfg.fav_line, state.useFlatDecay, preBetsMap);
        if (live === _ALREADY_DECIDED) continue;
        liveBets.push(live || b);
      }
      gsBets = liveBets;
    }
  }

  if (anchor) {
    anchorStatus = 'known';
    gsForTrace = { trigger: 'HT', home_goals: String(anchor.home), away_goals: String(anchor.away) };
    const gsRows   = applyGameState(cfgRows,      gsForTrace);
    const gsBlRows = applyGameState(baselineRows, gsForTrace);
    const gsBlSide = applyGameState(blSide,        gsForTrace);
    if (gsRows.length >= minN) {
      // An HT anchor exists, so this branch is inherently 2H-conditioned
      // regardless of the exact current minute (always true by the time an
      // anchor exists, but pass true explicitly rather than past1H — an
      // anchor captured right at minute 44 would otherwise wrongly select
      // the 1H key set here).
      htBets = scoreBets(gsRows, gsBlRows, gsBlSide, minN);
      gsBets = filterLiveScanBets(htBets, true);

      if (minute > 45 && match.score) {
        const [curH, curA] = match.score.split('-').map(Number);
        if (!isNaN(curH) && !isNaN(curA)) {
          const favG2h = Math.max(0, (cfg.fav_side === 'HOME' ? curH : curA) - (cfg.fav_side === 'HOME' ? anchor.home : anchor.away));
          const dogG2h = Math.max(0, (cfg.fav_side === 'HOME' ? curA : curH) - (cfg.fav_side === 'HOME' ? anchor.away : anchor.home));
          // htBetsMap is built from the FULL (unfiltered) htBets — buildLiveAdjustedBet's
          // 2H-result/BTTS-2H dispatch needs favScored2H as an anchor even though favWins2H/
          // favScored2H themselves are outside the Live Games display set.
          const htBetsMap = new Map(htBets.map(b => [b.k, b]));
          // Already-decided bets (e.g. "Over 0.5 in 2H" once a goal has
          // already gone in this half) are dropped entirely, not shown at a
          // bogus 100%/0% — there's no bookmaker still offering that once
          // it's already happened.
          liveBets = [];
          for (const b of filterLiveScanBets(htBets, true)) {
            const live = buildLiveAdjustedBet(b, minute, favG2h, dogG2h, cfg.fav_side, cfg.fav_line, state.useFlatDecay, htBetsMap);
            if (live === _ALREADY_DECIDED) continue;
            liveBets.push(live || b);
          }
          gsBets = liveBets;
        }
      }
    }
  }

  const htScore = anchor ? { home: anchor.home, away: anchor.away } : null;
  return { match, minute, cfg, status: 'ok', anchorStatus, leagueTier, cfg_n: cfgRows.length, preBets, htBets, liveBets, gsBets, gsForTrace, htScore };
}

function rankScore(b) {
  return b ? b.z * (b.lo / 100) : -Infinity;
}

// The single best actionable bet for a match — a qualifying bet if one
// exists (using whatever the most specific available bet set is: live > HT
// > pre-match, already merged into gsBets/preBets by analyzeLiveMatch),
// falling back to the best value-hunt bet otherwise.
function topLiveBet(analysis) {
  if (analysis.status !== 'ok') return null;
  const preMap = new Map((analysis.preBets || []).map(b => [b.k, b]));
  const gsMap  = new Map((analysis.gsBets  || []).map(b => [b.k, b]));
  const minN = getMinN();
  const qualifying = buildQualifyingList(preMap, gsMap, minN);
  if (qualifying.length) {
    const q = qualifying[0];
    return q.gsPass && q.gs ? q.gs : q.pre;
  }
  const vh = buildValueHuntList(preMap, gsMap, minN);
  return vh[0] || null;
}

async function pollLiveMatches() {
  if (!_db.length) {
    const el = document.getElementById('right-live');
    if (el) el.innerHTML = `<div class="no-bets"><div class="warn-icon">⚠️</div><p>Load a database first.</p></div>`;
    return;
  }
  const statusEl = document.getElementById('live-status-text');
  if (statusEl) statusEl.textContent = 'Refreshing…';

  try {
    const rawMatches = await fetchLiveMatches();

    const analyzed = rawMatches.map(m => {
      const minute = parseLiveMinute(m.minute);
      if (minute == null) return null;
      updateHtAnchor(m, minute);
      return analyzeLiveMatch(m, minute);
    }).filter(Boolean);

    // List order is by match minute descending (longest-running match first)
    // — the "BEST LIVE BET" banner picks its own headline match independently
    // by score (see renderLiveGames), so this only affects the full list.
    analyzed.sort((a, b) => b.minute - a.minute);
    _liveMatchesAll = analyzed;
    applyLiveTierFilter();
    _liveLastUpdated = new Date();
    renderLiveGames();
  } catch (e) {
    if (statusEl) statusEl.textContent = 'Refresh failed';
    if (_activeTab === 'live') {
      document.getElementById('right-live').innerHTML =
        `<div class="no-bets"><div class="warn-icon">⚠️</div><p>Could not load live matches: ${esc(e.message)}</p></div>`;
    }
  }
}

function startLivePolling() {
  loadHtAnchors();
  pollLiveMatches();
  if (_livePollTimer) { clearInterval(_livePollTimer); _livePollTimer = null; }
  if (_liveAutoRefresh) _livePollTimer = setInterval(pollLiveMatches, LIVE_POLL_MS);
}

function stopLivePolling() {
  if (_livePollTimer) { clearInterval(_livePollTimer); _livePollTimer = null; }
}

function toggleLiveAutoRefresh(checked) {
  _liveAutoRefresh = !!checked;
  if (_activeTab !== 'live') return;
  if (_liveAutoRefresh) startLivePolling();
  else stopLivePolling();
}

function anchorStatusNote(analysis) {
  if (analysis.anchorStatus === '1h') return analysis.liveBets ? `LIVE @ ${analysis.minute}' (1H)` : '1st half kickoff — pre-match signal only';
  if (analysis.anchorStatus === 'unknown') return 'HT unknown (opened mid-2H) — closing-odds signal only';
  return analysis.liveBets ? `LIVE @ ${analysis.minute}'` : 'HT-conditioned';
}

// Small colored badge mirroring anchorStatusNote's text, for the compact
// Live Games card and modal header — same red/blue/grey language buildBetCol
// uses for its own LIVE/HT badges, so the status reads at a glance without
// having to parse the note sentence.
function anchorStatusBadge(analysis) {
  if (analysis.liveBets && (analysis.anchorStatus === 'known' || analysis.anchorStatus === '1h')) return '<span class="col-badge-live">🔴 LIVE</span>';
  if (analysis.anchorStatus === 'known') return '<span class="col-badge-ht">HT</span>';
  return `<span class="col-badge-weak">${analysis.anchorStatus === '1h' ? '1H' : 'HT UNKNOWN'}</span>`;
}

// Explicit "HT x-y" + current score line — the auto-captured HT anchor is
// the whole basis for live 2H decay, so it needs to be visible, not just
// implied. `match.score` is always the live feed's current score; htScore
// is the auto-snapshotted halftime score (analyzeLiveMatch), null until one
// has been captured for this match.
function formatHtScoreLine(analysis) {
  const { match, htScore, anchorStatus } = analysis;
  const cur = esc(match.score || '—');
  if (htScore) {
    return `HT <b>${htScore.home}-${htScore.away}</b>${match.score ? ` → now <b>${cur}</b>` : ''}`;
  }
  if (anchorStatus === '1h') return `HT not reached yet — currently <b>${cur}</b>`;
  return `HT unknown (opened mid-2H) — currently <b>${cur}</b>`;
}

function renderLiveGames() {
  const right = document.getElementById('right-live');
  if (!right) return;

  const updatedTxt = _liveLastUpdated
    ? _liveLastUpdated.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    : '—';
  const statusEl = document.getElementById('live-status-text');
  if (statusEl) {
    const hiddenCount = _liveMatchesAll.length - _liveMatches.length;
    statusEl.textContent = hiddenCount > 0
      ? `${_liveMatches.length} shown (${hiddenCount} hidden by tier filter) · updated ${updatedTxt}`
      : `${_liveMatches.length} live · updated ${updatedTxt}`;
  }
  let html = `<h2 class="results-title">LIVE GAMES</h2>`;
  html += `<p style="font-size:11px;color:var(--dim);margin-bottom:10px">${_liveMatches.length} match${_liveMatches.length !== 1 ? 'es' : ''} in play · scored against each match's own real signal pattern · click a match for full detail</p>`;

  if (!_liveMatches.length) {
    html += _liveMatchesAll.length
      ? `<div class="no-bets"><div class="warn-icon">🏳️</div><p>${_liveMatchesAll.length} match${_liveMatchesAll.length !== 1 ? 'es' : ''} live, but none in the "${state.liveTierFilter}" league tier filter — try ALL or MAJOR+ in the left panel.</p></div>`
      : `<div class="no-bets"><div class="warn-icon">⚽</div><p>No live matches right now — check back once matches kick off.</p></div>`;
    right.innerHTML = html;
    closeLiveMatchModal();
    return;
  }

  const okMatches = _liveMatches.filter(m => m.status === 'ok');
  let best = null;
  for (const m of okMatches) {
    const b = topLiveBet(m);
    if (b && (!best || rankScore(b) > rankScore(best.bet))) best = { match: m, bet: b };
  }
  if (best) {
    const preMap = new Map((best.match.preBets || []).map(b => [b.k, b]));
    const gsMap  = new Map((best.match.gsBets  || []).map(b => [b.k, b]));
    const minN = getMinN();
    const qualifying = buildQualifyingList(preMap, gsMap, minN);
    if (qualifying.length) {
      const label = `🏆 BEST LIVE BET — ${esc(best.match.match.home_team)} vs ${esc(best.match.match.away_team)} (${esc(best.match.match.league || '—')})`;
      // rank='live-top' keeps this Kelly-widget namespace distinct from
      // Manual Analysis's own 'top' rank — both write into the shared
      // _lastBetsByWidget map and must not collide on the same widget id.
      html += `<div class="top-pick-banner">${renderMergedBetCard(qualifying[0], 'live-top', anchorStatusNote(best.match), label, best.match.cfg)}</div>`;
    }
  }

  // Every qualifying bet across every shown match, not just the single
  // strongest one above — a match can have more than one bet clear the bar
  // at once, and the "BEST LIVE BET" banner only ever surfaces one.
  const allQualifying = collectAllQualifyingLiveBets(_liveMatches);
  if (allQualifying.length) {
    html += `<div class="section-label" style="margin-top:18px">ALL QUALIFYING BETS (${allQualifying.length})</div>`;
    html += `<p style="font-size:11px;color:var(--dim);margin-bottom:10px">Every bet clearing the statistical bar right now, across all shown matches · sorted by strength · click a row for full match detail</p>`;
    allQualifying.forEach(entry => { html += renderQualifyingLiveBetRow(entry); });
  }

  html += `<div class="section-label" style="margin-top:18px">ALL LIVE MATCHES</div>`;
  _liveMatches.forEach((m, i) => { html += renderLiveMatchCard(m, i); });

  right.innerHTML = html;
}

// Collects every qualifying bet (buildQualifyingList — same statistical bar
// as the top-pick banner and per-match cards) from every "ok" match in
// `matches`, tagged with the match's own index so a row can jump straight to
// openLiveMatchDetail(idx). One match can contribute more than one row.
function collectAllQualifyingLiveBets(matches) {
  const minN = getMinN();
  const all = [];
  matches.forEach((m, idx) => {
    if (m.status !== 'ok') return;
    const preMap = new Map((m.preBets || []).map(b => [b.k, b]));
    const gsMap  = new Map((m.gsBets  || []).map(b => [b.k, b]));
    const qualifying = buildQualifyingList(preMap, gsMap, minN);
    for (const q of qualifying) {
      const bet = q.gsPass && q.gs ? q.gs : q.pre;
      all.push({ idx, analysis: m, bet });
    }
  });
  all.sort((a, b) => rankScore(b.bet) - rankScore(a.bet));
  return all;
}

// One row in the "ALL QUALIFYING BETS" list — team names, league, the bet,
// its %/edge, and the odds range worth betting at, all together per the
// same consolidated-label requirement the headline banners already follow.
function renderQualifyingLiveBetRow(entry) {
  const { idx, analysis, bet } = entry;
  const m = analysis.match;
  return `<div class="scan-card scan-card-qualifies" onclick="openLiveMatchDetail(${idx})">
    <div class="scan-card-header">
      <span class="scan-match-name">${esc(m.home_team)}<span class="scan-vs">vs</span>${esc(m.away_team)}</span>
      <span class="scan-live-info"><span class="scan-minute">${esc(m.minute)}'</span> ${anchorStatusBadge(analysis)}</span>
    </div>
    <div class="scan-meta">${esc(m.league || '—')}</div>
    ${renderBetPickBlock(bet, true)}
  </div>`;
}

// idx (position in _liveMatches, not team-name-derived) is used for the
// click target — team/league names come from the scraped live-odds feed and
// aren't safe to embed raw into an inline onclick string.
function renderLiveMatchCard(analysis, idx) {
  const { match } = analysis;

  if (analysis.status !== 'ok') {
    const msg = analysis.status === 'no-odds'
      ? 'Closing odds not available yet'
      : 'Not enough historical matches for this exact closing config';
    return `<div class="scan-card" style="cursor:default">
      <div class="scan-card-header">
        <span class="scan-match-name">${esc(match.home_team)}<span class="scan-vs">vs</span>${esc(match.away_team)}</span>
        <div class="scan-live-info">
          <span class="scan-score">${esc(match.score || '—')}</span>
          <span class="scan-minute">${esc(match.minute)}</span>
        </div>
      </div>
      <div class="scan-meta">${esc(match.league || '—')}</div>
      <p style="font-size:11px;color:var(--dim)">${msg}</p>
    </div>`;
  }

  const preMap = new Map((analysis.preBets || []).map(b => [b.k, b]));
  const gsMap  = new Map((analysis.gsBets  || []).map(b => [b.k, b]));
  const minN = getMinN();
  const qualifying = buildQualifyingList(preMap, gsMap, minN);
  const vhBets = buildValueHuntList(preMap, gsMap, minN);
  const top = qualifying[0] ? (qualifying[0].gsPass && qualifying[0].gs ? qualifying[0].gs : qualifying[0].pre) : vhBets[0];
  const topQualifies = !!qualifying[0];

  const previewHtml = top
    ? renderBetPickBlock(top, topQualifies) + `<div class="col-stats" style="margin-top:6px">${sampleBadge(top.n, minN)}</div>`
    : `<p style="font-size:11px;color:var(--dim)">No bet clears the bar for this match's signal pattern yet.</p>`;
  const tierCls = top ? (topQualifies ? 'scan-card-qualifies' : 'scan-card-value') : '';

  return `<div class="scan-card ${tierCls}" onclick="openLiveMatchDetail(${idx})">
    <div class="scan-card-header">
      <span class="scan-match-name">${esc(match.home_team)}<span class="scan-vs">vs</span>${esc(match.away_team)}</span>
      <div class="scan-live-info">
        <span class="scan-score">${esc(match.score || '—')}</span>
        <span class="scan-minute">${esc(match.minute)}</span>
      </div>
    </div>
    <div class="scan-meta">${esc(match.league || '—')} · ${esc(anchorStatusNote(analysis))} ${anchorStatusBadge(analysis)}</div>
    <div class="scan-score-detail">${formatHtScoreLine(analysis)}</div>
    ${previewHtml}
  </div>`;
}

function _liveModalEscHandler(e) {
  if (e.key === 'Escape') closeLiveMatchModal();
}

function closeLiveMatchModal() {
  document.getElementById('live-match-modal')?.remove();
  document.removeEventListener('keydown', _liveModalEscHandler);
}

// Full-detail view for one live match — reuses the exact same rendering
// pipeline as Match Analysis (renderTopPickBanner/renderMergedBetCard/
// renderValueHuntSection/buildTraceHtml/renderBetDashboard) rather than a
// bespoke layout, driven by this match's already-computed analysis.
function openLiveMatchDetail(idx) {
  const analysis = _liveMatches[idx];
  if (!analysis) return;
  closeLiveMatchModal();

  const { match, minute, cfg } = analysis;
  let bodyHtml;

  if (analysis.status !== 'ok') {
    bodyHtml = `<div class="no-bets"><div class="warn-icon">⚠️</div><p>${
      analysis.status === 'no-odds'
        ? 'Closing odds not available for this match yet.'
        : 'Not enough historical matches for this exact closing configuration.'
    }</p></div>`;
  } else {
    const preMap = new Map((analysis.preBets || []).map(b => [b.k, b]));
    const gsMap  = new Map((analysis.gsBets  || []).map(b => [b.k, b]));
    const minN = getMinN();
    const qualifying = buildQualifyingList(preMap, gsMap, minN);
    const vhBets = buildValueHuntList(preMap, gsMap, minN);
    const gsLabel = anchorStatusNote(analysis);

    const ahSide = cfg.fav_side === 'AWAY' ? 'Away' : 'Home';
    bodyHtml = `<div class="cfg-summary" style="color:var(--bright)">${formatHtScoreLine(analysis)}</div>`;
    bodyHtml += `<div class="cfg-summary">${ahSide} AH −${cfg.fav_line} · line ${cfgMoveLabel(cfg.line_move)} · fav odds ${cfgMoveLabel(cfg.fav_odds_move)} · dog odds ${cfgMoveLabel(cfg.dog_odds_move)} · TL ${cfg.tl_c ?? '—'} (${cfgMoveLabel(cfg.tl_move)}) · over ${cfgMoveLabel(cfg.over_move)} · under ${cfgMoveLabel(cfg.under_move)} · ${analysis.cfg_n} matching records</div>`;

    // rank namespace prefixed 'live-detail-' so this modal's Kelly widgets
    // never collide with Manual Analysis's own numeric/'top' ranks in the
    // shared _lastBetsByWidget map (both can be present in the DOM at once —
    // the modal layers over whichever tab is active).
    if (qualifying.length) {
      const topPickLabel = `🏆 TOP PICK — ${esc(match.home_team)} vs ${esc(match.away_team)} (${esc(match.league || '—')})`;
      bodyHtml += `<div class="top-pick-banner">${renderMergedBetCard(qualifying[0], 'live-detail-top', gsLabel, topPickLabel, cfg)}</div>`;
      bodyHtml += `<div class="section-label" style="margin-top:18px">QUALIFYING BETS</div>`;
      bodyHtml += `<p style="font-size:11px;color:var(--dim);margin-bottom:10px">${qualifying.length} bet${qualifying.length !== 1 ? 's' : ''} · sorted by strength</p>`;
      qualifying.forEach((m, i) => { bodyHtml += renderMergedBetCard(m, `live-detail-${i + 1}`, gsLabel, null, cfg); });
    } else {
      bodyHtml += `<div class="no-bets" style="margin-top:20px"><div class="warn-icon">⚠</div><p>No bets clear the statistical bar for this match's signal pattern yet.</p></div>`;
    }

    bodyHtml += renderTopValueBanner(vhBets[0], minN);
    if (vhBets.length) bodyHtml += renderValueHuntSection(vhBets, minN);

    const ftrace = traceConfig(getDb(), cfg, analysis.gsForTrace);
    bodyHtml += buildTraceHtml(ftrace, 'FILTER TRACE');
    bodyHtml += renderBetDashboard(preMap, gsMap, minN);
  }

  const modal = document.createElement('div');
  modal.id = 'live-match-modal';
  modal.className = 'modal-overlay';
  modal.onclick = (e) => { if (e.target === modal) closeLiveMatchModal(); };
  modal.innerHTML = `<div class="modal-box">
    <div class="modal-header">
      <div>
        <div class="modal-title">${esc(match.home_team)} <span style="color:var(--dim)">vs</span> ${esc(match.away_team)}</div>
        <div class="modal-sub">${esc(match.league || '—')} · ${esc(match.score || '—')} · ${esc(match.minute)} ${analysis.status === 'ok' ? anchorStatusBadge(analysis) : ''}</div>
      </div>
      <button class="modal-close" onclick="closeLiveMatchModal()">✕</button>
    </div>
    <div class="modal-body">${bodyHtml}</div>
  </div>`;
  document.body.appendChild(modal);
  document.addEventListener('keydown', _liveModalEscHandler);
}

/* ── Live match league-tier filter ──────────────────────────────────────
   Restricts which live matches are shown, by their OWN league (via
   classifyLeague on match.league) — separate from state.leagueTier, which
   restricts the historical baseline pool instead. Obscure leagues have
   thinner historical pools and underperformed out-of-sample in past
   backtesting (see CLAUDE.md), so this lets Live Games narrow down to
   TOP/MAJOR matches specifically, without needing a re-fetch. */
function liveMatchPassesTier(analysis) {
  const t = analysis.leagueTier;
  if (state.liveTierFilter === 'TOP')   return t === 'TOP';
  if (state.liveTierFilter === 'MAJOR') return t === 'TOP' || t === 'MAJOR';
  return true;
}

function applyLiveTierFilter() {
  _liveMatches = _liveMatchesAll.filter(liveMatchPassesTier);
}

function setLiveTierFilter(tier) {
  state.liveTierFilter = tier;
  ['ALL', 'MAJOR', 'TOP'].forEach(t =>
    document.getElementById(`live-tier-btn-${t}`)?.classList.toggle('active', t === tier));
  applyLiveTierFilter();
  renderLiveGames();
}

