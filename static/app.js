/* ════════════════════════════════════════════════════════════
   CONSTANTS
   ════════════════════════════════════════════════════════════ */
const LINE_THRESH   = 0.12;
const ODDS_THRESH   = 0.06;
const TL_THRESH     = 0.12;
const DEFAULT_MIN_N = 15;
const MIN_Z         = 1.5;   // Match Analysis
const MIN_Z_DISC    = 2.0;   // Config Discovery (sweeps ~18k combos — higher bar to control false positives)

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
  // 1H results — fav-normalised
  { k: 'favWins1H',     label: 'Fav wins 1st half',        market: '1H Result — Favourite Win' },
  { k: 'draw1H',        label: 'Draw 1st half',            market: '1H Result — Draw' },
  { k: 'favScored1H',   label: 'Fav scores in 1H',         market: 'Team to Score — Fav 1st Half' },
  // 1H results — home/away
  { k: 'homeWins1H',    label: 'Home wins 1st half',       market: '1H Result — Home Win',   favSideBaseline: 'HOME' },
  { k: 'awayWins1H',    label: 'Away wins 1st half',       market: '1H Result — Away Win',   favSideBaseline: 'AWAY' },
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
  // FT totals — ov_c/un_c price the TL line (typically 2.5), so over25FT/under25FT are direct matches.
  // over15FT and over35FT have no direct proxy (ov_c is calibrated to the TL, not 1.5 or 3.5).
  { k: 'over15FT',      label: 'Over 1.5 goals FT',       market: 'Over/Under 1.5 — Full Time' },
  { k: 'over25FT',      label: 'Over 2.5 goals FT',       market: 'Over/Under 2.5 — Full Time' },
  { k: 'over35FT',      label: 'Over 3.5 goals FT',       market: 'Over/Under 3.5 — Full Time' },
  { k: 'under25FT',     label: 'Under 2.5 goals FT',      market: 'Over/Under 2.5 — Full Time' },
];

// Fixed bet groups for the always-visible dashboard (order defines display order)
const BET_GROUPS = [
  { label: 'FT RESULT',  keys: ['ahCover', 'homeWinsFT', 'drawFT', 'awayWinsFT', 'btts'] },
  { label: 'FT TOTALS',  keys: ['over15FT', 'over25FT', 'over35FT', 'under25FT'] },
  { label: '2H',         keys: ['favWins2H', 'draw2H', 'homeWins2H', 'awayWins2H', 'favScored2H', 'homeScored2H', 'awayScored2H', 'homeOver15_2H', 'awayOver15_2H', 'over05_2H', 'over15_2H', 'under05_2H', 'under15_2H'] },
  { label: '1H',         keys: ['favWins1H', 'draw1H', 'favScored1H', 'homeWins1H', 'awayWins1H', 'over05_1H', 'over15_1H', 'under05_1H', 'under15_1H', 'btts1H'] },
];

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
    homeOver15_2H: home2h >= 2,
    awayOver15_2H: away2h >= 2,
    under05_2H:    (home2h + away2h) === 0,
    under15_2H:    (home2h + away2h) <= 1,
    over25FT:      ftH + ftA >= 3,
    over15FT:      ftH + ftA >= 2,
    over35FT:      ftH + ftA >= 4,
    under25FT:     ftH + ftA <= 2,
    drawFT:        ftH === ftA,
    btts:          ftH >= 1 && ftA >= 1,
    // 1H results
    favWins1H:     favHt > dogHt,
    draw1H:        favHt === dogHt,
    homeWins1H:    htH > htA,
    awayWins1H:    htA > htH,
    favScored1H:   favHt >= 1,
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
  if (cfg.fav_lo != null) {
    const flo = parseFloat(cfg.fav_lo);
    rows = rows.filter(r => r.fav_lo != null && Math.abs(r.fav_lo - flo) < 0.13);
  }
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
function scoreBets(stateRows, baselineRows, baselineSideRows, minN = DEFAULT_MIN_N) {
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
    const matches = stateRows.map(r => ({
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
    }));
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
  if (cfg.fav_lo != null) {
    const flo = parseFloat(cfg.fav_lo);
    rows = rows.filter(r => r.fav_lo != null && Math.abs(r.fav_lo - flo) < 0.13);
    steps.push([`AH opening line ${cfg.fav_lo}`, rows.length]);
  }
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

// Within-half goal-timing shape. NOT derived from this app's dataset — the
// CSVs have no goal-minute timestamps (HT/FT scores only), so this shape is
// fundamentally unverifiable against our own data. Sourced from published
// per-15-minute goal distributions (playthepercentage.com; cross-checked
// against soccerstats.com's multi-league HT/FT split and broader literature
// summaries), normalised to mean 1.0 within each half. Buckets are relative
// elapsed minutes into the half. _FLAT_INTENSITY is the user-toggleable
// "no clustering assumption" alternative (state.useFlatDecay).
const _1H_INTENSITY = [[0,15,0.667],[15,30,1.000],[30,45,1.333]];
const _2H_INTENSITY = [[0,15,0.818],[15,30,1.091],[30,45,1.091]];
const _FLAT_INTENSITY = [[0,45,1.000]];
const _IT_2H = 4;

// Validated against this app's own ~165k-match dataset (AH line vs. average
// 2H goals) — observed ratios landed within ~1-2% of these values, so kept
// unchanged rather than "corrected".
const _LINE_STRENGTH_MOD = {0.25:0.92,0.50:0.96,0.75:1.00,1.00:1.06,1.25:1.12,1.50:1.18};
const _2H_BETS_SET = new Set([
  'over05_2H','over15_2H','over25_2H','favScored2H','favWins2H','ahCover',
  'homeWins2H','awayWins2H','homeScored2H','awayScored2H',
  'homeOver15_2H','awayOver15_2H','under05_2H','under15_2H','draw2H',
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
  'favScored2H':1,'favWins2H':1,'ahCover':1,
  'homeScored2H':1,'awayScored2H':1,
  'homeWins2H':1,'awayWins2H':1,
  'homeOver15_2H':2,'awayOver15_2H':2,
};

// Score-state modifiers — calibrated from this app's own dataset (HT margin
// -> subsequent 2H scoring, n=6,323-63,386 per bucket). Keyed by the current
// in-2H fav-minus-dog goal margin (same bucketing the old single modifier
// used), applied as a bet-class-specific multiplier rather than one blanket
// scalar. Caveat: measured conditioning on HT margin -> rest-of-2H scoring
// (the only thing measurable without goal-minute data) and applied here
// keyed by live in-2H margin-so-far — a reasonable proxy, not an exact match
// to what was measured.
const _FAV_SCORE_MOD   = {'-2':1.08, '-1':1.08, '0':1.00, '1':1.09, '2':1.45};
const _DOG_SCORE_MOD   = {'-2':1.32, '-1':1.09, '0':1.00, '1':1.06, '2':1.04};
const _TOTAL_SCORE_MOD = {'-2':1.16, '-1':1.08, '0':1.00, '1':1.08, '2':1.30};
const _BET_SCORE_MOD_CLASS = {
  favScored2H:'fav', favWins2H:'fav', ahCover:'fav',
  homeScored2H:'side', awayScored2H:'side', homeWins2H:'side', awayWins2H:'side',
  homeOver15_2H:'side', awayOver15_2H:'side',
  over05_2H:'total', over15_2H:'total', over25_2H:'total',
  under05_2H:'total', under15_2H:'total', draw2H:'total',
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
    if(goalsScored>maxG)return{live_p:0,fair_odd:99,note:note+' ✗ Already busted'};
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
    else if(betKey==='homeWins2H'){const l=homeG2h-awayG2h;need=l>0?0:1;}
    else if(betKey==='awayWins2H'){const l=awayG2h-homeG2h;need=l>0?0:1;}
    else need=Math.max(0,(_BET_GOAL_THRESHOLD[betKey]||1)-goalsScored);

    if(need===0)return{live_p:100,fair_odd:1.01,note:note+' ✓ Already hit'};
    liveP=_poissonAtLeast(remLam,need)*100;
  }

  return{
    live_p:Math.round(liveP*10)/10,
    fair_odd:Math.round(1/Math.max(liveP/100,0.001)*100)/100,
    note,
  };
}

// Wraps computeLiveOdd's output back into a scoreBets()-shaped bet object so
// it drops straight into the existing buildBetCol/renderOddsKellyWidget/
// calcKellyStake pipeline unchanged. anchorBet must be the HT-conditioned
// (minute-agnostic) historical bet — never the coarse INPLAY_2H-bucket one,
// to avoid double-counting "goals scored since HT" in both the historical
// pool match AND the Poisson time-decay.
function buildLiveAdjustedBet(anchorBet, minute, favG2h, dogG2h, favSide, favLine, useFlatDecay) {
  if (!_BET_SCORE_MOD_CLASS.hasOwnProperty(anchorBet.k)) return null;
  const favLineNum = parseFloat(favLine) || 0.75;

  const pointRes = computeLiveOdd(anchorBet.p,  anchorBet.k, minute, favLineNum, favG2h, dogG2h, favSide, useFlatDecay);
  if (pointRes.live_p == null) return null;
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
  leagueTier: 'ALL',
  bankroll: null,       // session-only, plain number, no persistence
  recencyMonths: null,  // null = all time, else 3|6|12
  selectedLeague: '',   // for the league-coverage sample-relevance stat
  lastImportedUrl: null, // last successfully imported match link, for Refresh
  useFlatDecay: false,   // live 2H odds: shaped (literature-sourced) vs flat time-decay
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
      status.textContent = '✓ Imported — check fields and analyze';
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

  renderBet365Ref(data.bet365);

  onInputChange();
}

// Bet365 reference odds — display only, never fed into the analysis engine
// (the historical dataset and signal detection are Pinnacle-calibrated).
// Useful to see what you'd actually get at execution time.
function renderBet365Ref(b365) {
  const el = document.getElementById('bet365-ref');
  if (!el) return;
  if (!b365) { el.style.display = 'none'; el.innerHTML = ''; return; }

  const f = v => v != null ? v.toFixed(2) : '—';
  el.style.display = '';
  el.innerHTML = `
    <span class="bet365-ref-label">BET365 (reference)</span>
    <span>AH ${f(b365.ah_hc)}</span>
    <span>Home ${f(b365.ho_c)}</span>
    <span>Away ${f(b365.ao_c)}</span>
    <span>TL ${f(b365.tl_c)}</span>
    <span>O ${f(b365.ov_c)}</span>
    <span>U ${f(b365.un_c)}</span>
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
  if (_db.length && document.getElementById('right-panel')?.querySelector('.results-title')) {
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

          const favG2h = cfg.fav_side === 'HOME' ? (gs.cur_home_2h || 0) : (gs.cur_away_2h || 0);
          const dogG2h = cfg.fav_side === 'HOME' ? (gs.cur_away_2h || 0) : (gs.cur_home_2h || 0);

          const liveMap = new Map(gsAllBets.map(b => [b.k, b]));
          for (const anchor of htAnchorBets) {
            const live = buildLiveAdjustedBet(anchor, gs.minute, favG2h, dogG2h, cfg.fav_side, cfg.fav_line, state.useFlatDecay);
            if (live) liveMap.set(anchor.k, live);
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
  document.getElementById('right-panel').innerHTML =
    `<div class="loader visible"><div class="spinner"></div> Analysing…</div>`;
}

function showError(msg) {
  document.getElementById('right-panel').innerHTML =
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
  const nColor   = bet.n >= 50 ? 'var(--green)' : 'var(--yellow)';
  const fill     = Math.min(100, Math.max(0, bet.p));
  const bColor   = hasMkt ? barColor(bet.p, bet.mkt_bl) : barColor(bet.p, bet.bl);
  const passCls  = (passes && !lowN) ? '' : 'col-weak';
  const mktCls   = hasMkt ? ' bet-col-market' : '';

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

  return `<div class="bet-col ${passCls}${mktCls}">
    <div class="col-hdr">
      <span class="col-title">${title}</span>
      <span class="col-sub">${subtitle}</span>
      ${bet._liveDecayed ? '<span class="col-badge-mkt" title="Poisson time-decay model, not a historical bucket match">MODEL</span>' : ''}
      ${hasMkt ? '<span class="col-badge-mkt">MKT</span>' : ''}
      ${lowN ? '<span class="col-badge-lown">⚠ low n</span>' : passes ? '<span class="col-badge-pass">✓</span>' : '<span class="col-badge-weak">z&lt;1.5</span>'}
    </div>
    <div class="col-bet-label">${betLabel}</div>
    <div class="col-prob">
      <span class="prob-pct">${bet.p.toFixed(1)}%</span>
      <span class="prob-edge ${edgeCls}">${edgeSign}${bet.edge.toFixed(1)}pp</span>
    </div>
    <div class="progress-bar"><div class="progress-fill" style="width:${fill}%;background:${bColor}"></div></div>
    <div class="col-stats">
      <span style="color:${nColor}">n=${bet.n}</span>
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
    <div class="col-min-odds">
      <span class="col-min-odds-label">${moLabel}</span>
      <span class="col-min-odds-value">${moRange}</span>
      <span class="col-min-odds-floor">${moFloor}</span>
    </div>
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

function renderBetDashboard(preMap, gsMap) {
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
      if (bestZ >= MIN_Z) groupHasPass = true;
      const hasData = pre !== null || gs !== null;
      let tierCls;
      if (!hasData)          tierCls = 'bd-nodata';
      else if (bestZ >= 2.5) tierCls = 'bd-strong';
      else if (bestZ >= 2.0) tierCls = 'bd-good';
      else if (bestZ >= 1.5) tierCls = 'bd-marginal';
      else if (bestZ >= 0)   tierCls = 'bd-weak';
      else                   tierCls = 'bd-negative';
      const mo = (pre ?? gs) ? `${(pre ?? gs).mo}–${(pre ?? gs).mo_mid}` : '—';
      const n  = pre?.n ?? gs?.n ?? '—';
      rowsHtml += `<div class="bd-row ${tierCls}">
        <span class="bd-dot"></span>
        <span class="bd-label">${def.label}</span>
        <span class="bd-scenarios"><span class="bd-pre">${fmtCol(pre)}</span><span class="bd-scen-sep">│</span><span class="bd-gs">${fmtCol(gs)}</span></span>
        <span class="bd-n">n=${n}</span>
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

function renderValueHuntSection(valueBets) {
  const cards = valueBets.map(bet => renderValueHuntCard(bet)).join('');
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

function renderValueHuntCard(bet) {
  const nColor = bet.n >= 50 ? 'var(--green)' : 'var(--yellow)';
  return `<div class="vh-card">
    <div class="vh-body">
      <div class="vh-left">
        <div class="vh-label">${bet.label}</div>
        <div class="vh-market">${bet.market}</div>
        <div class="vh-info">
          <span class="vh-p">p=${bet.p.toFixed(1)}%</span>
          <span style="color:${nColor}">  n=${bet.n}</span>
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
function renderMatchResults({ cfg_n, allBets, bets, gsAllBets, gsLabelText, ftrace, min_n, cfg }) {
  const right = document.getElementById('right-panel');
  _lastBetsByWidget = new Map();

  const ahSide = cfg.fav_side === 'AWAY' ? 'Away' : 'Home';
  const cfgSummary = `<div class="cfg-summary">${ahSide} AH −${cfg.fav_line} · ${cfg_n} matching records${gsLabelText ? ' · ' + gsLabelText : ''}</div>`;

  const preMap = new Map(allBets.map(b => [b.k, b]));
  const gsMap  = new Map((gsAllBets || []).map(b => [b.k, b]));

  // Qualifying bets — full detail cards, merging pre-match + in-play
  const qualifying = [];
  for (const def of BETS) {
    const pre = preMap.get(def.k) || null;
    const gs  = gsMap.get(def.k)  || null;
    const prePass = !!(pre && pre.z >= MIN_Z);
    const gsPass  = !!(gs  && gs.z  >= MIN_Z);
    if (prePass || gsPass) {
      const bestZ = Math.max(pre?.z ?? -99, gs?.z ?? -99);
      qualifying.push({ pre, gs, prePass, gsPass, bestZ, minN: min_n });
    }
  }
  qualifying.sort((a, b) => b.bestZ - a.bestZ);

  // Top Pick goes first — before the title, before everything — so the
  // single strongest recommendation is the very first thing visible,
  // with zero scrolling or reading required.
  let html = renderTopPickBanner(qualifying, gsLabelText, cfg);
  html += `<h2 class="results-title">BEST BETS</h2>`;
  html += `<div class="bankroll-row">
    <span class="col-min-odds-label">BANKROLL (optional)</span>
    <input type="text" class="bankroll-input" placeholder="e.g. 500" value="${state.bankroll ?? ''}" oninput="setBankroll(this.value)">
  </div>`;
  html += cfgSummary;
  html += buildTraceHtml(ftrace, 'FILTER TRACE');

  // All bets dashboard — pre-match vs in-play, colour-coded
  html += renderBetDashboard(preMap, gsMap);

  if (qualifying.length) {
    html += `<div class="section-label" style="margin-top:18px">QUALIFYING BETS</div>`;
    html += `<p style="font-size:11px;color:var(--dim);margin-bottom:10px">${qualifying.length} bet${qualifying.length !== 1 ? 's' : ''} · z ≥ ${MIN_Z} · sorted by strength</p>`;
    qualifying.forEach((m, i) => { html += renderMergedBetCard(m, i + 1, gsLabelText || 'in-play', null, cfg); });
  } else {
    html += `<div class="no-bets" style="margin-top:20px"><div class="warn-icon">⚠</div>
      <p>No bets clear the statistical bar (z ≥ ${MIN_Z}) yet.<br>Try a different AH line, or add the HT / current score once available.</p></div>`;
  }

  // Value hunt — positive edge but below the z bar (pre-match pool)
  const vhBets = allBets.filter(b => Math.abs(b.z) < MIN_Z && b.edge > 0 && b.n >= min_n);
  if (vhBets.length) html += renderValueHuntSection(vhBets);

  right.innerHTML = html;
}
