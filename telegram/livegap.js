'use strict';
/**
 * Strategy LIVEGAP — Bet365's in-play price ≥ X% above Pinnacle's live price
 * (margin removed) on the SAME line: the web app's MATCHES-tab Pinnacle check
 * as a Telegram alert, plus a silent recorder that measures whether such gaps
 * pay. Pure logic only (no network, no Telegram) — test_livegap.js tests it;
 * notify.js's runLiveGapScan wires it to the feeds.
 *
 * NOT BACKTESTED — there is no in-play price history. It is the in-play
 * analogue of the pre-match same-moment sharp-book check that did backtest
 * (Bet365 vs Sbobet; Pinnacle reproduced it on 13 months, 2026-10-05). The
 * recorder exists to measure it.
 *
 * Inputs:
 *   - Bet365 live prices: livescore.js fetchBet365LiveOddsMap (asianbetsoccer's
 *     "Bet365 Live" feed) — { ah_hc, ho_c, ao_c, tl_c, ov_c, un_c, x2_h, x2_x, x2_a }.
 *   - Pinnacle live lists: pinnacle_relay.js relayPayload() — raw guest-API
 *     markets + matchups, with their age.
 * Conventions (checked on both feeds 2026-10-03/04): in-play handicap counts
 * goals FROM NOW, the goal line is on the FULL-match total, AH line = home's.
 */

const num = x => (typeof x === 'number' && isFinite(x)) ? x : null;
const sameLine = (a, b) => num(a) != null && num(b) != null && Math.abs(a - b) < 0.01;
const dec = p => (typeof p === 'number' && p !== 0) ? +(p > 0 ? 1 + p / 100 : 1 + 100 / -p).toFixed(3) : null;
const fmtLine = x => (x > 0 ? '+' : '') + (Math.abs(x) < 1e-9 ? '0' : x);

// Proportional margin removal (Pinnacle's live margin is small, ~2-4%).
function devig(prices) {
  if (!prices.every(p => p > 1)) return null;
  const inv = prices.map(p => 1 / p), s = inv.reduce((a, b) => a + b, 0);
  return inv.map(q => s / q);
}

// ── Pinnacle: raw guest-API lists → one sheet per live match ────────────────
// Same shape and de-duplication as functions/api/pinnacle.js (keep in sync).
function pinnacleSheets(markets, matchups) {
  const byMatchup = new Map();
  for (const m of Array.isArray(markets) ? markets : []) {
    if (m.status !== 'open' || m.period !== 0 || !['moneyline', 'spread', 'total'].includes(m.type)) continue;
    if (!byMatchup.has(m.matchupId)) byMatchup.set(m.matchupId, []);
    byMatchup.get(m.matchupId).push(m);
  }
  const best = new Map();
  for (const g of Array.isArray(matchups) ? matchups : []) {
    if (g.units !== 'Regular' || g.participants?.length !== 2) continue;
    const list = byMatchup.get(g.id) || [];
    if (!list.length) continue;
    const [h, a] = ['home', 'away'].map(s => g.participants.find(p => p.alignment === s));
    if (!h || !a) continue;
    const key = `${h.name}|${a.name}`;
    if (best.has(key) && best.get(key).n >= list.length) continue;
    const ft = { ml: null, ah: [], ou: [] };
    for (const m of list) {
      const p = d => m.prices.find(x => x.designation === d);
      if (m.type === 'moneyline') {
        const hh = dec(p('home')?.price), dd = dec(p('draw')?.price), aa = dec(p('away')?.price);
        if (hh && dd && aa) ft.ml = { h: hh, d: dd, a: aa };
      } else if (m.type === 'spread') {
        const hh = p('home'), aa = p('away');
        if (hh && aa && typeof hh.points === 'number') ft.ah.push({ line: hh.points, h: dec(hh.price), a: dec(aa.price) });
      } else if (m.type === 'total') {
        const o = p('over'), u = p('under');
        if (o && u && typeof o.points === 'number') ft.ou.push({ line: o.points, o: dec(o.price), u: dec(u.price) });
      }
    }
    best.set(key, { n: list.length, m: {
      id: g.id, league: g.league?.name || '', home: h.name, away: a.name,
      score: { home: h.state?.score ?? null, away: a.state?.score ?? null },
      red: (h.state?.redCards ?? 0) + (a.state?.redCards ?? 0), ft,
    } });
  }
  return [...best.values()].map(v => v.m);
}

// ── Pairing a Bet365 match with Pinnacle's: team names + the SAME score ─────
const STOP = /\b(fc|cf|cd|sc|ud|ac|afc|club|de|del|la|the|fk|sk|nk|if|bk|sv|calcio|w|women|femenil)\b/g;
const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\(w\)/g, ' w ').replace(STOP, ' ').replace(/[^a-z0-9]/g, '');
function dice(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const g = s => { const m = new Map(); for (let i = 0; i < s.length - 1; i++) { const k = s.slice(i, i + 2); m.set(k, (m.get(k) || 0) + 1); } return m; };
  const ga = g(a), gb = g(b);
  let hit = 0;
  for (const [k, n] of ga) hit += Math.min(n, gb.get(k) || 0);
  return (2 * hit) / (a.length - 1 + b.length - 1);
}
// A different score means Pinnacle's copy is from before a goal — never pair it.
function findPinnacle(sheets, home, away, score) {
  let best = null;
  for (const m of sheets || []) {
    const sh = dice(m.home, home), sa = dice(m.away, away);
    if (Math.min(sh, sa) < 0.4) continue;
    if (score && m.score?.home != null && (m.score.home !== score.home || m.score.away !== score.away)) continue;
    const s = (sh + sa) / 2;
    if (!best || s > best.s) best = { m, s };
  }
  return best && best.s >= 0.7 ? best.m : null;
}

// ── Same-line comparison rows ───────────────────────────────────────────────
// Each row: { key, market, label, line, side, price (Bet365), fair, pin (Pinnacle's own price), edge }.
function gapRows(live, pm, teams = {}) {
  const rows = [];
  if (!live || !pm?.ft) return rows;
  const add = (market, side, label, line, price, fair, pin) => {
    if (!(price > 1) || !(fair > 1)) return;
    rows.push({ key: `${market}|${label}`, market, side, label, line, price, fair, pin, edge: price / fair - 1 });
  };
  const ml = pm.ft.ml;
  if (ml) {
    const f = devig([ml.h, ml.d, ml.a]);
    if (f) {
      add('1X2', 'home', `${teams.home || 'Home'} to win`, null, live.x2_h, f[0], ml.h);
      add('1X2', 'draw', 'Draw', null, live.x2_x, f[1], ml.d);
      add('1X2', 'away', `${teams.away || 'Away'} to win`, null, live.x2_a, f[2], ml.a);
    }
  }
  if (num(live.ah_hc) != null) {
    const ah = pm.ft.ah.find(x => sameLine(x.line, live.ah_hc));
    const f = ah && devig([ah.h, ah.a]);
    if (f) {
      add('AH', 'home', `${teams.home || 'Home'} ${fmtLine(live.ah_hc)} (goals from now)`, live.ah_hc, live.ho_c, f[0], ah.h);
      add('AH', 'away', `${teams.away || 'Away'} ${fmtLine(-live.ah_hc)} (goals from now)`, -live.ah_hc, live.ao_c, f[1], ah.a);
    }
  }
  if (num(live.tl_c) != null) {
    const ou = pm.ft.ou.find(x => sameLine(x.line, live.tl_c));
    const f = ou && devig([ou.o, ou.u]);
    if (f) {
      add('OU', 'over', `Over ${live.tl_c} (match total)`, live.tl_c, live.ov_c, f[0], ou.o);
      add('OU', 'under', `Under ${live.tl_c} (match total)`, live.tl_c, live.un_c, f[1], ou.u);
    }
  }
  return rows;
}

// ── Per-match state between scans: score/red-card changes, gap streaks ──────
// state: Map matchId → { score, red, changedAt, gaps: Map key → { first, last, n } }
function updateMatchState(state, id, score, red, now) {
  let s = state.get(id);
  const sc = score ? `${score.home}-${score.away}` : null;
  if (!s) { s = { score: sc, red, changedAt: now, firstSeen: now, gaps: new Map() }; state.set(id, s); return s; }
  if ((sc && sc !== s.score) || (red != null && s.red != null && red !== s.red)) { s.changedAt = now; s.gaps.clear(); }
  if (sc) s.score = sc;
  if (red != null) s.red = red;
  return s;
}
// Records which rows are ≥ minEdge this scan; a gap's streak continues only if
// it was also there on the previous scan (≤ maxGapMs ago).
function trackGaps(s, rows, minEdge, now, maxGapMs) {
  const next = new Map();
  for (const r of rows) {
    if (r.edge < minEdge) continue;
    const p = s.gaps.get(r.key);
    const cont = p && now - p.last <= maxGapMs;
    next.set(r.key, { first: cont ? p.first : now, last: now, n: cont ? p.n + 1 : 1 });
  }
  s.gaps = next;
  return next;
}

/**
 * Alert decision for one row. opts: { minEdge, maxEdge, minScans, quietMs,
 * maxMinute, pinAgeS, maxPinAgeS }. Returns null (send) or the reason not to.
 */
function blockReason(r, s, minute, now, opts) {
  if (r.edge < opts.minEdge) return 'below threshold';
  if (r.edge >= opts.maxEdge) return 'gap too large — usually a stale or suspended price';
  if (!(opts.pinAgeS <= opts.maxPinAgeS)) return `Pinnacle prices ${Math.round(opts.pinAgeS)} s old`;
  if (minute != null && minute > opts.maxMinute) return `minute ${minute} > ${opts.maxMinute}`;
  if (now - s.changedAt < opts.quietMs) return 'goal / red card / first sight less than quiet window ago';
  const g = s.gaps.get(r.key);
  if (!g || g.n < opts.minScans) return `seen on ${g ? g.n : 0} scan(s), need ${opts.minScans}`;
  return null;
}

// Fractional Kelly stake as a share of bankroll.
function kelly(p, price, fraction) {
  const b = price - 1;
  if (!(b > 0)) return 0;
  return Math.max(0, (p * b - (1 - p)) / b) * fraction;
}

function formatAlert(match, minuteText, rows, pinAgeS, esc, opts = {}) {
  const thr = opts.threshold ?? 5;
  const lines = [
    `⚡ <b>LIVE GAP</b> — Bet365 above Pinnacle live`,
    ``,
    `⚽ <b>${esc(match.home_team)} vs ${esc(match.away_team)}</b>`,
    `🏆 ${esc(match.league) || '—'}`,
    `⏱ ${esc(minuteText || '')} · score ${esc(match.score || '—')}`,
    ``,
  ];
  for (const r of rows) {
    const minOdds = r.fair * (1 + thr / 100);
    const k = kelly(1 / r.fair, r.price, opts.kellyFraction ?? 0.125);
    const stake = opts.bankroll ? `€${(opts.bankroll * k).toFixed(2)}` : `${(k * 100).toFixed(2)}% of bankroll`;
    lines.push(
      `🎯 <b>${esc(r.label)}</b>`,
      `  Bet365 now <b>${r.price.toFixed(2)}</b> · Pinnacle ${r.pin.toFixed(2)} (fair ${r.fair.toFixed(2)}) · edge <b>+${(r.edge * 100).toFixed(1)}%</b>`,
      `  ✅ Bet only at ≥ <b>${minOdds.toFixed(2)}</b> · stake ${stake}`,
      ``,
    );
  }
  lines.push(
    `🕒 Gap held on consecutive checks a minute apart · Pinnacle prices ${Math.round(pinAgeS)} s old`,
    `⚠️ NOT backtested (no in-play price history). Live prices move in seconds — check Bet365 before betting; skip if a goal or card just happened.`,
  );
  return lines.join('\n');
}

// ── Recorder ─────────────────────────────────────────────────────────────────
// One JSONL file per UTC day: a heartbeat per scan, every same-line row of a
// match that has (or had in the last followMs) a gap ≥ the recording floor,
// and the last score seen when a tracked match leaves the live list — enough
// to measure later who closed each gap and how the bets settled.
const fs = require('fs');
const path = require('path');
function appendRecords(dir, t, lines) {
  if (!lines.length) return;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, new Date(t).toISOString().slice(0, 10) + '.jsonl'), lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  } catch (e) { console.error(`LiveGap recorder: ${e.message}`); }
}
const recordRow = (t, match, minute, r, pinAgeS) => ({
  t, id: match.id, min: minute, sc: match.score, k: r.key, mk: r.market, side: r.side, line: r.line,
  p: r.price, pin: r.pin, f: +r.fair.toFixed(3), e: +(r.edge * 100).toFixed(2), pa: Math.round(pinAgeS),
  m: `${match.home_team} v ${match.away_team}`, lg: match.league || '',
});

module.exports = { devig, pinnacleSheets, findPinnacle, gapRows, updateMatchState, trackGaps, blockReason, kelly, formatAlert, appendRecords, recordRow, dice, dec };
