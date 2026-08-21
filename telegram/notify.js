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
  scoreBets,
} = require('./engine');
const { fetchLiveMatches, refreshHashes } = require('./livescore');

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

// Compute window flags and common fields for a match once per scan iteration.
function matchContext(match) {
  const liveMin = parseLiveMinute(match.minute);
  return {
    matchId:    match.id || `${match.home_team}:${match.away_team}`,
    label:      `${match.home_team} vs ${match.away_team}`,
    tier:       classifyLeague(match.league || ''),
    liveMin,
    isL123Fire: liveMin != null,
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

function l123Format(match, agreeCount, bet, votes, liveMin, liveOdds) {
  // The action line is the single thing to actually do — put it right under
  // the bet name, bolded, with a clear pass/fail marker against live price
  // (always ✅ here: runStrategyL123 already skips the alert otherwise).
  const actionLine = liveOdds != null
    ? `✅ Bet  @${liveOdds.toFixed(2)} — clears the min (≥ @${bet.mo_lo ?? '—'})`
    : `📌 Bet at ≥ <b>@${bet.mo_lo ?? '—'}</b>  (best case @${bet.mo ?? '—'})`;
  return buildMessage(
    `L123 ALERT — ${agreeCount}/3 layers agree`,
    match,
    `${liveMin}' · Score ${match.score || '0-0'}`,
    [
      `💰 <b>${esc(bet.label)}</b>`,
      actionLine,
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
  const { matchId, label, tier, liveMin, isL123Fire } = ctx;

  if (!cfg.L123_ENABLED) return;
  if (!isL123Fire) { flogv(liveMin, label, 'L123', `SKIP: match not live yet (min=${liveMin})`); return; }
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

  const msg = l123Format(match, topCount, bet, votes, liveMin, liveOdds);
  await sendTelegram(msg);
  l123Dedup.mark(dedupKey);
  flog(liveMin, label, 'L123', `ALERT: ${topCount}/3 agree on ${topKey} edge=${bet.edge.toFixed(1)}pp z=${bet.z.toFixed(2)} n=${bet.n} tier=${tier}`);
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
    const { label, tier, liveMin, isL123Fire } = ctx;

    if (!isL123Fire) {
      flogv(liveMin, `${label} [${tier}]`, 'ALL', `not live (min=${liveMin ?? 'no_time'})`);
      continue;
    }

    inWindowCount++;
    flogv(liveMin, `${label} [${tier}]`, 'ALL', `live(${liveMin}')  score=${match.score || '—'}  bet365_odds=${match.bet365_odds ? 'ok' : 'MISSING'}`);

    await runStrategyL123(match, ctx);
  }

  console.log(`Scan done — ${matches.length} matches · ${inWindowCount} in window · ${_scanAlerts} alert(s) sent.`);
}

// ── Entry point ──────────────────────────────────────────────────────────────
async function main() {
  const once = process.argv.includes('--once');

  await loadDb();

  const on = s => s ? 'ON ' : 'OFF';
  console.log(`Strategy L123 [${on(cfg.L123_ENABLED)}][${cfg.L123_TIER}]: Layer 1(open)/2(move)/3(close) consensus  minAgree=${cfg.L123_MIN_AGREE}/3  fire=any live minute  n≥${cfg.L123_MIN_N} z≥${cfg.L123_MIN_Z} edge≥${cfg.L123_MIN_EDGE}pp bl≥${cfg.L123_MIN_BASELINE}%`);
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
}

main().catch(e => { console.error(e); process.exit(1); });
