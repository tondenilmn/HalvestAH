'use strict';
// ── HalvestAH Telegram Notifier ───────────────────────────────────────────────
// Runs a single strategy: L123 — Layer 1/2/3 consensus (see config.js for the
// full description). Polls the live match feed every SCAN_INTERVAL_MINUTES
// (default 2 min) and fires as soon as the match is live and >= L123_MIN_AGREE
// of the 3 layers agree on the same bet.
//
// Usage:
//   node notify.js          — start scheduler (runs every N minutes)
//   node notify.js --once   — single scan + exit (for testing)
//   node notify.js --verbose — verbose logging (skip reasons)

const path = require('path');
const cron = require('node-cron');
const cfg  = require('./config');
const {
  classifyLeague,
  loadDatabase,
  loadDatabaseFromUrl,
  buildCfgFromMatch,
  applyConfig,
  applyGameState,
  scoreBets,
} = require('./engine');
const { fetchLiveMatches, refreshHashes } = require('./livescore');
const { verifyBet365Price } = require('./apifootball');
const { recordAlert, settlePendingAlerts, buildDigestMessage, loadState, saveState } = require('./track_record');
const { computeLiveOdd } = require('./live_odds');

const VERBOSE = process.argv.includes('--verbose') || process.env.VERBOSE === 'true';
const verbose = VERBOSE ? (...a) => console.log(...a) : () => {};

let _scanAlerts = 0;

// Format: [min'] Match  Strategy  reason
function flog(liveMin, label, strat, msg) {
  const m = liveMin != null ? `[${liveMin}']` : '[—]';
  console.log(`${m.padEnd(6)} ${label}  ${strat}  ${msg}`);
}
function flogv(liveMin, label, strat, msg) {
  if (VERBOSE) flog(liveMin, label, strat, msg);
}

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${cfg.TELEGRAM_TOKEN}/sendMessage`;
  const preview = text.replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim().slice(0, 120);
  console.log(`[TELEGRAM] Sending notification → "${preview}…"`);
  try {
    const res = await fetch(url, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ chat_id: cfg.TELEGRAM_CHAT_ID, text, parse_mode: 'HTML' }),
    });
    if (!res.ok) {
      console.error(`[TELEGRAM] Send FAILED: ${await res.text()}`);
    } else {
      console.log(`[TELEGRAM] Sent OK`);
      _scanAlerts++;
    }
  } catch (e) {
    console.error(`[TELEGRAM] Fetch failed: ${e.message}`);
  }
}

// ── Utilities ─────────────────────────────────────────────────────────────────

// Escape HTML special chars (team/league names may contain < >)
function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

// Parse live minute from match.minute. Returns null if upcoming/not started.
function parseLiveMinute(minute) {
  if (minute == null) return null;
  const s = String(minute).replace(/'/g, '').trim();
  if (s === 'HT') return 45;
  const n = parseInt(s, 10);
  return isNaN(n) ? null : n;
}

// Returns true if matchTier is allowed under stratTier setting.
function tierAllowed(matchTier, stratTier) {
  if (!stratTier || stratTier === 'ALL') return true;
  if (stratTier === 'TOP')       return matchTier === 'TOP';
  if (stratTier === 'MAJOR')     return matchTier === 'MAJOR';
  if (stratTier === 'TOP+MAJOR') return matchTier === 'TOP' || matchTier === 'MAJOR';
  return true;
}

// Minutes from now until kickoff, or null if kickoff_time is missing/unparseable.
// Negative once the match has actually started (kept as-is — callers gate on
// liveMin for "already live" separately).
function minutesToKickoff(kickoffTime) {
  if (!kickoffTime) return null;
  const t = new Date(kickoffTime).getTime();
  if (isNaN(t)) return null;
  return (t - Date.now()) / 60000;
}

// L123 fires PRE-MATCH now, in the window from kickoff down to 10 minutes
// before it — not once the match is already live. Rationale: firing before
// kickoff gives time to actually place the bet at a stable price, instead of
// needing fast in-play execution once the match has started. Note this is a
// real methodology shift from how L123 was walk-forward validated (see
// CLAUDE.md) — Layer 3 ("closing odds only") was validated against the
// TRUE closing line at kickoff, and the price up to 10 minutes early can
// still move before then, so it's a same-idea-different-timing approximation
// of "closing", not the exact thing that was backtested.
const PRE_MATCH_WINDOW_MIN = 10;

// Compute window flags and common fields for a match once per scan iteration.
function matchContext(match) {
  const liveMin = parseLiveMinute(match.minute);
  const toKickoff = liveMin == null ? minutesToKickoff(match.kickoff_time) : null;
  return {
    matchId:    match.id || `${match.home_team}:${match.away_team}`,
    label:      `${match.home_team} vs ${match.away_team}`,
    tier:       classifyLeague(match.league || ''),
    liveMin,
    toKickoff,
    isL123Fire: liveMin == null && toKickoff != null && toKickoff >= 0 && toKickoff <= PRE_MATCH_WINDOW_MIN,
  };
}

// ── Deduplication ─────────────────────────────────────────────────────────────
class Dedup {
  constructor(ttlMs) {
    this._map = new Map();
    this._ttl = ttlMs;
  }

  has(key) {
    const ts = this._map.get(key);
    if (!ts) return false;
    if (Date.now() - ts > this._ttl) { this._map.delete(key); return false; }
    return true;
  }

  mark(key) { this._map.set(key, Date.now()); }
}

// ── Message builder ────────────────────────────────────────────────────────────
// Common message frame — match info first, then the strategy's bet lines
// (the actionable part).
function buildMessage(strategyName, match, minuteScore, betLines) {
  return [
    `🎯 <b>${strategyName}</b>`,
    ``,
    `⚽ <b>${esc(match.home_team)} vs ${esc(match.away_team)}</b>`,
    `🏆 ${esc(match.league) || '—'}`,
    `⏱ ${minuteScore}`,
    ``,
    ...betLines,
  ].join('\n');
}

// ── Database ──────────────────────────────────────────────────────────────────
let _dbAll = null;

async function loadDb() {
  try {
    if (cfg.DATA_URL) {
      console.log(`[DB] Loading Bet365 dataset from ${cfg.DATA_URL}…`);
      _dbAll = await loadDatabaseFromUrl(cfg.DATA_URL);
    } else {
      const dataDir = path.resolve(__dirname, cfg.DATA_DIR);
      console.log(`[DB] Loading Bet365 dataset from ${dataDir}…`);
      _dbAll = loadDatabase(dataDir);
    }
    console.log(`[DB] Ready — ${_dbAll.length} rows`);
  } catch (e) {
    console.error(`[DB] Load failed: ${e.message}`);
    _dbAll = [];
  }
}

// ── Strategy L123: Layer 1/2/3 consensus ─────────────────────────────────────
// Layer 1 — opening odds only (fav opening odds band + opening TL band)
// Layer 2 — movement only (line_move, fav/dog odds move, tl_move)
// Layer 3 — closing odds only (fav closing odds band + closing TL band)
// Each layer independently queries the historical Bet365 DB using only its
// own slice of information, mirroring telegram/layer_analysis.js's
// layer1Rec/layer2Rec/layer3Rec. Fires when the match is live (2–4') and
// >= L123_MIN_AGREE layers land on the same bet — the "2/3 agree" / "3/3
// agree" convergence signal. Compares against match.bet365_odds (not
// Pinnacle) to stay consistent with the Bet365-priced historical pool.

const ODDS_BANDS = [
  [null, 1.60], [1.60, 1.75], [1.75, 1.90], [1.90, 2.05],
  [2.05, 2.30], [2.30, 2.70], [2.70, null],
];
const TL_BANDS = {
  '<2':    [null, 2.0],
  '2-2.5': [2.0,  2.5],
  '2.5-3': [2.5,  3.0],
  '>3':    [3.0,  null],
};
function inBand(v, band) {
  if (v == null || !band) return false;
  const [lo, hi] = band;
  return (lo == null || v >= lo) && (hi == null || v < hi);
}

// Qualifies on the Wilson CI *lower bound* (b.lo) rather than the raw point
// estimate (b.p/b.edge) — the point estimate is inflated by winner's-curse
// selection (each layer picks the single best-scoring cell out of thousands
// swept), so gating on it prices bets off a number that regresses toward
// baseline out-of-sample. Gating on the pessimistic end of the CI bakes that
// regression in up front instead of getting surprised by it after the fact.
function l123Qualifies(b) {
  return b.n >= cfg.L123_MIN_N && b.z >= cfg.L123_MIN_Z && (b.lo - b.bl) >= cfg.L123_MIN_EDGE && b.bl >= cfg.L123_MIN_BASELINE;
}
function l123BestQualifying(bets) {
  const q = bets.filter(l123Qualifies);
  if (!q.length) return null;
  q.sort((a, b) => (b.z * b.lo / 100) - (a.z * a.lo / 100));
  return q[0];
}

function layer1Live(favLine, favSide, favOo, tlO) {
  if (favOo == null) return null;
  const base = _dbAll.filter(r => r.fav_line === favLine && r.fav_side === favSide);
  if (base.length < cfg.L123_MIN_N) return null;
  const oddsBand = ODDS_BANDS.find(b => inBand(favOo, b));
  const tlBand   = Object.values(TL_BANDS).find(b => inBand(tlO, b));
  const cfgRows  = base.filter(r => inBand(r.fav_oo, oddsBand) && (tlBand ? inBand(r.tl_o, tlBand) : true));
  if (cfgRows.length < cfg.L123_MIN_N) return null;
  return l123BestQualifying(scoreBets(cfgRows, base, base, cfg.L123_MIN_N));
}

function layer2Live(l2Cfg) {
  const base = _dbAll.filter(r => r.fav_line === l2Cfg.fav_line && r.fav_side === l2Cfg.fav_side);
  if (base.length < cfg.L123_MIN_N) return null;
  const cfgRows = applyConfig(base, l2Cfg);
  if (cfgRows.length < cfg.L123_MIN_N) return null;
  return l123BestQualifying(scoreBets(cfgRows, base, base, cfg.L123_MIN_N));
}

function layer3Live(favLine, favSide, favOc, tlC) {
  if (favOc == null) return null;
  const base = _dbAll.filter(r => r.fav_line === favLine && r.fav_side === favSide);
  if (base.length < cfg.L123_MIN_N) return null;
  const oddsBand = ODDS_BANDS.find(b => inBand(favOc, b));
  const tlBand   = Object.values(TL_BANDS).find(b => inBand(tlC, b));
  const cfgRows  = base.filter(r => inBand(r.fav_oc, oddsBand) && (tlBand ? inBand(r.tl_c, tlBand) : true));
  if (cfgRows.length < cfg.L123_MIN_N) return null;
  return l123BestQualifying(scoreBets(cfgRows, base, base, cfg.L123_MIN_N));
}

const l123Dedup = new Dedup(24 * 60 * 60 * 1000);

// apiFootballCheck: null (not configured/not attempted), or
// { supported, odds } from verifyBet365Price — used to build a line telling
// the user directly whether the live price clears the target, so they don't
// have to open Bet365 themselves to check.
function apiFootballLine(bet, apiFootballCheck) {
  if (!apiFootballCheck) return null;
  if (!apiFootballCheck.supported) return `🔍 Bet365 odds (api-football): not available for this market type`;
  if (apiFootballCheck.odds == null) return `🔍 Bet365 odds (api-football): fixture/price not found`;
  const odds = apiFootballCheck.odds;
  const minOdds = bet.mo_lo;
  const ok = minOdds == null || odds >= minOdds;
  return ok
    ? `✅ Bet365 odds (api-football): @${odds.toFixed(2)} — ODDS OK (≥ min @${minOdds ?? '—'})`
    : `⚠️ Bet365 odds (api-football): @${odds.toFixed(2)} — ODDS LOWER than min @${minOdds ?? '—'}`;
}

function l123Format(match, agreeCount, bet, votes, toKickoff, liveOdds, apiFootballCheck) {
  // The action line is the single thing to actually do — put it right under
  // the bet name, bolded, with a clear pass/fail marker against live price
  // (always ✅ here: runStrategyL123 already skips the alert otherwise).
  const actionLine = liveOdds != null
    ? `✅ Bet  @${liveOdds.toFixed(2)} — clears the min (≥ @${bet.mo_lo ?? '—'})`
    : `📌 Bet at ≥ <b>@${bet.mo_lo ?? '—'}</b>  (best case @${bet.mo ?? '—'})`;
  const afLine = apiFootballLine(bet, apiFootballCheck);
  const kickoffLine = toKickoff != null
    ? `Kickoff in ${Math.max(0, Math.round(toKickoff))} min`
    : 'Kickoff imminent';
  return buildMessage(
    `L123 ALERT (pre-match) — ${agreeCount}/3 layers agree`,
    match,
    kickoffLine,
    [
      `💰 <b>${esc(bet.label)}</b>`,
      actionLine,
      ...(afLine ? [afLine] : []),
      ``,
      `📊 HitRate ${bet.p.toFixed(1)}% (baseline +${bet.edge.toFixed(1)}%)`,
      `🔎 Confidence: z=${bet.z.toFixed(2)} (n=${bet.n})`,
      `🔀 Layers : ${votes.join(', ')}`,
    ],
  );
}

// The only bet types with a live Bet365 price already in the feed
// (match.bet365_odds) — the 4 with a 1:1 marketOddsKey in engine.js's BETS.
// For everything else there is no live price to check against.
function liveOddsForBet(betKey, odds, favSide) {
  if (betKey === 'ahCover')  return favSide === 'HOME' ? odds.ho_c : odds.ao_c;
  if (betKey === 'dogCover') return favSide === 'HOME' ? odds.ao_c : odds.ho_c;
  if (betKey === 'overTL')   return odds.ov_c;
  if (betKey === 'underTL')  return odds.un_c;
  return null;
}

async function runStrategyL123(match, ctx) {
  const { matchId, label, tier, liveMin, toKickoff, isL123Fire } = ctx;

  if (!cfg.L123_ENABLED) return;
  if (!isL123Fire) {
    flogv(liveMin, label, 'L123', `SKIP: not in the pre-match window (toKickoff=${toKickoff != null ? Math.round(toKickoff) + 'm' : '—'})`);
    return;
  }
  if (!tierAllowed(tier, cfg.L123_TIER)) { flogv(liveMin, label, 'L123', `SKIP: tier=${tier} not in ${cfg.L123_TIER}`); return; }
  if (!_dbAll || !_dbAll.length) { flog(liveMin, label, 'L123', 'SKIP: DB empty'); return; }

  const odds = match.bet365_odds;
  if (!odds) { flogv(liveMin, label, 'L123', 'SKIP: no Bet365 odds'); return; }

  const matchCfg = buildCfgFromMatch(odds, { LINE_MOVE_ON: true, FAV_ODDS_ON: true, DOG_ODDS_ON: true, TL_MOVE_ON: true });
  if (!matchCfg) { flogv(liveMin, label, 'L123', 'SKIP: odds incomplete'); return; }

  const favLine = matchCfg.signals.favLine;
  const favSide = matchCfg.signals.favSide;
  const favOc   = favSide === 'HOME' ? odds.ho_c : odds.ao_c;
  const favOo   = favSide === 'HOME' ? odds.ho_o : odds.ao_o;
  const tlO     = odds.tl_o;
  const tlC     = odds.tl_c;

  const r1 = layer1Live(favLine, favSide, favOo, tlO);
  const r2 = layer2Live({
    fav_line: matchCfg.fav_line, fav_side: favSide,
    line_move: matchCfg.line_move, fav_odds_move: matchCfg.fav_odds_move,
    dog_odds_move: matchCfg.dog_odds_move, tl_move: matchCfg.tl_move,
  });
  const r3 = layer3Live(favLine, favSide, favOc, tlC);

  const recs = [
    r1 && { rec: r1, name: 'L1(open)' },
    r2 && { rec: r2, name: 'L2(move)' },
    r3 && { rec: r3, name: 'L3(close)' },
  ].filter(Boolean);

  if (recs.length < cfg.L123_MIN_AGREE) {
    flogv(liveMin, label, 'L123', `SKIP: only ${recs.length}/3 layers have a qualifying rec (L1=${r1 ? r1.k : '—'} L2=${r2 ? r2.k : '—'} L3=${r3 ? r3.k : '—'})`);
    return;
  }

  const counts = {};
  for (const { rec } of recs) counts[rec.k] = (counts[rec.k] || 0) + 1;
  const [topKey, topCount] = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];

  if (topCount < cfg.L123_MIN_AGREE) {
    flogv(liveMin, label, 'L123', `SKIP: no agreement (best=${topCount}/3 on ${topKey})`);
    return;
  }

  const agreeing = recs.filter(x => x.rec.k === topKey);
  const bet      = agreeing[0].rec;
  const votes    = agreeing.map(x => x.name);

  // For the 4 bet types with a live Bet365 price in the feed, require the
  // actual live price to still clear the conservative (Wilson lower-bound)
  // min odds before alerting — otherwise the "edge" only existed on paper.
  const liveOdds = liveOddsForBet(topKey, odds, favSide);
  if (liveOdds != null && bet.mo_lo != null && liveOdds < bet.mo_lo) {
    flogv(liveMin, label, 'L123', `SKIP: live price @${liveOdds.toFixed(2)} below conservative min @${bet.mo_lo} for ${topKey}`);
    return;
  }

  const dedupKey = `${matchId}:l123:${topKey}`;
  if (l123Dedup.has(dedupKey)) { flogv(liveMin, label, 'L123', 'SKIP: already notified'); return; }

  // Informational only — does NOT change whether the alert fires (that
  // decision is already made above). Just fetches an independent live price
  // so the message can tell you "odds OK"/"odds lower" directly, without
  // touching L123's own picking/gating logic. Only called here, right before
  // sending, never on every scan cycle — see config.js's APIFOOTBALL_KEY note.
  let apiFootballCheck = null;
  if (cfg.APIFOOTBALL_KEY) {
    try {
      apiFootballCheck = await verifyBet365Price(topKey, {
        matchId, homeTeam: match.home_team, awayTeam: match.away_team,
        favSide, favLine, avgTl: bet.avgTl,
      }, cfg.APIFOOTBALL_KEY);
    } catch (e) {
      flogv(liveMin, label, 'L123', `api-football check failed: ${e.message}`);
    }
  }

  const msg = l123Format(match, topCount, bet, votes, toKickoff, liveOdds, apiFootballCheck);
  await sendTelegram(msg);
  l123Dedup.mark(dedupKey);
  flog(liveMin, label, 'L123', `ALERT: ${topCount}/3 agree on ${topKey} edge=${bet.edge.toFixed(1)}pp z=${bet.z.toFixed(2)} n=${bet.n} tier=${tier}`);

  // Log this alert so the track record can settle it once the match ends and
  // report back on how it actually did — see track_record.js. Never affects
  // whether the alert fired; purely a record for later reporting.
  recordAlert({
    matchId, homeTeam: match.home_team, awayTeam: match.away_team,
    league: match.league, tier,
    fixtureId: apiFootballCheck?.fixtureId ?? null,
    betKey: topKey, betLabel: bet.label,
    favSide, favLine, tlLine: tlC,
    priceAtAlert: liveOdds ?? apiFootballCheck?.odds ?? null,
    mo: bet.mo, mo_lo: bet.mo_lo,
  });
}

// ── Strategy LATEGOAL — "still no 2H goal" watch ──────────────────────────────
// See config.js's LATEGOAL_* block for the full design rationale.

// matchId -> { home, away, ts } — the score captured the first time a match
// is observed at HT. Kept in memory only (like l123Dedup) — acceptable
// staleness on a process restart mid-match, same tradeoff L123 already makes.
const _htSnapshots = new Map();
const HT_SNAPSHOT_WINDOW = [44, 50]; // live-minute range in which to capture
const HT_SNAPSHOT_TTL = 4 * 60 * 60 * 1000; // 4h — generous, matches never run this long

function parseScoreStr(scoreStr) {
  const m = String(scoreStr || '').match(/^(\d+)\s*-\s*(\d+)$/);
  if (!m) return null;
  return { home: parseInt(m[1], 10), away: parseInt(m[2], 10) };
}

function captureHtSnapshot(matchId, liveMin, scoreStr) {
  if (liveMin < HT_SNAPSHOT_WINDOW[0] || liveMin > HT_SNAPSHOT_WINDOW[1]) return;
  if (_htSnapshots.has(matchId)) return;
  const score = parseScoreStr(scoreStr);
  if (!score) return;
  _htSnapshots.set(matchId, { ...score, ts: Date.now() });
}

function cleanupHtSnapshots() {
  const now = Date.now();
  for (const [k, v] of _htSnapshots) {
    if (now - v.ts > HT_SNAPSHOT_TTL) _htSnapshots.delete(k);
  }
}

const lateGoalDedup = new Dedup(24 * 60 * 60 * 1000);

function lateGoalQualifies(b) {
  return b.n >= cfg.LATEGOAL_MIN_N && b.z >= cfg.LATEGOAL_MIN_Z
    && (b.lo - b.bl) >= cfg.LATEGOAL_MIN_EDGE && b.bl >= cfg.LATEGOAL_MIN_BASELINE;
}

// True exactly when `betKey` (favScored2H/homeScored2H/awayScored2H) is
// mathematically equivalent to "BTTS Yes" given the current (still-HT)
// score — the team this bet is about has 0 goals so far and the opponent
// has >=1, so the opponent has already satisfied BTTS's other half. Lets
// the alert offer a REAL, commonly-quoted live market (BTTS) instead of an
// unpriced synthetic one for these bet types.
function bttsEquivalent(betKey, htSnap, favSide) {
  if (betKey === 'favScored2H') {
    const favHt = favSide === 'HOME' ? htSnap.home : htSnap.away;
    const dogHt = favSide === 'HOME' ? htSnap.away : htSnap.home;
    return favHt === 0 && dogHt >= 1;
  }
  if (betKey === 'homeScored2H') return htSnap.home === 0 && htSnap.away >= 1;
  if (betKey === 'awayScored2H') return htSnap.away === 0 && htSnap.home >= 1;
  return false;
}

function lateGoalFormat(match, bet, liveMin, htSnap, liveOdd, isBttsEquivalent, apiFootballCheck) {
  const liveLine = liveOdd.fair_odd != null
    ? `📌 Live fair odds now: <b>@${liveOdd.fair_odd}</b> (${liveOdd.live_p}% live prob) — check Bet365's in-play price against this`
    : `📌 Live estimate unavailable for this bet type`;
  const bttsNote = isBttsEquivalent
    ? [`♻️ Equivalent to <b>BTTS Yes</b> at this score (opponent already scored) — check that market on Bet365 instead.`]
    : [];
  const afLine = apiFootballLine(bet, apiFootballCheck);
  return buildMessage(
    `LATEGOAL WATCH — still no 2H goal`,
    match,
    `${liveMin}' · HT ${htSnap.home}-${htSnap.away}, still ${htSnap.home}-${htSnap.away}`,
    [
      `💰 <b>${esc(bet.label)}</b>`,
      liveLine,
      ...bttsNote,
      ...(afLine ? [afLine] : []),
      ``,
      `📊 HT-anchor HitRate ${bet.p.toFixed(1)}% (baseline +${bet.edge.toFixed(1)}%)`,
      `🔎 Confidence: z=${bet.z.toFixed(2)} (n=${bet.n})`,
      `✅ Walk-forward validated (2026-08-22): 34,596 flagged HT-state/bet instances across 10 held-out months, claimed 65.9% vs. realized 64.5% — well-calibrated, unlike the original L123 movement-signal gate.`,
    ],
  );
}

async function runStrategyLateGoal(match, ctx) {
  const { matchId, label, tier, liveMin } = ctx;

  if (!cfg.LATEGOAL_ENABLED) return;
  if (liveMin == null || liveMin < cfg.LATEGOAL_TRIGGER_MINUTE) return;
  if (!tierAllowed(tier, cfg.LATEGOAL_TIER)) { flogv(liveMin, label, 'LATEGOAL', `SKIP: tier=${tier} not in ${cfg.LATEGOAL_TIER}`); return; }
  if (!_dbAll || !_dbAll.length) return;

  const dedupKey = `${matchId}:lategoal`;
  if (lateGoalDedup.has(dedupKey)) return;

  const htSnap = _htSnapshots.get(matchId);
  if (!htSnap) { flogv(liveMin, label, 'LATEGOAL', 'SKIP: no HT snapshot captured for this match'); return; }

  const curScore = parseScoreStr(match.score);
  if (!curScore) { flogv(liveMin, label, 'LATEGOAL', 'SKIP: current score unparseable'); return; }
  if (curScore.home !== htSnap.home || curScore.away !== htSnap.away) {
    flogv(liveMin, label, 'LATEGOAL', `SKIP: already scored since HT (HT ${htSnap.home}-${htSnap.away} -> now ${curScore.home}-${curScore.away})`);
    return;
  }

  const odds = match.bet365_odds;
  if (!odds) { flogv(liveMin, label, 'LATEGOAL', 'SKIP: no Bet365 odds'); return; }
  const matchCfg = buildCfgFromMatch(odds, { LINE_MOVE_ON: true, FAV_ODDS_ON: true, DOG_ODDS_ON: true, TL_MOVE_ON: true });
  if (!matchCfg) { flogv(liveMin, label, 'LATEGOAL', 'SKIP: odds incomplete'); return; }

  const favLine = matchCfg.signals.favLine;
  const favSide = matchCfg.signals.favSide;

  const base = _dbAll.filter(r => r.fav_line === favLine && r.fav_side === favSide);
  if (base.length < cfg.LATEGOAL_MIN_N) { flogv(liveMin, label, 'LATEGOAL', 'SKIP: base pool too small'); return; }

  const gs = { trigger: 'HT', home_goals: String(htSnap.home), away_goals: String(htSnap.away) };
  const gsRows = applyGameState(base, gs);
  if (gsRows.length < cfg.LATEGOAL_MIN_N) { flogv(liveMin, label, 'LATEGOAL', `SKIP: only ${gsRows.length} historical matches reached this HT state`); return; }

  const allBets = scoreBets(gsRows, base, base, cfg.LATEGOAL_MIN_N);
  const candidates = allBets.filter(b => cfg.LATEGOAL_BETS.includes(b.k) && lateGoalQualifies(b));
  if (!candidates.length) { flogv(liveMin, label, 'LATEGOAL', 'SKIP: no qualifying goal-in-2H bet'); return; }

  candidates.sort((a, b) => (b.z * b.lo / 100) - (a.z * a.lo / 100));
  const bet = candidates[0];

  // favG2h/dogG2h are always 0 here — that's the entire trigger condition
  // (no goal since HT yet).
  const liveOdd = computeLiveOdd(bet.p, bet.k, liveMin, favLine, 0, 0, favSide);

  const isBtts = bttsEquivalent(bet.k, htSnap, favSide);
  let apiFootballCheck = null;
  if (isBtts && cfg.APIFOOTBALL_KEY) {
    try {
      apiFootballCheck = await verifyBet365Price('btts', {
        matchId, homeTeam: match.home_team, awayTeam: match.away_team,
        favSide, favLine, avgTl: null,
      }, cfg.APIFOOTBALL_KEY);
    } catch (e) {
      flogv(liveMin, label, 'LATEGOAL', `api-football BTTS check failed: ${e.message}`);
    }
  }

  const msg = lateGoalFormat(match, bet, liveMin, htSnap, liveOdd, isBtts, apiFootballCheck);
  await sendTelegram(msg);
  lateGoalDedup.mark(dedupKey);
  flog(liveMin, label, 'LATEGOAL', `ALERT: ${bet.k} p=${bet.p.toFixed(1)}% z=${bet.z.toFixed(2)} n=${bet.n} liveOdd=${liveOdd.fair_odd} btts=${isBtts} tier=${tier}`);

  recordAlert({
    matchId, homeTeam: match.home_team, awayTeam: match.away_team,
    league: match.league, tier,
    fixtureId: null, betKey: bet.k, betLabel: bet.label,
    favSide, favLine, tlLine: odds.tl_c,
    priceAtAlert: null, // no real bookmaker price captured for this bet type — see LATEGOAL config comment
    mo: bet.mo, mo_lo: bet.mo_lo,
  });
}

// ── Hash-failure alert (once per failed hash value) ──────────────────────────
const _hashAlerted = new Set();
async function notifyHashFailed(bookmaker, shortHash) {
  const key = `${bookmaker}:${shortHash}`;
  if (_hashAlerted.has(key)) return;
  _hashAlerted.add(key);
  const msg = `⚠️ <b>${esc(bookmaker)} hash invalid</b>\n\nThe bookmaker hash <code>${esc(shortHash)}…</code> returned 404.\nUpdate <code>${esc(bookmaker === 'Pinnacle' ? 'PINNACLE_HASH' : bookmaker === 'Bet365' ? 'BET365_HASH' : 'SBOBET_HASH')}</code> in <code>livescore.js</code>.`;
  console.log(`Hash alert: ${bookmaker} hash ${shortHash} is invalid — sending Telegram notification`);
  await sendTelegram(msg);
}

// ── Match fetcher (live matches only — L123 fires early live, not pre-match) ─
// Always goes straight to Bet365 via livescore.js's own hash discovery — NOT
// through the Cloudflare Pages Function (functions/api/livescore.js), which
// is still Pinnacle-oriented and wasn't updated for the Bet365 migration.
// DATA_URL only controls where the historical CSV dataset is loaded from
// (see loadDb()) — it's unrelated to live match fetching.
async function fetchMatches() {
  const liveResult = await fetchLiveMatches();
  if (liveResult.bet365HashFailed) await notifyHashFailed('Bet365', (liveResult.bet365Hash || '????????').slice(0, 8));
  return liveResult.matches;
}

// ── Scan loop ─────────────────────────────────────────────────────────────────
async function runScan() {
  _scanAlerts = 0;
  console.log(`[${new Date().toISOString()}] Scanning…`);

  let matches;
  try { matches = await fetchMatches(); }
  catch (e) { console.error(`Livescore fetch failed: ${e.message}`); return; }

  if (!matches.length) { console.log('No matches found.'); return; }

  let inWindowCount = 0;

  for (const match of matches) {
    const ctx = matchContext(match);
    const { matchId, label, tier, liveMin, toKickoff, isL123Fire } = ctx;

    // HT snapshot capture happens for every live match regardless of which
    // strategy (if any) fires — LateGoal needs it much later (at 70'+), so
    // it has to be recorded the moment a match passes through HT, not just
    // when a strategy happens to be checking that match right now.
    if (liveMin != null) captureHtSnapshot(matchId, liveMin, match.score);

    if (isL123Fire) {
      inWindowCount++;
      flogv(liveMin, `${label} [${tier}]`, 'ALL', `pre-match, kickoff in ${Math.round(toKickoff)}m  bet365_odds=${match.bet365_odds ? 'ok' : 'MISSING'}`);
      await runStrategyL123(match, ctx);
    } else if (liveMin != null) {
      flogv(liveMin, `${label} [${tier}]`, 'ALL', `live ${liveMin}'  score=${match.score || '—'}`);
      await runStrategyLateGoal(match, ctx);
    } else {
      flogv(liveMin, `${label} [${tier}]`, 'ALL', `not in pre-match window (liveMin=— toKickoff=${toKickoff != null ? Math.round(toKickoff) + 'm' : '—'})`);
    }
  }

  cleanupHtSnapshots();
  console.log(`Scan done — ${matches.length} matches · ${inWindowCount} pre-match · ${_scanAlerts} alert(s) sent.`);
}

// ── Track record: settle finished matches + send a daily scorecard ───────────
async function runSettlementCheck() {
  try {
    const { checked, settled } = await settlePendingAlerts(cfg.APIFOOTBALL_KEY);
    if (checked) console.log(`[track_record] Checked ${checked} pending alert(s), settled ${settled}.`);
  } catch (e) {
    console.error(`[track_record] Settlement check failed: ${e.message}`);
  }
}

async function maybeSendDailyDigest() {
  const today = new Date().toISOString().slice(0, 10);
  const state = loadState();
  if (state.lastDigestDate === today) return; // already sent today
  try {
    const msg = buildDigestMessage(7);
    await sendTelegram(msg);
    saveState({ ...state, lastDigestDate: today });
    console.log('[track_record] Daily digest sent.');
  } catch (e) {
    console.error(`[track_record] Digest send failed: ${e.message}`);
  }
}

// ── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  const once = process.argv.includes('--once');

  await loadDb();

  const on = s => s ? 'ON ' : 'OFF';
  console.log(`Strategy L123 [${on(cfg.L123_ENABLED)}][${cfg.L123_TIER}]: Layer 1(open)/2(move)/3(close) consensus  minAgree=${cfg.L123_MIN_AGREE}/3  fire=${PRE_MATCH_WINDOW_MIN}min pre-kickoff window  n≥${cfg.L123_MIN_N} z≥${cfg.L123_MIN_Z} edge≥${cfg.L123_MIN_EDGE}pp bl≥${cfg.L123_MIN_BASELINE}%`);
  console.log(`Global tier default: ${cfg.LEAGUE_TIER}`);

  // Refresh all book hashes at startup
  await refreshHashes();

  if (once) {
    await runScan();
    process.exit(0);
  }

  console.log(`Scheduler started — every ${cfg.SCAN_INTERVAL_MINUTES} min.`);
  await runScan();
  cron.schedule(`*/${cfg.SCAN_INTERVAL_MINUTES} * * * *`, runScan);
  // Refresh hashes daily at 06:00 UTC (hashes rotate ~once/day)
  cron.schedule('0 6 * * *', () => refreshHashes().catch(e => console.error('Hash refresh error:', e)));
  // Track record: check for newly-finished matches every 30 min (cheap —
  // zero API calls once nothing outstanding is old enough to check), and
  // send a scorecard digest once/day if APIFOOTBALL_KEY is configured.
  cron.schedule('*/30 * * * *', runSettlementCheck);
  cron.schedule('0 8 * * *', maybeSendDailyDigest);
}

main().catch(e => { console.error(e); process.exit(1); });
