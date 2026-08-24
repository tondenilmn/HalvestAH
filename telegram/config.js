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

  // ── api-football.com odds verification (optional) ────────────────────────────
  // If set, telegram/apifootball.js fetches Bet365's live price for whatever
  // bet L123 is about to alert on, from an independent source — so the
  // message tells you "odds OK" / "odds lower" directly instead of you having
  // to open Bet365 yourself to check. Only called once per alert (never on
  // every scan cycle) since the free plan caps at 100 req/day. Leave unset to
  // disable — alerts still fire normally, just without this extra line.
  APIFOOTBALL_KEY: process.env.APIFOOTBALL_KEY || '0b7b5d6268aea444fcc7a761147f600f',

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY L123 — Layer 1/2/3 consensus
  // Three independent layers each recommend a bet from historical data, using
  // only the information that layer is allowed to see:
  //   Layer 1 — OPENING ODDS ONLY  (fav opening odds band + opening TL band)
  //   Layer 2 — MOVEMENT ONLY     (line_move, fav/dog odds move, tl_move)
  //   Layer 3 — CLOSING ODDS ONLY (fav closing odds band + closing TL band)
  // Fires in the 10-minute pre-match window (kickoff minus 10 min down to
  // kickoff) when >= L123_MIN_AGREE of the 3 layers independently land on
  // the same bet — odds are read from the live feed (polled every
  // SCAN_INTERVAL_MINUTES, default 2 min). Pre-match rather than in-play so
  // there's time to actually place the bet at a stable price — see
  // PRE_MATCH_WINDOW_MIN in notify.js's matchContext(). Source: telegram/
  // layer_analysis.js convergence study — the "2/3 agree" and "3/3 agree"
  // buckets showed higher hit%/ROI than any single layer alone or matches
  // where layers disagree.
  //
  // Walk-forward validated (2026-08-21): qualifying on the Wilson CI lower
  // bound (L123_MIN_EDGE, see below) rather than the raw point estimate —
  // ROI@fair@mo_lo pooled +7.3% across 5 exploratory held-out months (all 5
  // positive) and +10.6% across 2 never-touched lock-box months (both
  // positive), vs. the prior point-estimate gate which was negative/flat in
  // most of the same months. See telegram/tune_l123_scratch.js.
  // ════════════════════════════════════════════════════════════════════════════
  L123_ENABLED:      process.env.L123_ENABLED === 'true',   // disabled by default (2026-08-23) — set L123_ENABLED=true to re-enable
  L123_TIER:         process.env.L123_TIER    || process.env.LEAGUE_TIER || 'TOP+MAJOR',
  L123_MIN_N:        parseInt(process.env.L123_MIN_N          || '30',  10),  // min historical pool size per layer
  L123_MIN_Z:        parseFloat(process.env.L123_MIN_Z        || '1.8'),      // min z-score per layer
  // Min pp the Wilson CI *lower bound* (conservative hit rate) must clear the
  // baseline by — NOT the raw point-estimate edge. Walk-forward testing showed
  // qualifying on the point estimate suffers from winner's-curse selection
  // bias (best-of-thousands-of-cells picks regress toward baseline OOS),
  // producing negative ROI@fair despite good-looking hit rates. Gating on the
  // pessimistic end of the CI instead bakes that regression in up front.
  L123_MIN_EDGE:     parseFloat(process.env.L123_MIN_EDGE     || '0'),
  L123_MIN_BASELINE: parseFloat(process.env.L123_MIN_BASELINE || '20'),       // min baseline hit rate per layer
  L123_MIN_AGREE:    parseInt(process.env.L123_MIN_AGREE      || '2',   10),  // 2 = fire on 2/3 or 3/3; 3 = 3/3 only

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY LATEGOAL — "still no 2H goal" watch
  // Fires once per match within the LATEGOAL_TRIGGER_WINDOW (default 68-72')
  // if: (a) the
  // HT-conditioned historical pool (fav line/side + HT score, same query the
  // GSA tab runs) shows a qualifying "a goal happens in 2H" bet
  // (LATEGOAL_BETS), AND (b) no goal has actually been scored in the 2nd
  // half yet (current score still equals the HT score captured earlier).
  // The message reports both the static HT-anchor rate AND the live,
  // time-decayed fair odds at the current minute (telegram/live_odds.js,
  // the Node port of computeLiveOdd) — that's the number to check against
  // Bet365's actual in-play price; this strategy does NOT auto-verify a live
  // price itself (unlike L123's 4 market-priced bets, "goal in 2H" markets
  // aren't reliably listed as a single matchable value by api-football —
  // see apifootball.js's SUPPORTED set).
  //
  // Research backing which leagues/configs actually run hot for a 2H goal
  // (2026-08-22): driven almost entirely by each league's OVERALL scoring
  // rate, not a front/back-loading bias — goals_time2 independently confirms
  // the 2H-goal-share is nearly flat (53-56%) across every league checked.
  // Fav-odds-band sweeps within top leagues found no meaningful additional
  // signal (z<1.5 throughout) — league choice is the only real lever, which
  // is exactly what LATEGOAL_TIER controls. NOT walk-forward validated yet
  // (unlike L123) — treat early alerts from this strategy with the same
  // caution as everything pre-validation in this codebase.
  // ════════════════════════════════════════════════════════════════════════════
  LATEGOAL_ENABLED:       process.env.LATEGOAL_ENABLED !== 'false',
  LATEGOAL_TIER:          process.env.LATEGOAL_TIER          || 'TOP+MAJOR',
  // Windowed (not a single minute) so a missed/delayed scan cycle can't let
  // the alert fire arbitrarily late in the 2nd half once outside the window.
  LATEGOAL_TRIGGER_WINDOW: [
    parseInt(process.env.LATEGOAL_TRIGGER_MIN || '68', 10),
    parseInt(process.env.LATEGOAL_TRIGGER_MAX || '72', 10),
  ],
  // "a goal happens in 2H"-flavoured bets this strategy considers. Only the
  // side-agnostic "any goal" bet — favScored2H/homeScored2H/awayScored2H were
  // dropped 2026-08-24 after a leave-one-month-out walk-forward
  // (telegram/backtest_lategoal_favvsany.js) showed that on the subset of
  // instances where one of those three would have been the qualifying bet,
  // over05_2H on the SAME matches was both more accurate (79.5% vs 59.9% hit
  // rate) and more profitable (+8.0% vs +5.2% ROI@mo_lo) — awayScored2H in
  // particular was net-negative out-of-sample (-3.3% ROI@mo_lo), a sign of
  // overfitting to the training pool rather than a real edge.
  LATEGOAL_BETS:          (process.env.LATEGOAL_BETS || 'over05_2H').split(','),
  LATEGOAL_MIN_N:         parseInt(process.env.LATEGOAL_MIN_N    || '30',  10),
  LATEGOAL_MIN_Z:         parseFloat(process.env.LATEGOAL_MIN_Z  || '1.8'),
  LATEGOAL_MIN_EDGE:      parseFloat(process.env.LATEGOAL_MIN_EDGE || '0'), // same Wilson-CI-lower-bound discipline as L123
  LATEGOAL_MIN_BASELINE:  parseFloat(process.env.LATEGOAL_MIN_BASELINE || '20'),

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY QUIET2H — "expect a quiet 2nd half" watch
  // Mirror image of LATEGOAL: fires once per match right as the 2nd half
  // starts (as soon as an HT snapshot exists, i.e. liveMin >= 45 — no need
  // to wait, unlike LATEGOAL, since this doesn't depend on the 2nd half
  // staying goalless first) if the match's own closing Total Line is low
  // (QUIET2H_TL_BANDS) and the HT-conditioned historical pool (fav
  // line/side + TL band + exact HT score) shows a qualifying
  // under05_2H/under15_2H bet.
  //
  // Research + walk-forward validation (2026-08-23): TL band is by far the
  // dominant driver — TL<2 shows ~32-39% under05_2H / ~70-75% under15_2H
  // (vs. 22.2%/54.9% pooled baseline), TL 2-2.5 shows a smaller but still
  // real elevation (~25-33% / ~60-67%), TL>=2.5 shows no edge at all
  // (QUIET2H_TL_BANDS excludes those bands by default). Walk-forward:
  // 79 qualifying (fav_line/side, TL band, HT state) cells across 10
  // held-out months — 50.6% claimed vs. 49.1% realized (1.5pp gap),
  // tighter than LATEGOAL's own TL-banded calibration.
  //
  // No bookmaker market equivalence trick needed here (unlike LATEGOAL) —
  // "Total Goals — 2nd Half Under 0.5/1.5" is typically a real, directly
  // quotable Bet365 market on its own; api-football just doesn't support
  // checking it (2H-scoped markets aren't in its matchable set), so the
  // message shows the internal computeLiveOdd target only, same as
  // LATEGOAL's fallback when no equivalence/verification applies.
  // ════════════════════════════════════════════════════════════════════════════
  QUIET2H_ENABLED:      process.env.QUIET2H_ENABLED !== 'false',
  QUIET2H_TIER:         process.env.QUIET2H_TIER          || 'TOP+MAJOR',
  QUIET2H_TL_BANDS:     (process.env.QUIET2H_TL_BANDS     || '<2,2-2.5').split(','),
  QUIET2H_BETS:         (process.env.QUIET2H_BETS         || 'under05_2H,under15_2H').split(','),
  QUIET2H_MIN_N:        parseInt(process.env.QUIET2H_MIN_N    || '40',  10),
  QUIET2H_MIN_Z:        parseFloat(process.env.QUIET2H_MIN_Z  || '1.8'),
  QUIET2H_MIN_EDGE:     parseFloat(process.env.QUIET2H_MIN_EDGE || '0'),
};
