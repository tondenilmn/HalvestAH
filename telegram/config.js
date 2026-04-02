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

  // ── Strategy 3: TLM=IN + high TL → no 1H goal by ~30' → Over 0.5 1H ─────────
  // Fire when TL steamed up (tl_c - tl_o >= MIN_STEAM) AND closing TL >= MIN_TL
  // AND the match is still 0-0 in the alert window (minutes MIN–MAX of 1H).
  TLM1H_MIN_TL:     parseFloat(process.env.TLM1H_MIN_TL     || '2.5'),   // 2.5–3 and >3 clusters
  TLM1H_MIN_STEAM:  parseFloat(process.env.TLM1H_MIN_STEAM  || '0.25'),  // 1 step minimum
  TLM1H_MIN_MINUTE: parseInt(process.env.TLM1H_MIN_MINUTE   || '25', 10),
  TLM1H_MAX_MINUTE: parseInt(process.env.TLM1H_MAX_MINUTE   || '32', 10),

  // ── Steam strategy thresholds ────────────────────────────────────────────────
  // Alert when the AH line has moved at least LM_STEAM_MIN toward the favourite.
  // 0.45 captures "at least 2 steps" (0.50 movement), e.g. −0.25 → −0.75.
  // Backtest (TOP+MAJOR, 12 months OOS): 55.8% win rate · +21% ROI · n=934
  LM_STEAM_MIN: parseFloat(process.env.LM_STEAM_MIN || '0.45'),

  // ── League tier filter ───────────────────────────────────────────────────────
  // 'ALL' | 'TOP' | 'MAJOR' | 'TOP+MAJOR'
  // TOP+MAJOR is recommended — obscure leagues pollute the signal.
  LEAGUE_TIER: process.env.LEAGUE_TIER || 'TOP+MAJOR',

  // ── Alert window ─────────────────────────────────────────────────────────────
  // Fire alerts only when the match is live between minute MIN and MAX.
  // Minutes 1–5 = just kicked off, pre-match AH odds still actionable.
  ALERT_MIN_MINUTE: parseInt(process.env.ALERT_MIN_MINUTE || '1',  10),
  ALERT_MAX_MINUTE: parseInt(process.env.ALERT_MAX_MINUTE || '5', 10),

  // ── Upcoming match pre-kick alert ────────────────────────────────────────────
  // Fire a pre-kick alert when a match is within this many minutes of its
  // scheduled start time and the AH steam threshold is met.
  UPCOMING_WINDOW_MINUTES: parseInt(process.env.UPCOMING_WINDOW_MINUTES || '10', 10),

  // ── Scan frequency ───────────────────────────────────────────────────────────
  SCAN_INTERVAL_MINUTES: parseInt(process.env.SCAN_INTERVAL_MINUTES || '3', 10),

  // ── Site timezone offset ─────────────────────────────────────────────────────
  // botbot3.space returns kickoff times in this UTC offset (set by _cookie_GMT=1
  // in livescore.js). The datetime strings have no timezone suffix, so we must
  // apply the offset manually when computing minutes-to-kickoff.
  // Italy = GMT+1 (CET) standard / GMT+2 (CEST) summer. Default: 1.
  SITE_GMT_OFFSET: parseInt(process.env.SITE_GMT_OFFSET || '1', 10),

  // ── Display timezone ─────────────────────────────────────────────────────────
  // IANA timezone used for the timestamp shown in Telegram messages.
  // Handles DST automatically (CET ↔ CEST).
  DISPLAY_TZ: process.env.DISPLAY_TZ || 'Europe/Rome',

  // ── Strategy 5: HT-as-signal (DB-based analysis at HT interval) ─────────────
  // At HT, filters the historical DB by AH line + fav side + HT score, then
  // compares that pool vs the full pre-HT baseline. Alerts when a 2H/FT bet
  // shows meaningful statistical shift above baseline.
  HT_MIN_N:        parseInt(process.env.HT_MIN_N        || '200', 10), // min HT pool size
  HT_MIN_Z:        parseFloat(process.env.HT_MIN_Z      || '2.5'),     // min z-score
  HT_MIN_BASELINE: parseFloat(process.env.HT_MIN_BASELINE || '30'),    // min baseline hit rate %

  // ── Strategy 6: Market-calibrated edge (pre-match, 4 MKT_KEYS bets) ──────────
  // Fires when the signal-filtered pool shows ≥ MKT_EDGE_THRESH pp edge above
  // Pinnacle's market-implied probability, AND Bet365 current odds beat the
  // historical Pinnacle average (value confirmation).
  // Bets: ahCover · dogCover · overTL · underTL (those with a direct odds proxy).
  MKT_EDGE_THRESH: parseFloat(process.env.MKT_EDGE_THRESH || '10'),   // min pp above market implied
  MKT_EDGE_MIN_N:  parseInt(process.env.MKT_EDGE_MIN_N   || '35', 10), // min signal pool size
};
