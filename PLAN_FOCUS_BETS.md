# Focus-Bets Plan — 1T/2T Over/Under 0.5 & 1.5

Execution plan for Claude Sonnet. Work phase by phase, commit after each phase, never skip the
acceptance check at the end of a phase. All new scripts live in `telegram/`, run with
`cd telegram && node <script>`. Never edit `static/data/manifest.json` by hand.

## Scope (the only 7 bets that matter)

| Key | Market | Playable when |
|---|---|---|
| `over05_1H` | Over 0.5 1st half | pre-kickoff or 1H live while 0-0 |
| `over15_1H` | Over 1.5 1st half | pre-kickoff or 1H live while 1H goals ≤ 1 |
| `under05_1H` | Under 0.5 1st half | pre-kickoff or 1H live while 0-0 |
| `over05_2H` | Over 0.5 2nd half | HT or 2H live while 2H goals = 0 |
| `over15_2H` | Over 1.5 2nd half | HT or 2H live while 2H goals ≤ 1 |
| `under05_2H` | Under 0.5 2nd half | HT or 2H live while 2H goals = 0 |
| `under15_2H` | Under 1.5 2nd half | HT or 2H live while 2H goals ≤ 1 |

Everything else (1X2, AH, BTTS, FT totals, 2H result, next-goal ladder) is **out of scope** for this
plan and should be hidden by default in the Live tab (Phase 6).

Existing building blocks to reuse — do NOT rewrite:
- Outcome computation: `telegram/engine.js` (`processRow`, `BETS`, `scoreBets`, `applyGameState`, `classifyLeague`, `wilsonCI`).
- Live decay model: `static/app.js` `computeLiveOdd` (2H keys) / `computeLive1HOdd` (1H keys); Node mirror `telegram/live_odds.js` (2H only — Phase 3 adds 1H).
- Cross-book loader: `telegram/backtest_crossbook.js` (Papa.parse + `processRow` + merge-by-match). Note it references `../Crossbooks` (wrong case) — fix to `../CrossBooks`.
- Live feed: `telegram/livescore.js` (`fetchLiveMatches`), `telegram/live_check.js` (HT-anchor persistence in `telegram/data/live_check_ht.json`).
- Web UI focus panel: `FOCUS_MARKET_BETS`, `renderFocusMarketsPanel`, `renderFocusMarketRow` in `static/app.js`.

Data: `CrossBooks/Bet365_Data_months/*.csv` and `CrossBooks/Sbobet_Data_months/*.csv` — identical 21-column
schema, same fixtures, 14 months (2025-01 … 2026-02). Sbobet covers fewer matches. Bet365 file set is the
"model" book (historical dataset is Bet365-priced); Sbobet is the sharper, lower-margin book.

**Walk-forward rule for every backtest in this plan:** train on months `< M`, test on month `M`, for each
of the last 8 months (2025-07 … 2026-02). Report per-month AND pooled. A finding "works" only if
≥ 6/8 months positive AND pooled ROI at the *real* book price > 0. Report hit rate, claimed-vs-realised
gap, ROI@fair, ROI@Bet365-closing-price, ROI@Sbobet-closing-price, n. Minimum n=100 per cell pooled.

---

## Phase 1 — Shared focus library (`telegram/focus_lib.js`)

Create one module used by every later script so nothing is duplicated.

1. `loadBook(book)` → rows from `../CrossBooks/${book}_Data_months/*.csv` through `engine.processRow`
   (copy the loader from `backtest_crossbook.js`, fix the path case). Attach `month = 'YYYY-MM'`, `book`.
2. `mergeBooks(b365Rows, sboRows)` → array of `{ b365, sbo }` pairs keyed by `date|home|away`
   (same key as `backtest_crossbook.js`). Keep unmatched Bet365 rows with `sbo: null`.
3. `FOCUS_KEYS` = the 7 keys above; `outcome(row, key)` — read from `row.bets[key]` if `processRow`
   already computed it, otherwise from HT/FT score (1H goals = HT total; 2H goals = FT − HT).
4. `bookOdds(row, key)` — the *real* market price for the bet. The CSVs carry only FT Over/Under at the
   closing TL, so:
   - There is **no direct historical price** for 1H/2H 0.5/1.5 lines. Derive a "market-implied" price:
     fit a Poisson total-goals λ from the closing TL + over/under odds (reuse `live_lambda_solver.js`
     `solveLambdaFromOdds`), split λ into halves using the calibrated share (1H share ≈ 0.44 — take it
     from `static/data/goal_timing_summary.json`, do not hardcode blindly), then
     `P(over05_1H) = 1 − e^{−λ1}`, `P(over15_1H) = 1 − e^{−λ1}(1+λ1)`, same for 2H with λ2, unders = complements.
     Convert to a price with a **6% margin** (Bet365 half-time O/U markets run ~6-8%; Sbobet ~4%).
   - Expose both `fairImplied` and `priced` (with margin). Every ROI must be reported at `priced`.
5. `walkForward(pairs, fn)` — helper implementing the walk-forward rule above.
6. `report(cells)` — prints table + writes JSON to `telegram/data/focus_<script>.json`.

Acceptance: `node focus_lib.js --selftest` prints row counts per book/month, the merged-pair count,
outcome base rates for the 7 keys, and the mean market-implied price per key (sanity: Over 0.5 1H
should land ≈ 1.25–1.35, Over 0.5 2H ≈ 1.20–1.30 for TL 2.5).

## Phase 2 — Configuration search: which match configs produce a profitable focus bet

`telegram/focus_config_search.js`. Grid over pre-match context (all from Bet365 closing unless stated):

- `fav_line` bucket: {0, 0.25, 0.5, 0.75, 1, 1.25, 1.5+} × `fav_side` {HOME, AWAY}
- `tl_band` (closing): `<2`, `2-2.5`, `2.5-3`, `>3` (reuse `TL_BANDS`)
- `tl_move`: IN / OUT / FLAT (±0.2 threshold, same as `backtest_crossbook.js`)
- `ou_move` (over odds closing vs opening): steam-to-over / steam-to-under / flat (±0.06)
- `tier`: TOP / MAJOR / OTHER (`classifyLeague`)
- For the four 2H keys additionally the **exact HT score state** (0-0, 1-0 fav, 0-1 dog, 1-1, 2+ total)

For each cell × focus key compute the Wilson CI lower bound `lo`, the market-implied price from
Phase 1, and `edge = lo − 1/priced`. Rank cells by edge × sqrt(n). Keep cells that pass the walk-forward
rule. Apply the winner's-curse guard: select on train fold, price on the *other* half of train
(`fold` field from `processRow`, see CLAUDE.md "Cross-Fit Bet Selection") — otherwise the top cells
will all be optimistic.

Deliverable: `telegram/data/focus_configs.json` — the surviving cells, each with
`{ key, filters, n, p, lo, impliedPrice, minPrice: 1/lo, roiAtPrice, monthsPositive }`, plus a
markdown summary appended to `BETTING_EDGE_ANALYSIS.md` under "## Focus bets (1T/2T O/U)".
Expect (from earlier research in CLAUDE.md): `under05_2H`/`under15_2H` edge concentrated in TL `<2` and
`2-2.5`; `over05_2H` in HT 0-0 with TL ≥ 2.5; `over05_1H` near TL `>3`. Confirm or refute — do not assume.

## Phase 3 — Live price from the model, for all 7 keys, in Node

1. Port `computeLive1HOdd` from `static/app.js` into `telegram/live_odds.js` (currently 2H only).
   Verify with a small fixture test that Node and browser output match to 4 dp for 10 random inputs
   (write the expected values by running the browser function in `node -e` after extracting it, or by
   copy of the constants — `_1H_INTENSITY`, `_IT_1H = 2.40`).
2. `telegram/focus_live_price.js` exporting `priceFocusBet({ key, anchorPct, minute, score, htScore, favSide })`
   → `{ live_p, live_lo, fair_odd, min_odd: 1/live_lo, note, alreadyDecided }`. `anchorPct` = the
   Phase-2 cell's `p`/`lo` (use `lo` for `min_odd`, `p` for `fair_odd`, matching `modelProbLine()` policy).
3. **Backtest the decay curve against real minutes**: `football-data/data/goals_time2` has goal minutes
   (used by `telegram/goal_timing.js`). For each of the 7 keys, simulate "bet placed at minute m
   (m ∈ {0,15,30 for 1H; 46,60,70,80 for 2H}) if nothing yet happened" and compare model `live_p` to
   realised frequency, bucketed by TL band. Report calibration table (claimed vs realised per minute
   bucket). If any bucket is off by > 3pp, add a per-key calibration multiplier table in
   `focus_live_price.js` (not in `computeLiveOdd` itself) and document it.

Acceptance: calibration table printed and saved to `telegram/data/focus_live_calibration.json`.

## Phase 4 — Cross-book check: follow the market or fade it?

`telegram/focus_crossbook.js`, using merged pairs from Phase 1. Questions to answer with numbers
(walk-forward, all 7 keys, at the market-implied price):

1. **Direction of movement** — Bet365 TL/over-odds moved toward Over vs toward Under between opening and
   closing: does following (bet Over when steamed to Over) or fading beat flat? Test both books' moves.
2. **Book disagreement** — Sbobet closing TL ≠ Bet365 closing TL, or over-odds gap ≥ 0.06: when the
   sharper book (Sbobet) is *higher* on total goals than Bet365, do the over-family keys win more?
   Hypothesis: Sbobet's closing is the better estimator; Bet365's stale/soft side is where the edge is.
3. **Open→close style** — Sbobet moves lines, Bet365 moves prices (the "two different ways to adjust").
   Quantify: share of fixtures where each book changed TL vs changed odds only; then test whether a
   Bet365 *price-only* move (TL unchanged, over odds shortened) predicts 1H/2H overs better than a
   Sbobet *line* move.
4. **Consensus** — both books moved the same way vs they diverged.

Output: `telegram/data/focus_crossbook.json` + a 10-line verdict in `BETTING_EDGE_ANALYSIS.md`:
for each key, "follow", "fade" or "no signal", with the month-consistency count. Feed any surviving
signal back into the Phase 2 filters as an extra optional dimension (`market_agree`, `sbo_gap`).

## Phase 5 — Selection & staking policy (pre-match, HT, in-play) — `telegram/focus_select.js`

Encode the rules that turn a live match into a recommendation. Keep them data-driven from
`focus_configs.json`; no hardcoded thresholds outside `config.js` (`FOCUS_*` keys).

1. **Match funnel per scan cycle** (`fetchLiveMatches`): tier filter → find the matching Phase-2 cell for
   each of the 7 keys → drop keys already decided (`liveModelAlreadyHappened` logic) → price with Phase 3
   → keep if `min_odd ≤ best available price` (Bet365 live via `apifootball.js` `overTL`/`underTL` for the
   *half* markets is not supported — so use the model price as the target and print it; the user
   compares manually. Add `over05_1H` etc. to `apifootball.js` only if the API exposes "Goals Over/Under
   First Half" — check the market list once, cache the id).
2. **Timing windows** (windowed like LATEGOAL, never single minutes):
   - 1H overs: pre-kickoff (best price) or 15'–25' while 0-0 (price has drifted, model says pace still fine).
   - 1H under 0.5: pre-kickoff only if cell edge exists; never in-play (bad price + no way to exit).
   - 2H overs: at HT (44'–50' snapshot window, price stable) and a second chance at 60'–72' while no 2H goal (LATEGOAL analogue).
   - 2H unders: at HT only (QUIET2H analogue).
3. **Staking**: fractional Kelly ¼ on `live_lo` (never on `p`), capped at 2% bankroll, halve stake when the
   cell's n < 300 or when the match tier is OTHER. Print the stake line in every recommendation.
4. **Price advice line**: `target = fair_odd`, `min = min_odd`, `walk-away = min_odd × 0.97`. Show all three.
5. Output for each recommendation the same object the web UI and Telegram will consume:
   `{ matchId, home, away, league, minute, score, key, label, window, p, lo, fair_odd, min_odd, stake_pct, cellId, reasons[] }`.
6. Wire into `notify.js` as strategy **FOCUS** (`FOCUS_ENABLED` in `config.js`, default true; dedup key
   `matchId:key:window`), reusing `modelProbLine()`, `kellyLine()`, `track_record.js` logging. Leave
   L123/LATEGOAL/QUIET2H untouched; they can be disabled via existing flags.

Acceptance: `node focus_select.js --once` prints recommendations for currently live matches;
`node notify.js --once` sends at most one FOCUS message per match/key/window.

## Phase 6 — Exchange strategies (Betfair/Smarkets) — `telegram/focus_exchange.js` + doc section

Add a "## Exchange playbook" section to `BETTING_EDGE_ANALYSIS.md` and a helper that, given a Phase-5
recommendation, prints the exchange plan. Markets: *First Half Goals 0.5/1.5*, *Second Half Goals* is
not always listed — fall back to *Over/Under X.5 Goals FT* where X = current total (the
`equivalentRealMarket()` trick already in `notify.js`). Commission from `#live-exchange-commission` /
`FOCUS_EXCHANGE_COMMISSION` (default 2%).

Strategies to implement as calculators (inputs: back price, lay price now, model curve from Phase 3):

1. **Time-decay lay (unders)** — lay Over 0.5 2H at HT when the cell says quiet; the Over price drifts up
   every minute without a goal. Compute the *green-up minute*: earliest minute at which backing Over at
   the model-projected price locks ≥ X% of the lay stake in profit on both outcomes. Show the
   projected P&L ladder per 5 minutes.
2. **Back-then-lay on overs ("split")** — back Over 0.5 1H pre-kickoff at the exchange, place a lay order
   at a lower price that fills only after a goal (or auto-cash-out). The calculator prints the lay stake
   for equal green and for "free bet" (stake back, keep upside).
3. **Ladder entry** — instead of one back at HT for Over 0.5 2H, split the stake 50/25/25 at HT / 60' /
   70' (only if still 0-0 in 2H) at model-derived prices; expected price improvement vs single entry is
   computed from the Phase 3 curve. Show expected ROI at each rung and the combined figure.
4. **Book vs exchange arbitrage of the model**: when Bet365 (soft) offers ≥ `min_odd` AND the exchange
   lay price on the same market is below `fair_odd × (1 − commission)`, print the "back soft / lay
   exchange" pair with guaranteed-profit stake. Rare but worth printing.
5. **Exit rule**: for every open exchange position print the minute after which the model's `live_lo`
   drops below 1/current lay price — that is the "cut" minute; never hold an Over past it.

Acceptance: `node focus_exchange.js --demo` prints all five calculators for a fixed sample input, and
Phase-5 recommendations get an `exchange` sub-object.

## Phase 7 — Live tab UI cleanup (`static/index.html`, `static/app.js`, `static/style.css`)

Goal: the Live tab shows **only** the focus bets by default, with everything else behind one
"Advanced" toggle. No behaviour removed — just hidden.

1. Left panel (`#tab-live-controls`): keep, in this order —
   status line, "Refresh" + auto-refresh, tier buttons, one **Mode** segmented control
   `Focus (1T/2T O/U)` | `All markets`. Move `#live-new-model-toggle`, `#live-model-focus-toggle`,
   `#live-exchange-commission`, the 14-checkbox market filter `<details>` and every explanatory `<p>`
   into a collapsed `<details id="live-advanced">` labelled "⚙️ Advanced". Delete the duplicated
   explanatory paragraphs; keep a single tooltip (`title=`) per control.
2. Focus mode match card (`renderLiveMatchCard`): one row per match — teams, minute, score, HT score,
   TL, and up to 3 focus chips `Over 0.5 2H · 78% · fair 1.28 · min 1.36 · ✔ cell n=412`. Chip colour =
   edge tier (green: price ≥ min_odd, yellow: below min, grey: already decided/not playable). Hide
   the model ladder and TOP PICK/VALUE HUNT in focus mode.
3. Match modal (`openLiveMatchDetail`): in focus mode show, in order — (a) the 7-key table
   (key, playable?, historical p/lo/n, cell filters, live p, fair, min, stake ¼-Kelly, window),
   (b) the price-advice line, (c) exchange plan from Phase 6 (ported calculators, small), (d) a
   `<details>` "Everything else" containing the current sections 3–7 unchanged.
4. Sort matches by best focus edge (`(live_lo − 1/impliedPrice) × sqrt(n)`); put a
   "🏆 BEST FOCUS BET" banner on top reusing `renderMergedBetCard` with rank namespace `'live-top'`.
5. Persist mode + advanced open/closed in `localStorage['halvest_live_ui']` (wrap in try/catch).
6. Mobile: cards must not overflow at 360 px; chips wrap.

Acceptance: `npx wrangler pages dev static --port 8788`, open Live tab — in Focus mode the left panel
has ≤ 6 visible controls and each match card fits in one row on desktop; All-markets mode is
pixel-identical to today. Then `node build.js` and commit.

## Phase 8 — Close the loop

- `track_record.js`: log FOCUS alerts (`verifiedGoodPrice()` applies) and settle 1H/2H keys from
  HT/FT scores (api-football gives HT score — no new market support needed).
- Daily scorecard section "FOCUS" with hit rate, ROI@alert price, per key.
- After 4 weeks of live data, re-run Phase 2 including the live results and compare live vs backtest
  calibration; record the result in `BETTING_EDGE_ANALYSIS.md`.
- Update `CLAUDE.md`: new files, `FOCUS_*` config table, Live tab modes.

---

## Order & effort

| Phase | Est. | Depends on |
|---|---|---|
| 1 lib | 2 h | – |
| 2 config search | 3 h | 1 |
| 3 live price + calibration | 3 h | 1 |
| 4 cross-book | 3 h | 1, 2 |
| 5 selection + notify | 3 h | 2, 3, 4 |
| 6 exchange | 2 h | 3, 5 |
| 7 UI | 4 h | 5, 6 (can start after 3 with mock data) |
| 8 loop | 2 h | 5 |

Guard-rails for Sonnet: no new npm deps; keep `engine.js` ↔ `app.js` in sync if any constant changes;
every number quoted in docs must come from a script output saved under `telegram/data/`; if a
phase's acceptance fails, report it and stop instead of tuning thresholds until it passes.
