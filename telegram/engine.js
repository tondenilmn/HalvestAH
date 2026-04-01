'use strict';
// ── Analysis engine ───────────────────────────────────────────────────────────
// Direct port of the relevant sections of static/app.js.
// Keep in sync if the web app logic changes.

const fs   = require('fs');
const path = require('path');
const Papa = require('papaparse');

// ── Constants ─────────────────────────────────────────────────────────────────
const LINE_THRESH   = 0.12;
const ODDS_THRESH   = 0.06;
const TL_THRESH     = 0.12;
const DEFAULT_MIN_N = 15;
const VALID_LINES   = [0.00, 0.25, 0.50, 0.75, 1.00, 1.25, 1.50];

const TL_CLUSTERS = {
  '<2':    [null, 2.0],
  '2-2.5': [2.0,  2.5],
  '2.5-3': [2.5,  3.0],
  '>3':    [3.0,  null],
};

const COL_MAP = {
  'date': 'Date', 'event date': 'Date', 'event_date': 'Date',
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
  // marketOddsKey: CSV field whose closing odds directly price this bet.
  // Only set where there is a 1:1 correspondence — used for market-calibrated baseline.
  { k: 'ahCover',       label: 'AH Cover (Fav)',   marketOddsKey: 'fav_oc' },
  { k: 'dogCover',      label: 'AH Cover (Dog)',   marketOddsKey: 'dog_oc' },
  { k: 'overTL',        label: 'Over Total Line',  marketOddsKey: 'ov_c'   },
  { k: 'underTL',       label: 'Under Total Line', marketOddsKey: 'un_c'   },
  { k: 'favWins2H',     label: 'Fav wins 2H' },
  { k: 'favScored2H',   label: 'Fav scores 2H' },
  { k: 'draw2H',        label: 'Draw 2H' },
  { k: 'homeWins2H',    label: 'Home wins 2H',    favSideBaseline: 'HOME' },
  { k: 'awayWins2H',    label: 'Away wins 2H',    favSideBaseline: 'AWAY' },
  { k: 'homeScored2H',  label: 'Home scores 2H',  favSideBaseline: 'HOME' },
  { k: 'awayScored2H',  label: 'Away scores 2H',  favSideBaseline: 'AWAY' },
  { k: 'homeOver15_2H', label: 'Home Over 1.5 2H', favSideBaseline: 'HOME' },
  { k: 'awayOver15_2H', label: 'Away Over 1.5 2H', favSideBaseline: 'AWAY' },
  { k: 'over05_2H',     label: 'Over 0.5 2H' },
  { k: 'over15_2H',     label: 'Over 1.5 2H' },
  { k: 'under05_2H',    label: 'Under 0.5 2H' },
  { k: 'under15_2H',    label: 'Under 1.5 2H' },
  { k: 'favWins1H',     label: 'Fav wins 1H' },
  { k: 'draw1H',        label: 'Draw 1H' },
  { k: 'favScored1H',   label: 'Fav scores 1H' },
  { k: 'homeWins1H',    label: 'Home wins 1H',    favSideBaseline: 'HOME' },
  { k: 'awayWins1H',    label: 'Away wins 1H',    favSideBaseline: 'AWAY' },
  { k: 'over05_1H',     label: 'Over 0.5 1H' },
  { k: 'over15_1H',     label: 'Over 1.5 1H' },
  { k: 'under05_1H',    label: 'Under 0.5 1H' },
  { k: 'under15_1H',    label: 'Under 1.5 1H' },
  { k: 'btts1H',        label: 'BTTS 1H' },
  { k: 'homeWinsFT',    label: 'Home wins FT',    favSideBaseline: 'HOME' },
  { k: 'awayWinsFT',    label: 'Away wins FT',    favSideBaseline: 'AWAY' },
  { k: 'drawFT',        label: 'Draw FT' },
  { k: 'btts',          label: 'BTTS FT' },
  { k: 'over15FT',      label: 'Over 1.5 FT' },
  { k: 'over25FT',      label: 'Over 2.5 FT' },
  { k: 'over35FT',      label: 'Over 3.5 FT' },
  { k: 'under25FT',     label: 'Under 2.5 FT' },
];

// Pure 2H bets only — used for HT-as-signal probe.
// Excludes 1H bets (expired) AND FT bets (mechanically inflated by HT score:
// e.g. Over 2.5 FT filtered by HT 1-1 trivially hits because 2 goals already
// occurred — this is arithmetic, not edge. Pinnacle reprices FT immediately at HT).
const GS_PROBE_OUTCOMES = BETS.filter(b => b.k.includes('2H'));

// ── League tier ───────────────────────────────────────────────────────────────
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

// ── Data layer ────────────────────────────────────────────────────────────────
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
  if (d >  ODDS_THRESH) return 'OUT';
  return 'STABLE';
}

function moveDir(c, o, thresh) {
  if (c === null || o === null) return 'UNKNOWN';
  const d = c - o;
  if (d >  thresh) return 'UP';
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
    file_label: fileLabel,
    league_tier: classifyLeague(league),
    date, league, home_team: homeTeam, away_team: awayTeam,
    fav_side: favSide, fav_line: favLine, fav_lc: favLc, fav_lo: favLo,
    fav_oc: favOc, fav_oo: favOo, dog_oc: dogOc, dog_oo: dogOo,
    tl_c: tlC, tl_o: tlO, ov_c: ovC, ov_o: ovO, un_c: unC, un_o: unO,
    line_move: lineMove,
    fav_odds_move: oddsDir(favOc, favOo),
    dog_odds_move: oddsDir(dogOc, dogOo),
    tl_move: moveDir(tlC, tlO, TL_THRESH),
    over_move: oddsDir(ovC, ovO),
    under_move: oddsDir(unC, unO),
    fav_ht: favHt, dog_ht: dogHt, fav_ft: favFt, dog_ft: dogFt,
    fav_2h: fav2h, dog_2h: dog2h, home_2h: home2h, away_2h: away2h,
    first_goal: firstGoal,
    favScored2H: fav2h >= 1, favWins2H: fav2h > dog2h, draw2H: fav2h === dog2h,
    over05_2H: home2h + away2h >= 1, over15_2H: home2h + away2h >= 2,
    ahCover:  ah2h > 0.01,
    dogCover: ah2h < -0.01,
    overTL:   tlC != null && (ftH + ftA) > tlC,
    underTL:  tlC != null && (ftH + ftA) < tlC,
    homeWins2H: home2h > away2h, awayWins2H: away2h > home2h,
    homeWinsFT: ftH > ftA, awayWinsFT: ftA > ftH,
    homeScored2H: home2h >= 1, awayScored2H: away2h >= 1,
    homeOver15_2H: home2h >= 2, awayOver15_2H: away2h >= 2,
    under05_2H: home2h + away2h === 0, under15_2H: home2h + away2h <= 1,
    over25FT: ftH + ftA >= 3, over15FT: ftH + ftA >= 2,
    over35FT: ftH + ftA >= 4, under25FT: ftH + ftA <= 2,
    drawFT: ftH === ftA, btts: ftH >= 1 && ftA >= 1,
    favWins1H: favHt > dogHt, draw1H: favHt === dogHt,
    homeWins1H: htH > htA, awayWins1H: htA > htH,
    favScored1H: favHt >= 1, btts1H: htH >= 1 && htA >= 1,
    over05_1H: htH + htA >= 1, over15_1H: htH + htA >= 2,
    under05_1H: htH + htA === 0, under15_1H: htH + htA <= 1,
  };
}

// ── Stats ─────────────────────────────────────────────────────────────────────
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
  return p > 0 ? parseFloat((1 / (p / 100)).toFixed(2)) : null;
}

function avgMarketImplied(rows, oddsKey) {
  const valid = rows.filter(r => r[oddsKey] != null && r[oddsKey] > 1);
  if (valid.length < 5) return null;
  const sum = valid.reduce((s, r) => s + (1 / r[oddsKey]), 0);
  return sum / valid.length * 100;
}

// ── Engine ────────────────────────────────────────────────────────────────────
function applyConfig(db, cfg) {
  let rows = db;
  if (cfg.fav_line != null && cfg.fav_line !== 'ANY') {
    const fl = parseFloat(cfg.fav_line);
    rows = rows.filter(r => Math.abs(r.fav_line - fl) < 0.13);
  }
  if (cfg.fav_side != null && cfg.fav_side !== 'ANY')
    rows = rows.filter(r => r.fav_side === cfg.fav_side);
  if (cfg.odds_tolerance != null) {
    for (const key of ['fav_oc', 'dog_oc']) {
      const val = cfg[key];
      if (val != null) rows = rows.filter(r => r[key] != null && Math.abs(r[key] - val) <= cfg.odds_tolerance);
    }
  }
  if (cfg.line_move != null && cfg.line_move !== 'ANY' && cfg.line_move !== 'UNKNOWN')
    rows = rows.filter(r => r.line_move === cfg.line_move);
  if (cfg.fav_odds_move != null && cfg.fav_odds_move !== 'ANY' && cfg.fav_odds_move !== 'UNKNOWN')
    rows = rows.filter(r => r.fav_odds_move === cfg.fav_odds_move);
  if (cfg.dog_odds_move != null && cfg.dog_odds_move !== 'ANY' && cfg.dog_odds_move !== 'UNKNOWN')
    rows = rows.filter(r => r.dog_odds_move === cfg.dog_odds_move);
  if (cfg.tl_c != null && cfg.tl_c !== 'ANY') {
    const tlc = parseFloat(cfg.tl_c);
    if (!isNaN(tlc)) rows = rows.filter(r => r.tl_c != null && Math.abs(r.tl_c - tlc) < 0.13);
  }
  if (cfg.tl_move != null && cfg.tl_move !== 'ANY' && cfg.tl_move !== 'UNKNOWN')
    rows = rows.filter(r => r.tl_move === cfg.tl_move);
  if (cfg.over_move != null && cfg.over_move !== 'ANY' && cfg.over_move !== 'UNKNOWN')
    rows = rows.filter(r => r.over_move === cfg.over_move);
  if (cfg.under_move != null && cfg.under_move !== 'ANY' && cfg.under_move !== 'UNKNOWN')
    rows = rows.filter(r => r.under_move === cfg.under_move);
  return rows;
}

function applyBaselineConfig(db, cfg) {
  let rows = db;
  if (cfg.fav_line != null && cfg.fav_line !== 'ANY') {
    const fl = parseFloat(cfg.fav_line);
    rows = rows.filter(r => Math.abs(r.fav_line - fl) < 0.13);
  }
  if (cfg.fav_side != null && cfg.fav_side !== 'ANY')
    rows = rows.filter(r => r.fav_side === cfg.fav_side);
  if (cfg.tl_c != null && cfg.tl_c !== 'ANY') {
    const tlc = parseFloat(cfg.tl_c);
    if (!isNaN(tlc)) rows = rows.filter(r => r.tl_c != null && Math.abs(r.tl_c - tlc) < 0.13);
  }
  return rows;
}

function scoreBets(cfgRows, blRows, blSideRows, minN = DEFAULT_MIN_N) {
  if (!cfgRows.length || !blRows.length) return [];
  const n = cfgRows.length;
  if (n < minN) return [];
  const results = [];
  for (const b of BETS) {
    const baseline = (b.favSideBaseline && blSideRows) ? blSideRows : blRows;
    const p    = pct(cfgRows, b.k);
    const bl   = pct(baseline, b.k);
    const z    = zScore(cfgRows, baseline, b.k);
    const edge = p - bl;
    const [lo, hi] = wilsonCI(p, n);
    const mo     = minOdds(p);              // fair value (pure hit rate)
    const mo_lo  = minOdds(lo);             // conservative (Wilson CI lower bound)
    const mo_mid = minOdds((p + lo) / 2);  // midpoint CI
    const mkt_bl   = b.marketOddsKey ? avgMarketImplied(cfgRows, b.marketOddsKey) : null;
    const mkt_edge = mkt_bl != null ? p - mkt_bl : null;
    const mkt_avg_odds = mkt_bl != null ? parseFloat((100 / mkt_bl).toFixed(2)) : null;
    const avgTl = (b.k === 'overTL' || b.k === 'underTL')
      ? (() => { const v = cfgRows.filter(r => r.tl_c != null); return v.length ? v.reduce((s, r) => s + r.tl_c, 0) / v.length : null; })()
      : null;
    results.push({ ...b, n, p, bl, z, edge, lo, hi, mo, mo_lo, mo_mid, mkt_bl, mkt_edge, mkt_avg_odds, avgTl });
  }
  return results;
}

// ── Build cfg from live match odds ────────────────────────────────────────────
function buildCfgFromMatch(odds, cfg_flags) {
  const hc = odds.ah_hc;
  if (hc == null) return null;

  const favLc  = Math.abs(hc);
  const favLine = VALID_LINES.find(v => Math.abs(favLc - v) < 0.13);
  if (favLine === undefined) return null;

  const favSide = hc < -0.01 ? 'HOME' : hc > 0.01 ? 'AWAY'
    : (odds.ho_c != null && odds.ao_c != null && odds.ho_c <= odds.ao_c) ? 'HOME' : 'AWAY';

  const favOc = favSide === 'HOME' ? odds.ho_c : odds.ao_c;
  const favOo = favSide === 'HOME' ? odds.ho_o : odds.ao_o;
  const dogOc = favSide === 'HOME' ? odds.ao_c : odds.ho_c;
  const dogOo = favSide === 'HOME' ? odds.ao_o : odds.ho_o;

  let lineMove = 'UNKNOWN';
  if (odds.ah_ho != null) {
    const diff = favLc - Math.abs(odds.ah_ho);
    lineMove = diff > LINE_THRESH ? 'DEEPER' : diff < -LINE_THRESH ? 'SHRANK' : 'STABLE';
  }
  const favOddsMove = oddsDir(favOc, favOo);
  const dogOddsMove = oddsDir(dogOc, dogOo);
  const tlMove      = moveDir(odds.tl_c, odds.tl_o, TL_THRESH);
  const overMove    = oddsDir(odds.ov_c, odds.ov_o);
  const underMove   = oddsDir(odds.un_c, odds.un_o);

  const oddsTol  = cfg_flags.ODDS_TOLERANCE ?? null;
  const oddsSide = cfg_flags.ODDS_SIDE      ?? 'FAV';

  return {
    fav_line:      favLine.toFixed(2),
    fav_side:      favSide,
    odds_tolerance: oddsTol,
    fav_oc:        oddsSide !== 'DOG'  ? favOc : null,
    dog_oc:        oddsSide !== 'FAV'  ? dogOc : null,
    line_move:     cfg_flags.LINE_MOVE_ON   ? lineMove     : 'ANY',
    fav_odds_move: cfg_flags.FAV_ODDS_ON    ? favOddsMove  : 'ANY',
    dog_odds_move: cfg_flags.DOG_ODDS_ON    ? dogOddsMove  : 'ANY',
    tl_c:          odds.tl_c,
    tl_move:       cfg_flags.TL_MOVE_ON    ? tlMove       : 'ANY',
    over_move:     cfg_flags.OVER_ODDS_ON  ? overMove     : 'ANY',
    under_move:    cfg_flags.UNDER_ODDS_ON ? underMove    : 'ANY',
    signals: { lineMove, favOddsMove, dogOddsMove, tlMove, overMove, underMove, favSide, favLine },
  };
}

// ── Game state filter ─────────────────────────────────────────────────────────
function applyGameState(rows, gs) {
  if (!gs || !gs.trigger) return rows;
  const trigger = gs.trigger;
  if (trigger === 'HT') {
    const homeG = parseInt(gs.home_goals || 0, 10);
    const awayG = parseInt(gs.away_goals || 0, 10);
    return rows.filter(r =>
      r.fav_side === 'HOME'
        ? r.fav_ht === homeG && r.dog_ht === awayG
        : r.fav_ht === awayG && r.dog_ht === homeG
    );
  } else if (trigger === 'FIRST_GOAL') {
    const fg = gs.first_goal;
    return fg ? rows.filter(r => r.first_goal === fg) : rows;
  } else { // INPLAY_2H
    const home2h = parseInt(gs.home_2h || 0, 10);
    const away2h = parseInt(gs.away_2h || 0, 10);
    return rows.filter(r => r.home_2h >= home2h && r.away_2h >= away2h);
  }
}

// ── HT-as-signal probe ────────────────────────────────────────────────────────
// Compares HT-filtered pool (baseGs) against full pre-HT pool (base).
// Returns all 2H/FT bets with stats. Caller applies MIN_N/MIN_Z/MIN_BASELINE.
function computeHtAsSignalProbe(base, baseGs) {
  const results = [];
  for (const b of GS_PROBE_OUTCOMES) {
    const n = baseGs.length;
    if (n < 5) continue;
    const blRows = (b.favSideBaseline && base.length)
      ? base.filter(r => r.fav_side === b.favSideBaseline)
      : base;
    const p    = pct(baseGs, b.k);
    const bl   = pct(blRows, b.k);
    const z    = zScore(baseGs, blRows, b.k);
    const edge = p - bl;
    const [lo] = wilsonCI(p, n);
    const fairOdds   = p  > 0 ? parseFloat((100 / p).toFixed(2))  : null;
    const minOddsVal = lo > 0 ? parseFloat((100 / lo).toFixed(2)) : null;
    results.push({ ...b, n, p, bl, z, edge, lo, fairOdds, minOddsVal });
  }
  return results;
}

// ── CSV loader — local ────────────────────────────────────────────────────────
function loadDatabase(dataDir) {
  const manifestPath = path.join(dataDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`manifest.json not found at ${manifestPath}. Run node build.js first.`);
  }
  const { files } = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const db = [];
  for (const rel of files) {
    const fullPath = path.join(dataDir, rel);
    if (!fs.existsSync(fullPath)) continue;
    const csv = fs.readFileSync(fullPath, 'utf8');
    const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true });
    const label = path.basename(rel, '.csv');
    for (const row of data) {
      const processed = processRow(row, label);
      if (processed) db.push(processed);
    }
  }
  return db;
}

// ── CSV loader — remote (Cloudflare Pages) ────────────────────────────────────
// Fetches manifest.json then all CSV files from the deployed static site.
// Uses concurrency of 20 to keep startup fast without hammering the CDN.
async function loadDatabaseFromUrl(baseUrl) {
  const base = baseUrl.replace(/\/$/, '');

  const manifestRes = await fetch(`${base}/data/manifest.json`);
  if (!manifestRes.ok) {
    throw new Error(`Failed to fetch manifest from ${base}/data/manifest.json: ${manifestRes.status} ${manifestRes.statusText}`);
  }
  const { files } = await manifestRes.json();
  console.log(`Manifest loaded — ${files.length} CSV files to fetch`);

  const db = [];
  const CONCURRENCY = 20;

  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    const results = await Promise.all(batch.map(async rel => {
      const res = await fetch(`${base}/data/${rel}`);
      if (!res.ok) {
        console.warn(`  Skip ${rel}: HTTP ${res.status}`);
        return [];
      }
      const csv  = await res.text();
      const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true });
      const label = path.basename(rel, '.csv');
      const rows = [];
      for (const row of data) {
        const processed = processRow(row, label);
        if (processed) rows.push(processed);
      }
      return rows;
    }));
    for (const rows of results) db.push(...rows);
    process.stdout.write(`\r  Progress: ${Math.min(i + CONCURRENCY, files.length)}/${files.length} files…`);
  }
  process.stdout.write('\n');

  return db;
}

module.exports = {
  loadDatabase,
  loadDatabaseFromUrl,
  buildCfgFromMatch,
  applyConfig,
  applyBaselineConfig,
  applyGameState,
  scoreBets,
  classifyLeague,
  pct,
  zScore,
  wilsonCI,
  VALID_LINES,
  BETS,
  GS_PROBE_OUTCOMES,
  computeHtAsSignalProbe,
};
