# Betting Edge Analysis — Key Conclusions

## 1. Pre-match betting vs Pinnacle

- Pinnacle is the sharpest bookmaker in the world. Their closing line is the best available estimate of true probability.
- Betting pre-match at Pinnacle = playing against an efficient model + vig. Long-run expectation is negative.
- The signals in the dataset (line movement, steam, drift, TL shift) represent where sharp money went. Pinnacle's line already corrected for that information. You are always one step behind.

## 2. Soft books following Pinnacle

- Soft books (Bet365, Bwin, etc.) do not price independently. They copy Pinnacle with a lag.
- The lag window is:
  - **2–10 minutes** on major European leagues
  - **Up to 1 hour** on minor leagues, totals markets, off-peak hours
  - **Near-instant** for large automated moves at big books
- Even if you catch the lag, soft books restrict or gub accounts that win consistently. The window is doubly narrow: you need to be faster than their trader AND have an unrestricted account.

## 3. HT score as a predictor of 2H outcomes

- HT score is genuinely new information that the pre-match model didn't have.
- The conditional probability `P(FT outcome | HT state + pre-match config)` is more informative than `P(FT outcome | pre-match config)` alone.
- **However**: Pinnacle's in-play model already incorporates the HT score. They reprice immediately at HT. Sharp bettors test their in-play line within seconds.
- You do not have private information that Pinnacle doesn't have at HT. Their in-play line IS the conditional probability.

## 4. In-play betting during the second half

- The "event hasn't happened yet" observation (e.g. 0-0 at 65', Under 2.5 now 85%) is fully priced into Pinnacle's live model via Poisson time-decay.
- Pinnacle updates live odds every few seconds. They suspend on every dangerous situation.
- The bookmaker knows the current score, minute, remaining time, and expected goals. There is no systematic angle from tracking what hasn't happened yet.
- Soft books are slower in-play (1–3 minute lags on minor leagues) but execution speed requires automation, not manual betting.

## 5. Betting opposite to recreational bettors at soft books

- Soft books shade their odds based on public betting patterns (favorites, home teams, popular clubs, overs).
- The "other side" (underdog, away, under) can sometimes be priced slightly generously — this is called **fading the public**.
- The effect is real but small: **1–3% in the odds** at most.
- Critical problem: you cannot see Bet365's book liability data. You don't know where their public money actually is.
- Pinnacle data tells you where sharp money went, not where soft book recreational customers bet.
- Even if you identify these situations, vig eats most of the edge and accounts get restricted before you can exploit it at scale.

## 6. What the dataset CAN be used for

### Closing Line Value (CLV) — most validated approach
- Pinnacle's closing line = best estimate of true probability.
- If you consistently get odds **better than Pinnacle's closing line** at a soft book, you have demonstrable edge.
- Long-run profitability correlates strongly with CLV > 0.
- Use the dataset to identify which markets/configurations have the **most line movement** (opening → closing). Those are the markets where the CLV window is longest and soft books are slowest to follow.
- **Act early** (24–48h before KO when lines first open), not late.

### Exchanges (Betfair, Smarkets)
- No account restrictions.
- You bet against other bettors, not the house.
- Commission ~2–5% vs 6–8% soft book margin.
- If your patterns identify even a small real edge, exchanges are the only place to exploit it at scale.
- This is where sharp bettors actually operate.

### Calibration tool — not a signal generator
- Use the dataset to ask: **does Pinnacle's implied probability match actual outcomes in specific niches?**
- Compare `Pinnacle closing implied probability` vs `actual historical outcome rate` per market segment.
- In most cases they match (efficiency). A **systematic divergence** in a specific niche is a genuine signal.
- This is fundamentally different from pattern-mining. You are testing whether the market is correct, not just whether a historical filter had a good hit rate.

### Opening line window
- Pinnacle publishes lines early. The movement from opening to closing = where the market corrected itself.
- The dataset can quantify: in which configurations does the line move the most?
- Those are markets where Pinnacle's opening was least accurate and soft books are slowest to follow.
- Acting at opening in those configurations gives a lag measured in **hours, not minutes**.

## 7. What the dataset CANNOT do

- Historical hit rates above baseline do not guarantee future edge. Most are noise from overfitting across many filter combinations.
- Z-scores are informative but not sufficient — the market already priced the signal.
- Any edge requiring a soft book will eventually result in account restrictions.
- In-play conditional probabilities cannot beat Pinnacle's own live model.

## 8. The core question to always ask

> **Does my implied edge survive comparison to Pinnacle's closing line?**

- If yes → it is real edge.
- If no → it is noise from historical patterns that the market already priced.

## 9. Value betting and money management

### What value betting is
- If your empirical hit rate exceeds the bookmaker's implied probability, you have value.
- Example: your tool shows 58% hit rate on 200 filtered samples. Bet365 offers 1.77 (implied 53.8%). Your fair odd is 1.72. Bet365 offers +0.05 more. EV = +2.5% per bet.
- This is the **only legitimate framework** for profitable betting.

### Money management cannot create edge — mathematical fact
- No staking system (Kelly, Martingale, Fibonacci, flat, proportional) can turn zero or negative EV into profit.
- They only control the *path* (variance, drawdown), not the destination (expected value).
- EV < 0 → any system leads to ruin over time
- EV = 0 → any system produces a random walk, you go nowhere
- EV > 0 → Kelly optimizes how fast you grow

### What money management CAN do
- When EV > 0: Kelly maximizes bankroll growth rate and reduces ruin probability
- When EV = 0: controls variance, changes nothing about outcome
- When EV < 0: slows the inevitable, cannot prevent it

### The correct sequence
1. Find genuine EV > 0 first (CLV-based, calibration vs Pinnacle close)
2. Verify it is not overfitting (out-of-sample test on data the model never saw)
3. Only then apply Kelly to size bets optimally

## 10. How many samples to confirm real edge vs noise

The required sample size depends entirely on how large your edge is above baseline.

### Required samples (95% confidence, 80% power)

| Edge above baseline | Example | Samples needed |
|---|---|---|
| +2% | 52% vs 50% baseline | ~3,900 |
| +3% | 53% vs 50% baseline | ~1,700 |
| +4% | 54% vs 50% baseline | ~970 |
| +5% | 55% vs 50% baseline | ~620 |
| +8% | 58% vs 50% baseline | ~240 |
| +10% | 60% vs 50% baseline | ~150 |
| +15% | 65% vs 50% baseline | ~70 |

### The overfitting multiplier
- The numbers above assume you are testing on **data the model never saw**.
- If the filter was built and tested on the **same dataset**, multiply required samples by **2–3x**.
- The only real validation: train filter on data up to date X, test on data after date X.

### Key implications
- The tool's `MIN_N = 35` is a quality gate on the historical pool, not a validation sample. It means "enough history to measure", not "enough to confirm real edge".
- 200 post-filter samples is only sufficient if your edge is +8% or more AND the data is truly out-of-sample.
- A +3–5% edge (realistic for value betting) requires 500–1,700 clean out-of-sample matches — potentially 1–2 years of live results.
- **CLV confirmation is faster than outcome confirmation**: if you consistently beat Pinnacle's closing line, you don't need to wait years for outcome validation.

## 11. Summary table

| Approach | Edge source | Realistic? |
|---|---|---|
| CLV betting (early, pre-match) | Line movement lag at soft books | Yes, but narrow window |
| Exchange betting | No restrictions + lower margin | Yes, but needs genuine edge |
| Calibration vs Pinnacle closing | Systematic mis-pricing in niches | Possible in specific niches |
| Pattern mining → soft book | Bookmaker already priced it | Very weak |
| In-play conditional probabilities | Bookmaker already knows | No |
| Fading the public at soft books | Public bias shading | Too small, account restrictions |
| HT-conditional 2H betting | Bookmaker already reprices | No |

## 12. Which signal/bet to follow at HT

### If Bet365 offered odds are entered (Kelly% visible)

Follow Kelly% directly — it already encodes edge size, sample size, and odds value in one number.

| Kelly% | Action |
|---|---|
| Green ≥ 2% (offered ≥ MIN ODDS) | Bet |
| Yellow ≥ 1% (between fair and MIN) | Bet small |
| Yellow < 1% | Skip — margin too thin after vig |
| NO VALUE | Skip |

### If offered odds are not available — select 1-2 bets per match

**Step 1 — Hard filters (non-negotiable)**
- Discard baseline < 30% — unreliable low base-rate markets
- Discard n < 200 — insufficient sample to confirm edge

**Step 2 — Prefer market type**

| Priority | Market | Why |
|---|---|---|
| 1st | Over/Under goals 2H | Soft books lag most on totals, always available in-play |
| 2nd | Fav/Home/Away scores 2H | Liquid, commonly offered, moderate lag |
| 3rd | 2H result (Fav wins, Draw) | Soft books follow Pinnacle faster on results |
| 4th | FT remaining | Already partially priced via HT score |

**Step 3 — Rank by z-score**
Z-score is the single best number when offered odds are unknown. It encodes both edge size and sample size. The tool already sorts by this.

**Step 4 — Tiebreaker: lower MIN ODDS**
Between two bets with similar z-score, prefer lower MIN ODDS — easier to find value on at Bet365.

**Practical rule**
```
1. Remove baseline < 30% and n < 200
2. Take top Over/Under 2H bet by z-score
3. If none survives, take top scoring market by z-score
4. Maximum 2 bets per match — only if both pass step 1
```

### The two numbers to remember
- **Z-score** is your guide without offered odds
- **MIN ODDS** is your guide once you open Bet365

## 13. Z-score thresholds for HT live bet cards

The HT LIVE VIEW shows all bets with positive delta — z-score is not used to filter. Apply these thresholds manually:

| Z-score | Interpretation | Action |
|---|---|---|
| < 1.5 | Noise | Ignore |
| 1.5 – 2.0 | Weak | Only if n > 300 AND fits game logic |
| 2.0 – 2.5 | Moderate confidence | Actionable with caution |
| ≥ 2.5 | Good confidence | Prioritise |
| ≥ 3.0 | Strong signal | Best candidates |

**Multiple comparisons note:** up to 17 bets shown simultaneously → at least one false positive expected at z ≥ 2.0 by chance. Use z ≥ 2.5 as working minimum. For grey zone bets (between fair and MIN), require z ≥ 3.0.

**Combined rule:**
- Without offered odds: z ≥ 2.5 + n ≥ 200 + baseline ≥ 30%
- With offered odds above MIN: z ≥ 2.0 is sufficient (Kelly handles sizing)
- With offered odds between fair/MIN: z ≥ 3.0 required

## 14. Complete betting workflow

### Step 1 — Live Scan
Run the live scan. Look only for matches currently at half time. Ignore all others — the window is ~15 minutes.

### Step 2 — Select the match
Click **"Use this match →"** on a HT match. The tool loads pre-match odds and switches to GSA tab automatically.

### Step 3 — Configure GSA
In the **HT ANALYSIS** tab:
1. Enable **HT SCORE** toggle → enter the actual HT score (e.g. 0-0)
2. Tick **"HT as signal"**
3. Click **RUN GSA →**

### Step 4 — Filter results
Immediately discard any bet where:
- Baseline < 30%
- n < 200
- z < 2.5

### Step 5 — Rank survivors
Without opening Bet365 yet, rank by:
1. Market type: Over/Under 2H → scoring 2H → result 2H → FT
2. Z-score: highest first
3. Tiebreaker: lower MIN ODDS

Pick top 1-2 candidates only.

### Step 6 — Check Bet365
Open Bet365 in-play for those 1-2 bets only. Enter offered odds in the card.

- Offered > MIN ODDS → green Kelly% → bet
- Fair < Offered < MIN → yellow Kelly% ≥ 1% AND z ≥ 3.0 → small bet
- Offered ≤ Fair → skip

### Step 7 — Size the bet
Use Kelly% shown in the card as % of bankroll.
- Green Kelly ≥ 2% → bet that percentage
- Yellow Kelly 1-2% → bet half (extra caution)
- Hard cap: never exceed 5% of bankroll on a single HT bet

### Step 8 — Move on
Maximum 2 bets per match. Do not chase after the primary bet is placed.

### Quick reference
```
Scan → select HT match
GSA: HT score ON + HT as signal ON → Run

Discard:  baseline < 30%  /  n < 200  /  z < 2.5
Rank:     Over/Under 2H first → z-score → lower MIN ODDS
Max:      2 bets per match

Bet365:   offered > MIN ODDS → green Kelly% → bet
          offered between fair/MIN → yellow Kelly% ≥ 1% + z ≥ 3.0 → small bet
          offered ≤ fair → skip

Size:     Kelly% of bankroll, cap at 5%
```

## Focus bets (1T/2T O/U) — PLAN_FOCUS_BETS.md Phases 2 & 4 (2026-08-29)

Config search (`telegram/focus_config_search.js`) over the 7 in-scope 1H/2H Over/Under 0.5/1.5
bets, walk-forward validated on the last 8 held-out months of `CrossBooks/Bet365_Data_months`
(cross-fit selected/priced per `focus_config_search.js`'s `crossFitCells` — never picks and prices
a cell from the same fold). Cross-book follow/fade check (`telegram/focus_crossbook.js`) using
`CrossBooks/Sbobet_Data_months` for the ~50% of fixtures both books quote. Full output:
`telegram/data/focus_configs.json`, `telegram/data/focus_crossbook.json`.

**Important caveat before reading any number below:** the CrossBooks CSVs carry no real historical
price for half-time 0.5/1.5 lines — only the FT Over/Under at the closing Total Line. Every
"hit%"/"ROI" figure here is against a **model-implied price** (`focus_lib.js`'s `impliedPrice`: a
bivariate-Poisson fit to the match's own closing AH+O/U odds via `live_lambda_solver.js`, split
into 1H/2H shares using the real goal-timing data in `goal_timing_summary.json`). This validates
"does this configuration beat what the match's own odds imply", not "does this beat a real
bookmaker quote for this exact half-line market" — treat it as a signal-quality ranking, not a
literal expected return.

**A real calibration bug was found and fixed before trusting any of this.** The first pass (no
correction) showed 18-31 "surviving" cells, all Under-side, all OTHER tier, with implausibly large
pooled ROI (up to +35%). Before believing that, a plain unconditional check — pooled model-implied
mean probability vs. realized rate across all 152,350 Bet365 rows, no filtering at all — showed a
**systematic bias in the pricing model itself**: every Over-family key was overpriced by the model
by 2.6-4.5pp, every Under-family key underpriced by the same amount. Likely cause: splitting one
combined FT lambda into two independent per-half Poisson processes discards the Dixon-Coles tau
correction, which specifically adjusts the low-score cells (0-0, 1-0, 0-1, 1-1) that a 0.5-goal
line sits exactly on. Left uncorrected, this bias alone was enough to make "always bet Under"
look like a walk-forward-consistent edge with nothing to do with any of the configuration filters.

**Fix:** `focus_lib.js`'s `computeCalibration(rows, key)` derives an additive correction (realized%
minus model-implied%) from **train rows only**, recomputed fresh inside every walk-forward
iteration (never from the test month — that would leak test-set information into the price) —
same walk-forward discipline used everywhere else in this codebase. Both `focus_config_search.js`
and `focus_crossbook.js` now price every train/test row through this corrected estimate.

**Result after the fix — almost everything that looked like an edge was the calibration bug:**

| Key | Surviving cells (pre-fix) | Surviving cells (post-fix) | Best post-fix ROI |
|---|---|---|---|
| `over05_1H` | 0 | 0 | — |
| `over15_1H` | 0 | 0 | — |
| `under05_1H` | 18 | **1** | +12.0% (n=168) |
| `over05_2H` | 0 | 0 | — |
| `over15_2H` | 0 | **1** | +12.6% (n=122) |
| `under05_2H` | 4 | **3** | +20.0% (n=752) |
| `under15_2H` | 9 | 0 | — |

The one config that survives with real weight (`under05_2H`, n=752 pooled, +20% ROI, 7/8 held-out
months positive) is: fav line 0.25, HOME or AWAY favourite, closing TL 2-2.5, OTHER tier, HT 0-0,
TL/Over-Under odds flat since open. Everything else that survives is thin (n=122-196) and should
be treated as noise until more months of data confirm it.

**Cross-book check (Phase 4) found no follow/fade signal, and confirms the calibration fix worked.**
With the bias corrected, unconditional ROI at the model-implied price is negative for every one of
the 7 keys (roughly -1% to -12%, i.e. close to "a fairly-margined market minus the book's vig" —
exactly what a well-calibrated price should look like with no edge applied) — a good sanity check
that the correction isn't overcorrecting. Conditioning on Bet365's own TL movement (`tl_move`) or on
Sbobet-vs-Bet365 closing TL disagreement produced no consistent (>=6/8 months) directional edge for
any key once the bias is removed; several buckets hit the 6/8-months bar but with a "counter-intuitive"
sign (the opposite of what a real follow/fade story would predict) and both buckets still net negative
— read as noise, not a fadeable signal.

**Bottom line for the plan's scope:** this analysis does not support building the FOCUS strategy
around a wide net of configurations. It supports exactly one candidate worth carrying into Phase 5
(`under05_2H` at fav 0.25/TL 2-2.5/OTHER/HT 0-0/flat odds), staked conservatively given OTHER-tier's
known extra risk (CLAUDE.md's Dashboard near-kickoff section flags the same caution independently),
and it means `over05_1H`, `over15_1H`, `over05_2H`, `under15_2H` currently have **no supported
pre-match/HT selection rule** — Strategy FOCUS should only alert on `under05_1H`/`over15_2H`/`under05_2H`
in the specific surviving cells, and should surface the other four keys purely for the live-playable
1T/2T panel (no historical edge claim), not as alert triggers.
