'use strict';
// Generates static/data/goal_timing_summary.json — a small, browser-fetchable
// summary of the goals_time2 minute-level dataset, since the raw
// football-data/ files aren't deployed to the Cloudflare Pages static site
// (gitignored, Node-only). Run this once (or whenever goals_time2 is
// refreshed with new seasons) and commit the resulting JSON — it's tiny
// (a few KB) compared to the source data (1.4MB+ per file).
//
// Usage: node generate_goal_timing_summary.js

const fs = require('fs');
const path = require('path');
const { buildGoalTimingProfile, LEAGUE_FILE_PREFIX } = require('./goal_timing');

const OUT_FILE = path.resolve(__dirname, '../static/data/goal_timing_summary.json');
const SEASONS = 3;
const LATEST_SEASON = '2024-2025';

const summary = {};
for (const league of Object.keys(LEAGUE_FILE_PREFIX)) {
  const profile = buildGoalTimingProfile(league, { seasons: SEASONS, latestSeason: LATEST_SEASON });
  if (!profile) { console.log(`  ${league}: no data, skipped`); continue; }
  summary[league] = {
    seasons: profile.seasons,
    matchCount: profile.matchCount,
    totalGoals: profile.totalGoals,
    half: { h1Pct: profile.half.h1Pct, h2Pct: profile.half.h2Pct },
    bucketPct: profile.bucketPct,
  };
  console.log(`  ${league}: ${profile.matchCount} matches, ${profile.totalGoals} goals — 1H ${profile.half.h1Pct.toFixed(1)}% / 2H ${profile.half.h2Pct.toFixed(1)}%`);
}

fs.writeFileSync(OUT_FILE, JSON.stringify({ generatedAt: new Date().toISOString(), seasons: SEASONS, leagues: summary }, null, 2));
console.log(`\nWrote ${OUT_FILE}`);
