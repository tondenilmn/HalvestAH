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
  SCAN_INTERVAL_MINUTES: parseInt(process.env.SCAN_INTERVAL_MINUTES || '2', 10),

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
  S6_ENABLED: process.env.S6_ENABLED === 'true',
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
  // STRATEGY S8 — Pinnacle Cross: High Volume steam → Over 2.5 FT at 60'
  // Pre-match Pinnacle-only signal:
  //   1. AH closing home <= -1      (home is at least a 1-goal favourite)
  //   2. AH home steam >= 0.50      (ah_ho − ah_hc ≥ 0.50, strong home steam)
  //   3. TL moved up >= 0.25        (market pricing in goals)
  // In-play trigger at ~60': if Over 2.5 FT not yet settled (< 3 goals) → bet it.
  // ════════════════════════════════════════════════════════════════════════════
  S8_ENABLED:         process.env.S8_ENABLED !== 'false',
  S8_TIER:            process.env.S8_TIER    || 'ALL',
  S8_AH_HC_MAX:       parseFloat(process.env.S8_AH_HC_MAX        || '-1'),   // home closing AH must be <= this (home is at least a 1-goal fav)
  S8_MIN_HOME_STEAM:  parseFloat(process.env.S8_MIN_HOME_STEAM   || '0.5'),  // min AH steam toward home (ah_ho − ah_hc)
  S8_MIN_TL_MOVE:     parseFloat(process.env.S8_MIN_TL_MOVE      || '0.25'), // min TL move up (tl_c − tl_o)
  S8_FIRE_MIN:        parseInt(process.env.S8_FIRE_MIN           || '57',  10), // start of in-play fire window
  S8_FIRE_MAX:        parseInt(process.env.S8_FIRE_MAX           || '63',  10), // end of in-play fire window

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY S9 — Sbobet Cross → Over 2.5 FT at 60'
  // Sbobet-only signal (line stable, odds movement only):
  //   1. AH home closing <= -1        (home at least 1-goal fav)
  //   2. AH line stable               (|ah_hc − ah_ho| ≤ S9_LINE_STABLE_THRESH)
  //   3. AH home odds dropped ≥ 0.20  (ho_o − ho_c ≥ threshold)
  //   4. Total Line stable            (|tl_c − tl_o| ≤ S9_TL_STABLE_THRESH)
  //   5. Over odds dropped ≥ 0.15     (ov_o − ov_c ≥ threshold)
  // In-play trigger at ~60': if Over 2.5 FT not yet settled (< 3 goals) → bet it.
  // ════════════════════════════════════════════════════════════════════════════
  S9_ENABLED:              process.env.S9_ENABLED !== 'false',
  S9_TIER:                 process.env.S9_TIER    || 'ALL',
  S9_AH_HC_MAX:            parseFloat(process.env.S9_AH_HC_MAX            || '-1'),   // home closing AH must be <= this
  S9_LINE_STABLE_THRESH:   parseFloat(process.env.S9_LINE_STABLE_THRESH   || '0.12'), // max AH line move to count as stable
  S9_MIN_HO_ODDS_DROP:     parseFloat(process.env.S9_MIN_HO_ODDS_DROP     || '0.20'), // min home odds drop (ho_o − ho_c)
  S9_TL_STABLE_THRESH:     parseFloat(process.env.S9_TL_STABLE_THRESH     || '0.12'), // max TL move to count as stable
  S9_MIN_OV_ODDS_DROP:     parseFloat(process.env.S9_MIN_OV_ODDS_DROP     || '0.15'), // min over odds drop (ov_o − ov_c)
  S9_FIRE_MIN:             parseInt(process.env.S9_FIRE_MIN               || '57',  10),
  S9_FIRE_MAX:             parseInt(process.env.S9_FIRE_MAX               || '63',  10),

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY S10 — Sbobet Away Steam → Away to score (live)
  // Sbobet-only signal — line stable, home odds drifting (money going away):
  //   1. AH home closing in [−0.25, +0.50]  (near pick-em or slight away fav)
  //   2. AH line stable                      (|ah_hc − ah_ho| ≤ S10_LINE_STABLE_THRESH)
  //   3. AH home odds rose ≥ 0.35            (ho_c − ho_o ≥ threshold — away backed)
  //   4. Total Line stable                   (|tl_c − tl_o| ≤ S10_TL_STABLE_THRESH)
  // In-play trigger at ~20' 1H: bet Away to score (if away hasn't scored yet).
  // ════════════════════════════════════════════════════════════════════════════
  S10_ENABLED:             process.env.S10_ENABLED !== 'false',
  S10_TIER:                process.env.S10_TIER    || 'ALL',
  S10_AH_HC_MIN:           parseFloat(process.env.S10_AH_HC_MIN           || '-0.25'), // home closing AH >= this
  S10_AH_HC_MAX:           parseFloat(process.env.S10_AH_HC_MAX           || '0.50'),  // home closing AH <= this
  S10_LINE_STABLE_THRESH:  parseFloat(process.env.S10_LINE_STABLE_THRESH  || '0.12'),  // max AH line move to count as stable
  S10_MIN_HO_ODDS_RISE:    parseFloat(process.env.S10_MIN_HO_ODDS_RISE    || '0.35'),  // min home odds rise (ho_c − ho_o)
  S10_TL_STABLE_THRESH:    parseFloat(process.env.S10_TL_STABLE_THRESH    || '0.12'),  // max TL move to count as stable
  S10_FIRE_MIN:            parseInt(process.env.S10_FIRE_MIN              || '18',  10),
  S10_FIRE_MAX:            parseInt(process.env.S10_FIRE_MAX              || '22',  10),

  // ════════════════════════════════════════════════════════════════════════════
  // STRATEGY S11 — Pinnacle + Sbobet Home → Home to score in 2H (at HT)
  // Cross-book signal: Pinnacle line steamed home + Sbobet line stable but odds confirm:
  //   1. Pinnacle AH home closing <= −0.75
  //   2. Pinnacle AH home steam >= 0.50    (pin.ah_ho − pin.ah_hc ≥ 0.50)
  //   3. Sbobet AH line stable             (|sbo.ah_hc − sbo.ah_ho| ≤ S11_SBO_LINE_STABLE_THRESH)
  //   4. Sbobet AH home odds steam >= 0.20 (sbo.ho_o − sbo.ho_c ≥ 0.20)
  // In-play trigger at HT (44–52'): bet Home to score in 2H, only if home hasn't scored yet.
  // ════════════════════════════════════════════════════════════════════════════
  S11_ENABLED:                 process.env.S11_ENABLED !== 'false',
  S11_TIER:                    process.env.S11_TIER    || 'ALL',
  S11_PIN_AH_HC_MAX:           parseFloat(process.env.S11_PIN_AH_HC_MAX           || '-0.75'), // Pinnacle home closing <= this
  S11_PIN_MIN_HOME_STEAM:      parseFloat(process.env.S11_PIN_MIN_HOME_STEAM      || '0.50'),  // Pinnacle home steam (ah_ho − ah_hc)
  S11_SBO_LINE_STABLE_THRESH:  parseFloat(process.env.S11_SBO_LINE_STABLE_THRESH  || '0.12'),  // max Sbobet AH line move to count as stable
  S11_SBO_MIN_HO_ODDS_STEAM:   parseFloat(process.env.S11_SBO_MIN_HO_ODDS_STEAM   || '0.20'),  // Sbobet home odds steam (ho_o − ho_c)
  S11_FIRE_MIN:                parseInt(process.env.S11_FIRE_MIN                  || '44',  10),
  S11_FIRE_MAX:                parseInt(process.env.S11_FIRE_MAX                  || '52',  10),
};
