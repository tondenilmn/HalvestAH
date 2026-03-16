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
# One-shot deploy (runs build.js automatically via wrangler)
node build.js && npx wrangler pages deploy static --project-name=<your-project>
```

Or connect the repo to Cloudflare Pages with build command `node build.js` and output directory `static`.

## File Structure

```
build.js                  # Scans static/data/*.csv → writes static/data/manifest.json
functions/
  api/
    scrape.js             # Cloudflare Pages Function: GET /api/scrape?url=<asianbetsoccer URL>
static/
  index.html              # App shell + PapaParse (embedded)
  app.js                  # All logic: CSV processing, engine, UI (~78 KB)
  style.css               # Dark theme
  data/
    manifest.json         # Auto-generated — do not edit by hand
    *.csv                 # Pinnacle export CSVs
```

## Architecture

Everything in the Python desktop app (`constants.py`, `data.py`, `engine.py`, `stats.py`, `live_odds.py`) is ported into `static/app.js` as a single file. The constants, `processRow`, `applyConfig`, `applyGameState`, `scoreBets`, `discover`, and `computeLiveOdd` functions are direct JS equivalents — keep them in sync if the Python logic changes.

`app.js` structure (top-down):
1. **Constants** — `LINE_THRESH`, `VALID_LINES`, `TL_CLUSTERS`, `ADV_TL_RANGES`, `BETS`, `COL_MAP`
2. **Data layer** — `normaliseRow`, `parseScore`, `oddsDir`, `moveDir`, `processRow`, `loadCsv`
3. **Stats** — `pct`, `zScore`, `wilsonCI`, `stability`, `minOdds`
4. **Engine** — `applyConfig`, `applyGameState`, `scoreBets`, `traceConfig`, `discover`
5. **Live odds** — `computeLiveOdd` (Poisson time-decay, 2H bets only)
6. **UI** — event handlers, `runMatch`, `runDisc`, render functions

## The Scrape Function (`functions/api/scrape.js`)

Accepts `GET /api/scrape?url=<asianbetsoccer.com/match?id=HEX>`. Strategy:

1. Extracts the `?id=` hex from the asianbetsoccer URL.
2. Fetches `https://botbot3.space/tables/v4/oddsComp/<id>.js` server-side (CORS bypass).
3. Parses `tablematch1` to find Pinnacle's bookmaker index (bookmaker names only appear there).
4. Parses `tablematch2`, splits groups by `<tr class='vrng'>` separator rows (same order as tablematch1), extracts the Pinnacle group.
5. Parses H/A rows **by TD cell position** (not CSS class — classes like `SU`/`SD`/`SN` vary per match).

Returns JSON with keys: `ah_hc`, `ah_ho`, `ho_c`, `ho_o`, `ao_c`, `ao_o`, `tl_c`, `tl_o`, `ov_c`, `ov_o`, `un_c`, `un_o` — mapped directly to app input fields.

**If the source HTML structure changes**, the positional offsets in `parseTds` (lines ~164–180) are what needs updating.

## CSV Workflow

1. Drop Pinnacle export CSVs into `static/data/`.
2. Run `node build.js` to regenerate `manifest.json`.
3. Commit and push — Cloudflare auto-redeploys.

Column names are accepted with spaces or underscores (e.g. `Home AH Closing` or `home_ah_closing`). Required: AH Home/Away Closing+Opening, Home/Away Odds Closing+Opening, HT Result, FT Result. TL columns optional but needed for TL filtering.

## Key Differences vs Python Desktop App

| Aspect | Desktop (`gamestate_gui.py`) | This (`static/app.js`) |
|---|---|---|
| Config Discovery bar | `MIN_Z = 1.5` | `MIN_Z_DISC = 2.0` (higher — sweeps ~18k combos) |
| Bet set | 16 bets (home/away absolute) | Includes `ahCover`, `favWins2H`, `draw2H` (fav-normalised bets) |
| Scrape auto-fill | Not available | `/api/scrape?url=` pre-fills all inputs from a match URL |
| `traceConfig` | Not in desktop | Returns per-filter funnel counts for diagnostics display |
