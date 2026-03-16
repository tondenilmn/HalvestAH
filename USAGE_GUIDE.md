# Usage Guide — Game State Betting Tool

## What each mode does

### Basic mode
Filters only by:
- AH line (closing) — fav side is auto-derived
- TL closing value (optional)
- Odds tolerance (optional) — matches records where closing odds are within ±X of your input

All movement signals (line move, odds move, TL move) are set to ANY. Basic shows you the **raw base rates** for a given line and game state, without conditioning on market direction.

### Advanced mode
Adds movement signal filters on top of Basic:
- Line movement (DEEPER / STABLE / SHRANK) — auto-derived from AH closing vs opening
- Fav/Dog odds movement (STEAM / DRIFT / STABLE) — auto-derived from closing vs opening odds
- Over/Under movement — auto-derived from closing vs opening over/under odds
- TL movement (UP / DOWN / STABLE) — auto-derived from TL closing vs opening
- Tighter TL ranges

Advanced requires entering both closing **and** opening values so the tool can derive the signals automatically.

---

## Recommended workflow for a real match

### Step 1 — Run Config Discovery first

Before looking at your specific match, use the **Config Discovery** tab with only the AH line fixed (and optionally TL cluster). Leave everything else on ANY.

This sweeps all combinations of movement signals and returns which configurations have historically shown edge at the game state you are interested in. It tells you **which market signals to look for** in a real match.

> Only act on configs with z ≥ 2.0 and n ≥ 20 after game state filter.

---

### Step 2 — Use Basic as a sanity check

Run **Match Analysis → Basic** with just the AH line closing, TL closing, and game state. This gives you the unconditional base rates for this setup — how often each bet hits regardless of market movement.

If the base rates are already extreme (e.g. a bet hits 70%+ unconditionally), the signal is structural and Advanced filters may not add much.

---

### Step 3 — Use Advanced to apply the signals from Discovery

Switch to **Advanced** and enter both closing and opening values for AH odds, TL, and over/under. The tool auto-derives the movement signals and filters to records matching your match's specific market behaviour.

Check whether the signals in your match match any of the promising configs found in Step 1. If they do and z ≥ 2.0 with n ≥ 20: that is actionable.

**Do not use Advanced to search for a signal that Discovery did not surface.** Sweeping extra parameters until something looks significant is overfitting. Advanced is for confirming a signal you already identified, not for finding a new one.

---

## Minimum odds to bet

The tool shows three values for each bet:

| Value | Formula | Meaning |
|---|---|---|
| **Min odds** (face) | `1 / p` | Break-even at the observed hit rate |
| **Safe min** (midpoint) | `1 / ((p + CI_lo) / 2)` | Recommended threshold — balances optimism and conservatism |
| **Hard floor** (CI lo) | `1 / CI_lo` | Worst-case credible estimate — very conservative |

**Use the Safe min as your betting threshold.** Only enter a bet if the bookmaker odds are at or above this number. The hard floor is a reference: if a soft book beats even the hard floor, the opportunity is strong; if it only beats the face value but not the safe min, pass.

The safe min converges toward the face value as n grows — with large samples (n > 100) the two are nearly identical and conservatism fades naturally.

---

## Value hunting (no edge vs baseline)

Bets that do not pass z ≥ 1.5 / edge > 0 vs Pinnacle's baseline are shown in the **Value Hunting** section. These are not statistically significant against the sharp market, but they carry an implied fair odds estimate.

If a soft bookmaker or exchange offers odds above the **safe min** for one of these bets, that is positive EV against your sample estimate — even without a detected edge vs Pinnacle.

Be more cautious here:
- Require n ≥ 25 before acting on a value hunt bet
- Prefer bets where safe min and hard floor are close together (tight CI = reliable estimate)
- Treat this as a secondary scan, not your primary strategy

---

## Sample size rules of thumb

| n (after game state) | Interpretation |
|---|---|
| < 15 | Too small — do not act, results are noise |
| 15–29 | Marginal — only act on z ≥ 2.5 and wide odds margin above safe min |
| 30–59 | Usable — z ≥ 2.0 is sufficient |
| 60+ | Reliable — z ≥ 1.5 is actionable if edge is consistent across files |

The **stability** metric (spread of hit rates across CSV files) is your best check for whether a signal is real or a database artifact. A signal that holds across multiple seasons and leagues is more trustworthy than one driven by a single file.

---

## Quick checklist before placing a bet

- [ ] Config Discovery confirmed edge at this line / game state
- [ ] Advanced Match Analysis shows the same signal direction for your match
- [ ] n ≥ 20 after game state filter
- [ ] z ≥ 2.0 (or ≥ 1.5 with n ≥ 60)
- [ ] Bookmaker odds ≥ Safe min odds
- [ ] Signal is stable across multiple CSV files (low stability delta)
- [ ] Not acting on Advanced-only signals that Discovery did not surface
