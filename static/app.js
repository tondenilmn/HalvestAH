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
};

const BETS = [
  // AH
  { k: 'ahCover',       label: 'AH Cover (Fav)',           market: 'Asian Handicap — Favourite' },
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
  // 2H totals (symmetric — no favSideBaseline)
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
  { k: 'homeWinsFT',    label: 'Home wins full time',      market: 'Match Result — Home Win',           favSideBaseline: 'HOME' },
  { k: 'awayWinsFT',    label: 'Away wins full time',      market: 'Match Result — Away Win',           favSideBaseline: 'AWAY' },
  { k: 'drawFT',        label: 'Draw full time',           market: 'Match Result — Draw' },
  { k: 'btts',          label: 'BTTS full time',           market: 'Both Teams to Score — FT' },
  // FT totals
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

    return {
      k, label, group,
      sn, sh, sp, slo, shi,
      tn, th, tp,
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
    results.push({ ...b, n, p, bl, z, edge, lo, hi, mo: minOdds(p), mo_lo: minOdds(lo), mo_mid, matches });
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

function discover(db, favLine, favSide, inLineMove, inTlMove, gs, minN = DEFAULT_MIN_N, tlC = 'ANY') {
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

const _1H_INTENSITY = [[0,5,0.70],[5,15,0.90],[15,30,1.00],[30,40,1.10],[40,45,1.35]];
const _2H_INTENSITY = [[0,5,0.75],[5,15,0.90],[15,25,1.05],[25,35,1.20],[35,45,1.55]];
const _IT_2H = 4;

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

function _fac(n){let r=1;for(let i=2;i<=n;i++)r*=i;return r;}

function _goalIntAt(e,half){
  const t=half===1?_1H_INTENSITY:_2H_INTENSITY;
  for(const[s,en,m]of t)if(e>=s&&e<en)return m;
  return t[t.length-1][2];
}

function _integrateInt(from,to,half){
  if(to<=from)return 0;
  const steps=Math.max(1,Math.round((to-from)*4));
  const step=(to-from)/steps;
  let total=0;
  for(let i=0;i<steps;i++)total+=_goalIntAt(from+(i+0.5)*step,half)*step;
  return total;
}

function _baseInt2h(){
  return _integrateInt(0,45,2)+_2H_INTENSITY[_2H_INTENSITY.length-1][2]*_IT_2H;
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

function _scoreStateMod(fav2h,dog2h){
  const d=fav2h-dog2h;
  if(d<=-2)return 1.20;if(d===-1)return 1.10;if(d===0)return 1.00;
  if(d===1)return 0.93;return 0.82;
}

function computeLiveOdd(pHtPct,betKey,matchMinute,favLine=0.75,
                        favGoals2h=0,dogGoals2h=0,favSide='HOME'){
  if(_FT_BETS_SET.has(betKey))
    return{live_p:null,fair_odd:null,note:'Full-time bet — HT reference only'};
  if(!_2H_BETS_SET.has(betKey))
    return{live_p:null,fair_odd:null,note:'—'};

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

  const baseInt=_baseInt2h();
  let elapsed2h,remaining2h,note,fg2h=favGoals2h,dg2h=dogGoals2h;
  if(matchMinute<=45){
    elapsed2h=0;remaining2h=45;fg2h=0;dg2h=0;
    note=`1H min ${matchMinute} — full 2H ahead`;
  }else{
    elapsed2h=Math.min(45,matchMinute-45);
    remaining2h=Math.max(0,45-elapsed2h);
    note=`Min ${matchMinute} — ${Math.round(remaining2h)} min left in 2H`;
  }

  if(remaining2h<=0)return{live_p:100.0,fair_odd:1.01,note:'Match over'};

  const itRate=_2H_INTENSITY[_2H_INTENSITY.length-1][2];
  const remInt=_integrateInt(elapsed2h,45,2)+itRate*_IT_2H;
  const intFrac=remInt/baseInt;
  const bayMod=1-(elapsed2h/45)*0.05;
  let remLam=lam*intFrac*bayMod*_scoreStateMod(fg2h,dg2h);

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

/* ════════════════════════════════════════════════════════════
   APP STATE & DATABASE
   ════════════════════════════════════════════════════════════ */
let _db       = [];
let _fileInfo = [];
let _scanDataCache  = new Map();   // id → { odds, match, cfg }; populated by runBatchScan
let _activeScanCfg  = null;        // cfg of the match currently loaded from scan

const state = {
  gsTrigger:    'HT',
  gsaTrigger:   'HT',
  dGsTrigger:   'HT',
  liveOn:       false,
  filterMode:   'ADVANCED', // 'BASIC' or 'ADVANCED'
  // Advanced toggles
  advLmOn:      true,
  advOddsTolOn: false,
  advOddsDeltaOn: false,
  advHomOn:     false,
  advAomOn:     false,
  advTlmOn:     true,
  advOvTolOn:   false,
  advOvmOn:     false,
  advUnTolOn:   false,
  advUnmOn:     false,
  advTlRange:   '2.25-2.75',
  bOddsSide: 'FAV',      // which side(s) to apply odds tolerance: 'FAV' | 'DOG' | 'BOTH'
  scanOddsSide: 'FAV',  // scan tab odds side filter: 'FAV' | 'DOG' | 'BOTH'
  // Basic signal toggles
  bLmOn:  true,
  bFomOn: false,
  bDomOn: false,
  bTlmOn: true,
  bOvmOn: false,
  bUnmOn: false,
  // GSA tab movement toggles (scan mode)
  gsaLmOn:  true,
  gsaTlmOn: true,
  gsaFomOn: false,
  gsaDomOn: false,
  gsaOvmOn: false,
  gsaUnmOn: false,
  leagueTier: 'ALL',
};

function getDb() {
  if (state.leagueTier === 'TOP')   return _db.filter(r => r.league_tier === 'TOP');
  if (state.leagueTier === 'MAJOR') return _db.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
  return _db;
}

/* ════════════════════════════════════════════════════════════
   INIT
   ════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  setupUpload();
  renderGsPanel('gsa-gs-panel', 'HT');
  renderGsPanel('d-gs-panel', 'HT');
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
   TAB SWITCHING
   ════════════════════════════════════════════════════════════ */
function switchTab(name) {
  document.querySelectorAll('.tab-btn').forEach(b => {
    b.classList.toggle('active', b.dataset.tab === name);
  });
  ['match', 'disc', 'scan', 'gsa'].forEach(t =>
    document.getElementById(`tab-${t}`).classList.toggle('active', t === name)
  );
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
  }
}

/* ════════════════════════════════════════════════════════════
   DB CARD + URL IMPORT COLLAPSE TOGGLES
   ════════════════════════════════════════════════════════════ */
function toggleDbExpand() {
  const area = document.getElementById('db-expand-area');
  const btn  = document.getElementById('db-expand-btn');
  if (!area) return;
  const open = area.style.display !== 'none';
  area.style.display = open ? 'none' : '';
  btn.textContent    = open ? '▶' : '▼';
}

function toggleUrlImport() {
  const body  = document.getElementById('url-import-body');
  const arrow = document.getElementById('url-toggle-arrow');
  if (!body) return;
  const open = body.style.display !== 'none';
  body.style.display = open ? 'none' : '';
  if (arrow) arrow.textContent = open ? '▼' : '▲';
}

/* ════════════════════════════════════════════════════════════
   FILTER MODE SWITCHER
   ════════════════════════════════════════════════════════════ */
function setFilterMode(mode) {
  state.filterMode = mode;
  document.getElementById('mode-btn-BASIC').classList.toggle('active', mode === 'BASIC');
  document.getElementById('mode-btn-ADVANCED').classList.toggle('active', mode === 'ADVANCED');
  document.getElementById('basic-inputs').style.display  = mode === 'BASIC'    ? '' : 'none';
  document.getElementById('adv-inputs').style.display    = mode === 'ADVANCED' ? '' : 'none';
  onInputChange();
}

/* ════════════════════════════════════════════════════════════
   INPUT MIRRORING & SIGNAL REFRESH
   ════════════════════════════════════════════════════════════ */
function onInputChange() {
  if (state.filterMode === 'BASIC') {
    mirrorBasic();
  } else {
    mirrorAdvanced();
    refreshAdvSignals();
  }
}

function mirrorBasic() {
  const hc = parseFloat(document.getElementById('b_ah_hc').value);
  const el = document.getElementById('b_ah_ac');
  if (!isNaN(hc)) el.textContent = (Math.abs(hc) < 0.001 ? 0 : -hc).toFixed(2);
  else el.textContent = '—';
}

function mirrorAdvanced() {
  const hc = parseFloat(document.getElementById('ah_hc').value);
  const ho = parseFloat(document.getElementById('ah_ho').value);
  const acEl = document.getElementById('ah_ac');
  const aoEl = document.getElementById('ah_ao');

  if (!isNaN(hc)) acEl.value = (Math.abs(hc) < 0.001 ? 0 : -hc).toFixed(2);
  else acEl.value = '';
  if (!isNaN(ho)) aoEl.value = (Math.abs(ho) < 0.001 ? 0 : -ho).toFixed(2);
  else aoEl.value = '';
}

/* ════════════════════════════════════════════════════════════
   ADVANCED SIGNAL PREVIEW
   ════════════════════════════════════════════════════════════ */

// Map engine signal (IN/OUT/STABLE/UNKNOWN) to display label for odds direction
function engineToUiLabel(sig) {
  if (sig === 'IN')      return 'STEAM';
  if (sig === 'OUT')     return 'DRIFT';
  return sig; // STABLE, UNKNOWN, DEEPER, SHRANK, UP, DOWN, etc.
}

function refreshAdvSignals() {
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
  setAdvSig('adv-sig-lm', lineMove, lineMove);

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
      dirEl.textContent = 'e.g. \u22120.75 = Home gives';
      dirEl.style.color = 'var(--dim)';
    }
  }

  // Home odds movement
  const homMove = oddsDir(isNaN(hoc) ? null : hoc, isNaN(hoo) ? null : hoo);
  setAdvSig('adv-sig-hom', engineToUiLabel(homMove), homMove);

  // Away odds movement
  const aomMove = oddsDir(isNaN(aoc) ? null : aoc, isNaN(aoo) ? null : aoo);
  setAdvSig('adv-sig-aom', engineToUiLabel(aomMove), aomMove);

  // TL movement
  const tlMove = moveDir(isNaN(tlc) ? null : tlc, isNaN(tlo) ? null : tlo, TL_THRESH);
  setAdvSig('adv-sig-tlm', tlMove, tlMove);

  // Over odds movement
  const ovMove = oddsDir(isNaN(ovc) ? null : ovc, isNaN(ovo) ? null : ovo);
  setAdvSig('adv-sig-ovm', engineToUiLabel(ovMove), ovMove);

  // Under odds movement
  const unMove = oddsDir(isNaN(unc) ? null : unc, isNaN(uno) ? null : uno);
  setAdvSig('adv-sig-unm', engineToUiLabel(unMove), unMove);
}

function setAdvSig(id, text, colorClass) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = text;
  el.className   = 'sdrow-val ' + colorClass;
}

/* ════════════════════════════════════════════════════════════
   ADVANCED TOGGLES
   ════════════════════════════════════════════════════════════ */
function toggleAdvToggle(name) {
  const map = {
    'lm':      { key: 'advLmOn',      tgl: 'adv-lm-tgl'      },
    'oddsTol':   { key: 'advOddsTolOn',   tgl: 'adv-oddstol-tgl'  },
    'oddsDelta': { key: 'advOddsDeltaOn', tgl: 'adv-delta-tgl'    },
    'hom':     { key: 'advHomOn',     tgl: 'adv-hom-tgl'      },
    'aom':     { key: 'advAomOn',     tgl: 'adv-aom-tgl'      },
    'tlm':     { key: 'advTlmOn',     tgl: 'adv-tlm-tgl'      },
    'ovTol':   { key: 'advOvTolOn',   tgl: 'adv-ovtol-tgl'    },
    'ovm':     { key: 'advOvmOn',     tgl: 'adv-ovm-tgl'      },
    'unTol':   { key: 'advUnTolOn',   tgl: 'adv-untol-tgl'    },
    'unm':     { key: 'advUnmOn',     tgl: 'adv-unm-tgl'      },
  };
  const m = map[name]; if (!m) return;
  state[m.key] = !state[m.key];
  const btn = document.getElementById(m.tgl);
  if (!btn) return;
  btn.textContent = state[m.key] ? 'ON ' : 'OFF';
  btn.classList.toggle('on', state[m.key]);
}

function toggleBasicSignal(name) {
  const map = {
    'lm':  { key: 'bLmOn',  tgl: 'b-lm-tgl'  },
    'fom': { key: 'bFomOn', tgl: 'b-fom-tgl' },
    'dom': { key: 'bDomOn', tgl: 'b-dom-tgl' },
    'tlm': { key: 'bTlmOn', tgl: 'b-tlm-tgl' },
    'ovm': { key: 'bOvmOn', tgl: 'b-ovm-tgl' },
    'unm': { key: 'bUnmOn', tgl: 'b-unm-tgl' },
  };
  const m = map[name]; if (!m) return;
  state[m.key] = !state[m.key];
  const btn = document.getElementById(m.tgl);
  if (!btn) return;
  btn.textContent = state[m.key] ? 'ON ' : 'OFF';
  btn.classList.toggle('on', state[m.key]);
}

function setAdvTlRange(val) {
  state.advTlRange = val;
  Object.keys(ADV_TL_RANGES).forEach(k => {
    const btn = document.getElementById(`tl-range-${k}`);
    if (btn) btn.classList.toggle('selected', k === val);
  });
}

function setAdvTol(v) {
  const inp = document.getElementById('adv_odds_tol');
  if (inp) inp.value = v;
}

function setBasicTol(v) {
  const inp = document.getElementById('b_odds_tol');
  if (inp) inp.value = v;
}

function setScanOddsSide(side) {
  state.scanOddsSide = side;
  ['FAV', 'DOG', 'BOTH'].forEach(s => {
    const btn = document.getElementById(`scan-odds-side-${s.toLowerCase()}`);
    if (btn) btn.classList.toggle('on', s === side);
  });
}

function setBasicOddsSide(side) {
  state.bOddsSide = side;
  ['FAV', 'DOG', 'BOTH'].forEach(s => {
    const btn = document.getElementById(`b-odds-side-${s.toLowerCase()}`);
    if (btn) btn.classList.toggle('on', s === side);
  });
}

/* ════════════════════════════════════════════════════════════
   LIVE ODDS ESTIMATOR TOGGLE
   ════════════════════════════════════════════════════════════ */
function toggleLive() {
  state.liveOn = !state.liveOn;
  const btn = document.getElementById('live-tgl');
  btn.textContent = state.liveOn ? 'ON ' : 'OFF';
  btn.classList.toggle('on', state.liveOn);
  document.getElementById('live-body').style.display = state.liveOn ? 'block' : 'none';
}

/* ════════════════════════════════════════════════════════════
   MIN N
   ════════════════════════════════════════════════════════════ */
function setMinN(v) {
  document.querySelectorAll('.min-n-input').forEach(el => el.value = v);
}

function getMinN() {
  const activeTab = document.querySelector('.tab-pane.active');
  const el = activeTab ? activeTab.querySelector('.min-n-input') : null;
  const v  = parseInt(el ? el.value : 15, 10);
  return isNaN(v) || v < 1 ? 15 : v;
}

/* ════════════════════════════════════════════════════════════
   URL IMPORT  (asianbetsoccer.com → auto-fill inputs)
   ════════════════════════════════════════════════════════════ */
async function importFromUrl() {
  const input  = document.getElementById('url-import-input');
  const btn    = document.getElementById('url-import-btn');
  const status = document.getElementById('url-import-status');

  const url = (input.value || '').trim();
  if (!url) return;

  btn.disabled    = true;
  btn.textContent = '…';
  status.textContent = 'Fetching…';
  status.className   = 'url-import-status loading';

  try {
    const resp = await fetch('/api/scrape?url=' + encodeURIComponent(url));
    const data = await resp.json();

    if (data.error) {
      status.textContent = '✗ ' + data.error;
      status.className   = 'url-import-status error';
    } else {
      fillFromScraped(data);
      status.textContent = '✓ Imported — check fields and run analysis';
      status.className   = 'url-import-status ok';
    }
  } catch (e) {
    status.textContent = '✗ ' + e.message;
    status.className   = 'url-import-status error';
  } finally {
    btn.disabled    = false;
    btn.textContent = 'Import';
  }
}

function fillFromScraped(data) {
  const set = (id, v) => {
    if (v == null) return;
    const el = document.getElementById(id);
    if (el && !el.readOnly) el.value = Number.isFinite(v) ? v.toFixed(2) : String(v);
  };

  // Basic mode fields (closing values only — no opening in basic mode)
  set('b_ah_hc', data.ah_hc);
  set('b_ho_c',  data.ho_c);
  set('b_ao_c',  data.ao_c);
  set('b_tl_c',  data.tl_c);

  // Advanced mode fields (full opening + closing)
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

  // Auto-set Basic signal selects from computed directions
  const sel = (id, v) => { if (v && v !== 'UNKNOWN') { const el = document.getElementById(id); if (el) el.value = v; } };

  const hc = data.ah_hc;
  if (hc != null) {
    const favSide = hc < -0.01 ? 'HOME' : hc > 0.01 ? 'AWAY'
                  : (data.ho_c != null && data.ao_c != null && data.ho_c <= data.ao_c) ? 'HOME' : 'AWAY';
    const favOc = favSide === 'HOME' ? data.ho_c : data.ao_c;
    const favOo = favSide === 'HOME' ? data.ho_o : data.ao_o;
    const dogOc = favSide === 'HOME' ? data.ao_c : data.ho_c;
    const dogOo = favSide === 'HOME' ? data.ao_o : data.ho_o;

    if (data.ah_ho != null) {
      const diff = Math.abs(hc) - Math.abs(data.ah_ho);
      sel('b_lm_sel', diff > LINE_THRESH ? 'DEEPER' : diff < -LINE_THRESH ? 'SHRANK' : 'STABLE');
    }
    if (favOc != null && favOo != null) sel('b_fom_sel', oddsDir(favOc, favOo));
    if (dogOc != null && dogOo != null) sel('b_dom_sel', oddsDir(dogOc, dogOo));
  }
  if (data.tl_c != null && data.tl_o != null) sel('b_tlm_sel', moveDir(data.tl_c, data.tl_o, TL_THRESH));
  if (data.ov_c != null && data.ov_o != null) sel('b_ovm_sel', oddsDir(data.ov_c, data.ov_o));
  if (data.un_c != null && data.un_o != null) sel('b_unm_sel', oddsDir(data.un_c, data.un_o));

  // Recompute mirrored fields and signal previews for both modes
  mirrorBasic();
  mirrorAdvanced();
  refreshAdvSignals();
}

/* ════════════════════════════════════════════════════════════
   GAME STATE PANEL
   ════════════════════════════════════════════════════════════ */
function setGsTrigger(val) {
  state.gsTrigger = val;
  ['HT', 'FIRST_GOAL', 'INPLAY_2H'].forEach(v => {
    const btn = document.getElementById(`gs-btn-${v}`);
    if (btn) btn.classList.toggle('active', v === val);
  });
  renderGsPanel('gs-panel', val);
}

function setGsaTrigger(val) {
  state.gsaTrigger = val;
  ['HT', 'FIRST_GOAL', 'INPLAY_2H'].forEach(v => {
    const btn = document.getElementById(`gsa-gs-btn-${v}`);
    if (btn) btn.classList.toggle('active', v === val);
  });
  renderGsPanel('gsa-gs-panel', val);
}

function setDGsTrigger(val) {
  state.dGsTrigger = val;
  ['HT', 'FIRST_GOAL', 'INPLAY_2H'].forEach(v => {
    const btn = document.getElementById(`d-gs-btn-${v}`);
    if (btn) btn.classList.toggle('active', v === val);
  });
  renderGsPanel('d-gs-panel', val);
}

function renderGsPanel(panelId, trigger) {
  const panel = document.getElementById(panelId);
  if (!panel) return;
  if (!trigger) trigger = 'HT';
  if (trigger === 'HT') {
    panel.innerHTML = `
      <p style="font-size:11px;color:var(--dim);margin-bottom:8px">HT score (Home – Away)</p>
      <div class="score-row">
        <input class="score-input" id="${panelId}-home" type="text" value="0" maxlength="2">
        <span class="score-sep"> – </span>
        <input class="score-input" id="${panelId}-away" type="text" value="0" maxlength="2">
        <span class="score-label">  HOME – AWAY</span>
      </div>`;
  } else if (trigger === 'FIRST_GOAL') {
    panel.innerHTML = `
      <div class="fg-grid">
        <div>
          <label>WHO SCORED</label>
          <select class="gs-select" id="${panelId}-team">
            <option>HOME</option><option>AWAY</option>
          </select>
        </div>
        <div>
          <label>MINUTE</label>
          <input class="gs-select" id="${panelId}-min" type="text" placeholder="35"
                 style="background:var(--bg2);color:var(--bright)">
        </div>
      </div>`;
  } else { // INPLAY_2H
    panel.innerHTML = `
      <p style="font-size:11px;color:var(--dim);margin-bottom:8px">2H goals scored so far (Home – Away)</p>
      <div class="score-row">
        <input class="score-input" id="${panelId}-home2h" type="text" value="0" maxlength="2">
        <span class="score-sep"> – </span>
        <input class="score-input" id="${panelId}-away2h" type="text" value="0" maxlength="2">
        <span class="score-label">  HOME – AWAY</span>
      </div>`;
  }
}

function getGs(panelId, trigger) {
  const gs = { trigger };
  if (trigger === 'HT') {
    gs.home_goals = document.getElementById(`${panelId}-home`)?.value || '0';
    gs.away_goals = document.getElementById(`${panelId}-away`)?.value || '0';
  } else if (trigger === 'FIRST_GOAL') {
    gs.goal_team = document.getElementById(`${panelId}-team`)?.value || 'HOME';
    gs.minute    = document.getElementById(`${panelId}-min`)?.value  || '35';
  } else {
    gs.home_2h = document.getElementById(`${panelId}-home2h`)?.value || '0';
    gs.away_2h = document.getElementById(`${panelId}-away2h`)?.value || '0';
  }
  return gs;
}

function gsLabel(gs) {
  if (gs.trigger === 'HT')         return `HT ${gs.home_goals || 0}–${gs.away_goals || 0}`;
  if (gs.trigger === 'FIRST_GOAL') return `1st goal ${gs.goal_team} min.${gs.minute}`;
  return `2H in-play ${gs.home_2h || 0}–${gs.away_2h || 0}`;
}

/* ════════════════════════════════════════════════════════════
   RUN MATCH ANALYSIS
   ════════════════════════════════════════════════════════════ */
function runMatch() {
  if (!_db.length) { showError('No database loaded. Please upload CSV files first.'); return; }

  let cfg;

  if (state.filterMode === 'BASIC') {
    cfg = buildBasicCfg();
  } else {
    cfg = buildAdvancedCfg();
  }

  if (!cfg) { showError('Invalid AH line — enter a valid Asian Handicap value.'); return; }

  showLoader();

  const minN = getMinN();

  const _activeDb = getDb();
  const cfgRows = applyConfig(_activeDb, cfg);
  const derivedFavSide = cfg.fav_side !== 'ANY' ? cfg.fav_side : cfg.derived_fav_side;

  const baselineRows_pre = applyBaselineConfig(_activeDb, cfg);
  const blSide_pre = (derivedFavSide && derivedFavSide !== 'ANY')
    ? baselineRows_pre.filter(r => r.fav_side === derivedFavSide) : null;
  const allBets_pre = scoreBets(cfgRows, baselineRows_pre, blSide_pre, minN);
  const bets_pre    = allBets_pre.filter(b => Math.abs(b.z) >= MIN_Z);
  const ftrace_pre  = traceConfig(_activeDb, cfg, null);

  renderMatchResults({
    cfg_n:   cfgRows.length,
    allBets: allBets_pre,
    bets:    bets_pre,
    ftrace:  ftrace_pre,
    min_n:   minN,
    cfg,
    filterMode: state.filterMode,
  });
}

// ── GSA tab entry point ───────────────────────────────────────────────────────
function runGsa() {
  if (!_db.length) { showError('No database loaded. Please upload CSV files first.'); return; }

  showLoader();

  const activeDb = getDb();
  const minN     = getMinN();
  const gs       = getGs('gsa-gs-panel', state.gsaTrigger);

  // ── Scan GSA mode: match was loaded from Live Scan ────────────────────────
  if (_activeScanCfg) {
    const sig = _activeScanCfg._signals;

    // Baseline: AH line + AH closing odds ±tol + TL closing — no movement filter
    const blCfg = {
      ..._activeScanCfg,
      line_move: 'ANY', fav_odds_move: 'ANY', dog_odds_move: 'ANY',
      tl_move:   'ANY', over_move:     'ANY', under_move:    'ANY',
    };

    // Signal: same base + active movement filters (only when the signal is a real move)
    const sigCfg = {
      ..._activeScanCfg,
      line_move:     state.gsaLmOn  && !['STABLE','UNKNOWN'].includes(sig.lineMove)    ? sig.lineMove    : 'ANY',
      fav_odds_move: state.gsaFomOn && !['STABLE','UNKNOWN'].includes(sig.favOddsMove) ? sig.favOddsMove : 'ANY',
      dog_odds_move: state.gsaDomOn && !['STABLE','UNKNOWN'].includes(sig.dogOddsMove) ? sig.dogOddsMove : 'ANY',
      tl_move:       state.gsaTlmOn && !['STABLE','UNKNOWN'].includes(sig.tlMove)      ? sig.tlMove      : 'ANY',
      over_move:     state.gsaOvmOn && !['STABLE','UNKNOWN'].includes(sig.overMove)    ? sig.overMove    : 'ANY',
      under_move:    state.gsaUnmOn && !['STABLE','UNKNOWN'].includes(sig.underMove)   ? sig.underMove   : 'ANY',
    };

    const blRows  = applyConfig(activeDb, blCfg);
    const cfgRows = applyConfig(activeDb, sigCfg);
    const blSide  = blRows.filter(r => r.fav_side === sigCfg.fav_side);

    const probe = (state.gsaTrigger === 'HT')
      ? computeGsProbe(cfgRows, blRows, gs)
      : null;

    _renderScanGsaPanel({ cfgRows, blRows, blSide, minN, probe, gs, sigCfg });
    return;
  }

  // ── Manual mode: BASIC / ADVANCED form inputs ─────────────────────────────
  let cfg;
  if (state.filterMode === 'BASIC') cfg = buildBasicCfg();
  else                               cfg = buildAdvancedCfg();
  if (!cfg) { showError('Invalid AH line — enter a valid Asian Handicap value.'); return; }

  // Strip closing odds tolerance for GSA: HT score already splits the pool
  const gsaCfg = { ...cfg, odds_tolerance: null, fav_oc: null, dog_oc: null, fav_oo: null, dog_oo: null };

  const cfgRows = applyConfig(activeDb, gsaCfg);
  const blRows  = applyBaselineConfig(activeDb, gsaCfg);
  const probe   = (state.gsaTrigger === 'HT') ? computeGsProbe(cfgRows, blRows, gs) : null;

  const right  = document.getElementById('right-panel');
  const ahSide = gsaCfg.fav_side === 'AWAY' ? 'Away' : 'Home';

  try {
    let html = `<h2 class="results-title">HT LIVE VIEW</h2>`;
    html += `<div class="cfg-summary">${ahSide} AH −${gsaCfg.fav_line} · Signal pool: ${cfgRows.length} · Baseline: ${blRows.length}</div>`;
    if (!probe) {
      const gsLbl  = gsLabel(gs);
      const reason = state.gsaTrigger !== 'HT'
        ? 'This view only supports the <b>Half Time</b> trigger.'
        : cfgRows.length < minN ? `Signal pool too small (${cfgRows.length} rows).` : 'No rows match this HT score.';
      html += `<div class="no-bets" style="margin-top:20px"><div class="warn-icon">⚠</div><p>No data for <b>${gsLbl}</b>.<br>${reason}</p></div>`;
    } else {
      html += renderHtLivePanel(probe, gsLabel(gs));
    }
    right.innerHTML = html;
  } catch (err) {
    right.innerHTML = `<div class="no-bets" style="margin-top:20px"><div class="warn-icon">⚠</div><p>Render error: ${err.message}</p></div>`;
  }
}

// ── Scan GSA results panel ───────────────────────────────────────────────────
function _renderScanGsaPanel({ cfgRows, blRows, blSide, minN, probe, gs, sigCfg }) {
  const right  = document.getElementById('right-panel');
  const ahSide = sigCfg.fav_side === 'AWAY' ? 'Away' : 'Home';

  try {
    let html = `<h2 class="results-title">MATCH ANALYSIS</h2>`;
    html += `<div class="cfg-summary">${ahSide} AH −${sigCfg.fav_line} · Signal n=${cfgRows.length} · Baseline n=${blRows.length}</div>`;

    if (probe) {
      // HT entered → show 2H + FT bets only
      if (!probe.sn) {
        html += `<div class="no-bets" style="margin-top:20px"><div class="warn-icon">⚠</div>
          <p>No data for <b>${gsLabel(gs)}</b>.<br>
          ${cfgRows.length < minN ? `Signal pool too small (${cfgRows.length} rows).` : 'No rows match this HT score.'}</p>
        </div>`;
      } else {
        html += renderHtLivePanel(probe, gsLabel(gs));
      }
    } else {
      // No HT → all bets, sorted by delta vs baseline
      const bets = scoreBets(cfgRows, blRows, blSide, minN);
      if (!bets.length) {
        html += `<div class="no-bets"><p>Not enough data — signal pool has ${cfgRows.length} rows (need ≥${minN}).</p></div>`;
      } else {
        const sorted = [...bets].sort((a, b) => b.edge - a.edge);
        html += `<p style="font-size:11px;color:var(--dim);margin-bottom:10px">${bets.length} bets · sorted by Δ vs baseline</p>`;
        html += `<div class="htlive-table">
          <div class="htlive-thead">
            <span class="htlive-th-label">Bet</span>
            <span class="htlive-th-prob">Signal%</span>
            <span class="htlive-th-delta">Δ vs Baseline</span>
            <span class="htlive-th-n">n</span>
          </div>`;
        for (const b of sorted) {
          const dSign = b.edge >= 0 ? '+' : '';
          const tier  = b.edge >= 5 ? 'strong' : b.edge >= 0 ? 'good' : 'weak';
          const nCls  = b.n >= 30 ? 'green' : b.n >= 15 ? 'yellow' : 'red';
          html += `
          <div class="htlive-row htlive-row-${tier}">
            <span class="htlive-col-label">${b.label}</span>
            <span class="htlive-col-prob">${b.p.toFixed(1)}% <span style="color:var(--dim)">bl ${b.bl.toFixed(1)}%</span></span>
            <span class="htlive-col-delta probe-delta ${b.edge >= 0 ? 'pos' : 'neg'}">${dSign}${b.edge.toFixed(1)}pp</span>
            <span class="htlive-col-n probe-conf ${nCls}">${b.n}</span>
          </div>`;
        }
        html += `</div>`;
      }
    }

    right.innerHTML = html;
  } catch (err) {
    right.innerHTML = `<div class="no-bets"><div class="warn-icon">⚠</div><p>Render error: ${err.message}</p></div>`;
  }
}

/* Build cfg from BASIC mode inputs */
function buildBasicCfg() {
  const hcRaw = document.getElementById('b_ah_hc').value;
  const hc    = sf(hcRaw);
  if (hc === null) return null;

  const favLc   = Math.abs(hc);
  const favLine = VALID_LINES.find(v => Math.abs(favLc - v) < 0.13);
  if (favLine === undefined) return null;

  const favOc  = sf(document.getElementById('b_ho_c').value);
  const dogOc  = sf(document.getElementById('b_ao_c').value);
  const tlcRaw = document.getElementById('b_tl_c').value;
  const basicTlC = sf(tlcRaw);
  const basicTolRaw = document.getElementById('b_odds_tol').value;
  const basicTol = sf(basicTolRaw) ?? 0;

  // Determine fav_side: fav gives handicap; at 0 line use closing odds (lower = fav)
  let favSide = 'HOME';
  if      (hc > 0.01)                                    favSide = 'AWAY';
  else if (Math.abs(hc) <= 0.01 && favOc !== null && dogOc !== null)
                                                         favSide = favOc <= dogOc ? 'HOME' : 'AWAY';

  // Remap fav/dog according to side
  let favOcVal = favOc, dogOcVal = dogOc;
  if (favSide === 'AWAY') { favOcVal = dogOc; dogOcVal = favOc; }

  // Read signal dropdowns if their toggle is ON
  const lineMove    = state.bLmOn  ? document.getElementById('b_lm_sel').value  : 'ANY';
  const favOddsMove = state.bFomOn ? document.getElementById('b_fom_sel').value : 'ANY';
  const dogOddsMove = state.bDomOn ? document.getElementById('b_dom_sel').value : 'ANY';
  const tlMove      = state.bTlmOn ? document.getElementById('b_tlm_sel').value : 'ANY';
  const overMove    = state.bOvmOn ? document.getElementById('b_ovm_sel').value : 'ANY';
  const underMove   = state.bUnmOn ? document.getElementById('b_unm_sel').value : 'ANY';

  return {
    fav_line:         favLine.toFixed(2),
    fav_side:         favSide,
    derived_fav_side: favSide,
    line_move:        lineMove,
    fav_odds_move:    favOddsMove,
    dog_odds_move:    dogOddsMove,
    over_move:        overMove,
    under_move:       underMove,
    tl_c:             basicTlC,
    tl_range:         null,
    tl_cluster:       null,
    tl_move:          tlMove,
    tl_max:         null,
    odds_tolerance: basicTol,
    fav_oc:         state.bOddsSide !== 'DOG'  ? (favSide === 'HOME' ? favOc : dogOc) : null,
    fav_oo:         null,
    dog_oc:         state.bOddsSide !== 'FAV'  ? (favSide === 'HOME' ? dogOc : favOc) : null,
    dog_oo:         null,
    ov_c:           null,
    ov_tol:         null,
    un_c:           null,
    un_tol:         null,
  };
}

/* Build cfg from ADVANCED mode inputs */
function buildAdvancedCfg() {
  const hcRaw = document.getElementById('ah_hc').value;
  const hoRaw = document.getElementById('ah_ho').value;
  const hc    = sf(hcRaw);
  if (hc === null) return null;

  const favLc   = Math.abs(hc);
  const favLine = VALID_LINES.find(v => Math.abs(favLc - v) < 0.13);
  if (favLine === undefined) return null;

  // AH odds: map home/away to fav/dog
  const hoc = sf(document.getElementById('ho_c').value);
  const hoo = sf(document.getElementById('ho_o').value);
  const aoc = sf(document.getElementById('ao_c').value);
  const aoo = sf(document.getElementById('ao_o').value);
  // Determine fav_side: fav gives handicap; at 0 line use closing odds (lower = fav)
  let favSide;
  if      (hc < -0.01)                               favSide = 'HOME';
  else if (hc >  0.01)                               favSide = 'AWAY';
  else if (hoc !== null && aoc !== null)              favSide = hoc <= aoc ? 'HOME' : 'AWAY';
  else                                               favSide = 'HOME';
  const favOc = favSide === 'HOME' ? hoc : aoc;
  const favOo = favSide === 'HOME' ? hoo : aoo;
  const dogOc = favSide === 'HOME' ? aoc : hoc;
  const dogOo = favSide === 'HOME' ? aoo : hoo;

  // Line movement
  const ho    = sf(hoRaw);
  const favLo = ho !== null ? Math.abs(ho) : null;
  let lineMove = 'UNKNOWN';
  if (favLo !== null) {
    const diff = favLc - favLo;
    lineMove = diff > LINE_THRESH ? 'DEEPER' : diff < -LINE_THRESH ? 'SHRANK' : 'STABLE';
  }

  // Home/away odds movement signals (as engine values)
  const homMoveEngine = oddsDir(hoc, hoo); // home in engine terms
  const aomMoveEngine = oddsDir(aoc, aoo);
  // Map to fav/dog
  const favOddsMove = favSide === 'HOME' ? homMoveEngine : aomMoveEngine;
  const dogOddsMove = favSide === 'HOME' ? aomMoveEngine : homMoveEngine;

  // Over/under
  const ovc = sf(document.getElementById('ov_c').value);
  const ovo = sf(document.getElementById('ov_o').value);
  const unc = sf(document.getElementById('un_c').value);
  const uno = sf(document.getElementById('un_o').value);
  const overMove  = oddsDir(ovc, ovo);
  const underMove = oddsDir(unc, uno);

  // TL
  const tlc = sf(document.getElementById('tl_c').value);
  const tlo = sf(document.getElementById('tl_o').value);
  const tlMove = moveDir(tlc, tlo, TL_THRESH);

  // Odds tolerance
  const advOddsToRaw = document.getElementById('adv_odds_tol').value;
  const advOddsToVal = sf(advOddsToRaw);

  // Odds delta
  const oddsDeltaRaw = document.getElementById('adv_odds_delta').value;
  const oddsDeltaVal = sf(oddsDeltaRaw);

  // Over/Under tolerance
  const ovTolRaw = document.getElementById('adv_ov_tol').value;
  const ovTolVal = sf(ovTolRaw);
  const unTolRaw = document.getElementById('adv_un_tol').value;
  const unTolVal = sf(unTolRaw);

  return {
    fav_line:           favLine.toFixed(2),
    fav_lo:             favLo,
    fav_side:           favSide,
    line_move:          state.advLmOn        ? lineMove      : 'ANY',
    fav_odds_move:      state.advHomOn       ? favOddsMove   : 'ANY',
    fav_odds_min_delta: state.advOddsDeltaOn ? oddsDeltaVal  : null,
    dog_odds_move:  state.advAomOn     ? dogOddsMove : 'ANY',
    over_move:      state.advOvmOn     ? overMove    : 'ANY',
    under_move:     state.advUnmOn     ? underMove   : 'ANY',
    tl_range:       null,
    tl_c:           tlc != null ? tlc.toFixed(2) : null,
    tl_cluster:     null,
    tl_move:        state.advTlmOn     ? tlMove      : 'ANY',
    tl_max:         null,
    odds_tolerance: state.advOddsTolOn ? advOddsToVal : null,
    fav_oc:         favOc,
    fav_oo:         favOo,
    dog_oc:         dogOc,
    dog_oo:         dogOo,
    ov_c:           state.advOvTolOn ? ovc : null,
    ov_tol:         state.advOvTolOn ? ovTolVal : null,
    un_c:           state.advUnTolOn ? unc : null,
    un_tol:         state.advUnTolOn ? unTolVal : null,
  };
}

/* ════════════════════════════════════════════════════════════
   RUN CONFIG DISCOVERY
   ════════════════════════════════════════════════════════════ */
function runDisc() {
  if (!_db.length) { showError('No database loaded. Please upload CSV files first.'); return; }

  showLoader();

  const favLine  = document.getElementById('disc-line').value;
  const favSide  = document.getElementById('disc-side').value;
  const tlRaw    = document.getElementById('disc-tl').value;
  const lineMoveI = document.getElementById('disc-lm').value;
  const tlMoveI   = document.getElementById('disc-tlm').value;
  const gs        = getGs('d-gs-panel', state.dGsTrigger);
  const minN      = getMinN();

  // Diagnostic check for TL data
  let diagMsg = null;
  if (tlRaw && tlRaw !== 'ANY') {
    const totalWithTl = getDb().filter(r => r.tl_c != null).length;
    if (totalWithTl === 0) {
      diagMsg = 'No Total Line data found in the loaded CSV files. Your CSVs must include a "Total Line Closing" column for TL filtering.';
    } else {
      let tlN;
      if (TL_CLUSTERS[tlRaw]) {
        const [lo, hi] = TL_CLUSTERS[tlRaw];
        tlN = getDb().filter(r => r.tl_c != null && (lo == null || r.tl_c >= lo) && (hi == null || r.tl_c < hi)).length;
      } else {
        const tlv = parseFloat(tlRaw);
        tlN = isNaN(tlv) ? 0 : getDb().filter(r => r.tl_c != null && Math.abs(r.tl_c - tlv) < 0.13).length;
      }
      if (tlN < minN) diagMsg = `TL filter "${tlRaw}" matches only ${tlN} records (minimum is ${minN}). Try a broader range.`;
    }
  }

  // Yield to browser so loader renders before heavy computation
  setTimeout(() => {
    try {
      const results = discover(getDb(), favLine, favSide, lineMoveI, tlMoveI, gs, minN, tlRaw);
      renderDiscResults({ results, diag_msg: diagMsg });
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

function renderBayesianScore(results, n, signals, ctx) {
  const DIM_LABELS = { lm: 'LM', om: 'OM', tlm: 'TLM', ovm: 'OVM', ht: 'HT' };
  const ALL_DIMS   = ['lm', 'om', 'tlm', 'ovm', 'ht'];

  // Signal badges
  const badgesHtml = ALL_DIMS.map(dim => {
    const val = signals[dim];
    if (val == null) {
      return `<span class="bayes-badge dim-off">${DIM_LABELS[dim]}: —</span>`;
    }
    const uiVal = { IN: 'STEAM', OUT: 'DRIFT' }[val] || val;
    return `<span class="bayes-badge">${DIM_LABELS[dim]}: ${uiVal}</span>`;
  }).join('');

  // Context line
  const lineLabel = ctx.favLine != null ? `AH ${ctx.favLine}` : '';
  const sideLabel = ctx.favSide ? ` · Fav: ${ctx.favSide}` : '';
  const tlLabel   = ctx.tlc    != null ? ` · TL ≈ ${parseFloat(ctx.tlc).toFixed(2)}` : '';
  const ctxLine   = `${lineLabel}${sideLabel}${tlLabel} · n = ${n}`;

  // Table rows
  const rowsHtml = results.map(r => {
    const rowCls   = r.unreliable ? 'bayes-row-dim'
                   : r.delta > 3  ? 'bayes-row-pos'
                   : r.delta < -3 ? 'bayes-row-neg'
                   : '';
    const sign     = r.delta >= 0 ? '+' : '';
    const deltaCls = r.delta >= 0 ? 'bayes-delta-pos' : 'bayes-delta-neg';
    const arrow    = r.delta >= 0 ? '▲' : '▼';
    const warnIcon = r.unreliable ? ' ⚠' : '';
    return `<tr class="${rowCls}">
      <td><span class="bayes-label">${r.label}${warnIcon}</span><span class="bayes-minodds">${minOdds(r.posterior)}</span></td>
      <td class="bayes-pct">${r.baseline.toFixed(1)}%</td>
      <td>→</td>
      <td class="bayes-pct">${r.posterior.toFixed(1)}%</td>
      <td class="${deltaCls}">${arrow} ${sign}${r.delta.toFixed(1)}pp</td>
      <td class="bayes-n">${r.poolN}</td>
    </tr>`;
  }).join('');

  const html = `
    <div style="padding:16px">
      <div style="font-size:14px;font-weight:700;color:var(--bright);margin-bottom:8px">
        BAYESIAN SCORE
      </div>
      <div class="bayes-header">${ctxLine}</div>
      <div class="bayes-badges">${badgesHtml}</div>
      <table class="bayes-table">
        <thead>
          <tr>
            <th>Bet</th>
            <th>Baseline</th>
            <th></th>
            <th>Posterior</th>
            <th>Shift</th>
            <th>n</th>
          </tr>
        </thead>
        <tbody>${rowsHtml}</tbody>
      </table>
      <p style="font-size:10px;color:var(--dim);margin-top:10px">
        ⚠ = LR cell &lt; ${DEFAULT_MIN_N} rows — treat with caution
      </p>
    </div>`;

  // Append below whatever is already in the panel (e.g. BET DASHBOARD from runMatch)
  const rp = document.getElementById('right-panel');
  if (rp.querySelector('.results-title')) {
    rp.innerHTML += html;  // bet dashboard already rendered — append Bayes below
  } else {
    rp.innerHTML = html;   // standalone render
  }
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

/* ════════════════════════════════════════════════════════════
   FT CONTEXT
   ════════════════════════════════════════════════════════════ */
function renderFtContext(ftDist, n) {
  if (!ftDist) return '';

  function delta(p, bl) {
    const d = p - bl;
    if (Math.abs(d) < 1) return '';
    const sign = d >= 0 ? '+' : '';
    const cls  = d >= 3 ? 'ftc-up' : d <= -3 ? 'ftc-down' : 'ftc-nudge';
    return `<span class="${cls}"> ${sign}${d.toFixed(0)}pp</span>`;
  }

  function cell(data, label) {
    return `<div class="ftc-cell">
      <div class="ftc-pct">${data.p.toFixed(0)}%${delta(data.p, data.bl)}</div>
      <div class="ftc-lbl">${label}</div>
      <div class="ftc-bl">bl ${data.bl.toFixed(0)}%</div>
      <div class="ftc-mo">min odds ${minOdds(data.p)}</div>
    </div>`;
  }

  function goalCard(label, data) {
    return `<div class="ftc-cell ftc-sm">
      <div class="ftc-pct">${data.p.toFixed(0)}%${delta(data.p, data.bl)}</div>
      <div class="ftc-lbl">${label}</div>
      <div class="ftc-bl">bl ${data.bl.toFixed(0)}%</div>
      <div class="ftc-mo">min ${minOdds(data.p)}</div>
    </div>`;
  }

  const { favWins, draw, dogWins, over15, over25, over35, btts, under25 } = ftDist;

  return `<div class="ft-context">
    <div class="ftc-hdr" onclick="this.nextElementSibling.classList.toggle('open'); this.querySelector('.ftc-toggle').textContent = this.nextElementSibling.classList.contains('open') ? '▼' : '▶'">
      <span class="ftc-toggle">▼</span>
      <span class="ftc-title">FT RESULT CONTEXT</span>
      <span class="ftc-n">n=${n} matches · delta vs baseline</span>
    </div>
    <div class="ftc-body open">
      <div class="ftc-3way">
        ${cell(favWins, 'Fav Wins FT')}
        ${cell(draw,    'Draw FT')}
        ${cell(dogWins, 'Dog Wins FT')}
      </div>
      <div class="ftc-totals">
        ${goalCard('Over 1.5', over15)}
        ${goalCard('Over 2.5', over25)}
        ${goalCard('Over 3.5', over35)}
        ${goalCard('BTTS', btts)}
        ${goalCard('Under 2.5', under25)}
      </div>
    </div>
  </div>`;
}

/* ════════════════════════════════════════════════════════════
   RENDER MATCH RESULTS
   ════════════════════════════════════════════════════════════ */
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
  const lowN     = minN != null && bet.n < minN;
  const edgeSign = bet.edge >= 0 ? '+' : '';
  const edgeCls  = bet.edge >= 0 ? 'pos' : 'neg';
  const nColor   = bet.n >= 50 ? 'var(--green)' : 'var(--yellow)';
  const fill     = Math.min(100, Math.max(0, bet.p));
  const bColor   = barColor(bet.p, bet.bl);
  const passCls  = (passes && !lowN) ? '' : 'col-weak';

  const hasLive  = bet.live && bet.live.live_p != null && bet.live.live_p > 0 && bet.live.live_p < 100;
  const moRange  = hasLive
    ? `<b>${bet.live.fair_odd.toFixed(2)}</b> <span class="mo-range-sep">live</span>`
    : `<b>${bet.mo}</b><span class="mo-range-sep"> – </span><b>${bet.mo_mid}</b>`;
  const moLabel  = hasLive ? 'LIVE ODDS' : 'ODDS RANGE';
  const moFloor  = hasLive ? `hist. range ${bet.mo} – ${bet.mo_mid}` : `floor: ${bet.mo_lo}`;

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

  return `<div class="bet-col ${passCls}">
    <div class="col-hdr">
      <span class="col-title">${title}</span>
      <span class="col-sub">${subtitle}</span>
      ${lowN ? '<span class="col-badge-lown">⚠ low n</span>' : passes ? '<span class="col-badge-pass">✓</span>' : '<span class="col-badge-weak">z&lt;1.5</span>'}
    </div>
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
    <div class="col-min-odds">
      <span class="col-min-odds-label">${moLabel}</span>
      <span class="col-min-odds-value">${moRange}</span>
      <span class="col-min-odds-floor">${moFloor}</span>
    </div>
    ${matchesHtml}
  </div>`;
}

function renderMergedBetCard(merged, rank, label) {
  const { pre, gs, prePass, gsPass } = merged;
  const anchor = (gsPass && gs) ? gs : pre;
  const tier = tierClass(anchor.z);
  const tl   = tierLabel(tier);

  const preColHtml = buildBetCol(pre, prePass, 'PRE-MATCH', 'no score filter', rank, 'pre', merged.minN);
  const gsColHtml  = buildBetCol(gs,  gsPass,  'IN-PLAY',   label,             rank, 'gs',  merged.minN);

  let liveHtml = '';
  const liveBet = gs?.live ? gs : (pre?.live ? pre : null);
  if (liveBet?.live) {
    const live = liveBet.live;
    if (live.live_p === null) {
      liveHtml = `<div class="live-ft-note">LIVE: ${live.note}</div>`;
    } else if (live.live_p === 100) {
      liveHtml = `<div class="live-odds-strip"><span class="live-odds-label">LIVE</span><span class="live-odds-hit">✓ Already hit</span><span class="live-odds-note">${live.note}</span></div>`;
    } else if (live.live_p === 0) {
      liveHtml = `<div class="live-odds-strip"><span class="live-odds-label">LIVE</span><span class="live-odds-bust">✗ Busted</span><span class="live-odds-note">${live.note}</span></div>`;
    } else {
      liveHtml = `<div class="live-odds-strip"><span class="live-odds-label">LIVE</span><span class="live-odds-p">${live.live_p.toFixed(1)}%</span><span class="live-odds-fair">fair: ${live.fair_odd.toFixed(2)}</span><span class="live-odds-note">${live.note}</span></div>`;
    }
  }

  return `<div class="bet-card tier-${tier}">
    <div class="bet-stripe">
      <span class="tier-label">BET #${rank}  ·  ${tl}</span>
      <div class="badges">
        ${prePass ? '<span class="badge-scenario-pass">PRE ✓</span>' : '<span class="badge-scenario-miss">PRE —</span>'}
        ${gsPass  ? '<span class="badge-scenario-pass">GS ✓</span>'  : '<span class="badge-scenario-miss">GS —</span>'}
      </div>
    </div>
    <div class="bet-merged-header">
      <h3>${anchor.label}</h3>
      <div class="market">${anchor.market}</div>
    </div>
    <div class="bet-scenarios">
      ${preColHtml}
      ${gsColHtml}
    </div>
    ${liveHtml}
  </div>`;
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
    let groupBestZ = -99;
    let groupHasPass = false;
    for (const k of group.keys) {
      const def = betDefMap.get(k);
      if (!def) continue;
      const pre = preMap.get(k) || null;
      const gs  = gsMap.get(k)  || null;
      const bestZ   = Math.max(pre?.z ?? -99, gs?.z ?? -99);
      if (bestZ > groupBestZ) groupBestZ = bestZ;
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
    html += `<details class="bd-group">
      <summary class="bd-group-hdr">${badge}${group.label}<span class="bd-group-arrow">▸</span></summary>
      <div class="bd-group-body">${rowsHtml}</div>
    </details>`;
  }
  html += '</div>';
  return html;
}

// ── GSA Probe panel ───────────────────────────────────────────────────────────
function renderGsProbePanel(probe, stateLabel) {
  if (!probe || !probe.outcomes) return '';
  const { sn, tn, outcomes } = probe;

  const confBadge = sn >= 30 ? `<span class="probe-conf green">n=${sn}</span>`
                  : sn >= 15 ? `<span class="probe-conf yellow">n=${sn} ⚠</span>`
                  :             `<span class="probe-conf red">n=${sn} ⚠⚠</span>`;

  // Tier: strong (green) / good (blue) / weak (dim) / avoid (red)
  function cardTier(r) {
    if (r.delta <= -3)                                    return 'avoid';
    if (r.delta >= 5 && r.sp >= 55 && r.sn >= 20)        return 'strong';
    if (r.delta >= 3 && r.sp >= 40 && r.sn >= 15)        return 'good';
    return 'weak';
  }

  let html = `
  <div class="section-label" style="margin-top:20px">GSA PROBABILITY PROBE</div>
  <p style="font-size:11px;color:var(--dim);margin-bottom:12px">
    ${stateLabel} · Signal pool ${confBadge} · State-only n=${tn}
    · <span style="color:var(--green)">Green</span> = strong edge
    · <span style="color:var(--blue)">Blue</span> = moderate
    · <span style="color:var(--red)">Red</span> = avoid
  </p>`;

  const groups = [...new Set(outcomes.map(r => r.group))];
  for (const grp of groups) {
    const rows = outcomes.filter(r => r.group === grp);
    html += `<div class="probe-group-label">${grp} bets</div><div class="probe-cards">`;
    for (const r of rows) {
      const tier    = cardTier(r);
      const dSign   = r.delta >= 0 ? '+' : '';
      const fair    = r.fairOdds  ? r.fairOdds.toFixed(2)  : '—';
      const cons    = r.consOdds  ? r.consOdds.toFixed(2)  : '—';
      const soOdds  = r.stateOdds ? r.stateOdds.toFixed(2) : '—';
      const lowN    = r.sn < 15   ? ' probe-card-lown' : '';
      const nCls    = r.sn >= 30  ? 'green' : r.sn >= 15 ? 'yellow' : 'red';

      html += `
      <div class="probe-card probe-card-${tier}${lowN}">
        <div class="pcard-top">
          <span class="pcard-label">${r.label}</span>
          <span class="pcard-n probe-conf ${nCls}">n=${r.sn}</span>
        </div>
        <div class="pcard-prob">${r.sp.toFixed(1)}<span class="pcard-pct">%</span></div>
        <div class="pcard-delta probe-delta ${tier === 'avoid' ? 'neg' : tier === 'weak' ? '' : 'pos'}">
          ${dSign}${r.delta.toFixed(1)}pp vs ${r.tp.toFixed(1)}%
        </div>
        <div class="pcard-footer">
          <div class="pcard-odds-block">
            <span class="pcard-odds-label">Fair</span>
            <span class="pcard-odds-fair">${fair}</span>
          </div>
          <div class="pcard-sep"></div>
          <div class="pcard-odds-block">
            <span class="pcard-odds-label">Cons.</span>
            <span class="pcard-odds-cons">${cons}</span>
          </div>
          <div class="pcard-sep"></div>
          <div class="pcard-odds-block">
            <span class="pcard-odds-label">State</span>
            <span class="pcard-odds-state">${soOdds}</span>
          </div>
        </div>
      </div>`;
    }
    html += `</div>`;
  }

  return html;
}

// ── HT Live Panel ─────────────────────────────────────────────────────────
// Replaces the generic GSA probe for the HT trigger.
// Designed for live use at half-time: shows only bets where the signal+HT
// pool beats the state-only baseline, sorted by conservative odds ascending
// (most achievable markets first). The "MIN ODDS" column is the Wilson
// lower-bound threshold — any soft book offering above it is +EV.
function renderHtLivePanel(probe, stateLabel) {
  if (!probe || !probe.outcomes) return '';
  const { sn, tn, outcomes } = probe;

  const confCls = sn >= 30 ? 'green' : sn >= 15 ? 'yellow' : 'red';
  const confBadge = `<span class="probe-conf ${confCls}">n=${sn}</span>`;

  const reliabilityNote = sn >= 50 ? 'High confidence'
    : sn >= 30 ? 'Moderate confidence'
    : sn >= 15 ? 'Low confidence — treat as indicative'
    : 'Very low confidence — unreliable';

  // Only bets where signal+HT pool is better than state-only, and consOdds available
  const positive = outcomes.filter(r => r.delta > 0 && r.consOdds != null);
  const skipped  = outcomes.length - positive.length;

  let html = `
  <div class="htlive-header">
    <div class="htlive-title">HT LIVE — ${stateLabel}</div>
    <div class="htlive-meta">
      Signal pool ${confBadge} · State-only n=${tn} ·
      <span class="htlive-reliability ${confCls}">${reliabilityNote}</span>
    </div>
    <div class="htlive-legend">
      MIN ODDS = conservative threshold (Wilson 95% CI lower bound) — bet only above this ·
      Fair = raw hit-rate odds
    </div>
  </div>`;

  if (!positive.length) {
    return html + `<div class="no-bets" style="margin-top:16px">
      <p>No bets improve on the state-only baseline at this HT score.<br>
      <span style="color:var(--dim)">Try a looser configuration or check a different HT score.</span></p>
    </div>`;
  }

  function rowTier(r) {
    if (r.delta >= 8 && r.sn >= 20) return 'strong';
    if (r.delta >= 4 && r.sn >= 15) return 'good';
    return 'weak';
  }

  const groups = [...new Set(positive.map(r => r.group))];

  for (const grp of groups) {
    const rows = positive
      .filter(r => r.group === grp)
      .sort((a, b) => a.consOdds - b.consOdds); // ascending = most achievable first

    html += `<div class="probe-group-label">${grp}</div>
    <div class="htlive-table">
      <div class="htlive-thead">
        <span class="htlive-th-label">Bet</span>
        <span class="htlive-th-prob">Hit%</span>
        <span class="htlive-th-delta">vs Baseline</span>
        <span class="htlive-th-minodds">MIN ODDS</span>
        <span class="htlive-th-fair">Fair</span>
        <span class="htlive-th-n">n</span>
      </div>`;

    for (const r of rows) {
      const tier  = rowTier(r);
      const nCls  = r.sn >= 30 ? 'green' : r.sn >= 15 ? 'yellow' : 'red';
      const dSign = r.delta >= 0 ? '+' : '';
      const fair  = r.fairOdds ? r.fairOdds.toFixed(2) : '—';
      const cons  = r.consOdds.toFixed(2);

      html += `
      <div class="htlive-row htlive-row-${tier}">
        <span class="htlive-col-label">${r.label}</span>
        <span class="htlive-col-prob">${r.sp.toFixed(1)}%</span>
        <span class="htlive-col-delta probe-delta pos">${dSign}${r.delta.toFixed(1)}pp</span>
        <span class="htlive-col-minodds htlive-minodds-${tier}">${cons}</span>
        <span class="htlive-col-fair">${fair}</span>
        <span class="htlive-col-n probe-conf ${nCls}">${r.sn}</span>
      </div>`;
    }
    html += `</div>`;
  }

  if (skipped > 0) {
    html += `<div class="htlive-skipped">${skipped} bet${skipped > 1 ? 's' : ''} hidden — no improvement vs state baseline</div>`;
  }

  return html;
}

function renderMatchResults({ cfg_n, allBets, bets, ftrace, min_n, cfg, filterMode }) {
  const right = document.getElementById('right-panel');

  const ahSide = cfg && cfg.fav_side === 'AWAY' ? 'Away' : 'Home';
  const cfgSummary = cfg
    ? `<div class="cfg-summary">${ahSide} AH −${cfg.fav_line} · ${cfg_n} matching records</div>`
    : '';

  const preMap  = new Map(allBets.map(b => [b.k, b]));
  const qualPre = bets.filter(b => b.edge > 0).length;

  let html = `<h2 class="results-title">BET DASHBOARD</h2>${cfgSummary}`;

  html += buildTraceHtml(ftrace, 'FILTER TRACE');

  if (filterMode === 'BASIC') {
    const anySignalOn = state.bLmOn || state.bFomOn || state.bDomOn || state.bTlmOn || state.bOvmOn || state.bUnmOn;
    if (!anySignalOn) {
      html += `<div class="basic-mode-notice">
        ⚠ Basic mode — no movement signals active. Results reflect the AH line only.
        Activate signal groups for meaningful edge detection.
      </div>`;
    }
  }

  // All bets dashboard (color-coded by tier)
  html += renderBetDashboard(preMap, new Map());

  // Qualifying bets — full detail cards
  if (bets.length > 0) {
    const sorted = [...bets].sort((a, b) => b.z - a.z);
    html += `<div class="section-label" style="margin-top:18px">QUALIFYING BETS</div>`;
    html += `<p style="font-size:11px;color:var(--dim);margin-bottom:10px">${sorted.length} bet${sorted.length !== 1 ? 's' : ''} · z ≥ ${MIN_Z} · sorted by strength</p>`;
    for (let i = 0; i < sorted.length; i++) html += renderBetCard(sorted[i], i + 1);
  }

  // Value hunt (positive edge but z < MIN_Z)
  const vhBets = allBets.filter(b => Math.abs(b.z) < MIN_Z && b.edge > 0 && b.n >= min_n);
  if (vhBets.length) html += renderValueHuntSection(vhBets);

  right.innerHTML = html;
}

function renderBetCard(bet, rank) {
  const tier    = tierClass(bet.z);
  const tl      = tierLabel(tier);
  const edgeSign = bet.edge >= 0 ? '+' : '';
  const edgeCls  = bet.edge >= 0 ? 'pos' : 'neg';
  const nColor   = bet.n >= 50 ? 'var(--green)' : 'var(--yellow)';
  const fill     = Math.min(100, Math.max(0, bet.p));
  const bColor   = barColor(bet.p, bet.bl);

  let matchesHtml = '';
  if (bet.matches && bet.matches.length) {
    const nHit = bet.matches.filter(m => m.hit).length;
    const uid  = `matches-${rank}`;
    const rows = bet.matches.map(m => {
      const favHt = m.ht[0], dogHt = m.ht[1];
      const favFt = m.ft[0], dogFt = m.ft[1];
      const htHome = m.fav_side === 'HOME' ? favHt : dogHt;
      const htAway = m.fav_side === 'HOME' ? dogHt : favHt;
      const ftHome = m.fav_side === 'HOME' ? favFt : dogFt;
      const ftAway = m.fav_side === 'HOME' ? dogFt : favFt;
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

  let liveHtml = '';
  if (bet.live) {
    if (bet.live.live_p === null) {
      liveHtml = `<div class="live-ft-note">LIVE: ${bet.live.note}</div>`;
    } else if (bet.live.live_p === 100) {
      liveHtml = `<div class="live-odds-strip">
        <span class="live-odds-label">LIVE</span>
        <span class="live-odds-hit">✓ Already hit</span>
        <span class="live-odds-note">${bet.live.note}</span>
      </div>`;
    } else if (bet.live.live_p === 0) {
      liveHtml = `<div class="live-odds-strip">
        <span class="live-odds-label">LIVE</span>
        <span class="live-odds-bust">✗ Busted</span>
        <span class="live-odds-note">${bet.live.note}</span>
      </div>`;
    } else {
      liveHtml = `<div class="live-odds-strip">
        <span class="live-odds-label">LIVE</span>
        <span class="live-odds-p">${bet.live.live_p.toFixed(1)}%</span>
        <span class="live-odds-fair">fair: ${bet.live.fair_odd.toFixed(2)}</span>
        <span class="live-odds-note">${bet.live.note}</span>
      </div>`;
    }
  }

  return `<div class="bet-card tier-${tier}">
    <div class="bet-stripe">
      <span class="tier-label">BET #${rank}  ·  ${tl}</span>
      <div class="badges">
        <span class="badge-n" style="color:${nColor}">n=${bet.n}</span>
        <span class="badge-z">z=${bet.z.toFixed(2)}</span>
      </div>
    </div>
    <div class="bet-body">
      <div class="bet-left">
        <h3>${bet.label}</h3>
        <div class="market">${bet.market}</div>
        <div class="prob-row">
          <span class="prob-pct">${bet.p.toFixed(1)}%</span>
          <span class="prob-edge ${edgeCls}">${edgeSign}${bet.edge.toFixed(1)}pp vs baseline</span>
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width:${fill}%;background:${bColor}"></div>
        </div>
        <div class="bet-ci">baseline ${bet.bl.toFixed(1)}%  ·  CI [${bet.lo}%–${bet.hi}%]</div>
        ${matchesHtml}
      </div>
      <div class="bet-right">
        <div class="mo-label">${moLabel}</div>
        <div class="mo-value">${moRange}</div>
        <div class="mo-sub">fair value → conservative</div>
        <div class="mo-lo-ref">${moFloor}</div>
      </div>
    </div>
    ${liveHtml}
  </div>`;
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
        <div class="mo-label">ODDS RANGE</div>
        <div class="vh-mo-value"><b>${bet.mo}</b><span class="mo-range-sep"> – </span><b>${bet.mo_mid}</b></div>
        <div class="mo-sub">fair value → conservative</div>
        <div class="mo-lo-ref">floor: ${bet.mo_lo}</div>
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
   RENDER DISCOVERY RESULTS
   ════════════════════════════════════════════════════════════ */
function renderDiscResults(data) {
  const { results, diag_msg } = data;
  const right = document.getElementById('right-panel');

  let html = `<h2 class="results-title">BEST CONFIGURATIONS</h2>`;

  if (diag_msg) {
    html += `<div class="no-bets"><div class="warn-icon">⚠️</div><p>${diag_msg}</p></div>`;
  }

  if (!results || !results.length) {
    if (!diag_msg) {
      html += `<div class="no-bets"><div class="warn-icon">⚠️</div>
        <p>No significant configurations found.<br>
        Try a different game state or a broader AH line selection.</p></div>`;
    }
    right.innerHTML = html;
    return;
  }

  html += `<p style="font-size:11px;color:var(--dim);margin-bottom:10px">Top ${results.length} configurations ranked by z-score</p>`;

  for (let i = 0; i < results.length; i++) {
    const r    = results[i];
    const tier = tierClass(r.z);
    const c    = r.cfg;
    const ahSide = c.fav_side === 'AWAY' ? 'Away' : 'Home';
    let cfgStr = `${ahSide} AH −${c.fav_line}  ·  Line: ${c.line_move}  ·  FavOdds: ${c.fav_odds_move}  ·  DogOdds: ${c.dog_odds_move}`;
    if (c.over_move && c.over_move !== 'ANY') cfgStr += `  ·  OverOdds: ${c.over_move}`;
    if (c.tl_move   && c.tl_move   !== 'ANY') cfgStr += `  ·  TLMove: ${c.tl_move}`;

    html += `<div class="disc-card tier-${tier}">
      <div class="disc-left">
        <h3>#${i + 1}  ${r.label}</h3>
        <div class="market">${r.market}</div>
        <div class="disc-cfg">${cfgStr}</div>
        <div class="disc-stats">n=${r.n}  ·  baseline ${r.bl.toFixed(1)}%  ·  edge +${r.edge.toFixed(1)}pp  ·  z=${r.z.toFixed(2)}</div>
      </div>
      <div class="disc-right">
        <div class="dp">${r.p.toFixed(1)}%</div>
        <div class="dl">ODDS RANGE</div>
        <div class="dm">${r.mo}<span class="mo-range-sep"> – </span>${r.mo_mid}</div>
      </div>
    </div>`;
  }

  right.innerHTML = html;
}

/* ════════════════════════════════════════════════════════════
   LIVE SCAN — batch match processing
   ════════════════════════════════════════════════════════════ */

function buildCfgFromMatchData(data) {
  const hc = data.ah_hc != null ? data.ah_hc : null;
  if (hc === null) return null;
  const favLc   = Math.abs(hc);
  const favLine = VALID_LINES.find(v => Math.abs(favLc - v) < 0.13);
  if (favLine === undefined) return null;

  const favSide = hc < -0.01 ? 'HOME' : hc > 0.01 ? 'AWAY'
                : (data.ho_c != null && data.ao_c != null && data.ho_c <= data.ao_c) ? 'HOME' : 'AWAY';

  const favOc = favSide === 'HOME' ? data.ho_c : data.ao_c;
  const favOo = favSide === 'HOME' ? data.ho_o : data.ao_o;
  const dogOc = favSide === 'HOME' ? data.ao_c : data.ho_c;
  const dogOo = favSide === 'HOME' ? data.ao_o : data.ho_o;

  let lineMove = 'UNKNOWN';
  if (data.ah_ho != null) {
    const diff = favLc - Math.abs(data.ah_ho);
    lineMove = diff > LINE_THRESH ? 'DEEPER' : diff < -LINE_THRESH ? 'SHRANK' : 'STABLE';
  }
  const favOddsMove = oddsDir(favOc, favOo);
  const dogOddsMove = oddsDir(dogOc, dogOo);
  const tlMove      = moveDir(data.tl_c, data.tl_o, TL_THRESH);
  const overMove    = oddsDir(data.ov_c, data.ov_o);
  const underMove   = oddsDir(data.un_c, data.un_o);

  return {
    fav_line: favLine.toFixed(2), fav_side: favSide, derived_fav_side: favSide,
    line_move:     state.bLmOn  ? lineMove     : 'ANY',
    fav_odds_move: state.bFomOn ? favOddsMove  : 'ANY',
    dog_odds_move: state.bDomOn ? dogOddsMove  : 'ANY',
    over_move:     state.bOvmOn ? overMove     : 'ANY',
    under_move:    state.bUnmOn ? underMove    : 'ANY',
    tl_c: data.tl_c, tl_range: null, tl_cluster: null,
    tl_move: 'ANY', tl_max: null,
    odds_tolerance: getScanOddsTol(),
    fav_oc: state.scanOddsSide !== 'DOG'  ? favOc : null, fav_oo: null,
    dog_oc: state.scanOddsSide !== 'FAV'  ? dogOc : null, dog_oo: null,
    ov_c: null, ov_tol: null, un_c: null, un_tol: null,
    // passthrough for display only (not used by applyConfig):
    _signals: { lineMove, favOddsMove, dogOddsMove, tlMove, overMove, underMove, favSide, favLine },
  };
}

async function runBatchScan() {
  if (!_db.length) { showScanError('No database loaded.'); return; }

  const minN = getScanMinN();

  // Phase 1: fetch match list (with embedded Pinnacle odds from botbot3.space)
  setScanProgress('Fetching live match list…', 0, 0);
  let matchList;
  try {
    const scanUrl = document.getElementById('scan-url-input')?.value.trim() || '';
    const apiUrl  = '/api/livescore' + (scanUrl ? '?url=' + encodeURIComponent(scanUrl) : '');
    const resp = await fetch(apiUrl);
    const data = await resp.json();
    if (data.error) { showScanError(data.error); return; }
    matchList = data.matches || [];
    if (data.note && !matchList.length) { showScanError(data.note); return; }
  } catch (e) { showScanError('Network error: ' + e.message); return; }

  if (!matchList.length) { showScanError('No live matches found.'); return; }

  // Phase 2: fetch odds per match — skipped when livescore already returns embedded odds
  const BATCH = 6;
  const total = matchList.length;
  let done = 0;
  const scraped = [];
  _scanDataCache.clear();

  // Separate matches that already have odds (new livescore endpoint) from those that don't
  const needsScrape = matchList.filter(m => !m.odds);
  const hasOdds     = matchList.filter(m =>  m.odds);

  // Matches with embedded odds go straight to scored list
  for (const match of hasOdds) {
    scraped.push({ match, data: match.odds });
  }

  // Only scrape individually for matches that came without odds (fallback path)
  if (needsScrape.length > 0) {
    setScanProgress(`Fetching odds for ${needsScrape.length} matches…`, 0, needsScrape.length);
    for (let i = 0; i < needsScrape.length; i += BATCH) {
      const chunk = needsScrape.slice(i, i + BATCH);
      const results = await Promise.all(chunk.map(async match => {
        try {
          const r = await fetch('/api/scrape?url=' + encodeURIComponent(match.url));
          const d = await r.json();
          return { match, data: d.error ? null : d };
        } catch { return { match, data: null }; }
      }));
      scraped.push(...results);
      done += chunk.length;
      setScanProgress(`Fetched ${done} / ${needsScrape.length} matches…`, done, needsScrape.length);
    }
  }

  // Phase 3: score each match
  const qualifying = [];
  for (const { match, data } of scraped) {
    if (!data) continue;
    const cfg = buildCfgFromMatchData(data);
    if (!cfg) continue;

    const cfgRows = applyConfig(getDb(), cfg);
    const blRows  = applyBaselineConfig(getDb(), cfg);
    const blSide  = blRows.filter(r => r.fav_side === cfg.fav_side);

    if (cfgRows.length < minN) continue;

    // Show match if AH line moved (DEEPER/SHRANK) or TL moved (UP/DOWN)
    const sig = cfg._signals;
    const hasMovement = ['DEEPER', 'SHRANK'].includes(sig.lineMove) || ['UP', 'DOWN'].includes(sig.tlMove);
    if (!hasMovement) continue;

    // Scan card always shows pre-match bets (no GS filter) for a clean signal
    const bets  = scoreBets(cfgRows, blRows, blSide, minN);
    const bestZ = bets.length ? Math.max(...bets.map(b => Math.abs(b.z))) : 0;

    _scanDataCache.set(match.id, { odds: data, match, cfg });
    qualifying.push({ match, cfg, bets, bestZ, n: cfgRows.length });
  }

  const parseMin = m => parseInt(String(m?.minute || '999').replace(/'/g, ''), 10) || 999;
  qualifying.sort((a, b) => parseMin(a.match) - parseMin(b.match));
  setScanProgress(`Done — ${qualifying.length} match${qualifying.length !== 1 ? 'es' : ''} with movement from ${total} live`, total, total);
  renderBatchResults(qualifying, total);
}

async function startBatchScan() {
  const btn  = document.getElementById('scan-run-btn');
  const wrap = document.getElementById('scan-progress-wrap');
  btn.disabled = true;
  btn.textContent = 'Scanning…';
  wrap.style.display = '';
  document.getElementById('scan-results').innerHTML = '';
  try { await runBatchScan(); } finally {
    btn.disabled = false;
    btn.textContent = 'SCAN LIVE MATCHES →';
  }
}

function setScanProgress(msg, done, total) {
  document.getElementById('scan-progress-text').textContent = msg;
  document.getElementById('scan-progress-bar').style.width =
    total > 0 ? `${Math.round(done / total * 100)}%` : '0%';
}

function showScanError(msg) {
  document.getElementById('scan-results').innerHTML =
    `<div class="no-bets"><div class="warn-icon">⚠️</div><p>${msg}</p></div>`;
  setScanProgress('', 0, 0);
}

function getScanMinN() {
  const v = parseInt(document.getElementById('scan-min-n')?.value, 10);
  return isNaN(v) || v < 1 ? 15 : v;
}

function getScanOddsTol() {
  const v = parseFloat(document.getElementById('scan-odds-tol')?.value);
  return isNaN(v) || v < 0 ? 0.05 : v;
}

function useScanMatch(id) {
  const entry = _scanDataCache.get(id);
  if (!entry) return;
  fillFromScraped(entry.odds);
  fillLiveMatchState(entry.match);
  _showActiveMatchBanner(entry.match);
  _activeScanCfg = entry.cfg;
  _updateGsaMovementBadges();
  switchTab('gsa');
  runGsa();
}

function _updateGsaMovementBadges() {
  const sig = _activeScanCfg?._signals;
  const rows = [
    ['gsa-sig-lm',  sig?.lineMove],
    ['gsa-sig-tlm', sig?.tlMove],
    ['gsa-sig-fom', sig?.favOddsMove],
    ['gsa-sig-dom', sig?.dogOddsMove],
    ['gsa-sig-ovm', sig?.overMove],
    ['gsa-sig-unm', sig?.underMove],
  ];
  const label = { IN:'STEAM', OUT:'DRIFT', DEEPER:'DEEPER', SHRANK:'SHRANK', UP:'UP', DOWN:'DOWN', STABLE:'STABLE', UNKNOWN:'—' };
  for (const [id, val] of rows) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.textContent = label[val] || val || '—';
    el.className = 'sdrow-val' + (val ? ` ${val}` : '');
  }
}

function toggleGsaMovement(signal) {
  const keyMap = { lm:'gsaLmOn', tlm:'gsaTlmOn', fom:'gsaFomOn', dom:'gsaDomOn', ovm:'gsaOvmOn', unm:'gsaUnmOn' };
  const key = keyMap[signal];
  if (!key) return;
  state[key] = !state[key];
  const btn = document.getElementById(`gsa-${signal}-tgl`);
  if (btn) { btn.textContent = state[key] ? 'ON ' : 'OFF'; btn.classList.toggle('on', state[key]); }
}

function _showActiveMatchBanner(match) {
  const el = document.getElementById('active-match-banner');
  if (!el) return;
  if (!match) { el.style.display = 'none'; return; }

  const home   = match.home_team || '?';
  const away   = match.away_team || '?';
  const league = match.league    || '';
  const score  = match.score     || null;
  const min    = match.minute    ? String(match.minute).replace(/'/g, '').trim() + "'" : null;

  const scorePart  = score  ? `<span class="amb-score">${score}</span>`          : '';
  const minPart    = min    ? `<span class="amb-minute">${min}</span>`            : '';
  const leaguePart = league ? `<span class="amb-league">${league}</span><span class="amb-sep">·</span>` : '';

  el.innerHTML = `
    ${leaguePart}
    <span class="amb-teams">${home}<span class="amb-vs">vs</span>${away}</span>
    ${scorePart}${minPart}
    <button class="amb-clear" onclick="document.getElementById('active-match-banner').style.display='none'" title="Dismiss">✕</button>
  `;
  el.style.display = 'flex';
}

function fillLiveMatchState(match) {
  if (!match) return;

  // Live minute — strip apostrophe ("7'" → 7) and populate the estimator field
  const rawMin = match.minute ? String(match.minute).replace(/'/g, '').trim() : null;
  const minNum = rawMin ? parseInt(rawMin, 10) : NaN;
  if (!isNaN(minNum)) {
    const el = document.getElementById('live-minute');
    if (el) el.value = minNum;
  }

  // Score — only populate when explicitly known; never assume 0-0 (score=null may mean parse failed)
  if (!match.score) return;
  const parts = match.score.split('-');
  const homeG = parseInt(parts[0], 10) || 0;
  const awayG = parseInt(parts[1], 10) || 0;

  const setField = (id, v) => { const el = document.getElementById(id); if (el) el.value = v; };

  // Populate GSA tab HT score fields
  setField('gsa-gs-panel-home', homeG);
  setField('gsa-gs-panel-away', awayG);

  // If we're in 2H (minute > 45), also pre-fill the 2H in-play fields with 0-0
  if (!isNaN(minNum) && minNum > 45) {
    setField('gsa-gs-panel-home2h', 0);
    setField('gsa-gs-panel-away2h', 0);
  }
}

function renderBatchResults(results, totalScanned) {
  const container = document.getElementById('scan-results');
  if (!results.length) {
    container.innerHTML = `<div class="no-bets"><div class="warn-icon">⚠️</div>
      <p>No matches with AH line or TL movement.<br>Scanned ${totalScanned} live matches.</p></div>`;
    return;
  }
  let html = `<h2 class="results-title">LIVE SCAN — ${results.length} match${results.length !== 1 ? 'es' : ''} with movement</h2>
    <p style="font-size:11px;color:var(--dim);margin-bottom:12px">
      AH line or TL changed · ${totalScanned} live scanned · sorted by minute</p>`;
  for (const item of results) html += renderScanMatchCard(item);
  container.innerHTML = html;
}

function renderScanMatchCard({ match, cfg, bets, bestZ, n }) {
  const sig  = cfg._signals;
  const tier = tierClass(bestZ);

  const badges = [
    state.bLmOn  && sig.lineMove    !== 'UNKNOWN' ? sigBadge('LM',    sig.lineMove)    : '',
    state.bFomOn && sig.favOddsMove !== 'UNKNOWN' ? sigBadge('FAV',   sig.favOddsMove) : '',
    state.bDomOn && sig.dogOddsMove !== 'UNKNOWN' ? sigBadge('DOG',   sig.dogOddsMove) : '',
    state.bTlmOn && sig.tlMove      !== 'UNKNOWN' ? sigBadge('TLM',   sig.tlMove)      : '',
    state.bOvmOn && sig.overMove    !== 'UNKNOWN' ? sigBadge('OVER',  sig.overMove)    : '',
    state.bUnmOn && sig.underMove   !== 'UNKNOWN' ? sigBadge('UNDER', sig.underMove)   : '',
  ].join('');

  const topBets = bets.slice(0, 3).map(b => {
    const above = b.edge > 0;
    const zCls  = above ? 'badge-z badge-z-pos' : 'badge-z badge-z-neg';
    return `<div class="scan-bet-row">
      <span class="scan-bet-label">${b.label}</span>
      <span class="${zCls}">z=${b.z.toFixed(2)}</span>
      <span class="scan-bet-p">${b.p.toFixed(1)}% <span class="scan-bet-bl">vs ${b.bl.toFixed(1)}%</span></span>
      <span class="scan-bet-mo">${b.mo}–${b.mo_mid}</span>
    </div>`;
  }).join('');

  const scoreStr  = match.score  ? `<span class="scan-score">${match.score}</span>`   : '';
  const minuteStr = match.minute ? `<span class="scan-minute">${match.minute}</span>` : '';
  const leagueStr = match.league ? `<span class="scan-league">${match.league}</span>` : '';
  const ahStr = `AH ${sig.favSide === 'HOME' ? '−' : '+'}${sig.favLine}`;

  return `<div class="scan-card tier-${tier}">
    <div class="scan-card-header">
      <div class="scan-match-name">
        <span class="scan-home">${match.home_team || 'Home'}</span>
        <span class="scan-vs"> vs </span>
        <span class="scan-away">${match.away_team || 'Away'}</span>
        ${scoreStr}${minuteStr}
      </div>
      <div class="scan-meta">${leagueStr}${leagueStr ? ' · ' : ''}${ahStr} · n=${n}</div>
    </div>
    <div class="scan-signals">${badges}</div>
    <div class="scan-bets">${topBets}</div>
    <button class="scan-use-btn" onclick="useScanMatch('${match.id}')">Use this match →</button>
  </div>`;
}

function sigBadge(label, direction) {
  const pos = ['IN', 'DEEPER', 'UP'].includes(direction);
  const neg = ['OUT', 'SHRANK', 'DOWN'].includes(direction);
  const cls = pos ? 'sig-badge-pos' : neg ? 'sig-badge-neg' : 'sig-badge-stable';
  const lbl = { IN:'STEAM', OUT:'DRIFT', DEEPER:'DEEPER', SHRANK:'SHRANK',
                UP:'UP', DOWN:'DOWN', STABLE:'STABLE' }[direction] || direction;
  return `<span class="sig-badge ${cls}">${label}: ${lbl}</span>`;
}
