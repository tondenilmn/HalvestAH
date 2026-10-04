/* ══════════════════════════════════════════════════════════════════════
   scan.js — the 🔎 SCANNER tab: every upcoming fixture asianbetsoccer
   lists (today … +7 days), Bet365's current AH / O-U price vs Sbobet's
   current de-vigged fair price on the SAME line, flagged when the edge
   clears the threshold. One click opens the match in the MATCH tab.

   Data: /api/upcoming (functions/api/upcoming.js) — both books'
   tablenext/day0…day7 files, paired by match id, current + opening prices.

   Only same-line, same-moment comparisons are flagged — the backtested
   setup (CrossBooks, 14 months, see match.js header / BETTING_EDGE_ANALYSIS):
     prices still at opening, ≥3% → +4.8% ROI, 13/14 months (≥5%: +6.4%)
     prices already moved (closing-type), ≥3% → +2.4%, 8/14; ≥5% → +6.2%,
       10/14; AH-only ≥5% → +9.3%, 12/14
   Each flagged bet is tagged with which of the two it is. Different-line
   pairs (model conversion) aren't validated and aren't scanned.

   1X2 is scanned too (added 2026-10-04), under two restrictions the AH/O-U
   rows don't need, both straight out of its own backtest
   (telegram/backtest_pricegap_1x2.js, 20 months of direct Bet365-vs-Sbobet
   1X2 — see CLAUDE.md's "Evidence behind the Value view"):
     - OPENING PRICES ONLY. Opening vs opening ≥5% → +6.2% ROI, 17/20 months;
       the same picks at Bet365's closing price → −9.0%, and closing vs
       closing → +0.1%. So a 1X2 gap on a market that has already moved has
       no evidence behind it and is never flagged (SC_X12_OPEN_ONLY).
     - POWER DE-VIG, not proportional (FairModel.devigPower) — Sbobet's 1X2
       margin is 12-14%, and proportional de-vig of a margin that size invents
       edges on draws and dogs. See devigPower's own comment.
   The threshold floor for 1X2 is 5% (SC_X12_MIN_EDGE), the only level its
   backtest measured.

   Depends on: fair_model.js (FairModel), match.js (_mt prefs for Kelly /
   bankroll, importMatchTab, fOdd/fPct/fSigned/fLine/mtEsc/sameLine/num),
   app.js (switchTab, classifyLeague).
   ══════════════════════════════════════════════════════════════════════ */

const SC_PREF_KEY = 'halvest_scan_prefs';

const _sc = {
  data: null,        // raw /api/upcoming response
  rows: [],          // every same-line comparison (built once per fetch)
  scannedAt: null,
  loading: false,
  threshold: 3,      // % edge; 3% is profitable in both price states (see header)
  hours: 168,        // kick-off window
  market: 'ALL',     // ALL | AH | OU
  tier: 'ALL',       // ALL | TOP | MAJOR | OTHER
  state: 'ALL',      // ALL | OPEN (prices still at opening only)
  sort: 'edge',      // edge | kickoff
};
// Edges this large are far outside what the backtest saw on real gaps —
// usually one book's price is stale or mistyped. Shown, but tagged.
const SC_SUSPECT_EDGE = 0.15;
// 1X2 gates — see the header. Opening-only because the closing bucket paid
// nothing; 5% because that is the one threshold its backtest measured.
const SC_X12_OPEN_ONLY = true;
const SC_X12_MIN_EDGE  = 5;

(function loadScanPrefs() {
  try {
    const p = JSON.parse(localStorage.getItem(SC_PREF_KEY) || '{}');
    for (const k of ['threshold', 'hours', 'market', 'tier', 'state', 'sort']) if (p[k] != null) _sc[k] = p[k];
  } catch (_) { /* storage unavailable — defaults are fine */ }
})();
function saveScanPrefs() {
  try {
    const { threshold, hours, market, tier, state, sort } = _sc;
    localStorage.setItem(SC_PREF_KEY, JSON.stringify({ threshold, hours, market, tier, state, sort }));
  } catch (_) {}
}
function setScanPref(key, value) {
  if (key === 'threshold' || key === 'hours') value = parseFloat(value);
  _sc[key] = value; saveScanPrefs();
  renderScan();
}

/* ── fetch ────────────────────────────────────────────────────────────── */
async function runScan() {
  if (_sc.loading) return;
  _sc.loading = true;
  const btn = document.getElementById('sc-run-btn');
  const status = document.getElementById('sc-status');
  if (btn) btn.disabled = true;
  if (status) { status.textContent = 'Fetching the week\'s fixtures from Bet365 and Sbobet…'; status.className = 'url-import-status loading'; }
  try {
    const resp = await fetch('/api/upcoming?days=7');
    const data = await resp.json();
    if (data.error) throw new Error(data.error);
    _sc.data = data;
    _sc.rows = buildScanRows(data.matches || []);
    _sc.scannedAt = new Date();
    if (status) { status.textContent = `✓ ${data.matches.length} fixtures · ${data.matches.filter(m => m.sbobet).length} with Sbobet`; status.className = 'url-import-status ok'; }
    renderScan();
  } catch (e) {
    if (status) { status.textContent = '✗ ' + e.message; status.className = 'url-import-status error'; }
  } finally {
    _sc.loading = false;
    if (btn) btn.disabled = false;
  }
}

/* ── comparisons ──────────────────────────────────────────────────────── */
// Both books still on their opening line AND price for this market — the
// "opening" backtest bucket. Anything else is the closing-type bucket.
function marketUnmoved(b, s, mkt) {
  if (mkt === 'X12') {
    return [b, s].every(x => x.x12 && ['home', 'draw', 'away'].every(k =>
      num(x.x12[k + '_c']) != null && Math.abs(x.x12[k + '_c'] - x.x12[k + '_o']) < 0.001));
  }
  const keys = mkt === 'AH' ? ['ah_h', 'ho_', 'ao_'] : ['tl_', 'ov_', 'un_'];
  return [b, s].every(x => keys.every(k => num(x[k + 'c']) != null && Math.abs(x[k + 'c'] - x[k + 'o']) < 0.001));
}

function buildScanRows(matches) {
  const rows = [];
  const now = Date.now();
  for (const m of matches) {
    const b = m.bet365, s = m.sbobet;
    if (!b || !s) continue;
    const ko = m.kickoff_time ? new Date(m.kickoff_time).getTime() : NaN;
    if (Number.isFinite(ko) && ko <= now) continue; // already kicked off — pre-match prices are frozen
    const tier = typeof classifyLeague === 'function' ? classifyLeague(m.league) : 'OTHER';
    const add = (market, side, label, line, price, fair, openPrice, openFair) => {
      if (!(price > 1) || !(fair > 1)) return;
      const edge = price / fair - 1;
      rows.push({
        m, ko, tier, market, side, label, line, price, fair, edge, p: 1 / fair, openPrice,
        unmoved: marketUnmoved(b, s, market),
        openEdge: openPrice > 1 && openFair > 1 ? openPrice / openFair - 1 : null,
      });
    };
    if (sameLine(b.ah_hc, s.ah_hc)) {
      const f = FairModel.devig([s.ho_c, s.ao_c]);
      const fo = sameLine(b.ah_ho, s.ah_ho) ? FairModel.devig([s.ho_o, s.ao_o]) : null;
      if (f) {
        add('AH', 'home', `${m.home_team} ${fLine(b.ah_hc)}`, b.ah_hc, b.ho_c, f.fair[0], b.ho_o, fo?.fair[0]);
        add('AH', 'away', `${m.away_team} ${fLine(-b.ah_hc)}`, b.ah_hc, b.ao_c, f.fair[1], b.ao_o, fo?.fair[1]);
      }
    }
    if (sameLine(b.tl_c, s.tl_c)) {
      const f = FairModel.devig([s.ov_c, s.un_c]);
      const fo = sameLine(b.tl_o, s.tl_o) ? FairModel.devig([s.ov_o, s.un_o]) : null;
      if (f) {
        add('OU', 'over', `Over ${b.tl_c}`, b.tl_c, b.ov_c, f.fair[0], b.ov_o, fo?.fair[0]);
        add('OU', 'under', `Under ${b.tl_c}`, b.tl_c, b.un_c, f.fair[1], b.un_o, fo?.fair[1]);
      }
    }
    // 1X2 — no line to match, so the only same-ness needed is the market
    // itself. Power de-vig, and only while both books still sit at their
    // opening price (that gate lives in filteredScanRows — see the header).
    if (b.x12 && s.x12) {
      const f  = FairModel.devigPower([s.x12.home_c, s.x12.draw_c, s.x12.away_c]);
      const fo = FairModel.devigPower([s.x12.home_o, s.x12.draw_o, s.x12.away_o]);
      if (f) {
        const sides = [['home', m.home_team, 0], ['draw', 'Draw', 1], ['away', m.away_team, 2]];
        for (const [side, label, i] of sides) {
          add('X12', side, label, null, b.x12[side + '_c'], f.fair[i], b.x12[side + '_o'], fo?.fair[i]);
        }
      }
    }
  }
  return rows;
}

// A 1X2 row clears its own two extra gates before it is a candidate at all —
// its backtest only covers unmoved prices at ≥5%, and anything outside that
// would be presented as evidence-backed when it isn't.
// The edge a row has to clear: the slider, but never below 1X2's own floor —
// so the "Min odds" column can't advise a 1X2 price its backtest never saw.
function scanRowThreshold(r) {
  return r.market === 'X12' ? Math.max(_sc.threshold, SC_X12_MIN_EDGE) : _sc.threshold;
}

function x12Allowed(r) {
  return r.market !== 'X12'
    || ((!SC_X12_OPEN_ONLY || r.unmoved) && r.edge * 100 >= SC_X12_MIN_EDGE);
}

function filteredScanRows() {
  const horizon = Date.now() + _sc.hours * 3600e3;
  return _sc.rows.filter(r =>
    (!Number.isFinite(r.ko) || r.ko <= horizon)
    && (_sc.market === 'ALL' || r.market === _sc.market)
    && (_sc.tier === 'ALL' || r.tier === _sc.tier)
    && (_sc.state === 'ALL' || r.unmoved)
    && x12Allowed(r));
}

// Which backtest bucket this flag falls into, and what it measured there.
function scanBucket(r) {
  const e = r.edge * 100;
  if (r.market === 'X12') {
    return r.unmoved
      ? { cls: 'open', label: 'at opening', tip: 'Both books still on their opening 1X2 price — the only bucket its backtest found an edge in: ≥5% → +6.2% ROI, 17/20 months. The same picks at Bet365 closing prices returned −9.0%, so take it now or not at all. Power de-vig.' }
      : { cls: 'moved-thin', label: 'moved — no evidence', tip: '1X2 prices have already moved, and closing vs closing returned +0.1% over 20 months. Normally filtered out entirely (SC_X12_OPEN_ONLY).' };
  }
  if (r.unmoved) return { cls: 'open', label: 'at opening', tip: `Both books still on their opening price — the backtested opening setup: ≥3% → +4.8% ROI (13/14 months), ≥5% → +6.4% (12/14).` };
  const tip = r.market === 'AH' && e >= 5
    ? 'Prices have moved since opening (closing-type comparison): AH ≥5% → +9.3% ROI (12/14 months).'
    : e >= 5 ? 'Prices have moved since opening (closing-type comparison): ≥5% → +6.2% ROI (10/14 months).'
    : 'Prices have moved since opening (closing-type comparison): ≥3% → +2.4% ROI (8/14 months) — thinner; ≥5% is more reliable here.';
  return { cls: e >= 5 ? 'moved' : 'moved-thin', label: 'moved', tip };
}

/* ── render ───────────────────────────────────────────────────────────── */
function fmtScanKickoff(ko) {
  if (!Number.isFinite(ko)) return '—';
  const t = new Date(ko);
  const mins = Math.round((ko - Date.now()) / 60000);
  const rel = mins < 60 ? `in ${mins}m` : mins < 24 * 60 ? `in ${Math.floor(mins / 60)}h` : `in ${Math.round(mins / 1440)}d`;
  return `${mtEsc(t.toLocaleString(undefined, { weekday: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' }))}<span class="mt-mini">${rel}</span>`;
}

function renderScanRow(r, i, hit) {
  const bucket = scanBucket(r);
  const kelly = FairModel.kelly(r.p, r.price, _mt.kellyFrac);
  const stake = hit && kelly > 0 ? (_mt.bankroll ? `€${(_mt.bankroll * kelly).toFixed(2)}` : fPct(kelly, 2)) : '—';
  const suspect = r.edge >= SC_SUSPECT_EDGE;
  return `<tr class="sc-row ${hit ? 'mt-v-hit' : r.edge > 0 ? 'mt-v-pos' : 'mt-v-neg'}" onclick="openScanMatch(${i})" title="Open in the MATCH tab">
    <td class="num">${fmtScanKickoff(r.ko)}</td>
    <td><div class="sc-match">${mtEsc(r.m.home_team)} <span class="mt-dim">v</span> ${mtEsc(r.m.away_team)}</div>
        <div class="mt-mini">${mtEsc(r.m.league)} <span class="sc-tier ${r.tier.toLowerCase()}">${r.tier}</span></div></td>
    <td class="mt-strong">${r.market === 'OU' ? 'O/U' : r.market === 'X12' ? '1X2' : 'AH'} · ${mtEsc(r.label)}${suspect ? ' <span class="mt-tag model" title="Edge this large is usually a stale or mistyped price on one book — check both books before betting.">verify</span>' : ''}</td>
    <td class="num mt-strong">${fOdd(r.price)}${r.openPrice > 1 && Math.abs(r.price - r.openPrice) > 0.001 ? `<span class="mt-mini ${r.price < r.openPrice ? 'down' : 'up'}" title="Bet365 opening price">${r.price < r.openPrice ? '▼' : '▲'}${fOdd(r.openPrice)}</span>` : ''}</td>
    <td class="num">${fOdd(r.fair)}</td>
    <td class="num mt-edge">${fSigned(r.edge * 100)}%</td>
    <td class="num">${fOdd(r.fair * (1 + scanRowThreshold(r) / 100))}</td>
    <td class="num">${stake}</td>
    <td><span class="sc-bucket ${bucket.cls}" title="${mtEsc(bucket.tip)}">${bucket.label}</span>${r.openEdge != null && !r.unmoved ? `<span class="mt-mini">opened ${fSigned(r.openEdge * 100)}%</span>` : ''}</td>
  </tr>`;
}

function scanTable(rows, offset, hit) {
  return `<div class="mt-table-wrap"><table class="mt-table sc-table">
    <thead><tr><th>Kick-off</th><th>Match</th><th>Bet</th><th>Bet365</th><th>Fair (Sbobet)</th><th>Edge</th><th>Min odds</th><th>Stake</th><th>Prices</th></tr></thead>
    <tbody>${rows.map((r, i) => renderScanRow(r, offset + i, hit)).join('')}</tbody>
  </table></div>`;
}

let _scVisible = []; // rows currently rendered, indexed by openScanMatch

function renderScan() {
  const el = document.getElementById('right-scan');
  if (!el || !_sc.data) return;
  const d = _sc.data;
  const all = filteredScanRows();
  const sortFn = _sc.sort === 'kickoff' ? (a, b) => a.ko - b.ko || b.edge - a.edge : (a, b) => b.edge - a.edge;
  const flagged = all.filter(r => r.edge * 100 >= scanRowThreshold(r)).sort(sortFn);
  const near = all.filter(r => r.edge * 100 < scanRowThreshold(r) && r.edge > 0).sort((a, b) => b.edge - a.edge).slice(0, 15);
  _scVisible = [...flagged, ...near];

  const upcoming = (d.matches || []).filter(m => !m.kickoff_time || new Date(m.kickoff_time).getTime() > Date.now());
  const withSbo = upcoming.filter(m => m.sbobet);
  const comparedIds = new Set(_sc.rows.map(r => r.m.id));
  const flaggedMatches = new Set(flagged.map(r => r.m.id)).size;
  const ago = _sc.scannedAt ? Math.round((Date.now() - _sc.scannedAt) / 60000) : null;

  el.innerHTML = `
    <div class="mt-value-summary ${flagged.length ? 'hit' : ''}">
      <div class="mt-big">${flagged.length
        ? `💰 ${flagged.length} value bet${flagged.length > 1 ? 's' : ''} ≥ ${_sc.threshold}% in ${flaggedMatches} match${flaggedMatches > 1 ? 'es' : ''}`
        : `No Bet365 price clears ${_sc.threshold}% right now`}</div>
      <div class="mt-dim">${upcoming.length} upcoming fixtures · ${withSbo.length} listed by Sbobet · ${comparedIds.size} with an AH, O/U or 1X2 price to compare
        · scanned ${_sc.scannedAt ? _sc.scannedAt.toLocaleTimeString() : ''}${ago ? ` (${ago} min ago — prices move, rescan before betting)` : ''}</div>
    </div>
    ${(d.notes || []).map(n => `<div class="mt-banner warn">${mtEsc(n)}</div>`).join('')}
    ${flagged.length ? scanTable(flagged, 0, true) : ''}
    ${near.length ? `
      <details class="mt-details" ${flagged.length ? '' : 'open'}><summary>Closest to the threshold (${near.length})</summary>
        <div style="margin-top:8px">${scanTable(near, flagged.length, false)}</div>
      </details>` : ''}
    <div class="mt-sub" style="margin-top:10px">Edge = Bet365 price ÷ Sbobet de-vigged fair − 1, both current, same line. Min odds = fair × ${(1 + _sc.threshold / 100).toFixed(2)} — skip if Bet365 has dropped below it (1X2 rows use fair × ${(1 + Math.max(_sc.threshold, SC_X12_MIN_EDGE) / 100).toFixed(2)}, their backtest's own floor). Stake = ${({ 0.125: '⅛', 0.25: '¼', 0.5: '½' })[_mt.kellyFrac] || _mt.kellyFrac} Kelly${_mt.bankroll ? ` of €${_mt.bankroll}` : ' (% of bankroll — set a bankroll in the MATCH tab for €)'}. Click a row for the full match page.</div>
    <details class="mt-details"><summary>What the backtest says (read before betting)</summary>
      <ul class="mt-notes">
        <li><span class="sc-bucket open">at opening</span> both books still on their opening price: ≥3% → +4.8% ROI on 8,671 bets, 13/14 months positive; ≥5% → +6.4%.</li>
        <li><span class="sc-bucket moved">moved</span> prices already moved (closing-type): ≥3% → +2.4% (8/14 months), ≥5% → +6.2% (10/14), AH-only ≥5% → +9.3% (12/14). Below 5% here the edge is thin — the "moved" tag turns dim.</li>
        <li><b>The edge is the price, not the side.</b> Bet365 moves toward Sbobet ~80% of the time when they disagree — the same picks at Bet365's later price lose −3.6%. Bet early, and rescan: flags disappear as Bet365 corrects.</li>
        <li><b>1X2</b> is checked against Sbobet's own 1X2 (power de-vig), and only while both books are still at their opening price: ≥5% → +6.2% ROI on 18,260 bets, 17/20 months positive — but −9.0% at Bet365's closing price and +0.1% closing-vs-closing, so a moved 1X2 market is never flagged. 20 months, direct market-to-market.</li>
        <li>Only matches Sbobet lists (≈⅓ of fixtures) and only same-line pairs can be checked. Different-line comparisons aren't validated and aren't scanned.</li>
      </ul>
    </details>`;
}

function openScanMatch(i) {
  const r = _scVisible[i];
  if (!r?.m?.url) return;
  switchTab('match');
  importMatchTab(r.m.url);
}

document.addEventListener('DOMContentLoaded', () => {
  const set = (id, v) => { const el = document.getElementById(id); if (el && v != null) el.value = String(v); };
  set('sc-thr', _sc.threshold); set('sc-hours', _sc.hours); set('sc-market', _sc.market);
  set('sc-tier', _sc.tier); set('sc-state', _sc.state); set('sc-sort', _sc.sort);
});
