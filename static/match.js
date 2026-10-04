/* ══════════════════════════════════════════════════════════════════════
   match.js — the 🎯 MATCH tab: paste an asianbetsoccer link, get one page
   with everything about that match.

   Sub-views:
     OVERVIEW     match header, every book's prices, opening→current
                  movement (1X2 / AH / TL) with a one-line read
     VALUE        Bet365 vs the reference book's de-vigged fair price:
                  edge %, advised minimum odds, Kelly stake
     FAIR PRICES  fair_model.js scoreline model fitted to the reference
                  book → probabilities + fair odds for every market
                  (+ an in-play "from now" section once the match is live)
     HISTORICAL   one click into the existing Manual analysis (the
                  similar-matches engine in app.js), pre-filled with
                  this match's Bet365 odds

   Why Sbobet is the default reference (backtested 2026-10-02 on
   CrossBooks/, 14 months, AH + O/U, same line on both books):
     Bet365 OPENING price ≥3% above Sbobet's OPENING de-vigged fair
       → n=8,671, ROI +4.8%, 13/14 months positive (≥5%: +6.4%, 12/14).
     Same selection bet at Bet365's CLOSING price → −3.6% (the edge is in
     the price, not the side — Bet365 corrects toward Sbobet ~80% of the time).
     Bet365 current vs Sbobet's OLD opening price → −4.5% (always compare
     prices taken at the same moment).
     Bet365 closing vs Sbobet closing fair: ≥3% → +2.4% (8/14), ≥5% → +6.2% (10/14).
   Crown / market average as reference are NOT backtested (no history for
   them) — the UI labels them so.

   Depends on: fair_model.js (window.FairModel), app.js (esc, switchTab,
   fillFromScraped, analyzeMatch, state, _db).
   ══════════════════════════════════════════════════════════════════════ */

const MT_PREF_KEY = 'halvest_match_prefs';

const _mt = {
  url: null,
  data: null,          // raw /api/scrape response
  view: 'overview',    // overview | value | fair | historical
  refPref: 'auto',     // auto | <book key>
  betBook: 'bet365',
  threshold: 3,        // % edge required to flag a value bet
  kellyFrac: 0.25,
  bankroll: null,
  loading: false,
  live: null,          // last /api/livematch response + fetchedAt (in-play only)
};
const MT_LIVE_POLL_MS = 60000;
const MT_LIVE_SUSPECT_EDGE = 0.15; // live model gaps above this get no stake
let _mtLiveTimer = null;

(function loadMatchPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(MT_PREF_KEY) || '{}');
    for (const k of ['refPref', 'betBook', 'threshold', 'kellyFrac', 'bankroll']) if (p[k] != null) _mt[k] = p[k];
  } catch (_) { /* storage unavailable — defaults are fine */ }
})();
function saveMatchPrefs() {
  try {
    localStorage.setItem(MT_PREF_KEY, JSON.stringify({
      refPref: _mt.refPref, betBook: _mt.betBook, threshold: _mt.threshold,
      kellyFrac: _mt.kellyFrac, bankroll: _mt.bankroll,
    }));
  } catch (_) {}
}

/* ── small formatters ─────────────────────────────────────────────────── */
const mtEsc = s => (typeof esc === 'function' ? esc(s) : String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])));
const fOdd = o => (o > 1 && isFinite(o)) ? o.toFixed(2) : '—';
const fPct = (p, d = 1) => Number.isFinite(p) ? (p * 100).toFixed(d) + '%' : '—';
const fSigned = (x, d = 1) => Number.isFinite(x) ? (x > 0 ? '+' : '') + x.toFixed(d) : '—';
const fLine = x => FairModel.fmtLine(x);
const num = x => (typeof x === 'number' && isFinite(x)) ? x : null;
const sameLine = (a, b) => num(a) != null && num(b) != null && Math.abs(a - b) < 0.01;

const BOOK_LABEL = { bet365: 'Bet365', sbobet: 'Sbobet', crown: 'Crown', '188bet': '188bet', '12bet': '12bet', '18bet': '18bet', avg: 'Market avg', pinnacle: 'Pinnacle' };
const bookLabel = k => BOOK_LABEL[k] || (_mt.data?.books?.[k]?.name) || k;
// Only Sbobet (and Pinnacle, no longer available) were backtested as a reference.
const VALIDATED_REFS = new Set(['sbobet', 'pinnacle']);

/* ── import ───────────────────────────────────────────────────────────── */
async function importMatchTab(urlArg) {
  const input = document.getElementById('mt-url');
  const url = (urlArg || input?.value || '').trim();
  const status = document.getElementById('mt-status');
  if (!url) return;
  if (!/asianbetsoccer\.com/i.test(url) || !/[?&]id=[a-f0-9]+/i.test(url)) {
    if (status) { status.textContent = '✗ Paste an asianbetsoccer.com match link (it contains ?id=…)'; status.className = 'url-import-status error'; }
    return;
  }
  if (input) input.value = url;
  _mt.loading = true;
  if (status) { status.textContent = 'Fetching match…'; status.className = 'url-import-status loading'; }
  const btn = document.getElementById('mt-import-btn'); if (btn) btn.disabled = true;
  try {
    const resp = await fetch('/api/scrape?url=' + encodeURIComponent(url));
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    if (!data.books) throw new Error('The scrape function is an older version without per-book data — redeploy functions/api/scrape.js.');
    if (_mt.url !== url) _mt.live = null;
    _mt.url = url; _mt.data = data; _mt.fetchedAt = new Date();
    const n = Object.keys(data.books).length;
    if (status) { status.textContent = `✓ ${data.match?.home || 'Match'} v ${data.match?.away || ''} — ${n} books`; status.className = 'url-import-status ok'; }
    document.getElementById('mt-refresh-btn')?.style.removeProperty('display');
    renderMatchControls();
    renderMatchTab();
    syncLivePolling();
  } catch (e) {
    if (status) { status.textContent = '✗ ' + e.message; status.className = 'url-import-status error'; }
  } finally {
    _mt.loading = false; if (btn) btn.disabled = false;
  }
}
function refreshMatchTab() { if (_mt.url) importMatchTab(_mt.url); }

function setMatchView(v) { _mt.view = v; renderMatchTab(); }
function setMatchPref(key, value) {
  if (key === 'threshold' || key === 'kellyFrac') value = parseFloat(value);
  if (key === 'bankroll') { value = parseFloat(value); if (!(value > 0)) value = null; }
  _mt[key] = value; saveMatchPrefs();
  if (_mt.data) renderMatchTab();
}

/* ── book selection ───────────────────────────────────────────────────── */
const hasPrices = b => b && ((num(b.ah_hc) != null && b.ho_c > 1 && b.ao_c > 1) || (num(b.tl_c) != null && b.ov_c > 1 && b.un_c > 1));

function pickReference(books) {
  if (_mt.refPref !== 'auto' && hasPrices(books[_mt.refPref]) && _mt.refPref !== _mt.betBook) return _mt.refPref;
  for (const k of ['sbobet', 'pinnacle', 'crown', 'avg']) if (k !== _mt.betBook && hasPrices(books[k])) return k;
  return Object.keys(books).find(k => k !== _mt.betBook && hasPrices(books[k])) || null;
}

/* ── fair model for one book at one moment ('c' = current/closing, 'o' = opening) ── */
function fitBook(b, when = 'c') {
  if (!b) return null;
  const line = num(b['ah_h' + when]), tl = num(b['tl_' + when]);
  const ah = FairModel.devig([b['ho_' + when], b['ao_' + when]]);
  const ou = FairModel.devig([b['ov_' + when], b['un_' + when]]);
  const x = b.x12 ? FairModel.devig([b.x12['h_' + when], b.x12['d_' + when], b.x12['a_' + when]]) : null;
  let fit = null;
  if (ah && line != null) fit = FairModel.solve({ ahLine: line, ahHomeFair: ah.fair[0], tl: ou ? tl : NaN, overFair: ou ? ou.fair[0] : NaN });
  else if (x) fit = FairModel.solveFrom1x2({ pHome: x.probs[0], pAway: x.probs[2], tl: ou ? tl : NaN, overFair: ou ? ou.fair[0] : NaN });
  if (!fit) return null;
  return { line, tl, ah, ou, x12: x, fit, markets: FairModel.markets(fit.lh, fit.la) };
}

/* ── value rows: bet book price vs reference fair ─────────────────────── */
// For each market the bet book prices: fair odds come from the reference
// book's own de-vigged price when both books quote the SAME line ("direct" —
// the backtested comparison), else from the model fitted to the reference
// book, priced at the bet book's line ("model" — line conversion, not
// backtested, shown with a marker).
function buildValueRows(bet, refFit, when = 'c') {
  if (!bet || !refFit) return [];
  const rows = [];
  const { lh, la } = refFit.fit;
  const push = (market, side, label, price, fair, method, line) => {
    if (!(price > 1) || !(fair > 1)) return;
    const edge = price / fair - 1;
    const p = 1 / fair;
    rows.push({ market, side, label, price, fair, method, line, edge, p, minOdds: fair * (1 + _mt.threshold / 100), kelly: FairModel.kelly(p, price, _mt.kellyFrac) });
  };
  const bl = num(bet['ah_h' + when]);
  if (bl != null) {
    const direct = sameLine(bl, refFit.line) && refFit.ah;
    push('AH', 'home', `Home ${fLine(bl)}`, bet['ho_' + when], direct ? refFit.ah.fair[0] : FairModel.priceAH(lh, la, bl, 'home'), direct ? 'direct' : 'model', bl);
    push('AH', 'away', `Away ${fLine(-bl)}`, bet['ao_' + when], direct ? refFit.ah.fair[1] : FairModel.priceAH(lh, la, bl, 'away'), direct ? 'direct' : 'model', bl);
  }
  const btl = num(bet['tl_' + when]);
  if (btl != null) {
    const direct = sameLine(btl, refFit.tl) && refFit.ou;
    push('OU', 'over', `Over ${btl}`, bet['ov_' + when], direct ? refFit.ou.fair[0] : FairModel.priceOU(lh, la, btl, 'over'), direct ? 'direct' : 'model', btl);
    push('OU', 'under', `Under ${btl}`, bet['un_' + when], direct ? refFit.ou.fair[1] : FairModel.priceOU(lh, la, btl, 'under'), direct ? 'direct' : 'model', btl);
  }
  // 1X2: always priced from the model fitted to the reference book's AH+TL,
  // never from the reference book's own 1X2 de-vigged proportionally — that
  // overstates long shots (Boca v Unión, 2026-10-03: Sbobet 1X2 → away fair
  // 7.30, model → 8.07, and Bet365 offered 8.00). Backtest (static/data
  // Bet365 1X2 vs model fair from CrossBooks Sbobet): closing ≥3% → +1.3%
  // ROI (8/14 months); opening looked implausibly good (+13.6% on 26k bets,
  // ~1 in 10 flagged), most likely the two books' openings were captured at
  // different times. Treated as unvalidated — tagged 'model' in the UI.
  if (bet.x12) {
    const m = refFit.markets.result;
    ['h', 'd', 'a'].forEach((s, i) => {
      push('1X2', s, ['Home win', 'Draw', 'Away win'][i], bet.x12[s + '_' + when], m[i].fair, 'model');
    });
  }
  return rows.sort((a, b) => b.edge - a.edge);
}

/* ── movement read ────────────────────────────────────────────────────── */
// Plain-language summary of opening→current for one book, plus the effect
// sizes measured on the Bet365 dataset (2026-10-02, ~250k matches: residual
// goals vs what the CLOSING price implies, same closing line/price).
function movementRead(b) {
  if (!b) return null;
  const notes = [], parts = [];
  const lo = num(b.ah_ho), lc = num(b.ah_hc);
  if (lo != null && lc != null) {
    const favHome = lc < 0 || (lc === 0 && b.ho_c <= b.ao_c);
    const favName = favHome ? 'home' : 'away';
    const grow = favHome ? (lo - lc) : (lc - lo); // >0 = favourite's handicap got bigger
    if (grow > 0.01) {
      parts.push(`favourite (${favName}) backed — line ${fLine(lo)} → ${fLine(lc)}`);
      notes.push('Favourite line grew: historically the favourite is slightly weaker in the 2nd half than the closing price says (−0.02 to −0.03 goals of margin).');
    } else if (grow < -0.01) {
      parts.push(`favourite (${favName}) drifted — line ${fLine(lo)} → ${fLine(lc)}`);
    } else {
      const po = favHome ? b.ho_o : b.ao_o, pc = favHome ? b.ho_c : b.ao_c;
      if (po > 1 && pc > 1 && Math.abs(pc - po) >= 0.05) parts.push(`same line, favourite price ${pc < po ? 'shortened' : 'lengthened'} ${fOdd(po)} → ${fOdd(pc)}`);
      else parts.push('handicap stable');
    }
  }
  const to = num(b.tl_o), tc = num(b.tl_c);
  if (to != null && tc != null) {
    const d = tc - to;
    if (d <= -0.49) { parts.push(`goals line down ${to} → ${tc}`); notes.push('Total line dropped ≥0.5: historically the market overshoots — about +0.04 goals more than the closing price implies (≈ +1pp on Over), FT and 2H.'); }
    else if (d < -0.01) parts.push(`goals line down ${to} → ${tc}`);
    else if (d >= 0.49) parts.push(`goals line up ${to} → ${tc}`);
    else if (d > 0.01) { parts.push(`goals line up ${to} → ${tc}`); notes.push('Total line rose 0.25: historically slightly fewer 1H goals than priced (−0.02 goals).'); }
    else if (b.ov_o > 1 && b.ov_c > 1) {
      const od = b.ov_c - b.ov_o;
      if (od <= -0.08) { parts.push(`same goals line, Over shortened ${fOdd(b.ov_o)} → ${fOdd(b.ov_c)}`); notes.push('Over steamed on an unchanged line: historically the market under-reacts — about +0.045 goals vs the closing price (≈ +1pp on Over).'); }
      else if (od >= 0.08) { parts.push(`same goals line, Over drifted ${fOdd(b.ov_o)} → ${fOdd(b.ov_c)}`); notes.push('Over drifted on an unchanged line: historically about −0.04 goals vs the closing price (≈ −1pp on Over).'); }
      else parts.push('goals line stable');
    }
  }
  return { text: parts.join(' · '), notes };
}

/* ── in-play ──────────────────────────────────────────────────────────── */
// The match page only has pre-match prices; /api/livematch adds the live
// minute/score/HT and Bet365's current in-play prices. Polled every minute
// while the match is (or should be) in play and the MATCH tab is open.
function matchId(url) { const m = (url || '').match(/[?&]id=([a-f0-9]+)/i); return m ? m[1].toLowerCase() : null; }

function shouldPollLive() {
  const m = _mt.data?.match;
  if (!m || m.status === 'FT') return false;
  if (m.status === 'LIVE' || m.status === 'HT') return true;
  const ko = m.kickoff ? new Date(m.kickoff).getTime() : NaN;
  return Number.isFinite(ko) && ko - Date.now() < 10 * 60000 && Date.now() - ko < 3 * 3600e3;
}
function syncLivePolling() {
  clearInterval(_mtLiveTimer); _mtLiveTimer = null;
  if (!shouldPollLive()) return;
  pollMatchLive();
  _mtLiveTimer = setInterval(() => {
    if (typeof _activeTab !== 'undefined' && _activeTab !== 'match') return;
    if (!shouldPollLive()) { clearInterval(_mtLiveTimer); _mtLiveTimer = null; return; }
    pollMatchLive();
  }, MT_LIVE_POLL_MS);
}
async function pollMatchLive() {
  const id = matchId(_mt.url); if (!id) return;
  let data = null;
  try {
    const resp = await fetch('/api/livematch?id=' + id);
    data = await resp.json();
  } catch (_) { /* asianbetsoccer side failed — Sofascore below may still have prices */ }
  if (matchId(_mt.url) !== id) return; // another match was loaded meanwhile
  const wasLive = !!_mt.live?.minute;
  if (data) {
    // Dropped off the live feed after being live → finished; re-read the page for the FT state.
    if (wasLive && !data.found) { _mt.live = Object.assign(data, { fetchedAt: new Date() }); refreshMatchTab(); return; }
  } else if (!_mt.live) {
    data = { found: false, notes: ['The live feed could not be reached.'] };
  } else {
    data = Object.assign({}, _mt.live, { live_odds: null, live_source: null, notes: ['The live feed could not be reached — showing the last minute/score.'] });
  }
  data.live_source = data.live_odds ? 'asianbetsoccer' : null;
  await Promise.all([data.live_odds ? null : addSofascoreOdds(data), addPinnacleMatch(data)]);
  if (matchId(_mt.url) !== id) return;
  _mt.live = Object.assign(data, { fetchedAt: new Date() });
  renderMatchTab();
}

// Fallback for Bet365's in-play prices: Sofascore (bet365 is its odds
// provider), fetched from this browser — see sofascore.js. The event is
// looked up once per match, then reused.
async function addSofascoreOdds(data) {
  if (typeof Sofa === 'undefined') return;
  const m = _mt.data?.match || {};
  const st = matchState();
  if (!(st.status === 'LIVE' || st.status === 'HT' || data.minute)) return;
  try {
    if (!_mt.sofa || _mt.sofa.url !== _mt.url) {
      const score = data.score || st.score || null;
      const ev = await Sofa.findLiveEvent(m.home, m.away, score);
      _mt.sofa = { url: _mt.url, event: ev, tried: Date.now() };
    } else if (!_mt.sofa.event && Date.now() - _mt.sofa.tried > 5 * 60000) {
      _mt.sofa = null; return addSofascoreOdds(data); // not found earlier — look again every 5 min
    }
    const ev = _mt.sofa.event;
    if (!ev) return;
    const odds = await Sofa.liveOdds(ev.id);
    if (!odds) return;
    data.live_odds = odds;
    data.live_source = 'sofascore';
    data.sofaUrl = Sofa.eventUrl(ev);
    data.sofaName = `${ev.homeTeam?.name} v ${ev.awayTeam?.name}`;
    // The asianbetsoccer note about missing in-play prices no longer applies.
    data.notes = (data.notes || []).filter(n => !/in-play prices unavailable/i.test(n));
  } catch (e) {
    data.notes = [...(data.notes || []), `Sofascore fallback failed: ${e.message}`];
  }
}
// Pinnacle's live sheet for this match (pinnacle.js / /api/pinnacle), the
// sharp reference for the In-play value table.
async function addPinnacleMatch(data) {
  if (typeof Pinn === 'undefined') return;
  const st = matchState();
  if (!(st.status === 'LIVE' || st.status === 'HT' || data.minute)) return;
  try {
    const d = await Pinn.get();
    if (d.error) { data.pinError = d.error; return; }
    const m = _mt.data?.match || {};
    data.pin = Pinn.find(d.matches, m.home, m.away, data.score || st.score || null);
  } catch (e) { data.pinError = e.message; }
}
// Label for whichever feed the Bet365 live prices came from.
function liveSourceTag() {
  const L = _mt.live;
  if (L?.live_source !== 'sofascore') return '';
  return ` <span class="mt-tag model" title="asianbetsoccer had no Bet365 in-play prices for this match — these are Bet365's, via Sofascore (${mtEsc(L.sofaName || '')}). Its goals market is the .5-line Match Goals, not the Asian goal line.">via Sofascore</span>`;
}

// Current match state, preferring the live feed over the (slower) page.
function matchState() {
  const m = _mt.data?.match || {};
  const L = _mt.live?.found ? _mt.live : null;
  if (L?.minute) {
    const ht = L.minute === 'HT';
    return { status: ht ? 'HT' : 'LIVE', minute: ht ? 45 : parseInt(L.minute, 10), stoppage: !ht && L.minute.includes('+'),
             minuteText: ht ? 'HT' : L.minute.replace(/'?\+$/, "'+"), score: L.score || m.score, htScore: L.htScore || m.htScore };
  }
  return { status: m.status, minute: m.minute, stoppage: !!m.stoppage,
           minuteText: m.minute != null ? `${m.minute}'${m.stoppage ? '+' : ''}` : null,
           score: m.score, htScore: m.htScore };
}

// Bet365 in-play price vs the live model fair price (pre-match λ from the
// reference book → goal-timing decay + score state). Not backtested.
function buildLiveValueRows(lm, odds) {
  if (!lm || !odds) return [];
  const rows = [];
  const g0 = lm.score.home + lm.score.away;
  const push = (market, label, price, fair) => {
    if (!(price > 1) || !(fair > 1) || !isFinite(fair)) return;
    const p = 1 / fair;
    rows.push({ market, label, price, fair, p, method: 'model', edge: price / fair - 1, minOdds: fair * (1 + _mt.threshold / 100), kelly: FairModel.kelly(p, price, _mt.kellyFrac) });
  };
  ['x2_h', 'x2_x', 'x2_a'].forEach((k, i) => push('1X2', ['Home win', 'Draw', 'Away win'][i], odds[k], lm.result[i].fair));
  if (num(odds.ah_hc) != null) {
    push('AH', `Home ${fLine(odds.ah_hc)} (from now)`, odds.ho_c, FairModel.fairOddsFromDist(FairModel.ahDist(lm.grid, odds.ah_hc, 'home')));
    push('AH', `Away ${fLine(-odds.ah_hc)} (from now)`, odds.ao_c, FairModel.fairOddsFromDist(FairModel.ahDist(lm.grid, odds.ah_hc, 'away')));
  }
  if (num(odds.tl_c) != null && odds.tl_c > g0) {
    push('OU', `Over ${odds.tl_c}`, odds.ov_c, FairModel.fairOddsFromDist(FairModel.outcomeDist(lm.grid, (h, a) => g0 + h + a, -odds.tl_c)));
    push('OU', `Under ${odds.tl_c}`, odds.un_c, FairModel.fairOddsFromDist(FairModel.outcomeDist(lm.grid, (h, a) => -(g0 + h + a), odds.tl_c)));
  }
  return rows.sort((a, b) => b.edge - a.edge);
}

/* ══ RENDER ═══════════════════════════════════════════════════════════ */
function renderMatchControls() {
  const books = _mt.data?.books || {};
  const keys = Object.keys(books).filter(k => hasPrices(books[k]));
  const refSel = document.getElementById('mt-ref');
  const betSel = document.getElementById('mt-bet');
  if (refSel) {
    const opts = ['auto', ...keys.filter(k => k !== _mt.betBook)];
    refSel.innerHTML = opts.map(k => `<option value="${mtEsc(k)}"${k === _mt.refPref ? ' selected' : ''}>${k === 'auto' ? 'Auto (Sbobet → Crown → avg)' : mtEsc(bookLabel(k)) + (VALIDATED_REFS.has(k) ? ' ✓ backtested' : ' (not backtested)')}</option>`).join('');
  }
  if (betSel && keys.length) {
    if (!keys.includes(_mt.betBook)) keys.unshift(_mt.betBook);
    betSel.innerHTML = keys.map(k => `<option value="${mtEsc(k)}"${k === _mt.betBook ? ' selected' : ''}>${mtEsc(bookLabel(k))}</option>`).join('');
  }
}

function renderMatchTab() {
  const el = document.getElementById('right-match');
  if (!el) return;
  const d = _mt.data;
  if (!d) return;
  if (typeof FairModel === 'undefined') { el.innerHTML = '<div class="placeholder"><p>fair_model.js failed to load.</p></div>'; return; }

  const books = d.books || {};
  const m = d.match || {};
  const bet = books[_mt.betBook];
  const refKey = pickReference(books);
  const ref = refKey ? books[refKey] : null;
  const refFit = fitBook(ref, 'c');
  const betFit = fitBook(bet, 'c');
  const st = matchState();
  const live = st.status === 'LIVE' || st.status === 'HT';
  const lm = live && refFit ? FairModel.liveMarkets(refFit.fit.lh, refFit.fit.la, st) : null;
  const ctx = { d, m, st, lm, books, bet, refKey, ref, refFit, betFit, live, finished: st.status === 'FT' };

  const views = [
    ['overview', '📋 Overview'], ['value', '💰 Value'], ['fair', '🎲 Fair prices'], ['historical', '📚 Historical'],
  ];
  el.innerHTML = `
    ${renderMatchHeader(ctx)}
    <div class="mt-views" role="tablist">
      ${views.map(([k, l]) => `<button class="mt-view-btn${_mt.view === k ? ' active' : ''}" role="tab" aria-selected="${_mt.view === k}" onclick="setMatchView('${k}')">${l}</button>`).join('')}
    </div>
    <div class="mt-view-body">
      ${_mt.view === 'overview' ? renderMtOverview(ctx)
        : _mt.view === 'value' ? renderMtValue(ctx)
        : _mt.view === 'fair' ? renderMtFair(ctx)
        : renderMtHistorical(ctx)}
    </div>`;
}

function renderMatchHeader({ m, st, lm, refKey, refFit, live, finished }) {
  const statusTxt = st.status === 'HT' ? 'Half-time'
    : st.status === 'LIVE' ? `LIVE ${st.minuteText ?? ''}`
    : st.status === 'FT' ? 'Full-time'
    : (m.kickoff ? fmtKickoff(m.kickoff) : 'Pre-match');
  const score = st.score ? `${st.score.home} - ${st.score.away}` : '–';
  const ht = st.htScore ? `${st.htScore.home} - ${st.htScore.away}` : '–';
  const L = _mt.live;
  const cards = side => {
    const c = m.cards?.[side] || {};
    return `${c.yellow ? `<span class="mt-card y">${c.yellow}</span>` : ''}${c.red ? `<span class="mt-card r">${c.red}</span>` : ''}`;
  };
  const xg = refFit ? `${refFit.fit.lh.toFixed(2)} – ${refFit.fit.la.toFixed(2)}` : '—';
  return `
    <div class="mt-league">${mtEsc(m.league || '')}${_mt.fetchedAt ? ` · <span class="mt-dim">fetched ${_mt.fetchedAt.toLocaleTimeString()}</span>` : ''}</div>
    <div class="mt-head">
      <div class="mt-hcard mt-hcard-match">
        <div class="mt-hlabel">MATCH</div>
        <div class="mt-teams"><span>${mtEsc(m.home || 'Home')} ${cards('home')}</span><span class="mt-vs">vs</span><span>${mtEsc(m.away || 'Away')} ${cards('away')}</span></div>
      </div>
      <div class="mt-hcard"><div class="mt-hlabel">STATUS</div><div class="mt-hval ${live ? 'mt-live' : ''}">${statusTxt}</div></div>
      <div class="mt-hcard"><div class="mt-hlabel">SCORE / HT</div><div class="mt-hval num">${score} <span class="mt-dim">/ ${ht}</span></div>
        ${m.corners ? `<div class="mt-sub">corners ${m.corners.home} - ${m.corners.away}</div>` : ''}</div>
      <div class="mt-hcard"><div class="mt-hlabel">${lm ? 'GOALS STILL TO COME' : 'EXPECTED GOALS'} (${mtEsc(refKey ? bookLabel(refKey) : '—')})</div>
        <div class="mt-hval num">${lm ? `${lm.live.lh.toFixed(2)} – ${lm.live.la.toFixed(2)}` : xg}</div>
        ${refFit ? `<div class="mt-sub">${lm ? `pre-match ${xg}` : `total ${refFit.fit.mu.toFixed(2)}`}</div>` : ''}</div>
    </div>
    ${live ? `<div class="mt-banner live">🔴 In play — minute, score and Bet365's in-play prices refresh every minute${L?.fetchedAt ? ` (last ${L.fetchedAt.toLocaleTimeString()})` : ''}.
      Live fair prices = pre-match strength (${mtEsc(refKey ? bookLabel(refKey) : 'reference')}) decayed by the real goal-timing curve and score state — a model, not backtested.
      ${(m.cards?.home?.red || m.cards?.away?.red) ? '<b>A red card has been shown — the model does not adjust for it.</b>' : ''}
      ${L && !L.live_odds ? '<br>Bet365 in-play prices aren&#39;t available for this match right now (asianbetsoccer and Sofascore both checked).' : ''}
      ${L?.live_source === 'sofascore' ? `<br>Bet365 in-play prices via <a href="${mtEsc(L.sofaUrl || 'https://www.sofascore.com')}" target="_blank" rel="noopener">Sofascore</a> (${mtEsc(L.sofaName || '')}) — asianbetsoccer's Bet365 Live feed has nothing for this match.` : ''}${(L?.notes || []).map(n => `<br>${mtEsc(n)}`).join('')}</div>`
      : finished ? `<div class="mt-banner warn">⏱ This match is over — the prices below are the pre-match opening/closing prices.</div>` : ''}`;
}

// "Sat 03 Oct 02:30 · in 3h 10m" in the viewer's local time.
function fmtKickoff(iso) {
  const t = new Date(iso);
  if (isNaN(t.getTime())) return 'Kick-off ' + mtEsc(iso);
  const when = t.toLocaleString(undefined, { weekday: 'short', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  const mins = Math.round((t - Date.now()) / 60000);
  const rel = mins <= 0 ? 'starting' : mins < 60 ? `in ${mins}m` : mins < 48 * 60 ? `in ${Math.floor(mins / 60)}h ${mins % 60}m` : `in ${Math.round(mins / 1440)} days`;
  return `${mtEsc(when)}<div class="mt-sub">${rel}</div>`;
}

/* ── OVERVIEW ─────────────────────────────────────────────────────────── */
function moveCard(label, o, c, { isLine = false, hint = '' } = {}) {
  if (o == null && c == null) return '';
  let cls = '', delta = '';
  if (!isLine && o > 1 && c > 1) {
    const pct = (c / o - 1) * 100;
    cls = pct < -0.5 ? 'down' : pct > 0.5 ? 'up' : '';
    delta = `<span class="mt-delta ${cls}">${fSigned(pct)}%</span>`;
  } else if (isLine && o != null && c != null && Math.abs(c - o) > 0.01) {
    cls = c < o ? 'down' : 'up';
    delta = `<span class="mt-delta ${cls}">${fSigned(c - o, 2)}</span>`;
  }
  const show = v => isLine ? (label.includes('TOTAL') ? (v ?? '—') : fLine(v)) : fOdd(v);
  const arrow = (o != null && c != null && Math.abs(c - o) > 0.001) ? (c < o ? '▼' : '▲') : '→';
  return `<div class="mt-move ${cls}">
    <div class="mt-hlabel">${label}</div>
    <div class="mt-move-val num">${show(o)} <span class="mt-arrow">${arrow}</span> <b>${show(c)}</b> ${delta}</div>
    ${hint ? `<div class="mt-sub">${hint}</div>` : ''}
  </div>`;
}

function renderMtOverview({ books, bet, refKey, ref }) {
  if (!bet) return `<div class="mt-banner warn">${mtEsc(bookLabel(_mt.betBook))} isn't listed for this match.</div>` + renderBooksTable(books, refKey);
  const read = movementRead(bet);
  const refRead = ref ? movementRead(ref) : null;
  const x = bet.x12 || {};
  const favHome = num(bet.ah_hc) != null ? (bet.ah_hc < 0 || (bet.ah_hc === 0 && bet.ho_c <= bet.ao_c)) : null;
  const ahHint = num(bet.ah_hc) != null && num(bet.ah_ho) != null && Math.abs(bet.ah_hc - bet.ah_ho) > 0.01
    ? ((bet.ah_hc < bet.ah_ho) ? 'toward Home' : 'toward Away') : '';
  const tlHint = num(bet.tl_c) != null && num(bet.tl_o) != null && Math.abs(bet.tl_c - bet.tl_o) > 0.01
    ? (bet.tl_c < bet.tl_o ? 'toward fewer goals' : 'toward more goals') : '';
  return `
    <div class="mt-section-title">ODDS MOVEMENT · ${mtEsc(bookLabel(_mt.betBook))} <span class="mt-dim">opening → current</span></div>
    <div class="mt-grid3">
      ${moveCard('HOME (1)', x.h_o, x.h_c)}${moveCard('DRAW (X)', x.d_o, x.d_c)}${moveCard('AWAY (2)', x.a_o, x.a_c)}
    </div>
    <div class="mt-grid4">
      ${moveCard('AH LINE (HOME)', bet.ah_ho, bet.ah_hc, { isLine: true, hint: ahHint })}
      ${moveCard(`AH ${favHome == null ? '' : favHome ? 'HOME' : 'AWAY'} PRICE`, favHome === false ? bet.ao_o : bet.ho_o, favHome === false ? bet.ao_c : bet.ho_c)}
      ${moveCard('TOTAL LINE', bet.tl_o, bet.tl_c, { isLine: true, hint: tlHint })}
      ${moveCard('OVER PRICE', bet.ov_o, bet.ov_c)}
    </div>
    ${read && read.text ? `<div class="mt-read"><b>Read:</b> ${mtEsc(read.text)}${refRead && refRead.text && ref ? `<div class="mt-sub">${mtEsc(bookLabel(refKey))}: ${mtEsc(refRead.text)}</div>` : ''}
      ${read.notes.length ? `<ul class="mt-notes">${read.notes.map(n => `<li>${mtEsc(n)}</li>`).join('')}</ul><div class="mt-sub">These effects are about 1 percentage point — context, not a bet on their own.</div>` : ''}</div>` : ''}
    ${renderBooksTable(books, refKey)}`;
}

function renderBooksTable(books, refKey) {
  const keys = Object.keys(books).filter(k => hasPrices(books[k]) || books[k].x12);
  if (!keys.length) return '';
  // best current price per column, only among books quoting the same line as the bet book
  const betB = books[_mt.betBook] || {};
  const best = {};
  const consider = (col, k, v, ok) => { if (ok && v > 1 && (!best[col] || v > best[col].v)) best[col] = { k, v }; };
  for (const k of keys) {
    const b = books[k]; if (k === 'avg') continue;
    consider('ho', k, b.ho_c, sameLine(b.ah_hc, betB.ah_hc)); consider('ao', k, b.ao_c, sameLine(b.ah_hc, betB.ah_hc));
    consider('ov', k, b.ov_c, sameLine(b.tl_c, betB.tl_c)); consider('un', k, b.un_c, sameLine(b.tl_c, betB.tl_c));
    consider('h', k, b.x12?.h_c, true); consider('d', k, b.x12?.d_c, true); consider('a', k, b.x12?.a_c, true);
  }
  const cell = (col, k, v, o) => {
    const isBest = best[col] && best[col].k === k && keys.length > 2;
    const mv = (v > 1 && o > 1 && Math.abs(v - o) > 0.001) ? `<span class="mt-mini ${v < o ? 'down' : 'up'}">${v < o ? '▼' : '▲'}${fOdd(o)}</span>` : '';
    return `<td class="num${isBest ? ' mt-best' : ''}">${fOdd(v)}${mv}</td>`;
  };
  const rowsHtml = keys.map(k => {
    const b = books[k]; const x = b.x12 || {};
    const tags = (k === _mt.betBook ? '<span class="mt-tag bet">BET</span>' : '') + (k === refKey ? '<span class="mt-tag ref">REF</span>' : '');
    return `<tr class="${k === _mt.betBook ? 'mt-row-bet' : ''}${k === refKey ? ' mt-row-ref' : ''}">
      <td class="mt-bookname">${mtEsc(bookLabel(k))} ${tags}</td>
      <td class="num">${fLine(b.ah_hc)}</td>${cell('ho', k, b.ho_c, b.ho_o)}${cell('ao', k, b.ao_c, b.ao_o)}
      <td class="num">${b.tl_c ?? '—'}</td>${cell('ov', k, b.ov_c, b.ov_o)}${cell('un', k, b.un_c, b.un_o)}
      ${cell('h', k, x.h_c, x.h_o)}${cell('d', k, x.d_c, x.d_o)}${cell('a', k, x.a_c, x.a_o)}
    </tr>`;
  }).join('');
  return `
    <div class="mt-section-title">ALL BOOKS · current <span class="mt-dim">(▲▼ = opening price · green = best price on ${mtEsc(bookLabel(_mt.betBook))}'s line)</span></div>
    <div class="mt-table-wrap"><table class="mt-table">
      <thead><tr><th>Book</th><th>AH</th><th>Home</th><th>Away</th><th>TL</th><th>Over</th><th>Under</th><th>1</th><th>X</th><th>2</th></tr></thead>
      <tbody>${rowsHtml}</tbody>
    </table></div>`;
}

/* ── VALUE ────────────────────────────────────────────────────────────── */
function renderMtValue({ bet, ref, refKey, refFit, live, finished, lm }) {
  if (!bet) return `<div class="mt-banner warn">${mtEsc(bookLabel(_mt.betBook))} isn't listed for this match — nothing to compare.</div>`;
  if (!ref || !refFit) return `<div class="mt-banner warn">No reference book with usable prices for this match (Sbobet isn't listed). Pick another reference in the left panel, or skip this match — without a sharp reference there's no measured edge (Bet365 alone averages −4.5% ROI).</div>`;

  const validated = VALIDATED_REFS.has(refKey);
  const rows = buildValueRows(bet, refFit, 'c');
  const refOpenFit = fitBook(ref, 'o');
  const openRows = refOpenFit ? buildValueRows(bet, refOpenFit, 'o') : [];
  const flagged = rows.filter(r => r.edge * 100 >= _mt.threshold);
  const bank = _mt.bankroll;

  const rowHtml = r => {
    const hit = r.edge * 100 >= _mt.threshold;
    const cls = hit ? 'mt-v-hit' : r.edge > 0 ? 'mt-v-pos' : 'mt-v-neg';
    const stake = hit && r.kelly > 0 ? (bank ? `€${(bank * r.kelly).toFixed(2)}` : fPct(r.kelly, 2)) : '—';
    return `<tr class="${cls}">
      <td>${r.market === 'OU' ? 'O/U' : r.market}</td>
      <td class="mt-strong">${mtEsc(r.label)}${r.method === 'model' ? ' <span class="mt-tag model" title="Fair price converted through the scoreline model (different line on the two books, or a 1X2 market). Not validated like the same-line AH/O-U comparison.">model</span>' : ''}${r.suspect ? ` <span class="mt-tag model" title="${mtEsc(r.suspect)}">verify</span>` : ''}</td>
      <td class="num mt-strong">${fOdd(r.price)}</td>
      <td class="num">${fOdd(r.fair)}</td>
      <td class="num">${fPct(r.p)}</td>
      <td class="num mt-edge">${fSigned(r.edge * 100)}%</td>
      <td class="num">${fOdd(r.minOdds)}</td>
      <td class="num">${stake}</td>
    </tr>`;
  };

  const openHtml = openRows.length ? `
    <div class="mt-section-title">AT OPENING <span class="mt-dim">— ${mtEsc(bookLabel(_mt.betBook))} opening vs ${mtEsc(bookLabel(refKey))} opening (the moment the backtested edge is biggest)</span></div>
    <div class="mt-chips">${openRows.filter(r => r.method === 'direct').map(r =>
      `<span class="mt-chip ${r.edge * 100 >= _mt.threshold ? 'hit' : r.edge > 0 ? 'pos' : ''}">${mtEsc(r.label)} @ ${fOdd(r.price)} <b>${fSigned(r.edge * 100)}%</b></span>`).join('') || '<span class="mt-dim">no same-line opening prices to compare</span>'}</div>
    <div class="mt-sub">Shows whether this match opened with a gap. You can only bet the <b>current</b> price — the table above is what matters now.</div>` : '';

  // A big live gap is far more often the model missing something the market
  // knows (a red card, an injury, one side dominating) than real value — no
  // stake for those, and a 'verify' tag.
  const redCard = !!(_mt.data?.match?.cards?.home?.red || _mt.data?.match?.cards?.away?.red);
  const liveRows = (live && lm && _mt.live?.live_odds ? buildLiveValueRows(lm, _mt.live.live_odds) : []).map(r =>
    redCard || r.edge >= MT_LIVE_SUSPECT_EDGE
      ? Object.assign(r, { kelly: 0, suspect: redCard ? 'A red card has been shown — the model still uses pre-match strength.' : 'Gap this large usually means the model is missing match information the market has.' })
      : r);
  // Pinnacle's live price on the same line, de-vigged — the sharp-book check.
  // A red card is in Pinnacle's price, so it doesn't void these rows; a huge
  // gap is still usually one price lagging the other.
  const pm = _mt.live?.pin || null;
  const pinRows = (live && pm && _mt.live?.live_odds && typeof buildPinnacleRows === 'function' ? buildPinnacleRows(_mt.live.live_odds, pm) : []).map(r =>
    r.edge >= MT_LIVE_SUSPECT_EDGE ? Object.assign(r, { kelly: 0, suspect: 'Gap this large usually means one of the two prices is lagging — check both before betting.' }) : r);
  const modelTable = liveRows.length ? `
    <div class="mt-table-wrap"><table class="mt-table mt-value-table">
      <thead><tr><th>Mkt</th><th>Bet</th><th>Bet365 live</th><th>Fair (model)</th><th>Prob</th><th>Edge</th><th>Min odds</th><th>Stake</th></tr></thead>
      <tbody>${liveRows.map(rowHtml).join('')}</tbody>
    </table></div>` : '';
  const pinNote = live && _mt.live?.live_odds && !pinRows.length
    ? `<div class="mt-sub">${pm ? 'Pinnacle has this match but not on the same lines as Bet365 right now.' : _mt.live?.pinError ? `Pinnacle: ${mtEsc(_mt.live.pinError)}` : 'Pinnacle doesn\'t list this match live — comparing with the model only.'}</div>` : '';
  const liveHtml = pinRows.length ? `
    <div class="mt-section-title">IN PLAY NOW${liveSourceTag()} <span class="mt-dim">— Bet365 live vs Pinnacle live (margin removed, same line) · not backtested</span></div>
    <div class="mt-table-wrap"><table class="mt-table mt-value-table">
      <thead><tr><th>Mkt</th><th>Bet</th><th>Bet365 live</th><th>Fair (Pinnacle)</th><th>Prob</th><th>Edge</th><th>Min odds</th><th>Stake</th></tr></thead>
      <tbody>${pinRows.map(rowHtml).join('')}</tbody>
    </table></div>
    <div class="mt-sub">Pinnacle ${mtEsc(pm.home)} v ${mtEsc(pm.away)}${pm.score?.home != null ? ` (${pm.score.home}-${pm.score.away})` : ''}. Both books: handicap counts goals from now, goal line on the full-match total. Same-moment comparison against the sharpest book — the in-play version of the pre-match check that backtested, but not itself backtested.</div>
    ${modelTable ? `<details class="mt-details"><summary>vs the live model (${liveRows.length} rows)</summary>${modelTable}</details>` : ''}
    <div class="mt-section-title" style="margin-top:22px">PRE-MATCH <span class="mt-dim">— Bet365 vs ${mtEsc(bookLabel(refKey))} at kick-off</span></div>`
    : liveRows.length ? `
    <div class="mt-section-title">IN PLAY NOW${liveSourceTag()} <span class="mt-dim">— Bet365 live price vs live model fair · not backtested</span></div>
    ${modelTable}${pinNote}
    <div class="mt-sub">In-play Asian handicap counts goals from now; the goal line is on the full-match total. This comparison has no backtest — treat an edge here as a pointer, not a signal.</div>
    <div class="mt-section-title" style="margin-top:22px">PRE-MATCH <span class="mt-dim">— Bet365 vs ${mtEsc(bookLabel(refKey))} at kick-off</span></div>` : '';

  return `
    ${liveHtml}
    ${!validated ? `<div class="mt-banner warn">Reference = <b>${mtEsc(bookLabel(refKey))}</b>, which has <b>not been backtested</b> as a fair-price reference (only Sbobet has). Treat these edges as indicative.</div>` : ''}
    ${live || finished ? `<div class="mt-banner warn">Pre-match prices — how the gap stood at kick-off, not a bet available now.</div>` : ''}
    <div class="mt-value-summary ${flagged.length ? 'hit' : ''}">
      ${flagged.length
        ? `<div class="mt-big">💰 ${flagged.length} value bet${flagged.length > 1 ? 's' : ''} ≥ ${_mt.threshold}%</div>
           <div>Best: <b>${mtEsc(flagged[0].label)}</b> @ ${fOdd(flagged[0].price)} on ${mtEsc(bookLabel(_mt.betBook))} — fair ${fOdd(flagged[0].fair)}, edge <b>${fSigned(flagged[0].edge * 100)}%</b>, take it at ≥ <b>${fOdd(flagged[0].minOdds)}</b></div>`
        : `<div class="mt-big">No bet clears ${_mt.threshold}% right now</div><div class="mt-dim">Best gap: ${rows[0] ? `${mtEsc(rows[0].label)} ${fSigned(rows[0].edge * 100)}%` : '—'}</div>`}
    </div>
    <div class="mt-table-wrap"><table class="mt-table mt-value-table">
      <thead><tr><th>Mkt</th><th>Bet</th><th>${mtEsc(bookLabel(_mt.betBook))}</th><th>Fair (${mtEsc(bookLabel(refKey))})</th><th>Prob</th><th>Edge</th><th>Min odds</th><th>Stake</th></tr></thead>
      <tbody>${rows.map(rowHtml).join('')}</tbody>
    </table></div>
    <div class="mt-sub">Edge = ${mtEsc(bookLabel(_mt.betBook))} price ÷ fair − 1 · Min odds = fair × ${(1 + _mt.threshold / 100).toFixed(2)} · Stake = ${_mt.kellyFrac === 0.25 ? '¼' : _mt.kellyFrac === 0.5 ? '½' : _mt.kellyFrac === 0.125 ? '⅛' : _mt.kellyFrac} Kelly${bank ? ` of €${bank}` : ' (% of bankroll — set a bankroll on the left for €)'}. AH quarter lines use the win-equivalent probability.</div>
    ${openHtml}
    <details class="mt-details"><summary>What the backtest says (read before betting)</summary>
      <ul class="mt-notes">
        <li><b>Bet365 opening ≥3% above Sbobet opening fair:</b> +4.8% ROI, 8,671 bets, 13/14 months positive. ≥5%: +6.4%, 12/14.</li>
        <li><b>Near kick-off (closing vs closing):</b> ≥3% → +2.4% (8/14 months), ≥5% → +6.2%, AH-only ≥5% → +9.3% (12/14) — rarer and noisier. Use a higher threshold close to kick-off.</li>
        <li><b>The edge is the price, not the side.</b> The same picks bet at Bet365's later price lose −3.6%. If the price has moved below the min odds, skip.</li>
        <li><b>Always compare prices at the same moment.</b> Bet365 now vs Sbobet's old opening price lost −4.5%.</li>
        <li>No reference book → no bet. Lines differing between books ("model" rows) and Crown/avg references are not backtested.</li>
      </ul>
    </details>`;
}

/* ── FAIR PRICES ──────────────────────────────────────────────────────── */
function renderMtFair({ st, lm, bet, refKey, refFit, live }) {
  if (!refFit) return `<div class="mt-banner warn">No book with usable AH/TL or 1X2 prices to fit the model.</div>`;
  const mk = refFit.markets;
  const betPrice = (kind, line, side) => {
    if (!bet) return null;
    if (kind === 'AH' && sameLine(bet.ah_hc, line)) return side === 'home' ? bet.ho_c : bet.ao_c;
    if (kind === 'OU' && sameLine(bet.tl_c, line)) return side === 'over' ? bet.ov_c : bet.un_c;
    return null;
  };
  const tile = (label, p, fair, price) => {
    const edge = price > 1 && fair > 1 ? price / fair - 1 : null;
    return `<div class="mt-tile">
      <div class="mt-tile-label">${mtEsc(label)}</div>
      <div class="mt-tile-p num">${fPct(p, 0)}</div>
      <div class="mt-bar"><span style="width:${Math.max(0, Math.min(100, p * 100)).toFixed(1)}%"></span></div>
      <div class="mt-tile-foot num">fair ${fOdd(fair)}${price ? ` · ${mtEsc(bookLabel(_mt.betBook))} ${fOdd(price)} <b class="${edge >= _mt.threshold / 100 ? 'pos' : edge < 0 ? 'neg' : ''}">${fSigned(edge * 100)}%</b>` : ''}</div>
    </div>`;
  };
  const x = bet?.x12;
  const res = mk.result.map((r, i) => tile(r.label, r.p, r.fair, x ? [x.h_c, x.d_c, x.a_c][i] : null)).join('');

  const totalsRows = mk.totals.filter(t => [0.5, 1.5, 2, 2.25, 2.5, 2.75, 3, 3.5, 4.5].includes(t.line) || sameLine(t.line, bet?.tl_c)).map(t => {
    const bo = betPrice('OU', t.line, 'over'), bu = betPrice('OU', t.line, 'under');
    return `<tr class="${bo ? 'mt-row-bet' : ''}"><td class="num">${t.line}</td><td class="num">${fPct(t.over.p, 0)}</td><td class="num">${fOdd(t.over.fair)}</td><td class="num">${bo ? fOdd(bo) : ''}</td><td class="num">${fPct(t.under.p, 0)}</td><td class="num">${fOdd(t.under.fair)}</td><td class="num">${bu ? fOdd(bu) : ''}</td></tr>`;
  }).join('');
  const center = refFit.line ?? 0;
  const ahRows = mk.ah.filter(a => Math.abs(a.line - center) <= 1.01).map(a => {
    const bh = betPrice('AH', a.line, 'home'), ba = betPrice('AH', a.line, 'away');
    return `<tr class="${bh ? 'mt-row-bet' : ''}"><td class="num">${fLine(a.line)}</td><td class="num">${fPct(a.home.p, 0)}</td><td class="num">${fOdd(a.home.fair)}</td><td class="num">${bh ? fOdd(bh) : ''}</td><td class="num">${fLine(-a.line)}</td><td class="num">${fPct(a.away.p, 0)}</td><td class="num">${fOdd(a.away.fair)}</td><td class="num">${ba ? fOdd(ba) : ''}</td></tr>`;
  }).join('');
  const tt = mk.teamTotals.map(t => t.lines.map(l => tile(l.over.label, l.over.p, l.over.fair)).join('')).join('');
  const cs = mk.correctScore.map(c => `<div class="mt-cs"><span class="num">${c.h}-${c.a}</span><b class="num">${fPct(c.p, 1)}</b><span class="mt-dim num">${fOdd(c.fair)}</span></div>`).join('');
  const fh = mk.firstHalf, sh = mk.secondHalf;
  const inPlay = lm ? renderMtInPlay(lm, st, tile) : '';

  return `
    <div class="mt-sub" style="margin-bottom:10px">Fitted to <b>${mtEsc(bookLabel(refKey))}</b>'s current AH + Total Line prices (margin removed) → expected goals <b class="num">${refFit.fit.lh.toFixed(2)}</b> home, <b class="num">${refFit.fit.la.toFixed(2)}</b> away. Checked on 21k past matches: 1X2, BTTS and totals land within ~1pp of actual results. Where ${mtEsc(bookLabel(_mt.betBook))} quotes the market, its price and edge are shown.</div>
    ${inPlay}
    <div class="mt-section-title">RESULT</div>
    <div class="mt-grid3">${res}</div>
    <div class="mt-grid3">${mk.doubleChance.map(r => tile(r.label, r.p, r.fair)).join('')}</div>
    <div class="mt-grid4">${mk.dnb.map(r => tile(r.label, r.p, r.fair)).join('')}${mk.btts.map(r => tile(r.label, r.p, r.fair)).join('')}</div>
    <div class="mt-two">
      <div><div class="mt-section-title">GOALS (TOTAL)</div>
        <div class="mt-table-wrap"><table class="mt-table"><thead><tr><th>Line</th><th>Over</th><th>Fair</th><th>${mtEsc(bookLabel(_mt.betBook))}</th><th>Under</th><th>Fair</th><th>${mtEsc(bookLabel(_mt.betBook))}</th></tr></thead><tbody>${totalsRows}</tbody></table></div></div>
      <div><div class="mt-section-title">ASIAN HANDICAP</div>
        <div class="mt-table-wrap"><table class="mt-table"><thead><tr><th>Home</th><th>P</th><th>Fair</th><th>B</th><th>Away</th><th>P</th><th>Fair</th><th>B</th></tr></thead><tbody>${ahRows}</tbody></table></div></div>
    </div>
    <div class="mt-section-title">SPECIALS</div>
    <div class="mt-grid4">${mk.specials.map(r => tile(r.label, r.p, r.fair)).join('')}</div>
    <div class="mt-section-title">TEAM GOALS</div>
    <div class="mt-grid3">${tt}</div>
    <div class="mt-section-title">1ST HALF <span class="mt-dim">(44.6% of goals, dataset average)</span></div>
    <div class="mt-grid3">${fh.result.map(r => tile(r.label, r.p, r.fair)).join('')}</div>
    <div class="mt-grid4">${fh.totals.map(t => tile(t.over.label, t.over.p, t.over.fair)).join('')}${tile(fh.btts.label, fh.btts.p, fh.btts.fair)}</div>
    <div class="mt-section-title">2ND HALF</div>
    <div class="mt-grid3">${sh.totals.map(t => tile(t.over.label, t.over.p, t.over.fair)).join('')}</div>
    <div class="mt-section-title">CORRECT SCORE <span class="mt-dim">top 12</span></div>
    <div class="mt-cs-grid">${cs}</div>`;
}

// In-play section of the Fair prices view (FairModel.liveMarkets).
function renderMtInPlay(lm, st, tile) {
  const odds = _mt.live?.live_odds || null;
  const g0 = lm.score.home + lm.score.away;
  const L = lm.live;
  const when = st.status === 'HT' ? 'half-time' : st.minuteText;
  const r = L.half === 1 ? L.r1 : L.r2;
  const modTxt = L.mod && L.mod.bucket !== '0'
    ? ` Score state (${L.mod.favHome ? 'home' : 'away'} favourite ${+L.mod.bucket > 0 ? 'leading' : 'trailing'}): rest-of-2H scoring home ×${L.mod.home.toFixed(2)}, away ×${L.mod.away.toFixed(2)}.` : '';
  const liveTotals = lm.totals.map(t => {
    const b = odds && sameLine(odds.tl_c, t.line);
    return `<tr class="${b ? 'mt-row-bet' : ''}"><td class="num">${t.line}</td><td class="num">${fPct(t.over.p, 0)}</td><td class="num">${fOdd(t.over.fair)}</td><td class="num">${b ? fOdd(odds.ov_c) : ''}</td><td class="num">${fPct(t.under.p, 0)}</td><td class="num">${fOdd(t.under.fair)}</td><td class="num">${b ? fOdd(odds.un_c) : ''}</td></tr>`;
  }).join('');
  const center = odds && num(odds.ah_hc) != null ? odds.ah_hc : 0;
  const liveAh = lm.ah.filter(a => Math.abs(a.line - center) <= 0.76).map(a => {
    const b = odds && sameLine(odds.ah_hc, a.line);
    return `<tr class="${b ? 'mt-row-bet' : ''}"><td class="num">${fLine(a.line)}</td><td class="num">${fPct(a.home.p, 0)}</td><td class="num">${fOdd(a.home.fair)}</td><td class="num">${b ? fOdd(odds.ho_c) : ''}</td><td class="num">${fLine(-a.line)}</td><td class="num">${fPct(a.away.p, 0)}</td><td class="num">${fOdd(a.away.fair)}</td><td class="num">${b ? fOdd(odds.ao_c) : ''}</td></tr>`;
  }).join('');
  const x = odds ? [odds.x2_h, odds.x2_x, odds.x2_a] : [];
  const roh = lm.restOfHalf;
  return `
    <div class="mt-section-title">IN PLAY · ${mtEsc(when || '')} · ${lm.score.home}-${lm.score.away}${liveSourceTag()} <span class="mt-dim">— live model; Bet365 live prices where quoted</span></div>
    <div class="mt-sub" style="margin-bottom:8px">${fPct(r, 0)} of the ${L.half === 1 ? '1st' : '2nd'}-half goal expectation still to come (real goal-timing curve incl. added time) → <b class="num">${L.lh.toFixed(2)}</b> home, <b class="num">${L.la.toFixed(2)}</b> away goals expected from here.${modTxt}</div>
    <div class="mt-grid3">${lm.result.map((o, i) => tile('Final: ' + o.label, o.p, o.fair, x[i])).join('')}</div>
    <div class="mt-grid3">${lm.nextGoal.map(o => tile(o.label, o.p, o.fair)).join('')}</div>
    <div class="mt-grid4">
      ${tile('BTTS (final)', lm.btts[0].p, lm.btts[0].fair)}
      ${lm.specials.map(o => tile(o.label, o.p, o.fair)).join('')}
      ${roh ? tile(`Goal in rest of ${roh.label}`, roh.goal, 1 / roh.goal) : ''}
    </div>
    ${roh && roh.totals.length ? `<div class="mt-grid3">${roh.totals.map(t => tile(t.label, t.p, t.fair)).join('')}</div>` : ''}
    <div class="mt-two">
      <div><div class="mt-section-title">FINAL TOTAL <span class="mt-dim">(now ${g0})</span></div>
        <div class="mt-table-wrap"><table class="mt-table"><thead><tr><th>Line</th><th>Over</th><th>Fair</th><th>B365</th><th>Under</th><th>Fair</th><th>B365</th></tr></thead><tbody>${liveTotals}</tbody></table></div></div>
      <div><div class="mt-section-title">ASIAN HANDICAP <span class="mt-dim">(goals from now)</span></div>
        <div class="mt-table-wrap"><table class="mt-table"><thead><tr><th>Home</th><th>P</th><th>Fair</th><th>B</th><th>Away</th><th>P</th><th>Fair</th><th>B</th></tr></thead><tbody>${liveAh}</tbody></table></div></div>
    </div>
    <div class="mt-section-title" style="margin-top:22px">PRE-MATCH FAIR PRICES <span class="mt-dim">— as at kick-off</span></div>`;
}

/* ── HISTORICAL (existing Manual analysis) ────────────────────────────── */
function renderMtHistorical({ d, books }) {
  const b = books.bet365 || books.pinnacle;
  const dbReady = typeof _db !== 'undefined' && _db.length > 0;
  return `
    <div class="mt-hist">
      <p>The similar-matches engine (the current <b>Manual</b> analysis): finds past matches in your ${dbReady ? `<b>${_db.length.toLocaleString()}</b>-match` : ''} Bet365 dataset with the same handicap, odds movement and total line, and ranks every bet by its historical hit rate vs baseline (cross-fit corrected), with Top Pick, value hunting and the full filter trace.</p>
      <p class="mt-dim">Remember: on its own this beats the average hit rate, not the price — check the result against the <b>Value</b> view before betting.</p>
      ${b ? `<button class="run-btn" onclick="openMatchInManual()">📚 Run historical analysis for this match →</button>`
          : `<div class="mt-banner warn">Bet365 isn't listed for this match — the historical dataset is Bet365-priced, so the analysis needs Bet365 odds.</div>`}
      ${!dbReady ? '<div class="mt-sub">The dataset is still loading — the analysis runs once it has loaded.</div>' : ''}
    </div>`;
}

// Pre-fills the Manual tab with this match (same path as its own Import
// button: fillFromScraped + lastImportedUrl so its Refresh works too), sets
// the league for the coverage check if the dataset knows it, then runs it.
function openMatchInManual() {
  const d = _mt.data; if (!d) return;
  const urlInput = document.getElementById('url-import-input');
  if (urlInput) urlInput.value = _mt.url;
  fillFromScraped(d);
  state.lastImportedUrl = _mt.url;
  document.getElementById('url-refresh-btn')?.style.removeProperty('display');
  const lg = document.getElementById('match-league');
  if (lg && d.match?.league && [...lg.options].some(o => o.value === d.match.league)) {
    lg.value = d.match.league; onLeagueSelectChange();
  }
  const st = document.getElementById('url-import-status');
  if (st) { st.textContent = `✓ From MATCH tab: ${d.match?.home || ''} v ${d.match?.away || ''} (${d.source === 'pinnacle' ? 'Pinnacle' : 'Bet365'})`; st.className = 'url-import-status ok'; }
  switchTab('manual');
  if (_db.length) analyzeMatch();
}

// Restore saved settings into the left-panel controls.
document.addEventListener('DOMContentLoaded', () => {
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = String(v); };
  set('mt-thr', _mt.threshold);
  set('mt-kelly', _mt.kellyFrac);
  set('mt-bank', _mt.bankroll ?? '');
  renderMatchControls();
});
