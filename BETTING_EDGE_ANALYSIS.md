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
