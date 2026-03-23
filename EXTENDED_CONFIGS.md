# Extended Alert Configurations — Beyond TLM UP
**Generated:** 2026-03-19
**Dataset:** 68,798 records · 208 daily CSVs · Oct 2024 – Jan 2026
**Method:** Swept 10 signal groups × all AH lines × fav sides × TL clusters × 3 game states
**Bar:** z ≥ 2.5, n ≥ 20, edge > 0 (excluding TLM UP — already covered in TOP3_CONFIGS.md)

---

## Notes on result quality

- Results with n < 50 are flagged as low-confidence even if z ≥ 2.5.
- Several signal groups surface the same underlying configuration (LM DEEPER + FavOdds IN shows
  up in 3 separate groups — it is one configuration, counted once).
- All odds below are conservative (Wilson lower-bound midpoint).

---

## New Configuration #1 — LM DEEPER + FavOdds STEAM + TLM STABLE → **Under 2.5 FT** ★★ STRONG

**Signal interpretation:**
Pinnacle moved the AH line *deeper* (more weight on fav) AND fav odds *fell* (steamed) —
double sharp signal on the fav side. But the total line did NOT move up (STABLE).
→ Sharps expect the fav to WIN, but via a controlled, lower-scoring game.

| Parameter     | Value                                    |
|---------------|------------------------------------------|
| AH line       | ANY                                      |
| Fav side      | ANY                                      |
| TL cluster    | ANY (or narrow to 2.5–3 for tighter edge)|
| Signal        | **LM: DEEPER + FavOdds: IN + TLM: STABLE** |
| Dog odds      | OUT (optional — tightens edge slightly)  |
| Game state    | HT 0-0                                   |
| Bet           | **Under 2.5 goals FT**                   |

**Version A — broad (any TL):**

| n   | Baseline | Hit rate | Edge    | z    | Wilson-LB | Min odds (conservative) |
|-----|----------|----------|---------|------|-----------|------------------------|
| 299 | 83.3%    | 90.3%    | +7.1pp  | 3.25 | 86.4%     | **1.13**               |

**Version B — narrow (TL 2.5–3 only):**

| n   | Baseline | Hit rate | Edge    | z    | Wilson-LB | Min odds (conservative) |
|-----|----------|----------|---------|------|-----------|------------------------|
| 105 | 81.8%    | 95.2%    | +13.4pp | 3.56 | 89.3%     | **1.08**               |

**Alert filter:** Line moves deeper + fav odds fall + total line stays flat.
Recommended: use Version A for frequency, Version B if TL is in the 2.5–3 zone.

---

## New Configuration #2 — LM SHRANK + TL 2–2.5 → **Under 1.5 2H** ★★ STRONG

**Signal interpretation:**
AH line *shrank* (less weight on fav, dog support) on a match with a very low total (2–2.5).
Tight handicap (-0.25) + low expected goal game + line moving away from fav
→ very few 2H goals, market broadly expects a tight, low-scoring match.

| Parameter     | Value                                    |
|---------------|------------------------------------------|
| AH line       | **-0.25** (Home fav gives 0.25)          |
| Fav side      | ANY                                      |
| TL cluster    | **2–2.5**                                |
| Signal        | **LM: SHRANK**                           |
| Over odds     | STABLE (optional — confirms no goal push)|
| Game state    | HT 0-0                                   |
| Bet           | **Under 1.5 goals in 2H**               |

| n   | Baseline | Hit rate | Edge    | z    | Wilson-LB | Min odds (conservative) |
|-----|----------|----------|---------|------|-----------|------------------------|
| 232 | 65.4%    | 77.6%    | +12.2pp | 3.78 | 71.8%     | **1.34**               |

**Alert filter:** AH line is -0.25 (or +0.25) + TL closing between 2.0 and 2.5 + line shrank.
**Best odds available** of any new config (1.34) — good value.
Highest z-score of any new config (3.78).

---

## New Configuration #3 — TLM DOWN + FavOdds DRIFT, HOME fav, HT 1-0 → **Over 1.5 FT** ★ GOOD

**Signal interpretation:**
Counter-intuitive live config. Prematch: TL moved *down* (fewer goals expected) AND fav odds
*drifted up* (less sharp fav confidence) AND over odds also drifted.
The market said "low scoring, dog value." Yet — when home leads 1-0 at HT in these matches —
they still go on to produce Over 1.5 FT at a strongly elevated rate.

| Parameter     | Value                                          |
|---------------|------------------------------------------------|
| AH line       | ANY                                            |
| Fav side      | **HOME**                                       |
| TL cluster    | ANY                                            |
| Signal        | **TLM: DOWN + FavOdds: OUT + OverOdds: OUT**   |
| Game state    | **HT 1-0 (Home leads)**                        |
| Bet           | **Over 1.5 goals FT** (also: Over 0.5 2H)     |

| n   | Baseline | Hit rate | Edge   | z    | Wilson-LB | Min odds (conservative) |
|-----|----------|----------|--------|------|-----------|------------------------|
| 196 | 76.9%    | 86.2%    | +9.3pp | 3.08 | 80.7%     | **1.20**               |

**Alert filter:** Set prematch alert for home-fav matches where TL falls + fav odds drift.
At HT: confirm score is 1-0. Then bet Over 1.5 FT.
Good odds (1.20) and solid sample (n=196).

---

## Honorable Mention — LM SHRANK + TLM DOWN, HOME fav, HT 1-0 → **Home wins FT / DNB Home**

If you want a 4th slot targeting the *live* scenario where a home favourite is leading but
signals suggest the market is undervaluing them:

| Parameter     | Value                                          |
|---------------|------------------------------------------------|
| AH line       | **-0.75** (Home gives 0.75)                    |
| Fav side      | **HOME**                                       |
| Signal        | **LM: SHRANK + FavOdds: STABLE + TLM: DOWN**   |
| Game state    | **HT 1-0 (Home leads)**                        |
| Bet           | **Home wins FT** (or DNB Home)                 |

| n  | Baseline | Hit rate | Edge    | z    | Wilson-LB | Min odds (conservative) |
|----|----------|----------|---------|------|-----------|------------------------|
| 70 | 78.8%    | 94.3%    | +15.5pp | 3.14 | 86.2%     | **1.11**               |

⚠️ n=70 — smaller sample, treat with more caution than configs #1–3.

---

## Combined Alert Slots Summary

| Slot | Signal (prematch)                          | GS check    | Bet            | Min odds | z    | n   |
|------|--------------------------------------------|-------------|----------------|----------|------|-----|
| A    | TLM UP                                     | HT 0-0      | Fav scores 2H  | 1.62     | 6.25 | 3493|
| B    | LM DEEPER + FavOdds IN + TLM STABLE        | HT 0-0      | Under 2.5 FT   | 1.13     | 3.25 | 299 |
| C    | LM SHRANK + AH -0.25 + TL 2–2.5           | HT 0-0      | Under 1.5 2H   | 1.34     | 3.78 | 232 |
| D    | TLM DOWN + FavOdds DRIFT + OverOdds DRIFT  | HT 1-0 live | Over 1.5 FT    | 1.20     | 3.08 | 196 |

Slots A–C are pure **prematch** alerts (set the filter, watch the match, bet at HT 0-0).
Slot D is a **live** alert (prematch filter + live HT 1-0 confirmation).

---

## Key Insight Pattern

The data converges on a consistent logic:

| Signal combination       | What sharps are saying         | Best bet       |
|--------------------------|-------------------------------|----------------|
| TLM UP                   | More goals coming              | Fav scores 2H  |
| LM DEEPER + FavOdds IN   | Fav wins, low scoring          | Under 2.5 FT   |
| LM SHRANK + low TL       | Less confident fav, tight game | Under 1.5 2H   |
| TLM DOWN + all drifting  | Wrong market, goals still come | Over 1.5 FT    |
