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
  { k: 'dnbHome',       label: 'DNB — Home',               market: 'Draw No Bet — Home',                favSideBaseline: 'HOME' },
  { k: 'dnbAway',       label: 'DNB — Away',               market: 'Draw No Bet — Away',                favSideBaseline: 'AWAY' },
  { k: 'btts',          label: 'BTTS full time',           market: 'Both Teams to Score — FT' },
  // FT totals
  { k: 'over15FT',      label: 'Over 1.5 goals FT',       market: 'Over/Under 1.5 — Full Time' },
  { k: 'over25FT',      label: 'Over 2.5 goals FT',       market: 'Over/Under 2.5 — Full Time' },
  { k: 'over35FT',      label: 'Over 3.5 goals FT',       market: 'Over/Under 3.5 — Full Time' },
  { k: 'under25FT',     label: 'Under 2.5 goals FT',      market: 'Over/Under 2.5 — Full Time' },
];

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
                mo: minOdds(p),
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
  'dnbHome','dnbAway','over25FT','over15FT','over35FT','under25FT','drawFT','btts',
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

const state = {
  gsTrigger:    'HT',
  dGsTrigger:   'HT',
  liveOn:       false,
  filterMode:   'BASIC',   // 'BASIC' or 'ADVANCED'
  // Advanced toggles
  advLmOn:      false,
  advOddsTolOn: false,
  advOddsDeltaOn: false,
  advHomOn:     false,
  advAomOn:     false,
  advTlmOn:     false,
  advOvTolOn:   false,
  advOvmOn:     false,
  advUnTolOn:   false,
  advUnmOn:     false,
  advTlRange:   '2.25-2.75',
  bOddsSide: 'FAV',   // which side(s) to apply odds tolerance: 'FAV' | 'DOG' | 'BOTH'
  // Basic signal toggles
  bLmOn:  true,
  bFomOn: false,
  bDomOn: false,
  bTlmOn: true,
  bOvmOn: false,
  bUnmOn: false,
};

/* ════════════════════════════════════════════════════════════
   INIT
   ════════════════════════════════════════════════════════════ */
document.addEventListener('DOMContentLoaded', () => {
  setupUpload();
  renderGsPanel('gs-panel', 'HT');
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
  document.querySelectorAll('.tab-btn').forEach((b, i) => {
    b.classList.toggle('active', (i === 0 ? 'match' : 'disc') === name);
  });
  document.getElementById('tab-match').classList.toggle('active', name === 'match');
  document.getElementById('tab-disc').classList.toggle('active', name === 'disc');
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

function updateDbUI(data) {
  const status = document.getElementById('db-status');

  if (data.total === 0) {
    status.textContent = 'No database loaded';
    status.className   = 'db-status';
  } else {
    status.textContent = `✓  ${data.total.toLocaleString()} records  ·  ${data.files.length} file${data.files.length !== 1 ? 's' : ''}`;
    status.className   = 'db-status loaded';
  }
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

  // Recompute mirrored fields and signal previews
  onInputChange();
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

  const gs   = getGs('gs-panel', state.gsTrigger);
  const minN = getMinN();

  const cfgRows = applyConfig(_db, cfg);
  const derivedFavSide = cfg.fav_side !== 'ANY' ? cfg.fav_side : cfg.derived_fav_side;

  // --- Scenario 1: pre-match (no game state) ---
  const baselineRows_pre = applyBaselineConfig(_db, cfg);
  const blSide_pre = (derivedFavSide && derivedFavSide !== 'ANY')
    ? baselineRows_pre.filter(r => r.fav_side === derivedFavSide) : null;
  const allBets_pre = scoreBets(cfgRows, baselineRows_pre, blSide_pre, minN);
  const bets_pre    = allBets_pre.filter(b => Math.abs(b.z) >= MIN_Z);
  const ftrace_pre  = traceConfig(_db, cfg, null);

  // --- Scenario 2: in-play (with game state) ---
  const stateRows_gs    = applyGameState(cfgRows, gs);
  const baselineRows_gs = applyGameState(baselineRows_pre, gs);
  const blSide_gs       = blSide_pre ? applyGameState(blSide_pre, gs) : null;
  const allBets_gs      = scoreBets(stateRows_gs, baselineRows_gs, blSide_gs, 1);
  const bets_gs         = allBets_gs.filter(b => Math.abs(b.z) >= MIN_Z);
  const ftrace_gs       = traceConfig(_db, cfg, gs);

  // Attach live odds to in-play scenario bets if estimator is ON
  if (state.liveOn) {
    const liveMin  = parseInt(document.getElementById('live-minute').value, 10);
    const lhome2h  = parseInt(document.getElementById('live-home2h').value, 10) || 0;
    const laway2h  = parseInt(document.getElementById('live-away2h').value, 10) || 0;
    if (!isNaN(liveMin) && liveMin > 0) {
      const favLineVal = parseFloat(cfg.fav_line);
      const favLine = isNaN(favLineVal) ? 0.75 : favLineVal;
      const favSide = (cfg.fav_side === 'ANY' || !cfg.fav_side) ? 'HOME' : cfg.fav_side;
      const fgDelta = favSide === 'HOME' ? lhome2h : laway2h;
      const dgDelta = favSide === 'HOME' ? laway2h : lhome2h;
      for (const bet of bets_gs) {
        bet.live = computeLiveOdd(bet.p, bet.k, liveMin, favLine, fgDelta, dgDelta, favSide);
      }
    }
  }

  renderMatchResults({
    pre: { cfg_n: cfgRows.length, gs_n: cfgRows.length, allBets: allBets_pre, bets: bets_pre, ftrace: ftrace_pre, min_n: minN, cfg, filterMode: state.filterMode },
    gs:  { cfg_n: cfgRows.length, gs_n: stateRows_gs.length, allBets: allBets_gs, bets: bets_gs, ftrace: ftrace_gs, min_n: minN, cfg, filterMode: state.filterMode },
    gsLabel: gsLabel(gs),
  });
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
    const totalWithTl = _db.filter(r => r.tl_c != null).length;
    if (totalWithTl === 0) {
      diagMsg = 'No Total Line data found in the loaded CSV files. Your CSVs must include a "Total Line Closing" column for TL filtering.';
    } else {
      let tlN;
      if (TL_CLUSTERS[tlRaw]) {
        const [lo, hi] = TL_CLUSTERS[tlRaw];
        tlN = _db.filter(r => r.tl_c != null && (lo == null || r.tl_c >= lo) && (hi == null || r.tl_c < hi)).length;
      } else {
        const tlv = parseFloat(tlRaw);
        tlN = isNaN(tlv) ? 0 : _db.filter(r => r.tl_c != null && Math.abs(r.tl_c - tlv) < 0.13).length;
      }
      if (tlN < minN) diagMsg = `TL filter "${tlRaw}" matches only ${tlN} records (minimum is ${minN}). Try a broader range.`;
    }
  }

  // Yield to browser so loader renders before heavy computation
  setTimeout(() => {
    try {
      const results = discover(_db, favLine, favSide, lineMoveI, tlMoveI, gs, minN, tlRaw);
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
      <span class="col-min-odds-label">MIN ODDS</span>
      <span class="col-min-odds-value">${bet.mo_mid}</span>
      <span class="col-min-odds-floor">floor ${bet.mo_lo}</span>
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

  // Odds checker uses in-play if it passes (more specific), else pre-match
  const ocBet = (gsPass && gs) ? gs : pre;

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
    <div class="odds-checker">
      <label>CHECK LIVE ODDS:</label>
      <span>Betfair</span>
      <input class="odds-check-input" type="text" placeholder="1.85"
             data-mo="${ocBet.mo_mid}" data-p="${ocBet.p}">
      <span class="odds-result"></span>
      <span style="margin-left:10px">Soft book</span>
      <input class="odds-check-input" type="text" placeholder="1.85"
             data-mo="${ocBet.mo_mid}" data-p="${ocBet.p}">
      <span class="odds-result"></span>
    </div>
  </div>`;
}

function renderMatchResults({ pre, gs, gsLabel: label }) {
  const right = document.getElementById('right-panel');

  let cfgSummary = '';
  if (pre.cfg) {
    const ahSide = pre.cfg.fav_side === 'AWAY' ? 'Away' : 'Home';
    cfgSummary = `<div class="cfg-summary">${ahSide} AH −${pre.cfg.fav_line}</div>`;
  }

  // Build union of bets passing MIN_Z in at least one scenario
  const preMap = new Map(pre.allBets.map(b => [b.k, b]));
  const gsMap  = new Map(gs.allBets.map(b => [b.k, b]));
  const unionKeys = new Set([...pre.bets.map(b => b.k), ...gs.bets.map(b => b.k)]);

  const mergedBets = Array.from(unionKeys).map(k => ({
    k,
    pre:     preMap.get(k) || null,
    gs:      gsMap.get(k)  || null,
    prePass: pre.bets.some(b => b.k === k),
    gsPass:  gs.bets.some(b => b.k === k),
    minN:    pre.min_n,
  }));

  // Sort: both pass first, then by combined z
  mergedBets.sort((a, b) => {
    const aBoth = a.prePass && a.gsPass, bBoth = b.prePass && b.gsPass;
    if (aBoth !== bBoth) return aBoth ? -1 : 1;
    return ((b.pre?.z || 0) + (b.gs?.z || 0)) - ((a.pre?.z || 0) + (a.gs?.z || 0));
  });

  const qualPre = pre.bets.filter(b => b.edge > 0).length;
  const qualGs  = gs.bets.filter(b => b.edge > 0).length;
  const gsLow   = gs.gs_n < pre.min_n;

  let html = `<h2 class="results-title">BEST BETS</h2>${cfgSummary}`;

  html += `<div class="scenarios-summary">
    <div class="sc-stat"><span class="sc-label">Config</span><span class="sc-val">${pre.cfg_n}</span><span class="sc-sub">matches</span></div>
    <div class="sc-sep">·</div>
    <div class="sc-stat"><span class="sc-label">Pre-match</span><span class="sc-val" style="color:${qualPre ? 'var(--green)' : 'var(--dim)'}">${qualPre}</span><span class="sc-sub">qualifying</span></div>
    <div class="sc-sep">·</div>
    <div class="sc-stat"><span class="sc-label">In-play ${label}</span><span class="sc-val" style="color:${gsLow ? 'var(--yellow)' : qualGs ? 'var(--green)' : 'var(--dim)'}">${gsLow ? gs.gs_n + ' ⚠' : qualGs}</span><span class="sc-sub">${gsLow ? 'records — low' : 'qualifying'}</span></div>
  </div>`;

  html += buildTraceHtml(pre.ftrace, 'PRE-MATCH FILTER TRACE');
  html += buildTraceHtml(gs.ftrace,  `IN-PLAY FILTER TRACE  (${label})`);

  if (pre.filterMode === 'BASIC') {
    const anySignalOn = state.bLmOn || state.bFomOn || state.bDomOn || state.bTlmOn || state.bOvmOn || state.bUnmOn;
    if (!anySignalOn) {
      html += `<div class="basic-mode-notice">
        ⚠ Basic mode — no movement signals active. Results reflect game state only, not conditioned on market direction.
        Activate AH or TL signal groups for meaningful edge detection.
      </div>`;
    }
  }

  if (!mergedBets.length) {
    html += `<div class="no-bets"><div class="warn-icon">⚠️</div>
      <p>No statistically significant bets found.<br>No edge detected (z ≥ 1.5) on any outcome.<br><br>
      → Skip this match.<br>→ Use Config Discovery to explore other configurations.</p></div>`;
    right.innerHTML = html;
    return;
  }

  html += `<p style="font-size:11px;color:var(--dim);margin-bottom:10px">${mergedBets.length} bet${mergedBets.length !== 1 ? 's' : ''} — sorted by strength · both-pass first</p>`;
  for (let i = 0; i < mergedBets.length; i++) html += renderMergedBetCard(mergedBets[i], i + 1, label);

  // Value hunt from pre-match allBets (bets with positive edge but z < MIN_Z)
  const vhBets = pre.allBets.filter(b => Math.abs(b.z) < MIN_Z && b.edge > 0 && b.n >= pre.min_n);
  if (vhBets.length) html += renderValueHuntSection(vhBets);

  right.innerHTML = html;
  right.querySelectorAll('.odds-check-input').forEach(inp => {
    inp.addEventListener('input', () => {
      const mo   = parseFloat(inp.dataset.mo);
      const p    = parseFloat(inp.dataset.p);
      const lbl  = inp.nextElementSibling;
      const odds = parseFloat(inp.value);
      if (isNaN(odds) || isNaN(mo)) { lbl.textContent = ''; lbl.className = 'odds-result'; return; }
      const ev = (odds * (p / 100) - 1) * 100;
      if (odds >= mo) {
        lbl.textContent = `✓ VALUE  ${ev >= 0 ? '+' : ''}${ev.toFixed(1)}%`;
        lbl.className   = 'odds-result value';
      } else {
        lbl.textContent = `✗ SKIP  ${ev >= 0 ? '+' : ''}${ev.toFixed(1)}%`;
        lbl.className   = 'odds-result skip';
      }
    });
  });
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
        <div class="mo-label">MIN ODDS</div>
        <div class="mo-value">${bet.mo}</div>
        <div class="mo-sub">face value</div>
        <div class="mo-divider"></div>
        <div class="mo-label">SAFE MIN</div>
        <div class="mo-safe">${bet.mo_mid}</div>
        <div class="mo-sub">midpoint CI</div>
        <div class="mo-lo-ref">hard floor: ${bet.mo_lo}</div>
      </div>
    </div>
    ${liveHtml}
    <div class="odds-checker">
      <label>CHECK LIVE ODDS:</label>
      <span>Betfair</span>
      <input class="odds-check-input" type="text" placeholder="1.85"
             data-mo="${bet.mo_mid}" data-p="${bet.p}">
      <span class="odds-result"></span>
      <span style="margin-left:10px">Soft book</span>
      <input class="odds-check-input" type="text" placeholder="1.85"
             data-mo="${bet.mo_mid}" data-p="${bet.p}">
      <span class="odds-result"></span>
    </div>
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
        <div class="vh-checker">
          <label>BK ODDS:</label>
          <input class="odds-check-input" type="text" placeholder="2.10"
                 data-mo="${bet.mo_mid}" data-p="${bet.p}">
          <span class="odds-result"></span>
        </div>
      </div>
      <div class="vh-right">
        <div class="mo-label">SAFE MIN ODDS</div>
        <div class="vh-mo-value">${bet.mo_mid}</div>
        <div class="mo-sub">midpoint CI</div>
        <div class="mo-lo-ref">hard floor: ${bet.mo_lo}</div>
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
        <div class="dl">MIN ODDS</div>
        <div class="dm">${r.mo}</div>
      </div>
    </div>`;
  }

  right.innerHTML = html;
}
