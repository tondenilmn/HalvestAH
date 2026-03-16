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
    scrape.js             # Cloudflare Pages Function: GET /api/scrape?url=<asianbetsoccer URL>
static/
  index.html              # App shell
  app.js                  # All logic: CSV processing, engine, UI (~1950 lines)
  style.css               # Dark theme
  data/
    manifest.json         # Auto-generated — do not edit by hand
    *.csv / **/*.csv      # Pinnacle export CSVs (nested folders supported)
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

- **`VALID_LINES`**: `[0.00, 0.25, 0.50, 0.75, 1.00, 1.25, 1.50]` — includes level ball (0.00). Rows outside ±0.13 of a valid line are excluded.
- **`TL_CLUSTERS`**: named ranges `<2`, `2-2.5`, `2.5-3`, `>3` for TL cluster mode.
- **`ADV_TL_RANGES`**: finer ranges `1.5-2`, `2.25-2.75`, `3-3.5` for advanced TL range mode.
- **`SIGNAL_UI_TO_ENGINE`**: maps UI labels (`STEAM`→`IN`, `DRIFT`→`OUT`) to engine values.
- **`MIN_Z_DISC = 2.0`**: higher bar for Config Discovery (sweeps ~18k combos).

## Level Ball (0.00 Line)

When `ahHc ≈ 0`, the favourite is determined by lower closing odds (more likely to win). `favLc = 0.0`, `favLo = |ahHo|`.

## Bet Set (24 bets)

Fav-normalised: `ahCover`, `favWins2H`, `favScored2H`, `draw2H`
Home/Away 2H: `homeWins2H`, `awayWins2H`, `homeScored2H`, `awayScored2H`, `homeOver15_2H`, `awayOver15_2H`
2H totals: `over05_2H`, `over15_2H`, `under05_2H`, `under15_2H`
FT results: `homeWinsFT`, `awayWinsFT`, `drawFT`, `dnbHome`, `dnbAway`, `btts`
FT totals: `over15FT`, `over25FT`, `over35FT`, `under25FT`

Bets with `favSideBaseline` use a side-filtered baseline pool (e.g. only HOME fav rows as baseline for `homeWins2H`).

## Filter Modes (applyConfig)

**Basic mode** (`state.filterMode === 'BASIC'`): signal-based — filters by `fav_odds_move`/`dog_odds_move`/`tl_move` direction, or by odds tolerance if tolerance toggles are on.

**Advanced mode** (`state.filterMode === 'ADVANCED'`): each signal dimension has its own on/off toggle (`advLmOn`, `advOddsTolOn`, `advHomOn`, `advAomOn`, `advTlmOn`, `advOvTolOn`, `advOvmOn`, `advUnTolOn`, `advUnmOn`) and can mix signal direction, raw odds tolerance, or TL range independently.

**TL filter priority** (inside `applyConfig`):
1. `cfg.tl_range` (exact range from `ADV_TL_RANGES`) — takes priority
2. `cfg.tl_cluster` (named cluster from `TL_CLUSTERS`)
3. `cfg.tl_c` (exact value ±0.13)
4. `cfg.tl_o` (opening TL exact match ±0.13)

`over_move` and `under_move` are tracked per row and filterable independently.

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

1. Drop Pinnacle export CSVs into `static/data/` (nested folders like `data/League/Season/file.csv` are supported).
2. Run `node build.js` to regenerate `manifest.json`.
3. Commit and push — Cloudflare auto-redeploys.

Required columns: AH Home/Away Closing+Opening, Home/Away Odds Closing+Opening, HT Result, FT Result. TL columns optional but needed for TL filtering. Column names accepted with spaces or underscores.

## Key Differences vs Python Desktop App

| Aspect | Desktop (`gamestate_gui.py`) | This (`static/app.js`) |
|---|---|---|
| Config Discovery bar | `MIN_Z = 1.5` | `MIN_Z_DISC = 2.0` |
| Bet set | 16 bets | 24 bets (adds FT markets, DNB, BTTS, totals) |
| Filter mode | Basic only | Basic + Advanced (per-signal toggles) |
| Level ball | Not supported | Supported (0.00 line, fav by odds) |
| Scrape auto-fill | Not available | `/api/scrape?url=` pre-fills all inputs |
| `traceConfig` | Not in desktop | Returns per-filter funnel counts |
| Value hunting | Not shown | Renders bets with no edge but fair min odds |
