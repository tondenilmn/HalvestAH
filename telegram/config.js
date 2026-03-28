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

  // ── Steam strategy thresholds ────────────────────────────────────────────────
  // Alert when the AH line has moved at least LM_STEAM_MIN toward the favourite.
  // 0.45 captures "at least 2 steps" (0.50 movement), e.g. −0.25 → −0.75.
  // Backtest (TOP+MAJOR, 12 months OOS): 55.8% win rate · +21% ROI · n=934
  LM_STEAM_MIN: parseFloat(process.env.LM_STEAM_MIN || '0.45'),

  // ── League tier filter ───────────────────────────────────────────────────────
  // 'ALL' | 'TOP' | 'MAJOR' | 'TOP+MAJOR'
  // TOP+MAJOR is recommended — obscure leagues pollute the signal.
  LEAGUE_TIER: process.env.LEAGUE_TIER || 'ALL',

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
};
