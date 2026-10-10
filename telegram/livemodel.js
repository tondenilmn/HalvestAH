'use strict';
/**
 * Strategy LIVEMODEL (shadow — records, never alerts): Bet365's in-play price
 * against the result distribution of similar historical matches.
 *
 * Similar matches = the Bet365 dataset rows with the same pre-match closing
 * favourite line and side (and closing total-line band when that leaves
 * enough rows). The dataset has only HT and FT scores, so the live state is
 * matched like this:
 *   1st half, minute m, score h-a: every row is weighted by the chance that,
 *     of its 1st-half goals, exactly h / a had been scored by minute m — each
 *     goal falls before m with probability 1 − r, r = the share of the half's
 *     goal mass still to come (the goals_time2 intensity curve + stoppage time,
 *     same as live_odds.js). Remaining goals = its other 1st-half goals + its
 *     2nd-half goals.
 *   Half-time / 2nd half: only rows with the same HT score, weighted the same
 *     way on their 2nd-half goals.
 * That gives a distribution of final scores (and of goals from now), which
 * prices every market Bet365 quotes in play exactly as it settles: 1X2 on the
 * final score, Asian handicap on goals from now, goal line on the final total,
 * quarter lines split. For each side: model fair odds, expected return at
 * Bet365's live price (edge), its standard error from the effective number of
 * similar matches, and Pinnacle's de-vigged fair on the same line if paired.
 *
 * Assumes a goal's timing within a half doesn't depend on the match beyond
 * its pre-match odds and the score — the same assumption computeLiveOdd makes.
 */

const INT_1H = [[0, 15, 0.907], [15, 30, 0.937], [30, 45, 1.156]];
const INT_2H = [[0, 15, 0.879], [15, 30, 0.874], [30, 45, 1.247]];
const IT = { 1: 2.40, 2: 5.07 };        // stoppage mass, in minutes of end-of-half intensity
const STOP_MIN = { 1: 2.65, 2: 3.72 };  // average real stoppage minutes
const VALID_LINES = [0, 0.25, 0.5, 0.75, 1, 1.25, 1.5];
const TL_BANDS = [['<2', null, 2], ['2-2.5', 2, 2.5], ['2.5-3', 2.5, 3], ['>3', 3, null]];
const MIN_ROWS = 300;     // pool before HT conditioning: below it, drop the TL band
const MIN_NEFF = 40;      // effective similar matches needed to price at all

const tlBandOf = v => (v == null ? null : (TL_BANDS.find(([, lo, hi]) => (lo == null || v >= lo) && (hi == null || v < hi)) || [])[0] ?? null);

function integrate(from, to, curve) {
  if (to <= from) return 0;
  let s = 0;
  for (const [a, b, m] of curve) s += Math.max(0, Math.min(b, to) - Math.max(a, from)) * m;
  return s;
}
// Share of a half's goal mass still to come, `played` minutes into it
// (> 45 = minutes into stoppage time).
function remainingShare(half, played) {
  const c = half === 1 ? INT_1H : INT_2H, end = c[c.length - 1][2];
  const total = integrate(0, 45, c) + end * IT[half];
  const reg = Math.min(45, Math.max(0, played)), extra = Math.max(0, played - 45);
  const rem = integrate(reg, 45, c) + end * IT[half] * Math.max(0, 1 - extra / STOP_MIN[half]);
  return Math.max(0, Math.min(1, rem / total));
}

const choose = (n, k) => { let r = 1; for (let i = 1; i <= k; i++) r = r * (n - k + i) / i; return r; };
const binom = (n, k, p) => (k < 0 || k > n ? 0 : choose(n, k) * p ** k * (1 - p) ** (n - k));

// Pre-match favourite line/side from Bet365's closing AH (as engine.processRow).
function favOf(odds) {
  const hc = +odds?.ah_hc;
  if (!isFinite(hc)) return null;
  let side;
  if (hc < -0.01) side = 'HOME'; else if (hc > 0.01) side = 'AWAY';
  else if (odds.ho_c > 1 && odds.ao_c > 1) side = odds.ho_c <= odds.ao_c ? 'HOME' : 'AWAY'; else return null;
  const line = VALID_LINES.find(v => Math.abs(Math.abs(hc) - v) < 0.13);
  return line === undefined ? null : { line, side };
}

// Per-row home/away goals by half.
function goals(r) {
  const home = r.fav_side === 'HOME';
  const h1 = home ? r.fav_ht : r.dog_ht, a1 = home ? r.dog_ht : r.fav_ht;
  return { h1, a1, h2: (home ? r.fav_ft : r.dog_ft) - h1, a2: (home ? r.dog_ft : r.fav_ft) - a1 };
}

// Pools per (line, side, TL band), cached per dataset.
const _pools = new WeakMap();
function pools(db, fav, band) {
  let c = _pools.get(db); if (!c) _pools.set(db, c = new Map());
  const k = `${fav.line}|${fav.side}|${band}`;
  if (!c.has(k)) {
    const lineRows = db.filter(r => r.fav_line === fav.line && r.fav_side === fav.side);
    c.set(k, { lineRows, bandRows: band ? lineRows.filter(r => tlBandOf(r.tl_c) === band) : [] });
  }
  return c.get(k);
}

/**
 * Weighted distribution of goals from now for one live state.
 * state: { minute, isHT, score: {home, away}, ht: {home, away} | null }
 * Returns { outcomes: [{rh, ra, w}], neff, pool, level } or { error }.
 */
function remainingDist(db, odds, state) {
  const fav = favOf(odds);
  if (!fav) return { error: 'no pre-match line' };
  const { minute, isHT, score } = state;
  if (!score || minute == null) return { error: 'no score/minute' };
  const second = isHT || minute > 45;
  if (second && !state.ht) return { error: 'no HT score' };
  const band = tlBandOf(odds.tl_c);
  const { lineRows, bandRows } = pools(db, fav, band);
  const tries = [[bandRows, 'line+TL'], [lineRows, 'line']];
  for (const [rows, level] of tries) {
    if (rows.length < MIN_ROWS && level !== 'line') continue;
    const out = [];
    let sw = 0, sw2 = 0;
    if (!second) {
      const r = remainingShare(1, minute);
      for (const row of rows) {
        const g = goals(row);
        const w = binom(g.h1, score.home, 1 - r) * binom(g.a1, score.away, 1 - r);
        if (w <= 0) continue;
        out.push({ rh: g.h1 - score.home + g.h2, ra: g.a1 - score.away + g.a2, w }); sw += w; sw2 += w * w;
      }
    } else {
      const r = isHT ? 1 : remainingShare(2, minute - 45);
      const s2h = score.home - state.ht.home, s2a = score.away - state.ht.away;
      if (s2h < 0 || s2a < 0) return { error: 'score below HT score' };
      for (const row of rows) {
        const g = goals(row);
        if (g.h1 !== state.ht.home || g.a1 !== state.ht.away) continue;
        const w = binom(g.h2, s2h, 1 - r) * binom(g.a2, s2a, 1 - r);
        if (w <= 0) continue;
        out.push({ rh: g.h2 - s2h, ra: g.a2 - s2a, w }); sw += w; sw2 += w * w;
      }
    }
    const neff = sw2 > 0 ? sw * sw / sw2 : 0;
    if (neff >= MIN_NEFF) return { outcomes: out.map(o => ({ ...o, w: o.w / sw })), neff, pool: rows.length, level };
  }
  return { error: 'too few similar matches' };
}

// Return per unit at `price` for one outcome (price = full win, 0 = loss).
const part = (x, price) => (x > 1e-9 ? price : x < -1e-9 ? 0 : 1);
const settle = (base, line, price) => (Math.abs(Math.abs(line * 4) % 2 - 1) < 1e-6
  ? (part(base + line - 0.25, price) + part(base + line + 0.25, price)) / 2 : part(base + line, price));
function returnOf(mk, side, line, score, o, price) {
  const fh = score.home + o.rh, fa = score.away + o.ra;
  if (mk === '1X2') return (side === 'home' ? fh > fa : side === 'away' ? fa > fh : fh === fa) ? price : 0;
  if (mk === 'OU') return side === 'over' ? settle(fh + fa, -line, price) : settle(-(fh + fa), line, price);
  if (mk === 'AH') { const d = o.rh - o.ra; return settle(side === 'home' ? d : -d, line, price); }
  return null;
}

// Every side Bet365 quotes live, priced against the distribution.
function sides(live) {
  const out = [];
  const add = (mk, side, line, price) => { if (price > 1) out.push({ mk, side, line, price }); };
  add('1X2', 'home', null, live.x2_h); add('1X2', 'draw', null, live.x2_x); add('1X2', 'away', null, live.x2_a);
  if (live.ah_hc != null && isFinite(live.ah_hc)) { add('AH', 'home', +live.ah_hc, live.ho_c); add('AH', 'away', -live.ah_hc, live.ao_c); }
  if (live.tl_c != null && isFinite(live.tl_c)) { add('OU', 'over', +live.tl_c, live.ov_c); add('OU', 'under', +live.tl_c, live.un_c); }
  return out;
}

function priceSides(dist, live, score) {
  const rows = [];
  for (const s of sides(live)) {
    // E(price) = A·price + B: A = full-win share, B = refunded share.
    let A = 0, B = 0, m = 0, m2 = 0;
    for (const o of dist.outcomes) {
      const at1 = returnOf(s.mk, s.side, s.line, score, o, 1), at2 = returnOf(s.mk, s.side, s.line, score, o, 2);
      const a = at2 - at1, b = at1 - a;
      A += o.w * a; B += o.w * b;
      const x = a * s.price + b; m += o.w * x; m2 += o.w * x * x;
    }
    if (A <= 1e-9) continue;
    const fair = (1 - B) / A;
    const se = Math.sqrt(Math.max(0, m2 - m * m) / dist.neff);
    rows.push({ ...s, key: `${s.mk}|${s.side}|${s.line ?? ''}`, fair, edge: m - 1, se, pWin: A, pPush: B });
  }
  return rows;
}

// Pinnacle's de-vigged fair for the same side, from livegap.gapRows output.
function pinnacleFairOf(gapRows, s) {
  const g = gapRows.find(r => r.market === s.mk && r.side === s.side && (s.line == null || Math.abs((r.line ?? 0) - s.line) < 1e-6));
  return g ? g.fair : null;
}

// ── Alerts (since 2026-10-08, user request) ──────────────────────────────────
// The rule the recorder's first two days pointed to: edge ≥ minEdge, still ≥
// minEdge after one standard error, not in the skip band (10–20% lost in every
// window while ≥ 20% and 5–10% paid — see livemodel_report), Bet365 price in
// minOdds–maxOdds, minute ≤ maxMinute. One alert per match (the first side
// that passes) — the "first bet per match" the report measures.
// Bet365 Live keeps serving a match's pre-goal prices for minutes after a goal
// (seen 2026-10-09: MC Alger 1-0 at 78'-83' still quoted goal line 0.5 and the
// 1X2 of a 0-0 — "MC Alger to win" 2.25 when the real price was ~1.10). Such a
// row is not bettable and its "edge" is fiction. Two contradictions give it
// away: a full-match goal line at or below the goals already scored, and —
// from half-time on — the leading side priced as the outsider.
function staleReason(odds, score, minute) {
  if (!odds || !score) return null;
  const g = score.home + score.away, lead = score.home - score.away;
  // Live slot showing the pre-match prices (Bet365 suspended — half-time, after
  // a goal): goal line, Over and Under prices all identical to pre-match, once
  // the match is far enough in (or a goal has gone in) that live must differ.
  const P = odds.pre;
  if (P && (g > 0 || (minute != null && minute >= 20)) && P.tl_c != null && odds.tl_c === P.tl_c && odds.ov_c === P.ov_c && odds.un_c === P.un_c
      && (odds.x2_h == null || P.x2_h == null || (odds.x2_h === P.x2_h && odds.x2_a === P.x2_a)))
    return `live prices identical to pre-match (goal line ${odds.tl_c} @${odds.ov_c}) — Bet365 live market suspended`;
  if (odds.tl_c != null && odds.tl_c <= g) return `goal line ${odds.tl_c} with ${g} goal(s) scored — price from before a goal`;
  if (lead !== 0 && minute != null && minute >= 45 && odds.x2_h > 1 && odds.x2_a > 1) {
    const leader = lead > 0 ? odds.x2_h : odds.x2_a, trailer = lead > 0 ? odds.x2_a : odds.x2_h;
    if (leader >= trailer) return `leading side at ${leader} vs ${trailer} — price from before a goal`;
  }
  return null;
}

function alertBlock(r, minute, o) {
  const e = r.edge * 100, se = r.se * 100;
  if (e < o.minEdge) return `edge +${e.toFixed(1)}% < ${o.minEdge}%`;
  if (o.maxEdge != null && e >= o.maxEdge) return `edge +${e.toFixed(1)}% ≥ ${o.maxEdge}% (almost always a stale price or news the model lacks)`;
  if (o.useSe && e - se < o.minEdge) return `edge − s.e. ${(e - se).toFixed(1)}% < ${o.minEdge}%`;
  if (o.skipFrom != null && e >= o.skipFrom && e < o.skipTo) return `edge in the skipped ${o.skipFrom}–${o.skipTo}% band`;
  if (r.price < o.minOdds || r.price > o.maxOdds) return `price ${r.price} outside ${o.minOdds}–${o.maxOdds}`;
  if (minute == null || minute > o.maxMinute) return `minute ${minute ?? '?'} > ${o.maxMinute}`;
  return null;
}
// Lowest Bet365 price that still clears the threshold (and the s.e. if used):
// E(price) = A·price + B ≥ 1 + edge.
const minPrice = (r, o) => (1 + o.minEdge / 100 + (o.useSe ? r.se : 0) - r.pPush) / r.pWin;

const MK_NAME = { '1X2': '1X2', AH: 'AH', OU: 'OU' };
function formatAlert(match, minuteText, r, dist, pinFair, esc, betText, kellyFn, o = {}) {
  const teams = { home: match.home_team || 'Home', away: match.away_team || 'Away' };
  const mo = minPrice(r, o), room = Math.max(0, r.price - mo);
  const k = kellyFn(1 / r.fair, r.price, o.kellyFraction ?? 0.125), pct = `${(k * 100).toFixed(2)}%`;
  const bet = betText({ market: MK_NAME[r.mk], side: r.side, line: r.line }, match, teams);
  return [
    `🧮 <b>${esc(teams.home)} v ${esc(teams.away)}</b>`,
    `⏱ ${esc(minuteText || '')} · ${esc(match.score || '—')} · ${esc(match.league) || '—'}`,
    ``,
    `🎯 <b>${esc(bet)}</b>`,
    `✅ <b>BET AT ${mo.toFixed(2)} OR HIGHER</b> · now ${r.price.toFixed(2)} → ${room < 0.03 ? '<b>bet immediately, no room</b>' : `room ${room.toFixed(2)}`}`,
    `💰 Stake ${o.bankroll ? `€${(o.bankroll * k).toFixed(2)} (${pct})` : `${pct} of bankroll`}`,
    `📊 Bet365 ${r.price.toFixed(2)} vs fair ${r.fair.toFixed(2)} → +${(r.edge * 100).toFixed(1)}% (±${(r.se * 100).toFixed(1)})`,
    `📚 From ~${Math.round(dist.neff)} similar matches at the same state${pinFair ? ` · Pinnacle fair ${pinFair.toFixed(2)}` : ''}`,
    ``,
    `🕒 Live model · one alert per match`,
  ].join('\n');
}

module.exports = { staleReason, remainingShare, remainingDist, priceSides, pinnacleFairOf, favOf, tlBandOf, returnOf, alertBlock, minPrice, formatAlert, MIN_NEFF };
