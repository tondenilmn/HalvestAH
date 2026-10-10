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
 * 1X2 (added 2026-10-04, telegram/backtest_pricegap_1x2.js — 20 months of
 * direct Bet365-vs-Sbobet 1X2, no model in between) is included on two
 * conditions, both forced in code rather than left to config:
 *   - only while BOTH books are still at their opening 1X2 price. Opening vs
 *     opening ≥5% → +6.2% ROI, 17/20 months; the same picks at Bet365's
 *     closing price → −9.0%, and closing vs closing → +0.1%. A moved 1X2
 *     market has no evidence behind it (X12_OPEN_ONLY).
 *   - power de-vig, never proportional — Sbobet's three-way margin is 12-14%
 *     and proportional de-vig of a margin that size manufactures edges on
 *     draws and dogs (see devigPower).
 * Its floor is X12_MIN_EDGE_PCT (5), the one threshold the backtest measured,
 * regardless of a lower PRICEGAP_MIN_EDGE_PCT.
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

// Three-way margin removal (power): p_i = q_i^k with k solved so Σ p_i = 1.
// For 1X2 only, and deliberately not devig2's proportional method — see the
// header, and static/fair_model.js's devigPower (the same function, kept in
// both places the way engine.js mirrors app.js).
function devigPower(odds) {
  if (!odds || odds.some(o => !(o > 1))) return null;
  const q = odds.map(o => 1 / o);
  const sum = k => q.reduce((a, x) => a + Math.pow(x, k), 0);
  let lo = 0.5, hi = 1.5;
  for (let i = 0; i < 60; i++) { const k = (lo + hi) / 2; if (sum(k) > 1) lo = k; else hi = k; }
  const p = q.map(x => Math.pow(x, (lo + hi) / 2));
  const t = p.reduce((a, b) => a + b, 0);
  return p.map(x => t / x);   // fair decimal odds, same shape devig2 returns
}

// 1X2 gates — see the header. Not configurable: outside these the backtest
// says there is nothing there.
const X12_OPEN_ONLY = true;
const X12_MIN_EDGE_PCT = 5;
const X12_SIDES = [['home', 'home'], ['draw', 'Draw'], ['away', 'away']];

// Both books still on their opening 1X2 price — the only bucket 1X2 pays in.
function x12Unmoved(b, s) {
  return [b, s].every(x => x && ['home', 'draw', 'away'].every(k =>
    num(x[k + '_c']) != null && num(x[k + '_o']) != null && Math.abs(x[k + '_c'] - x[k + '_o']) < 0.001));
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
function findGaps(b365, sbo, teams = {}, x12 = {}) {
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
  // 1X2 — the odds live on match.x2_odds, not match.odds (getDatanext1 vs
  // getData2), so the caller passes them in as { b, s }.
  const unmoved = x12Unmoved(x12.b, x12.s);
  if (x12.b && x12.s && (unmoved || !X12_OPEN_ONLY)) {
    const f = devigPower([x12.s.home_c, x12.s.draw_c, x12.s.away_c]);
    if (f) {
      X12_SIDES.forEach(([side, name], i) => {
        const who = side === 'draw' ? 'Draw' : (teams[side] || name);
        if (!(x12.b[side + '_c'] > 1) || !(f[i] > 1)) return;
        rows.push({
          market: 'X12', side, label: who, line: null,
          price: x12.b[side + '_c'], fair: f[i], edge: x12.b[side + '_c'] / f[i] - 1,
          p: 1 / f[i], openPrice: x12.b[side + '_o'], unmoved,
        });
      });
    }
  }
  return rows;
}

// Which backtest bucket the gap falls into, and what it measured there.
function bucketOf(r) {
  const e = r.edge * 100;
  if (r.market === 'X12') {
    return r.unmoved
      ? { name: 'at opening', note: '1X2 ≥5% at opening → +6.2% ROI, 17/20 months (−9.0% at closing prices — take it now)' }
      : { name: 'moved', note: '1X2 after movement → +0.1% over 20 months — no edge' };
  }
  if (r.unmoved) return { name: 'at opening', note: e >= 5 ? '≥5% at opening → +6.4% ROI, 12/14 months' : '≥3% at opening → +4.8% ROI, 13/14 months' };
  if (r.market === 'AH' && e >= 5) return { name: 'moved', note: 'AH ≥5% after movement → +9.3% ROI, 12/14 months' };
  if (e >= 5) return { name: 'moved', note: '≥5% after movement → +6.2% ROI, 10/14 months' };
  return { name: 'moved', note: '3-5% after movement → +2.4% ROI, 8/14 months (thin)' };
}

// Gaps worth an alert: edge within [minEdge, maxEdge) — above maxEdge it is
// almost always a stale or mistyped price, not value.
function qualifyingGaps(rows, minEdgePct, maxEdgePct) {
  return rows
    .filter(r => r.edge * 100 >= Math.max(minEdgePct, r.market === 'X12' ? X12_MIN_EDGE_PCT : 0))
    .filter(r => r.edge * 100 < maxEdgePct)
    .sort((a, b) => b.edge - a.edge);
}

const MARKET_SHORT = { AH: 'Asian handicap', OU: 'goals', X12: '1X2' };

// Kick-off as a date AND a time, in the reader's own timezone — a bet that
// needs placing before kick-off is useless without the date.
function kickoffLine(match, toKickoffMin, tz) {
  const when = match.kickoff_time
    ? new Date(match.kickoff_time).toLocaleString('it-IT', {
        timeZone: tz || 'Europe/Rome', weekday: 'short',
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
      })
    : null;
  const inWhen = toKickoffMin == null ? null
    : toKickoffMin < 90 ? `in ${Math.round(toKickoffMin)} min`
    : toKickoffMin < 48 * 60 ? `in ${(toKickoffMin / 60).toFixed(1)} h`
    : `in ${(toKickoffMin / 1440).toFixed(1)} days`;
  if (!when && !inWhen) return null;
  return `📅 ${when || '—'}${inWhen ? ` (${inWhen})` : ''}`;
}

/**
 * Telegram message (HTML). `esc` = the caller's HTML escaper; `toKickoffMin`
 * minutes to kick-off; `opts` = { threshold, kellyFraction, bankroll, appUrl,
 * displayTz }.
 *
 * Shape is deliberately one labelled line per thing the reader has to act on —
 * what to bet, the price Bet365 is showing, and the price below which the bet
 * is off — rather than a dense summary line (asked for 2026-10-04).
 */
// Bet365 search for the home team (2026-10-10, user-tested on bet365.it): Bet365's
// own match ids aren't in any feed we read, so a search one tap from the match is
// the closest link. Team-kind markers are dropped so the search finds the club.
function bet365SearchUrl(team, domain = process.env.BET365_DOMAIN || 'www.bet365.it') {
  const q = String(team || '').replace(/\((w|r)\)|\bU-?\d{2}\b|\bII\b/gi, ' ').replace(/\s+/g, ' ').trim();
  return q ? `https://${domain}/#/AX/K%5E${encodeURIComponent(q)}/` : null;
}
// "🔍 Bet365 · Match page" links (either may be missing).
function linksLine(match, esc) {
  const b = bet365SearchUrl(match.home_team);
  return [b ? `<a href="${esc(b)}">🔍 Bet365</a>` : null, match.url ? `<a href="${esc(match.url)}">Match page</a>` : null].filter(Boolean).join(' · ');
}

function formatAlert(match, gaps, toKickoffMin, esc, opts = {}) {
  // Simplified 2026-10-10 (user request): only what is needed to act — match,
  // kick-off, the bet, Bet365's price, the minimum price, edge and stake. The
  // fair price, opening price and backtest bucket live in /pricegap/report.
  const thr = opts.threshold ?? 5;
  const ko = kickoffLine(match, toKickoffMin, opts.displayTz);
  const kFrac = opts.kellyFraction ?? 0.25;
  const lines = [
    `🟢 <b>PRICE GAP</b> · ${esc(match.league) || '—'}`,
    `⚽ <b>${esc(match.home_team)} vs ${esc(match.away_team)}</b>`,
    ...(ko ? [ko] : []),
    ``,
  ];
  for (const r of gaps) {
    const minOdds = r.fair * (1 + (r.market === 'X12' ? Math.max(thr, X12_MIN_EDGE_PCT) : thr) / 100);
    const k = kelly(r.p, r.price, kFrac);
    const stake = opts.bankroll ? `€${(opts.bankroll * k).toFixed(2)}` : `${(k * 100).toFixed(1)}% of bankroll`;
    lines.push(
      `👉 <b>${esc(r.label)}</b> (${MARKET_SHORT[r.market] || r.market}) @ <b>${r.price.toFixed(2)}</b>`,
      `   min ${minOdds.toFixed(2)} · edge +${(r.edge * 100).toFixed(1)}% · stake ${stake}`,
    );
  }
  const links = linksLine(match, esc);
  lines.push('', 'Check the price on Bet365 first — skip it below the min.', ...(links ? [links] : []));
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

module.exports = { bet365SearchUrl, linksLine, devig2, devigPower, marketUnmoved, x12Unmoved, kelly, findGaps, bucketOf, qualifyingGaps, formatAlert, kickoffLine, sameLine, recordRow, appendRecord, X12_MIN_EDGE_PCT, X12_OPEN_ONLY };
