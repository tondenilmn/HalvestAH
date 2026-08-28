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
const http = require('http');
const cron = require('node-cron');
const cfg  = require('./config');
const {
  classifyLeague,
  loadDatabase,
  loadDatabaseFromUrl,
  buildCfgFromMatch,
  applyConfig,
  applyBaselineConfig,
  applyGameState,
  scoreBets,
  mergeCrossFit,
  BETS,
  VALID_LINES,
} = require('./engine');
const { fetchLiveMatches, fetchNextMatches, refreshHashes, getCurrentHashes } = require('./livescore');
const { verifyBet365Price } = require('./apifootball');
const { recordAlert, settlePendingAlerts, buildDigestMessage, loadState, saveState } = require('./track_record');
const { computeLiveOdd, computeLiveResult2H, computeLiveBtts2H, _2hResultField, _2H_RESULT_KEYS, mcLiveLo, mcLiveHi } = require('./live_odds');
// 2026-08-29: switched from `require('../static/...')` to local copies —
// Railway's Docker build context is scoped to telegram/ only, so a require
// reaching outside it (`../static/`) throws MODULE_NOT_FOUND in production
// even though it works locally. See telegram/live_model.js's header "Sync
// requirement" note for the hand-mirroring convention this now follows
// (same one telegram/live_odds.js already used).
const LM = require('./live_model.js'); // E8 — new pricing engine, see Strategy NEWMODEL below
const { solveLambdaFromOdds } = require('./live_lambda_solver.js'); // AH+O/U-only per-match implied lambda (fixes the lambda_lookup.json bucket-fallback circularity — see runStrategyNewModel)

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
// Phase 0 fix 0.4 (mirrors static/app.js's parseLiveMinute): keeps the "+N"
// stoppage-time offset instead of discarding it — "90+4" -> 94, "45+2" -> 47
// — so live_odds.js's stoppage-time decay (_STOP_MIN_2H) actually receives a
// minute that keeps advancing through injury time instead of being frozen
// at 90 for its entire duration.
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
    isL123Fire:      liveMin == null && toKickoff != null && toKickoff >= 0 && toKickoff <= PRE_MATCH_WINDOW_MIN,
    isDashboardFire: liveMin == null && toKickoff != null && toKickoff >= 0 && toKickoff <= cfg.DASHBOARD_WINDOW_MIN,
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
function tlBandOf(v) {
  return Object.entries(TL_BANDS).find(([, b]) => inBand(v, b))?.[0] ?? null;
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

// Shows the two numbers needed to decide/size the bet as explicit, separate
// figures — the minimum odds to check for (`minOdds`, the target/mo_lo or
// fair-odds floor) and the actual live price found (`odds`) — rather than
// folding them into one prose sentence. `marketLabel` names the market the
// price is actually FOR (may differ from the bet's own label — e.g.
// "Over 2.5 FT" standing in for "Over 0.5 2H").
function realPriceVerdict(marketLabel, odds, minOdds) {
  const targetStr = minOdds != null ? `@${minOdds.toFixed(2)}` : '—';
  if (odds == null) {
    return `🎯 Target: ${targetStr}  ·  📖 Bet365 ${marketLabel}: not found — check manually`;
  }
  const clears = minOdds == null || odds >= minOdds;
  return `${clears ? '✅' : '❌'} 🎯 Target: ${targetStr}  ·  📖 Bet365 ${marketLabel}: @${odds.toFixed(2)}${clears ? '' : ' (below target — skip)'}`;
}

// Track-record recording gate: only log an alert to track_record.js if we
// actually have a real, verified price AND it clears the advised/target
// fair odds — an alert that fires but shows a price below target (or no
// price at all) still gets sent to Telegram (so the user sees it and can
// check Bet365 manually), but is deliberately excluded from the track
// record so hit-rate/ROI reporting only reflects genuinely bettable picks.
function verifiedGoodPrice(price, minOdds) {
  return price != null && minOdds != null && price >= minOdds;
}

// apiFootballCheck: null (not attempted/configured), or { supported, odds }
// from verifyBet365Price. marketLabel is what to call the market in the
// message (may be a substituted equivalent market, not the bet's own name).
function apiFootballVerdictLine(marketLabel, minOdds, apiFootballCheck) {
  if (!apiFootballCheck) return null;
  if (!apiFootballCheck.supported) return `ℹ️ No automated price check for this market — check Bet365 yourself.`;
  return realPriceVerdict(marketLabel, apiFootballCheck.odds, minOdds);
}

// Kelly stake %, computed off the actual price found (not the target/mo_lo)
// and the Wilson CI *lower-bound* probability (bet.lo), not the raw point
// estimate (bet.p) — bet.p is winner's-curse-inflated (same reason mo_lo
// uses the CI lower bound instead of bet.p for the "clears the target"
// gate), so feeding it straight into Kelly would systematically overstake.
// f* = p - (1-p)/b, where b = decimal odds - 1. Returns null if there's no
// price to size against or the CI-lower-bound edge doesn't clear this price
// (can happen even when the price "clears the target," since mo_lo is a
// break-even floor, not the price Kelly needs to show a positive edge).
function kellyLine(price, loPct) {
  if (price == null || loPct == null) return null;
  const b = price - 1;
  if (b <= 0) return null;
  const p = loPct / 100;
  const f = p - (1 - p) / b;
  if (f <= 0) {
    return `💰 Kelly: no edge at this price on the conservative (CI-lower) ${loPct.toFixed(0)}% estimate — sizing not advised.`;
  }
  const full = f * 100;
  return `💰 Kelly stake: ${full.toFixed(1)}% of bankroll (half-Kelly: ${(full / 2).toFixed(1)}%) — based on CI-lower ${loPct.toFixed(0)}% @ ${price.toFixed(2)}`;
}

// Standalone probability line, always shown (unlike kellyLine, which only
// prints once a real price has been found) — so there's always a number to
// manually plug into a Kelly calculator/tracker even when no verified price
// was available for this alert, or the user wants to size against a
// different bookmaker's price than the one checked. Prints the same
// CI-lower-bound probability kellyLine() itself sizes off (bet.lo for L123,
// the CI-lower live-decayed rate for LATEGOAL/QUIET2H) — not the raw
// point-estimate historical rate in the "📊 x% historically" line, which is
// winner's-curse-inflated and would overstake if used directly for Kelly.
function modelProbLine(pct) {
  if (pct == null) return null;
  return `🎲 Model probability (for manual Kelly): ${pct.toFixed(1)}%`;
}

function l123Format(match, agreeCount, bet, votes, toKickoff, liveOdds, apiFootballCheck, odds) {
  const actualPrice = liveOdds != null ? liveOdds : (apiFootballCheck?.supported ? apiFootballCheck.odds : null);
  const verdictLine = liveOdds != null
    ? realPriceVerdict(bet.label, liveOdds, bet.mo_lo)
    : apiFootballVerdictLine(bet.label, bet.mo_lo, apiFootballCheck) ?? realPriceVerdict(bet.label, null, bet.mo_lo);
  const kellyLn = kellyLine(actualPrice, bet.lo);
  const kickoffLine = toKickoff != null
    ? `Kickoff in ${Math.max(0, Math.round(toKickoff))} min`
    : 'Kickoff imminent';
  const moveLine = lineMovementLine(odds);
  return buildMessage(
    `L123 — pre-match pick (${agreeCount}/3 signals agree)`,
    match,
    kickoffLine,
    [
      `👉 <b>${esc(bet.label)}</b>`,
      verdictLine,
      ...(bet.lo != null ? [modelProbLine(bet.lo)] : []),
      ...(kellyLn ? [kellyLn] : []),
      ...(moveLine ? [moveLine] : []),
      `📊 ${bet.p.toFixed(0)}% historically vs ${bet.bl.toFixed(0)}% baseline (n=${bet.n}) · agreed by ${votes.join(', ')}`,
    ],
  );
}

// Formats the AH line and Total Line's opening-vs-current movement as one
// compact line — the raw home-team-oriented values (sign as Bet365 itself
// shows: negative = home favoured), not fav/dog-reoriented, so it reads
// exactly like what's on the bookmaker screen.
function lineMovementLine(odds) {
  if (!odds) return null;
  const fmtAh = v => v == null ? '—' : (v > 0 ? '+' : '') + v.toFixed(2);
  const fmtTl = v => v == null ? '—' : v.toFixed(2);
  const ahText = (odds.ah_ho != null || odds.ah_hc != null) ? `AH ${fmtAh(odds.ah_ho)} → ${fmtAh(odds.ah_hc)}` : null;
  const tlText = (odds.tl_o != null || odds.tl_c != null) ? `TL ${fmtTl(odds.tl_o)} → ${fmtTl(odds.tl_c)}` : null;
  const parts = [ahText, tlText].filter(Boolean);
  return parts.length ? `📈 ${parts.join('   ')}` : null;
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

  const msg = l123Format(match, topCount, bet, votes, toKickoff, liveOdds, apiFootballCheck, odds);
  await sendTelegram(msg);
  l123Dedup.mark(dedupKey);
  flog(liveMin, label, 'L123', `ALERT: ${topCount}/3 agree on ${topKey} edge=${bet.edge.toFixed(1)}pp z=${bet.z.toFixed(2)} n=${bet.n} tier=${tier}`);

  // Log this alert so the track record can settle it once the match ends and
  // report back on how it actually did — see track_record.js. Never affects
  // whether the alert fired; purely a record for later reporting. Only
  // recorded if we have a real, verified price that actually clears the
  // target — see verifiedGoodPrice's comment.
  const l123Price = liveOdds ?? (apiFootballCheck?.supported ? apiFootballCheck.odds : null);
  if (verifiedGoodPrice(l123Price, bet.mo_lo)) {
    recordAlert({
      matchId, homeTeam: match.home_team, awayTeam: match.away_team,
      league: match.league, tier,
      fixtureId: apiFootballCheck?.fixtureId ?? null,
      betKey: topKey, betLabel: bet.label,
      favSide, favLine, tlLine: tlC,
      priceAtAlert: l123Price,
      mo: bet.mo, mo_lo: bet.mo_lo,
      strategy: 'L123', venue: 'soft', minute: null,
      state: { score: null, redCards: 0, half: null },
    });
  } else {
    flogv(liveMin, label, 'L123', 'Not recorded to track record — no verified price clearing target.');
  }
}

// ── Strategy DASHBOARD — cross-fit opening-odds pick ─────────────────────────
// Mirrors the Web UI's Daily Dashboard pick (static/app.js's
// openingOddsSignal) — see config.js's DASHBOARD_* block for the full design
// rationale and backtest numbers.
const dashboardDedup = new Dedup(24 * 60 * 60 * 1000);

// Same 13 FT/pre-match markets the Dashboard restricts itself to — everything
// else (AH cover, any 1H/2H market) needs either in-play state or a
// bookmaker line this signal doesn't have pre-match.
const _DASHBOARD_BET_KEYS = new Set([
  'homeWinsFT', 'drawFT', 'awayWinsFT',
  'over15FT', 'over25FT', 'under15FT', 'under25FT',
  'btts', 'noBtts',
  'homeOver05FT', 'homeOver15FT', 'awayOver05FT', 'awayOver15FT',
]);
const _DASHBOARD_BET_DEFS = BETS.filter(b => _DASHBOARD_BET_KEYS.has(b.k));

function dashboardQualifies(b) {
  return !!b && b.n >= cfg.DASHBOARD_MIN_N && b.z >= cfg.DASHBOARD_MIN_Z && (b.lo - b.bl) >= cfg.DASHBOARD_MIN_EDGE;
}

// pool -> the 13-key scored bet list for the opening-odds band + opening TL
// cluster this match falls into. Shared by the full pool and each fold.
function dashboardPickFromPool(pool, oddsBand, tlBand) {
  const cfgRows = pool.filter(r => inBand(r.fav_oo, oddsBand) && (tlBand ? inBand(r.tl_o, tlBand) : true));
  if (cfgRows.length < cfg.DASHBOARD_MIN_N) return [];
  return scoreBets(cfgRows, pool, pool, cfg.DASHBOARD_MIN_N).filter(b => _DASHBOARD_BET_KEYS.has(b.k));
}

function dashboardFormat(match, bet, toKickoff, apiFootballCheck, equivalent) {
  const marketLabel = equivalent ? equivalent.label : bet.label;
  const verdictLine = apiFootballVerdictLine(marketLabel, bet.mo_lo, apiFootballCheck) ?? realPriceVerdict(marketLabel, null, bet.mo_lo);
  const actualPrice = apiFootballCheck?.supported ? apiFootballCheck.odds : null;
  const kellyLn = kellyLine(actualPrice, bet.lo);
  const kickoffLine = toKickoff != null ? `Kickoff in ${Math.max(0, Math.round(toKickoff))} min` : 'Kickoff imminent';
  return buildMessage(
    `Dashboard — opening-odds pick`,
    match,
    kickoffLine,
    [
      `👉 <b>${esc(bet.label)}</b>`,
      verdictLine,
      ...(bet.lo != null ? [modelProbLine(bet.lo)] : []),
      ...(kellyLn ? [kellyLn] : []),
      `📊 ${bet.p.toFixed(0)}% historically vs ${bet.bl.toFixed(0)}% baseline (n=${bet.n})${bet._pricedFold ? ` · cross-fit priced by fold ${bet._pricedFold}` : ''}`,
    ],
  );
}

// homeWinsFT/awayWinsFT/drawFT/btts are directly in api-football's SUPPORTED
// set (verifyBet365Price) — no substitution needed. over15FT/over25FT and
// under15FT/under25FT re-express as Over/Under (fixed line) FT, which
// verifyBet365Price already knows how to look up via overTL/underTL.
// noBtts and the FT team-total markets (homeOver05FT etc.) have no
// equivalence — left unsupported, same fallback as LATEGOAL/QUIET2H/HTPICK.
function equivalentRealMarketDashboard(betKey) {
  if (betKey === 'homeWinsFT' || betKey === 'awayWinsFT' || betKey === 'drawFT' || betKey === 'btts') {
    const def = BETS.find(b => b.k === betKey);
    return { apiKey: betKey, avgTl: null, label: def ? def.label : betKey };
  }
  if (betKey === 'over15FT')  return { apiKey: 'overTL',  avgTl: 1.5, label: 'Over 1.5 FT' };
  if (betKey === 'over25FT')  return { apiKey: 'overTL',  avgTl: 2.5, label: 'Over 2.5 FT' };
  if (betKey === 'under15FT') return { apiKey: 'underTL', avgTl: 1.5, label: 'Under 1.5 FT' };
  if (betKey === 'under25FT') return { apiKey: 'underTL', avgTl: 2.5, label: 'Under 2.5 FT' };
  return null;
}

async function runStrategyDashboard(match, ctx) {
  const { matchId, label, tier, toKickoff } = ctx;

  if (!cfg.DASHBOARD_ENABLED) return;
  if (!tierAllowed(tier, cfg.DASHBOARD_TIER)) { flogv(null, label, 'DASHBOARD', `SKIP: tier=${tier} not in ${cfg.DASHBOARD_TIER}`); return; }
  if (!_dbAll || !_dbAll.length) return;

  const dedupKey = `${matchId}:dashboard`;
  if (dashboardDedup.has(dedupKey)) return;

  const odds = match.bet365_odds;
  if (!odds) { flogv(null, label, 'DASHBOARD', 'SKIP: no Bet365 odds'); return; }
  if (odds.ah_ho == null) { flogv(null, label, 'DASHBOARD', 'SKIP: no opening AH line'); return; }

  // Opening-odds-only context — deliberately ignores current/closing fields,
  // even though the feed has them (see static/app.js's deriveOpeningContext,
  // this mirrors it), since the whole point is a pick knowable well before
  // near-kickoff price movement.
  const favLc = Math.abs(odds.ah_ho);
  const favLine = VALID_LINES.find(v => Math.abs(favLc - v) < 0.13);
  if (favLine === undefined) { flogv(null, label, 'DASHBOARD', 'SKIP: opening line not a valid AH value'); return; }
  const favSide = odds.ah_ho < -0.01 ? 'HOME' : odds.ah_ho > 0.01 ? 'AWAY'
    : (odds.ho_o != null && odds.ao_o != null && odds.ho_o <= odds.ao_o) ? 'HOME' : 'AWAY';
  const favOo = favSide === 'HOME' ? odds.ho_o : odds.ao_o;
  if (favOo == null) { flogv(null, label, 'DASHBOARD', 'SKIP: no opening odds for favourite'); return; }

  const base = _dbAll.filter(r => r.fav_line === favLine && r.fav_side === favSide);
  if (base.length < cfg.DASHBOARD_MIN_N) { flogv(null, label, 'DASHBOARD', 'SKIP: base pool too small'); return; }

  const oddsBand = ODDS_BANDS.find(b => inBand(favOo, b));
  const tlBand = Object.values(TL_BANDS).find(b => inBand(odds.tl_o, b));

  const allBets = dashboardPickFromPool(base, oddsBand, tlBand);
  if (!allBets.length) { flogv(null, label, 'DASHBOARD', 'SKIP: no historical bets for this band'); return; }

  const foldBets = (fold) => {
    const fBase = base.filter(r => r.fold === fold);
    if (fBase.length < cfg.DASHBOARD_MIN_N) return [];
    return dashboardPickFromPool(fBase, oddsBand, tlBand);
  };
  const betsA = foldBets('A');
  const betsB = foldBets('B');
  const crossFit = (betsA.length && betsB.length) ? mergeCrossFit(betsA, betsB, _DASHBOARD_BET_DEFS, dashboardQualifies) : [];

  // Falls back to a plain single-pool qualifying check if either fold is too
  // thin (same discipline as static/app.js's openingOddsSignal) — but NEVER
  // to a non-qualifying "best guess" the way the Web UI dashboard does for
  // display purposes. A Telegram alert only ever fires on a real qualifying
  // bet.
  const qualifying = crossFit.length
    ? crossFit.sort((a, b) => (b.z * (b.lo / 100)) - (a.z * (a.lo / 100)))
    : allBets.filter(dashboardQualifies);
  if (!qualifying.length) { flogv(null, label, 'DASHBOARD', 'SKIP: no cross-fit qualifying bet'); return; }
  const bet = qualifying[0];

  const equivalent = equivalentRealMarketDashboard(bet.k);
  let apiFootballCheck = null;
  if (equivalent && cfg.APIFOOTBALL_KEY) {
    try {
      apiFootballCheck = await verifyBet365Price(equivalent.apiKey, {
        matchId, homeTeam: match.home_team, awayTeam: match.away_team,
        favSide, favLine, avgTl: equivalent.avgTl,
      }, cfg.APIFOOTBALL_KEY);
    } catch (e) {
      flogv(null, label, 'DASHBOARD', `api-football check failed: ${e.message}`);
    }
  }

  const msg = dashboardFormat(match, bet, toKickoff, apiFootballCheck, equivalent);
  await sendTelegram(msg);
  dashboardDedup.mark(dedupKey);
  flog(null, label, 'DASHBOARD', `ALERT: ${bet.k} p=${bet.p.toFixed(1)}% z=${bet.z.toFixed(2)} n=${bet.n} pricedFold=${bet._pricedFold ?? '—'} kickoffIn=${Math.round(toKickoff)}m tier=${tier}`);

  const dashboardPrice = apiFootballCheck?.supported ? apiFootballCheck.odds : null;
  if (verifiedGoodPrice(dashboardPrice, bet.mo_lo)) {
    recordAlert({
      matchId, homeTeam: match.home_team, awayTeam: match.away_team,
      league: match.league, tier,
      fixtureId: apiFootballCheck?.fixtureId ?? null, betKey: bet.k, betLabel: bet.label,
      favSide, favLine, tlLine: odds.tl_o,
      priceAtAlert: dashboardPrice,
      mo: bet.mo, mo_lo: bet.mo_lo,
      strategy: 'DASHBOARD', venue: 'soft', minute: null,
      state: { score: null, redCards: 0, half: null },
    });
  } else {
    flogv(null, label, 'DASHBOARD', 'Not recorded to track record — no verified price clearing target.');
  }
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

// over05_2H ("any goal happens") isn't a market a bookmaker actually lists,
// but once you condition on the current (unchanged-since-HT) score it's
// always equivalent to a real, directly quotable one: "Over (current total +
// 0.5) FT" — e.g. still 0-0 -> Over 0.5 FT; still 0-2, 2-0, or 1-1 (3 goals
// so far either way) -> Over 2.5 FT; still 0-1 or 1-0 -> Over 1.5 FT. One
// more goal, by either side, crosses that line by construction, since the
// current total is fixed until it happens.
// (LATEGOAL_BETS only ever contains over05_2H as of 2026-08-24 — the
// favScored2H/homeScored2H/awayScored2H variants were dropped, see
// config.js's LATEGOAL_BETS comment — so this only needs to handle that one
// key. Returns { apiKey, avgTl, label } — the args verifyBet365Price needs
// plus what to call the market in the message.)
function equivalentRealMarket(betKey, htSnap) {
  if (betKey !== 'over05_2H') return null;
  const line = htSnap.home + htSnap.away + 0.5;
  return { apiKey: 'overTL', avgTl: line, label: `Over ${line} FT` };
}

function tlPaceLine(odds, htSnap) {
  if (odds.tl_c == null) return null;
  const goalsSoFar = htSnap.home + htSnap.away;
  const diff = odds.tl_c - goalsSoFar;
  const pace = diff <= 0 ? '🔥 already at/over TL' : diff < 1 ? '⚡ close to TL' : 'behind TL pace';
  return `⚽ Goals so far: ${goalsSoFar} vs. TL ${odds.tl_c} (${pace})`;
}

// 2026-08-29: simplified — dropped modelProbLine (redundant with the
// historical-rate line below and with kellyLine's own CI-lower mention) and
// lineMovementLine (pre-match open→close context, tangential to an in-play
// decision already conditioned on the real HT state).
function lateGoalFormat(match, bet, liveMin, htSnap, liveOdd, liveOddLo, equivalent, apiFootballCheck, odds, tlBandUsed) {
  const marketLabel = equivalent ? equivalent.label : bet.label;
  const actualPrice = apiFootballCheck?.supported ? apiFootballCheck.odds : null;
  const verdictLine = realPriceVerdict(marketLabel, actualPrice, liveOdd.fair_odd);
  const kellyLn = kellyLine(actualPrice, liveOddLo.live_p);
  const paceLine = tlPaceLine(odds, htSnap);
  return buildMessage(
    `🟡 LATEGOAL — still no 2nd-half goal`,
    match,
    `${liveMin}' · Score stuck at ${htSnap.home}-${htSnap.away} since half-time`,
    [
      `👉 <b>${esc(bet.label)}</b>`,
      verdictLine,
      ...(kellyLn ? [kellyLn] : []),
      ...(paceLine ? [paceLine] : []),
      `📊 ${bet.p.toFixed(0)}% historically vs ${bet.bl.toFixed(0)}% baseline (n=${bet.n}, similar HT scores${tlBandUsed ? ' + Total Line' : ''})`,
    ],
  );
}

async function runStrategyLateGoal(match, ctx) {
  const { matchId, label, tier, liveMin } = ctx;

  if (!cfg.LATEGOAL_ENABLED) return;
  if (liveMin == null || liveMin < cfg.LATEGOAL_TRIGGER_WINDOW[0] || liveMin > cfg.LATEGOAL_TRIGGER_WINDOW[1]) return;
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

  const lineBase = _dbAll.filter(r => r.fav_line === favLine && r.fav_side === favSide);
  if (lineBase.length < cfg.LATEGOAL_MIN_N) { flogv(liveMin, label, 'LATEGOAL', 'SKIP: base pool too small'); return; }

  // Same HT scoreline means very different things depending on the match's
  // own pre-match TL — e.g. HT 0-0 with TL 3.5 (goal expectation barely
  // touched) vs HT 0-0 with TL 1.5 (already tracking under). Bucket the
  // historical pool by the match's own closing TL (same TL_BANDS L123 uses)
  // so "similar matches" also means "similar total-goals expectation," not
  // just similar favourite strength — confirmed empirically to matter
  // (over05_2H at HT 0-0 ranges 71%-83% across TL bands vs. the flat 75.4%
  // a TL-blind pool reports). Falls back to the TL-blind pool if the band is
  // unknown or too thin, rather than skip the alert outright.
  const tlBand = Object.values(TL_BANDS).find(b => inBand(odds.tl_c, b));
  const tlBase = tlBand ? lineBase.filter(r => inBand(r.tl_c, tlBand)) : [];
  const base = tlBase.length >= cfg.LATEGOAL_MIN_N ? tlBase : lineBase;
  flogv(liveMin, label, 'LATEGOAL', base === tlBase
    ? `TL band matched: tl_c=${odds.tl_c} -> n=${base.length}`
    : `TL band pool too thin (n=${tlBase.length}) — falling back to TL-blind pool (n=${lineBase.length})`);

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
  // Same time-decay applied to the Wilson CI *lower-bound* probability
  // (bet.lo) instead of the raw point estimate (bet.p) — gives a
  // conservative live probability to size Kelly stakes off, consistent with
  // why mo_lo/target odds elsewhere use the CI lower bound, not bet.p.
  const liveOddLo = computeLiveOdd(bet.lo, bet.k, liveMin, favLine, 0, 0, favSide);

  const equivalent = equivalentRealMarket(bet.k, htSnap);
  let apiFootballCheck = null;
  if (equivalent && cfg.APIFOOTBALL_KEY) {
    try {
      apiFootballCheck = await verifyBet365Price(equivalent.apiKey, {
        matchId, homeTeam: match.home_team, awayTeam: match.away_team,
        favSide, favLine, avgTl: equivalent.avgTl,
      }, cfg.APIFOOTBALL_KEY);
    } catch (e) {
      flogv(liveMin, label, 'LATEGOAL', `api-football check failed: ${e.message}`);
    }
  }

  const msg = lateGoalFormat(match, bet, liveMin, htSnap, liveOdd, liveOddLo, equivalent, apiFootballCheck, odds, base === tlBase);
  await sendTelegram(msg);
  lateGoalDedup.mark(dedupKey);
  flog(liveMin, label, 'LATEGOAL', `ALERT: ${bet.k} p=${bet.p.toFixed(1)}% z=${bet.z.toFixed(2)} n=${bet.n} liveOdd=${liveOdd.fair_odd} equiv=${equivalent ? equivalent.label : '—'} tier=${tier}`);

  // Only recorded if api-football found a real price for the equivalent
  // market AND it clears the target fair odds — see verifiedGoodPrice.
  const lateGoalPrice = apiFootballCheck?.supported ? apiFootballCheck.odds : null;
  if (verifiedGoodPrice(lateGoalPrice, liveOdd.fair_odd)) {
    recordAlert({
      matchId, homeTeam: match.home_team, awayTeam: match.away_team,
      league: match.league, tier,
      fixtureId: apiFootballCheck?.fixtureId ?? null, betKey: bet.k, betLabel: bet.label,
      favSide, favLine, tlLine: odds.tl_c,
      priceAtAlert: lateGoalPrice,
      mo: bet.mo, mo_lo: bet.mo_lo,
      strategy: 'LATEGOAL', venue: 'soft', minute: liveMin,
      state: { score: `${htSnap.home}-${htSnap.away}`, redCards: 0, half: 2 },
    });
  } else {
    flogv(liveMin, label, 'LATEGOAL', 'Not recorded to track record — no verified price clearing target.');
  }
}

// ── Strategy QUIET2H — "expect a quiet 2nd half" watch ───────────────────────
const quiet2hDedup = new Dedup(24 * 60 * 60 * 1000);

function quiet2hQualifies(b) {
  return b.n >= cfg.QUIET2H_MIN_N && b.z >= cfg.QUIET2H_MIN_Z && (b.lo - b.bl) >= cfg.QUIET2H_MIN_EDGE;
}

// Same equivalence trick as LATEGOAL's equivalentRealMarket, run in reverse:
// QUIET2H fires the moment 2H starts, so the current score always equals the
// HT snapshot (no 2H goals possible yet) — "no more goals in 2H" therefore
// always equals "FT total stays at the current total", and "at most 1 more
// goal in 2H" always equals "FT total rises by at most 1". Both re-express as
// a standard, directly quotable Under-Total-Goals FT market:
//   under05_2H (0 more goals) -> Under (current total + 0.5) FT
//     e.g. HT 1-0 or 0-1 (total 1) -> Under 1.5 FT
//   under15_2H (<=1 more goal) -> Under (current total + 1.5) FT
//     e.g. HT 1-0 or 0-1 (total 1) -> Under 2.5 FT
function equivalentRealMarketQuiet2h(betKey, htSnap) {
  const total = htSnap.home + htSnap.away;
  if (betKey === 'under05_2H') return { apiKey: 'underTL', avgTl: total + 0.5, label: `Under ${total + 0.5} FT` };
  if (betKey === 'under15_2H') return { apiKey: 'underTL', avgTl: total + 1.5, label: `Under ${total + 1.5} FT` };
  return null;
}

// 2026-08-29: simplified — same rationale as lateGoalFormat above.
function quiet2hFormat(match, bet, liveMin, htSnap, liveOdd, liveOddLo, equivalent, apiFootballCheck, odds, tlBandUsed) {
  const marketLabel = equivalent ? equivalent.label : bet.label;
  const actualPrice = apiFootballCheck?.supported ? apiFootballCheck.odds : null;
  const verdictLine = realPriceVerdict(marketLabel, actualPrice, liveOdd.fair_odd);
  const kellyLn = kellyLine(actualPrice, liveOddLo.live_p);
  return buildMessage(
    `🔵 QUIET2H — quiet 2nd half expected`,
    match,
    `${liveMin}' · HT score ${htSnap.home}-${htSnap.away} · TL ${odds.tl_c ?? '—'}`,
    [
      `👉 <b>${esc(bet.label)}</b>`,
      verdictLine,
      ...(kellyLn ? [kellyLn] : []),
      `📊 ${bet.p.toFixed(0)}% historically vs ${bet.bl.toFixed(0)}% baseline (n=${bet.n}, same HT score${tlBandUsed ? ' + Total Line' : ''})`,
    ],
  );
}

async function runStrategyQuiet2H(match, ctx) {
  const { matchId, label, tier, liveMin } = ctx;

  if (!cfg.QUIET2H_ENABLED) return;
  if (liveMin == null || liveMin < HT_SNAPSHOT_WINDOW[0] || liveMin > HT_SNAPSHOT_WINDOW[1]) return;
  if (!tierAllowed(tier, cfg.QUIET2H_TIER)) { flogv(liveMin, label, 'QUIET2H', `SKIP: tier=${tier} not in ${cfg.QUIET2H_TIER}`); return; }
  if (!_dbAll || !_dbAll.length) return;

  const dedupKey = `${matchId}:quiet2h`;
  if (quiet2hDedup.has(dedupKey)) return;

  const htSnap = _htSnapshots.get(matchId);
  if (!htSnap) { flogv(liveMin, label, 'QUIET2H', 'SKIP: no HT snapshot captured for this match'); return; }

  const odds = match.bet365_odds;
  if (!odds) { flogv(liveMin, label, 'QUIET2H', 'SKIP: no Bet365 odds'); return; }
  const matchCfg = buildCfgFromMatch(odds, { LINE_MOVE_ON: true, FAV_ODDS_ON: true, DOG_ODDS_ON: true, TL_MOVE_ON: true });
  if (!matchCfg) { flogv(liveMin, label, 'QUIET2H', 'SKIP: odds incomplete'); return; }

  const favLine = matchCfg.signals.favLine;
  const favSide = matchCfg.signals.favSide;

  // Only TL<2 and TL 2-2.5 showed a validated edge for a quiet 2nd half —
  // TL>=2.5 matches showed no elevation over baseline at all (see config.js
  // comment), so skip outright rather than fire a false-confidence alert.
  const tlBand = tlBandOf(odds.tl_c);
  if (!cfg.QUIET2H_TL_BANDS.includes(tlBand)) { flogv(liveMin, label, 'QUIET2H', `SKIP: TL band ${tlBand} not in ${cfg.QUIET2H_TL_BANDS}`); return; }

  const lineBase = _dbAll.filter(r => r.fav_line === favLine && r.fav_side === favSide);
  const bandBase = lineBase.filter(r => tlBandOf(r.tl_c) === tlBand);
  const base = bandBase.length >= cfg.QUIET2H_MIN_N ? bandBase : lineBase;
  if (base.length < cfg.QUIET2H_MIN_N) { flogv(liveMin, label, 'QUIET2H', 'SKIP: base pool too small'); return; }

  const gs = { trigger: 'HT', home_goals: String(htSnap.home), away_goals: String(htSnap.away) };
  const gsRows = applyGameState(base, gs);
  if (gsRows.length < cfg.QUIET2H_MIN_N) { flogv(liveMin, label, 'QUIET2H', `SKIP: only ${gsRows.length} historical matches reached this HT state`); return; }

  const allBets = scoreBets(gsRows, base, base, cfg.QUIET2H_MIN_N);
  const candidates = allBets.filter(b => cfg.QUIET2H_BETS.includes(b.k) && quiet2hQualifies(b));
  if (!candidates.length) { flogv(liveMin, label, 'QUIET2H', 'SKIP: no qualifying quiet-2H bet'); return; }

  candidates.sort((a, b) => (b.z * b.lo / 100) - (a.z * a.lo / 100));
  const bet = candidates[0];

  // favG2h/dogG2h are always 0 here — QUIET2H fires right as the 2nd half
  // starts, before any 2H goals could have happened yet.
  const liveOdd = computeLiveOdd(bet.p, bet.k, liveMin, favLine, 0, 0, favSide);
  // Same time-decay applied to bet.lo (Wilson CI lower bound) instead of
  // bet.p — conservative live probability to size Kelly stakes off.
  const liveOddLo = computeLiveOdd(bet.lo, bet.k, liveMin, favLine, 0, 0, favSide);

  const equivalent = equivalentRealMarketQuiet2h(bet.k, htSnap);
  let apiFootballCheck = null;
  if (equivalent && cfg.APIFOOTBALL_KEY) {
    try {
      apiFootballCheck = await verifyBet365Price(equivalent.apiKey, {
        matchId, homeTeam: match.home_team, awayTeam: match.away_team,
        favSide, favLine, avgTl: equivalent.avgTl,
      }, cfg.APIFOOTBALL_KEY);
    } catch (e) {
      flogv(liveMin, label, 'QUIET2H', `api-football check failed: ${e.message}`);
    }
  }

  const msg = quiet2hFormat(match, bet, liveMin, htSnap, liveOdd, liveOddLo, equivalent, apiFootballCheck, odds, base === bandBase);
  await sendTelegram(msg);
  quiet2hDedup.mark(dedupKey);
  flog(liveMin, label, 'QUIET2H', `ALERT: ${bet.k} p=${bet.p.toFixed(1)}% z=${bet.z.toFixed(2)} n=${bet.n} liveOdd=${liveOdd.fair_odd} equiv=${equivalent ? equivalent.label : '—'} tier=${tier}`);

  // Only recorded if api-football found a real price for the equivalent
  // market AND it clears the target fair odds — see verifiedGoodPrice.
  const quiet2hPrice = apiFootballCheck?.supported ? apiFootballCheck.odds : null;
  if (verifiedGoodPrice(quiet2hPrice, liveOdd.fair_odd)) {
    recordAlert({
      matchId, homeTeam: match.home_team, awayTeam: match.away_team,
      league: match.league, tier,
      fixtureId: apiFootballCheck?.fixtureId ?? null, betKey: bet.k, betLabel: bet.label,
      favSide, favLine, tlLine: odds.tl_c,
      priceAtAlert: quiet2hPrice,
      mo: bet.mo, mo_lo: bet.mo_lo,
      strategy: 'QUIET2H', venue: 'soft', minute: liveMin,
      state: { score: `${htSnap.home}-${htSnap.away}`, redCards: 0, half: 2 },
    });
  } else {
    flogv(liveMin, label, 'QUIET2H', 'Not recorded to track record — no verified price clearing target.');
  }
}

// ── Strategy HTPICK — cross-fit "HT pick" (winner's-curse-corrected) ─────────
// Fires once per match at half-time, same trigger window QUIET2H uses. Unlike
// LATEGOAL/QUIET2H (score a single historical pool directly, then gate on its
// own z/CI-lower-bound), this picks across the SAME 2H bet set the Live Games
// UI's HT pick uses, cross-fit selected — see config.js's HTPICK_* comment
// and CLAUDE.md's "Cross-Fit Bet Selection" section for why this correction
// exists and the walk-forward numbers behind it (naive single-pool pick on
// this exact bet set: -22% to -29% ROI@price; cross-fit: +4% to +22%).
const htPickDedup = new Dedup(24 * 60 * 60 * 1000);

const _HTPICK_KEYS = new Set([
  'over05_2H', 'over15_2H', 'under05_2H', 'under15_2H',
  'homeScored2H', 'awayScored2H',
  'homeWins2H', 'awayWins2H', 'draw2H',
  'btts2H',
]);
const _HTPICK_BET_DEFS = BETS.filter(b => _HTPICK_KEYS.has(b.k));

function htPickQualifies(b) {
  return !!b && b.n >= cfg.HTPICK_MIN_N && b.z >= cfg.HTPICK_MIN_Z && (b.lo - b.bl) >= cfg.HTPICK_MIN_EDGE;
}
function htPickBaseScore(b) { return b ? b.z * (b.lo / 100) : -Infinity; }

// Runs applyConfig/applyBaselineConfig (pre-match pool) and, on top of that,
// applyGameState for the real HT state (HT-conditioned pool) against ONE
// fold's rows, then per bet key keeps whichever of the two pools scores
// higher — mirrors static/app.js's buildQualifyingList pre-vs-gs merge and
// the exact selectFrom() logic backtest_live_ui_split_sample.js validated.
// Returns { candidates, gsMap }: candidates is one bet object per HTPICK key
// (not yet cross-fit qualified/priced — that happens next, across this
// fold's result and the other fold's); gsMap is the FULL (unfiltered by
// _HTPICK_KEYS) HT-conditioned scoreBets() map for this fold — mirrors
// app.js's htMapA/htMapB, needed as the anchor source (favScored2H/
// homeScored2H/awayScored2H) for the bivariate homeWins2H/awayWins2H/
// draw2H/btts2H live-decay dispatch, since those anchor keys aren't
// themselves in _HTPICK_KEYS.
function htPickSelectFold(pool, matchCfg, gs) {
  const cfgRows = applyConfig(pool, matchCfg);
  const baselineRows = applyBaselineConfig(pool, matchCfg);
  const blSide = baselineRows.filter(r => r.fav_side === matchCfg.fav_side);

  let preMap = new Map();
  if (cfgRows.length >= cfg.HTPICK_MIN_N && baselineRows.length) {
    preMap = new Map(scoreBets(cfgRows, baselineRows, blSide, cfg.HTPICK_MIN_N).map(b => [b.k, b]));
  }

  let gsMap = new Map();
  const gsRows = applyGameState(cfgRows, gs);
  if (gsRows.length >= cfg.HTPICK_MIN_N) {
    const gsBlRows = applyGameState(baselineRows, gs);
    const gsBlSide = applyGameState(blSide, gs);
    gsMap = new Map(scoreBets(gsRows, gsBlRows, gsBlSide, cfg.HTPICK_MIN_N).map(b => [b.k, b]));
  }

  const candidates = [];
  for (const k of _HTPICK_KEYS) {
    const pre = preMap.get(k) || null;
    const gsB = gsMap.get(k) || null;
    if (!pre && !gsB) continue;
    candidates.push(htPickBaseScore(gsB) > htPickBaseScore(pre) ? gsB : pre);
  }
  return { candidates, gsMap };
}

// Same equivalence-to-a-real-market trick LATEGOAL/QUIET2H use, extended to
// cover this strategy's wider bet set. over05_2H/over15_2H and
// under05_2H/under15_2H re-express as Over/Under (current total + line) FT
// exactly as in equivalentRealMarket()/equivalentRealMarketQuiet2h() (score
// is frozen at the HT snapshot the moment this fires, same as QUIET2H).
// homeScored2H/awayScored2H re-express as BTTS Yes ONLY when that side is
// still scoreless and the opponent already has a goal — the documented
// LATEGOAL equivalence (see CLAUDE.md's "No bookmaker lists any of the 4
// LATEGOAL bet types directly" section), included here since this strategy's
// backtest covers the full key set, unlike LATEGOAL_BETS which dropped these
// three for its OWN selection-quality reasons (not because the equivalence
// itself doesn't hold). homeWins2H/awayWins2H/draw2H/btts2H have no clean FT
// equivalence — left unsupported (message falls back to the internal target
// only, same as LATEGOAL/QUIET2H's own fallback when equivalent is null).
function equivalentRealMarketHtPick(betKey, htSnap) {
  const total = htSnap.home + htSnap.away;
  if (betKey === 'over05_2H')  return { apiKey: 'overTL',  avgTl: total + 0.5, label: `Over ${total + 0.5} FT` };
  if (betKey === 'over15_2H')  return { apiKey: 'overTL',  avgTl: total + 1.5, label: `Over ${total + 1.5} FT` };
  if (betKey === 'under05_2H') return { apiKey: 'underTL', avgTl: total + 0.5, label: `Under ${total + 0.5} FT` };
  if (betKey === 'under15_2H') return { apiKey: 'underTL', avgTl: total + 1.5, label: `Under ${total + 1.5} FT` };
  if (betKey === 'homeScored2H' && htSnap.home === 0 && htSnap.away >= 1) return { apiKey: 'btts', avgTl: null, label: 'BTTS Yes' };
  if (betKey === 'awayScored2H' && htSnap.away === 0 && htSnap.home >= 1) return { apiKey: 'btts', avgTl: null, label: 'BTTS Yes' };
  return null;
}

function htPickFormat(match, bet, liveMin, htSnap, liveOdd, liveOddLo, equivalent, apiFootballCheck, odds) {
  const marketLabel = equivalent ? equivalent.label : bet.label;
  const actualPrice = apiFootballCheck?.supported ? apiFootballCheck.odds : null;
  const verdictLine = realPriceVerdict(marketLabel, actualPrice, liveOdd.fair_odd);
  const kellyLn = kellyLine(actualPrice, liveOddLo.live_p);
  const moveLine = lineMovementLine(odds);
  return buildMessage(
    `HT pick — cross-fit qualifying bet`,
    match,
    `${liveMin}' · HT score ${htSnap.home}-${htSnap.away}${odds.tl_c != null ? ` · TL ${odds.tl_c}` : ''}`,
    [
      `👉 <b>${esc(bet.label)}</b>`,
      verdictLine,
      ...(liveOddLo.live_p != null ? [modelProbLine(liveOddLo.live_p)] : []),
      ...(kellyLn ? [kellyLn] : []),
      ...(moveLine ? [moveLine] : []),
      `📊 ${bet.p.toFixed(0)}% historically vs ${bet.bl.toFixed(0)}% baseline (n=${bet.n}, cross-fit priced by fold ${bet._pricedFold})`,
    ],
  );
}

async function runStrategyHtPick(match, ctx) {
  const { matchId, label, tier, liveMin } = ctx;

  if (!cfg.HTPICK_ENABLED) return;
  if (liveMin == null || liveMin < HT_SNAPSHOT_WINDOW[0] || liveMin > HT_SNAPSHOT_WINDOW[1]) return;
  if (!tierAllowed(tier, cfg.HTPICK_TIER)) { flogv(liveMin, label, 'HTPICK', `SKIP: tier=${tier} not in ${cfg.HTPICK_TIER}`); return; }
  if (!_dbAll || !_dbAll.length) return;

  const dedupKey = `${matchId}:htpick`;
  if (htPickDedup.has(dedupKey)) return;

  const htSnap = _htSnapshots.get(matchId);
  if (!htSnap) { flogv(liveMin, label, 'HTPICK', 'SKIP: no HT snapshot captured for this match'); return; }

  const odds = match.bet365_odds;
  if (!odds) { flogv(liveMin, label, 'HTPICK', 'SKIP: no Bet365 odds'); return; }
  const matchCfg = buildCfgFromMatch(odds, { LINE_MOVE_ON: true, FAV_ODDS_ON: true, DOG_ODDS_ON: true, TL_MOVE_ON: true });
  if (!matchCfg) { flogv(liveMin, label, 'HTPICK', 'SKIP: odds incomplete'); return; }

  const favLine = matchCfg.signals.favLine;
  const favSide = matchCfg.signals.favSide;
  const gs = { trigger: 'HT', home_goals: String(htSnap.home), away_goals: String(htSnap.away) };

  // Tier-filter the historical pool itself (not just the alerting match's own
  // tier, which tierAllowed already gated above) before the fold split — this
  // matches backtest_live_ui_split_sample.js's applyTier(), which is what was
  // actually walk-forward validated. L123/LATEGOAL/QUIET2H don't do this (see
  // CLAUDE.md/git history), so this is a deliberate divergence for HTPICK
  // specifically, to keep the live implementation faithful to its own backtest.
  const tierPool = _dbAll.filter(r => tierAllowed(r.league_tier, cfg.HTPICK_TIER));
  const dbA = tierPool.filter(r => r.fold === 'A');
  const dbB = tierPool.filter(r => r.fold === 'B');
  const selA = htPickSelectFold(dbA, matchCfg, gs);
  const selB = htPickSelectFold(dbB, matchCfg, gs);
  const merged = mergeCrossFit(selA.candidates, selB.candidates, _HTPICK_BET_DEFS, htPickQualifies);
  if (!merged.length) { flogv(liveMin, label, 'HTPICK', 'SKIP: no cross-fit qualifying bet'); return; }

  merged.sort((a, b) => (b.z * b.lo / 100) - (a.z * a.lo / 100));
  const bet = merged[0];

  // favG2h/dogG2h are always 0 here — HTPICK fires right at HT, before any
  // 2H goals could have happened yet (same as QUIET2H). homeWins2H/awayWins2H/
  // draw2H/btts2H can't go through computeLiveOdd's single-threshold path
  // (see live_odds.js's computeLiveResult2H/computeLiveBtts2H comments) — they
  // need the SAME fold's favScored2H/homeScored2H/awayScored2H anchor rates
  // that priced `bet` itself, mirroring app.js's buildLiveAdjustedBet dispatch.
  const anchorMap = bet._pricedFold === 'A' ? selA.gsMap : selB.gsMap;
  let liveOdd, liveOddLo;
  if (_2H_RESULT_KEYS.has(bet.k)) {
    const favAnchor = anchorMap.get('favScored2H');
    const dogAnchor = anchorMap.get(favSide === 'HOME' ? 'awayScored2H' : 'homeScored2H');
    if (favAnchor && dogAnchor) {
      const field = _2hResultField(bet.k, favSide);
      const point = computeLiveResult2H(favAnchor.p, dogAnchor.p, liveMin, favLine, 0, 0, false);
      if (point.alreadyDecided) {
        flogv(liveMin, label, 'HTPICK', 'SKIP: result market already decided (no remaining goal-scoring time)');
        return;
      }
      const p = point[field];
      // Phase 0 fix 0.8: joint Monte Carlo CI over favAnchor/dogAnchor's own
      // Wilson intervals, instead of the old "run once with both anchors at
      // their own lo" (invalid joint lower bound — see live_odds.js's
      // comment on mcLiveLo/mcLiveHi for why).
      const loMc = mcLiveLo(favAnchor, dogAnchor, (a, b) => computeLiveResult2H(a, b, liveMin, favLine, 0, 0, false)[field]);
      const hiMc = mcLiveHi(favAnchor, dogAnchor, (a, b) => computeLiveResult2H(a, b, liveMin, favLine, 0, 0, false)[field]);
      const lo = Math.min(p, loMc != null ? loMc : p);
      liveOdd    = { live_p: Math.round(p  * 10) / 10, fair_odd: Math.round(1 / Math.max(p  / 100, 0.001) * 100) / 100 };
      liveOddLo  = { live_p: Math.round(lo * 10) / 10, fair_odd: Math.round(1 / Math.max(lo / 100, 0.001) * 100) / 100 };
    } else {
      liveOdd = liveOddLo = { live_p: null, fair_odd: null };
    }
  } else if (bet.k === 'btts2H') {
    const homeAnchor = anchorMap.get('homeScored2H');
    const awayAnchor = anchorMap.get('awayScored2H');
    if (homeAnchor && awayAnchor) {
      const pointRes = computeLiveBtts2H(homeAnchor.p, awayAnchor.p, liveMin, favLine, 0, 0, favSide, false);
      if (!pointRes || pointRes.alreadyDecided) {
        flogv(liveMin, label, 'HTPICK', 'SKIP: btts2H already decided (no remaining goal-scoring time)');
        return;
      }
      const p = pointRes.live_p;
      const loMc = mcLiveLo(homeAnchor, awayAnchor, (a, b) => {
        const r = computeLiveBtts2H(a, b, liveMin, favLine, 0, 0, favSide, false);
        return r ? r.live_p : null;
      });
      const lo = Math.min(p, loMc != null ? loMc : p);
      liveOdd    = { live_p: p,  fair_odd: p  != null ? Math.round(1 / Math.max(p  / 100, 0.001) * 100) / 100 : null };
      liveOddLo  = { live_p: lo, fair_odd: lo != null ? Math.round(1 / Math.max(lo / 100, 0.001) * 100) / 100 : null };
    } else {
      liveOdd = liveOddLo = { live_p: null, fair_odd: null };
    }
  } else {
    liveOdd = computeLiveOdd(bet.p, bet.k, liveMin, favLine, 0, 0, favSide);
    if (liveOdd.alreadyDecided) {
      flogv(liveMin, label, 'HTPICK', 'SKIP: bet already decided (no remaining goal-scoring time)');
      return;
    }
    liveOddLo = computeLiveOdd(bet.lo, bet.k, liveMin, favLine, 0, 0, favSide);
  }

  const equivalent = equivalentRealMarketHtPick(bet.k, htSnap);
  let apiFootballCheck = null;
  if (equivalent && cfg.APIFOOTBALL_KEY) {
    try {
      apiFootballCheck = await verifyBet365Price(equivalent.apiKey, {
        matchId, homeTeam: match.home_team, awayTeam: match.away_team,
        favSide, favLine, avgTl: equivalent.avgTl,
      }, cfg.APIFOOTBALL_KEY);
    } catch (e) {
      flogv(liveMin, label, 'HTPICK', `api-football check failed: ${e.message}`);
    }
  }

  const msg = htPickFormat(match, bet, liveMin, htSnap, liveOdd, liveOddLo, equivalent, apiFootballCheck, odds);
  await sendTelegram(msg);
  htPickDedup.mark(dedupKey);
  flog(liveMin, label, 'HTPICK', `ALERT: ${bet.k} p=${bet.p.toFixed(1)}% z=${bet.z.toFixed(2)} n=${bet.n} pricedFold=${bet._pricedFold} liveOdd=${liveOdd.fair_odd} equiv=${equivalent ? equivalent.label : '—'} tier=${tier}`);

  // Only recorded if api-football found a real price for the equivalent
  // market AND it clears the target fair odds — see verifiedGoodPrice.
  const htPickPrice = apiFootballCheck?.supported ? apiFootballCheck.odds : null;
  if (verifiedGoodPrice(htPickPrice, liveOdd.fair_odd)) {
    recordAlert({
      matchId, homeTeam: match.home_team, awayTeam: match.away_team,
      league: match.league, tier,
      fixtureId: apiFootballCheck?.fixtureId ?? null, betKey: bet.k, betLabel: bet.label,
      favSide, favLine, tlLine: odds.tl_c,
      priceAtAlert: htPickPrice,
      mo: bet.mo, mo_lo: bet.mo_lo,
      strategy: 'HTPICK', venue: 'soft', minute: liveMin,
      state: { score: `${htSnap.home}-${htSnap.away}`, redCards: 0, half: 2 },
    });
  } else {
    flogv(liveMin, label, 'HTPICK', 'Not recorded to track record — no verified price clearing target.');
  }
}

// ── Strategy NEWMODEL — E8: static/live_model.js as an independent signal ────
// See config.js's NEWMODEL_* block for the full design rationale. OPT-IN,
// OFF by default — the pricing engine itself is not yet walk-forward
// validated against real outcomes (that's E6, a separate follow-up), so this
// exists purely to start accumulating a track record (see track_record.js's
// per-strategy breakdown) without touching L123/LATEGOAL/QUIET2H/HTPICK/
// DASHBOARD in any way.
//
// Trigger: HT window only (same HT_SNAPSHOT_WINDOW/_htSnapshots capture every
// other HT-triggered strategy already uses — no new snapshot mechanism).
//
// Red-card trigger (LIVE_BETTING_PLAN.md Part C 3A "new" bullet): SKIPPED.
// Wiring it would need a live fixture-events poll (red cards) from
// api-football, and nothing in this codebase polls fixture events today —
// telegram/apifootball.js only ever calls /odds/live and /fixtures, never
// /fixtures/events. Adding a per-scan-cycle events poll for every live match
// just to catch a red card promptly would either blow through the 100/day
// notification budget (api_budget.js) or, if throttled enough to fit the
// budget, arrive too late/rarely to be useful as an event trigger — a
// genuinely different scope than "reuse the existing HT window," so it's
// left out of this first cut rather than forced in.
const newModelDedup = new Dedup(24 * 60 * 60 * 1000);
const newModelRecheckDedup = new Dedup(24 * 60 * 60 * 1000);
// 2026-08-29: remembers which matches' HT NEWMODEL pick was an Over-2H-goals
// bet (over05_2H/over15_2H), so runStrategyNewModelRecheck can re-check ONLY
// those specific matches later in the half — reusing LATEGOAL's own proven
// 68'-72' window rather than inventing a new one. Cleared (a) once the bet
// resolves/busts, (b) after the recheck fires or is skipped, or (c) by the
// same natural process-restart reset every other in-memory map here has.
const _newModelPickTracker = new Map();

// Standard TL line for the Over/Under FT candidates: the match's own closing
// Total Line, unrounded — so the feed's own ov_c/un_c prices (quoted exactly
// at that line) can be used as a zero-cost, already-verified market price,
// the same trick L123's liveOddsForBet() relies on for its 4 direct-price
// bet types.
function newModelOuLine(odds) {
  return odds.tl_c != null ? odds.tl_c : (odds.tl_o != null ? odds.tl_o : 2.5);
}

// pct: model probability (0-100, i.e. already *100). marketOdds: decimal odds
// or null. Returns { edgePp, marketImpliedPct } or nulls if no market price.
function newModelEdge(pct, marketOdds) {
  if (marketOdds == null || !(marketOdds > 1)) return { edgePp: null, marketImpliedPct: null };
  const marketImpliedPct = 100 / marketOdds;
  return { edgePp: pct - marketImpliedPct, marketImpliedPct };
}

function newModelFormat(match, cand, liveMin, htSnap, odds) {
  const row = cand.row;
  const lo = row.lo != null ? row.lo * 100 : null;
  const p = row.p * 100;
  const hi = row.hi != null ? row.hi * 100 : null;
  // overTL/underTL's "market price" is odds.ov_c/un_c — per buildCfgFromLiveOdds's
  // own header comment (static/app.js) these fields hold the PRE-MATCH CLOSING
  // price and do not get re-scraped/updated once the match kicks off, so by HT
  // this is NOT a live in-play quote — it has not moved for anything that
  // happened in the first half (goals, cards, pace). A backtest of this exact
  // check (telegram/research/backtest_newmodel_ou_v2.js) showed a large
  // apparent "edge" that is very plausibly just the model correctly using the
  // real HT score while the reference price is stale, not a real exploitable
  // edge against an actual live market — see that report's caveats. Never
  // present this as a live-verified price; always say so plainly so a real
  // bet isn't placed on the strength of a false "✅ ODDS OK".
  // 2026-08-29: shortened — same warning, fewer words (full rationale above
  // unchanged). Also dropped modelProbLine (redundant with the CI line
  // below) and lineMovementLine (tangential pre-match context), and folded
  // the edge-vs-market pp into the CI line instead of its own line.
  const isStaleOuCheck = cand.betKey === 'overTL' || cand.betKey === 'underTL';
  let verdictLine;
  if (isStaleOuCheck && cand.marketOdds != null) {
    const clears = row.min_back_odds == null || cand.marketOdds >= row.min_back_odds;
    verdictLine = `${clears ? '⚠️' : '❌'} Target @${row.min_back_odds != null ? row.min_back_odds.toFixed(2) : '—'} · Pre-match price @${cand.marketOdds.toFixed(2)} (not live — check your bookmaker)`;
  } else if (cand.marketOdds != null) {
    verdictLine = realPriceVerdict(cand.label, cand.marketOdds, row.min_back_odds);
  } else {
    verdictLine = `ℹ️ Target @${row.min_back_odds != null ? row.min_back_odds.toFixed(2) : '—'} · No live price check available — check Bet365 yourself for the current price.`;
  }
  const kellyLn = cand.marketOdds != null ? kellyLine(cand.marketOdds, lo) : null;
  const edgeSuffix = cand.edgePp != null ? `, edge ${cand.edgePp >= 0 ? '+' : ''}${cand.edgePp.toFixed(1)}pp` : '';
  const ciLine = lo != null && hi != null
    ? `🧪 p=${p.toFixed(1)}% (CI ${lo.toFixed(1)}–${hi.toFixed(1)}%) — UNVALIDATED${edgeSuffix}`
    : `🧪 p=${p.toFixed(1)}% — UNVALIDATED${edgeSuffix}`;
  return buildMessage(
    `🟣 NEWMODEL — HT reprice`,
    match,
    `${liveMin}' · HT score ${htSnap.home}-${htSnap.away}${odds.tl_c != null ? ` · TL ${odds.tl_c}` : ''}`,
    [
      `👉 <b>${esc(cand.label)}</b>`,
      verdictLine,
      ...(kellyLn ? [kellyLn] : []),
      ciLine,
    ],
  );
}

async function runStrategyNewModel(match, ctx) {
  const { matchId, label, tier, liveMin } = ctx;

  if (!cfg.NEWMODEL_ENABLED) return;
  if (liveMin == null || liveMin < HT_SNAPSHOT_WINDOW[0] || liveMin > HT_SNAPSHOT_WINDOW[1]) return;
  if (!tierAllowed(tier, cfg.NEWMODEL_TIER)) { flogv(liveMin, label, 'NEWMODEL', `SKIP: tier=${tier} not in ${cfg.NEWMODEL_TIER}`); return; }

  const dedupKey = `${matchId}:newmodel`;
  if (newModelDedup.has(dedupKey)) return;

  const htSnap = _htSnapshots.get(matchId);
  if (!htSnap) { flogv(liveMin, label, 'NEWMODEL', 'SKIP: no HT snapshot captured for this match'); return; }

  const odds = match.bet365_odds;
  if (!odds) { flogv(liveMin, label, 'NEWMODEL', 'SKIP: no Bet365 odds'); return; }
  if (odds.ah_hc == null) { flogv(liveMin, label, 'NEWMODEL', 'SKIP: no closing AH line'); return; }

  let boot;
  try { boot = LM.init(); } catch (e) { flogv(liveMin, label, 'NEWMODEL', `SKIP: LiveModel init failed: ${e.message}`); return; }
  if (!boot.hazardLoaded) { flogv(liveMin, label, 'NEWMODEL', 'SKIP: goal_hazard.json not loaded'); return; }

  const ouLine = newModelOuLine(odds);
  const state = {
    ah_line: odds.ah_hc, tl: odds.tl_c != null ? odds.tl_c : odds.tl_o,
    tier,
    home_goals: htSnap.home, away_goals: htSnap.away,
    ht_home_goals: htSnap.home, ht_away_goals: htSnap.away,
    red_h: 0, red_a: 0, // no red-card feed — see header comment; treated as 11v11
  };

  // ── Per-match implied lambda (fixes the bucket-fallback circularity) ──────
  // Previously this state object only set ah_line/tl, so static/live_model.js's
  // _normState() silently fell back to lambdaFromLookup() — a bucket MEDIAN
  // over thousands of historical matches sharing the (line, TL, tier) cell,
  // not a per-match fit. That produced a near-tautological backtest result
  // (comparing a bucket-average price against individual draws from the same
  // population). live_lambda_solver.js solves a real per-match (lambda_h,
  // lambda_a) from ONLY the information the live Bet365 feed actually has —
  // AH line + AH odds, Total Line + O/U odds — with rho fixed at a
  // tier-specific constant (see that module's header). Falls back to the
  // bucket lookup (by simply leaving lambda_h/lambda_a unset) if the solver
  // fails or the odds needed for it are missing/malformed — never crashes,
  // never silently skips the strategy.
  let lambdaSource = 'bucket_fallback';
  let lambdaSolveDetail = null;
  const solved = solveLambdaFromOdds({
    ahLine: odds.ah_hc,
    ahHomeOdds: odds.ho_c,
    ahAwayOdds: odds.ao_c,
    tl: state.tl,
    overOdds: odds.ov_c,
    underOdds: odds.un_c,
    tier,
  });
  if (solved.ok) {
    state.lambda_h = solved.lambda_h;
    state.lambda_a = solved.lambda_a;
    state.rho = solved.rho;
    lambdaSource = 'per_match_solver';
    lambdaSolveDetail = `residualNorm=${solved.residualNorm.toFixed(5)} method=${solved.method} converged=${solved.converged}`;
  } else {
    lambdaSolveDetail = `solver failed: ${solved.error}`;
  }
  // Auditable per-alert: which lambda source actually priced this pick.
  flogv(liveMin, label, 'NEWMODEL', `lambda source=${lambdaSource} (${lambdaSolveDetail})`);

  // 2026-08-29: scoped to Over/Under FT, BTTS, and Over 0.5/1.5 2H — the
  // market families with (a) real historical walk-forward validation behind
  // the underlying goal-occurrence signal (LATEGOAL/QUIET2H's own
  // over05_2H/under05_2H/under15_2H) and (b) a genuine live price check path
  // (BTTS + over05_2H/over15_2H via api-football's equivalent-market trick,
  // same one LATEGOAL/HTPICK already use; O/U-FT via the feed, caveat still
  // applies — see newModelFormat's isStaleOuCheck disclosure). The 2H-result
  // (home/draw/away) leg was removed earlier — never price-verifiable, never
  // backtested as its own signal. Under05_2H/Under15_2H deliberately NOT
  // added here even though QUIET2H covers them: unlike Over-type bets, an
  // Under bet's correct entry point is right at HT (every extra minute
  // survived without a goal is already priced in by an efficient market, so
  // there's no "wait for the market to lag" edge the way there can be for
  // Over bets) — QUIET2H already owns that entry point.
  const over05Line = 0.5, over15Line = 1.5; // 2H-remainder lines
  const specs = [
    { type: 'over',  line: ouLine,      scope: 'match' },
    { type: 'under', line: ouLine,      scope: 'match' },
    { type: 'btts',  scope: 'match', yes: true },
    { type: 'over',  line: over05Line,  scope: 'half' }, // over05_2H equivalent
    { type: 'over',  line: over15Line,  scope: 'half' }, // over15_2H equivalent
  ];
  let rows;
  try {
    rows = LM.priceLadder(specs, state, 'HT', { samples: cfg.NEWMODEL_MC_SAMPLES });
  } catch (e) {
    flogv(liveMin, label, 'NEWMODEL', `SKIP: pricing failed: ${e.message}`);
    return;
  }
  const [rOver, rUnder, rBtts, rOver05_2h, rOver15_2h] = rows;
  const htTotal = htSnap.home + htSnap.away;

  // ── Step 1: Over/Under FT vs the feed's own closing O/U price — zero API
  // cost, same trick L123's liveOddsForBet() already relies on.
  const overEdge  = newModelEdge(rOver.lo  * 100, odds.ov_c);
  const underEdge = newModelEdge(rUnder.lo * 100, odds.un_c);
  const ouCandidates = [
    { label: `Over ${ouLine} FT`,  betKey: 'overTL',  row: rOver,  marketOdds: odds.ov_c ?? null, edgePp: overEdge.edgePp },
    { label: `Under ${ouLine} FT`, betKey: 'underTL', row: rUnder, marketOdds: odds.un_c ?? null, edgePp: underEdge.edgePp },
  ].filter(c => c.edgePp != null);
  ouCandidates.sort((a, b) => b.edgePp - a.edgePp);

  let chosen = null;
  if (ouCandidates.length && ouCandidates[0].edgePp >= cfg.NEWMODEL_MIN_EDGE_PP) {
    chosen = ouCandidates[0];
  } else {
    // ── Step 2: BTTS / Over05_2H / Over15_2H via api-football — only ONE
    // budgeted call, spent on whichever of the three the model itself looks
    // most confident about (avoids spending budget on a coinflip that could
    // never clear the edge bar anyway, and avoids tripling the api-football
    // cost per alert now that there are 3 checkable candidates instead of 1).
    const apiCandidates = [
      { betKey: 'btts',      row: rBtts,      apiKey: 'btts',   avgTl: null,             label: 'BTTS Yes' },
      { betKey: 'over05_2H', row: rOver05_2h, apiKey: 'overTL', avgTl: htTotal + 0.5,    label: `Over ${htTotal + 0.5} FT (2H: Over 0.5)` },
      { betKey: 'over15_2H', row: rOver15_2h, apiKey: 'overTL', avgTl: htTotal + 1.5,    label: `Over ${htTotal + 1.5} FT (2H: Over 1.5)` },
    ]
      .map(c => ({ ...c, conf: Math.max(c.row.lo * 100, 100 - c.row.hi * 100) }))
      .filter(c => c.conf >= 55)
      .sort((a, b) => b.conf - a.conf);

    if (cfg.APIFOOTBALL_KEY && apiCandidates.length) {
      const top = apiCandidates[0];
      try {
        const check = await verifyBet365Price(top.apiKey, {
          matchId, homeTeam: match.home_team, awayTeam: match.away_team,
          favSide: odds.ah_hc < 0 ? 'HOME' : 'AWAY', favLine: Math.abs(odds.ah_hc), avgTl: top.avgTl,
        }, cfg.APIFOOTBALL_KEY);
        if (check.supported && check.odds != null) {
          const edge = newModelEdge(top.row.lo * 100, check.odds);
          if (edge.edgePp != null && edge.edgePp >= cfg.NEWMODEL_MIN_EDGE_PP) {
            chosen = { label: top.label, betKey: top.betKey, row: top.row, marketOdds: check.odds, edgePp: edge.edgePp };
          }
        }
      } catch (e) {
        flogv(liveMin, label, 'NEWMODEL', `api-football ${top.betKey} check failed: ${e.message}`);
      }
    }
  }

  // ── Step 3: unverified fallback — fires when no market price was found or
  // reachable at all for anything above (no api-football key/budget, or the
  // feed itself has no O/U price this match) — this is what keeps alerts
  // firing even with api-football unavailable, gated on a stricter raw-
  // confidence floor since there's no price to check the edge against.
  if (!chosen) {
    const unverified = [
      ...(ouCandidates.length ? [] : [
        { label: `Over ${ouLine} FT`,  betKey: 'overTL',  row: rOver,  marketOdds: null, edgePp: null },
        { label: `Under ${ouLine} FT`, betKey: 'underTL', row: rUnder, marketOdds: null, edgePp: null },
      ]),
      { label: 'BTTS Yes', betKey: 'btts', row: rBtts, marketOdds: null, edgePp: null },
      { label: `Over ${htTotal + 0.5} FT (2H: Over 0.5)`, betKey: 'over05_2H', row: rOver05_2h, marketOdds: null, edgePp: null },
      { label: `Over ${htTotal + 1.5} FT (2H: Over 1.5)`, betKey: 'over15_2H', row: rOver15_2h, marketOdds: null, edgePp: null },
    ].filter(c => c.row.lo != null && c.row.lo * 100 >= cfg.NEWMODEL_MIN_LO_UNVERIFIED);
    unverified.sort((a, b) => b.row.lo - a.row.lo);
    if (unverified.length) chosen = unverified[0];
  }

  if (!chosen) { flogv(liveMin, label, 'NEWMODEL', 'SKIP: no candidate cleared the edge/confidence bar'); return; }

  const msg = newModelFormat(match, chosen, liveMin, htSnap, odds);
  await sendTelegram(msg);
  newModelDedup.mark(dedupKey);
  flog(liveMin, label, 'NEWMODEL', `ALERT: ${chosen.label} p=${(chosen.row.p * 100).toFixed(1)}% lo=${(chosen.row.lo * 100).toFixed(1)}% edge=${chosen.edgePp != null ? chosen.edgePp.toFixed(1) + 'pp' : 'unverified'} tier=${tier} lambdaSource=${lambdaSource}`);

  // 2026-08-29: if the HT pick was an Over-2H-goals bet, remember it so
  // runStrategyNewModelRecheck can re-check it at 68'-72' if it still hasn't
  // happened — see that function's header comment.
  if (chosen.betKey === 'over05_2H' || chosen.betKey === 'over15_2H') {
    _newModelPickTracker.set(matchId, { betKey: chosen.betKey, htTotal, firedAtMin: liveMin });
  }

  // track_record.js — logs regardless of verified/unverified (unlike
  // L123/LATEGOAL/QUIET2H/HTPICK/DASHBOARD's verifiedGoodPrice() gate) since
  // this strategy's whole purpose right now is accumulating a track record to
  // decide whether the model has any edge at all (E6) — excluding unverified
  // picks would bias that record toward only the O/U-feed-price cases.
  recordAlert({
    matchId, homeTeam: match.home_team, awayTeam: match.away_team,
    league: match.league, tier,
    fixtureId: null, betKey: chosen.betKey, betLabel: chosen.label,
    favSide: odds.ah_hc < 0 ? 'HOME' : 'AWAY', favLine: Math.abs(odds.ah_hc),
    // overTL/underTL settle against `tlLine` in track_record.js — use the
    // exact line this alert priced (ouLine), not just whatever odds.tl_c
    // happens to be (they're usually the same value, but ouLine is the one
    // actually fed into LiveModel and shown in the message).
    tlLine: (chosen.betKey === 'overTL' || chosen.betKey === 'underTL') ? ouLine : odds.tl_c,
    priceAtAlert: chosen.marketOdds,
    mo: chosen.row.fair_odds ?? null, mo_lo: chosen.row.min_back_odds ?? null,
    strategy: 'NEWMODEL',
    venue: 'soft',
    minute: liveMin,
    state: { score: `${htSnap.home}-${htSnap.away}`, redCards: 0, half: 2, lambdaSource },
  });
}

// 2026-08-29: simplified — same rationale as newModelFormat above.
function newModelRecheckFormat(match, cand, liveMin, htSnap, curScore, odds, pick) {
  const row = cand.row;
  const lo = row.lo != null ? row.lo * 100 : null;
  const p = row.p * 100;
  const hi = row.hi != null ? row.hi * 100 : null;
  const verdictLine = cand.marketOdds != null
    ? realPriceVerdict(cand.label, cand.marketOdds, row.min_back_odds)
    : `ℹ️ Target @${row.min_back_odds != null ? row.min_back_odds.toFixed(2) : '—'} · No live price check available — check Bet365 yourself for the current price.`;
  const kellyLn = cand.marketOdds != null ? kellyLine(cand.marketOdds, lo) : null;
  const edgeSuffix = cand.edgePp != null ? `, edge ${cand.edgePp >= 0 ? '+' : ''}${cand.edgePp.toFixed(1)}pp` : '';
  const ciLine = lo != null && hi != null
    ? `🧪 p=${p.toFixed(1)}% (CI ${lo.toFixed(1)}–${hi.toFixed(1)}%) — UNVALIDATED${edgeSuffix}`
    : `🧪 p=${p.toFixed(1)}% — UNVALIDATED${edgeSuffix}`;
  const origLabel = pick.betKey === 'over05_2H' ? 'Over 0.5 2H' : 'Over 1.5 2H';
  return buildMessage(
    `🟣 NEWMODEL — 2H recheck (still hasn't happened)`,
    match,
    `${liveMin}' · HT pick was ${origLabel} at ${pick.firedAtMin}' · now ${curScore.home}-${curScore.away} (HT was ${htSnap.home}-${htSnap.away})`,
    [
      `👉 <b>${esc(cand.label)}</b>`,
      verdictLine,
      ...(kellyLn ? [kellyLn] : []),
      ciLine,
    ],
  );
}

// 2026-08-29: re-checks NEWMODEL's own Over-2H-goals HT pick (over05_2H /
// over15_2H) at 68'-72' — LATEGOAL's own proven trigger window (reused
// rather than inventing a new one) — IF it still hasn't happened. This is
// the "wait and see if the market lagged" pattern the user asked for, and
// it deliberately only applies to Over-type bets (over05_2H/over15_2H) —
// see runStrategyNewModel's header comment on why Under-type bets don't get
// this treatment (their correct entry point is HT itself, not a later
// recheck). Prices the SAME market again at the current, later minute — the
// same gamma-Poisson update now reflects however many 2H goals (0 or 1,
// since 2+ would already have resolved the bet) have happened since HT.
async function runStrategyNewModelRecheck(match, ctx) {
  const { matchId, label, tier, liveMin } = ctx;

  if (!cfg.NEWMODEL_ENABLED) return;
  if (liveMin == null || liveMin < cfg.LATEGOAL_TRIGGER_WINDOW[0] || liveMin > cfg.LATEGOAL_TRIGGER_WINDOW[1]) return;

  const pick = _newModelPickTracker.get(matchId);
  if (!pick) return; // NEWMODEL's HT pick for this match wasn't an Over-2H bet (or there was no HT pick)

  const dedupKey = `${matchId}:newmodel_recheck`;
  if (newModelRecheckDedup.has(dedupKey)) return;

  const htSnap = _htSnapshots.get(matchId);
  if (!htSnap) { _newModelPickTracker.delete(matchId); return; }

  const curScore = parseScoreStr(match.score);
  if (!curScore) return;
  const goalsSinceHt = (curScore.home - htSnap.home) + (curScore.away - htSnap.away);
  const neededMoreGoals = pick.betKey === 'over05_2H' ? 1 : 2;
  if (goalsSinceHt >= neededMoreGoals) {
    flogv(liveMin, label, 'NEWMODEL', `RECHECK SKIP: ${pick.betKey} already happened (goals since HT=${goalsSinceHt})`);
    _newModelPickTracker.delete(matchId);
    return;
  }

  const odds = match.bet365_odds;
  if (!odds || odds.ah_hc == null) { flogv(liveMin, label, 'NEWMODEL', 'RECHECK SKIP: no closing AH line'); return; }

  let boot;
  try { boot = LM.init(); } catch (e) { flogv(liveMin, label, 'NEWMODEL', `RECHECK SKIP: LiveModel init failed: ${e.message}`); return; }
  if (!boot.hazardLoaded) return;

  const state = {
    ah_line: odds.ah_hc, tl: odds.tl_c != null ? odds.tl_c : odds.tl_o,
    tier,
    home_goals: curScore.home, away_goals: curScore.away,
    ht_home_goals: htSnap.home, ht_away_goals: htSnap.away,
    red_h: 0, red_a: 0, // no red-card feed — see runStrategyNewModel's header comment
  };
  let lambdaSource = 'bucket_fallback';
  const solved = solveLambdaFromOdds({
    ahLine: odds.ah_hc, ahHomeOdds: odds.ho_c, ahAwayOdds: odds.ao_c,
    tl: state.tl, overOdds: odds.ov_c, underOdds: odds.un_c, tier,
  });
  if (solved.ok) {
    state.lambda_h = solved.lambda_h; state.lambda_a = solved.lambda_a; state.rho = solved.rho;
    lambdaSource = 'per_match_solver';
  }

  const line = pick.betKey === 'over05_2H' ? 0.5 : 1.5;
  let row;
  try {
    row = LM.priceMarket({ type: 'over', line, scope: 'half' }, state, String(liveMin), { samples: cfg.NEWMODEL_MC_SAMPLES });
  } catch (e) {
    flogv(liveMin, label, 'NEWMODEL', `RECHECK SKIP: pricing failed: ${e.message}`);
    return;
  }

  // Invariant of how many (0 or 1) 2H goals have happened so far, as long as
  // the bet hasn't already resolved — see header comment's math: the
  // equivalent FT total-target is always htTotal + (0.5 for over05_2H,
  // 1.5 for over15_2H), never needs recomputing against the current score.
  const avgTl = pick.htTotal + (pick.betKey === 'over05_2H' ? 0.5 : 1.5);
  const recheckLabel = `Over ${avgTl} FT (2H: ${pick.betKey === 'over05_2H' ? 'Over 0.5' : 'Over 1.5'})`;

  let chosen = null;
  if (cfg.APIFOOTBALL_KEY) {
    try {
      const check = await verifyBet365Price('overTL', {
        matchId, homeTeam: match.home_team, awayTeam: match.away_team,
        favSide: odds.ah_hc < 0 ? 'HOME' : 'AWAY', favLine: Math.abs(odds.ah_hc), avgTl,
      }, cfg.APIFOOTBALL_KEY);
      if (check.supported && check.odds != null) {
        const edge = newModelEdge(row.lo * 100, check.odds);
        if (edge.edgePp != null && edge.edgePp >= cfg.NEWMODEL_MIN_EDGE_PP) {
          chosen = { label: recheckLabel, betKey: pick.betKey, row, marketOdds: check.odds, edgePp: edge.edgePp };
        }
      }
    } catch (e) {
      flogv(liveMin, label, 'NEWMODEL', `RECHECK api-football check failed: ${e.message}`);
    }
  }
  // Unverified fallback — fires even without a working api-football key,
  // same as the HT alert's own Step 3.
  if (!chosen && row.lo != null && row.lo * 100 >= cfg.NEWMODEL_MIN_LO_UNVERIFIED) {
    chosen = { label: recheckLabel, betKey: pick.betKey, row, marketOdds: null, edgePp: null };
  }

  _newModelPickTracker.delete(matchId); // one recheck attempt per match, whether it fires or not

  if (!chosen) { flogv(liveMin, label, 'NEWMODEL', 'RECHECK SKIP: no longer clears the edge/confidence bar'); return; }

  const msg = newModelRecheckFormat(match, chosen, liveMin, htSnap, curScore, odds, pick);
  await sendTelegram(msg);
  newModelRecheckDedup.mark(dedupKey);
  flog(liveMin, label, 'NEWMODEL', `RECHECK ALERT: ${chosen.label} p=${(chosen.row.p * 100).toFixed(1)}% lo=${(chosen.row.lo * 100).toFixed(1)}% edge=${chosen.edgePp != null ? chosen.edgePp.toFixed(1) + 'pp' : 'unverified'} tier=${tier} lambdaSource=${lambdaSource}`);

  // Tagged as its own strategy ('NEWMODEL_RECHECK', not 'NEWMODEL') so the
  // digest's by-strategy breakdown can answer, once enough data accumulates,
  // whether waiting for confirmation actually helps or hurts vs. betting the
  // HT pick immediately.
  recordAlert({
    matchId, homeTeam: match.home_team, awayTeam: match.away_team,
    league: match.league, tier,
    fixtureId: null, betKey: chosen.betKey, betLabel: chosen.label,
    favSide: odds.ah_hc < 0 ? 'HOME' : 'AWAY', favLine: Math.abs(odds.ah_hc),
    tlLine: odds.tl_c,
    priceAtAlert: chosen.marketOdds,
    mo: chosen.row.fair_odds ?? null, mo_lo: chosen.row.min_back_odds ?? null,
    strategy: 'NEWMODEL_RECHECK',
    venue: 'soft',
    minute: liveMin,
    state: { score: `${curScore.home}-${curScore.away}`, redCards: 0, half: 2, lambdaSource },
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

// ── Match fetcher ─────────────────────────────────────────────────────────────
// Always goes straight to Bet365 via livescore.js's own hash discovery — NOT
// through the Cloudflare Pages Function (functions/api/livescore.js).
// DATA_URL only controls where the historical CSV dataset is loaded from
// (see loadDb()) — it's unrelated to live match fetching.
//
// Merges TWO distinct botbot3 endpoints, not just one — this was a real gap
// (found 2026-08-27) that silently starved every pre-match strategy (L123,
// DASHBOARD) of candidates since they were added: fetchLiveMatches() hits
// the `livegame` table, which only lists matches once they're already live
// (or immediately about to be) — a match sitting 5-15 minutes before kickoff
// simply never appears there, so isL123Fire/isDashboardFire's pre-kickoff
// window logic had nothing to ever fire on in practice (confirmed empirically
// against 3 real matches today: none appeared in the live feed pre-kickoff,
// all only appeared once already live). fetchNextMatches() hits the separate
// `tablenext` table (same BET365_HASH, no Pinnacle involved — this app is
// Bet365-priced end to end), which DOES list genuinely upcoming fixtures
// with a real kickoff_time — this is what the pre-match window logic
// actually needs. Merged by id, live-match data preferred on overlap (it's
// more current/complete — has minute/score, not just kickoff_time).
async function fetchMatches() {
  const [liveResult, nextResult] = await Promise.all([fetchLiveMatches(), fetchNextMatches()]);
  if (liveResult.bet365HashFailed) await notifyHashFailed('Bet365', (liveResult.bet365Hash || '????????').slice(0, 8));
  else if (nextResult.bet365HashFailed) await notifyHashFailed('Bet365', (nextResult.bet365Hash || '????????').slice(0, 8));

  const merged = new Map();
  for (const m of nextResult.matches) if (m.id) merged.set(m.id, m);
  for (const m of liveResult.matches) merged.set(m.id || `${m.home_team}:${m.away_team}`, m);
  return [...merged.values()];
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
    const { matchId, label, tier, liveMin, toKickoff, isL123Fire, isDashboardFire } = ctx;

    // HT snapshot capture happens for every live match regardless of which
    // strategy (if any) fires — LateGoal needs it much later (at 70'+), so
    // it has to be recorded the moment a match passes through HT, not just
    // when a strategy happens to be checking that match right now.
    if (liveMin != null) captureHtSnapshot(matchId, liveMin, match.score);

    // isL123Fire (10min window) and isDashboardFire (15min window) are
    // independent, not mutually exclusive — a match 12 minutes from kickoff
    // is in the Dashboard window but not L123's, and both can be true at
    // once inside 10 minutes. Each strategy has its own dedup key, so
    // running both here is safe.
    if (isL123Fire || isDashboardFire) {
      inWindowCount++;
      flogv(liveMin, `${label} [${tier}]`, 'ALL', `pre-match, kickoff in ${Math.round(toKickoff)}m  bet365_odds=${match.bet365_odds ? 'ok' : 'MISSING'}`);
      if (isL123Fire) await runStrategyL123(match, ctx);
      if (isDashboardFire) await runStrategyDashboard(match, ctx);
    } else if (liveMin != null) {
      flogv(liveMin, `${label} [${tier}]`, 'ALL', `live ${liveMin}'  score=${match.score || '—'}`);
      await runStrategyQuiet2H(match, ctx);
      await runStrategyLateGoal(match, ctx);
      await runStrategyHtPick(match, ctx);
      await runStrategyNewModel(match, ctx);
      await runStrategyNewModelRecheck(match, ctx);
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

// ── Hash relay server ────────────────────────────────────────────────────────
// asianbetsoccer.com's WAF blocks discovery requests from Cloudflare's edge
// (confirmed 2026-08-24 — both header sets get a 202 bot-challenge from
// functions/api/livescore.js), but Railway's outbound IP isn't subject to
// that block, so this Node process is the reliable source of a fresh hash.
// Exposes GET /hashes so the Cloudflare Function can relay through here
// instead of hitting asianbetsoccer.com directly when its own discovery
// fails — closes the loop that used to require pasting a fresh hash in by
// hand. Only starts if Railway has assigned a PORT (public networking must
// be enabled on the Railway service for this to be reachable externally).
function startHashRelayServer() {
  if (!process.env.PORT) {
    console.log('Hash relay: PORT not set — skipping (enable Railway public networking to serve /hashes).');
    return;
  }
  const server = http.createServer((req, res) => {
    if (req.url === '/hashes') {
      const { pinnacle, bet365, sbobet } = getCurrentHashes();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ pinnacle_hash: pinnacle, bet365_hash: bet365, sbobet_hash: sbobet }));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  server.listen(process.env.PORT, () => {
    console.log(`Hash relay: listening on :${process.env.PORT} (GET /hashes)`);
  });
}

// ── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  const once = process.argv.includes('--once');

  await loadDb();
  startHashRelayServer();

  const on = s => s ? 'ON ' : 'OFF';
  console.log(`Strategy L123 [${on(cfg.L123_ENABLED)}][${cfg.L123_TIER}]: Layer 1(open)/2(move)/3(close) consensus  minAgree=${cfg.L123_MIN_AGREE}/3  fire=${PRE_MATCH_WINDOW_MIN}min pre-kickoff window  n≥${cfg.L123_MIN_N} z≥${cfg.L123_MIN_Z} edge≥${cfg.L123_MIN_EDGE}pp bl≥${cfg.L123_MIN_BASELINE}%`);
  console.log(`Strategy HTPICK [${on(cfg.HTPICK_ENABLED)}][${cfg.HTPICK_TIER}]: cross-fit HT pick  fire=HT window ${HT_SNAPSHOT_WINDOW[0]}'-${HT_SNAPSHOT_WINDOW[1]}'  n≥${cfg.HTPICK_MIN_N} z≥${cfg.HTPICK_MIN_Z} edge≥${cfg.HTPICK_MIN_EDGE}pp`);
  console.log(`Strategy DASHBOARD [${on(cfg.DASHBOARD_ENABLED)}][${cfg.DASHBOARD_TIER}]: cross-fit opening-odds pick  fire=${cfg.DASHBOARD_WINDOW_MIN}min pre-kickoff window  n≥${cfg.DASHBOARD_MIN_N} z≥${cfg.DASHBOARD_MIN_Z} edge≥${cfg.DASHBOARD_MIN_EDGE}pp`);
  console.log(`Strategy NEWMODEL [${on(cfg.NEWMODEL_ENABLED)}][${cfg.NEWMODEL_TIER}]: E8 LiveModel HT reprice (UNVALIDATED)  fire=HT window ${HT_SNAPSHOT_WINDOW[0]}'-${HT_SNAPSHOT_WINDOW[1]}'  minEdge≥${cfg.NEWMODEL_MIN_EDGE_PP}pp  minLoUnverified≥${cfg.NEWMODEL_MIN_LO_UNVERIFIED}%`);
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
