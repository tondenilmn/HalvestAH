// ── HalvestAH Telegram Notifier — configuration ───────────────────────────────
// Values are read from environment variables first (for Railway/cloud),
// then fall back to the hardcoded defaults below (for local use).

module.exports = {
  // ── Telegram credentials ─────────────────────────────────────────────────────
  TELEGRAM_TOKEN:   process.env.TELEGRAM_TOKEN   || '8731720026:AAHDDH9tvlluID3Xlvr_HKI11Y5edrHzlhs',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '569463264',

  // ── Data source ──────────────────────────────────────────────────────────────
  DATA_URL: process.env.DATA_URL || null,   // set to your Cloudflare Pages URL for Railway
  DATA_DIR: process.env.DATA_DIR || '../static/data',

  // ── api-football.com (Bet365 odds enrichment) ────────────────────────────────
  APIFOOTBALL_KEY: process.env.APIFOOTBALL_KEY || null,  // null = skip B365 enrichment

  // ── League tier filter ───────────────────────────────────────────────────────
  // Global default tier — used by each strategy unless overridden by its own SN_TIER.
  // 'ALL' | 'TOP' | 'MAJOR' | 'TOP+MAJOR'
  LEAGUE_TIER: process.env.LEAGUE_TIER || 'TOP+MAJOR',

  // ── Scan frequency ───────────────────────────────────────────────────────────
  SCAN_INTERVAL_MINUTES: parseInt(process.env.SCAN_INTERVAL_MINUTES || '3', 10),

  // ── Site timezone offset ─────────────────────────────────────────────────────
  // botbot3.space returns kickoff times in this UTC offset.
  // Italy = GMT+1 (CET) standard / GMT+2 (CEST) summer. Default: 1.
  SITE_GMT_OFFSET: parseInt(process.env.SITE_GMT_OFFSET || '1', 10),

  // ── Display timezone ─────────────────────────────────────────────────────────
  // IANA timezone used for the timestamp shown in Telegram messages.
  DISPLAY_TZ: process.env.DISPLAY_TZ || 'Europe/Rome',

  // ── Shared HT window ─────────────────────────────────────────────────────────
  HT_MIN_MINUTE: parseInt(process.env.HT_MIN_MINUTE || '44', 10),
  HT_MAX_MINUTE: parseInt(process.env.HT_MAX_MINUTE || '52', 10),

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY SX — Confirming Favourite (3-book steam → home structural fav wins)
  // STRATEGY SY — Steamrolled Away Favourite (3-book steam → away structural fav wins)
  // Alert 1 (1–10'):   all available books steamed same direction → 1x2 fav win at soft book
  // Alert 2 (28–32'):  still 0-0 → Over 0.5 1H in-play
  // Alert 3 (44–52'):  HT score → 2H live bet guidance
  // Source: master_steam_analysis.html (73,910 fixtures, Jan 2025–Feb 2026)
  // ════════════════════════════════════════════════════════════════════════════
  SX_ENABLED: process.env.SX_ENABLED !== 'false',
  SX_TIER:    process.env.SX_TIER    || process.env.LEAGUE_TIER || 'ALL',
  SY_ENABLED: process.env.SY_ENABLED !== 'false',
  SY_TIER:    process.env.SY_TIER    || process.env.LEAGUE_TIER || 'ALL',

  // Min AH move per book to count as steam (0.125 = half a step)
  SXSY_MIN_STEAM: parseFloat(process.env.SXSY_MIN_STEAM || '0.125'),
  // All 3 books must confirm — this value is informational only (logic enforces 3)
  SXSY_MIN_BOOKS: 3,
  // Alert 1 window: early live
  SXSY_EARLY_MIN: parseInt(process.env.SXSY_EARLY_MIN || '1',  10),
  SXSY_EARLY_MAX: parseInt(process.env.SXSY_EARLY_MAX || '10', 10),
  // Alert 2 window: mid-1H check (30')
  SXSY_MIDH_MIN:  parseInt(process.env.SXSY_MIDH_MIN  || '28', 10),
  SXSY_MIDH_MAX:  parseInt(process.env.SXSY_MIDH_MAX  || '32', 10),
  // Alert 3 — HT score storage window
  SXSY_HT_STORE_MIN: parseInt(process.env.SXSY_HT_STORE_MIN || '44', 10),
  SXSY_HT_STORE_MAX: parseInt(process.env.SXSY_HT_STORE_MAX || '52', 10),
  // Alert 3 — fire window: if no 2H goal yet at this point
  SXSY_HT_FIRE_MIN:  parseInt(process.env.SXSY_HT_FIRE_MIN  || '55', 10),
  SXSY_HT_FIRE_MAX:  parseInt(process.env.SXSY_HT_FIRE_MAX  || '60', 10),

  // Alert window: minutes into the match (used by S7 live window check)
  ALERT_MIN_MINUTE: parseInt(process.env.ALERT_MIN_MINUTE || '1',  10),
  ALERT_MAX_MINUTE: parseInt(process.env.ALERT_MAX_MINUTE || '5', 10),

  // Pre-kick window: fire when kickoff is within this many minutes
  UPCOMING_WINDOW_MINUTES: parseInt(process.env.UPCOMING_WINDOW_MINUTES || '10', 10),

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY 6 — Market-calibrated edge (pre-match, all leagues)
  // Fires when signal-filtered pool shows ≥ MKT_EDGE_THRESH pp above
  // Pinnacle's market-implied probability for any of the 4 market bets
  // (ahCover, dogCover, overTL, underTL), AND Bet365 odds beat Pinnacle avg.
  // ════════════════════════════════════════════════════════════════════════════
  S6_ENABLED: process.env.S6_ENABLED !== 'false',
  S6_TIER:    process.env.S6_TIER    || 'ALL',  // default ALL — Strategy 6 was designed for all leagues

  MKT_EDGE_THRESH:   parseFloat(process.env.MKT_EDGE_THRESH   || '10'),    // min pp above market implied
  MKT_EDGE_MIN_N:    parseInt(process.env.MKT_EDGE_MIN_N      || '35', 10), // min signal pool size
  S6_WINDOW_MINUTES: parseInt(process.env.S6_WINDOW_MINUTES   || '5',  10), // max live minute to fire (1–N minutes into the match)

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY 7 — Bet365 vs Pinnacle AH line gap
  // Fire when Bet365 closing AH line is more generous than Pinnacle's by ≥ threshold.
  // Since Pinnacle is the sharp consensus, Bet365 is mispriced — bet the favoured
  // side at Bet365 where you get the better number.
  // Backtest (Jan–Mar 2025, same-line excluded): HC diff ≥ 0.25 → N=3,608 · +4.1% ROI
  //   HC diff ≥ 0.50 → N=174 · +8.1% ROI  |  HC diff ≥ 0.75 → N=40 · +17.9% ROI
  // ════════════════════════════════════════════════════════════════════════════
  S7_ENABLED:    process.env.S7_ENABLED !== 'false',
  S7_TIER:       process.env.S7_TIER    || 'ALL',

  S7_MIN_HC_DIFF: parseFloat(process.env.S7_MIN_HC_DIFF || '0.50'),  // min Bet365–Pinnacle line gap
};
