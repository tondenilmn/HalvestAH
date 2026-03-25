'use strict';
// ── HalvestAH Telegram Notifier ───────────────────────────────────────────────
// Runs a live scan every N minutes and sends Telegram alerts for qualifying bets.
//
// Usage:
//   node notify.js          — start the scheduler (runs forever)
//   node notify.js --once   — run one scan immediately and exit (for testing)

const path   = require('path');
const cron   = require('node-cron');
const cfg    = require('./config');
const { loadDatabase, loadDatabaseFromUrl, buildCfgFromMatch, applyConfig, applyBaselineConfig, applyGameState, scoreBets } = require('./engine');

const HT_MIN_MINUTE = 46;   // start of HT window (definitively HT, no 2H goals yet)
const HT_MAX_MINUTE = 56;   // end of HT window (10-min band covers any scan interval)
const { fetchLiveMatches } = require('./livescore');

// GSA probe: restrict HT alerts to these 5 live 2H bets where the signal
// meaningfully adds above the HT-conditioned baseline and odds are findable.
const HT_ALLOWED_BETS = new Set([
  'homeScored2H', 'awayScored2H',
  'over05_2H', 'over15_2H', 'under15_2H',
]);

// GSA actionability thresholds
const GSA_MIN_DELTA   = 4;    // Δ signal vs HT-conditioned baseline (pp)
const GSA_MIN_N       = 20;   // min rows after HT game state filter
const GSA_MAX_CONS_ODDS = 2.20; // conservative odds ceiling (realistic to find)

// ── Telegram ──────────────────────────────────────────────────────────────────
async function sendTelegram(text) {
  const url = `https://api.telegram.org/bot${cfg.TELEGRAM_TOKEN}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id:    cfg.TELEGRAM_CHAT_ID,
        text,
        parse_mode: 'HTML',
      }),
    });
    if (!res.ok) {
      const err = await res.text();
      console.error(`Telegram error: ${err}`);
    }
  } catch (e) {
    console.error(`Telegram fetch failed: ${e.message}`);
  }
}

// ── Kelly stake calculator ─────────────────────────────────────────────────────
// Returns the quarter-Kelly fraction (0–1), or null if the bet has no edge at
// the given odds. Uses min odds as the conservative odds input.
// Quarter Kelly (25% of full Kelly) is the standard for managing variance.
function computeKelly(p, mo) {
  if (!mo || mo <= 1 || p <= 0 || p >= 1) return null;
  const b = mo - 1;                   // net odds (e.g. 1.85 → 0.85)
  const fullKelly = (p * b - (1 - p)) / b;
  return fullKelly > 0 ? fullKelly * 0.25 : null;
}

// ── Timestamp helper ──────────────────────────────────────────────────────────
function nowStamp() {
  const d   = new Date();
  const hh  = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return { time: `${hh}:${min}` };
}

// ── Bet type classifier ────────────────────────────────────────────────────────
function betTypeInfo(minute) {
  const n = minute ? parseInt(minute, 10) : NaN;
  if (isNaN(n)) return { label: 'PreMatch', icon: '⏳' };
  if (n > 45)   return { label: 'Live 2T',  icon: '🔴' };
  return           { label: 'Live 1T',  icon: '🟡' };
}

// ── Z-score strength icon ──────────────────────────────────────────────────────
function zIcon(z) {
  if (z >= 3.5) return '🔥';
  if (z >= 3.0) return '⚡';
  if (z >= 2.5) return '✅';
  return '📊';
}

// ── Bet row renderer ───────────────────────────────────────────────────────────
function formatBetLines(bets, gsMap = null) {
  return [...bets].sort((a, b) => b.z - a.z).map(b => {
    const icon    = zIcon(b.z);
    const zStr    = b.z.toFixed(2);
    const edgeStr = (b.edge >= 0 ? '+' : '') + b.edge.toFixed(1) + 'pp';
    // mo = fair value (lower decimal odds), mo_mid = conservative (higher decimal odds)
    const oddsRange = (b.mo_mid && b.mo) ? `${b.mo}–${b.mo_mid}` : (b.mo || '—');

    let gsLine = '';
    if (gsMap) {
      const gs = gsMap.get(b.k);
      if (gs && gs.n >= 10) {
        const gz = gs.z.toFixed(2);
        gsLine = `\n   <i>↳ in-play  ${gs.p.toFixed(0)}% vs ${gs.bl.toFixed(0)}%  z=${gz}  n=${gs.n}</i>`;
      }
    }

    return (
      `${icon} <b>${b.label}</b>\n` +
      `   [<code>${oddsRange}</code>]  ${edgeStr}  z=${zStr}  n=${b.n}${gsLine}`
    );
  }).join('\n\n');
}

// ── Signal builders ────────────────────────────────────────────────────────────
// Returns the LM signal string to append to the AH line, e.g. " (STEAM)"
function ahSignalSuffix(matchCfg) {
  const sig = matchCfg.signals;
  const parts = [];
  if (sig.lineMove === 'DEEPER' || sig.lineMove === 'SHRANK') parts.push(sig.lineMove);
  if (cfg.FAV_ODDS_ON && sig.favOddsMove !== 'UNKNOWN' && sig.favOddsMove !== 'STABLE') parts.push(`Fav ${sig.favOddsMove}`);
  if (cfg.DOG_ODDS_ON && sig.dogOddsMove !== 'UNKNOWN' && sig.dogOddsMove !== 'STABLE') parts.push(`Dog ${sig.dogOddsMove}`);
  return parts.length ? ` <i>(${parts.join('  ·  ')})</i>` : '';
}

// Returns the TL line, e.g. "TL: 2.75 (UP)", or null if not available
function tlLine(match) {
  const { tl_c, tl_o } = match.odds;
  if (tl_c == null) return null;
  let dir = '';
  if (tl_o != null && tl_c !== tl_o) {
    dir = tl_c > tl_o ? ' <i>(UP)</i>' : ' <i>(DOWN)</i>';
  }
  return `📏 TL: ${tl_c}${dir}`;
}

// ── Pre-match / live alert formatter ──────────────────────────────────────────
// gsMap: Map of betKey → gs result for in-play enrichment lines (optional)
function formatMessage(match, bets, matchCfg, gsMap) {
  const { time } = nowStamp();
  const ahSide = matchCfg.fav_side === 'HOME' ? 'Home' : 'Away';
  const { label: btLabel, icon: btIcon } = betTypeInfo(match.minute);
  const scoreMin = match.score && match.minute
    ? `${match.score}  (${match.minute})`
    : match.score || 'Pre-match';
  const gsLabel = gsMap && match._gsLabel ? `\n🎯 <i>${match._gsLabel}</i>` : '';
  const tl = tlLine(match);

  const header = [
    `${btIcon} ${btLabel}  ·  ${time}`,
    ``,
    `🏆 <i>${match.league || '—'}</i>`,
    `⚽ <b>${match.home_team} vs ${match.away_team}</b>  <code>${scoreMin}</code>`,
    `⚖️ ${ahSide} -${matchCfg.fav_line}${ahSignalSuffix(matchCfg)}${gsLabel}`,
    tl,
  ].filter(l => l != null).join('\n');

  return `${header}\n\n${formatBetLines(bets, gsMap)}\n`;
}

// ── GSA bet row renderer (HT alerts) ──────────────────────────────────────────
// Shows absolute probability, delta vs HT-conditioned baseline, and fair/cons odds.
function formatGsaBetLines(bets) {
  return [...bets].sort((a, b) => b.edge - a.edge).map(b => {
    const pStr    = b.p.toFixed(0) + '%';
    const deltaStr = (b.edge >= 0 ? '+' : '') + b.edge.toFixed(1) + 'pp';
    const blStr   = b.bl.toFixed(0) + '%';
    const fairStr  = b.mo   ? `@${b.mo}`   : '—';
    const consStr  = b.mo_mid ? `≤${b.mo_mid}` : '—';
    return (
      `🎯 <b>${b.label}</b>\n` +
      `   P=${pStr} vs ${blStr} (Δ ${deltaStr})  fair ${fairStr}  cons ${consStr}  n=${b.n}`
    );
  }).join('\n\n');
}

// ── Half-time alert formatter ──────────────────────────────────────────────────
function formatHtMessage(match, bets, matchCfg, homeGoals, awayGoals) {
  const { time } = nowStamp();
  const ahSide = matchCfg.fav_side === 'HOME' ? 'Home' : 'Away';
  const tl = tlLine(match);

  const header = [
    `⏸ Half Time GSA  ·  ${time}`,
    ``,
    `🏆 <i>${match.league || '—'}</i>`,
    `⚽ <b>${match.home_team} vs ${match.away_team}</b>  <code>HT ${homeGoals}-${awayGoals}</code>`,
    `⚖️ ${ahSide} -${matchCfg.fav_line}${ahSignalSuffix(matchCfg)}`,
    tl,
  ].filter(l => l != null).join('\n');

  return `${header}\n\n${formatGsaBetLines(bets)}\n`;
}

// ── Game state builder ─────────────────────────────────────────────────────────
// Derives a game state object from the live match data.
// If minute > 45 we're in 2H — use current score as HT proxy (best we have).
// If minute ≤ 45 we're in 1H — use FIRST_GOAL trigger based on whether
// the score is still 0-0 or someone has scored.
function buildGameState(match, matchCfg) {
  const score  = match.score;  // e.g. "1-0" or null
  const minute = match.minute; // e.g. "67'" or null

  if (!score || !minute) return null;

  const minNum = parseInt(minute, 10);
  if (isNaN(minNum)) return null;

  const parts = score.split('-');
  const homeG = parseInt(parts[0], 10);
  const awayG = parseInt(parts[1], 10);
  if (isNaN(homeG) || isNaN(awayG)) return null;

  if (minNum > 45) {
    // 2H in-play: use HT trigger with current score as proxy
    // (we don't have the actual HT split, this is an approximation)
    return {
      trigger:    'HT',
      home_goals: homeG,
      away_goals: awayG,
      _label:     `HT ${homeG}-${awayG} (approx)`,
      _approx:    true,
    };
  } else {
    // 1H in-play: use FIRST_GOAL trigger
    const favSide = matchCfg.fav_side;
    const favG = favSide === 'HOME' ? homeG : awayG;
    const dogG = favSide === 'HOME' ? awayG : homeG;
    let firstGoal;
    if (favG > 0)      firstGoal = 'FAV_1H';
    else if (dogG > 0) firstGoal = 'DOG_1H';
    else               firstGoal = null; // 0-0 in 1H — no first goal yet
    if (!firstGoal) return null; // nothing interesting to filter on
    return {
      trigger:     'FIRST_GOAL',
      first_goal:  firstGoal,
      _label:      `1H ${score} (${firstGoal})`,
      _approx:     false,
    };
  }
}

// ── Deduplication ─────────────────────────────────────────────────────────────
// In-memory — resets on restart. Keyed by matchId + betKey.
// Expires entries after 2 hours so a match can re-alert if signals change between runs.
const _notified = new Map(); // key → timestamp

function alreadyNotified(matchId, betKey) {
  const key = `${matchId}:${betKey}`;
  const ts  = _notified.get(key);
  if (!ts) return false;
  if (Date.now() - ts > 2 * 60 * 60 * 1000) { _notified.delete(key); return false; }
  return true;
}

function markNotified(matchId, betKey) {
  _notified.set(`${matchId}:${betKey}`, Date.now());
}

// ── Core scan ─────────────────────────────────────────────────────────────────
let _db       = null;
let _dbPromise = null; // deduplicate concurrent calls during startup

async function getDb() {
  if (_db) return _db;
  if (_dbPromise) return _dbPromise;

  _dbPromise = (async () => {
    if (cfg.DATA_URL) {
      console.log(`Loading database from ${cfg.DATA_URL}…`);
      _db = await loadDatabaseFromUrl(cfg.DATA_URL);
    } else {
      const dataDir = path.resolve(__dirname, cfg.DATA_DIR);
      console.log(`Loading database from ${dataDir}…`);
      _db = loadDatabase(dataDir);
    }
    console.log(`Database ready — ${_db.length} rows`);
    return _db;
  })();

  return _dbPromise;
}

const VERBOSE = process.argv.includes('--verbose');

async function fetchMatches() {
  // If DATA_URL is set, proxy through our own Cloudflare Pages /api/livescore
  // endpoint — it handles hash discovery from Cloudflare's edge network, which
  // works reliably even when direct botbot3.space requests fail from Railway.
  if (cfg.DATA_URL) {
    const url = `${cfg.DATA_URL.replace(/\/$/, '')}/api/livescore`;
    console.log(`Fetching live matches via Cloudflare: ${url}`);
    const resp = await fetch(url);
    if (!resp.ok) throw new Error(`Cloudflare livescore returned HTTP ${resp.status}`);
    const json = await resp.json();
    return json.matches || [];
  }
  // Local / direct path (no DATA_URL set)
  return fetchLiveMatches();
}

async function runScan() {
  console.log(`[${new Date().toISOString()}] Scanning live matches…`);
  let matches;
  try {
    matches = await fetchMatches();
  } catch (e) {
    console.error(`Livescore fetch failed: ${e.message}`);
    return;
  }

  if (!matches.length) {
    console.log('No live matches found.');
    return;
  }

  console.log(`Found ${matches.length} live match(es).`);
  const db = await getDb();

  for (const match of matches) {
    const label = `${match.home_team} vs ${match.away_team}`;
    const matchCfg = buildCfgFromMatch(match.odds, cfg);
    if (!matchCfg) {
      if (VERBOSE) console.log(`  SKIP [no cfg]        ${label}`);
      continue;
    }

    // Signal quality gate — skip matches where every active signal is flat
    if (cfg.REQUIRE_MOVEMENT) {
      const s = matchCfg.signals;
      const hasMovement =
        (cfg.LINE_MOVE_ON  && s.lineMove    !== 'STABLE' && s.lineMove    !== 'UNKNOWN') ||
        (cfg.TL_MOVE_ON    && s.tlMove      !== 'STABLE' && s.tlMove      !== 'UNKNOWN') ||
        (cfg.FAV_ODDS_ON   && s.favOddsMove !== 'STABLE' && s.favOddsMove !== 'UNKNOWN') ||
        (cfg.DOG_ODDS_ON   && s.dogOddsMove !== 'STABLE' && s.dogOddsMove !== 'UNKNOWN');
      if (!hasMovement) {
        if (VERBOSE) {
          const s = matchCfg.signals;
          console.log(`  SKIP [no movement]   ${label}  LM:${s.lineMove} TL:${s.tlMove}`);
        }
        continue;
      }
    }

    // League tier filter — restrict DB to the configured tier before scoring
    let tierDb = db;
    if (cfg.LEAGUE_TIER === 'TOP')       tierDb = db.filter(r => r.league_tier === 'TOP');
    else if (cfg.LEAGUE_TIER === 'MAJOR') tierDb = db.filter(r => r.league_tier === 'MAJOR');
    else if (cfg.LEAGUE_TIER === 'TOP+MAJOR') tierDb = db.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');

    const cfgRows = applyConfig(tierDb, matchCfg);
    const blRows  = applyBaselineConfig(tierDb, matchCfg);
    const blSide  = blRows.filter(r => r.fav_side === matchCfg.fav_side);

    if (VERBOSE) {
      const s = matchCfg.signals;
      console.log(`  CHECK                ${label}  LM:${s.lineMove} TL:${s.tlMove}  pool:${cfgRows.length}  bl:${blRows.length}`);
    }

    // ── HT window detection ────────────────────────────────────────────────
    const minNum     = match.minute ? parseInt(match.minute, 10) : null;
    const isHtWindow = minNum != null && !isNaN(minNum) &&
                       minNum >= HT_MIN_MINUTE && minNum <= HT_MAX_MINUTE;

    // ── Pre-match alert ────────────────────────────────────────────────────
    const bets = scoreBets(cfgRows, blRows, blSide, cfg.MIN_N);
    const qualifying = bets.filter(b =>
      b.z >= cfg.MIN_Z &&
      b.edge >= cfg.MIN_EDGE &&
      b.n >= cfg.MIN_N &&
      b.bl >= (cfg.MIN_BASELINE ?? 0)
    );

    if (VERBOSE && !qualifying.length) {
      const best = bets.filter(b => b.n >= cfg.MIN_N).sort((a, b) => b.z - a.z)[0];
      const reason = cfgRows.length < cfg.MIN_N
        ? `pool too small (${cfgRows.length} < ${cfg.MIN_N})`
        : best
          ? `best bet: ${best.label} z=${best.z.toFixed(1)} edge=${best.edge.toFixed(1)}pp bl=${best.bl.toFixed(0)}% — below thresholds`
          : `no bets with n≥${cfg.MIN_N}`;
      console.log(`  SKIP [thresholds]    ${label}  ${reason}`);
    }

    // Skip match entirely only if neither pre-match nor HT window applies
    if (!qualifying.length && !isHtWindow) continue;

    const matchId = match.id || `${match.home_team}:${match.away_team}`;

    if (qualifying.length) {
      const newBets = qualifying.filter(b => !alreadyNotified(matchId, b.k));
      if (newBets.length) {
        // Game state enrichment pass for pre-match alert (in-play context lines)
        const GS_MIN_N = 15;
        let gsMap = null;
        const gs = buildGameState(match, matchCfg);
        if (gs) {
          const gsRows = applyGameState(cfgRows, gs);
          if (gsRows.length >= GS_MIN_N) {
            const gsBets = scoreBets(gsRows, blRows, blSide, GS_MIN_N);
            gsMap = new Map(gsBets.map(b => [b.k, b]));
            match._gsLabel = gs._label + (gs._approx ? ' ⚠️approx' : '');
          }
        }

        match._signals = matchCfg.signals;
        const msg = formatMessage(match, newBets, matchCfg, gsMap);
        console.log(`ALERT → ${match.home_team} vs ${match.away_team}: ${newBets.map(b => b.label).join(', ')}`);
        await sendTelegram(msg);
        for (const b of newBets) markNotified(matchId, b.k);
      }
    }

    // ── Dedicated HT alert ─────────────────────────────────────────────────
    // Fires only during the HT window using the known score as the game state.
    // Uses HT_LEAGUE_TIER (default ALL) — wider pool than pre-match because the
    // HT score filter compensates for league noise. 1H bets excluded. MIN_N = 15.
    if (isHtWindow && match.score) {
      const parts = match.score.split('-');
      const homeGoals = parseInt(parts[0], 10);
      const awayGoals = parseInt(parts[1], 10);

      if (!isNaN(homeGoals) && !isNaN(awayGoals)) {
        // Build HT-specific tier DB (may differ from pre-match tierDb)
        const htTier = cfg.HT_LEAGUE_TIER || 'ALL';
        let htTierDb = db;
        if (htTier === 'TOP')            htTierDb = db.filter(r => r.league_tier === 'TOP');
        else if (htTier === 'MAJOR')     htTierDb = db.filter(r => r.league_tier === 'MAJOR');
        else if (htTier === 'TOP+MAJOR') htTierDb = db.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');

        const htCfgRows = applyConfig(htTierDb, matchCfg);
        const htBlRows  = applyBaselineConfig(htTierDb, matchCfg);
        const htBlSide  = htBlRows.filter(r => r.fav_side === matchCfg.fav_side);

        const htGs = { trigger: 'HT', home_goals: homeGoals, away_goals: awayGoals };
        const htRows = applyGameState(htCfgRows, htGs);

        // HT-conditioned baseline: same game state applied to signal-stripped pool.
        // b.edge = P(signal+HT) − P(HT only) — the pure marginal contribution of the signal.
        const htStateRows = applyGameState(htBlRows,  htGs);
        const htStateSide = applyGameState(htBlSide, htGs);

        if (htRows.length >= GSA_MIN_N && htStateRows.length >= GSA_MIN_N) {
          const htBets = scoreBets(htRows, htStateRows, htStateSide, GSA_MIN_N);
          const htQualifying = htBets.filter(b => {
            if (!HT_ALLOWED_BETS.has(b.k)) return false;
            return b.edge >= GSA_MIN_DELTA && b.n >= GSA_MIN_N && b.mo_mid <= GSA_MAX_CONS_ODDS;
          });

          if (htQualifying.length) {
            const htNewBets = htQualifying.filter(b => !alreadyNotified(matchId, `ht:${b.k}`));
            if (htNewBets.length) {
              const htMsg = formatHtMessage(match, htNewBets, matchCfg, homeGoals, awayGoals);
              console.log(`HT ALERT → ${match.home_team} vs ${match.away_team} [${homeGoals}-${awayGoals}]: ${htNewBets.map(b => b.label).join(', ')}`);
              await sendTelegram(htMsg);
              for (const b of htNewBets) markNotified(matchId, `ht:${b.k}`);
            }
          }
        }
      }
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────
async function main() {
  const once = process.argv.includes('--once');

  // Pre-load DB on startup
  await getDb();

  if (once) {
    await runScan();
    process.exit(0);
  }

  // Validate Telegram credentials before starting the loop
  if (cfg.TELEGRAM_TOKEN === 'YOUR_BOT_TOKEN_HERE') {
    console.error('ERROR: Fill in TELEGRAM_TOKEN and TELEGRAM_CHAT_ID in config.js before starting.');
    process.exit(1);
  }

  console.log(`Scheduler started — scanning every ${cfg.SCAN_INTERVAL_MINUTES} minute(s).`);
  await runScan(); // run immediately on start

  const cronExpr = `*/${cfg.SCAN_INTERVAL_MINUTES} * * * *`;
  cron.schedule(cronExpr, runScan);
}

main().catch(e => { console.error(e); process.exit(1); });
