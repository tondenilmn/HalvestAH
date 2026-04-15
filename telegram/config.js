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
  SX_ENABLED: process.env.SX_ENABLED === 'true',   // disabled by default
  SX_TIER:    process.env.SX_TIER    || process.env.LEAGUE_TIER || 'ALL',
  SY_ENABLED: process.env.SY_ENABLED === 'true',   // disabled by default
  SY_TIER:    process.env.SY_TIER    || process.env.LEAGUE_TIER || 'ALL',

  // Min AH move per book to count as steam (0.125 = half a step)
  SXSY_MIN_STEAM: parseFloat(process.env.SXSY_MIN_STEAM || '0.125'),
  // SX: Pin + any 1 of Bet365/Sbobet; SY: all 3 required (enforced in detectSXYSignal)
  SXSY_MIN_BOOKS_SX: 2,
  SXSY_MIN_BOOKS_SY: 3,
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
  S6_ENABLED: process.env.S6_ENABLED === 'true',   // disabled by default
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
  S7_ENABLED:    process.env.S7_ENABLED === 'true',   // disabled by default
  S7_TIER:       process.env.S7_TIER    || 'ALL',

  S7_MIN_HC_DIFF: parseFloat(process.env.S7_MIN_HC_DIFF || '0.50'),  // min Bet365–Pinnacle line gap

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY SN — Pre-match Pinnacle steam
  // Fires when Pinnacle moves both AH line AND Total Line before kick-off.
  // Bet at soft books (Bet365) while they still lag Pinnacle's repriced line.
  // ════════════════════════════════════════════════════════════════════════════
  SN_ENABLED:      process.env.SN_ENABLED === 'false',
  SN_TIER:         process.env.SN_TIER    || 'TOP+MAJOR',
  SN_MAX_DAYS:     parseInt(process.env.SN_MAX_DAYS    || '7',    10),  // days ahead to monitor
  SN_MIN_AH_MOVE:  parseFloat(process.env.SN_MIN_AH_MOVE  || '0.25'), // min AH line movement (opening→current)
  SN_MIN_TL_MOVE:  parseFloat(process.env.SN_MIN_TL_MOVE  || '0.25'), // min TL movement
  SN_B365_LAG_MIN: parseFloat(process.env.SN_B365_LAG_MIN || '0.10'), // skip if B365 already repriced within this gap

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY S1 — Sbobet S1: pre-match AH+Over odds steam → Over 0.5 Goals Remaining at 65'
  // Pre-match signal: AH odds (home or away) drop ≥ 0.20 + Over odds drop ≥ 0.15
  //                   + AH closing line in [−1.5, +1.5] + TL closing in [2.0, 3.0]
  // In-play fire at 65': fav was winning at HT + current score diff ≤ 1 + total goals ≤ 3
  // Bet: Over 0.5 Goals Remaining (in-play)
  // ════════════════════════════════════════════════════════════════════════════
  S1_ENABLED:          process.env.S1_ENABLED !== 'false',
  S1_TIER:             process.env.S1_TIER    || 'ALL',
  S1_MIN_AH_ODDS_MOVE: parseFloat(process.env.S1_MIN_AH_ODDS_MOVE || '-0.20'),  // AH odds move threshold (≤ fires)
  S1_MIN_OV_ODDS_MOVE: parseFloat(process.env.S1_MIN_OV_ODDS_MOVE || '-0.15'),  // Over odds move threshold (≤ fires)
  S1_AH_LINE_MIN:      parseFloat(process.env.S1_AH_LINE_MIN      || '-1.5'),   // AH closing line min
  S1_AH_LINE_MAX:      parseFloat(process.env.S1_AH_LINE_MAX      || '1.5'),    // AH closing line max
  S1_TL_MIN:           parseFloat(process.env.S1_TL_MIN            || '2.0'),   // TL closing min
  S1_TL_MAX:           parseFloat(process.env.S1_TL_MAX            || '3.0'),   // TL closing max
  S1_HT_STORE_MIN:     parseInt(process.env.S1_HT_STORE_MIN        || '44', 10),
  S1_HT_STORE_MAX:     parseInt(process.env.S1_HT_STORE_MAX        || '52', 10),
  S1_FIRE_MIN:         parseInt(process.env.S1_FIRE_MIN             || '63', 10),
  S1_FIRE_MAX:         parseInt(process.env.S1_FIRE_MAX             || '67', 10),
  S1_MAX_TOTAL_GOALS:  parseInt(process.env.S1_MAX_TOTAL_GOALS      || '3',  10),
  S1_MAX_SCORE_DIFF:   parseInt(process.env.S1_MAX_SCORE_DIFF       || '1',  10),

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY S2 — Sbobet S2: same pre-match gates as S1
  // Pre-match: identical to S1 (reads from sbobet_odds)
  // HT condition: score must be exactly 1-1
  // In-play fire at 65': score diff ≤ 1 (covers still-draw and one-goal difference)
  // Bet: Over 0.5 Goals Remaining
  // ════════════════════════════════════════════════════════════════════════════
  S2_ENABLED:       process.env.S2_ENABLED !== 'false',
  S2_TIER:          process.env.S2_TIER    || 'ALL',
  S2_HT_STORE_MIN:  parseInt(process.env.S2_HT_STORE_MIN  || '44', 10),
  S2_HT_STORE_MAX:  parseInt(process.env.S2_HT_STORE_MAX  || '52', 10),
  S2_FIRE_MIN:        parseInt(process.env.S2_FIRE_MIN        || '63', 10),
  S2_FIRE_MAX:        parseInt(process.env.S2_FIRE_MAX        || '67', 10),
  S2_MAX_SCORE_DIFF:  parseInt(process.env.S2_MAX_SCORE_DIFF  || '1', 10),
  S2_MAX_TOTAL_GOALS: parseInt(process.env.S2_MAX_TOTAL_GOALS || '3', 10),

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY S3 — Sbobet S3: contradictory signal (line→home but away odds drop)
  // Pre-match (sbobet_odds):
  //   AH line moves toward home ≥ 0.75  (ah_ho − ah_hc ≥ 0.75)
  //   Away AH odds drop ≥ 0.10          (ao_c − ao_o ≤ −0.10)   ← sharp money on away
  //   AH closing line in [−1.0, +1.5]
  //   TL closing in [2.25, 3.0]
  // Fire at 65' (no HT condition):
  //   Goal difference ≤ 1
  //   Away conceded ≤ 2 goals (home goals ≤ 2)
  // Bet: Away Team Score Next Goal  @min 1.80
  // ════════════════════════════════════════════════════════════════════════════
  S3_ENABLED:           process.env.S3_ENABLED !== 'false',
  S3_TIER:              process.env.S3_TIER    || 'ALL',
  S3_MIN_LINE_MOVE:     parseFloat(process.env.S3_MIN_LINE_MOVE      || '0.75'),   // min AH line move toward home
  S3_MIN_AWAY_ODDS_DROP: parseFloat(process.env.S3_MIN_AWAY_ODDS_DROP || '-0.10'), // away odds drop threshold (≤ fires)
  S3_AH_LINE_MIN:       parseFloat(process.env.S3_AH_LINE_MIN        || '-1.0'),   // AH closing line min
  S3_AH_LINE_MAX:       parseFloat(process.env.S3_AH_LINE_MAX        || '1.5'),    // AH closing line max
  S3_TL_MIN:            parseFloat(process.env.S3_TL_MIN              || '2.25'),  // TL closing min
  S3_TL_MAX:            parseFloat(process.env.S3_TL_MAX              || '3.0'),   // TL closing max
  S3_FIRE_MIN:          parseInt(process.env.S3_FIRE_MIN               || '63', 10),
  S3_FIRE_MAX:          parseInt(process.env.S3_FIRE_MAX               || '67', 10),
  S3_MAX_SCORE_DIFF:    parseInt(process.env.S3_MAX_SCORE_DIFF         || '1',  10),
  S3_MAX_AWAY_CONCEDED: parseInt(process.env.S3_MAX_AWAY_CONCEDED      || '2',  10), // home goals ≤ this
  S3_MIN_ODDS:          parseFloat(process.env.S3_MIN_ODDS              || '1.80'),

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY S5 — Sbobet S5: Over odds steam + flat/rising TL → Over 0.5 Remaining at 65'
  // Pre-match (sbobet_odds):
  //   Over odds drop ≥ 0.25   (ov_c − ov_o ≤ −0.25)
  //   TL flat or rising        (tl_c − tl_o ≥ 0)
  //   TL closing in [2.0, 2.75]
  // HT condition (46'): total goals at HT = 0 or 1
  // Fire at 65–70': total goals ≤ 2  +  goal difference ≤ 1
  // Bet: Over 0.5 Goals Remaining
  // ════════════════════════════════════════════════════════════════════════════
  S5_ENABLED:         process.env.S5_ENABLED !== 'false',
  S5_TIER:            process.env.S5_TIER    || 'ALL',
  S5_MIN_OV_DROP:     parseFloat(process.env.S5_MIN_OV_DROP     || '-0.25'),  // Over odds drop threshold (≤ fires)
  S5_TL_MIN:          parseFloat(process.env.S5_TL_MIN           || '2.0'),
  S5_TL_MAX:          parseFloat(process.env.S5_TL_MAX           || '2.75'),
  S5_HT_STORE_MIN:    parseInt(process.env.S5_HT_STORE_MIN       || '44', 10),
  S5_HT_STORE_MAX:    parseInt(process.env.S5_HT_STORE_MAX       || '52', 10),
  S5_HT_MAX_GOALS:    parseInt(process.env.S5_HT_MAX_GOALS       || '1',  10), // total goals at HT ≤ this
  S5_FIRE_MIN:        parseInt(process.env.S5_FIRE_MIN            || '65', 10),
  S5_FIRE_MAX:        parseInt(process.env.S5_FIRE_MAX            || '70', 10),
  S5_MAX_TOTAL_GOALS: parseInt(process.env.S5_MAX_TOTAL_GOALS     || '2',  10),
  S5_MAX_SCORE_DIFF:  parseInt(process.env.S5_MAX_SCORE_DIFF      || '1',  10),

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY SS6 — Sbobet S6: Strong Away Steam → Away Team Score Next Goal at 65'
  // (Named SS6 to avoid collision with existing Strategy S6 / market-calibrated edge)
  // Pre-match (sbobet_odds):
  //   Away AH odds drop ≥ 0.35  (ao_c − ao_o ≤ −0.35)  ← strong steam
  //   AH closing line in [−0.5, +1.5]  (away fav or small underdog)
  //   TL closing in [2.0, 3.0]
  // HT condition (44–52'): away winning, drawing, or losing by ≤1  (home − away ≤ 1)
  // Fire at 65': away not losing by 2+  (home − away ≤ 1)  +  total goals ≤ 3
  // Bet: Away Team Score Next Goal  @min 1.60
  // ════════════════════════════════════════════════════════════════════════════
  SS6_ENABLED:          process.env.SS6_ENABLED !== 'false',
  SS6_TIER:             process.env.SS6_TIER    || 'ALL',
  SS6_MIN_AWAY_DROP:    parseFloat(process.env.SS6_MIN_AWAY_DROP    || '-0.35'),  // ao_c − ao_o threshold (≤ fires)
  SS6_AH_LINE_MIN:      parseFloat(process.env.SS6_AH_LINE_MIN      || '-0.5'),
  SS6_AH_LINE_MAX:      parseFloat(process.env.SS6_AH_LINE_MAX      || '1.5'),
  SS6_TL_MIN:           parseFloat(process.env.SS6_TL_MIN            || '2.0'),
  SS6_TL_MAX:           parseFloat(process.env.SS6_TL_MAX            || '3.0'),
  SS6_HT_STORE_MIN:     parseInt(process.env.SS6_HT_STORE_MIN        || '44', 10),
  SS6_HT_STORE_MAX:     parseInt(process.env.SS6_HT_STORE_MAX        || '52', 10),
  SS6_FIRE_MIN:         parseInt(process.env.SS6_FIRE_MIN             || '63', 10),
  SS6_FIRE_MAX:         parseInt(process.env.SS6_FIRE_MAX             || '67', 10),
  SS6_MAX_TOTAL_GOALS:  parseInt(process.env.SS6_MAX_TOTAL_GOALS      || '3',  10),
  SS6_MAX_AWAY_DEFICIT: parseInt(process.env.SS6_MAX_AWAY_DEFICIT     || '1',  10), // home − away ≤ this
  SS6_MIN_ODDS:         parseFloat(process.env.SS6_MIN_ODDS            || '1.60'),
};
