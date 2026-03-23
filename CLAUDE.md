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
  config.js               # All configuration (credentials, thresholds, scan interval)
  engine.js               # Direct port of app.js analysis logic for Node.js
  livescore.js            # Adapted livescore fetcher (Node.js, no Cloudflare runtime)
  notify.js               # Entry point: cron scheduler + Telegram message formatting
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
7. **UI** — event handlers, `runMatch`, `runDisc`, render functions

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

**Pinnacle book hash** rotates periodically (sometimes multiple times per day). The code auto-discovers it:
1. Fast path: try `GS_PRIMARY` (`Q`) + `PINNACLE_HASH` (1 subrequest)
2. On 404: fetch `https://www.asianbetsoccer.com/it/livescore.html`, extract new hash from `#book_filter` option values (1 subrequest), retry
3. Fall through: sweep all `GS_CANDIDATES` × hashes (max ~21 subrequests total, well under Cloudflare's 50 cap)

To manually update the hash: open DevTools → Network on the asianbetsoccer livescore page, find a request to `botbot3.space/tables/v4/*/livegame/*.js`, copy the 40-char hex filename.

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
`app.js` `runBatchScan()` uses embedded odds directly, skipping per-match `/api/scrape` calls. Scan cards display league (blue), live minute (yellow), and score (green).

**Debug endpoint:** `GET /api/livescore?debug=1` — returns `match_count`, `matches_preview` (all matches), `getData1_parsed` (every getDatalive1 call as a clean arg array) for diagnosing format changes.

## Live Scan Behaviour (`runBatchScan` in `app.js`)

- Fetches all live matches from `/api/livescore` (embedded odds, no per-match scrape needed).
- Scores each match on **pre-match bets only** (no game state filter applied) — cleaner signal, consistent across all matches.
- Scan cards show: league (blue), score (green, e.g. `1-0`), minute (yellow, e.g. `14'`), signal badges, top 3 bets.
- Each bet row shows: label · z-score (green=above baseline, red=below) · hit% `vs` baseline% · min odds.
- Results sorted by **match minute ascending** (earliest = most time left to act).
- `_scanDataCache` stores `{ odds, match }` per match id for use when clicking "Use this match →".
- `useScanMatch(id)` calls `fillFromScraped(entry.odds)` + `fillLiveMatchState(entry.match)`:
  - `fillLiveMatchState` sets the live minute estimator field and pre-fills HT score fields from `match.score` (only when score is explicitly known — never defaults to 0-0 to avoid masking parse failures).
  - If minute > 45 (2H), 2H in-play fields are reset to 0-0 (HT breakdown unknown without HT data).

**Odds tolerance quick buttons (Basic mode):** EXACT · 0.02 · 0.05 · 0.07 · 0.10

## The Scrape Function (`functions/api/scrape.js`)

Accepts `GET /api/scrape?url=<asianbetsoccer.com/match?id=HEX>`. Strategy:

1. Extracts the `?id=` hex from the asianbetsoccer URL.
2. Fetches `https://botbot3.space/tables/v4/oddsComp/<id>.js` server-side (CORS bypass).
3. Parses `tablematch1` to find Pinnacle's bookmaker index.
4. Parses `tablematch2`, splits groups by `<tr class='vrng'>` separator rows, extracts the Pinnacle group.
5. Parses H/A rows **by TD cell position** (not CSS class — classes like `SU`/`SD`/`SN` vary per match).

Returns JSON: `ah_hc`, `ah_ho`, `ho_c`, `ho_o`, `ao_c`, `ao_o`, `tl_c`, `tl_o`, `ov_c`, `ov_o`, `un_c`, `un_o` — mapped directly to app input fields.

**If the source HTML structure changes**, update positional offsets in `parseTds` (lines ~164–180 of `scrape.js`).

## CSV Workflow

1. Drop Pinnacle export CSVs into `static/data/` (nested folders OK, e.g. `data/League/Season/file.csv`).
2. Run `node build.js` to regenerate `manifest.json`.
3. Commit and push — Cloudflare auto-redeploys.

Required columns: AH Home/Away Closing+Opening, Home/Away Odds Closing+Opening, HT Result, FT Result. TL columns optional but needed for TL filtering. Column names accepted with spaces or underscores.

## Telegram Notifier (`telegram/`)

Standalone Node.js service that runs periodic live scans and sends Telegram alerts for qualifying bets. Deployable to Railway or run locally.

```bash
cd telegram
npm install

node notify.js          # start scheduler (runs every N minutes)
node notify.js --once   # single scan + exit (for testing)
node backtest.js        # simulate against last month (Feb 2026) — TOP+MAJOR filter
node backtest.js --all  # same but all leagues
node backtest.js --summary  # suppress individual alerts, show per-bet table only
```

**Architecture:** `notify.js` orchestrates — it calls `engine.js` (port of `app.js` analysis logic) and `livescore.js` (adapted from `functions/api/livescore.js` for Node >= 18 native fetch). Config lives entirely in `telegram/config.js`.

**Current config values (`config.js`):**

| Setting | Value | Reason |
|---|---|---|
| `MIN_N` | 35 | Minimum historical pool size after signal filtering |
| `MIN_Z` | 2.0 | Minimum z-score for statistical significance |
| `MIN_EDGE` | 6 | Minimum pp above baseline |
| `MIN_BASELINE` | 25 | **Suppresses low base-rate bets** — see below |
| `REQUIRE_MOVEMENT` | true | Skip matches where every active signal is STABLE/UNKNOWN |
| `LEAGUE_TIER` | `TOP+MAJOR` | See below |
| `SCAN_INTERVAL_MINUTES` | 3 | Poll frequency |

**Why `LEAGUE_TIER = TOP+MAJOR` (not ALL):**
Backtested against Feb 2026 (10,040 matches, all data before Feb excluded as DB):
- ALL leagues: 1,908 alerts, **40% hit rate, −1.5pp edge** — obscure leagues pollute the signal
- TOP+MAJOR: 664 alerts, **43% hit rate, +2.7pp edge**

TOP+MAJOR keeps leagues where the Pinnacle market is deep and the DB coverage is consistent. `engine.js` implements both tiers — `_T1_RULES` for TOP (top 5 EU + UEFA competitions), `_T2_KEYS` for MAJOR (~40 strong national/continental leagues). Both must be kept in sync with `app.js` if the classification changes.

**Why `MIN_BASELINE = 25` (suppress low base-rate bets):**
Bets with a baseline hit rate below ~25% — e.g. Home Over 1.5 2H (baseline ~4%), Away wins 1H (~7%), BTTS 1H (~9%), Over 3.5 FT (~11%) — consistently underperform out-of-sample despite high z-scores. The historical pattern doesn't hold for rare events because the cell sizes are too small to be reliable even at z ≥ 2.0.

Applying `MIN_BASELINE = 25` on the Feb 2026 backtest (TOP+MAJOR):
- Dropped from 664 → **452 alerts** (−32%)
- Hit rate improved from 43% → **56%**
- Edge improved from +2.7pp → **+5.3pp**

Surviving bets are high-frequency markets where the signal genuinely holds: Over 0.5 1H/2H, Fav/Home scores 1H/2H, Under 1.5 2H, Over 2.5 FT, Draw 1H.

**Why `REQUIRE_MOVEMENT = true`:**
Without this, a match where both LM and TLM are STABLE would still be scored. The AH line + TL combination alone can show spurious historical edge in small cells. Requiring at least one active signal to be non-STABLE/non-UNKNOWN ensures every alert has a genuine market movement story.

**Message format:**
Each alert contains: league, match, score/minute, AH line + signal summary, then per bet: name, 💰 min odds to look for, hit% vs baseline%, edge, z-score, n. Sorted by z-score descending. In-play game state shown per bet when available (n ≥ 10).

**Sync requirement:** `telegram/engine.js` is a direct port of `static/app.js` constants + engine sections. When changing scoring logic, filter modes, the bet set, or league tier classification in `app.js`, mirror those changes in `telegram/engine.js`.

**Railway deployment:** set `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`, and `DATA_URL` as env vars in the Railway dashboard. The `railway.json` in `telegram/` defines the start command.

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
