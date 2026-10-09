'use strict';
/**
 * "Vs blind" — a strategy's return compared with betting blind at the same
 * market and price band. Bet365's margin is not flat: blind betting loses a
 * few percent near evens and 10-15% on long prices (favourite–longshot bias),
 * so an ROI only means something next to what blind betting at the same
 * prices returns. For each settled bet: excess = its return − the blind ROI of
 * its market + price band; reported as the average excess per bet.
 *
 * Pre-match: blind_baseline.json (Bet365 closing prices, build_blind_baseline.js).
 * In-play: no history — inplayTable() builds it from a recorder's own rows
 * (every side LIVEMODEL logs for calibration, settled), so it is only as good
 * as their number.
 */
const fs = require('fs');
const path = require('path');

const BANDS = [[1.01, 1.3], [1.3, 1.5], [1.5, 1.7], [1.7, 1.9], [1.9, 2.1], [2.1, 2.4], [2.4, 2.8], [2.8, 3.5], [3.5, 5], [5, Infinity]];
const bandOf = p => (p > 1 ? BANDS.findIndex(([lo, hi]) => p >= lo && p < hi) : -1);
const bandLabel = i => { const [lo, hi] = BANDS[i]; return hi === Infinity ? `≥ ${lo}` : `${lo.toFixed(2)}–${hi.toFixed(2)}`; };
const keyOf = (mk, side) => (mk === '1X2' ? `1X2|${side}` : mk);
const MIN_N = 200;

let _pre = null;
function prematchTable() {
  if (_pre) return _pre;
  try { _pre = JSON.parse(fs.readFileSync(path.join(__dirname, 'blind_baseline.json'), 'utf8')).cells; } catch { _pre = {}; }
  return _pre;
}

// Blind ROI for one bet (null when the cell is missing or thin).
function blindRoi(table, mk, side, price, minN = MIN_N) {
  const b = bandOf(price); if (b < 0) return null;
  const c = table[`${keyOf(mk, side)}|${b}`];
  return c && c.n >= minN ? c.roi : null;
}

// In-play table from recorded rows: retOf(o) → return multiplier or null.
function inplayTable(rows, retOf) {
  const acc = {};
  for (const o of rows) {
    const r = retOf(o), b = bandOf(o.p); if (r == null || b < 0) continue;
    const k = `${keyOf(o.mk, o.side)}|${b}`; const s = acc[k] || (acc[k] = { n: 0, pl: 0 });
    s.n++; s.pl += r - 1;
  }
  const out = {}; for (const [k, s] of Object.entries(acc)) out[k] = { n: s.n, roi: s.pl / s.n };
  return out;
}

// bets: [{mk, side, p, ret}] (ret = return multiplier, settled only).
function vsBlind(table, bets, minN = MIN_N) {
  let n = 0, ex = 0, blind = 0;
  for (const o of bets) {
    const b = blindRoi(table, o.mk, o.side, o.p, minN); if (b == null || o.ret == null) continue;
    n++; ex += (o.ret - 1) - b; blind += b;
  }
  return n ? { n, excess: ex / n, blind: blind / n } : null;
}
const fmtVs = (v, tot) => (v ? ` · vs blind ${v.excess >= 0 ? '+' : ''}${(v.excess * 100).toFixed(1)}% (blind ${(v.blind * 100).toFixed(1)}%${tot != null && v.n < tot ? `, ${v.n} of ${tot}` : ''})` : '');

module.exports = { BANDS, bandOf, bandLabel, keyOf, prematchTable, blindRoi, inplayTable, vsBlind, fmtVs, MIN_N };
