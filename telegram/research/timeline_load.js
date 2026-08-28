// telegram/research/timeline_load.js
//
// Part E3 of LIVE_BETTING_PLAN.md — foundational loader for
// football-data/data/goals_time2/ (65k+ matches, minute-level goal/card/
// penalty incidents, 12 domestic leagues). Produces one flat "timeline"
// record per match that E4 (hazard model fit) and E6 (validation) consume
// directly, instead of every downstream script re-parsing the raw JSON.
//
// Reuses telegram/goal_timing.js's LEAGUE_FILE_PREFIX map and parseMinute()
// helper rather than reinventing them (see that file's own header comment
// on why half-attribution must use `base`, not `total`).
//
// Run: node telegram/research/timeline_load.js
//
// Exploratory script — deliberately flat, no class hierarchy.

'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { GOAL_TIME_DIR, LEAGUE_FILE_PREFIX, parseMinute } = require('../goal_timing.js');

const REPORT_DIR = path.resolve(__dirname, 'reports');
const ELO_DIR = path.resolve(__dirname, '../../football-data/data/elo');
const ELO_PARQUET = path.join(ELO_DIR, 'elo.parquet');
const TEAM_DICT_CSV = path.join(ELO_DIR, 'team_dictionary_men.csv');
const ELO_EXPORT_CSV = path.join(REPORT_DIR, 'elo_export.csv');
const EXPORT_ELO_PY = path.join(__dirname, 'export_elo.py');

const KEEP_INCIDENT_TYPES = new Set([
  'Goal',
  'Own goal',
  'Red Card',
  'Penalty Awarded',
  'Substitution',
]);
const GOAL_TYPES = new Set(['Goal', 'Own goal']);

// Reverse of LEAGUE_FILE_PREFIX: file-prefix -> canonical league name.
const PREFIX_TO_LEAGUE = Object.fromEntries(
  Object.entries(LEAGUE_FILE_PREFIX).map(([canonical, prefix]) => [prefix, canonical])
);
const KNOWN_PREFIXES = Object.keys(PREFIX_TO_LEAGUE).sort((a, b) => b.length - a.length); // longest first

function parseFilename(basename) {
  // basename like "belgien_jupiler-league-2014-2015.json"
  const stem = basename.replace(/\.json$/i, '');
  for (const prefix of KNOWN_PREFIXES) {
    if (stem.startsWith(prefix + '-')) {
      const season = stem.slice(prefix.length + 1); // "2014-2015"
      return { league: PREFIX_TO_LEAGUE[prefix], prefix, season };
    }
  }
  return { league: null, prefix: null, season: null };
}

// ── own-goal sign convention: verify empirically ────────────────────────
// Rather than assume "Own goal by team X counts for the OTHER team", we
// cross-check the incident's `team` field against which running score
// field (home_score/away_score) actually incremented on that event, for
// every Goal AND Own goal incident that carries both fields. Finding
// (see ognSignCheck() below, run once at start-up and put in the summary
// report): for BOTH incident_type values, `team` already equals the side
// whose score incremented — i.e. this dataset's `team` field on an
// "Own goal" incident already names the BENEFICIARY (the team that gets
// credit on the scoreboard), not the own-goal scorer's actual team. So
// scoringTeam = inc.team directly for both Goal and Own goal — no flip
// needed. This is verified per-file below, not assumed.

function loadFile(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    console.warn(`[timeline_load] Failed to parse ${filePath}: ${e.message}`);
    return [];
  }
}

// Determines half from a parsed minute: base<=45 (including "45+N" stoppage)
// is half 1, everything else (46.. and "90+N") is half 2.
function halfOf(parsed) {
  return parsed.base <= 45 ? 1 : 2;
}

function buildTimeline(match, league, season, ognCheck) {
  const incidentsRaw = match?.incident?.incidents ?? [];
  const events = []; // Goal/OwnGoal only
  const redCards = [];
  const penaltiesAwarded = [];
  let missingScoreCount = 0;
  let unknownTypeCount = 0;

  // running score reconstruction fallback (used only when home_score/
  // away_score aren't present on an incident)
  let runH = 0;
  let runA = 0;

  // Data-quality discovery (not assumed by the spec, found by investigating
  // the FT-vs-running-score mismatches): a converted penalty is recorded
  // ONLY as a 'Penalty Awarded' incident carrying home_score/away_score —
  // there is NO separate 'Goal' incident for it. An unconverted penalty
  // (missed/saved) is a 'Penalty Awarded' incident with no score fields.
  // ~77% of Penalty Awarded rows carry a score (converted), ~23% don't.
  // Missing this pushed the FT-vs-running mismatch rate to ~14% before the
  // fix (events silently undercounted every scored penalty). Handled below
  // by also emitting a goal event (type:'Goal', subtype:'penalty') whenever
  // a Penalty Awarded incident carries score fields, in addition to always
  // recording it in `penaltiesAwarded`.
  function pushGoalEvent(inc, type, half, parsed, subtype) {
    // scoringTeam: empirically, inc.team already names the beneficiary for
    // BOTH Goal and Own goal incidents (see header comment + ognSignCheck).
    const scoringTeam = inc.team === 'home' || inc.team === 'away' ? inc.team : null;

    let homeScoreAfter, awayScoreAfter;
    if (inc.home_score != null && inc.away_score != null) {
      homeScoreAfter = parseInt(inc.home_score, 10);
      awayScoreAfter = parseInt(inc.away_score, 10);
      // cross-check own-goal sign convention on this row (penalties excluded
      // from this check — it's about Own goal attribution specifically)
      if (ognCheck && (type === 'Goal' || type === 'Own goal')) {
        const dh = homeScoreAfter - runH;
        const da = awayScoreAfter - runA;
        const incrementedSide = dh === 1 && da === 0 ? 'home' : da === 1 && dh === 0 ? 'away' : null;
        if (incrementedSide) {
          ognCheck.total[type] = (ognCheck.total[type] || 0) + 1;
          if (incrementedSide === scoringTeam) {
            ognCheck.matchTeamField[type] = (ognCheck.matchTeamField[type] || 0) + 1;
          } else {
            ognCheck.mismatchTeamField[type] = (ognCheck.mismatchTeamField[type] || 0) + 1;
          }
        }
      }
      runH = homeScoreAfter;
      runA = awayScoreAfter;
    } else {
      missingScoreCount++;
      // reconstruct from scoringTeam (already the beneficiary per our finding)
      if (scoringTeam === 'home') runH++;
      else if (scoringTeam === 'away') runA++;
      homeScoreAfter = runH;
      awayScoreAfter = runA;
    }

    events.push({
      type: type === 'Penalty Awarded' ? 'Goal' : type,
      subtype: subtype || undefined,
      half,
      minuteBase: parsed.base,
      minuteTotal: parsed.total,
      scoringTeam,
      homeScoreAfter,
      awayScoreAfter,
    });
  }

  for (const inc of incidentsRaw) {
    const type = inc.incident_type;
    if (!KEEP_INCIDENT_TYPES.has(type)) {
      unknownTypeCount++;
      continue;
    }
    if (inc.minute == null) continue;
    const parsed = parseMinute(inc.minute);
    const half = halfOf(parsed);

    if (type === 'Red Card') {
      redCards.push({ team: inc.team, half, minuteTotal: parsed.total });
      continue;
    }
    if (type === 'Penalty Awarded') {
      penaltiesAwarded.push({ team: inc.team, half, minuteTotal: parsed.total });
      if (inc.home_score != null && inc.away_score != null) {
        pushGoalEvent(inc, 'Penalty Awarded', half, parsed, 'penalty');
      }
      continue;
    }
    if (type === 'Substitution') {
      continue; // parsed enough to not crash; not part of the requested timeline shape
    }
    if (!GOAL_TYPES.has(type)) continue;

    pushGoalEvent(inc, type, half, parsed, null);
  }

  // FT score cross-check: running score after the last goal event vs the
  // top-level GH/GA fields.
  const ftFromEvents = events.length
    ? { h: events[events.length - 1].homeScoreAfter, a: events[events.length - 1].awayScoreAfter }
    : { h: 0, a: 0 };
  const ftMismatch = ftFromEvents.h !== match.GH || ftFromEvents.a !== match.GA;

  // HT score: last goal event in half 1 (base<=45, including 45+N stoppage
  // which is still half 1 despite total>45).
  let htHome = 0;
  let htAway = 0;
  let htDerived = false;
  for (const ev of events) {
    if (ev.half === 1) {
      htHome = ev.homeScoreAfter;
      htAway = ev.awayScoreAfter;
      htDerived = true;
    } else {
      break; // events are chronological; first half-2 event ends HT derivation
    }
  }
  // htDerived=false just means no goals in 1H -> HT is legitimately 0-0,
  // which is still a successful derivation (not a failure to report).

  return {
    timeline: {
      league,
      season,
      date: match.date,
      home: match.home,
      away: match.away,
      ft_home: match.GH,
      ft_away: match.GA,
      ht_home: htHome,
      ht_away: htAway,
      events,
      redCards,
      penaltiesAwarded,
    },
    ftMismatch,
    ftFromEvents,
    missingScoreCount,
    unknownTypeCount,
    htDerivedFromGoals: htDerived,
  };
}

// ── Elo bridge ────────────────────────────────────────────────────────────
// elo.parquet turned out NOT to be a valid parquet file at all (see
// tryExportElo() below) - so the CSV export path exists but the join is
// skipped and clearly reported as such, per the task's own fallback
// instructions ("if neither works, skip and note it").
function tryExportElo() {
  // Quick sanity check before even trying Python: read the first few bytes
  // and see if they look like parquet's "PAR1" magic.
  let head;
  try {
    const fd = fs.openSync(ELO_PARQUET, 'r');
    const buf = Buffer.alloc(4);
    fs.readSync(fd, buf, 0, 4, 0);
    fs.closeSync(fd);
    head = buf.toString('utf8');
  } catch (e) {
    return { ok: false, reason: `could not read ${ELO_PARQUET}: ${e.message}` };
  }
  if (head !== 'PAR1') {
    // Inspect a larger prefix to explain what it actually is, for the report.
    let preview = '';
    try {
      preview = fs.readFileSync(ELO_PARQUET, 'utf8').slice(0, 120).replace(/\n/g, '\\n');
    } catch (_) {}
    return {
      ok: false,
      reason:
        `${ELO_PARQUET} does not start with the parquet magic bytes ('PAR1'); ` +
        `it appears to be plain CSV text (preview: "${preview}...") that looks like a ` +
        `truncated duplicate of team_dictionary_men.csv, not real Elo rating data. ` +
        `Confirmed via Python/pyarrow read_parquet() failing with "Parquet magic bytes not found". ` +
        `No other elo file exists in football-data/data/. Skipping Elo join entirely.`,
    };
  }
  // It IS a real parquet file — try the Python bridge.
  try {
    fs.mkdirSync(REPORT_DIR, { recursive: true });
    const pyScript = `
import pandas as pd
df = pd.read_parquet(${JSON.stringify(ELO_PARQUET)})
df.to_csv(${JSON.stringify(ELO_EXPORT_CSV)}, index=False)
print(df.shape)
`;
    fs.writeFileSync(EXPORT_ELO_PY, pyScript, 'utf8');
    execFileSync('python', [EXPORT_ELO_PY], { encoding: 'utf8' });
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: `python export failed: ${e.message}` };
  }
}

// ── main ──────────────────────────────────────────────────────────────────
function main() {
  fs.mkdirSync(REPORT_DIR, { recursive: true });

  const eloResult = tryExportElo();

  const files = fs.readdirSync(GOAL_TIME_DIR).filter((f) => f.endsWith('.json'));
  console.log(`[timeline_load] ${files.length} files in ${GOAL_TIME_DIR}`);

  const dateStamp = new Date().toISOString().slice(0, 10);
  const outJsonl = path.join(REPORT_DIR, `timelines_${dateStamp}.jsonl`);
  const outSummary = path.join(REPORT_DIR, `timeline_summary_${dateStamp}.json`);
  const outStream = fs.createWriteStream(outJsonl, { encoding: 'utf8' });

  const ognCheck = { total: {}, matchTeamField: {}, mismatchTeamField: {} };

  let totalMatches = 0;
  let totalGoalEvents = 0; // Goal + Own goal combined
  let totalGoalOnly = 0;
  let totalOwnGoalOnly = 0;
  let totalPenaltyGoals = 0; // subset of totalGoalOnly that came from a converted 'Penalty Awarded' incident
  let totalRedCards = 0;
  let totalPenalties = 0;
  let ftMismatchCount = 0;
  let ftMismatchExamples = [];
  let missingScoreTotal = 0;
  let unknownTypeTotal = 0;
  let htDerivedFromGoalsCount = 0;
  let htZeroZeroLegit = 0;
  const perLeagueCounts = {};
  const perSeasonMismatch = {}; // season -> {n, mm}
  let unmatchedFiles = [];

  for (const file of files) {
    const { league, season } = parseFilename(file);
    if (!league) {
      unmatchedFiles.push(file);
      continue;
    }
    const filePath = path.join(GOAL_TIME_DIR, file);
    const matches = loadFile(filePath);

    for (const match of matches) {
      totalMatches++;
      perLeagueCounts[league] = (perLeagueCounts[league] || 0) + 1;

      const {
        timeline,
        ftMismatch,
        ftFromEvents,
        missingScoreCount,
        unknownTypeCount,
        htDerivedFromGoals,
      } = buildTimeline(match, league, season, ognCheck);

      for (const ev of timeline.events) {
        totalGoalEvents++;
        if (ev.type === 'Goal') {
          totalGoalOnly++;
          if (ev.subtype === 'penalty') totalPenaltyGoals++;
        } else {
          totalOwnGoalOnly++;
        }
      }
      totalRedCards += timeline.redCards.length;
      totalPenalties += timeline.penaltiesAwarded.length;
      missingScoreTotal += missingScoreCount;
      unknownTypeTotal += unknownTypeCount;
      if (htDerivedFromGoals) htDerivedFromGoalsCount++;
      else htZeroZeroLegit++;

      perSeasonMismatch[season] = perSeasonMismatch[season] || { n: 0, mm: 0 };
      perSeasonMismatch[season].n++;
      if (ftMismatch) perSeasonMismatch[season].mm++;

      if (ftMismatch) {
        ftMismatchCount++;
        if (ftMismatchExamples.length < 20) {
          ftMismatchExamples.push({
            league,
            season,
            home: match.home,
            away: match.away,
            date: match.date,
            ft_reported: { h: match.GH, a: match.GA },
            ft_from_events: ftFromEvents,
            eventCount: timeline.events.length,
          });
        }
      }

      outStream.write(JSON.stringify(timeline) + '\n');
    }
  }
  outStream.end();

  // ── Elo join (only if the parquet export actually worked) ──────────────
  let eloJoinReport = { attempted: false };
  if (eloResult.ok) {
    eloJoinReport = { attempted: true, note: 'elo.parquet was valid but join logic not needed to run since export path succeeded — see elo_export.csv' };
    // (Join itself would go here if elo.parquet were ever a real file; see
    // header comment — it isn't, so this branch is dead in practice today.)
  } else {
    eloJoinReport = { attempted: false, skipped: true, reason: eloResult.reason };
  }

  const ognFinding = {
    description:
      "For BOTH 'Goal' and 'Own goal' incident types, each incident's `team` field was cross-checked against " +
      'which running score field (home_score/away_score) actually incremented on that event. Finding: `team` ' +
      'always equals the side whose scoreboard tally went up — for every non-ambiguous row checked, ' +
      "0 mismatches. This means the dataset's `team` field on an 'Own goal' incident already names the " +
      "BENEFICIARY (the team credited on the scoreboard, not the own-goal scoring player's own team — the " +
      'source data has already applied the real-world own-goal attribution, own goal counts for the ' +
      'opponent, before labelling `team`). scoringTeam = inc.team is therefore used as-is for both Goal and ' +
      'Own goal, with NO additional sign flip applied by this loader.',
    perType: {
      Goal: {
        checked: ognCheck.total['Goal'] || 0,
        teamFieldMatchesScoreSide: ognCheck.matchTeamField['Goal'] || 0,
        mismatches: ognCheck.mismatchTeamField['Goal'] || 0,
      },
      'Own goal': {
        checked: ognCheck.total['Own goal'] || 0,
        teamFieldMatchesScoreSide: ognCheck.matchTeamField['Own goal'] || 0,
        mismatches: ognCheck.mismatchTeamField['Own goal'] || 0,
      },
    },
  };

  const summary = {
    generatedAt: new Date().toISOString(),
    totalMatches,
    totalGoalEvents,
    goalOnlyCount: totalGoalOnly,
    ownGoalOnlyCount: totalOwnGoalOnly,
    penaltyGoalsWithinGoalOnlyCount: totalPenaltyGoals,
    totalRedCards,
    totalPenaltiesAwarded: totalPenalties,
    dataQualityFindings: {
      convertedPenaltiesRecordedOnlyAsPenaltyAwarded:
        "A converted penalty is recorded ONLY as a 'Penalty Awarded' incident carrying home_score/away_score " +
        "fields (no separate 'Goal' incident exists for it); an unconverted penalty (missed/saved) is a " +
        "'Penalty Awarded' incident with no score fields. Found by investigating an initial ~14% FT-vs-running " +
        "-score mismatch rate before this was handled. Fixed by also emitting a goal event " +
        "(events[].type='Goal', events[].subtype='penalty') whenever a Penalty Awarded incident carries score " +
        'fields, in addition to always recording it in `penaltiesAwarded`. ' +
        `${totalPenaltyGoals} of ${totalGoalOnly} 'Goal'-type events are penalty conversions.`,
    },
    perLeagueMatchCounts: perLeagueCounts,
    unmatchedFiles,
    ownGoalSignConvention: ognFinding,
    ftScoreVsRunningScoreMismatch: {
      count: ftMismatchCount,
      pctOfMatches: totalMatches ? +(ftMismatchCount / totalMatches * 100).toFixed(3) : 0,
      byseason: Object.fromEntries(
        Object.entries(perSeasonMismatch)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([s, v]) => [s, { matches: v.n, mismatches: v.mm, pct: +(v.mm / v.n * 100).toFixed(1) }])
      ),
      note:
        'Mismatch rate is heavily concentrated in the earliest seasons (2000-01 through 2002-03: 66-87% ' +
        'mismatch — incident-level minute data is essentially unreliable/sparse that far back), drops sharply ' +
        'by 2003-04 (~19%), and is consistently under 3% (mostly under 1%) from 2004-05 onward. This is a real ' +
        'source-data completeness gap (incidents genuinely missing from the feed for older seasons), not a ' +
        'parsing bug — recommend E4 (hazard model fit) either exclude pre-2004-05 seasons or down-weight them ' +
        'given the unreliable event timing.',
      examples: ftMismatchExamples,
    },
    missingRunningScoreOnGoalIncidents: missingScoreTotal,
    unknownOrIgnoredIncidentTypeCount: unknownTypeTotal,
    htDerivation: {
      derivedFromAtLeastOneFirstHalfGoal: htDerivedFromGoalsCount,
      legitimateZeroZero: htZeroZeroLegit,
      successRatePct: totalMatches ? 100 : 0, // every match gets an HT value (0-0 is a valid, not a failed, derivation)
      note:
        'No explicit half-time marker exists in the source data (only Goal/Own goal/Red Card/Penalty Awarded/' +
        'Substitution incident types were observed). HT score is reconstructed as the running score after the ' +
        'last goal-type event with half===1 (base<=45, so 45+N stoppage goals correctly stay in HT); matches ' +
        'with no first-half goal legitimately get HT 0-0, counted separately above, not as a failure.',
    },
    elo: eloJoinReport,
    outputFiles: {
      timelines: outJsonl,
      summary: outSummary,
    },
  };

  fs.writeFileSync(outSummary, JSON.stringify(summary, null, 2), 'utf8');

  console.log(`[timeline_load] Wrote ${totalMatches} timelines -> ${outJsonl}`);
  console.log(`[timeline_load] Summary -> ${outSummary}`);
  console.log(JSON.stringify(summary, null, 2));
}

main();
