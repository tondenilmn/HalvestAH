# Betting Workflow — HalvestAH

## The core thesis

You are not trying to predict who wins. You are asking:

> **Do sharp market movements predict secondary outcomes at rates the bookmaker has not fully priced into those markets?**

The bookmaker adjusts the main AH line and 1X2 odds in response to sharp action. But secondary markets (2H totals, 1H results, BTTS, etc.) are set at kick-off and adjusted less precisely. The lag between the main market and secondary markets is where the edge lives — if it exists.

---

## The bookmaker adjustment reality

| Market | How well the bookmaker adjusts | Edge potential |
|---|---|---|
| Main AH line | Fully — it moves because of sharp action | None |
| 1X2 / Fav odds | Largely — follows the steam | Very thin |
| FT Over/Under | Moderate — main market but less precise | Thin |
| 2H Asian Handicap | Partial — set at HT, less data available | Moderate |
| 2H totals (Over/Under) | Partial — lower liquidity, slower adjustment | Moderate |
| 1H markets, BTTS | Weaker — niche markets, less attention | Better |

**Practical rule**: in the Bayesian table and Match Analysis results, prioritise bets from the 2H and 1H sections over FT result bets. The bookmaker's reaction to sharp information is most incomplete in the secondary markets.

---

## Step 1 — Live scan entry point

Open the live scanner. You are scanning for matches where **at least two signals align**. A single signal is noise; two or more in the same direction is a story.

What to look for in scan cards:

- **LM = DEEPER**: the AH line deepened in favour of the favourite — the strongest sharp-money indicator. The bookmaker's primary response to heavy fav backing is to move the line, not just the odds.
- **TLM = UP**: the total line moved up — sharps expect more goals.
- **OVM**: reinforces or contradicts TLM. If TLM=UP but OVM=DRIFT, the TL move may be a hook rather than a real expectation shift.
- **OM = STEAM on fav**: secondary confirmation of the LM story. Important: OM is measured from opening to closing odds *without adjusting for the line change*. When LM=DEEPER, the fav odds will often drift slightly as a mechanical consequence of the larger handicap re-balancing the market — this is not bearish, it is expected.

**How to read LM + OM combinations:**

| Combination | Meaning | Confidence |
|---|---|---|
| LM=DEEPER + OM=STEAM | Double confirmation — line and odds both moved for fav | Strongest |
| LM=DEEPER + OM=STABLE | Clean line move, odds held | Strong |
| LM=DEEPER + OM=DRIFT | Line absorbed the steam, odds re-normalized mechanically | Still bullish — primary signal intact |
| LM=STABLE + OM=DRIFT | No line move, fav odds lengthened — dog being backed | Bearish for fav |
| LM=STABLE + OM=STEAM | Odds-only move without line adjustment — soft book signal | Moderate |

> **The genuinely contradictory case is LM=STABLE + OM=DRIFT**, not LM=DEEPER + OM=DRIFT. When the line has already deepened, some drift in fav odds is the mechanical consequence of the market re-equilibrating around the new handicap.

---

## Step 2 — Load the match and run Match Analysis

Use **"Use this match →"** from the scan card (or scrape manually via the URL field). All odds are pre-filled.

Run **Match Analysis → Advanced**. Read the results:

- **z ≥ 2.0**: statistically meaningful. Below this, do not bet regardless of the label.
- **z ≥ 2.5 with n < 30**: the bar you want when the sample is small.
- **Hit% vs Baseline%**: the raw hit rate must be meaningfully above baseline — not just z-score-inflated by a large n.
- **Min odds shown**: this is the breakeven computed from the observed hit rate. If the bookmaker is offering less, there is no value.

### Sample size thresholds

| n (filtered pool) | z threshold | Status |
|---|---|---|
| < 25 | Any | Unreliable — skip |
| 25–40 | ≥ 2.0 | Usable with caution |
| 40–60 | ≥ 1.8 | Good |
| 60+ | ≥ 1.5 | Reliable |

**z=2.0 with n=60 is more trustworthy than z=2.8 with n=18.**

---

## Step 3 — Run Bayesian Score

This is the confirmation step. The Bayesian panel combines all active signals simultaneously rather than one at a time, giving a posterior probability for each bet.

Read the table top-to-bottom:

1. **Reliable bets are sorted to the top** (no ⚠). The ⚠ means the LR cell has fewer than 15 rows — the signal is estimated from too little data to trust.
2. **Positive delta bets**: the posterior is above the baseline — a candidate.
3. **Min odds pill** (next to the bet name): your breakeven for this specific posterior. Open your bookmaker and compare directly.

### What ⚠ means in practice

The LR is computed from the intersection of *signal value × bet outcome*. For example: rows where LM=DEEPER AND Over 1.5 2H hit. If that cell has fewer than 15 rows, the LR estimate is fragile — a handful of matches could flip the result. Ignore ⚠ bets for sizing decisions; at most use them as directional hints.

---

## Step 4 — Value check

The **min odds** shown in the Bayesian panel is `1 / posterior_probability`. This is your break-even point.

| Situation | Decision |
|---|---|
| Bookmaker odds > min odds + 0.05 | Value — bet |
| Bookmaker odds = min odds ± 0.05 | Marginal — consider skipping or sizing very small |
| Bookmaker odds < min odds | No value — skip regardless of z-score |
| Pinnacle odds < min odds but soft book > min odds | Caution: sharp market disagrees with your estimate |

The +0.05 buffer above min odds absorbs overround and estimation error. If you are only beating the floor by 0.02, the edge exists in theory but disappears in practice.

---

## Step 5 — Decision checklist

All must pass before placing:

- [ ] At least 2 signals active (LM=DEEPER alone is sufficient as a primary signal; OM=DRIFT does not cancel it)
- [ ] Bet has **no ⚠** in the Bayesian table
- [ ] Bayesian **delta ≥ +5pp** above baseline
- [ ] Match Analysis **z ≥ 2.0** for the same bet (z ≥ 2.5 if n < 30)
- [ ] **Actual odds ≥ min odds + 0.05**
- [ ] Baseline pool n ≥ 30 (shown in the n column of Match Analysis)
- [ ] Bet is in a secondary market (2H/1H preferred over FT result bets)

If a bet passes all seven, it is a candidate. If it fails any one, skip it.

---

## Worked example

**Match**: Home favourite, AH −0.75 closing. LM=DEEPER, TLM=UP, OVM=STEAM.

Bayesian table (reliable rows only):

| Bet | Baseline | → | Posterior | Shift | Min odds |
|---|---|---|---|---|---|
| Over 1.5 2H | 54% | → | 71% | +17pp | **1.41** |
| Fav scores 2H | 61% | → | 74% | +13pp | **1.35** |
| Over 0.5 2H | 68% | → | 78% | +10pp | **1.28** |
| Fav wins 2H | 48% | → | 53% | +5pp | **1.89** |

Your bookmaker offers:
- Over 1.5 2H at **1.55** → above min odds 1.41 with margin → **bet**
- Fav scores 2H at **1.32** → below min odds 1.35 → **skip**
- Over 0.5 2H at **1.25** → below min odds 1.28 → **skip**
- Fav wins 2H at **1.85** → below min odds 1.89 → **skip**

Match Analysis confirms z=2.3 on Over 1.5 2H with n=45. All checklist items pass. You bet Over 1.5 2H.

---

## Config Discovery (optional validation step)

Before or after Match Analysis, run **Config Discovery** with only the AH line and TL cluster fixed (everything else ANY). It sweeps ~18k combinations and surfaces which signal configurations have historically shown edge at this setup.

- If the same bet you found in Advanced also appears in Discovery's top configs → confidence increases.
- If it does not appear → the result may be an artefact of multiple simultaneous filters shrinking the sample. Treat with caution, size down.

**Do not use Advanced mode to search for a signal that Discovery did not surface.** Sweeping filters until something looks significant is overfitting.

---

## Z-score colour guide (dashboard)

| Colour | Z range | Action |
|---|---|---|
| Bright green | ≥ 2.5 | Strong — act confidently if odds pass |
| Green | 2.0–2.5 | Good — act if other factors align |
| Yellow | 1.5–2.0 | Marginal — only if n is large (50+) |
| Dim | < 1.5 | Weak — do not place |
| Red | Negative | Against baseline — avoid |

---

## Manual live scan workflow

Use this when actively watching matches rather than waiting for a Telegram alert.

### Step 1 — Screen scan cards quickly

Skip a card immediately if:
- All signals are **STABLE** (no movement at all — nothing to work with)
- Minute is **75+** (too little time for 2H bets; FT bets only and only if clear edge)
- Score is **3+ goals** (high-scoring games distort 2H total baselines)
- League is unknown or obscure (edge is TOP/MAJOR-specific)

Keep a card if: **LM=DEEPER** or **TLM=UP**, regardless of what OM shows.

### Step 2 — Run Bayesian Score first

Before Match Analysis, open the Bayesian panel. It is the fastest summary of whether anything is worth pursuing.

- Scan the **reliable (no ⚠) rows only**
- Look for **delta ≥ +5pp** and **positive posterior**
- Note the **min odds pill** next to each bet name
- If nothing shows positive delta above +5pp among reliable bets → skip the match

If you see 1–2 reliable bets with strong delta, continue to Step 3.

### Step 3 — Check bookmaker odds immediately

Before running Match Analysis, open your bookmaker and compare the offered odds against the min odds shown in the Bayesian panel.

- Need: **bookmaker odds ≥ min odds + 0.05**
- If no bet clears that bar → skip the match now, before spending more time on it

This is the most common early exit point. Most matches pass signals but fail the value check.

### Step 4 — Run Match Analysis (Advanced mode)

Only if Step 3 found at least one bet with odds value. Confirm with z-score:

- **z ≥ 2.0** required (z ≥ 2.5 if n < 30)
- **n ≥ 30** in the filtered pool
- Hit% clearly above baseline% (not just z-inflated by large n)

### Step 5 — Add game state if in-play

If the match has a score and minute showing:

- **2H (minute > 45)**: enter the HT score in the HT fields, re-run
- **1H (minute ≤ 45, non 0-0)**: set the first goal trigger (FAV_1H or DOG_1H), re-run
- **1H 0-0**: no game state to add — pre-match signals only

Game state narrows the sample. If the filtered n drops below 15, ignore the game state result and fall back to the pre-match analysis.

### Step 6 — Prioritise by market type

When multiple bets pass, choose in this order:

1. **2H totals** (Over/Under 1.5 2H, Over 0.5 2H) — best bookmaker lag
2. **1H results and totals** — if still in 1H with time remaining
3. **FT Over/Under** — thin but usable
4. **FT result / Fav wins** — last resort; bookmaker adjusts these most precisely

### What to skip entirely in manual mode

- **Config Discovery** — useful for validation, too slow for real-time decisions
- **Basic mode** — use Advanced or Bayesian only; Basic produces noisier results
- **Stability tab** — only relevant for long-term config research
- Any bet with **⚠** in the Bayesian panel — unreliable LR estimate

### Quick checklist (manual scan)

- [ ] Signal present (LM=DEEPER or TLM=UP)
- [ ] Minute < 75 (or accepting FT-only bets after 75)
- [ ] Bayesian: at least one reliable bet with delta ≥ +5pp
- [ ] Bookmaker odds ≥ min odds + 0.05
- [ ] Match Analysis: z ≥ 2.0, n ≥ 30
- [ ] Game state added if in 2H with known HT score
- [ ] Bet is in a secondary market (2H or 1H preferred)
