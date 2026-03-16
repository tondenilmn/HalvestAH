# Workflow Example — Finding a Valuable Bet

## The scenario

It is half-time. You are watching a match where:

- Home team is the favourite, giving**−0.75 AH** at closing
- Home closing odds:**1.87**, opening odds:**1.93**
- Away closing odds:**1.95**, opening odds:**1.88**
- Total line closing:**2.75**, opening:**2.50**
- Over closing:**1.90**, opening:**2.05**
- HT score:**0-0**

You want to know if there is a bet worth placing for the second half.

---

## What each tool does

**Advanced Match Analysis** is your primary tool. Enter closing + opening values and a game
state. The tool auto-derives market movement signals and filters historical records that
match your match's exact conditions.

**Config Discovery** is a validation tool. It sweeps all signal combinations for a given
line and game state and returns which ones have historically shown edge. Use it *after*
Advanced finds a result — to check that the pattern is robust, not a narrow coincidence.

**Basic Match Analysis** shows unconditional base rates (all signals = ANY). Only useful
when Advanced returns very few records and you want to see if the game state alone has any
effect. Do not use it as a starting point.

---

## Step 1 — Run Advanced Match Analysis

Go to **Match Analysis → Advanced** and enter all values:

| Field             | Value     |
| ----------------- | --------- |
| AH home closing   | `-0.75` |
| AH home opening   | `-0.75` |
| Home odds closing | `1.87`  |
| Home odds opening | `1.93`  |
| Away odds closing | `1.95`  |
| Away odds opening | `1.88`  |
| TL closing        | `2.75`  |
| TL opening        | `2.50`  |
| Over closing      | `1.90`  |
| Over opening      | `2.05`  |
| Game state        | HT 0-0    |

The tool auto-derives: **Line: STABLE · FavOdds: STEAM · Dog: DRIFT · TL: UP · Over: STEAM**

**Run it.** Results come back in two sections:

### Qualifying bets (z ≥ 2.0 and edge > 0)

| Bet         | p   | baseline | edge | z   | n  | Safe min | Hard floor |
| ----------- | --- | -------- | ---- | --- | -- | -------- | ---------- |
| Over 0.5 2H | 74% | 65%      | +9pp | 2.1 | 22 | 1.62     | 1.51       |

**Over 0.5 2H** clears z ≥ 2.0 with edge +9pp.

- **Safe min 1.62** = midpoint CI — the threshold for value bets. Only bet if you can get
  odds at or above this.
- **Hard floor 1.51** = CI lower bound — the absolute minimum. Odds between 1.51 and 1.62
  technically show positive EV but offer little margin of safety.

> n=22 is in the marginal range (15–29). Ideally you want z ≥ 2.5 for samples this
> small. This result is promising but needs validation.

### Value Hunting (z < 2.0 or edge ≤ 0)

| Bet         | p   | n  | Safe min | Hard floor |
| ----------- | --- | -- | -------- | ---------- |
| Fav wins 2H | 55% | 22 | 1.98     | 1.89       |

**Fav wins 2H** does not clear the significance threshold (z=1.4) and appears here as a
reference only. If a soft book offers odds above **1.98**, the market may be mispricing it
— but the historical evidence is not strong enough to bet confidently. Treat with caution
and size small.

---

## Step 2 — Validate with Config Discovery

Run **Config Discovery** with the same line and game state to check whether the
Over 0.5 2H result is robust across the full signal sweep.

**Inputs:**

- AH line:`0.75`
- TL cluster:`2.5-3`
- Game state: HT 0-0
- Everything else:`ANY`

**Scenario A — Discovery confirms it:**

Discovery returns Over 0.5 2H with a STEAM fav / DRIFT dog / UP TL combination in its
top 10, with z ≥ 2.3 across a larger sample. The pattern holds beyond the narrow Advanced
filter. **Confidence increases.**

**Scenario B — Discovery does not confirm it:**

Over 0.5 2H does not appear in the top 15 configs for this line and game state. The
Advanced result may be an artefact of four simultaneous signal filters shrinking the
sample. **Confidence decreases — treat with caution.**

---

## Step 3 — Check bookmaker odds

You have a candidate bet: **Over 0.5 goals in the 2nd half**.
Safe min: **1.62** · Hard floor: **1.51**

| Book             | Odds | Decision                               |
| ---------------- | ---- | -------------------------------------- |
| Pinnacle         | 1.58 | ✗ Below safe min — caution flag      |
| Betfair exchange | 1.65 | ✓ Above safe min — value             |
| Soft book        | 1.72 | ✓ Comfortably above safe min — value |

Pinnacle at 1.58 is between safe min (1.62) and hard floor (1.51). The sharp market
disagrees with your estimate — this is a caution flag. Pinnacle has no margin and more
data. A soft book at 1.72 still offers positive EV against the conservative safe min.

Conservative EV at 1.72: `1.72 × 0.62 − 1 = +6.6%`
*(where 0.62 = CI lower bound probability)*

---

## Step 4 — Apply the checklist

- [ ] Advanced: z ≥ 2.0 on Over 0.5 2H
- [ ] n = 22 — marginal (z ≥ 2.5 preferred when n < 30)
- [ ] Edge > 0 (+9pp)
- [ ] Soft book odds (1.72) ≥ safe min (1.62)
- [ ] Pinnacle odds (1.58) below safe min — sharp market disagrees

- [x/✗] Discovery confirmed?*(depends on Scenario A or B)*

**If Scenario A (Discovery confirms):** two caution flags but pattern is validated.
Bet small at the soft book.

**If Scenario B (Discovery does not confirm):** three caution flags. The result is too
fragile to act on. Pass.

---

## Summary of the workflow

```
Advanced Match Analysis
        │
        ├─ No qualifying bets and n < 15?
        │         │
        │        YES → run Basic to check if game state has any
        │                effect at all. If Basic also shows nothing, pass.
        │
        └─ Qualifying bet found (z ≥ 2.0, edge > 0)?
                  │
                 YES
                  │
                  ▼
        Config Discovery — does the pattern appear in top configs?
                  │                          │
                 YES                         NO
                  │                          │
                  ▼                          ▼
        Check bookmaker odds        Pass or size very small
                  │
                  ▼
        Soft book odds ≥ safe min?
                  │                          │
                 YES                         NO
                  │                          │
                  ▼                          ▼
               Bet                         Pass
```

**Value Hunting bets** (below the qualifying threshold) are only worth acting on if:

- A soft book is significantly above the safe min
- Discovery confirms the pattern
- You size very small
