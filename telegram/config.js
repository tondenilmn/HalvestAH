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

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY HTPICK — cross-fit "HT pick" (winner's-curse-corrected)
  // Fires once per match at half-time (same HT_SNAPSHOT_WINDOW QUIET2H uses),
  // picking the best-scoring bet across the full Live Games 2H bet set
  // (over05_2H/over15_2H/under05_2H/under15_2H/homeScored2H/awayScored2H/
  // homeWins2H/awayWins2H/draw2H/btts2H — same set backtested), choosing per
  // key between the pre-match and HT-conditioned pool. UNLIKE LATEGOAL/
  // QUIET2H (which score a single historical pool directly), this is
  // cross-fit selected: the historical DB is split into two disjoint folds
  // (row.fold, stamped once at load time) and a candidate only qualifies if
  // it clears the bar in at least one fold, always PRICED using the OTHER
  // fold's numbers — see engine.js's mergeCrossFit().
  //
  // Why this matters here specifically: walk-forward backtested (leave-3-
  // months-out, telegram/backtest_live_ui_split_sample.js) — naive single-
  // pool select+price on this exact bet set lost -22% to -29% ROI@price
  // despite a reasonable ~40-50% hit rate (classic winner's-curse: the pool
  // that makes a candidate look best is the same one being asked how good it
  // is). Cross-fit selection flipped that to +4% to +22% ROI@price,
  // consistently positive across every test month, with hit rate barely
  // moved. Do NOT relax this to a single-pool pick without re-running that
  // backtest — the naive version is a real money-loser despite looking fine
  // on hit rate alone.
  // ════════════════════════════════════════════════════════════════════════════
  HTPICK_ENABLED:   process.env.HTPICK_ENABLED === 'true', // OFF by default (2026-08-29) — user asked to narrow Telegram to just the BTTS/O-U live families (LATEGOAL, QUIET2H, NEWMODEL's O-U+BTTS legs); this fires across the full 32-bet-type set, not scoped to those. Set HTPICK_ENABLED=true to re-enable.
  HTPICK_TIER:      process.env.HTPICK_TIER          || 'TOP+MAJOR',
  HTPICK_MIN_N:     parseInt(process.env.HTPICK_MIN_N    || '15',  10), // DEFAULT_MIN_N, matches the backtested config
  HTPICK_MIN_Z:     parseFloat(process.env.HTPICK_MIN_Z  || '1.5'), // MIN_Z, matches the backtested config
  HTPICK_MIN_EDGE:  parseFloat(process.env.HTPICK_MIN_EDGE || '0'),

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY DASHBOARD — cross-fit opening-odds pick (mirrors the Web UI's
  // Daily Dashboard "Signal 1" pick, static/app.js's openingOddsSignal).
  // Single-layer: opening AH-odds band + opening Total-Line cluster only, no
  // movement/closing-odds info — deliberately simpler than L123's 3-layer
  // consensus. Restricted to the same 13 FT/pre-match bet keys the Dashboard
  // itself picks from (straight 1X2, FT totals, BTTS, FT team totals) — see
  // notify.js's _DASHBOARD_BET_KEYS. Cross-fit selected (row.fold split, see
  // engine.js's mergeCrossFit()) — same fix as HTPICK, applied here because
  // this is the identical argmax-over-many-candidates shape.
  //
  // ONLY fires for a bet that actually clears DASHBOARD_MIN_N/Z/EDGE — unlike
  // the Web UI dashboard (which falls back to showing a non-qualifying
  // "best guess" bet when nothing clears the bar, purely for display), a
  // Telegram alert must never fire on that fallback.
  //
  // Fires in the window from kickoff down to DASHBOARD_WINDOW_MIN minutes
  // before it (default 15 — a bit earlier than L123's 10, since this signal
  // doesn't depend on near-kickoff price movement the way L123's Layer 2/3
  // do). Walk-forward backtested (telegram/backtest_dashboard_split_sample.js,
  // 3 held-out months, TOP+MAJOR): naive single-pool select+price -1.7% to
  // -5.4% ROI@mo -> cross-fit +0.2% to +3.5%, positive in all 3 months.
  // ════════════════════════════════════════════════════════════════════════════
  DASHBOARD_ENABLED:    process.env.DASHBOARD_ENABLED === 'true', // OFF by default (2026-08-29) — pre-match fixture scan, not one of the live BTTS/O-U in-play bets the user asked to focus on. Set DASHBOARD_ENABLED=true to re-enable.
  DASHBOARD_TIER:       process.env.DASHBOARD_TIER          || 'TOP+MAJOR',
  DASHBOARD_WINDOW_MIN: parseInt(process.env.DASHBOARD_WINDOW_MIN || '15', 10),
  DASHBOARD_MIN_N:      parseInt(process.env.DASHBOARD_MIN_N    || '15',  10), // DEFAULT_MIN_N, matches the backtested config
  DASHBOARD_MIN_Z:      parseFloat(process.env.DASHBOARD_MIN_Z  || '1.5'), // MIN_Z, matches the backtested config
  DASHBOARD_MIN_EDGE:   parseFloat(process.env.DASHBOARD_MIN_EDGE || '0'),

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY NEWMODEL — E8: `static/live_model.js` (LIVE_BETTING_PLAN.md Part E)
  // as an independent, OPT-IN, DISABLED-BY-DEFAULT signal source, alongside
  // (not replacing) L123/LATEGOAL/QUIET2H/HTPICK/DASHBOARD. The pricing engine
  // itself (state-conditioned goal-hazard + gamma-Poisson) has NOT been
  // walk-forward validated against real outcomes yet — that is a separate
  // follow-up (E6) — so this must stay off by default until it has its own
  // logged track record (see track_record.js's per-strategy breakdown).
  //
  // Trigger: HT window only (reuses the existing HT_SNAPSHOT_WINDOW/
  // _htSnapshots capture mechanism in notify.js — no new snapshot logic).
  // A red-card-triggered reprice (LIVE_BETTING_PLAN.md Part C 3A "new" bullet)
  // was scoped but NOT implemented — see notify.js's NEWMODEL section header
  // comment for why (no fixture-events polling exists anywhere in this
  // codebase today, and adding one cheaply enough to respect the 100/day
  // api-football budget while still catching a red card promptly is a real
  // scope expansion, not a lightweight addition).
  //
  // Markets: Over/Under FT total (at the match's own closing Total Line —
  // verified for free via the live feed's own ov_c/un_c fields, the same
  // fields L123's liveOddsForBet() already reads, so this costs ZERO
  // api-football budget for the common case), BTTS FT (verified via
  // apifootball.js, costs 1 call), 2nd-half result (home/draw/away — no
  // api-football equivalent exists for a half-scoped result market, so this
  // is always sent unverified, gated on a higher probability floor instead).
  //
  // Gate: always attempts price verification first (feed price for O/U, one
  // budgeted api-football call for BTTS only if O/U didn't already qualify);
  // fires only if the model's Wilson-style MC-lower probability (`lo`) clears
  // the verified market's implied probability by NEWMODEL_MIN_EDGE_PP. If no
  // price is available at all (feed missing ov_c/un_c AND api-football has no
  // BTTS price AND the candidate is the unverifiable 2H-result market), it
  // still fires — clearly labeled "unverified" — but only if `lo` clears the
  // more conservative NEWMODEL_MIN_LO_UNVERIFIED floor.
  // ════════════════════════════════════════════════════════════════════════════
  NEWMODEL_ENABLED:             process.env.NEWMODEL_ENABLED === 'true', // OFF by default (2026-08-29) — user asked to remove the HT reprice notification from Telegram (covers both runStrategyNewModel and runStrategyNewModelRecheck, gated on the same flag); set NEWMODEL_ENABLED=true to re-enable
  NEWMODEL_TIER:                process.env.NEWMODEL_TIER || 'TOP+MAJOR',
  NEWMODEL_MC_SAMPLES:          parseInt(process.env.NEWMODEL_MC_SAMPLES || '500', 10),
  // Min percentage points the model's CI-lower probability must clear the
  // verified market's implied probability by, before alerting.
  NEWMODEL_MIN_EDGE_PP:         parseFloat(process.env.NEWMODEL_MIN_EDGE_PP || '5'),
  // When no price could be verified at all, require this much more raw
  // confidence (CI-lower %) before firing — a stand-in for the missing price
  // check, deliberately stricter than the edge-gated path above.
  NEWMODEL_MIN_LO_UNVERIFIED:   parseFloat(process.env.NEWMODEL_MIN_LO_UNVERIFIED || '60'),

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY FOCUS — 1T/2T Over/Under 0.5/1.5 watch (PLAN_FOCUS_BETS.md)
  // Only the 7 keys over05_1H/over15_1H/under05_1H/over05_2H/over15_2H/
  // under05_2H/under15_2H are in scope. UNLIKE every other strategy here,
  // FOCUS does not pick a bet live via any threshold sweep — its candidate
  // set was fixed OFFLINE by telegram/focus_config_search.js's walk-forward +
  // cross-fit config search (telegram/data/focus_configs.json). At alert
  // time this only checks "does the live match's own fav-line/side/TL-band/
  // tier/TL-move/Over-Under-move (+ HT score, for the 4 2H keys) match one of
  // those validated cells" — see focus_select.js.
  //
  // Fires for 1H keys in the same pre-match window L123 uses (kickoff minus
  // FOCUS_PRE_WINDOW_MIN), and for the 4 2H keys at half-time (same
  // HT_SNAPSHOT_WINDOW every other HT-triggered strategy uses).
  //
  // IMPORTANT — see BETTING_EDGE_ANALYSIS.md's "Focus bets" section: as of
  // 2026-08-29, focus_configs.json has very few surviving cells (most of the
  // 7 keys have NO validated config at all after a calibration-bias fix
  // removed ~30 look-alike "edges"). This is deliberately conservative —
  // FOCUS will simply stay silent for a key with no surviving cell rather
  // than fall back to an unvalidated guess. Re-run focus_config_search.js
  // periodically as more months of data accumulate; it may find more.
  // ════════════════════════════════════════════════════════════════════════════
  FOCUS_ENABLED:        process.env.FOCUS_ENABLED !== 'false',
  FOCUS_PRE_WINDOW_MIN: parseInt(process.env.FOCUS_PRE_WINDOW_MIN || '10', 10),
  FOCUS_MIN_LIVE_N:     parseInt(process.env.FOCUS_MIN_LIVE_N || '50', 10), // min size of the live _dbAll pool backing a matched cell

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY LIVEWATCH — live probability threshold watch (added 2026-08-29)
  // The broader ask behind FOCUS: "tell me when a bet's live probability
  // crosses a threshold and it hasn't happened yet" — for ANY live match, not
  // just the handful of configs focus_config_search.js validated offline.
  // UNLIKE Strategy FOCUS (only fires on a pre-validated cell, at one fixed
  // window — pre-kickoff for 1H, HT for 2H), LIVEWATCH:
  //   - uses the plain historical hit-rate for this match's own fav-line/side
  //     + closing-TL-band (+ exact HT score, for 2H keys) — the same numbers
  //     already shown in the web UI's "1T/2T Goals Focus" panel — with NO
  //     offline validation step, so it WILL alert on configurations nobody
  //     has walk-forward-checked,
  //   - gates on the CONSERVATIVE Wilson-CI-lower-bound live probability
  //     (not the raw point estimate) clearing LIVEWATCH_THRESHOLD_PCT — same
  //     discipline L123/LATEGOAL/QUIET2H all use (gating on the point
  //     estimate produced negative ROI out-of-sample in this codebase's own
  //     walk-forward testing) — and the message's "minimum odds" is likewise
  //     the model's own CI-lower-bound-implied price, not the raw point
  //     estimate,
  //   - each key now fires at ONE fixed checkpoint instead of being swept
  //     continuously (2026-08-29, at the user's request), chosen per the
  //     bet's own direction+half — mirrors why LATEGOAL/QUIET2H each have a
  //     single natural entry point (LATEGOAL waits for a specific window
  //     before the "still hasn't happened" claim is meaningful; QUIET2H fires
  //     the moment its own condition first becomes checkable):
  //       Over,  1H (over05_1H/over15_1H + homeScored1H/awayScored1H):
  //         LIVEWATCH_TRIGGER_WINDOW_1H_OVER  (default 18'-22', "around 20'")
  //       Under, 1H (under05_1H):
  //         LIVEWATCH_TRIGGER_WINDOW_1H_UNDER (default 0'-4', start of 1H —
  //         an Under's edge is highest before anything has had a chance to
  //         happen yet, unlike an Over, which needs time to accumulate
  //         evidence that it's running late)
  //       Over,  2H (over05_2H/over15_2H + homeScored2H/awayScored2H):
  //         LIVEWATCH_TRIGGER_WINDOW_2H_OVER  (default 68'-72', "around 70'")
  //       Under, 2H (under05_2H/under15_2H):
  //         LIVEWATCH_TRIGGER_WINDOW_2H_UNDER (default 44'-50', start of 2H —
  //         same HT window QUIET2H itself fires in, same reasoning as the 1H
  //         Under case above)
  //     Each window stays a small range rather than one exact minute so a
  //     missed/delayed scan cycle can't skip the check entirely — same
  //     convention as LATEGOAL_TRIGGER_WINDOW.
  // This is explicitly UNVALIDATED — a real-time convenience alert on top of
  // numbers you can already see in the app, not a backtested strategy like
  // L123/LATEGOAL/QUIET2H. Treat it the same way as NEWMODEL: useful to watch,
  // not something to blindly stake without checking the historical n/context
  // in the message.
  // ════════════════════════════════════════════════════════════════════════════
  LIVEWATCH_ENABLED:            process.env.LIVEWATCH_ENABLED !== 'false',
  LIVEWATCH_TIER:               process.env.LIVEWATCH_TIER || 'TOP+MAJOR',
  LIVEWATCH_MIN_N:              parseInt(process.env.LIVEWATCH_MIN_N || '50', 10),
  LIVEWATCH_THRESHOLD_PCT:      parseFloat(process.env.LIVEWATCH_THRESHOLD_PCT || '75'),
  // Min pp the STATIC (pre-live-decay) Wilson CI lower bound of this match's
  // own conditioned pool (TL-band, +HT-state for 2H keys) must clear a
  // LESS-conditioned baseline pool by (fav-line/side [+TL-band for 2H]) —
  // same "cfgRows vs. a less-conditioned base pool" edge check L123/QUIET2H
  // already use, added 2026-08-29 at the user's request ("only show matches
  // where the selected bets are above baseline"). This is separate from
  // LIVEWATCH_THRESHOLD_PCT: the edge check says "this specific config is
  // meaningfully different from the generic case", the threshold check says
  // "and time has decayed it convincingly high/low" — both must pass.
  LIVEWATCH_MIN_EDGE:           parseFloat(process.env.LIVEWATCH_MIN_EDGE || '0'),
  LIVEWATCH_TRIGGER_WINDOW_1H_OVER: [
    parseInt(process.env.LIVEWATCH_TRIGGER_1H_OVER_MIN || '18', 10),
    parseInt(process.env.LIVEWATCH_TRIGGER_1H_OVER_MAX || '22', 10),
  ],
  LIVEWATCH_TRIGGER_WINDOW_1H_UNDER: [
    parseInt(process.env.LIVEWATCH_TRIGGER_1H_UNDER_MIN || '0', 10),
    parseInt(process.env.LIVEWATCH_TRIGGER_1H_UNDER_MAX || '4', 10),
  ],
  LIVEWATCH_TRIGGER_WINDOW_2H_OVER: [
    parseInt(process.env.LIVEWATCH_TRIGGER_MIN || process.env.LIVEWATCH_TRIGGER_2H_OVER_MIN || '68', 10),
    parseInt(process.env.LIVEWATCH_TRIGGER_MAX || process.env.LIVEWATCH_TRIGGER_2H_OVER_MAX || '72', 10),
  ],
  LIVEWATCH_TRIGGER_WINDOW_2H_UNDER: [
    parseInt(process.env.LIVEWATCH_TRIGGER_2H_UNDER_MIN || '44', 10),
    parseInt(process.env.LIVEWATCH_TRIGGER_2H_UNDER_MAX || '50', 10),
  ],
  // The 7 O/U keys (focus_lib.FOCUS_KEYS) plus 4 "team to score" keys —
  // homeScored1H/awayScored1H/homeScored2H/awayScored2H — added 2026-08-29 at
  // the user's request ("probability for Home/Away team to score, not yet
  // happened"). These 4 are NOT part of focus_lib.FOCUS_KEYS (they're not
  // offline-validated by focus_config_search.js/Strategy FOCUS — see
  // notify.js's LIVEWATCH_EXTRA_KEYS comment) but are already fully supported
  // by engine.js's BETS list and both live-decay functions, so no new pricing
  // logic was needed to add them here.
  LIVEWATCH_KEYS: (process.env.LIVEWATCH_KEYS ||
    'over05_1H,over15_1H,under05_1H,over05_2H,over15_2H,under05_2H,under15_2H,' +
    'homeScored1H,awayScored1H,homeScored2H,awayScored2H').split(','),
};
