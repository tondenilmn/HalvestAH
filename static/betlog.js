/* ══════════════════════════════════════════════════════════════════════
   betlog.js — two helpers for the 📡 MATCHES tab's live picks:

   1. "Seen for N min" — how long each live gap (match + market + line) has
      stayed at or above the value threshold across consecutive refreshes.
      Most in-play gaps vanish within a refresh or two (one book a minute
      behind the other); one that survives a couple of refreshes is the kind
      worth checking on Bet365.

   2. Bet log — "＋ log" on a row records the bet (price taken, stake, the
      fair price and reference at that moment). Every refresh while the tab
      is open follows the same market: which side closed the gap afterwards
      (Bet365 coming down = your price beat the market; the reference moving
      up = the gap was mostly lag), and your price vs Bet365's later price.
      Follow-up stops at the first goal after the bet (prices after a goal
      say nothing about the price you took). When the match leaves the live
      feed at 88'+ the bet is settled from the last score seen; otherwise
      set the result by hand.

   Stored in this browser only (localStorage) — a phone and a laptop keep
   separate logs; "Export CSV" copies it out. Nothing here is backtested:
   the log is how the live picks get measured at all.

   Depends on: matches.js (_ml, _mlVisible, ML_POLL_MS, renderMatchesList),
   match.js (_mt, formatters, mtEsc).
   ══════════════════════════════════════════════════════════════════════ */

const BL_KEY = 'halvest_bet_log_v1';
const ML_SEEN_KEY = 'halvest_ml_seen_v1';

const gapKey = (m, r) => `${m.id || `${m.home_team}|${m.away_team}`}|${r.market}|${r.label}`;

/* ── 1. how long each gap has been seen ───────────────────────────────── */
let _mlSeen = {};
try { _mlSeen = JSON.parse(localStorage.getItem(ML_SEEN_KEY) || '{}') || {}; } catch (_) { _mlSeen = {}; }

// Called after every scan with the analysed items. A gap keeps its first-seen
// time only while it shows up on back-to-back refreshes (≤ 2.5 poll intervals
// apart); anything not at/above the threshold this scan is dropped.
function mlTrackSeen(items, now = Date.now()) {
  const thr = _mt.threshold / 100;
  const next = {};
  for (const it of items) {
    for (const r of it.rows || []) {
      if (r.suspect || !(r.edge >= thr)) continue;
      const k = gapKey(it.m, r);
      const prev = _mlSeen[k];
      const cont = prev && now - prev.last <= 2.5 * ML_POLL_MS;
      next[k] = { first: cont ? prev.first : now, last: now, n: cont ? prev.n + 1 : 1 };
    }
  }
  _mlSeen = next;
  try { localStorage.setItem(ML_SEEN_KEY, JSON.stringify(_mlSeen)); } catch (_) {}
}

function seenBadge(it, r) {
  if (!r || r.modelOnly) return '';
  const s = _mlSeen[gapKey(it.m, r)];
  if (!s) return '';
  const min = Math.round((s.last - s.first) / 60000);
  return s.n <= 1
    ? `<span class="ml-seen new" title="First refresh with this gap at or above ${_mt.threshold}%. Most vanish by the next one (one book a minute behind) — wait one refresh before betting.">new</span>`
    : `<span class="ml-seen held" title="At or above ${_mt.threshold}% on ${s.n} refreshes in a row.">seen ${min < 1 ? '<1' : min} min</span>`;
}

/* ── 2. bet log ───────────────────────────────────────────────────────── */
let _bl = [];
try { _bl = JSON.parse(localStorage.getItem(BL_KEY) || '[]') || []; } catch (_) { _bl = []; }
function saveBetLog() { try { localStorage.setItem(BL_KEY, JSON.stringify(_bl)); } catch (_) {} }

// Line and side of a live row, for settling it later.
function rowSpec(r, odds) {
  if (r.market === '1X2') return { side: r.label.startsWith('Home') ? 'home' : r.label.startsWith('Away') ? 'away' : 'draw', line: null };
  if (r.market === 'AH') return r.label.startsWith('Home') ? { side: 'home', line: odds.ah_hc } : { side: 'away', line: -odds.ah_hc };
  if (r.market === 'OU') return { side: r.label.startsWith('Over') ? 'over' : 'under', line: odds.tl_c };
  return { side: null, line: null };
}

function logLiveBet(i, j) {
  const it = _mlVisible[i];
  const r = j == null ? it?.pick : it?.rows?.[j];
  if (!it || !r || r.modelOnly) return;
  const p = prompt(`Log: ${it.m.home_team} v ${it.m.away_team} — ${r.label}\nPrice you got on Bet365:`, r.price.toFixed(2));
  if (p == null) return;
  const price = parseFloat(String(p).replace(',', '.'));
  if (!(price > 1)) { alert('Enter the decimal price, e.g. 1.95'); return; }
  const kelly = FairModel.kelly(1 / r.fair, price, _mt.kellyFrac);
  const dflt = _mt.bankroll ? (_mt.bankroll * kelly).toFixed(2) : (kelly * 100).toFixed(2);
  const s = prompt(`Stake${_mt.bankroll ? ' (€)' : ' (% of bankroll)'}:`, dflt);
  if (s == null) return;
  const stake = parseFloat(String(s).replace(',', '.'));
  if (!(stake > 0)) { alert('Enter a stake above 0'); return; }
  const spec = rowSpec(r, it.m.bet365_live_odds || {});
  _bl.unshift({
    id: Date.now().toString(36), at: Date.now(), key: gapKey(it.m, r),
    matchId: it.m.id || null, url: it.m.url || null, home: it.m.home_team, away: it.m.away_team, league: it.m.league || '',
    minute: it.st.minuteText, score: it.st.score, market: r.market, label: r.label, side: spec.side, line: spec.line,
    shown: r.price, price, stake, unit: _mt.bankroll ? '€' : '%', fair: r.fair, edge: r.edge,
    basis: it.basis === 'pinnacle' ? 'pinnacle' : 'model', ref: it.basis === 'pinnacle' ? 'Pinnacle' : it.refKey === 'sbobet' ? 'model (Sbobet)' : 'model (Bet365 pre)',
    follow: null, lastScore: it.st.score, lastMinute: it.st.minute, lastMinuteText: it.st.minuteText, goalAfter: false, result: null, auto: false,
  });
  saveBetLog();
  renderMatchesList();
}

// Called after every scan: follow each open bet's market, note goals, settle
// the ones whose match has left the live feed late on.
function blFollowUp(items, now = Date.now()) {
  if (!_bl.length) return;
  const byId = new Map(items.filter(it => it.m.id).map(it => [it.m.id, it]));
  let changed = false;
  for (const b of _bl) {
    if (b.result) continue;
    const it = b.matchId ? byId.get(b.matchId) : null;
    if (it) {
      if (it.st.score) {
        if (!b.goalAfter && (it.st.score.home !== b.score.home || it.st.score.away !== b.score.away)) b.goalAfter = true;
        b.lastScore = it.st.score;
      }
      if (Number.isFinite(it.st.minute)) { b.lastMinute = it.st.minute; b.lastMinuteText = it.st.minuteText; }
      if (!b.goalAfter) {
        const r = (it.rows || []).find(x => gapKey(it.m, x) === b.key);
        if (r) b.follow = { at: now, minute: it.st.minuteText, price: r.price, fair: r.fair, edge: r.edge };
      }
      b.seenAt = now;
      changed = true;
    } else if (b.seenAt && now - b.seenAt > 3 * ML_POLL_MS && b.lastMinute >= 88 && b.lastScore) {
      const mult = settleMult(b, b.lastScore);
      if (mult != null) { b.result = resultName(mult, b.price); b.mult = mult; b.auto = true; changed = true; }
    }
  }
  if (changed) saveBetLog();
}

// Payout per unit staked (price for a full win, 0 for a loss; quarter lines
// split into two half-stakes) from the final score.
function settleMult(b, fin) {
  const part = x => (x > 1e-9 ? b.price : x < -1e-9 ? 0 : 1);
  const split = (base, line) => {
    const frac = Math.abs(line * 4) % 2;
    if (Math.abs(frac - 1) < 1e-6) return (part(base + line - 0.25) + part(base + line + 0.25)) / 2;
    return part(base + line);
  };
  if (b.market === '1X2') {
    const d = fin.home - fin.away;
    const won = b.side === 'home' ? d > 0 : b.side === 'away' ? d < 0 : d === 0;
    return won ? b.price : 0;
  }
  if (b.market === 'OU' && b.line != null) {
    const t = fin.home + fin.away;
    return b.side === 'over' ? split(t, -b.line) : split(-t, b.line);
  }
  if (b.market === 'AH' && b.line != null) {
    const dh = (fin.home - b.score.home) - (fin.away - b.score.away); // goals from now
    return split(b.side === 'home' ? dh : -dh, b.line);
  }
  return null;
}
const RESULT_MULT = { win: p => p, halfwin: p => (p + 1) / 2, push: () => 1, halflose: () => 0.5, lose: () => 0 };
const RESULT_LABEL = { win: 'Won', halfwin: 'Half won', push: 'Void', halflose: 'Half lost', lose: 'Lost' };
function resultName(mult, price) {
  if (mult >= price - 1e-9) return 'win';
  if (mult <= 1e-9) return 'lose';
  if (Math.abs(mult - 1) < 1e-9) return 'push';
  return mult > 1 ? 'halfwin' : 'halflose';
}
function setBetResult(id, v) {
  const b = _bl.find(x => x.id === id);
  if (!b) return;
  if (!v) { b.result = null; b.mult = null; b.auto = false; }
  else { b.result = v; b.mult = RESULT_MULT[v](b.price); b.auto = false; }
  saveBetLog(); renderMatchesList();
}
function deleteBet(id) {
  if (!confirm('Delete this bet from the log?')) return;
  _bl = _bl.filter(x => x.id !== id); saveBetLog(); renderMatchesList();
}
function clearBetLog() {
  if (!confirm(`Delete all ${_bl.length} logged bets? Export them first if you want to keep them.`)) return;
  _bl = []; saveBetLog(); renderMatchesList();
}

// Who closed the gap between logging and the last same-score refresh:
// ln(1+edge) falls by ln(shown/Bet365 now) + ln(fair now/fair then) — the
// first part is Bet365 coming down, the second the reference moving up.
function gapVerdict(b) {
  const f = b.follow;
  if (!f || f.at - b.at < 50000) return { cls: '', text: b.goalAfter ? 'goal before the next refresh' : 'waiting for the next refresh' };
  const thr = _mt.threshold / 100;
  const bk = Math.log(b.shown / f.price), rf = Math.log(f.fair / b.fair);
  if (f.edge >= thr) return { cls: '', text: `still open (${fSigned(f.edge * 100)}%)` };
  if (bk + rf <= 0) return { cls: '', text: `edge now ${fSigned(f.edge * 100)}%` };
  return bk >= rf
    ? { cls: 'good', text: `Bet365 came down to ${fOdd(f.price)} — your price beat the market`, by: 'bet365' }
    : { cls: 'bad', text: `${b.basis === 'pinnacle' ? 'Pinnacle' : 'model'} moved to ${fOdd(f.fair)} — mostly lag`, by: 'ref' };
}

function renderBetLog() {
  if (!_bl.length) return `<details class="mt-details bl-box"><summary>📒 Bet log (empty)</summary>
    <div class="mt-sub">Tap <b>＋ log</b> on a row after you place a bet. Each refresh then follows that market — which side closed the gap, your price vs Bet365's later price — and settles it at full time. Stored in this browser only.</div></details>`;
  const settled = _bl.filter(b => b.result && b.mult != null);
  const staked = settled.reduce((s, b) => s + b.stake, 0);
  const pl = settled.reduce((s, b) => s + b.stake * (b.mult - 1), 0);
  const verdicts = _bl.map(gapVerdict);
  const byB = verdicts.filter(v => v.by === 'bet365').length, byR = verdicts.filter(v => v.by === 'ref').length;
  const clv = _bl.filter(b => b.follow && b.follow.at - b.at >= 50000).map(b => b.price / b.follow.price - 1);
  const avgClv = clv.length ? clv.reduce((s, x) => s + x, 0) / clv.length : null;
  const u = _bl[0].unit;
  const money = x => (u === '€' ? `€${x.toFixed(2)}` : `${x.toFixed(2)}%`);
  const rows = _bl.map(b => {
    const v = gapVerdict(b);
    const t = new Date(b.at);
    const sel = `<select class="bl-res" onchange="setBetResult('${b.id}', this.value)">${['', 'win', 'halfwin', 'push', 'halflose', 'lose'].map(k =>
      `<option value="${k}"${(b.result || '') === k ? ' selected' : ''}>${k ? RESULT_LABEL[k] : 'open'}</option>`).join('')}</select>`;
    const plTxt = b.result && b.mult != null ? `<span class="${b.mult > 1 ? 'bl-pos' : b.mult < 1 ? 'bl-neg' : ''}">${b.mult >= 1 ? '+' : ''}${money(b.stake * (b.mult - 1))}</span>` : '—';
    return `<tr>
      <td class="mt-mini">${t.toLocaleDateString([], { day: '2-digit', month: '2-digit' })} ${t.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}<br>${mtEsc(b.minute)} · ${b.score.home}-${b.score.away}</td>
      <td><div class="sc-match">${mtEsc(b.home)} <span class="mt-dim">v</span> ${mtEsc(b.away)}</div><div class="mt-mini">${mtEsc(b.label)} · ${mtEsc(b.ref)}</div></td>
      <td class="num" data-l="Price">${fOdd(b.price)}<div class="mt-mini">fair ${fOdd(b.fair)} · ${fSigned(b.edge * 100)}%</div></td>
      <td class="num" data-l="Stake">${money(b.stake)}</td>
      <td class="bl-v ${v.cls}" data-l="Gap">${mtEsc(v.text)}${b.follow && b.follow.at - b.at >= 50000 ? `<div class="mt-mini">your price vs Bet365 at ${mtEsc(b.follow.minute)}: ${fSigned((b.price / b.follow.price - 1) * 100)}%</div>` : ''}</td>
      <td data-l="Result">${sel}${b.auto ? `<div class="mt-mini">from ${b.lastScore.home}-${b.lastScore.away} at ${mtEsc(b.lastMinuteText || '')}</div>` : ''}</td>
      <td class="num" data-l="P/L">${plTxt}</td>
      <td><button class="bl-del" title="Delete" onclick="deleteBet('${b.id}')">✕</button></td>
    </tr>`;
  }).join('');
  return `<details class="mt-details bl-box" open><summary>📒 Bet log — ${_bl.length} bet${_bl.length > 1 ? 's' : ''}${settled.length ? ` · P/L ${pl >= 0 ? '+' : ''}${money(pl)} (ROI ${fSigned(staked ? pl / staked * 100 : 0)}%)` : ''}</summary>
    <div class="mt-sub">${settled.length} settled · gap closed by Bet365 coming down: <b>${byB}</b> · by the reference moving: <b>${byR}</b>${avgClv != null ? ` · your price vs Bet365 later: <b>${fSigned(avgClv * 100)}%</b> on average (above 0 = you beat the market)` : ''}</div>
    <div class="mt-table-wrap"><table class="mt-table bl-table"><thead><tr><th>When</th><th>Bet</th><th>Price</th><th>Stake</th><th>Gap afterwards</th><th>Result</th><th>P/L</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>
    <div class="mt-sub">Followed only while this tab is open and until the next goal. Settled automatically when the match leaves the live feed at 88'+ (last score seen) — check it, or set the result by hand.
      <button class="bl-act" onclick="exportBetLog()">Export CSV</button> <button class="bl-act" onclick="clearBetLog()">Clear log</button></div>
  </details>`;
}

function exportBetLog() {
  const cols = ['at', 'home', 'away', 'league', 'minute', 'score', 'market', 'label', 'price', 'stake', 'unit', 'fair', 'edge', 'ref', 'follow_minute', 'follow_price', 'follow_fair', 'gap_closed_by', 'result', 'pl'];
  const q = v => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = [cols.join(',')].concat(_bl.map(b => {
    const v = gapVerdict(b);
    return [new Date(b.at).toISOString(), b.home, b.away, b.league, b.minute, `${b.score.home}-${b.score.away}`, b.market, b.label, b.price, b.stake, b.unit,
      b.fair.toFixed(3), (b.edge * 100).toFixed(2), b.ref, b.follow?.minute, b.follow?.price, b.follow?.fair?.toFixed(3), v.by || '',
      b.result || '', b.result && b.mult != null ? (b.stake * (b.mult - 1)).toFixed(2) : ''].map(q).join(',');
  }));
  const blob = new Blob([lines.join('\n')], { type: 'text/csv' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `halvest-bet-log-${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

if (typeof module !== 'undefined') module.exports = { settleMult, resultName, gapVerdict, mlTrackSeen, rowSpec, gapKey, _get: () => ({ _mlSeen, _bl }) };
