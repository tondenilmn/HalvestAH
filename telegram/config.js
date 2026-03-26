// ── HalvestAH Telegram Notifier — configuration ───────────────────────────────
// Values are read from environment variables first (for Railway/cloud),
// then fall back to the hardcoded defaults below (for local use).

module.exports = {
  // ── Telegram credentials ─────────────────────────────────────────────────────
  TELEGRAM_TOKEN:   process.env.TELEGRAM_TOKEN   || '8731720026:AAHDDH9tvlluID3Xlvr_HKI11Y5edrHzlhs',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '569463264',

  // ── Data source ──────────────────────────────────────────────────────────────
  DATA_URL: process.env.DATA_URL || null,
  DATA_DIR: process.env.DATA_DIR || '../static/data',

  // ── Baseline filters (AH line + AH closing odds ±tol + TL closing) ──────────
  // These are applied to BOTH the baseline pool and the signal pool.
  ODDS_TOLERANCE: 0.05,  // AH closing odds tolerance (0 = exact, 0.05 = default)
  ODDS_SIDE:      'FAV', // which side(s) to match odds: 'FAV' | 'DOG' | 'BOTH'

  // ── Signal filters (applied on top of baseline — movement only) ──────────────
  LINE_MOVE_ON:   true,   // AH line move (DEEPER / SHRANK)
  TL_MOVE_ON:     true,   // TL move (UP / DOWN)
  FAV_ODDS_ON:    false,  // Fav odds move (IN / OUT)
  DOG_ODDS_ON:    false,  // Dog odds move
  OVER_ODDS_ON:   false,  // Over odds move
  UNDER_ODDS_ON:  false,  // Under odds move

  // Require at least one active signal to show real movement (not STABLE/UNKNOWN).
  // Prevents alerts on flat-market matches where AH+TL+HT alone shows spurious edge.
  REQUIRE_MOVEMENT: true,

  // ── GSA notification thresholds ──────────────────────────────────────────────
  GSA_MIN_N:         20,    // min rows in signal+HT pool
  GSA_MIN_DELTA:     5,     // min improvement: signal% − baseline% (pp)
  GSA_MIN_P_2H:      50,    // min absolute hit rate for 2H bets (%)
  GSA_MIN_P_FT:      40,    // min absolute hit rate for FT bets (%)
  GSA_MAX_CONS_ODDS: 2.50,  // max conservative odds (Wilson CI lower bound) — don't alert above this

  // ── League tier filter ───────────────────────────────────────────────────────
  // 'ALL' | 'TOP' | 'MAJOR' | 'TOP+MAJOR'
  HT_LEAGUE_TIER: process.env.HT_LEAGUE_TIER || 'ALL',

  // ── Scan frequency ───────────────────────────────────────────────────────────
  SCAN_INTERVAL_MINUTES: parseInt(process.env.SCAN_INTERVAL_MINUTES || '3', 10),
};
