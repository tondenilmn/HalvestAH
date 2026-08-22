'use strict';
// ── L123 TRACK RECORD ─────────────────────────────────────────────────────────
// Closes the loop the walk-forward validation opened: instead of only
// retrospectively checking whether historical qualifying picks held up, this
// logs every REAL alert L123 sends, checks the actual final result once the
// match is over (via api-football), and periodically reports a live scorecard
// (hit rate + ROI@price-shown-at-alert-time) to Telegram — so the answer to
// "is this actually working" comes from real, ongoing alerts, not just a
// backtest.
//
// Persistence is a flat JSON file (telegram/data/alert_log.json) — no
// database needed for this volume, and it needs to survive process restarts
// (Railway redeploys, local restarts) since settlement happens hours after
// the alert was sent, often in a later process lifetime.
//
// Requires APIFOOTBALL_KEY (config.js) — without it, settlePendingAlerts()
// is a no-op and the digest will just report "no settled alerts yet". This
// module never fires or blocks an alert; it only records/reports after the
// fact.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'alert_log.json');
const STATE_FILE = path.join(DATA_DIR, 'track_state.json');

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadLog() {
  ensureDataDir();
  if (!fs.existsSync(LOG_FILE)) return [];
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf8')); } catch { return []; }
}
function saveLog(entries) {
  ensureDataDir();
  fs.writeFileSync(LOG_FILE, JSON.stringify(entries, null, 2));
}
function loadState() {
  ensureDataDir();
  if (!fs.existsSync(STATE_FILE)) return {};
  try { return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')); } catch { return {}; }
}
function saveState(state) {
  ensureDataDir();
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

// Called right after an alert is sent. `entry` carries everything needed to
// settle it later: matchId, fixtureId (if known from the api-football check
// at alert time), homeTeam, awayTeam, league, tier, betKey, betLabel,
// favSide, favLine (fav's AH line, positive), tlLine (this match's actual
// closing total line), priceAtAlert (the live price shown in the alert, if
// any — liveOdds or the api-football odds), mo, mo_lo.
function recordAlert(entry) {
  const log = loadLog();
  log.push({ ...entry, timestamp: Date.now(), settled: false, result: null, finalScore: null, fraction: null });
  saveLog(log);
}

// ── Settlement math (same fraction convention as league_analysis.js/poisson_model.js) ──
function settlementFraction(margin) {
  if (margin > 0.49) return 1;
  if (margin > 0.01) return 0.5;
  if (margin > -0.49) return margin > -0.01 ? 0 : -0.5;
  return -1;
}
function boolFraction(b) { return b === true ? 1 : b === false ? -1 : null; }

// Settles any of L123's 32 possible bet keys given the match's actual FT/HT
// goals plus the context stashed on the alert entry. Mirrors engine.js's
// BETS boolean definitions exactly (see engine.js processRow), reimplemented
// here from raw scores since we only have the final result, not a processed
// row. ahCover/dogCover use the FULL-MATCH margin (not engine.js's own
// 2H-only field, which is deliberately scoped for the HT-conditional live
// tool elsewhere — see league_analysis.js's correctAhFields for the same
// distinction) since this is settling a real pre-match/live bet on the
// actual full-time result.
function settleBetKey(betKey, { ftH, ftA, htH, htA, favSide, favLine, tlLine }) {
  if (ftH == null || ftA == null) return null;
  const favFt = favSide === 'HOME' ? ftH : ftA;
  const dogFt = favSide === 'HOME' ? ftA : ftH;

  switch (betKey) {
    case 'ahCover':   return favLine == null ? null : settlementFraction(favFt - dogFt - favLine);
    case 'dogCover':  return favLine == null ? null : settlementFraction(dogFt - favFt + favLine);
    case 'overTL':    return tlLine  == null ? null : settlementFraction((ftH + ftA) - tlLine);
    case 'underTL':   return tlLine  == null ? null : settlementFraction(tlLine - (ftH + ftA));
    case 'homeWinsFT': return boolFraction(ftH > ftA);
    case 'awayWinsFT': return boolFraction(ftA > ftH);
    case 'drawFT':     return boolFraction(ftH === ftA);
    case 'btts':       return boolFraction(ftH >= 1 && ftA >= 1);
    case 'over15FT':   return boolFraction(ftH + ftA >= 2);
    case 'over25FT':   return boolFraction(ftH + ftA >= 3);
    case 'over35FT':   return boolFraction(ftH + ftA >= 4);
    case 'under25FT':  return boolFraction(ftH + ftA <= 2);
  }

  if (htH == null || htA == null) return null; // everything below needs HT to derive 1H/2H
  const favHt = favSide === 'HOME' ? htH : htA;
  const dogHt = favSide === 'HOME' ? htA : htH;
  const fav2h = favFt - favHt, dog2h = dogFt - dogHt;
  const home2h = ftH - htH, away2h = ftA - htA;

  switch (betKey) {
    case 'favScored2H':   return boolFraction(fav2h >= 1);
    case 'favWins2H':     return boolFraction(fav2h > dog2h);
    case 'draw2H':        return boolFraction(fav2h === dog2h);
    case 'over05_2H':     return boolFraction(home2h + away2h >= 1);
    case 'over15_2H':     return boolFraction(home2h + away2h >= 2);
    case 'homeWins2H':    return boolFraction(home2h > away2h);
    case 'awayWins2H':    return boolFraction(away2h > home2h);
    case 'homeScored2H':  return boolFraction(home2h >= 1);
    case 'awayScored2H':  return boolFraction(away2h >= 1);
    case 'homeOver15_2H': return boolFraction(home2h >= 2);
    case 'awayOver15_2H': return boolFraction(away2h >= 2);
    case 'under05_2H':    return boolFraction(home2h + away2h === 0);
    case 'under15_2H':    return boolFraction(home2h + away2h <= 1);
    case 'favWins1H':     return boolFraction(favHt > dogHt);
    case 'draw1H':        return boolFraction(favHt === dogHt);
    case 'homeWins1H':    return boolFraction(htH > htA);
    case 'awayWins1H':    return boolFraction(htA > htH);
    case 'favScored1H':   return boolFraction(favHt >= 1);
    case 'btts1H':        return boolFraction(htH >= 1 && htA >= 1);
    case 'over05_1H':     return boolFraction(htH + htA >= 1);
    case 'over15_1H':     return boolFraction(htH + htA >= 2);
    case 'under05_1H':    return boolFraction(htH + htA === 0);
    case 'under15_1H':    return boolFraction(htH + htA <= 1);
    default: return null;
  }
}

// ── api-football fixture-result lookup ────────────────────────────────────────
async function apiGet(urlPath, key) {
  const res = await fetch(`https://v3.football.api-sports.io${urlPath}`, { headers: { 'x-apisports-key': key } });
  if (!res.ok) throw new Error(`api-football ${urlPath} -> HTTP ${res.status}`);
  const json = await res.json();
  if (json.errors && Object.keys(json.errors).length) throw new Error(`api-football error: ${JSON.stringify(json.errors)}`);
  return json;
}
function normName(s) {
  return String(s).toLowerCase().replace(/\b(fc|afc|cf|sc|fk|ac|bfc|bc|utd|united)\b/g, '').replace(/[^a-z0-9]/g, ' ').replace(/\s+/g, ' ').trim();
}
function namesMatch(a, b) {
  const na = normName(a), nb = normName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

const FINISHED_STATUSES = new Set(['FT', 'AET', 'PEN']);
const VOID_STATUSES = new Set(['CANC', 'ABD', 'PST', 'WO']);

async function fetchFixtureResult(entry, key) {
  let fixtureId = entry.fixtureId;
  if (!fixtureId) {
    const day = new Date(entry.timestamp).toISOString().slice(0, 10);
    const data = await apiGet(`/fixtures?date=${day}`, key);
    const f = (data.response || []).find(x =>
      namesMatch(x.teams?.home?.name, entry.homeTeam) && namesMatch(x.teams?.away?.name, entry.awayTeam));
    if (!f) return null;
    fixtureId = f.fixture.id;
  }
  const data = await apiGet(`/fixtures?id=${fixtureId}`, key);
  const f = data.response?.[0];
  if (!f) return null;
  return {
    status: f.fixture?.status?.short,
    ftH: f.goals?.home ?? null, ftA: f.goals?.away ?? null,
    htH: f.score?.halftime?.home ?? null, htA: f.score?.halftime?.away ?? null,
  };
}

// Only spends an API call on alerts old enough that the match should
// plausibly be over (2.5h buffer for delays/stoppage/ET), and only for
// still-unsettled entries — cheap by construction (zero calls once
// everything outstanding is settled), safe to call every scan cycle.
const SETTLE_AFTER_MS = 2.5 * 60 * 60 * 1000;

async function settlePendingAlerts(apiFootballKey) {
  if (!apiFootballKey) return { checked: 0, settled: 0 };
  const log = loadLog();
  const now = Date.now();
  let checked = 0, settled = 0;

  for (const entry of log) {
    if (entry.settled) continue;
    if (now - entry.timestamp < SETTLE_AFTER_MS) continue;
    checked++;
    try {
      const result = await fetchFixtureResult(entry, apiFootballKey);
      if (!result) continue; // not found yet — retry next cycle

      if (VOID_STATUSES.has(result.status)) { entry.settled = true; entry.result = 'VOID'; continue; }
      if (!FINISHED_STATUSES.has(result.status)) continue; // still not over

      entry.finalScore = `${result.ftH}-${result.ftA}` + (result.htH != null ? ` (HT ${result.htH}-${result.htA})` : '');
      const fraction = settleBetKey(entry.betKey, {
        ftH: result.ftH, ftA: result.ftA, htH: result.htH, htA: result.htA,
        favSide: entry.favSide, favLine: entry.favLine, tlLine: entry.tlLine,
      });
      entry.fraction = fraction;
      if (fraction != null) {
        entry.settled = true;
        entry.result = fraction > 0 ? (fraction === 1 ? 'WIN' : 'HALF-WIN')
          : fraction === 0 ? 'PUSH' : (fraction === -1 ? 'LOSS' : 'HALF-LOSS');
        settled++;
      } // else: match finished but we're missing HT data for a 1H/2H bet — leave open, retry later
    } catch (e) {
      console.error(`[track_record] settle failed for ${entry.homeTeam} vs ${entry.awayTeam}: ${e.message}`);
    }
  }

  saveLog(log);
  return { checked, settled };
}

// ── Digest ─────────────────────────────────────────────────────────────────────
function buildDigestMessage(windowDays = 7) {
  const log = loadLog();
  const cutoff = Date.now() - windowDays * 24 * 60 * 60 * 1000;
  const settled = log.filter(e => e.settled && e.result !== 'VOID' && e.timestamp >= cutoff);

  if (!settled.length) {
    return `📋 <b>L123 Track Record (last ${windowDays}d)</b>\n\nNo settled alerts in this window yet.`;
  }

  const nonPush = settled.filter(e => e.fraction !== 0);
  const hitPts = nonPush.reduce((s, e) => s + (e.fraction > 0 ? (e.fraction === 1 ? 1 : 0.5) : 0), 0);
  const hitRate = nonPush.length ? hitPts / nonPush.length * 100 : 0;

  const lines = [
    `📋 <b>L123 Track Record (last ${windowDays}d)</b>`,
    ``,
    `Alerts settled: ${settled.length}`,
    `Hit rate: ${hitRate.toFixed(1)}% (n=${nonPush.length}, excl. pushes)`,
  ];

  const priced = nonPush.filter(e => e.priceAtAlert != null);
  if (priced.length) {
    const pnl = priced.reduce((s, e) => s + (
      e.fraction === 1 ? e.priceAtAlert - 1 :
      e.fraction === 0.5 ? (e.priceAtAlert - 1) / 2 :
      e.fraction === -0.5 ? -0.5 : -1
    ), 0);
    const roi = pnl / priced.length * 100;
    lines.push(`ROI @ price shown at alert time: ${roi >= 0 ? '+' : ''}${roi.toFixed(1)}% (n=${priced.length} priced picks)`);
  } else {
    lines.push(`(No priced picks this window — ROI unavailable, hit rate only.)`);
  }

  const byBet = new Map();
  for (const e of settled) {
    if (!byBet.has(e.betLabel)) byBet.set(e.betLabel, { n: 0, hits: 0 });
    const b = byBet.get(e.betLabel);
    b.n++;
    if (e.fraction > 0) b.hits += e.fraction === 1 ? 1 : 0.5;
  }
  const topBets = [...byBet.entries()].sort((a, b) => b[1].n - a[1].n).slice(0, 5);
  if (topBets.length) {
    lines.push(``, `By bet type:`);
    for (const [label, s] of topBets) lines.push(`  ${label}: ${(s.hits / s.n * 100).toFixed(0)}% (n=${s.n})`);
  }

  return lines.join('\n');
}

module.exports = { recordAlert, settlePendingAlerts, buildDigestMessage, loadState, saveState };
