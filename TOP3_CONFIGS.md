# Top 3 Alert Configurations — Dataset Analysis
**Generated:** 2026-03-19
**Dataset:** 68,798 records · 208 daily CSV files · Oct 2024 – Jan 2026
**Engine:** Same logic as app.js Config Discovery (MIN_Z = 2.0, MIN_N = 15)
**Sweep:** All AH lines × fav sides × TL clusters × signal combinations × 3 game states

---

## Key Finding

The dominant, statistically robust signal in the dataset is:

> **Total Line moves UP from opening to closing** (TL closing > TL opening)
> → sharp money expects more goals → fav scores / goals are elevated in 2H

All 3 top configurations share this prematch trigger.

---

## Configuration #1 — TLM UP → Fav Scores in 2H at HT 0-0 ★★ STRONG

| Parameter     | Value                          |
|---------------|-------------------------------|
| AH line       | ANY                            |
| Fav side      | ANY                            |
| Signal        | **TL Move = UP**               |
| Game state    | HT score must be **0-0**       |
| Bet           | **Fav scores in 2H**           |
| Sample (n)    | 3,493                          |
| Hit rate      | **62.5%**                      |
| Baseline      | 56.9%                          |
| Edge          | +5.6pp                         |
| z-score       | **6.25**                       |
| Min odds      | 1.60 (conservative: 1.62)      |

**Alert filter on asianbetsoccer:**
Total Line closing > Total Line opening → any match, any AH line.
Wait until half time. Bet only if HT score is 0-0.

**Note:** Over 0.5 goals in 2H is the same sample and a correlated bet:
- Hit rate: 77.8% vs baseline 74.1% (+3.7pp) · z = 4.64 · min odds 1.29

---

## Configuration #2 — TLM UP + HOME Fav → Home Scores 2H at HT 0-0 ★★ STRONG

| Parameter     | Value                          |
|---------------|-------------------------------|
| AH line       | ANY (Home team gives handicap) |
| Fav side      | **HOME**                       |
| Signal        | **TL Move = UP**               |
| Game state    | HT score must be **0-0**       |
| Bet           | **Home scores in 2H**          |
| Sample (n)    | 2,334                          |
| Hit rate      | **64.2%**                      |
| Baseline      | 57.8%                          |
| Edge          | +6.5pp                         |
| z-score       | **5.87**                       |
| Min odds      | 1.56 (conservative: 1.58)      |

**Alert filter on asianbetsoccer:**
Home AH closing < 0 (home is favourite) AND TL moves up.
More specific than #1 — larger edge (+6.5pp vs +5.6pp) with still-large sample.

---

## Configuration #3 — TLM UP → Over 0.5 Goals 2H at HT 0-0 ★ GOOD

| Parameter     | Value                          |
|---------------|-------------------------------|
| AH line       | ANY                            |
| Fav side      | ANY                            |
| Signal        | **TL Move = UP**               |
| Game state    | HT score must be **0-0**       |
| Bet           | **Over 0.5 goals in 2H**       |
| Sample (n)    | 3,493                          |
| Hit rate      | **77.8%**                      |
| Baseline      | 74.1%                          |
| Edge          | +3.7pp                         |
| z-score       | **4.64**                       |
| Min odds      | 1.29 (conservative: 1.30)      |

**Alert filter on asianbetsoccer:**
Same filter as #1 but a different market. High base rate (77.8%) means odds are tight.
Best used as a corroborating bet alongside #1, not standalone.

---

## Summary Table

| Alert | Additional filter     | Bet at HT 0-0    | Min odds | z    |
|-------|-----------------------|------------------|----------|------|
| #1    | None (any match)      | Fav scores 2H    | 1.60     | 6.25 |
| #2    | Home team is fav      | Home scores 2H   | 1.56     | 5.87 |
| #3    | None (any match)      | Over 0.5 2H      | 1.29     | 4.64 |

---

## Practical Workflow

1. **Prematch:** Set alert for TL Move = UP (TL closing > TL opening by >0.12).
2. **At kickoff:** Note the match. If home team is also the fav, flag for #2 as well.
3. **At HT:** Check the score. If **0-0**, execute the relevant bet(s).
4. **Odds check:** Only bet if the available odds meet the minimum listed above.

---

## Statistical Notes

- z-score > 4.5 in all three cases = very high confidence (p < 0.00001).
- Sample spans ~9 months across all competitions in the Pinnacle export.
- Wilson lower bound used for conservative min odds (accounts for sample uncertainty).
- Baseline = same AH line / fav side pool with no signal filter — measures information edge above what the closing market already implies.
- These are 2H bets: results are independent of which team scored in 1H (the HT 0-0 filter ensures no goals were scored in either half so far).
