# api-football.com — Bet365 Live Odds Integration Plan

## Goal
After each GSA Telegram alert fires, fetch the live Bet365 odds for the alerted bets from api-football.com and compare them against `mo_lo` (Wilson CI lower bound). Append the result to the alert message.

## api-football endpoints needed

### 1. Find the fixture ID
Match live fixtures by team names + date:
```
GET https://v3.football.api-sports.io/fixtures?live=all
Headers: x-apisports-key: YOUR_KEY
```
Returns all currently live fixtures. Match by home/away team name (fuzzy) and league.

### 2. Fetch live odds for a fixture
```
GET https://v3.football.api-sports.io/odds/live?fixture=FIXTURE_ID
Headers: x-apisports-key: YOUR_KEY
```
Returns live odds from all bookmakers including Bet365 (bookmaker id=8).

## Bet365 bookmaker ID
**id = 8** in api-football.

## Bet key → api-football bet mapping

| Our key | api-football bet name | api-football bet id |
|---|---|---|
| `over05_2H` | Goals Over/Under Second Half | 26 (Over 0.5) |
| `over15_2H` | Goals Over/Under Second Half | 26 (Over 1.5) |
| `under15_2H` | Goals Over/Under Second Half | 26 (Under 1.5) |
| `homeWinsFT` | Match Winner | 1 (Home) |
| `awayWinsFT` | Match Winner | 1 (Away) |
| `drawFT` | Match Winner | 1 (Draw) |
| `over15FT` | Goals Over/Under | 5 (Over 1.5) |
| `over25FT` | Goals Over/Under | 5 (Over 2.5) |
| `under25FT` | Goals Over/Under | 5 (Under 2.5) |
| `btts` | Both Teams Score | 8 (Yes) |
| `homeWins2H` | Second Half Winner | 13 (Home) |
| `awayWins2H` | Second Half Winner | 13 (Away) |
| `draw2H` | Second Half Winner | 13 (Draw) |
| `homeScored2H` | Team To Score — 2nd Half | not standard, may be unavailable |
| `favScored2H` | Team To Score — 2nd Half | not standard, may be unavailable |
| `favWins2H` | derive from home/away wins 2H based on fav_side | 13 |

Note: `homeScored2H`, `awayScored2H`, `favScored2H` are not standard bet365 markets on api-football. Skip these or mark as "no odds available".

## Implementation plan

### New file: `telegram/apifootball.js`
```javascript
// Responsibilities:
// 1. findFixtureId(homeTeam, awayTeam)  — search live fixtures, fuzzy match teams
// 2. fetchBet365Odds(fixtureId)         — fetch live odds for fixture, filter Bet365
// 3. getOddsForBet(bet365Data, betKey)  — extract specific odd for our bet key
```

### Changes to `notify.js`
After `qualifying` bets are determined and before `sendTelegram`:
```javascript
// Try to fetch Bet365 live odds (non-blocking — don't fail alert if API errors)
let bet365Odds = null;
try {
  const fixtureId = await findFixtureId(match.home_team, match.away_team);
  if (fixtureId) bet365Odds = await fetchBet365Odds(fixtureId);
} catch (e) {
  console.warn(`api-football fetch failed: ${e.message}`);
}

// Pass to formatter
const msg = formatMessage(match, newBets, matchCfg, homeGoals, awayGoals,
                          htSigRows.length, htBlRows.length, bet365Odds);
```

### Changes to `formatMessage`
Per bet, append Bet365 odds status:
```javascript
// If Bet365 odds available for this bet:
const b365 = bet365Odds ? getOddsForBet(bet365Odds, b.k) : null;
const oddsLine = b365
  ? (b365 >= parseFloat(b.mo_lo)
      ? `✅ Bet365: ${b365} (≥ ${b.mo_lo})`
      : `❌ Bet365: ${b365} (below ${b.mo_lo})`)
  : `⚪ Bet365: n/a`;
```

### Message output (example)
```
🔥 [2H] Over 0.5 in 2H
   78% vs 65% (+13.0pp)  ·  find ≥ 1.22  ·  n=31
   ✅ Bet365: 1.35 (≥ 1.22)

✅ [FT] Over 2.5 FT
   52% vs 41% (+11.0pp)  ·  find ≥ 1.78  ·  n=31
   ❌ Bet365: 1.65 (below 1.78)
```

## Team name fuzzy matching
api-football team names differ from Pinnacle (e.g. "Manchester City" vs "Man City").
Strategy:
1. Normalize: lowercase, remove "FC", "AFC", "CF", accents
2. Check if one name contains the other (substring match)
3. If no match, log warning and skip odds enrichment (don't block alert)

## API key
Add to `config.js`:
```javascript
APIFOOTBALL_KEY: process.env.APIFOOTBALL_KEY || null,
```
Set as Railway env var. If null, skip odds enrichment entirely.

## Rate limits
- Free plan: 100 requests/day
- Each alert = 2 requests (fixtures list + odds)
- At 3-min scan interval during HT window (~10 min), max ~4 alerts per match cycle = 8 requests
- Well within free tier for normal usage

## Future: pre-match fixture caching
To reduce requests, cache the fixture ID per match when first seen (pre-HT),
so the HT alert only needs 1 request (odds fetch) instead of 2.
