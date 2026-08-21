// ── HalvestAH Telegram Notifier — configuration ───────────────────────────────
// Values are read from environment variables first (for Railway/cloud),
// then fall back to the hardcoded defaults below (for local use).

module.exports = {
  // ── Telegram credentials ─────────────────────────────────────────────────────
  TELEGRAM_TOKEN:   process.env.TELEGRAM_TOKEN   || '8731720026:AAHDDH9tvlluID3Xlvr_HKI11Y5edrHzlhs',
  TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID || '569463264',

  // ── Data source ───────────────────────────────────────────────────────────────
  // Historical pool Strategy L123 scores against (static/data/Bet365/*.csv +
  // manifest.json, built by build.js) — Bet365-priced to match the live
  // match.bet365_odds it compares against.
  // Local runs: loaded straight from DATA_DIR. Railway/cloud: set DATA_URL to
  // your deployed Cloudflare Pages URL (e.g. https://your-project.pages.dev)
  // and it's fetched from there instead — same manifest.json/CSV bundle the
  // static site itself serves, no separate upload needed.
  DATA_URL: process.env.DATA_URL || null,
  DATA_DIR: process.env.DATA_DIR || '../static/data',

  // ── League tier filter ───────────────────────────────────────────────────────
  // 'ALL' | 'TOP' | 'MAJOR' | 'TOP+MAJOR'
  LEAGUE_TIER: process.env.LEAGUE_TIER || 'TOP+MAJOR',

  // ── Scan frequency ───────────────────────────────────────────────────────────
  SCAN_INTERVAL_MINUTES: parseInt(process.env.SCAN_INTERVAL_MINUTES || '2', 10),

  // ── Display timezone ─────────────────────────────────────────────────────────
  // IANA timezone used for the timestamp shown in Telegram messages.
  DISPLAY_TZ: process.env.DISPLAY_TZ || 'Europe/Rome',

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY L123 — Layer 1/2/3 consensus
  // Three independent layers each recommend a bet from historical data, using
  // only the information that layer is allowed to see:
  //   Layer 1 — OPENING ODDS ONLY  (fav opening odds band + opening TL band)
  //   Layer 2 — MOVEMENT ONLY     (line_move, fav/dog odds move, tl_move)
  //   Layer 3 — CLOSING ODDS ONLY (fav closing odds band + closing TL band)
  // Fires once the match has just gone live (2–4') when >= L123_MIN_AGREE of
  // the 3 layers independently land on the same bet — odds are read from the
  // live feed (polled every SCAN_INTERVAL_MINUTES, default 2 min) at that
  // point, right after kickoff repricing settles. Source: telegram/
  // layer_analysis.js convergence study — the "2/3 agree" and "3/3 agree"
  // buckets showed higher hit%/ROI than any single layer alone or matches
  // where layers disagree.
  // ════════════════════════════════════════════════════════════════════════════
  L123_ENABLED:      process.env.L123_ENABLED !== 'false',   // enabled by default — the only active strategy
  L123_TIER:         process.env.L123_TIER    || process.env.LEAGUE_TIER || 'TOP+MAJOR',
  L123_MIN_N:        parseInt(process.env.L123_MIN_N          || '30',  10),  // min historical pool size per layer
  L123_MIN_Z:        parseFloat(process.env.L123_MIN_Z        || '1.8'),      // min z-score per layer
  L123_MIN_EDGE:     parseFloat(process.env.L123_MIN_EDGE     || '5'),        // min pp above baseline per layer
  L123_MIN_BASELINE: parseFloat(process.env.L123_MIN_BASELINE || '20'),       // min baseline hit rate per layer
  L123_MIN_AGREE:    parseInt(process.env.L123_MIN_AGREE      || '2',   10),  // 2 = fire on 2/3 or 3/3; 3 = 3/3 only
  L123_FIRE_MIN:     parseInt(process.env.L123_FIRE_MIN       || '2',   10),  // fire window: live minute range
  L123_FIRE_MAX:     parseInt(process.env.L123_FIRE_MAX       || '4',   10),
};
