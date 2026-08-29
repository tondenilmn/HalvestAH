// telegram/live_check.js — on-demand live price ladder (E8 LiveModel), NOT
// wired into notify.js's scheduler. Run whenever you want a GSA-style
// "given the current score, what's the target odds" check for the 3
// bet families that have a genuine live-play edge (see CLAUDE.md /
// Strategy NEWMODEL comment in notify.js): Over/Under FT, BTTS, and
// Over 0.5/1.5 2H. Under FT is INCLUDED for completeness but Under bets'
// real entry point is HT (no "market lags" edge live) — shown for context,
// not as a live recommendation.
//
// "Only if they didn't happen yet" = filters out any candidate whose
// outcome is already decided by the current score (Over already exceeded,
// BTTS already both scored, a 2H goal already scored for the Over-0.5/1.5
// 2H legs).
//
// Usage: node live_check.js [--tier=TOP+MAJOR|TOP|MAJOR|ALL] [--all]
//   --all shows every live match regardless of tier filter.
//
// HT anchors (needed for the 2H-remainder legs) are captured the first time
// a match is seen at minute 44'-50' and persisted to data/live_check_ht.json
// so repeated runs of this one-shot script accumulate them like notify.js's
// in-memory _htSnapshots does across scan cycles.

const fs = require('fs');
const path = require('path');
const cfg = require('./config.js');
const { classifyLeague } = require('./engine.js');
const { fetchLiveMatches, refreshHashes } = require('./livescore.js');
const LM = require('./live_model.js');
const { solveLambdaFromOdds } = require('./live_lambda_solver.js');

const args = process.argv.slice(2);
const tierArg = (args.find(a => a.startsWith('--tier=')) || '').split('=')[1];
const showAll = args.includes('--all');
const TIER_FILTER = showAll ? 'ALL' : (tierArg || cfg.NEWMODEL_TIER || 'TOP+MAJOR');

function tierAllowed(matchTier, stratTier) {
  if (!stratTier || stratTier === 'ALL') return true;
  if (stratTier === 'TOP')       return matchTier === 'TOP';
  if (stratTier === 'MAJOR')     return matchTier === 'MAJOR';
  if (stratTier === 'TOP+MAJOR') return matchTier === 'TOP' || matchTier === 'MAJOR';
  return true;
}

// Mirrors notify.js's parseLiveMinute (kept local — notify.js exports nothing).
function parseLiveMinute(minute) {
  if (minute == null) return null;
  const s = String(minute).replace(/'/g, '').trim();
  if (s === 'HT') return 45;
  const m = s.match(/^(\d+)(?:\+(\d+))?$/);
  if (!m) return null;
  const base = parseInt(m[1], 10);
  const extra = m[2] ? parseInt(m[2], 10) : 0;
  return isNaN(base) ? null : base + extra;
}

function parseScoreStr(scoreStr) {
  const m = String(scoreStr || '').match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  return { home: parseInt(m[1], 10), away: parseInt(m[2], 10) };
}

// ── HT snapshot persistence (file-backed version of notify.js's _htSnapshots) ──
const SNAP_FILE = path.join(__dirname, 'data', 'live_check_ht.json');
const HT_WINDOW = [44, 50];
const HT_TTL_MS = 4 * 60 * 60 * 1000;

function loadSnapshots() {
  try {
    const raw = JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8'));
    const now = Date.now();
    for (const k of Object.keys(raw)) if (now - raw[k].ts > HT_TTL_MS) delete raw[k];
    return raw;
  } catch { return {}; }
}
function saveSnapshots(snaps) {
  fs.mkdirSync(path.dirname(SNAP_FILE), { recursive: true });
  fs.writeFileSync(SNAP_FILE, JSON.stringify(snaps));
}

function fmtOdds(x) { return x != null && isFinite(x) ? x.toFixed(2) : '—'; }
function fmtPct(x)  { return x != null && isFinite(x) ? (x * 100).toFixed(1) + '%' : '—'; }

async function main() {
  console.log(`Refreshing book hashes…`);
  await refreshHashes().catch(e => console.log(`  hash refresh warning: ${e.message}`));

  const { matches } = await fetchLiveMatches();
  if (!matches.length) { console.log('No live matches right now.'); return; }

  let boot;
  try { boot = LM.init(); } catch (e) { console.log(`LiveModel init failed: ${e.message}`); return; }
  if (!boot.hazardLoaded) { console.log('goal_hazard.json not loaded — aborting.'); return; }

  const snaps = loadSnapshots();
  let shown = 0;

  for (const match of matches) {
    const liveMin = parseLiveMinute(match.minute);
    if (liveMin == null) continue; // not actually in-play
    const tier = classifyLeague(match.league || '');
    if (!tierAllowed(tier, TIER_FILTER)) continue;

    const odds = match.bet365_odds;
    if (!odds || odds.ah_hc == null) continue;

    const score = parseScoreStr(match.score);
    if (!score) continue;

    const matchId = match.id || `${match.home_team}:${match.away_team}`;
    if (liveMin >= HT_WINDOW[0] && liveMin <= HT_WINDOW[1] && !snaps[matchId]) {
      snaps[matchId] = { ...score, ts: Date.now() };
    }
    const htSnap = snaps[matchId];
    const in2H = liveMin > 45;

    const tl = odds.tl_c != null ? odds.tl_c : odds.tl_o;
    const ouLine = tl != null ? tl : 2.5;

    const state = {
      ah_line: odds.ah_hc, tl, tier,
      home_goals: score.home, away_goals: score.away,
      red_h: 0, red_a: 0, // no red-card feed
    };
    if (in2H && htSnap) { state.ht_home_goals = htSnap.home; state.ht_away_goals = htSnap.away; }

    const solved = solveLambdaFromOdds({
      ahLine: odds.ah_hc, ahHomeOdds: odds.ho_c, ahAwayOdds: odds.ao_c,
      tl, overOdds: odds.ov_c, underOdds: odds.un_c, tier,
    });
    if (solved.ok) { state.lambda_h = solved.lambda_h; state.lambda_a = solved.lambda_a; state.rho = solved.rho; }

    const specs = [
      { type: 'over',  line: ouLine, scope: 'match' },
      { type: 'under', line: ouLine, scope: 'match' },
      { type: 'btts',  scope: 'match', yes: true },
      ...(in2H && htSnap ? [
        { type: 'over', line: 0.5, scope: 'half' },
        { type: 'over', line: 1.5, scope: 'half' },
      ] : []),
    ];

    let rows;
    try {
      rows = LM.priceLadder(specs, state, liveMin, { samples: cfg.NEWMODEL_MC_SAMPLES });
    } catch (e) {
      console.log(`[${liveMin}'] ${match.home_team} vs ${match.away_team}  pricing failed: ${e.message}`);
      continue;
    }
    const [rOver, , rBtts, rOver05_2h, rOver15_2h] = rows;
    const totalGoals = score.home + score.away;
    const goals2h = htSnap ? Math.max(0, totalGoals - (htSnap.home + htSnap.away)) : null;

    const candidates = [];
    // Over/Under FT — "not happened yet" = the line hasn't already been settled.
    if (totalGoals < ouLine) {
      candidates.push({ label: `Over ${ouLine} FT`, row: rOver });
    }
    if (!(score.home >= 1 && score.away >= 1)) {
      candidates.push({ label: 'BTTS Yes', row: rBtts, marketOdds: null });
    }
    if (in2H && htSnap && goals2h === 0) {
      candidates.push({ label: `Over 0.5 2H (Over ${totalGoals + 0.5} FT)`, row: rOver05_2h, marketOdds: null });
    }
    if (in2H && htSnap && goals2h <= 1) {
      candidates.push({ label: `Over 1.5 2H (Over ${totalGoals + 1.5} FT)`, row: rOver15_2h, marketOdds: null });
    }

    if (!candidates.length) continue;

    shown++;
    console.log(`\n[${liveMin}'] ${match.home_team} vs ${match.away_team}  ${score.home}-${score.away}`);
    for (const c of candidates) {
      const p = c.row.p * 100;
      const target = fmtOdds(c.row.min_back_odds);
      console.log(`   ${c.label.padEnd(24)} ${p.toFixed(0)}%  → @${target}`);
    }
  }

  saveSnapshots(snaps);
  if (!shown) console.log(`No open (not-yet-happened) candidates among ${matches.length} live match(es) checked.`);
}

main().catch(e => { console.error(e); process.exit(1); });
