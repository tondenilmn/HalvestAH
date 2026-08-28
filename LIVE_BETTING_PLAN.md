# Live Betting — Audit & Implementation Plan

Written 2026-08-28. Target: implement phase by phase with Sonnet. Each task lists the files to touch and a
verifiable acceptance criterion. Read `CLAUDE.md` first (sections "Live Games Tab", "Live 2H Time-Decay Odds",
"Cross-Fit Bet Selection", "Strategy LATEGOAL/QUIET2H").

---

## Part A — Audit: is the live section built on sound math?

### A.1 What is sound (keep)

| Component | Where | Verdict |
|---|---|---|
| Intra-half goal-intensity curves `_1H_INTENSITY`/`_2H_INTENSITY`, stoppage mass `_IT_1H`/`_IT_2H` | `static/app.js:2239-2258` | Empirically calibrated from `goals_time2` (27k goals). Correct. |
| Wilson CI lower bound (`lo`) as the pricing/Kelly probability | `app.js:1304`, `calcKellyStake:1328` | Correct antidote to winner's-curse. |
| Cross-fit fold split for selection vs. pricing | `crossFitBets`, `mergeCrossFit` | Walk-forward validated; the single most important guard in the codebase. |
| HT-state conditioning (`applyGameState({trigger:'HT'})`) as the anchor for 2H bets | `analyzeLiveMatch:4336` | Correct: the historical pool is re-cut on the actual HT score. |
| Bivariate independent Poisson for 2H result markets (`computeLiveResult2H`) | `app.js:2585` | Standard (Maher/Dixon-Coles without the ρ correction). Acceptable baseline. |
| Poisson inversion `λ = −ln(1−p)` for k=1 events | `app.js:2439` | Exact for a homogeneous Poisson; fine as first-order. |

### A.2 Genuine bugs (fix first — Phase 0)

These make numbers shown in the Live Games tab wrong today, independent of any modelling debate.

1. **Live edge compares a decayed probability with an undecayed baseline.** `edge = p_live − bl_fullhalf`
   (`buildLiveAdjustedBet`, `app.js:2685/2707/2729` and 1H twins). As the clock runs, every live bet's edge drifts
   negative from time alone; `qualifiesBet` (`app.js:32`) uses `(lo − bl) ≥ 0`, so late-match bets get
   structurally disqualified — and the UI prints "−X pp vs baseline" that means nothing.
2. **`z`, `n`, `hi` are stale on live bets** (carried by `...anchorBet`). Ranking `z·lo/100` multiplies a historical
   z by a live `lo`. The CI line can print `hi < p`.
3. **`_pricedFold` short-circuits `qualifiesBet` to `true`** for every cross-fit live bet (`app.js:31`), so a bet whose
   live `p` decayed to ~0 still shows as "✓ QUALIFIES".
4. **1H live branch fires in the 2nd half** when no HT anchor was captured (`app.js:4301` has no minute guard):
   minute 70 → `computeLive1HOdd` with elapsed clamped to 45 and the FT score treated as a 1H score.
5. **Stoppage time never decays and minute is frozen at 90** (`parseLiveMinute` drops `+N`; `elapsed2h=min(45,…)`).
   At 90+6' the model still gives 12.3% of the half's goal mass.
6. **Result markets never become "already decided"** (`computeLiveResult2H` has no `alreadyDecided`), so
   `draw2H` at 0-0 with 30 seconds left shows <100%.
7. **`lo` propagation is invalid for bivariate/BTTS markets**: lowering both anchors together is not a lower bound
   for `favWins2H`/`draw2H` (lowering the dog's λ *raises* fav-win). `Math.min(p, loRes)` then collapses `lo` to `p`,
   removing all conservatism exactly where the model is weakest.
8. **`_LINE_STRENGTH_MOD` double counts the line**: the anchor pool is already filtered on `fav_line`; multiplying λ
   again (×0.92 … ×1.18) is a systematic bias. Applied to fav λ only in bivariate, to any bet in univariate — inconsistent.
9. **`bayMod = 1 − (elapsed/45)·0.05`** (`app.js:2468`) is undocumented, unsourced, unconditional. Remove or derive.
10. **`mo_lo` is never recomputed on live bets** (stale from anchor). `favLine=0` falls back to 0.75 (`parseFloat(x)||0.75`).
11. `telegram/live_odds.js` lacks the `alreadyDecided` flag → Telegram can price a "100% / 1.01" bet.

### A.3 Structural weaknesses (addressed by the new model — Phase 1)

- **Over-dispersion.** The anchor hit rate is a *mixture* over many matches; a single Poisson λ matched to `P(X≥1)`
  understates `P(X≥2)` and makes `over05_2H` and `over15_2H` mutually inconsistent on the same match.
- **Goals already scored are used only to reduce `need`, never to update λ.** A half with 3 goals already is evidence
  of a high-λ match; the model ignores it (Bayesian gamma-Poisson fixes this exactly — see B.2).
- **Score-state tables** (`_FAV_SCORE_MOD`/`_DOG_SCORE_MOD`) are HT-margin → rest-of-2H, applied to live in-2H margin,
  and the trailing-favourite entries contradict what `goals_time2` measured. Held fixed across the whole 11×11
  enumeration grid (no path dependence).
- **Home/away goal independence** in BTTS (product of marginals) and result markets.
- **No real in-play price exists anywhere in the web UI.** `bet.mo` labelled "min odds" is the fair odds `100/p` with
  zero margin. The feed odds (`ah_hc, ho_c, tl_c …`) are the *closing* pre-match Bet365 line, used only as a signal
  pattern. The only in-play prices in the system are api-football `/odds/live` calls in the Telegram bot (100/day budget).

**Overall verdict:** the *selection* layer (historical pool + HT state + cross-fit + Wilson) is statistically
well-founded and validated. The *live time-decay* layer is a reasonable first draft with correct timing shape but
wrong plumbing (A.2) and an under-specified probability model (A.3). It should not be used to size real stakes at
minute > ~70 until Phase 0 and Phase 1 land.

---

## Part B — What `goals_time2` (+ `elo.parquet`) lets us build

### B.1 Data facts

- `football-data/data/goals_time2/`: 202 JSON files, 12 domestic leagues, **65,143 matches, 147,377 goals
  (+4,646 own goals as a separate `incident_type` — `goal_timing.js` currently drops them: fix)**. Minute strings
  `"73'"`, `"45+2'"`, `"90+3'"`; running `home_score`/`away_score` per goal; date + team slugs; **no odds, no match id**.
- Existing summary (`goal_timing_summary.json`) uses only 3 seasons and 6 buckets; the rest is unused.
- `football-data/data/elo/elo.parquet` + `team_dictionary_men.csv` (`team_slug` in goals_time2 style): pre-match
  Elo → a favourite/strength proxy for **all 25 seasons**, closing the "no favourite designation" gap.
- Overlap with `static/data/Bet365/*.csv` (real AH lines): only 2025-01-01 → 2025-05-25 (~2-2.5k matches). Enough to
  **validate** the Elo→line mapping and the model's calibration against real odds; not enough to fit a table.

### B.2 The model to build: state-conditioned hazard + gamma-Poisson

Replace "invert one hit rate into a homogeneous λ" with a **scale × shape** decomposition:

```text
λ_side(t → end | state)  =  A_side · ∫_t^{end} h(u | state) du
```

- **Shape `h(u | state)`** — empirical per-minute goal hazard from `goals_time2`, conditioned on
  `state = (half, minute-bucket [5 min], total goals so far {0,1,2,3+}, margin from that side's view {≤−2,−1,0,+1,≥+2},
  strength tercile via Elo diff)`. Include stoppage time as its own minute (46..50 for 1H, 91..98 for 2H), so
  `parseLiveMinute` must keep `+N`. Aggregate cells below n=300 goals up to the parent (drop Elo tercile, then margin).
- **Scale `A_side`** — from the Bet365 historical pool exactly as today (signal cfg + HT state), solved so that the
  model's whole-half probability matches the pool's `bet.p` (and `bet.lo`) at the anchor minute. This keeps the
  validated cross-fit selection numbers as the anchor while `goals_time2` provides only the *timing/state shape*
  (which is where its 65k matches beat the 240k-row odds dataset that has no minutes).
- **Over-dispersion / in-half learning** — model λ ~ Gamma(α, β) so the remaining count is Negative-Binomial and
  goals already scored update the posterior: `α' = α + goals_so_far, β' = β + elapsed_mass`. Fit α (the dispersion)
  once per (league tier, half) from `goals_time2` by maximum likelihood on half-goal counts. This single change
  makes `over05_2H`/`over15_2H` consistent and fixes the "3 goals already → λ should rise" blind spot.
- **Result markets** — keep the bivariate enumeration but (a) draw each side's remaining λ from the state-conditioned
  hazard integrated *per cell path* is overkill; instead use the current-state hazard (as now) plus a
  Dixon-Coles-style low-score correction ρ fitted on `goals_time2` half-scores. (b) Compute the CI for these markets
  by **Monte-Carlo over the anchors' Wilson intervals** (sample favP, dogP independently 500×, take the 5th
  percentile of the target probability) instead of "run once at both `lo`s".
- **Own goals** count as goals for the scoring side (they settle that way).

### B.3 Validation protocol (must pass before UI wiring)

1. Walk-forward by season: fit on ≤ season S−1, test on S, for the last 5 seasons.
2. For every test match and every minute m ∈ {46, 50, …, 90}, every state, compute the model's
   `P(≥1 goal in remainder)`, `P(≥2)`, `P(home scores)`, `P(draw at FT)` etc. Report **reliability tables**
   (predicted-bucket vs realised), Brier and log-loss, versus two baselines: (i) the current `computeLiveOdd`,
   (ii) a flat-hazard Poisson. Acceptance: new model ≥ both baselines on log-loss in every minute bucket, and
   max reliability gap ≤ 2 pp in cells with n ≥ 500.
3. On the 2025 overlap join (Bet365 × goals_time2, join on date + slugified team + FT score check), compare the
   Elo-tercile proxy with the real `fav_line` bucket (confusion matrix), and check calibration of the full pipeline
   against Bet365 *closing* Over/Under prices at kickoff (de-vigged) as an external sanity check.

---

## Part C — Implementation phases (Sonnet-ready tasks)

### Phase 0 — Fix the plumbing bugs (1 day)

| # | Task | Files | Acceptance |
|---|---|---|---|
| 0.1 | Recompute `bl` for live bets: decay the baseline with the same function (`computeLiveOdd(bl, …)`), so `edge = p_live − bl_live`. Do the same for `hi`. Drop `z` display for live bets or recompute as `(p_live−bl_live)/se` with the anchor's `n`. | `app.js buildLiveAdjustedBet/buildLive1HAdjustedBet` | Edge of an unscored-yet over bet at min 46 ≈ its HT edge; at min 89 edge magnitude shrinks toward 0, never sign-flips from time alone. Unit test. |
| 0.2 | `qualifiesBet` must not short-circuit on `_pricedFold` for `_liveDecayed` bets; require `lo_live − bl_live ≥ MIN_EDGE` and `p_live ≥ 5%`. | `app.js:24-33` | A decayed bet at 2% never shows "✓ QUALIFIES". |
| 0.3 | Guard the 1H branch with `minute < 45`; matches at minute > 50 without anchor get `anchorStatus:'unknown'` and **no** live column. | `app.js:4301` | Manual test with a synthetic match at minute 70, no anchor. |
| 0.4 | Keep stoppage minute: `parseLiveMinute('90+4') → 94`, `'45+2' → 47`. In `computeLiveOdd`, elapsed mass in stoppage = `itRate × min(N, IT)` consumed; at ≥ 90+IT remaining mass → 0. | `app.js:4190, 2452-2466`, `telegram/live_odds.js` | live_p strictly decreasing across 88', 90', 90+3', 90+6'. |
| 0.5 | `computeLiveResult2H/1H`: return `alreadyDecided` when remaining mass < ε and the outcome is fixed; drop from lists like other markets. Mirror in `live_odds.js` (add the flag there too). | both files | `draw2H` at 0-0, 90+7' → decided. |
| 0.6 | Remove `_LINE_STRENGTH_MOD` from λ when the anchor pool was already line-filtered (always, in Live Games). Remove `bayMod`. | `app.js:2442-2444, 2468`, `live_odds.js` | Re-run `telegram/backtest_live_ui_split_sample.js`: ROI must not degrade (document numbers in commit). |
| 0.7 | Recompute `mo_lo`/`mo_mid` on live bets; fix the `parseFloat(favLine)`-or-0.75 fallback so a line of 0 is kept (use nullish check). | `app.js:2670,2806` | Level-ball match uses line 0. |
| 0.8 | CI for bivariate/BTTS via Monte-Carlo over anchor Wilson intervals (500 samples, 5th pct). | `app.js`, `live_odds.js` | `lo ≤ p` always and `lo < p` whenever `n < 5000`. |

### Phase 1 — Goal-hazard model from `goals_time2` (3-4 days)

| # | Task | Files | Acceptance |
|---|---|---|---|
| 1.1 | Loader: parse all 202 files, keep `Goal` **and** `Own goal`, parse minute to `{half, minuteInHalf, stoppage}`, running score, date, slugs. Join Elo (`elo.parquet` — read via `parquetjs`/`duckdb` npm; if awkward, one-off export to CSV with Python). | new `telegram/goal_model/load.js` | 65,143 matches; goal count 152,023 ± own-goal dedup; Elo join rate ≥ 95%. |
| 1.2 | Hazard tables: per state cell, `goals / exposure-minutes`, with hierarchical fallback. Export to `static/data/goal_hazard.json` (< 300 KB). | `telegram/goal_model/build_hazard.js` | JSON has n per cell; Phase B.3 step 2 reliability report saved to `telegram/goal_model/reports/`. |
| 1.3 | Gamma-Poisson dispersion fit per (tier, half). | `telegram/goal_model/fit_dispersion.js` | α reported with CI; NB log-lik > Poisson log-lik. |
| 1.4 | New engine `liveGoalModel.js` (shared code, ES-module-free so it can be pasted into `app.js` and required from Node): `remainingProb(bet, anchorP, state, minute) → {p, lo}`; replaces `computeLiveOdd`, `computeLive1HOdd`, result & BTTS functions behind the same call signatures. | `static/app.js`, `telegram/live_odds.js` | Byte-identical outputs between browser and Node copy (existing parity test pattern). |
| 1.5 | Walk-forward validation script (B.3) with reliability tables and Brier/log-loss vs. old model. | `telegram/goal_model/validate.js` | Acceptance thresholds in B.3. |
| 1.6 | Overlap join Bet365×goals_time2 (2025-01→05) + Elo-tercile vs `fav_line` confusion matrix + calibration vs closing O/U. | `telegram/goal_model/validate_odds_overlap.js` | Report committed. |

### Phase 2 — Prices, not just probabilities (2 days)

The UI cannot tell you whether a bet is *value* without a price. Three sources, in order of cost:

| # | Task | Files | Acceptance |
|---|---|---|---|
| 2.1 | Per-bet **"Your odds"** input already exists (Kelly widget). Show three numbers on every live card: **fair** (`100/p`), **min back** (`100/lo`), and **max lay** (`100/hi_live`). Rename the "min odds" label (it is fair odds). | `renderBetPickBlock`, `buildBetCol` | Labels correct; tooltip explains each. |
| 2.2 | Optional api-football `/odds/live` fetch on **click** of a live match (never on the poll loop), budgeted through `api_budget.js`; display market price next to fair. Map equivalents exactly as `equivalentRealMarket()` does. | new `functions/api/liveodds.js`, `app.js openLiveMatchDetail` | One click = ≤ 2 API calls. |
| 2.3 | Exchange mode toggle: commission `c` (default 2% Betfair/ 5% others) folded into edge: back EV `= p(o−1)(1−c) − (1−p)`; lay EV `= (1−p)(1−c) − p(o−1)`. Kelly on commission-adjusted odds `o' = 1 + (o−1)(1−c)`. | `calcKellyStake`, widget | Edge shown changes when toggle flips. |

### Phase 3 — Strategies (what to actually bet)

All strategies below reuse the validated selection layer; the new model only prices timing/state. Every alert/pick
goes through `track_record.js`-style logging with the price at bet time — no strategy is "live" until it has
≥ 200 logged bets and a positive CI-lower ROI.

#### 3A Soft bookmaker ("bet and forget")

Bet365 in-play limits stake sizes and prices in a ~6-8% overround; you win only on selection edge, and you must
beat closing-line-equivalent in-play prices. Rules:

1. **Entry windows fixed by strategy, not by "it looks good now"** (scan-cycle discipline, as LATEGOAL does):
   - **HT window (44'-50')** — pool: signal cfg + HT state. Markets: Over/Under FT total (from `over05_2H`/
     `under05_2H`/`under15_2H` equivalents), BTTS when one side already scored, 2H result via 1X2-2H if offered.
     Rationale: HT is the moment the in-play price is most stable and the historical anchor is exact.
   - **LATEGOAL window (68'-72')** — keep as is but price it with the new hazard model (state = total 0/1/2, margin).
   - **QUIET2H at HT** — keep.
   - **New: "goal-then-reprice" (55'-65')** — after the *first* 2H goal, pool = HT state + who scored; bet the
     side-scored markets that the Elo/state hazard says are still under-priced (soft books over-react to the goal).
     Validate first (Phase 1.5 gives the numbers).
2. **Price gate:** only bet if `offered ≥ mo_lo` (odds at Wilson-lower live probability). No exceptions.
3. **Stake:** half-Kelly on `lo`, capped at 2% bankroll, ≤ 3 open bets per match window. Flat 1u if `n < 60`.
4. **Never chase after the window** — a missed scan is a missed bet.
5. Log every bet with `price, fair, lo, minute, state` → `track_record.js` settles and reports ROI@price weekly.

#### 3B Betting exchange (Betfair/Smarkets/Matchbook)

Advantages: no limits, near-zero overround, ability to *lay* and to *trade out*. Costs: commission, liquidity
(only TOP tier + big MAJOR matches have deep in-play books), and 5-8s bet delay. Three concrete strategies:

1. **Back at your price with a limit order (value backing).** Place the back at `max(fair·(1+m), mo_lo)` where
   `m` = required margin (start 4%); leave it unmatched for the strategy's window, cancel at window end.
   In-play prices oscillate around fair; fills come from the market's own noise. EV per matched unit
   `= p·(o−1)(1−c) − (1−p)`. Only when the pool's `lo` clears the price after commission.
2. **Lay the low-probability side of a qualifying signal.** Where the model says `under05_2H` (no more goals) is
   *over*-priced (e.g. HT 0-0 with TL ≥ 3 and a strong-fav hazard), **lay Under 0.5 goals**/"0-0 correct score" at
   HT. Lay liability is `stake·(o−1)`; EV `= (1−p)(1−c) − p(o−1)`. Kelly for a lay: `f = ((1−p)(1−c) − p(o−1)) / (o−1)`.
   Use the new model's `hi` (upper CI) for `p` here — conservative on the lay side.
3. **Time-decay trading ("green up on the goal").** Back Over X.5 (or lay Under) at HT when the hazard model's
   next-15-minute goal probability is high; if a goal arrives, the Over price collapses — lay it back to lock a
   guaranteed profit; if no goal by minute ~65, exit at a small loss. Quantify with the model:
   `E[profit] = P(goal by t₁)·G − (1−P)·L` where `G/L` come from the price ladder; only enter when the
   modelled `P(goal by 60')` > breakeven `L/(G+L)`. The hazard tables give `P(goal in [46, t₁] | state)` directly —
   this is the strategy the `goals_time2` data is uniquely suited for.
   Same shape in reverse for QUIET2H: **lay Over 2.5 at HT** in low-TL matches, exit at ~70' when the price has
   drifted out or on a goal (stop-loss).
4. Exchange hygiene: pre-defined stop-loss on every trade, no adding to losers, stake ≤ 1% bankroll liability per
   trade, use "keep" bets only if you accept the pre-off→in-play transition risk, watch for suspended markets on goal
   (orders cancelled → re-place).

#### 3C Which information to use where

| Info | Best use |
|---|---|
| Opening odds (Layer 1) | Pre-match only; keep for L123. Weak in-play once the HT state is known. |
| Odds movement (Layer 2) | Signal cfg for the pool (`buildCfgFromLiveOdds`) — this is the historical-pool key, keep. |
| Closing odds (Layer 3) | Sets the **scale** `A_side` of the goal model (expected goals via TL and AH line). |
| HT score | The strongest single in-play conditioner — always in the pool key. |
| Minute + score since HT | Goes to the hazard model *shape* and gamma-Poisson update — never to the pool key (too sparse). |
| Elo diff | Fallback strength proxy where `fav_line` is absent (validation only, in production the line exists). |

### Phase 4 — Telegram parity & tracking (1 day)

- Mirror the new model into `telegram/live_odds.js` (same-file copy, parity test).
- Add the exchange-mode lines (`lay price ≤ …`, commission-adjusted Kelly) to `kellyLine()`.
- Extend `track_record.js` entries with `minute, state, strategy, venue(soft|exchange)`; digest ROI split by venue and
  minute bucket. Re-enable `APIFOOTBALL_SETTLEMENT_BUDGET` (e.g. 20) so the loop actually closes.

---

## Part D — Order of work & decision gates

1. Phase 0 (bugs) → ship; re-run `backtest_live_ui_split_sample.js`.
2. Phase 1.1-1.3, 1.5 (model + validation) → **gate: passes B.3**; else keep old decay and only ship Phase 0.
3. Phase 1.4, 2 (wire model + prices).
4. Phase 3A soft-book strategies in **paper mode** via `track_record.js` for ≥ 200 bets; then real stakes.
5. Phase 3B exchange strategies: start with (1) value backing; (3) trading only after the hazard model's
   next-15-min probabilities validate (B.3 step 2 includes `P(goal in [m, m+15])`).

Things deliberately **not** in scope: 1X2 in-play (feed has no 1X2), corner/card markets (data exists in
`goals_time2` — cards/subs — possible future extension), leagues outside the 12 (`goals_time2` hazard shape is
pooled and cross-league SD is small, so pooled shape + Bet365 scale is acceptable there, flagged as lower confidence).

---

## Part E — Clean-slate alternative: one market-implied joint model (recommended route)

Parts A-D patch the existing bucket-hit-rate approach. This part designs live betting from scratch around what the
data actually supports, and it is the route I recommend if you are willing to build new code rather than extend
`scoreBets`.

### E.1 Why change the paradigm

The current system answers 32 separate questions ("how often did `over05_2H` hit in matches like this?") from
32 separate bucket counts. That has three costs that no amount of patching removes:

1. **Incoherence** — the 32 numbers come from different cells and can contradict each other
   (`P(over15_2H) > P(over05_2H)` is possible). A book prices every market from *one* score distribution.
2. **Multiple comparisons** — sweeping cells × bets is the winner's-curse machine that cross-fit only half-fixes.
3. **Coverage** — cells go thin fast; the moment you condition on minute or on a red card there is no data left.

A parametric joint model has none of these: two rates (λ_home, λ_away) + a dependence term give the probability of
*every* market a book offers, in-play at any minute, from one place. The historical dataset is then used to fit a
handful of coefficients, not thousands of cells.

### E.2 What each dataset contributes (nothing else is needed)

| Dataset | Rows | Gives |
|---|---|---|
| `static/data/Bet365/*.csv` (2025-01 → 2026-07) | ~240k | Opening+closing 1X2, AH line/prices, TL, O/U prices, HT & FT scores → **market-implied λ per match** and the residual study (E.4). Also HT score = one in-play observation per match. |
| `football-data/data/goals_time2` (2000 → 2025-05) | 65k matches, 152k goals incl. own goals, plus **red cards (8.3k)**, penalties, subs | Minute-level **hazard shape** by state, dispersion, red-card & penalty multipliers. |
| `football-data/data/elo/elo.parquet` | — | Pre-match strength for goals_time2 matches (no odds there) → lets the hazard tables be conditioned on "favourite vs dog" for all 25 seasons. |
| 2025-01 → 2025-05 overlap of the first two | ~2.5k matches | Validation bridge: real λ_market next to real goal minutes. |

### E.3 The model

**Step 1 — market-implied rates (pre-match).** For each match solve for `(λ_h, λ_a, ρ)` so that a Dixon-Coles
bivariate Poisson reproduces the de-vigged closing **1X2** (3 probabilities) and the de-vigged **Over/Under at the TL**
(1 probability); the AH price is a 5th observation used as a check. De-vig with the power method (not proportional —
favourite-longshot bias). Result: two numbers per match that already encode everything the market knows, including
the opening→closing movement. Do the same for the *opening* prices to get `(λ_h⁰, λ_a⁰)`.

**Step 2 — residual model (does anything beat the market?).** Fit, with month-wise walk-forward on the 240k rows,
a regularised Poisson regression for actual goals per side:

```text
log E[goals_side] = log λ_side(closing)
                    + β1·(log λ_side(closing) − log λ_side(opening))   # movement
                    + β2·tier + β3·(AH line moved) + β4·(TL moved) + …
```

Report every β with a CI. **This one regression replaces the L123 layer machinery** and answers, with proper
uncertainty, whether opening odds/movement carry information beyond the closing line. Expected outcome from the
literature: β ≈ 0 for TOP leagues, small positive movement effect in lower tiers. Whatever survives becomes a
multiplier on λ; whatever does not is dropped. Separately fit the **half split**: `λ_side,1H = s·λ_side` with `s`
estimated from HT scores (books price FT; the 1H/2H split is where they are least careful — check tier by tier).

**Step 3 — in-play propagation (the goals_time2 part).**

```text
λ_side(t→end) = λ_side · S(state) · ∫_t^end h(u) du / ∫_0^90 h(u) du
```

- `h(u)`: per-minute hazard (stoppage minutes explicit) from goals_time2.
- `S(state)`: multiplicative state effects fitted by Poisson regression on goals_time2 with exposure = minutes:
  margin from that side's view, total goals so far, **men on pitch** (red cards — the one strong in-play effect books
  handle crudely; goals_time2 has 8.3k of them, ~1 per 8 matches), Elo/λ tercile, half, minute bucket. Fitted as
  coefficients, not cells, so sparsity is not a problem.
- **Gamma-Poisson update**: λ_side ~ Gamma(α, α/λ̂). Goals observed so far update it; the remaining-goal distribution
  is negative-binomial. α per (tier, half) by ML. This is what makes "3 goals by 60′" raise the expectation instead
  of ignoring it.
- Dependence `ρ` for low scores (Dixon-Coles) kept from Step 1.

**Step 4 — price every market from the joint distribution.** FT 1X2, any O/U line, any AH line (quarter lines via
the split rule), BTTS, 2H/1H results and totals, next goal (= competing hazards, direct from Step 3), correct score,
HT/FT. One function `priceMarket(marketSpec, state, minute) → {p, ci}`; CI by sampling the λ posterior (α, β) and the
residual β's — a real interval on *every* market, replacing the "run it twice at `lo`" trick.

### E.4 Where the edge comes from (be honest about it)

The closing line is efficient pre-match; a model built *from* it cannot beat it pre-match. The edge in live betting
comes from four places, and each one is testable before a euro is staked:

| Source | Test (all walk-forward) | Strategy if it survives |
|---|---|---|
| **Residual β's** (movement, tier, half-split) | Step 2 CIs exclude 0 in held-out months | Small λ tilt; feeds every in-play price. |
| **State effects books under-react to** — red cards, margin/tempo asymmetries, late-half intensity | Model vs. api-football live prices on a sample of ~300 matches (2 calls each; ~3 weeks of budget) — log-loss and realised ROI at the quoted price | Soft-book in-play value bets in fixed windows (HT, 60-65′, post-red-card). |
| **Timing (hazard) knowledge** for trades | `P(goal in [t, t+15] given state)` calibrated on goals_time2 held-out seasons | Exchange back-Over/lay-Over trades with green-up (Part C 3B.3). |
| **Book latency on soft books** after a goal/red card | Needs a price log; only measurable live | Fast entry in the 30-90 s after an event on markets the book re-prices slowly (2H totals, BTTS). |

If none of the four survives its test, the correct conclusion is "no live edge with this data", and the tool should
say so rather than show bucket hit rates that look like edge.

### E.5 Build plan (Sonnet-ready)

| # | Task | Files (new) | Acceptance |
|---|---|---|---|
| E1 | De-vig + implied-λ solver for all Bet365 rows (closing and opening). Store per-row `lam_h, lam_a, rho, lam_h0, lam_a0`. | `telegram/model/implied.js` | Reproduces the input 1X2 within 0.3 pp and O/U within 0.5 pp on 99% of rows; implied FT score distribution vs actual: log-loss no worse than a per-tier Poisson baseline. |
| E2 | Residual Poisson regression with L2, month-wise walk-forward, β CIs; half-split `s` per tier. | `telegram/model/residual.js`, report in `telegram/model/reports/` | Report committed; decision rule: keep a β only if CI excludes 0 in ≥ 2/3 of held-out folds. |
| E3 | goals_time2 loader (goals + own goals + red cards + penalties, stoppage minutes, running score, Elo join). | `telegram/model/timeline_load.js` | 65,143 matches; Elo join ≥ 95%. |
| E4 | Hazard shape `h(u)` + state-effect regression `S(state)` (exposure-weighted Poisson) + α dispersion. Export coefficients to `static/data/live_model.json`. | `telegram/model/hazard_fit.js` | Held-out seasons: reliability gap ≤ 2 pp for `P(goal in remainder)` in every minute bucket; red-card coefficient reported with CI. |
| E5 | Pricing engine `priceMarket()` + `simulateMatch()` (sample-based CIs), single file usable in browser and Node. | `static/live_model.js`, `telegram/live_model.js` (copy, parity test) | Every market's `p` from one distribution; monotonic O/U ladder; parity test passes. |
| E6 | Validation on the 2025 overlap: implied λ + hazard vs actual goal minutes; and the ~300-match api-football live-price study (E.4 row 2). | `telegram/model/validate_*.js` | Reports committed with go/no-go per edge source. |
| E7 | UI: new Live tab view driven by `priceMarket()` — per match a market ladder (fair / min-back / max-lay / your price / EV), state banner (score, minute, men on pitch), and the next-15-min goal probability for traders. Old bucket view kept behind a toggle until E6 says which is better. | `static/app.js`, `index.html` | Prices update every poll; a red card in the feed (if available) changes the ladder. |
| E8 | Telegram: strategies re-expressed as `priceMarket()` gates in fixed windows; `track_record.js` logs `venue, minute, state, edge source`. | `telegram/notify.js` | ≥ 200 paper bets per strategy before real stakes. |

Feed gap to close for E7: the livescore feed has no red-card field today. `getDatalive1`'s `statusCode` arg (`[4]`,
e.g. `'Q1_FA3-SB1-FC2'`) may encode cards — inspect with `?debug=1`; otherwise api-football's fixture events (1 call)
on click.

### E.6 Recommendation

- Do **Phase 0** regardless (it fixes numbers users see today).
- Then build **E1 → E2 → E4** before anything else — those three scripts are cheap (days, not weeks) and they *decide*
  the rest: E2 tells you whether the opening/movement information you asked about is worth anything beyond the closing
  line; E4 tells you whether the goals_time2 timing/state model is calibrated enough to trade on.
- Only if E2/E4 pass, build the pricing engine and the new UI (E5-E7); Part C's strategy rules then apply unchanged,
  with `priceMarket()` supplying `p`/`lo`/`hi` instead of bucket hit rates.

---

## Part F — Everything else the current data can be searched for (beyond live)

Ordered by cost. F1-F3 are pure analysis scripts on the Bet365 CSVs and should run before Part E.

| # | Search | Data | Script / acceptance |
|---|---|---|---|
| F1 | **Pricing-bias scan**: realised flat-stake return of backing every outcome by (market, closing-odds band, tier, home/away, line). Favourite-longshot bias, draw under-pricing, under over-pricing. | Bet365 rows | `telegram/research/bias_scan.js`; report ROI with Wilson CI per cell, n ≥ 500; walk-forward by month. A cell is a candidate only if CI-lower ROI > 0 in ≥ 2/3 of months. |
| F2 | **Cross-market inconsistency**: λ from 1X2+O/U (E1) vs the AH desk's price; back the AH side that is cheap relative to the 1X2-implied probability. Same test opening vs closing per market. | Bet365 rows | `telegram/research/cross_market.js`; ROI of the "cheap side" by disagreement size. |
| F3 | **Beat-the-closing-line**: predict closing from opening (+ tier, kickoff time, weekday, line, TL); where predicted steam ≥ x%, bet at the earlier price. Also measures CLV of every existing strategy. | Bet365 rows | `telegram/research/clv.js`; CLV distribution per strategy; only actionable if bets can be placed earlier than the current scan window. |
| F4 | **Team ratings from the dataset** (Elo / Dixon-Coles per league on the 19 months of results); test residual value vs market by tier. | Bet365 rows | Add as E2 features; expect ≈0 in TOP, possible signal in OTHER. |
| F5 | **Schedule/context features**: kickoff hour, midweek, days since last match, standings/dead-rubber from the dataset's own results. | Bet365 rows | Add as E2 features. |
| F6 | **Extra in-play events** from goals_time2: penalty awarded, goal disallowed, substitution timing, yellow-card count (red-card risk proxy). | goals_time2 | Extra terms in E4's `S(state)`; only useful if the live feed exposes them (check `getDatalive1` arg `[4]`). |

**Not possible with current data:** in-play price history, line shopping / arbitrage (single book), lineups, referees,
xG, card/corner odds. **Highest-value data investment:** start logging in-play prices today (api-football on a fixed
match sample, or a Betfair exchange stream / purchased historical in-play data) — every live strategy in this plan is
unverifiable against real prices until that log exists.
