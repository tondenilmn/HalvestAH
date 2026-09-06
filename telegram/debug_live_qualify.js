'use strict';
// Diagnostic: for every currently live match, replicate Live Games' own
// cross-fit qualifying-list computation (static/app.js's analyzeLiveMatch /
// buildCfgFromLiveOdds / applyConfig+applyBaselineConfig / crossFitBets) and
// print n/z/lo/bl for EVERY bet (not just qualifying ones) so we can see how
// close the pool gets to clearing the bar. Faithful port of the browser
// logic — NOT a shortcut using fav_line/side/TL only (that would understate
// how narrow cfgRows really gets once movement signals are applied, and
// wrongly compare against the whole DB instead of the real baseline).
// Not wired into notify.js — run manually: `node debug_live_qualify.js`.

const path = require('path');
const {
  loadDatabase, scoreBets, mergeCrossFit, BETS, TL_CLUSTERS,
} = require('./engine.js');
const { fetchLiveMatches } = require('./livescore.js');
const cfg = require('./config.js');

const DEFAULT_MIN_N = 15;
const MIN_Z = 1.5;
const MIN_EDGE = 0;
const LINE_THRESH = 0.12;
const ODDS_THRESH = 0.06;
const TL_THRESH   = 0.12;
const VALID_LINES = [0.00, 0.25, 0.50, 0.75, 1.00, 1.25, 1.50];

function qualifiesBet(b) {
  if (!b) return false;
  return b.z >= MIN_Z && (b.lo - b.bl) >= MIN_EDGE;
}

function sf(v) {
  const f = parseFloat(String(v == null ? '' : v).trim());
  return isNaN(f) ? null : f;
}
function oddsDir(c, o) {
  if (c === null || o === null) return 'UNKNOWN';
  const d = c - o;
  if (d < -ODDS_THRESH) return 'IN';
  if (d > ODDS_THRESH) return 'OUT';
  return 'STABLE';
}
function moveDir(c, o, thresh) {
  if (c === null || o === null) return 'UNKNOWN';
  const d = c - o;
  if (d > thresh) return 'UP';
  if (d < -thresh) return 'DOWN';
  return 'STABLE';
}

// Faithful port of static/app.js's buildRawCfgFromLiveOdds/buildCfgFromLiveOdds.
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

  const tlCluster = tlc == null ? null : Object.entries(TL_CLUSTERS).find(([, [lo, hi]]) =>
    (lo == null || tlc >= lo) && (hi == null || tlc < hi))?.[0] ?? null;

  return {
    fav_line: favLine.toFixed(2), fav_side: favSide,
    line_move: lineMove,
    fav_odds_move: tier2 ? favOddsMove : 'ANY',
    dog_odds_move: tier2 ? dogOddsMove : 'ANY',
    over_move:     tier2 ? overMove    : 'ANY',
    under_move:    tier2 ? underMove   : 'ANY',
    tl_move: tlMove,
    tl_c: tlc,
    tl_cluster_name: tlCluster,
  };
}

function buildCfgFromLiveOdds(odds) {
  const base = buildRawCfgFromLiveOdds(odds, false);
  if (!base) return null;
  const lineStable = base.line_move === 'STABLE';
  const tlStable    = base.tl_move   === 'STABLE';
  if (!lineStable && !tlStable) return base;

  const cfg2 = buildRawCfgFromLiveOdds(odds, true);
  if (!lineStable) { cfg2.fav_odds_move = 'ANY'; cfg2.dog_odds_move = 'ANY'; }
  if (!tlStable)    { cfg2.over_move = 'ANY'; cfg2.under_move = 'ANY'; }
  return cfg2;
}

function inTlCluster(tlC, band) {
  if (tlC == null) return false;
  const [lo, hi] = band;
  return (lo == null || tlC >= lo) && (hi == null || tlC < hi);
}

// applyBaselineConfig-equivalent: fav_line + fav_side + TL cluster only.
function baselineMatch(r, mCfg) {
  return Math.abs(r.fav_line - mCfg.fl) < 0.13
    && r.fav_side === mCfg.fav_side
    && (mCfg.tlBand ? inTlCluster(r.tl_c, mCfg.tlBand) : true);
}
// applyConfig-equivalent: baseline + movement signals (only the ones not 'ANY').
function cfgMatch(r, mCfg) {
  if (!baselineMatch(r, mCfg)) return false;
  if (mCfg.line_move !== 'ANY' && mCfg.line_move !== 'UNKNOWN' && r.line_move !== mCfg.line_move) return false;
  if (mCfg.fav_odds_move !== 'ANY' && mCfg.fav_odds_move !== 'UNKNOWN' && r.fav_odds_move !== mCfg.fav_odds_move) return false;
  if (mCfg.dog_odds_move !== 'ANY' && mCfg.dog_odds_move !== 'UNKNOWN' && r.dog_odds_move !== mCfg.dog_odds_move) return false;
  if (mCfg.tl_move !== 'ANY' && mCfg.tl_move !== 'UNKNOWN' && r.tl_move !== mCfg.tl_move) return false;
  if (mCfg.over_move !== 'ANY' && mCfg.over_move !== 'UNKNOWN' && r.over_move !== mCfg.over_move) return false;
  if (mCfg.under_move !== 'ANY' && mCfg.under_move !== 'UNKNOWN' && r.under_move !== mCfg.under_move) return false;
  return true;
}

async function main() {
  console.log('Loading historical dataset…');
  const dataDir = path.resolve(__dirname, cfg.DATA_DIR);
  const db = loadDatabase(dataDir);
  console.log(`DB ready — ${db.length} rows\n`);

  console.log('Fetching live matches…');
  const { matches } = await fetchLiveMatches();
  const live = (matches || []).filter(m => m.minute != null);
  console.log(`${live.length} live (in-play) matches found\n`);

  if (!live.length) {
    console.log('No live matches right now — nothing to diagnose. Try again during an active window.');
    return;
  }

  let anyQualified = 0, anyValueHunt = 0, scored = 0;

  for (const match of live) {
    const odds = match.bet365_odds;
    if (!odds) { console.log(`--- ${match.home_team} vs ${match.away_team}: SKIP (no Bet365 odds)\n`); continue; }

    const liveCfg = buildCfgFromLiveOdds(odds);
    if (!liveCfg) { console.log(`--- ${match.home_team} vs ${match.away_team}: SKIP (AH odds incomplete/invalid line)\n`); continue; }

    const fl = parseFloat(liveCfg.fav_line);
    const tlBand = liveCfg.tl_cluster_name ? TL_CLUSTERS[liveCfg.tl_cluster_name] : null;
    const mCfg = { fl, fav_side: liveCfg.fav_side, tlBand, ...liveCfg };

    console.log(`--- ${match.home_team} vs ${match.away_team} (${match.league || '—'}) — ${match.minute}' ---`);
    console.log(`    fav_line=${fl} fav_side=${liveCfg.fav_side} tl_c=${liveCfg.tl_c ?? '—'} tl_cluster=${liveCfg.tl_cluster_name ?? '—'}`);
    console.log(`    line_move=${liveCfg.line_move} fav_odds_move=${liveCfg.fav_odds_move} dog_odds_move=${liveCfg.dog_odds_move} tl_move=${liveCfg.tl_move} over_move=${liveCfg.over_move} under_move=${liveCfg.under_move}`);

    scored++;
    const baseAll = db.filter(r => baselineMatch(r, mCfg));
    const cfgAll  = db.filter(r => cfgMatch(r, mCfg));
    console.log(`    baseline pool n=${baseAll.length}  cfg (signal-matched) pool n=${cfgAll.length}`);

    if (cfgAll.length < DEFAULT_MIN_N || baseAll.length < DEFAULT_MIN_N) {
      console.log(`    -> full-pool cfg or baseline already under DEFAULT_MIN_N (${DEFAULT_MIN_N}) before fold split. SKIP.\n`);
      continue;
    }

    const foldBase = (fold) => db.filter(r => r.fold === fold && baselineMatch(r, mCfg));
    const foldCfg  = (fold) => db.filter(r => r.fold === fold && cfgMatch(r, mCfg));

    const baseA = foldBase('A'), baseB = foldBase('B');
    const cfgA  = foldCfg('A'),  cfgB  = foldCfg('B');
    console.log(`    fold A: base=${baseA.length} cfg=${cfgA.length}   fold B: base=${baseB.length} cfg=${cfgB.length}`);

    const betsA = scoreBets(cfgA, baseA, baseA, DEFAULT_MIN_N);
    const betsB = scoreBets(cfgB, baseB, baseB, DEFAULT_MIN_N);

    if (!betsA.length && !betsB.length) {
      console.log(`    -> neither fold's cfg pool reached DEFAULT_MIN_N (${DEFAULT_MIN_N}) after split. SKIP.\n`);
      continue;
    }

    const merged = mergeCrossFit(betsA, betsB, BETS, qualifiesBet);
    const rows = merged
      .map(b => ({ k: b.k, n: b.n, z: b.z, p: b.p, lo: b.lo, bl: b.bl, edge: (b.lo - b.bl), qualifies: qualifiesBet(b) }))
      .sort((a, b) => (b.z * (b.lo / 100)) - (a.z * (a.lo / 100)));

    if (!rows.length) {
      console.log(`    -> mergeCrossFit produced 0 bets.\n`);
      continue;
    }

    const qualifying = rows.filter(r => r.qualifies);
    const valueHunt = rows.filter(r => !r.qualifies && r.edge > 0);
    if (qualifying.length) anyQualified++;
    if (valueHunt.length) anyValueHunt++;

    console.log(`    ${rows.length} cross-fit bets computed | ${qualifying.length} qualify | ${valueHunt.length} value-hunt (edge>0, below z/CI bar)`);
    for (const r of rows.slice(0, 8)) {
      const tag = r.qualifies ? '✓ QUALIFIES' : r.edge > 0 ? '◆ value-hunt' : '  —';
      console.log(`      ${tag}  ${r.k.padEnd(16)} n=${String(r.n).padEnd(4)} z=${r.z.toFixed(2).padStart(5)} p=${r.p.toFixed(1).padStart(5)}% lo=${r.lo.toFixed(1).padStart(5)}% bl=${r.bl.toFixed(1).padStart(5)}% edge(lo-bl)=${r.edge.toFixed(1).padStart(6)}pp`);
    }
    console.log('');
  }

  console.log(`\nSummary: of ${scored} scoreable matches — ${anyQualified} had at least one qualifying bet; ${anyValueHunt} had at least one value-hunt (positive-edge but sub-bar) bet; ${scored - anyQualified - anyValueHunt} had neither.`);
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
