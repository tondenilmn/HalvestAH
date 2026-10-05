/* ══════════════════════════════════════════════════════════════════════
   matches.js — the 📡 MATCHES tab: every match in play right now, one
   row each with its best bet. Click a row → the full MATCH tab page for
   that match (overview, value, fair prices, historical, live refresh).

   Data: /api/livescore (functions/api/livescore.js) — one request carries
   every live match's minute / score / HT score, Bet365's and Sbobet's
   pre-match closing prices, and Bet365's current in-play prices.

   Per match, the same pipeline as the MATCH tab's "In play now" table
   (match.js): fit the scoreline model to the reference book's pre-match
   AH + TL (Sbobet when listed, else Bet365's own pre-match close) →
   FairModel.liveMarkets (goal-timing decay + score state) →
   buildLiveValueRows (Bet365 live 1X2 / AH from now / goal line vs model).
   The row's pick depends on "Rank by":
     best        highest Kelly stake — balances edge and probability
     probable    highest model probability
     profitable  highest edge (Bet365 price ÷ model fair − 1)
   Gaps ≥ MT_LIVE_SUSPECT_EDGE are never picked (usually the model is
   missing match information — a red card, an injury).

   NOT BACKTESTED — the in-play comparison has no validation, same caveat
   as the MATCH tab's "In play now" table. The list says so.

   Depends on: fair_model.js (FairModel), match.js (fitBook, hasPrices,
   buildLiveValueRows, importMatchTab, _mt prefs, formatters,
   MT_LIVE_SUSPECT_EDGE), app.js (switchTab, classifyLeague, _activeTab).
   ══════════════════════════════════════════════════════════════════════ */

const ML_PREF_KEY = 'halvest_matches_prefs_v2'; // v2: default sort became elapsed time
const ML_POLL_MS = 60000;

const _ml = {
  data: null,        // raw /api/livescore response
  items: [],         // one analysis per live match
  fetchedAt: null,
  loading: false,
  rank: 'best',      // best | probable | profitable
  minOdds: 1.3,      // picks below this price are skipped (near-certain outcomes)
  tier: 'ALL',       // ALL | TOP | MAJOR | OTHER
  ref: 'ANY',        // ANY | PINNACLE (only picks priced against Pinnacle live) | SBOBET (model fitted to Sbobet)
  leagues: [],       // selected league names; empty = all (list rebuilt from the live matches)
  leagueSearch: '',  // text filter for the league checklist (not saved)
  sort: 'minute',    // minute (most elapsed first) | pick
};
let _mlTimer = null;
let _mlVisible = []; // items currently rendered, indexed by openLiveListMatch

(function loadMatchesPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(ML_PREF_KEY) || '{}');
    for (const k of ['rank', 'minOdds', 'tier', 'leagues', 'ref', 'sort']) if (p[k] != null) _ml[k] = p[k];
    if (!Array.isArray(_ml.leagues)) _ml.leagues = [];
  } catch (_) { /* storage unavailable — defaults are fine */ }
})();
function saveMatchesPrefs() {
  try {
    const { rank, minOdds, tier, leagues, ref, sort } = _ml;
    localStorage.setItem(ML_PREF_KEY, JSON.stringify({ rank, minOdds, tier, leagues, ref, sort }));
  } catch (_) {}
}
function setMatchesPref(key, value) {
  if (key === 'minOdds') value = parseFloat(value);
  _ml[key] = value;
  saveMatchesPrefs();
  if (key === 'rank' || key === 'minOdds') _ml.items.forEach(it => { if (it.lm) it.pick = pickLiveBet(it); });
  renderMatchesList();
}

/* ── fetch + analyse ──────────────────────────────────────────────────── */
async function runMatchesScan() {
  if (_ml.loading) return;
  _ml.loading = true;
  const btn = document.getElementById('ml-run-btn');
  const status = document.getElementById('ml-status');
  if (btn) btn.disabled = true;
  if (status && !_ml.data) { status.textContent = 'Fetching live matches…'; status.className = 'url-import-status loading'; }
  try {
    // Pinnacle's live sheet is fetched alongside; a failure there only means
    // every match falls back to the model.
    const [data, pin] = await Promise.all([
      fetch('/api/livescore').then(r => r.json()),
      typeof Pinn !== 'undefined' ? Pinn.get().catch(e => ({ matches: [], error: e.message })) : Promise.resolve({ matches: [] }),
    ]);
    const live = (data.matches || []).filter(m => m.minute);
    if (!live.length && data.note) throw new Error(data.note);
    _ml.data = data;
    _ml.pin = pin;
    _ml.items = live.map(m => analyzeListMatch(m, pin.matches || []));
    _ml.fetchedAt = new Date();
    // betlog.js: how long each gap has lasted, and follow-up of logged bets.
    if (typeof mlTrackSeen === 'function') mlTrackSeen(_ml.items);
    if (typeof blFollowUp === 'function') blFollowUp(_ml.items);
    if (status) {
      const priced = _ml.items.filter(it => it.rows.length).length;
      const vsPin = _ml.items.filter(it => it.basis === 'pinnacle').length;
      status.textContent = `✓ ${live.length} live matches · ${priced} with Bet365 in-play prices · ${vsPin} vs Pinnacle${pin.error ? ' (Pinnacle unavailable)' : ''}`;
      status.className = 'url-import-status ok';
    }
    renderMatchesList();
  } catch (e) {
    if (status) { status.textContent = '✗ ' + e.message; status.className = 'url-import-status error'; }
  } finally {
    _ml.loading = false;
    if (btn) btn.disabled = false;
  }
}

const parseScoreStr = s => {
  const m = typeof s === 'string' && s.match(/^(\d+)-(\d+)$/);
  return m ? { home: +m[1], away: +m[2] } : null;
};

// Same shape as match.js's matchState(), from a livescore feed row.
function listMatchState(m) {
  const raw = String(m.minute || '').replace(/\\'/g, "'");
  const ht = raw === 'HT';
  const minute = ht ? 45 : parseInt(raw, 10);
  return {
    status: ht ? 'HT' : 'LIVE',
    minute,
    stoppage: !ht && raw.includes('+'),
    minuteText: ht ? 'HT' : Number.isFinite(minute) ? `${minute}'${raw.includes('+') ? '+' : ''}` : raw,
    score: parseScoreStr(m.score),
    htScore: parseScoreStr(m.ht_score),
  };
}

function analyzeListMatch(m, pinMatches = []) {
  const st = listMatchState(m);
  const tier = typeof classifyLeague === 'function' ? classifyLeague(m.league) : 'OTHER';
  const item = { m, st, tier, refKey: null, fit: null, lm: null, rows: [], pick: null, why: null, basis: null, pm: null };
  if (!st.score || !Number.isFinite(st.minute)) { item.why = 'no score / minute in the feed'; return item; }

  // Sbobet is the only backtested reference; Bet365's own pre-match close
  // is the fallback (labelled), so matches without Sbobet still get a read.
  if (hasPrices(m.sbobet_odds)) { item.refKey = 'sbobet'; item.fit = fitBook(m.sbobet_odds, 'c'); }
  if (!item.fit && hasPrices(m.odds)) { item.refKey = 'bet365'; item.fit = fitBook(m.odds, 'c'); }
  if (!item.fit) { item.refKey = null; item.why = 'no pre-match prices to fit the model'; return item; }

  item.lm = FairModel.liveMarkets(item.fit.fit.lh, item.fit.fit.la, st);
  item.model = modelCandidates(item.lm);
  if (m.bet365_live_odds) {
    // Pinnacle live on the same line when it has the match (the sharp-book
    // check), else the model. Either way huge gaps are never picked.
    item.pm = typeof Pinn !== 'undefined' ? Pinn.find(pinMatches, m.home_team, m.away_team, st.score) : null;
    const pinRows = item.pm ? buildPinnacleRows(m.bet365_live_odds, item.pm) : [];
    item.basis = pinRows.length ? 'pinnacle' : 'model';
    item.rows = (pinRows.length ? pinRows : buildLiveValueRows(item.lm, m.bet365_live_odds)).map(r =>
      r.edge >= MT_LIVE_SUSPECT_EDGE ? Object.assign(r, { kelly: 0, suspect: true }) : r);
  }
  item.why = m.bet365_live_odds ? 'Bet365 in-play markets suspended' : 'no Bet365 in-play price';
  item.pick = pickLiveBet(item);
  return item;
}

// Model-only outcomes (no bookmaker price) — what the list falls back to
// when Bet365's in-play prices are missing: the likeliest outcome by the
// live model, with its fair odds. Half-ball totals only (no push).
function modelCandidates(lm) {
  const out = [];
  const add = (market, o, label) => { if (o && o.p > 0 && o.p < 0.999 && isFinite(o.fair)) out.push({ market, label: label || o.label, p: o.p, fair: o.fair, modelOnly: true }); };
  lm.result.forEach(o => add('1X2', o, 'Final: ' + (o.label === 'Draw' ? 'Draw' : o.label + ' win')));
  lm.doubleChance.forEach(o => add('DC', o));
  lm.totals.filter(t => Math.abs(t.line % 1 - 0.5) < 0.01).forEach(t => { add('OU', t.over); add('OU', t.under); });
  add('BTTS', lm.btts[0]); add('BTTS', lm.btts[1]);
  lm.specials.forEach(o => add('Goals', o));
  (lm.restOfHalf?.totals || []).forEach(o => add('Half', o));
  return out;
}

// One bet per match, by the chosen ranking. Suspect gaps and prices under
// the min-odds floor never qualify.
function pickLiveBet(item) {
  const c = item.rows.filter(r => !r.suspect && r.price >= _ml.minOdds);
  if (!c.length) {
    // No usable Bet365 price → the model's likeliest outcome at a fair price
    // ≥ the min-odds floor (an informational pick: no edge to measure).
    const mc = (item.model || []).filter(r => r.fair >= _ml.minOdds);
    return mc.length ? mc.reduce((a, b) => (b.p > a.p ? b : a)) : null;
  }
  const by = f => c.reduce((a, b) => (f(b) > f(a) ? b : a));
  if (_ml.rank === 'probable') return by(r => r.p);
  if (_ml.rank === 'profitable') return by(r => r.edge);
  const pos = c.filter(r => r.kelly > 0);
  return pos.length ? pos.reduce((a, b) => (b.kelly > a.kelly ? b : a)) : by(r => r.edge);
}

const pickScore = it => !it.pick ? -Infinity
  : it.pick.modelOnly ? (_ml.rank === 'probable' ? it.pick.p : -2 + it.pick.p) // priced picks first
  : _ml.rank === 'probable' ? it.pick.p
  : _ml.rank === 'profitable' ? it.pick.edge
  : (it.pick.kelly > 0 ? 1 + it.pick.kelly : it.pick.edge); // value picks first, then the rest by edge

/* ── polling while the tab is open ────────────────────────────────────── */
function startMatchesPolling() {
  stopMatchesPolling();
  runMatchesScan();
  if (typeof loadFeedStatus === 'function' && !_fd.data) loadFeedStatus();
  _mlTimer = setInterval(() => {
    if (typeof _activeTab !== 'undefined' && _activeTab !== 'matches') { stopMatchesPolling(); return; }
    runMatchesScan();
  }, ML_POLL_MS);
}
function stopMatchesPolling() { clearInterval(_mlTimer); _mlTimer = null; }

/* ── render ───────────────────────────────────────────────────────────── */
function renderMatchesRow(it, i) {
  const { m, st, pick: r } = it;
  const thr = _mt.threshold / 100;
  const hit = r && !r.modelOnly && r.edge >= thr;
  const sc = st.score ? `${st.score.home}-${st.score.away}` : '—';
  const stake = hit && r.kelly > 0 ? (_mt.bankroll ? `€${(_mt.bankroll * r.kelly).toFixed(2)}` : fPct(r.kelly, 2)) : '—';
  const refTag = it.basis === 'pinnacle' && r && !r.modelOnly ? `<span class="sc-bucket open" title="Fair = Pinnacle's live price on the same line, margin removed (${mtEsc(it.pm?.home || '')} v ${mtEsc(it.pm?.away || '')}).">Pinnacle</span>`
    : it.refKey === 'sbobet' ? '<span class="sc-bucket open" title="Model fitted to Sbobet\'s pre-match prices (the backtested reference book).">Sbobet</span>'
    : it.refKey === 'bet365' ? '<span class="sc-bucket moved-thin" title="Sbobet not listed — model fitted to Bet365\'s own pre-match close, so the edge only measures how far the live price strays from that.">Bet365 pre</span>' : '';
  const betCells = r?.modelOnly ? `
    <td class="mt-strong ml-pick">${mtEsc(r.label)} <span class="mt-tag model" title="${mtEsc(it.why)} — the model's likeliest outcome, with its fair odds. No price to compare, so no edge or stake.">model only</span></td>
    <td class="num mt-dim" data-l="Bet365">—</td>
    <td class="num" data-l="Fair">${fOdd(r.fair)}</td>
    <td class="num" data-l="Prob">${fPct(r.p, 0)}</td>
    <td class="num mt-dim ml-sm-hide" data-l="Edge">—</td>
    <td class="num" data-l="Min odds">${fOdd(r.fair * (1 + _mt.threshold / 100))}</td>
    <td class="num ml-sm-hide" data-l="Stake">—</td>`
    : r ? `
    <td class="mt-strong ml-pick">${r.market === 'OU' ? 'O/U' : r.market} · ${mtEsc(r.label)} ${typeof seenBadge === 'function' ? seenBadge(it, r) : ''}</td>
    <td class="num mt-strong" data-l="Bet365">${fOdd(r.price)}</td>
    <td class="num" data-l="Fair">${fOdd(r.fair)}</td>
    <td class="num" data-l="Prob">${fPct(r.p, 0)}</td>
    <td class="num mt-edge" data-l="Edge">${fSigned(r.edge * 100)}%</td>
    <td class="num" data-l="Min odds">${fOdd(r.minOdds)}</td>
    <td class="num" data-l="Stake">${stake}</td>`
    : `<td colspan="7" class="mt-dim ml-pick">${mtEsc(it.why || `no bet at ≥ ${fOdd(_ml.minOdds)} without a suspect gap`)}</td>`;
  return `<tr class="sc-row ${hit ? 'mt-v-hit' : r && !r.modelOnly && r.edge > 0 ? 'mt-v-pos' : r && !r.modelOnly ? 'mt-v-neg' : ''}" onclick="openLiveListMatch(${i})" title="Open the full match page">
    <td class="num ml-mincell"><span class="ml-min">${mtEsc(st.minuteText || '')}</span></td>
    <td class="num ml-score">${sc}${st.htScore && st.status !== 'HT' ? `<span class="mt-mini">HT ${st.htScore.home}-${st.htScore.away}</span>` : ''}</td>
    <td class="ml-match"><div class="sc-match">${mtEsc(m.home_team)} <span class="mt-dim">v</span> ${mtEsc(m.away_team)}</div>
        <div class="mt-mini">${mtEsc(m.league)} <span class="sc-tier ${it.tier.toLowerCase()}">${it.tier}</span></div></td>
    ${betCells}
    <td class="ml-ref">${refTag}${r && !r.modelOnly && typeof logLiveBet === 'function'
      ? (_bl.some(b => !b.result && b.key === gapKey(m, r))
        ? '<span class="ml-logged" title="In the bet log below">✓ logged</span>'
        : `<button class="ml-log-btn" title="Placed this bet? Log it to follow the price and settle it" onclick="event.stopPropagation(); logLiveBet(${i})">＋ log</button>`) : ''}</td>
  </tr>`;
}

function renderMatchesList() {
  const el = document.getElementById('right-matches');
  if (!el || !_ml.data) return;
  renderLeagueOptions();
  const items = _ml.items.filter(it =>
    (_ml.tier === 'ALL' || it.tier === _ml.tier) && (_ml.ref === 'ANY' || (_ml.ref === 'PINNACLE' ? it.basis === 'pinnacle' : it.refKey === 'sbobet'))
    && (!_ml.leagues.length || _ml.leagues.includes(it.m.league)));
  // Elapsed time: 45'+ sits after 45', HT after that, 90'+ last.
  const minuteOf = it => it.st.status === 'HT' ? 45.5
    : Number.isFinite(it.st.minute) ? it.st.minute + (it.st.stoppage ? 0.2 : 0) : -1;
  items.sort(_ml.sort === 'minute'
    ? (a, b) => minuteOf(b) - minuteOf(a)
    : (a, b) => pickScore(b) - pickScore(a) || minuteOf(b) - minuteOf(a));
  _mlVisible = items;

  const thr = _mt.threshold / 100;
  const value = items.filter(it => it.pick && !it.pick.modelOnly && it.pick.edge >= thr);
  const rankLabel = { best: 'best bet (Kelly)', probable: 'most probable bet', profitable: 'most profitable bet (edge)' }[_ml.rank];
  // Headline = best pick in the filtered list, whatever the row order.
  const top = items.reduce((a, b) => (b.pick && (!a || pickScore(b) > pickScore(a)) ? b : a), null);
  const notes = [];
  if (_ml.data.matches?.length && !_ml.items.some(it => it.m.bet365_live_odds)) notes.push('No Bet365 in-play prices in the feed — the "Bet365 Live" hash is probably stale: open FEEDS (top of the left panel) to check and replace it. Without them each match shows the model\'s likeliest outcome and its fair odds ("model only") — no edge can be measured.');

  el.innerHTML = `
    <div class="mt-value-summary ${value.length ? 'hit' : ''}">
      <div class="mt-big">${value.length
        ? `💰 ${value.length} live match${value.length > 1 ? 'es' : ''} with a pick ≥ ${_mt.threshold}% edge`
        : `${items.length} live match${items.length === 1 ? '' : 'es'} · no pick clears ${_mt.threshold}% right now`}</div>
      ${top ? `<div>Top ${mtEsc(rankLabel)}: <b>${mtEsc(top.m.home_team)} v ${mtEsc(top.m.away_team)}</b> (${mtEsc(top.st.minuteText)}, ${top.st.score.home}-${top.st.score.away}) — <b>${mtEsc(top.pick.label)}</b> ${top.pick.modelOnly
        ? `model ${fPct(top.pick.p, 0)}, fair ${fOdd(top.pick.fair)} <span class="mt-dim">(no live price)</span>`
        : `@ ${fOdd(top.pick.price)}, model ${fPct(top.pick.p, 0)}, edge <b>${fSigned(top.pick.edge * 100)}%</b>`}</div>` : ''}
      <div class="mt-dim">Pick per match: ${mtEsc(rankLabel)} · sorted by ${_ml.sort === 'minute' ? 'time elapsed' : 'pick'}${_ml.leagues.length ? ` · ${_ml.leagues.length === 1 ? mtEsc(_ml.leagues[0]) : _ml.leagues.length + ' leagues'}` : ''} · updated ${_ml.fetchedAt ? _ml.fetchedAt.toLocaleTimeString() : ''} · refreshes every minute while this tab is open</div>
    </div>
    ${notes.map(n => `<div class="mt-banner warn">${mtEsc(n)}</div>`).join('')}
    ${items.length ? `<div class="mt-table-wrap"><table class="mt-table sc-table ml-table">
      <thead><tr><th>Min</th><th>Score</th><th>Match</th><th>Pick</th><th>Bet365 live</th><th>Fair</th><th>Prob</th><th>Edge</th><th>Min odds</th><th>Stake</th><th>Ref</th></tr></thead>
      <tbody>${items.map(renderMatchesRow).join('')}</tbody>
    </table></div>` : '<div class="placeholder"><p>No live matches match these filters right now.</p></div>'}
    <div class="mt-sub" style="margin-top:10px">Fair = Pinnacle's live price on the same line with its margin removed (<span class="sc-bucket open">Pinnacle</span> — the sharp-book check), else the live scoreline model (pre-match strength, real goal-timing curve, score state) · Edge = Bet365 live price ÷ fair − 1 · Min odds = fair × ${(1 + _mt.threshold / 100).toFixed(2)} · Stake = ${({ 0.125: '⅛', 0.25: '¼', 0.5: '½' })[_mt.kellyFrac] || _mt.kellyFrac} Kelly${_mt.bankroll ? ` of €${_mt.bankroll}` : ' (% of bankroll)'} — threshold, Kelly and bankroll come from the MATCH tab's settings. In-play AH counts goals from now; the goal line is on the full-match total. Click a match for the full page (it also checks red cards).</div>
    <details class="mt-details"><summary>Read before betting</summary>
      <ul class="mt-notes">
        <li><b>Not backtested.</b> Neither in-play comparison has validation behind it — there's no in-play price history to test on. Against Pinnacle it's the same idea as the pre-match Bet365-vs-Sbobet check that did backtest (same line, same moment, sharp book); against the model it's a much weaker pointer.</li>
        <li>Gaps ≥ ${(MT_LIVE_SUSPECT_EDGE * 100).toFixed(0)}% are never picked: a gap that big almost always means the model is missing something the market knows (a red card, an injury, one side dominating).</li>
        <li>Without Sbobet the model is fitted to Bet365's own pre-match close (<span class="sc-bucket moved-thin">Bet365 pre</span>) — the edge then only says the live price has strayed from what Bet365 itself implied at kick-off.</li>
        <li><span class="mt-tag model">model only</span> rows have no Bet365 live price: the pick is the model's likeliest outcome at fair odds ≥ the min-odds floor, and "Min odds" is the price you'd want before betting it.</li>
        <li><span class="ml-seen new">new</span> = first refresh with this gap at or above the threshold; <span class="ml-seen held">seen N min</span> = still there on back-to-back refreshes. Most gaps vanish within a refresh (one book a minute behind) — wait for one that holds, then check Bet365's price.</li>
        <li>"Most probable" picks the outcome the model rates likeliest among Bet365's live prices at ≥ the min-odds floor — likely, not necessarily good value. Check the edge column.</li>
      </ul>
    </details>
    ${typeof renderBetLog === 'function' ? renderBetLog() : ''}`;
}

// League checklist: every league in the current live list (within the tier
// filter) with its match count; tick any number of them, none = all. A ticked
// league with no live match right now stays listed (at the top) so the choice
// isn't silently lost between refreshes. Only the list body is rebuilt on each
// refresh, so the open/closed state and the search box survive it.
let _mlLeagueList = []; // names in the order rendered, indexed by the checkboxes

function renderLeagueOptions() {
  const box = document.getElementById('ml-league-list');
  const sum = document.getElementById('ml-league-summary');
  if (!box) return;
  const counts = new Map();
  for (const it of _ml.items) {
    if (_ml.tier !== 'ALL' && it.tier !== _ml.tier) continue;
    const lg = it.m.league || '';
    if (lg) counts.set(lg, (counts.get(lg) || 0) + 1);
  }
  const sel = new Set(_ml.leagues);
  const q = _ml.leagueSearch.trim().toLowerCase();
  const byName = (a, b) => a.localeCompare(b);
  const live = [...counts.keys()].sort(byName);
  // Ticked leagues first, then the rest; the search narrows only the unticked ones.
  _mlLeagueList = [
    ..._ml.leagues.slice().sort(byName),
    ...live.filter(lg => !sel.has(lg) && (!q || lg.toLowerCase().includes(q))),
  ];
  box.innerHTML = _mlLeagueList.length ? _mlLeagueList.map((lg, i) => `
    <label class="ml-lg${sel.has(lg) ? ' on' : ''}"><input type="checkbox" data-i="${i}"${sel.has(lg) ? ' checked' : ''} onchange="toggleMatchesLeague(this)">
      <span>${mtEsc(lg)}</span><b>${counts.get(lg) || '0'}</b></label>`).join('')
    : `<div class="mt-dim">${q ? 'No live league matches that search.' : 'No live matches yet.'}</div>`;
  if (sum) sum.textContent = _ml.leagues.length
    ? (_ml.leagues.length === 1 ? _ml.leagues[0] : `${_ml.leagues.length} leagues selected`)
    : `All leagues (${counts.size})`;
  const clr = document.getElementById('ml-league-clear');
  if (clr) clr.style.display = _ml.leagues.length ? '' : 'none';
}
function toggleMatchesLeague(cb) {
  const lg = _mlLeagueList[+cb.dataset.i];
  if (lg == null) return;
  _ml.leagues = cb.checked ? [...new Set([..._ml.leagues, lg])] : _ml.leagues.filter(x => x !== lg);
  saveMatchesPrefs();
  renderMatchesList();
}
function clearMatchesLeagues() { _ml.leagues = []; saveMatchesPrefs(); renderMatchesList(); }
function searchMatchesLeagues(v) { _ml.leagueSearch = v || ''; renderLeagueOptions(); }

function openLiveListMatch(i) {
  const it = _mlVisible[i];
  if (!it?.m?.url) return;
  switchTab('match');
  importMatchTab(it.m.url);
}

document.addEventListener('DOMContentLoaded', () => {
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = String(v); };
  set('ml-rank', _ml.rank); set('ml-minodds', _ml.minOdds); set('ml-tier', _ml.tier);
  set('ml-ref', _ml.ref); set('ml-sort', _ml.sort);
});
