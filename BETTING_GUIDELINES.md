# Betting Decision Guidelines

## Workflow

```
Live scan  →  Line move ON + TL move ON  →  shortlist top matches
     ↓
Select match  →  add Fav odds + Dog odds  →  confirm signal direction
     ↓
If betting over/under  →  add Over/Under move  →  final filter
     ↓
Check pre-match N + z  →  check in-play N + z  →  check min odds  →  place
```

---

## Sample Size Requirements

### Pre-match (cfg N)

| N       | Z threshold | Interpretation              |
|---------|-------------|-----------------------------|
| < 25    | Any         | Unreliable — skip           |
| 25–40   | ≥ 2.0       | Usable with caution         |
| 40–60   | ≥ 1.8       | Good                        |
| 60+     | ≥ 1.5       | Reliable                    |

**Target: N ≥ 40 before trusting any z-score.**
With 34 bets tested simultaneously, expect ~2 false positives by chance at z>1.5 with small N.

### In-play / Game state (gs N)

| N       | Z threshold | Interpretation                        |
|---------|-------------|---------------------------------------|
| < 10    | Any         | Ignore — anecdotal                    |
| 10–15   | ≥ 2.0       | Marginal — confirmation only          |
| 15–25   | ≥ 1.5       | Usable                                |
| 25+     | ≥ 1.5       | Good                                  |

**Target: N ≥ 15 in-play. Treat as confirmation, not standalone signal.**

---

## Threshold to Place a Bet

```
Pre-match:   N ≥ 40  ·  z ≥ 2.0  ·  edge ≥ +5pp above baseline
In-play:     N ≥ 15  ·  z ≥ 1.5  (confirmation)
Both pass → place the bet
```

If only pre-match passes and in-play N < 15: can still place but size down.

---

## Z-score vs N Trade-off

**z=2.0 with N=60 is more trustworthy than z=2.8 with N=18.**

- Large N + moderate z = small but real edge
- Small N + high z = likely a statistical artifact

| Situation             | Action      |
|-----------------------|-------------|
| z=3.0, N=12           | Do not place |
| z=1.8, N=70           | Solid bet    |
| z=2.5, N=40           | Strong bet   |

---

## Signal Filters

### Live scan defaults (ON)
- AH Line move — strongest sharp-money indicator
- TL move — independent game script dimension

### After selecting a match (add as needed)
- Fav odds move — confirms steam/drift thesis
- Dog odds move — confirms direction (fav steam + dog drift = clean signal)
- Over/Under move — only when targeting over/under bets

### Odds tolerance
- Default: ±0.05 — reasonable for most AH odds ranges
- Always check N after applying — if N drops below 20, widen to 0.07–0.10
- In advanced mode: combine tolerance on closing odds + signal direction for best precision

---

## Bet Selection Checklist

Before placing, all must pass:

- [ ] Pre-match N ≥ 40
- [ ] Pre-match z ≥ 2.0
- [ ] Edge ≥ +5pp above baseline
- [ ] In-play N ≥ 15 (or accept reduced confidence)
- [ ] In-play z ≥ 1.5
- [ ] Stability is not low
- [ ] Wilson CI lower bound still above baseline
- [ ] Market odds ≥ min odds shown by tool
- [ ] Minute still leaves time for the bet to resolve

---

## Two-Stage Z Check (Live Scan)

| Stage               | What to check                          | Threshold |
|---------------------|----------------------------------------|-----------|
| Scan card z         | Pre-match signal — use to shortlist    | ≥ 2.0     |
| Post-game-state z   | After adding HT/score/minute — decide  | ≥ 2.0     |

Only proceed if **both** are ≥ 2.0. If scan z was strong but drops after game state → skip.

---

## Z-score Tiers (dashboard color coding)

| Color  | Z range  | Action              |
|--------|----------|---------------------|
| Green (bright) | ≥ 2.5 | Strong — act confidently |
| Green  | 2.0–2.5  | Good — act if other factors align |
| Yellow | 1.5–2.0  | Marginal — only if N is large (50+) |
| Dim    | < 1.5    | Weak — do not place |
| Red    | Negative | Against baseline — avoid |
