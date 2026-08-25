# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Cloudflare Pages deployment of the AH betting analysis tool. Fully static (no backend server) — all CSV processing, filtering, and scoring runs client-side in `static/app.js`. The one server-side component is a Cloudflare Pages Function at `functions/api/scrape.js` for CORS-bypassed odds fetching.

## Running Locally

```bash
# Regenerate manifest after adding/removing CSVs in static/data/
node build.js

# Serve locally with Cloudflare Pages dev (includes Functions support)
npx wrangler pages dev static --port 8788

# Or plain HTTP server (Functions won't work, scrape feature unavailable)
npx serve static
# Alternative: python -m http.server 3000 --directory static
```

## Deploying

```bash
node build.js && npx wrangler pages deploy static --project-name=<your-project>
```

Or connect the repo to Cloudflare Pages with build command `node build.js` and output directory `static`.

## File Structure

```
build.js                  # Scans static/data/**/*.csv recursively → writes static/data/manifest.json
functions/
  api/
    scrape.js             # GET /api/scrape?url=<asianbetsoccer URL> — individual match odds (CORS bypass)
    livescore.js          # GET /api/livescore[?debug=1] — all live/upcoming Pinnacle odds in one request
static/
  index.html              # App shell
  app.js                  # All logic: CSV processing, engine, UI (~2500 lines)
  style.css               # Dark theme
  data/
    manifest.json         # Auto-generated — do not edit by hand
    *.csv / **/*.csv      # Pinnacle export CSVs (nested folders supported)
telegram/
  config.js               # All configuration (credentials, L123 thresholds, scan interval)
  engine.js               # Direct port of app.js analysis logic for Node.js
  livescore.js            # Live match + odds fetcher — Bet365 is now the primary book (Node.js, no Cloudflare runtime)
  notify.js               # Entry point: cron scheduler + Strategy L123 (Layer 1/2/3 consensus) + Telegram formatting
  layer_analysis.js       # Convergence study behind L123 (which layer-agreement buckets have the best hit%/ROI)
  tune_l123.js            # Walk-forward validator for L123's Wilson-CI qualifying gate
  apifootball.js          # Optional api-football.com Bet365 price verification — fetches the live
                          # price for whatever bet is about to alert on (any of the 3 strategies),
                          # called once per alert (not a scanning gate) so the message can say
                          # "odds OK"/"odds lower"
  api_budget.js           # Shared daily call-budget guard for api-football.com's 100 req/day free
                          # plan, split into two independent pools so notifications (apifootball.js)
                          # and settlement (track_record.js) can never compete for or borrow from
                          # each other's quota: APIFOOTBALL_NOTIFICATION_BUDGET (default 80) and
                          # APIFOOTBALL_SETTLEMENT_BUDGET (default 20); a refused settlement call
                          # just retries on the next 30-min cycle.
  track_record.js         # Logs an alert only when notify.js verified a real live/api-football
                          # price that clears the target fair odds (verifiedGoodPrice()) — an alert
                          # that fires with no verifiable or sub-target price is still sent to
                          # Telegram but deliberately excluded here. Settles logged alerts once the
                          # match finishes (via api-football) and sends a daily Telegram scorecard
                          # (hit rate + ROI@price shown at alert time) — closes the loop on whether
                          # live, genuinely bettable alerts actually work, not just historical
                          # backtests. Persists to telegram/data/ (gitignored).
  backtest.js, backtest_mkt.js, backtest_tlm1h.js, backtest_under15ht.js,
  backtest_baseline.js, backtest_config.js, backtest_crossbook.js,
  backtest_dogah_favsteam.js, backtest_favsteam.js, backtest_gsa.js,
  backtest_ht.js, backtest_lm2.js, backtest_prematch.js, backtest_rules.js,
  backtest_s6_yesterday.js, backtest_under_tlsteam.js
                           # LEGACY — backtests for earlier strategies (pre-L123); kept for reference, see git history
  discover.js              # Config Discovery CLI port
BETTING_EDGE_ANALYSIS.md  # Reference: betting edge theory, workflow, Kelly sizing guide
```

## Architecture

Everything in the Python desktop app (`constants.py`, `data.py`, `engine.py`, `stats.py`, `live_odds.py`) is ported into `static/app.js` as a single file. Keep these in sync if the Python logic changes.

`app.js` structure (top-down):
1. **Constants** — `LINE_THRESH`, `VALID_LINES`, `TL_CLUSTERS`, `ADV_TL_RANGES`, `SIGNAL_UI_TO_ENGINE`, `BETS`, `COL_MAP`
2. **Data layer** — `normaliseRow`, `parseScore`, `oddsDir`, `moveDir`, `processRow`, `loadCsv`
3. **Stats** — `pct`, `zScore`, `wilsonCI`, `stability`, `minOdds`
4. **Engine** — `applyConfig`, `applyGameState`, `scoreBets`, `traceConfig`, `discover`
5. **Live odds** — `computeLiveOdd` (Poisson time-decay, 2H bets only)
6. **App state & DB** — `state` object, `_db`, `_fileInfo`, `autoLoadData`
7. **UI** — event handlers, `switchTab`, `analyzeMatch` (Manual), `runDailyDashboard` (Dashboard), `pollLiveMatches`/`renderLiveGames`/`openLiveMatchDetail` (Live Games), render functions

## Key Constants (app.js)

- **`LINE_THRESH = 0.12`**, **`ODDS_THRESH = 0.06`**, **`TL_THRESH = 0.12`**: matching tolerances for AH line, odds, and TL respectively.
- **`DEFAULT_MIN_N = 15`**, **`MIN_Z = 1.5`**: minimum sample size and z-score for Match Analysis results.
- **`VALID_LINES`**: `[0.00, 0.25, 0.50, 0.75, 1.00, 1.25, 1.50]` — includes level ball (0.00). Rows outside ±0.12 of a valid line are excluded.
- **`TL_CLUSTERS`**: named ranges `<2`, `2-2.5`, `2.5-3`, `>3` for TL cluster mode.
- **`ADV_TL_RANGES`**: finer ranges `1.5-2`, `2.25-2.75`, `3-3.5` for advanced TL range mode.
- **`SIGNAL_UI_TO_ENGINE`**: maps UI labels (`STEAM`→`IN`, `DRIFT`→`OUT`) to engine values.
- **`MIN_Z_DISC = 2.0`**: higher bar for Config Discovery (sweeps ~18k combos).

## Level Ball (0.00 Line)

When `ahHc ≈ 0`, the favourite is determined by lower closing odds (more likely to win). `favLc = 0.0`, `favLo = |ahHo|`.

## Bet Set (32 bets)

Fav-normalised AH: `ahCover`
2H fav-normalised: `favWins2H`, `favScored2H`, `draw2H`
2H home/away: `homeWins2H`, `awayWins2H`, `homeScored2H`, `awayScored2H`, `homeOver15_2H`, `awayOver15_2H`
2H totals: `over05_2H`, `over15_2H`, `under05_2H`, `under15_2H`
1H fav-normalised: `favWins1H`, `draw1H`, `favScored1H`
1H home/away: `homeWins1H`, `awayWins1H`
1H totals: `over05_1H`, `over15_1H`, `under05_1H`, `under15_1H`, `btts1H`
FT results: `homeWinsFT`, `awayWinsFT`, `drawFT`, `btts`
FT totals: `over15FT`, `over25FT`, `over35FT`, `under25FT`

Bets with `favSideBaseline` use a side-filtered baseline pool (e.g. only HOME fav rows as baseline for `homeWins2H`).

## League Tier Classification

Rows are tagged `TOP` / `MAJOR` / `OTHER` at load time via `_T1_RULES` / `_T2_KEYS` in `app.js`. The UI exposes a tier filter (All / TOP / MAJOR / OTHER) that restricts the entire database before analysis. `TOP` = top 5 European leagues + main UEFA club competitions; `MAJOR` = other strong national/continental leagues; `OTHER` = everything else.

## Filter Modes (applyConfig)

**Basic mode** (`state.filterMode === 'BASIC'`): signal-based — filters by `fav_odds_move`/`dog_odds_move`/`tl_move` direction, or by odds tolerance if tolerance toggles are on.

**Advanced mode** (`state.filterMode === 'ADVANCED'`): each signal dimension has its own on/off toggle (`advLmOn`, `advOddsTolOn`, `advHomOn`, `advAomOn`, `advTlmOn`, `advOvTolOn`, `advOvmOn`, `advUnTolOn`, `advUnmOn`) and can mix signal direction, raw odds tolerance, or TL range independently.

**TL filter priority** (inside `applyConfig`):
1. `cfg.tl_range` (exact range from `ADV_TL_RANGES`) — takes priority
2. `cfg.tl_cluster` (named cluster from `TL_CLUSTERS`)
3. `cfg.tl_c` (exact value ±0.13)
4. `cfg.tl_o` (opening TL exact match ±0.13)

`over_move` and `under_move` are tracked per row and filterable independently.

## The Livescore Function (`functions/api/livescore.js`)

Fetches all live/upcoming matches with embedded Pinnacle odds in a single request.

**Bet365 book hash** (the primary/only live book now — see the constant comments in the file) rotates periodically. The code auto-discovers it:
1. Fast path: try `GS_PRIMARY` (`Q`) + stored `BET365_HASH` (1 subrequest)
2. On 404: try direct discovery — fetch `https://www.asianbetsoccer.com/it/livescore.html`, extract new hash from `#book_filter` option values, retry
3. **If direct discovery comes back empty**, relay through Railway instead (`RAILWAY_RELAY_URL` env var + `GET /hashes`) — see below, this is the important path in practice.

**Direct discovery from this Function is effectively always blocked** (confirmed 2026-08-24): asianbetsoccer.com's WAF returns an HTTP 202 bot-challenge (193-byte body) to every request from Cloudflare's edge network, regardless of header set. So step 2 above almost never succeeds on its own — step 3 (the Railway relay) is what actually keeps the hash fresh without manual intervention now.

**Railway relay (`RAILWAY_RELAY_URL`):** `telegram/notify.js` runs an HTTP server (`startHashRelayServer()` in `notify.js`, needs Railway's public networking enabled so `process.env.PORT` is set) exposing `GET /hashes` — the hashes it last discovered via its own direct scrape of asianbetsoccer.com (Railway's outbound IP isn't subject to the Cloudflare-specific WAF block). Set `RAILWAY_RELAY_URL` in the Cloudflare Pages project's env vars to the Railway service's public URL to enable this fallback; `functions/api/livescore.js`'s `fetchHashesViaRailwayRelay()` calls it whenever direct discovery returns nothing. Without it, a stale hash requires a manual `BET365_HASH` env var update (see `?debug=1`'s `hash_discovery` block for diagnostics on which path is failing).

To manually update the hash as a last resort: open DevTools → Network on the asianbetsoccer livescore page, find a request to `botbot3.space/tables/v4/*/livegame/*.js`, copy the 40-char hex filename, and set it as `BET365_HASH` in both the Cloudflare Pages and Railway dashboards.

**Confirmed botbot3.space endpoint:**
```
https://botbot3.space/tables/v4/Q/livegame/{PINNACLE_HASH}.js?date={timestamp}&_={timestamp+1}
```

**JS file format** — builds tables via repeated function calls:
- `match2text += getData2(rowIdx, 1, leagueId, enc, matchId, ah_hc, ah_ho, ...)` — odds data
- `match1text += getDatalive1(...)` — currently live matches (minute like `'5\''` at `[10]`)
- `match1text += getDatalast1(...)` — upcoming/finishing matches (ISO datetime at `[10]`)

**Confirmed `getData2()` param indices:**
```
[4]=matchId  [5]=ah_hc  [6]=ah_ho  [11]=ho_c  [12]=ho_o
[16]=ao_c    [17]=ao_o  [21]=tl_c  [22]=tl_o
[24]=ov_c    [25]=ov_o  [29]=un_c  [30]=un_o
```

**`getDatalive1` / `getDatalast1` confirmed param indices:**
```
[5]=matchId   [6]=leagueName   [9]=homeTeam   [10]=timeOrMinute   [22]=awayTeam
[11]=home goals (integer)      [23]=away goals (integer)
[24]=home corners (integer)    [25]=away corners (integer)
[4]=statusCode — contains match stats like 'Q1_FA3-SB1-FC2' (NOT the score)
```
Score is NOT encoded in the statusCode `FD` pattern (old format). Goals are at args[11]/[23].
Score is only extracted for live matches (those with a minute field); upcoming matches also have 0s there.

**Parsing strategy in `livescore.js`:**
1. `parseGetData2Calls()` — extracts odds from `getData2()` args using confirmed indices
2. `parseGetData1Calls()` — regex matches both `getDatalive1` and `getDatalast1`; extracts teams, league, minute, score (from args[11]/[23])
3. `mergeMatchData()` — merges by `matchId`; falls back to array index
4. `fetchPinnacleHash()` — auto-discovers current Pinnacle hash from asianbetsoccer livescore page
5. HTML string fallback (`parseLivegameTables`) kept for older botbot3 format (jQuery `.html("…")`)

**Returns:**
```json
{ matches: [{ id, url, home_team, away_team, league, minute, score, odds: {ah_hc, ah_ho, ho_c, ho_o, ao_c, ao_o, tl_c, tl_o, ov_c, ov_o, un_c, un_o} }] }
```
`app.js`'s Live Games tab (`pollLiveMatches()`) uses embedded odds directly, skipping per-match `/api/scrape` calls.

**Debug endpoint:** `GET /api/livescore?debug=1` — returns `match_count`, `matches_preview` (all matches), `getData1_parsed` (every getDatalive1 call as a clean arg array) for diagnosing format changes.

## Web UI Tabs (`static/index.html` + `static/app.js`)

The UI is three tabs — Dashboard, Live Games, Manual — switched via `switchTab(name)`, which toggles `.active` on the matching tab button, left-panel control pane (`#tab-{name}-controls`), and right-panel content pane (`#right-{name}`). The DB loader card (`#db-card`) sits above the tab-specific controls and is shared by all three tabs. `_activeTab` tracks the current tab; entering `'live'` starts polling (`startLivePolling()`), leaving it stops it (`stopLivePolling()`).

- **Dashboard** (`runDailyDashboard()` → `renderDailyDashboard()`, unchanged from before the tab split) — pre-match fixture scan on opening odds, see below.
- **Manual** (`analyzeMatch()` → `renderMatchResults()`, unchanged) — manual odds entry / URL import, full pre-match + in-play analysis.
- **Live Games** (new) — see below.

`buildQualifyingList(preMap, gsMap, minN)` and `buildValueHuntList(preBets, minN)` factor out the "merge pre-match + in-play bets into a ranked qualifying/value-hunt list" logic shared by `renderMatchResults` (Manual) and the Live Games pipeline.

## Live Games Tab (`static/app.js`)

Auto-scans in-play matches from `/api/livescore` and scores each one against the historical dataset using **the match's own real closing-odds signal pattern** (`buildCfgFromLiveOdds` — same cfg-building function the old `checkLiveBets` used) — not a hypothetical signal sweep (`discover()` stays unwired/out of scope for this tab).

- `fetchLiveMatches()` — hits `/api/livescore`, keeps only `data.matches` entries with `minute != null` (the live/in-play ones; `next_matches` and not-yet-started `matches` entries are excluded, unlike the Dashboard's `fetchUpcomingFixtures`).
- **HT auto-snapshot**: `updateHtAnchor(match, minute)` captures `match.score` as the HT anchor the first time a match is seen with a minute in the 44–50 window (or the `'HT'` sentinel) — no manual entry needed. Anchors are kept in `_liveHtAnchors` (`Map<matchId, {home, away, ts}>`) and persisted to `localStorage['halvest_ht_anchors']` (this app's only localStorage usage), pruned of entries older than `HT_ANCHOR_MAX_AGE_MS` (6h) on load. A match first observed after minute 50 with no prior anchor is flagged `anchorStatus: 'unknown'` and only gets closing-odds/pre-match bets, never live 2H decay, until a fresh anchor is captured (impossible for that match instance).
- `analyzeLiveMatch(match, minute)` — runs `applyConfig`/`applyBaselineConfig` + `scoreBets` for the pre-match pool (`preBets`, always computed if enough history), then, once an HT anchor is known, `applyGameState({trigger:'HT',...})` + `scoreBets` for the HT-conditioned pool (`htBets`), then — once `minute > 45` and a current score is available — `buildLiveAdjustedBet` per bet (goals-since-anchor derived from `match.score − anchor`, mapped to fav/dog via `cfg.fav_side`) for the minute-decayed live pool (`liveBets`). Whichever of `liveBets`/`htBets`/`preBets` is most specific becomes `gsBets`, consumed the same way Manual Analysis's `gsAllBets` is.
- `pollLiveMatches()` — fetches, snapshots anchors, analyzes, ranks matches by their best bet's CI-adjusted score (`rankScore` = `z * lo/100`, same metric `scoreBets` itself sorts by), renders. Runs immediately on entering the tab and every `LIVE_POLL_MS` (60s) via `setInterval` while the tab stays active and auto-refresh is on (`toggleLiveAutoRefresh`) — the only recurring timer in this codebase.
- `renderLiveGames()` — a "🏆 BEST LIVE BET" banner (reuses `renderMergedBetCard` directly, rank namespace `'live-top'`) followed by one compact `.scan-card` per match (`renderLiveMatchCard`), each clickable by array index (`openLiveMatchDetail(idx)` — index into `_liveMatches`, deliberately **not** a team-name-derived id, since team/league names come from the scraped feed and aren't safe to embed raw into an inline `onclick`).
- `openLiveMatchDetail(idx)` opens `#live-match-modal` (new `.modal-overlay`/`.modal-box` CSS) showing the full per-match breakdown — reuses `renderMergedBetCard`/`renderTopValueBanner`/`renderValueHuntSection`/`buildTraceHtml`/`renderBetDashboard` unchanged, just fed this match's live-derived `cfg`/`gsForTrace` instead of manual input. Rank namespace `'live-detail-*'`.
- **Kelly-widget rank namespacing**: `buildBetCol` keys `_lastBetsByWidget` by `${rank}-${colId}`, and this map is shared globally (reset only by `renderMatchResults`, i.e. Manual Analysis runs). Live Games' banner and modal use the `'live-top'`/`'live-detail-*'` rank prefixes specifically to avoid colliding with Manual Analysis's own `'top'`/numeric ranks when both are present in the DOM (the modal layers over whichever tab is active).

## Best Value Bet Banner & Top Pick (`static/app.js`)

After a Match Analysis run, two headline banners render above the full results table so the actionable answer doesn't require scrolling:
1. **Top Pick** — the single highest-ranked qualifying bet (same CI-adjusted `z*lo` metric `scoreBets` sorts by).
2. **Best Value Bet** — the best positive-edge bet that falls *below* the z-score bar (wouldn't otherwise surface outside the collapsed Value Hunting section), ranked by the same metric.

Both render right after each other, Top Pick first. Mobile layout was also fixed in the same change: a `min-width:360px` rule on the left panel wasn't overridden under the 900px breakpoint, causing real horizontal overflow on phones narrower than ~384px; the header's long instructional copy is hidden on small screens.

## The Scrape Function (`functions/api/scrape.js`)

Accepts `GET /api/scrape?url=<asianbetsoccer.com/match?id=HEX>`. Strategy:

1. Extracts the `?id=` hex from the asianbetsoccer URL.
2. Fetches `https://botbot3.space/tables/v4/oddsComp/<id>.js` server-side (CORS bypass).
3. Parses `tablematch1` to find each bookmaker's index. **Bet365 is tried first** (the bundled historical dataset is Bet365-sourced, so analysis is calibrated against it); falls back to Pinnacle only if Bet365 isn't listed or fails to parse. Previously a match with no Pinnacle odds errored out even when Bet365 was available.
4. Parses `tablematch2`, splits groups by `<tr class='vrng'>` separator rows, extracts the chosen book's group.
5. Parses H/A rows **by TD cell position** (not CSS class — classes like `SU`/`SD`/`SN` vary per match).

Returns JSON: `ah_hc`, `ah_ho`, `ho_c`, `ho_o`, `ao_c`, `ao_o`, `tl_c`, `tl_o`, `ov_c`, `ov_o`, `un_c`, `un_o` — mapped directly to app input fields. `static/app.js`'s reference-odds display shows whichever book *wasn't* used for the primary fields, labeled accordingly.

**If the source HTML structure changes**, update positional offsets in `parseTds` (lines ~164–180 of `scrape.js`).

## Live 2H Time-Decay Odds (`computeLiveOdd` in `static/app.js`)

Estimates a live fair probability/odd for 2H-only bets given HT hit%, match minute, and current 2H score. Recalibrated (2026-08-21) against this app's own ~165k-match dataset:
- **Score-state modifier** is now three bet-class-specific tables derived from the app's own data (previously backwards — it boosted the *trailing* team instead of the already-leading favourite).
- **Intra-half timing curve** was sourced from external published goal-timing research and gated behind a flat-decay toggle, since it couldn't be validated against this dataset (no goal-minute data, only HT/FT scores) — see the next paragraph, this blocker is now closed.
- Fixed a bug where the function returned `live_p:100` whenever time ran out, regardless of whether the bet had actually hit.

**Updated 2026-08-22, validated against real goal-minute data** (`football-data/data/goals_time2` via `telegram/goal_timing.js`, 12 domestic leagues × 3 seasons × 27,321 goals):
- **`_1H_INTENSITY`/`_2H_INTENSITY`** (the intra-half timing curve) replaced with the real empirical shape — the old externally-sourced curve significantly overstated 1st-half late-game clustering and got the 2nd half's 15-30-minute bucket's direction backwards (assumed elevated, real data shows it's the *lowest* of the three buckets). Cross-league standard deviation was small (0.03-0.05) despite very different leagues, so a single pooled curve is used (`computeLiveOdd` has no league parameter — see `static/data/goal_timing_summary.json` for the per-league breakdown if this is revisited).
- **`_TOTAL_SCORE_MOD`** replaced with real data too — this table is a genuine apples-to-apples fix (total goals don't care which side is the favourite, only the margin's magnitude, so goals_time2's home/away-only data measures it directly). Real total 2H scoring barely responds to the current margin (leading team's own scoring rises ~27% at a 2+ margin, trailing team's falls ~23%, nearly cancelling out — net +2.6%, not the +30% previously assumed).
- **`_FAV_SCORE_MOD`/`_DOG_SCORE_MOD` left unchanged** — goals_time2 has no pre-match favourite designation, only home/away, so it can't isolate a favourite-specific effect from a generic leading/trailing-team effect. A generic leading/trailing re-derivation found the "leading" side's pattern roughly consistent with the existing tables, but a real divergence on the "trailing favourite" entries — generic trailing teams score progressively *less* as the margin grows (0.99/0.95/0.77 at margin 0/1/2+), not the flat-to-mild-increase the table assumes for a trailing favourite specifically. Plausibly explained by favourites retaining more quality when behind than a generic trailing team, but unverifiable without linking to pre-match odds — treat the "-1"/"-2" (favourite trailing) entries with more caution than "1"/"2" (favourite leading).

**1H live-decay added (2026-08-26)** — previously 1H bets in Live Games only ever showed the static pre-match/closing-odds hit rate, with no minute-by-minute updating (the `_1H_INTENSITY` curve above was calibrated but never wired into any live-decay call). `computeLive1HOdd`/`computeLiveResult1H`/`computeLiveBtts1H`/`buildLive1HAdjustedBet` mirror the 2H functions, anchored at kickoff (always 0-0, so no anchor-capture step is needed the way 2H needs an HT snapshot) instead of HT. Deliberately has **no score-state margin modifier** — the `_FAV_SCORE_MOD`/`_DOG_SCORE_MOD`/`_TOTAL_SCORE_MOD` tables above are calibrated from *HT-margin → rest-of-2H* scoring, a different question than *current-1H-margin → rest-of-1H* scoring that was never measured; applying them here would misrepresent an untested relationship. Not ported to `telegram/live_odds.js` (Telegram's LATEGOAL/QUIET2H strategies are 2H-only by design) — web UI only.

**`_IT_1H`/`_IT_2H` calibrated from data (2026-08-26)**, replacing assumed values (2 and 4 respectively — `_IT_1H` was previously just "half of `_IT_2H`", and `_IT_2H` itself was never calibrated). Each represents how many extra minutes of goal-intensity the stoppage-time window adds, in this model's own rate-integral terms; solved so that mass's share of the whole half matches the real share of goals recorded during that half's actual stoppage time (`45+N'`/`90+N'` incident minutes) in `goals_time2` (12 leagues × 3 seasons through 2024-2025): 1H — n=12,261 first-half goals, 5.81% in recorded 1H stoppage (avg 2.65 added min when it happens) → **`_IT_1H` = 2.40**. 2H — n=15,060 second-half goals, 12.32% in recorded 2H stoppage (avg 3.72 added min) → **`_IT_2H` = 5.07**. The 2H stoppage share running ~2× the 1H share matches the general refereeing pattern (more subs/treatment/VAR stoppages accumulate by full time) — a sanity check the calibration passes, not something it was tuned to hit. Mirrored into `telegram/live_odds.js`'s `_IT_2H`.

## CSV Workflow

1. Drop Pinnacle export CSVs into `static/data/` (nested folders OK, e.g. `data/League/Season/file.csv`).
2. Run `node build.js` to regenerate `manifest.json`.
3. Commit and push — Cloudflare auto-redeploys.

Required columns: AH Home/Away Closing+Opening, Home/Away Odds Closing+Opening, HT Result, FT Result. TL columns optional but needed for TL filtering. Column names accepted with spaces or underscores.

## Telegram Notifier (`telegram/`)

Standalone Node.js service that polls live matches and sends Telegram alerts under three active strategies — **L123** (pre-match), **LATEGOAL** (in-play, still no 2H goal), and **QUIET2H** (in-play, expect a quiet 2nd half; see below); everything else is legacy (see further down). Deployable to Railway or run locally.

```bash
cd telegram
npm install

node notify.js          # start scheduler (runs every SCAN_INTERVAL_MINUTES, default 2 min)
node notify.js --once   # single scan + exit (for testing)
node tune_l123.js       # walk-forward validator for the L123 qualifying gate (Wilson CI vs point estimate)
node layer_analysis.js  # convergence study — which layer-agreement bucket (1/3, 2/3, 3/3) has the best hit%/ROI
```

**Strategy L123 — Layer 1/2/3 consensus** (`notify.js` + `config.js`): three independent layers each independently recommend a bet from historical data, each restricted to only the information that layer is allowed to see:
- **Layer 1 — opening odds only** (fav opening odds band + opening TL band)
- **Layer 2 — movement only** (`line_move`, fav/dog odds move, `tl_move`)
- **Layer 3 — closing odds only** (fav closing odds band + closing TL band)

An alert fires in the **10-minute pre-match window** (kickoff minus 10 minutes down to kickoff itself — see `PRE_MATCH_WINDOW_MIN` in `notify.js`'s `matchContext()`) once `L123_MIN_AGREE` (default 2) of the 3 layers independently land on the same bet, using odds polled every `SCAN_INTERVAL_MINUTES`. Pre-match rather than in-play by design — it gives time to actually place the bet at a stable price instead of needing fast in-play execution once the match has started. This came out of `layer_analysis.js`'s convergence study, which found the "2/3 agree" and "3/3 agree" buckets beat any single layer alone or matches where layers disagree.

Note this pre-match timing is a real shift from how L123 was originally walk-forward validated (see the ROI numbers below) — Layer 3 ("closing odds only") was validated against the true closing line *at* kickoff, and odds polled up to 10 minutes early can still move before then, so it's a same-idea-different-timing approximation of "closing," not the exact thing the walk-forward backtest measured.

**Qualifying gate (walk-forward validated 2026-08-21):** bets qualify off the **Wilson CI lower bound**, not the raw point estimate — `(b.lo - b.bl) >= L123_MIN_EDGE`, plus `n >= L123_MIN_N`, `z >= L123_MIN_Z`, baseline `>= L123_MIN_BASELINE` — per layer. The prior point-estimate gate produced negative-to-flat ROI@fair OOS despite good-looking hit rates (winner's-curse selection from sweeping thousands of cells). Gating on the CI lower bound instead: **+7.3% ROI@fair** pooled across 5 exploratory held-out months (5/5 positive), **+10.6%** across 2 never-touched lock-box months (2/2 positive). `telegram/tune_l123.js` is the reusable validator.

**Current config values (`config.js`):**

| Setting | Value | Meaning |
|---|---|---|
| `L123_ENABLED` | `true` | Only active strategy |
| `L123_TIER` | `TOP+MAJOR` | League tier filter (falls back to `LEAGUE_TIER`) |
| `L123_MIN_N` | 30 | Min historical pool size per layer |
| `L123_MIN_Z` | 1.8 | Min z-score per layer |
| `L123_MIN_EDGE` | 0 | Min pp the Wilson CI *lower bound* must clear baseline by |
| `L123_MIN_BASELINE` | 20 | Min baseline hit rate per layer |
| `L123_MIN_AGREE` | 2 | 2 = fire on 2/3 or 3/3 agreement; 3 = require 3/3 |
| `SCAN_INTERVAL_MINUTES` | 2 | Poll frequency |

**Live price gate:** before alerting, the recommended bet's Bet365 live price is checked against the conservative min odds (`bet.mo_lo`, derived from the Wilson CI) — the alert only fires if the live price is at or above it.

**Model probability line (`modelProbLine()`, `notify.js`):** every alert (L123, LATEGOAL, QUIET2H) always prints a standalone `🎲 Model probability (for manual Kelly): X%` line, independent of whether a verified price was found (unlike `kellyLine()`, which only prints once `actualPrice` is known) — so there's always a number to plug into a manual Kelly calculation (e.g. against a different bookmaker's price than the one auto-checked). It's the same CI-lower-bound probability `kellyLine()` itself sizes against — `bet.lo` for L123, the CI-lower live-decayed rate (`liveOddLo.live_p`) for LATEGOAL/QUIET2H — never the raw point-estimate historical rate shown in the "📊 x% historically" line, which is winner's-curse-inflated and would overstake if fed into Kelly directly.

**Data source:** the historical pool is `static/data/Bet365/*.csv` (Bet365-priced, matching the live `match.bet365_odds` it's compared against) — see `DATA_URL`/`DATA_DIR` in `config.js`.

**Architecture:** `notify.js` orchestrates — it calls `engine.js` (port of `app.js` analysis logic) and `livescore.js` (live match + odds fetcher, Bet365 is the primary book — see below). Config lives entirely in `telegram/config.js`.

**Deduplication in `notify.js`:** in-memory `_notified`/`l123Dedup` map keyed by `matchId:betKey`, expires after 2 hours. Resets on process restart — a restarted notifier will re-alert for active matches.

**Sync requirement:** `telegram/engine.js` is a direct port of `static/app.js` constants + engine sections. When changing scoring logic, filter modes, the bet set, or league tier classification in `app.js`, mirror those changes in `telegram/engine.js`.

**Railway deployment:** set `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, `DATA_URL` as env vars in the Railway dashboard. Also supports `BET365_HASH`/`PINNACLE_HASH`/`SBOBET_HASH` overrides as a no-redeploy manual stopgap if hash auto-discovery breaks (e.g. asianbetsoccer.com's WAF blocking Railway's outbound IP — auto-discovery failures now log the real fetch error instead of swallowing it in a bare `catch{}`). The `railway.json` in `telegram/` defines the start command.

**Enable Railway public networking** so `startHashRelayServer()` in `notify.js` can bind to the auto-assigned `PORT` and serve `GET /hashes` — this is what lets `functions/api/livescore.js` (the web UI, whose own hash discovery is blocked by asianbetsoccer's WAF from Cloudflare's edge — see "The Livescore Function" above) self-heal without a manual `BET365_HASH` paste. Then set `RAILWAY_RELAY_URL` in the Cloudflare Pages project's env vars to the Railway service's public URL.

**Strategy LATEGOAL — "still no 2H goal" watch** (`notify.js` + `config.js`, added 2026-08-22): fires once per match within `LATEGOAL_TRIGGER_WINDOW` (default 68'-72', windowed rather than a single minute so a missed/delayed scan cycle can't fire it arbitrarily late) if the match's HT scoreline historically supports a 2nd-half goal (checked against a fav-line/side + exact-HT-state historical bucket, further split by the match's own closing **Total Line band** — see below) AND no goal has actually been scored since HT (an in-memory HT-score snapshot, captured for every live match crossing minute 44-50 regardless of strategy, is compared against the current score). Considers `over05_2H`/`favScored2H`/`homeScored2H`/`awayScored2H` (`LATEGOAL_BETS`).

**TL-band filter (added 2026-08-23):** the historical pool is bucketed by the match's own closing TL (`TL_BANDS`, same 4 buckets L123's `layer1Live`/`layer3Live` use), falling back to the TL-blind pool if the band is unknown or has fewer than `LATEGOAL_MIN_N` rows. Two identical HT scorelines mean very different things depending on how much of the pre-match total-goals expectation is already "used up" — e.g. HT 0-0 with TL 3.5 vs. HT 0-0 with TL 1.5 — and pooling them together was diluting the signal (`over05_2H` at HT 0-0 ranged 71%-83% across TL bands vs. a flat 75.4% from the TL-blind pool). Walk-forward re-check after adding the band: 1.9pp claimed-vs-actual gap (vs. 2.5pp before), while surfacing more distinct qualifying cells (16 vs. 11) — a genuine improvement, not overfitting, since `bet.p` (and therefore both the message's headline rate and `computeLiveOdd`'s live fair-odds target) now reflects the TL-matched pool automatically. The alert message also shows a `tlPaceLine()` — current goals vs. the match's own TL — so ahead-of/behind-pace context is visible even where the fallback pool is used.

**Walk-forward validated (2026-08-22, pre-TL-split baseline):** 34,596 flagged (HT-state, bet) instances across 10 held-out months — 65.9% claimed vs. 64.5% realized hit rate, well-calibrated (unlike L123's original point-estimate gate). Note this validates the *historical signal claim* only (does a goal happen somewhere in the 2nd half); it can't validate the exact "still nothing by minute 70 specifically" timing against real minute-level data, since `goals_time2` (the only source with real goal minutes) has no favourite/odds designation to replicate the signal selection — see `telegram/live_odds.js`'s header comment.

**No bookmaker lists any of the 4 LATEGOAL bet types directly** — but every one of them is mathematically equivalent to a real, standard market once you condition on the score being unchanged since HT (`equivalentRealMarket()` in `notify.js`):
- `favScored2H`/`homeScored2H`/`awayScored2H`: if that side has 0 goals so far and the opponent has ≥1, "this side scores" = **BTTS Yes** (the opponent already satisfied BTTS's other half).
- `over05_2H` ("any goal happens"): always equivalent to **Over (current total + 0.5) FT** — e.g. still 0-0 → Over 0.5 FT; still 0-2, 2-0, or 1-1 → Over 2.5 FT; still 0-1 or 1-0 → Over 1.5 FT.

When the equivalence applies, the alert calls `apifootball.js`'s `verifyBet365Price()` for that *real* market instead of showing only the internal Poisson estimate — same api-football integration L123 uses, `overTL`/`btts` were already supported market types.

**Live fair-odds estimate:** `telegram/live_odds.js` is a Node port of `static/app.js`'s `computeLiveOdd` (verified to produce identical output) — used to time-decay the HT-anchor hit rate down to a live fair probability/odds at the current minute, given no goal has happened yet.

**Strategy QUIET2H — "expect a quiet 2nd half" watch** (`notify.js` + `config.js`, added 2026-08-23): the mirror image of LATEGOAL. Fires once per match right at halftime — within the same `HT_SNAPSHOT_WINDOW` (44'-50') the HT-score snapshot itself is captured in, so it doesn't wait for a condition to hold first (unlike LATEGOAL) but also can't fire arbitrarily late into the 2nd half if a scan cycle is missed — if the match's own closing Total Line is low (`QUIET2H_TL_BANDS`, default `<2` and `2-2.5` only) and the HT-conditioned historical pool (fav line/side + TL band + exact HT score) shows a qualifying `under05_2H`/`under15_2H` bet.

**Market equivalence, same trick as LATEGOAL run in reverse** (`equivalentRealMarketQuiet2h()`): QUIET2H fires the moment 2H starts, so the current score always equals the HT snapshot — "no more goals in 2H" (`under05_2H`) always equals "FT total stays at the current total", and "at most 1 more goal in 2H" (`under15_2H`) always equals "FT total rises by at most 1". Both re-express as a standard, directly quotable **Under Total Goals FT** market api-football already supports (`underTL`): e.g. HT 1-0 or 0-1 (current total 1) → `under05_2H` = Under 1.5 FT, `under15_2H` = Under 2.5 FT. Same `apifootball.js` call L123/LATEGOAL use, just with the computed line as `ctx.avgTl`.

**Research + walk-forward validation (2026-08-23):** Total Line band is by far the dominant driver of a quiet 2nd half — TL`<2` shows ~32-39% under05_2H / ~70-75% under15_2H (vs. 22.2%/54.9% pooled baseline), TL `2-2.5` shows a smaller but still real elevation (~25-33%/~60-67%), TL`>=2.5` shows no edge at all (excluded by default). Walk-forward: 79 qualifying (fav_line/side, TL band, HT state) cells across 10 held-out months — 50.6% claimed vs. 49.1% realized (1.5pp gap), tighter than even LATEGOAL's own TL-banded calibration. Two follow-up movement checks were tested and **rejected** — neither survives walk-forward on top of the TL-band+HT-state query: `tl_move` showed no residual effect once TL band is controlled for, and `under_move=IN`/`over_move=OUT` (Over/Under odds steaming toward Under) showed a real pooled effect (z≈3 in the TL `2-2.5` band) but widened the calibration gap from 0.3pp to 1.5pp and shrank coverage by ~4x once stacked on the HT-state split — the plain TL-band query was already better calibrated on its own.

## Live Match & Odds Feed (`telegram/livescore.js`)

Adapted from `functions/api/livescore.js` for Node ≥ 18 native fetch. **Bet365 is now the primary (and only) live book** — it carries both the match list and odds, so Pinnacle can no longer be auto-discovered but Bet365's hash can. Odds are aliased onto `match.bet365_odds`, the field name Strategy L123 reads for its live price gate. Hash auto-discovery/fallback logic otherwise mirrors `functions/api/livescore.js` (see below).

**Optional — `telegram/apifootball.js`:** independent Bet365 price verification via api-football.com, purely informational — it does **not** change whether an alert fires (that decision is made entirely by each strategy's own logic before this runs). If `APIFOOTBALL_KEY` is set in `config.js`, `notify.js` calls `verifyBet365Price(betKey, ctx, key)` once, right before sending an alert, for whatever bet was just picked (L123, or the equivalent real market LATEGOAL/QUIET2H substituted in), and appends an "✅ ODDS OK" / "⚠️ ODDS LOWER" / "🔍 not available" line to the message — so there's no need to open Bet365 manually to check. Only called at alert-send time, never on every scan cycle, since the free plan caps at 100 req/day (2 calls per alert: one fixture lookup, cached per match, plus one odds lookup). Covers the markets api-football reliably lists as a single matchable value: Asian Handicap (`ahCover`/`dogCover`), Goals Over/Under (`overTL`/`underTL`), Match Winner (`homeWinsFT`/`awayWinsFT`/`drawFT`), and Both Teams Score (`btts`) — the other ~24 bet types (half-specific/derived stats like `favWins2H`) return `{ supported: false }` immediately, no API call spent, and the message says the check wasn't available for that market, unless LATEGOAL/QUIET2H's equivalence trick substitutes in one of the supported ones. Leave `APIFOOTBALL_KEY` unset to disable entirely — alerts fire exactly as before, just without the extra line.

**Daily budget guard (`telegram/api_budget.js`, added 2026-08-23):** both `apifootball.js` (alert-time verification) and `track_record.js` (settlement) route every real API call through a shared in-memory tracker, since both draw on the same 100 req/day quota. Rather than one shared counter, the quota is split into two independent, non-overlapping pools — `APIFOOTBALL_NOTIFICATION_BUDGET` and `APIFOOTBALL_SETTLEMENT_BUDGET` — so neither can ever borrow from or starve the other; exhausting one pool has zero effect on the other's remaining allowance. A refused settlement call throws an error its own per-entry `try/catch` already handles gracefully, simply retrying on the next 30-min cycle with nothing lost. Resets at UTC midnight; resets early (fresh budget) on a process restart, since it's in-memory only, matching the existing `_fixtureCache` pattern. **Currently: notifications get the full 100, settlement gets 0** (all quota reserved for live alert-time checks for now) — `settlePendingAlerts` still runs every 30 min but every api-football call it attempts is refused, so alerts stay logged-but-unsettled until `APIFOOTBALL_SETTLEMENT_BUDGET` is set back to a positive value.

## Legacy Strategies & Backtests (`telegram/`)

Everything below predates Strategy L123 (superseded 2026-08-21) and is **not called from `notify.js`**. Kept for reference / historical context — see git log for the strategies that used them (movement-signal Gate 1/2/3 MA+Bayesian+HT scoring, market-calibrated `mkt_edge`, TLM-steam Over 0.5 1H, Under 1.5 2H at HT, etc.): `backtest.js`, `backtest_mkt.js`, `backtest_tlm1h.js`, `backtest_under15ht.js`, `backtest_baseline.js`, `backtest_config.js`, `backtest_crossbook.js`, `backtest_dogah_favsteam.js`, `backtest_favsteam.js`, `backtest_gsa.js`, `backtest_ht.js`, `backtest_lm2.js`, `backtest_prematch.js`, `backtest_rules.js`, `backtest_s6_yesterday.js`, `backtest_under_tlsteam.js`.

**Why earlier league-tier and low-base-rate findings still matter:** `L123_TIER` defaults to `TOP+MAJOR` and `L123_MIN_BASELINE` defaults to 20, carrying forward two findings validated during the pre-L123 era — obscure leagues and low base-rate bets (e.g. rare 2H/1H side markets) both underperform out-of-sample despite passing z-score/edge thresholds, because cell sizes are too small to be reliable even at high z.

## Key Differences vs Python Desktop App

| Aspect | Desktop (`gamestate_gui.py`) | This (`static/app.js`) |
|---|---|---|
| Config Discovery bar | `MIN_Z = 1.5` | `MIN_Z_DISC = 2.0` |
| Bet set | 16 bets | 32 bets (adds FT markets, BTTS, 1H/2H totals) |
| Filter mode | Basic only | Basic + Advanced (per-signal toggles) |
| Level ball | Not supported | Supported (0.00 line, fav by odds) |
| Scrape auto-fill | Not available | `/api/scrape?url=` pre-fills all inputs |
| `traceConfig` | Not in desktop | Returns per-filter funnel counts |
| Value hunting | Not shown | Renders bets with no edge but fair min odds |
