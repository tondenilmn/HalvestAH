'use strict';
/**
 * Strategy PRICEGAP — pre-match Bet365 price ≥ X% above Sbobet's de-vigged
 * fair price on the SAME line (Asian handicap / goals O-U), both current.
 * The Telegram version of the web app's SCANNER tab (static/scan.js) — same
 * comparison, same buckets, same backtest numbers.
 *
 * Backtest (CrossBooks, 14 months, AH + O/U, same line — see CLAUDE.md
 * "Match Tab"): Bet365 opening ≥3% above Sbobet opening fair → +4.8% ROI
 * (13/14 months), ≥5% → +6.4% (12/14); closing vs closing ≥5% → +6.2%
 * (10/14), AH-only ≥5% → +9.3% (12/14). Bet365 moves toward Sbobet ~80% of
 * the time, so the alert is only worth something if acted on quickly.
 *
 * Pure functions only (no network, no Telegram) so it can be tested without
 * requiring notify.js — see test_pricegap.js.
 */

const num = x => (typeof x === 'number' && isFinite(x)) ? x : null;
const sameLine = (a, b) => num(a) != null && num(b) != null && Math.abs(a - b) < 0.01;

// Two-way margin removal (proportional): decimal prices → fair decimal prices.
function devig2(a, b) {
  if (!(a > 1) || !(b > 1)) return null;
  const pa = 1 / a, pb = 1 / b, s = pa + pb;
  return [s / pa, s / pb];
}

// Both books still on their opening line AND price for this market — the
// backtest's "opening" bucket; anything else is the closing-type bucket.
function marketUnmoved(b, s, market) {
  const keys = market === 'AH' ? ['ah_h', 'ho_', 'ao_'] : ['tl_', 'ov_', 'un_'];
  return [b, s].every(x => keys.every(k => num(x[k + 'c']) != null && Math.abs(x[k + 'c'] - x[k + 'o']) < 0.001));
}

// Fractional Kelly stake as a share of bankroll.
function kelly(p, price, fraction) {
  const b = price - 1;
  if (!(b > 0)) return 0;
  return Math.max(0, (p * b - (1 - p)) / b) * fraction;
}

const fmtLine = x => (x > 0 ? '+' : '') + (Math.abs(x) < 1e-9 ? '0' : x);

/**
 * Every same-line gap for one match. `b365` / `sbo` carry the botbot3 odds
 * shape: { ah_hc, ah_ho, ho_c, ho_o, ao_c, ao_o, tl_c, tl_o, ov_c, ov_o, un_c, un_o }
 * (ah_hc = home handicap, negative = home gives). `teams` = { home, away }.
 * Returns rows { market, side, label, line, price, fair, edge, p, openPrice, unmoved }.
 */
function findGaps(b365, sbo, teams = {}) {
  const rows = [];
  if (!b365 || !sbo) return rows;
  const add = (market, side, label, line, price, fair, openPrice) => {
    if (!(price > 1) || !(fair > 1)) return;
    rows.push({ market, side, label, line, price, fair, edge: price / fair - 1, p: 1 / fair, openPrice,
                unmoved: marketUnmoved(b365, sbo, market) });
  };
  if (sameLine(b365.ah_hc, sbo.ah_hc)) {
    const f = devig2(sbo.ho_c, sbo.ao_c);
    if (f) {
      add('AH', 'home', `${teams.home || 'Home'} ${fmtLine(b365.ah_hc)}`, b365.ah_hc, b365.ho_c, f[0], b365.ho_o);
      add('AH', 'away', `${teams.away || 'Away'} ${fmtLine(-b365.ah_hc)}`, b365.ah_hc, b365.ao_c, f[1], b365.ao_o);
    }
  }
  if (sameLine(b365.tl_c, sbo.tl_c)) {
    const f = devig2(sbo.ov_c, sbo.un_c);
    if (f) {
      add('OU', 'over', `Over ${b365.tl_c}`, b365.tl_c, b365.ov_c, f[0], b365.ov_o);
      add('OU', 'under', `Under ${b365.tl_c}`, b365.tl_c, b365.un_c, f[1], b365.un_o);
    }
  }
  return rows;
}

// Which backtest bucket the gap falls into, and what it measured there.
function bucketOf(r) {
  const e = r.edge * 100;
  if (r.unmoved) return { name: 'at opening', note: e >= 5 ? '≥5% at opening → +6.4% ROI, 12/14 months' : '≥3% at opening → +4.8% ROI, 13/14 months' };
  if (r.market === 'AH' && e >= 5) return { name: 'moved', note: 'AH ≥5% after movement → +9.3% ROI, 12/14 months' };
  if (e >= 5) return { name: 'moved', note: '≥5% after movement → +6.2% ROI, 10/14 months' };
  return { name: 'moved', note: '3-5% after movement → +2.4% ROI, 8/14 months (thin)' };
}

// Gaps worth an alert: edge within [minEdge, maxEdge) — above maxEdge it is
// almost always a stale or mistyped price, not value.
function qualifyingGaps(rows, minEdgePct, maxEdgePct) {
  return rows.filter(r => r.edge * 100 >= minEdgePct && r.edge * 100 < maxEdgePct).sort((a, b) => b.edge - a.edge);
}

/**
 * Telegram message (HTML). `esc` = the caller's HTML escaper; `toKickoffMin`
 * minutes to kick-off; `opts` = { threshold, kellyFraction, bankroll, appUrl }.
 */
function formatAlert(match, gaps, toKickoffMin, esc, opts = {}) {
  const thr = opts.threshold ?? 5;
  const ko = toKickoffMin == null ? '' : toKickoffMin < 90 ? `kick-off in ${Math.round(toKickoffMin)} min` : `kick-off in ${(toKickoffMin / 60).toFixed(1)} h`;
  const lines = [
    `💰 <b>PRICE GAP</b> — Bet365 above Sbobet's fair price`,
    ``,
    `⚽ <b>${esc(match.home_team)} vs ${esc(match.away_team)}</b>`,
    `🏆 ${esc(match.league) || '—'}${ko ? ` · ⏱ ${ko}` : ''}`,
    ``,
  ];
  for (const r of gaps) {
    const b = bucketOf(r);
    const minOdds = r.fair * (1 + thr / 100);
    const k = kelly(r.p, r.price, opts.kellyFraction ?? 0.25);
    const stake = opts.bankroll ? `€${(opts.bankroll * k).toFixed(2)}` : `${(k * 100).toFixed(2)}% of bankroll`;
    const moved = r.openPrice > 1 && Math.abs(r.price - r.openPrice) > 0.001 ? ` (opened ${r.openPrice.toFixed(2)})` : '';
    lines.push(
      `${r.market === 'AH' ? 'Asian handicap' : 'Goals'} · <b>${esc(r.label)}</b>`,
      `  Bet365 <b>${r.price.toFixed(2)}</b>${moved} · fair ${r.fair.toFixed(2)} · edge <b>+${(r.edge * 100).toFixed(1)}%</b>`,
      `  ✅ Bet only at ≥ <b>${minOdds.toFixed(2)}</b> · stake ${stake} (${opts.kellyFraction === 0.125 ? '⅛' : opts.kellyFraction === 0.5 ? '½' : '¼'} Kelly)`,
      `  📊 ${b.name}: ${b.note}`,
      ``,
    );
  }
  lines.push('⚠️ Bet365 usually corrects toward Sbobet fast — check the price before betting.');
  if (opts.appUrl && match.url) lines.push(`🔗 <a href="${esc(opts.appUrl)}">Open the app</a> · <a href="${esc(match.url)}">match page</a>`);
  else if (match.url) lines.push(`🔗 <a href="${esc(match.url)}">match page</a>`);
  return lines.join('\n');
}

// ── Gap recorder ─────────────────────────────────────────────────────────────
// One JSONL file per UTC day under `dir`: a heartbeat line per scan
// ({hb:{t, scope, koMin, koMax, compared, ok}}) followed by one line per
// recorded gap side. pricegap_report.js turns these into gap lifetimes.
const fs = require('fs');
const path = require('path');

function recordRow(match, r, toKickoffMin) {
  return { id: match.id, k: `${r.market}:${r.side}:${r.line}`, ko: Math.round(toKickoffMin),
           p: r.price, f: +r.fair.toFixed(3), e: +(r.edge * 100).toFixed(2), u: r.unmoved ? 1 : 0,
           lg: match.league || '', m: `${match.home_team} v ${match.away_team}` };
}

function appendRecord(dir, t, heartbeat, rows) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, new Date(t).toISOString().slice(0, 10) + '.jsonl');
    const lines = [JSON.stringify({ hb: heartbeat }), ...rows.map(r => JSON.stringify({ t, ...r }))];
    fs.appendFileSync(file, lines.join('\n') + '\n');
  } catch (e) {
    console.error(`PriceGap recorder: ${e.message}`);
  }
}

module.exports = { devig2, marketUnmoved, kelly, findGaps, bucketOf, qualifyingGaps, formatAlert, sameLine, recordRow, appendRecord };
