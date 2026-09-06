'use strict';
// Empirical check: does match.bet365_odds (ah_hc/ho_c/ao_c/tl_c/ov_c/un_c)
// actually update as a live match progresses, or is it frozen at the
// pre-kickoff closing line (as static/app.js's buildRawCfgFromLiveOdds header
// comment and notify.js's NEWMODEL comment both claim)? Polls fetchLiveMatches()
// twice, several minutes apart, and diffs the odds for matches present both
// times. Run manually: `node debug_live_price_freshness.js`.

const { fetchLiveMatches } = require('./livescore.js');

function snapshot(matches) {
  const map = new Map();
  for (const m of matches) {
    if (!m.id || !m.odds) continue;
    map.set(m.id, { minute: m.minute, home: m.home_team, away: m.away_team, odds: { ...m.odds } });
  }
  return map;
}

function diffOdds(a, b) {
  const fields = ['ah_hc', 'ah_ho', 'ho_c', 'ho_o', 'ao_c', 'ao_o', 'tl_c', 'tl_o', 'ov_c', 'ov_o', 'un_c', 'un_o'];
  const changed = [];
  for (const f of fields) {
    if (a[f] !== b[f]) changed.push(`${f}: ${a[f]} -> ${b[f]}`);
  }
  return changed;
}

const WAIT_MS = 6 * 60 * 1000; // 6 minutes between polls

async function main() {
  console.log('Poll #1: fetching live matches…');
  const { matches: m1 } = await fetchLiveMatches();
  const snap1 = snapshot((m1 || []).filter(m => m.minute != null));
  console.log(`Poll #1: ${snap1.size} live matches with odds captured.`);
  for (const [id, s] of snap1) {
    console.log(`  ${s.home} vs ${s.away} — ${s.minute}' — ah_hc=${s.odds.ah_hc} ho_c=${s.odds.ho_c} ao_c=${s.odds.ao_c} tl_c=${s.odds.tl_c} ov_c=${s.odds.ov_c} un_c=${s.odds.un_c}`);
  }

  console.log(`\nWaiting ${WAIT_MS / 60000} minutes before poll #2…`);
  await new Promise(r => setTimeout(r, WAIT_MS));

  console.log('\nPoll #2: fetching live matches…');
  const { matches: m2 } = await fetchLiveMatches();
  const snap2 = snapshot((m2 || []).filter(m => m.minute != null));
  console.log(`Poll #2: ${snap2.size} live matches with odds captured.\n`);

  let stillLive = 0, anyChanged = 0;
  for (const [id, s1] of snap1) {
    const s2 = snap2.get(id);
    if (!s2) { console.log(`${s1.home} vs ${s1.away}: no longer in live feed (match ended or dropped).`); continue; }
    stillLive++;
    const changed = diffOdds(s1.odds, s2.odds);
    if (changed.length) {
      anyChanged++;
      console.log(`${s1.home} vs ${s1.away}: ${s1.minute}' -> ${s2.minute}' — CHANGED: ${changed.join(', ')}`);
    } else {
      console.log(`${s1.home} vs ${s1.away}: ${s1.minute}' -> ${s2.minute}' — no change in any odds field.`);
    }
  }

  console.log(`\nSummary: ${stillLive} matches still live at poll #2; ${anyChanged}/${stillLive} had ANY odds field change between polls.`);
  if (stillLive && anyChanged === 0) {
    console.log('CONCLUSION: odds are frozen post-kickoff for every match checked — confirms the code comments\' claim. Not safe to treat as a live price.');
  } else if (anyChanged > 0) {
    console.log('CONCLUSION: at least some odds fields DO update post-kickoff — the "frozen" comment may be stale or only true for some fields/leagues. Worth a closer look at which fields changed.');
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
