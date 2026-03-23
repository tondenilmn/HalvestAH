// ── HalvestAH Telegram Notifier — configuration ───────────────────────────────
// Values are read from environment variables first (for Railway/cloud),
// then fall back to the hardcoded defaults below (for local use).
//
// To run locally without env vars: just edit the defaults here.
// To deploy on Railway: set the env vars in the Railway dashboard and leave
// the defaults as-is (they are never sent to Railway).

module.exports = {
  // ── Telegram credentials ─────────────────────────────────────────────────────
  TELEGRAM_TOKEN:   process.env.TELEGRAM_TOKEN   || '8731720026:AAHDDH9tvlluID3Xlvr_HKI11Y5edrHzlhs',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '569463264',

  // ── Data source ──────────────────────────────────────────────────────────────
  // DATA_URL: base URL of your deployed Cloudflare Pages site.
  //   Set this env var on Railway so the notifier fetches CSVs over HTTP.
  //   Example: https://halvest-ah.pages.dev
  //   Leave null to use the local DATA_DIR path instead (default for local runs).
  DATA_URL: process.env.DATA_URL || null,
 

  // Local CSV folder — used when DATA_URL is null (relative to this file)
  DATA_DIR: process.env.DATA_DIR || '../static/data',

  // ── Signal filters (mirrors the Basic mode toggles in the web app) ──────────
  LINE_MOVE_ON:  true,   // AH line move (DEEPER / STABLE / SHRANK)
  TL_MOVE_ON:    true,   // TL move (UP / STABLE / DOWN)
  FAV_ODDS_ON:   false,  // Fav odds move (STEAM / STABLE / DRIFT)
  DOG_ODDS_ON:   false,  // Dog odds move

  // ── Thresholds to trigger a notification ────────────────────────────────────
  MIN_N:        35,   // minimum pre-match sample size
  MIN_Z:        2.0,  // minimum z-score
  MIN_EDGE:     6,    // minimum edge in percentage points above baseline
  MIN_BASELINE: 25,   // minimum baseline hit rate % — suppresses low base-rate bets
                      // (e.g. Home Over 1.5 2H at 8%, Away wins 1H at 7%) that
                      // historically underperform out-of-sample despite high z-scores

  // ── Signal quality gate ──────────────────────────────────────────────────────
  // Only notify matches where at least one active signal shows real movement
  // (i.e. not STABLE and not UNKNOWN). Prevents alerts on flat-signal matches
  // where the AH line + TL combination alone happens to show historical edge.
  REQUIRE_MOVEMENT: true,

  // ── League tier filter ───────────────────────────────────────────────────────
  // 'ALL'       — all leagues
  // 'TOP'       — top 5 EU + Champions/Europa/Conference League only
  // 'MAJOR'     — strong national leagues (Brazil, Argentina, MLS, J1, etc.)
  // 'TOP+MAJOR' — both TOP and MAJOR, excludes obscure/lower leagues
  LEAGUE_TIER: process.env.LEAGUE_TIER || 'TOP+MAJOR',

  // ── How often to scan (minutes) ─────────────────────────────────────────────
  SCAN_INTERVAL_MINUTES: parseInt(process.env.SCAN_INTERVAL_MINUTES || '3', 10),
};
