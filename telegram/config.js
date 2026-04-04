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
  // Live minute range considered "at halftime". Used by strategies 2, 4, and 5.
  HT_MIN_MINUTE: parseInt(process.env.HT_MIN_MINUTE || '44', 10),
  HT_MAX_MINUTE: parseInt(process.env.HT_MAX_MINUTE || '52', 10),

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY 1 — AH Steam → Bet Dog AH
  // Fire when the AH line steams toward the favourite by at least LM_STEAM_MIN.
  // Backtest (TOP+MAJOR, 12m OOS, n=934): 55.8% win rate · +21% ROI
  // ════════════════════════════════════════════════════════════════════════════
  S1_ENABLED: process.env.S1_ENABLED === 'false',
  S1_TIER:    process.env.S1_TIER    || process.env.LEAGUE_TIER || 'TOP+MAJOR',  // 'ALL'|'TOP'|'MAJOR'|'TOP+MAJOR'

  LM_STEAM_MIN: parseFloat(process.env.LM_STEAM_MIN || '0.45'),  // min AH steam magnitude (0.45 ≈ 2 steps)

  // Alert window: minutes into the match (for live alerts)
  ALERT_MIN_MINUTE: parseInt(process.env.ALERT_MIN_MINUTE || '1',  10),
  ALERT_MAX_MINUTE: parseInt(process.env.ALERT_MAX_MINUTE || '5', 10),

  // Pre-kick window: fire when kickoff is within this many minutes
  UPCOMING_WINDOW_MINUTES: parseInt(process.env.UPCOMING_WINDOW_MINUTES || '10', 10),

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY 2 — Strong Fav not winning at HT → Over 0.5 2H at 65–70'
  // Store candidate at HT if strong fav (AH ≥ S2_FAV_AH_MIN) is not winning.
  // Fire at S2_FIRE_MIN–S2_FIRE_MAX minutes if still no 2H goal.
  // ════════════════════════════════════════════════════════════════════════════
  S2_ENABLED: process.env.S2_ENABLED === 'false',
  S2_TIER:    process.env.S2_TIER    || process.env.LEAGUE_TIER || 'TOP+MAJOR',

  S2_FAV_AH_MIN:      parseFloat(process.env.S2_FAV_AH_MIN      || '0.88'),  // min AH line to qualify as "strong fav"
  S2_FIRE_MIN_MINUTE: parseInt(process.env.S2_FIRE_MIN_MINUTE   || '65', 10), // fire window start
  S2_FIRE_MAX_MINUTE: parseInt(process.env.S2_FIRE_MAX_MINUTE   || '70', 10), // fire window end

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY 3 — TLM steam + TL ≥ 2.5 + 0-0 at 25–32' → Over 0.5 1H
  // DISABLED by default — backtest shows ~52% hit rate, BE odds 1.94, not profitable.
  // Set S3_ENABLED=true to re-enable if market conditions change.
  // ════════════════════════════════════════════════════════════════════════════
  S3_ENABLED: process.env.S3_ENABLED === 'false',  // default OFF
  S3_TIER:    process.env.S3_TIER    || process.env.LEAGUE_TIER || 'TOP+MAJOR',

  TLM1H_MIN_TL:     parseFloat(process.env.TLM1H_MIN_TL     || '2.5'),    // min TL closing
  TLM1H_MIN_STEAM:  parseFloat(process.env.TLM1H_MIN_STEAM  || '0.25'),   // min TL steam (tl_c - tl_o)
  TLM1H_MIN_MINUTE: parseInt(process.env.TLM1H_MIN_MINUTE   || '25', 10), // alert window start
  TLM1H_MAX_MINUTE: parseInt(process.env.TLM1H_MAX_MINUTE   || '32', 10), // alert window end

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY 4 — Fav leads +1 at HT, AH 0.25–1.00, TL ≤ 2.75 → Under 1.5 2H
  // Fires at HT (same HT_MIN/MAX_MINUTE window as S2/S5).
  // Backtest (TOP+MAJOR, 12m OOS, n=3804): 59.3% hit · σ=2.1% · BE odds 1.69
  // ════════════════════════════════════════════════════════════════════════════
  S4_ENABLED: process.env.S4_ENABLED === 'false',
  S4_TIER:    process.env.S4_TIER    || process.env.LEAGUE_TIER || 'TOP+MAJOR',

  S4_FAV_AH_MIN: parseFloat(process.env.S4_FAV_AH_MIN || '0.13'),  // min AH line (lower bound)
  S4_FAV_AH_MAX: parseFloat(process.env.S4_FAV_AH_MAX || '1.12'),  // max AH line (upper bound)
  S4_MAX_TL:     parseFloat(process.env.S4_MAX_TL     || '2.75'),  // max closing TL

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY 5 — HT-as-signal DB probe
  // At HT, filters the historical DB by AH line + fav side + HT score,
  // then alerts when a 2H/FT bet shows meaningful z-score above baseline.
  // Uses full DB (all leagues) for largest possible baseline.
  // ════════════════════════════════════════════════════════════════════════════
  S5_ENABLED: process.env.S5_ENABLED === 'false',
  S5_TIER:    process.env.S5_TIER    || process.env.LEAGUE_TIER || 'TOP+MAJOR',

  HT_MIN_N:        parseInt(process.env.HT_MIN_N        || '200', 10), // min HT-filtered pool size
  HT_MIN_Z:        parseFloat(process.env.HT_MIN_Z      || '2.5'),     // min z-score
  HT_MIN_BASELINE: parseFloat(process.env.HT_MIN_BASELINE || '30'),    // min baseline hit rate %

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

  S7_MIN_HC_DIFF: parseFloat(process.env.S7_MIN_HC_DIFF || '0.25'),  // min Bet365–Pinnacle line gap
};
