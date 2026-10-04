'use strict';
// ── PRICEGAP backtest: Bet365 1X2 vs Sbobet 1X2 (direct, same market) ────────
// Why this exists: the AH / goals-O-U price-gap edge behind Strategy PRICEGAP
// and the SCANNER tab compares Bet365's price with Sbobet's de-vigged price on
// the SAME line. 1X2 could never be checked the same way, because the
// CrossBooks/ Sbobet CSVs carry no 1X2 columns — so the only earlier test
// priced Bet365's 1X2 against fair_model.js fitted to Sbobet's AH+TL (a model
// hop, and its opening result came out implausibly good; see CLAUDE.md's
// "Evidence behind the Value view").
//
// D:/BET/Match_Dataset/Sbobet_Data_months DOES carry 1X2 Home/Draw/Away
// Closing+Opening (20 months, vs CrossBooks' 14) — so this script does the
// direct thing: de-vig Sbobet's own three-way 1X2 and compare Bet365's own 1X2
// price on the same outcome. No model in between.
//
// Settlement is at BET365's price (the price actually taken), FT result from
// the Bet365 row. Per-month ROI, because the AH result's credibility came from
// month-by-month consistency (13/14), not the pooled number.
//
// Usage:
//   node backtest_pricegap_1x2.js
//   node backtest_pricegap_1x2.js --tier=TOP+MAJOR
//   node backtest_pricegap_1x2.js --devig=power        (proportional|power|shin|all)
//   node backtest_pricegap_1x2.js --max-edge=15        (drop suspected stale prices)
//   node backtest_pricegap_1x2.js --control            (also re-run AH + O/U same-line)
//   node backtest_pricegap_1x2.js --lead               (margins + who leads + opening-pick decay)
//   node backtest_pricegap_1x2.js --detail             (per-month rows at the first threshold)
//   node backtest_pricegap_1x2.js --dir=D:/BET/Match_Dataset
//
// Caveat no flag can fix: these are two scrapes of the same source, but nothing
// guarantees Bet365's and Sbobet's "opening" were captured at the same moment.
// A same-moment comparison is the whole premise of the edge (see the −4.5%
// "current vs old opening" result in CLAUDE.md), so a too-good opening number
// should be read as a timestamp artefact first, an edge second.

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const { processRow } = require('./engine');

const arg = (name, dflt) => {
  const hit = process.argv.find(a => a.startsWith('--' + name + '='));
  return hit ? hit.split('=').slice(1).join('=') : dflt;
};
const DATA_ROOT = arg('dir', 'D:/BET/Match_Dataset');
const TIER      = arg('tier', 'ALL').toUpperCase();
const DEVIG     = arg('devig', 'all').toLowerCase();
const MAX_EDGE  = parseFloat(arg('max-edge', '15'));
const MIN_PRICE = parseFloat(arg('min-price', '0'));
const MAX_PRICE = parseFloat(arg('max-price', '1000'));
const CONTROL   = process.argv.includes('--control');
const DETAIL    = process.argv.includes('--detail');   // per-month rows at the first threshold
const LEAD      = process.argv.includes('--lead');     // margin + who-leads diagnostics
const THRESHOLDS = arg('thresholds', '3,5,8').split(',').map(Number);

// ── de-vig: decimal prices → fair probabilities ──────────────────────────────
// proportional — the two-way method pricegap.js/scan.js already use, extended
// to three outcomes. Known to under-price longshots (favourite-longshot bias),
// which matters more over three outcomes than two, hence the alternatives.
function devigProportional(odds) {
  const q = odds.map(o => 1 / o);
  const s = q.reduce((a, b) => a + b, 0);
  return q.map(x => x / s);
}
// power — p_i = q_i^k with k solved so the probabilities sum to 1.
function devigPower(odds) {
  const q = odds.map(o => 1 / o);
  let lo = 0.5, hi = 1.5;
  for (let i = 0; i < 80; i++) {
    const k = (lo + hi) / 2;
    const s = q.reduce((a, x) => a + Math.pow(x, k), 0);
    if (s > 1) lo = k; else hi = k;
  }
  const p = q.map(x => Math.pow(x, (lo + hi) / 2));
  const s = p.reduce((a, b) => a + b, 0);
  return p.map(x => x / s);
}
// Shin — insider-trading model; the usual choice when longshot bias is the
// concern. z = implied share of informed money.
function devigShin(odds) {
  const q = odds.map(o => 1 / o);
  const S = q.reduce((a, b) => a + b, 0);
  const pOf = z => q.map(x =>
    (Math.sqrt(z * z + 4 * (1 - z) * (x * x) / S) - z) / (2 * (1 - z)));
  let lo = 1e-6, hi = 0.4;
  for (let i = 0; i < 80; i++) {
    const z = (lo + hi) / 2;
    const s = pOf(z).reduce((a, b) => a + b, 0);
    if (s > 1) lo = z; else hi = z;
  }
  const p = pOf((lo + hi) / 2);
  const s = p.reduce((a, b) => a + b, 0);
  return p.map(x => x / s);
}
const DEVIGS = { proportional: devigProportional, power: devigPower, shin: devigShin };

// ── loading ──────────────────────────────────────────────────────────────────
const monthOf = d => {
  const m = /^(\d{4})-(\d{2})/.exec(String(d || ''));
  return m ? m[1] + '-' + m[2] : null;
};

function loadBook(book) {
  const dir = path.join(DATA_ROOT, book + '_Data_months');
  if (!fs.existsSync(dir)) throw new Error('missing folder: ' + dir);
  const rows = [];
  let raw = 0, dropped = 0;
  for (const f of fs.readdirSync(dir).sort()) {
    if (!f.toLowerCase().endsWith('.csv')) continue;
    const { data } = Papa.parse(fs.readFileSync(path.join(dir, f), 'utf8'),
      { header: true, skipEmptyLines: true });
    const label = path.basename(f, '.csv');
    for (const row of data) {
      raw++;
      const p = processRow(row, label);
      if (!p) { dropped++; continue; }
      p.month = monthOf(p.date);
      rows.push(p);
    }
  }
  return { rows, raw, dropped };
}

// Same source, identical Date/Home Team/Away Team columns — exact key, same
// reasoning as crossdog_lib.matchKey (no fuzzy team matching needed).
const matchKey = r => r.date + '|' + r.home_team + '|' + r.away_team;

function mergeBooks(b365rows, sborows) {
  const idx = new Map();
  for (const r of sborows) idx.set(matchKey(r), r);
  const pairs = [];
  for (const b of b365rows) {
    const s = idx.get(matchKey(b));
    if (s) pairs.push({ b, s });
  }
  return pairs;
}

const tierOk = r => TIER === 'ALL' ? true
  : TIER === 'TOP+MAJOR' ? (r.league_tier === 'TOP' || r.league_tier === 'MAJOR')
  : r.league_tier === TIER;

// ── one comparison row ───────────────────────────────────────────────────────
// price = what Bet365 quotes, fair = Sbobet de-vigged, won = did it land.
function x12Rows(pair, phase, devig) {
  const { b, s } = pair;
  const sfx = phase === 'open' ? '_o' : '_c';
  const sb = [s['x2_home' + sfx], s['x2_draw' + sfx], s['x2_away' + sfx]];
  const b3 = [b['x2_home' + sfx], b['x2_draw' + sfx], b['x2_away' + sfx]];
  if (sb.some(o => !(o > 1)) || b3.some(o => !(o > 1))) return [];
  const fair = devig(sb).map(p => 1 / p);
  const won = [b.homeWinsFT, b.drawFT, b.awayWinsFT];
  const side = ['HOME', 'DRAW', 'AWAY'];
  const out = [];
  for (let i = 0; i < 3; i++) {
    out.push({
      month: b.month, side: side[i], price: b3[i], fair: fair[i],
      edge: (b3[i] / fair[i] - 1) * 100, won: won[i], tier: b.league_tier,
    });
  }
  return out;
}

// Control: the already-validated AH / goals comparison, same line only, two-way
// de-vig — here only to confirm this loader reproduces the known numbers.
function controlRows(pair, phase) {
  const { b, s } = pair;
  const sfx = phase === 'open' ? 'o' : 'c';
  const out = [];
  const d2 = (a, x) => { const pa = 1 / a, pb = 1 / x, t = pa + pb; return [t / pa, t / pb]; };
  const bLine = phase === 'open' ? b.fav_lo : b.fav_lc;
  const sLine = phase === 'open' ? s.fav_lo : s.fav_lc;
  // AH — same favourite side and same fav-normalised line.
  if (b.fav_side === s.fav_side && Math.abs(bLine - sLine) < 0.01) {
    const bp = [b['fav_o' + sfx], b['dog_o' + sfx]];
    const sp = [s['fav_o' + sfx], s['dog_o' + sfx]];
    if (bp.every(o => o > 1) && sp.every(o => o > 1)) {
      const fair = d2(sp[0], sp[1]);
      const margin = b.fav_ft - b.dog_ft - bLine;
      // Exact-line pushes excluded — a whole line settles as a void, not a loss.
      if (Math.abs(margin) > 0.01) {
        out.push({ month: b.month, side: 'AH_FAV', price: bp[0], fair: fair[0], edge: (bp[0] / fair[0] - 1) * 100, won: margin > 0, tier: b.league_tier });
        out.push({ month: b.month, side: 'AH_DOG', price: bp[1], fair: fair[1], edge: (bp[1] / fair[1] - 1) * 100, won: margin < 0, tier: b.league_tier });
      }
    }
  }
  // Goals O/U — same total line.
  const btl = phase === 'open' ? b.tl_o : b.tl_c;
  const stl = phase === 'open' ? s.tl_o : s.tl_c;
  if (btl != null && stl != null && Math.abs(btl - stl) < 0.01) {
    const bp = [b['ov_' + sfx], b['un_' + sfx]];
    const sp = [s['ov_' + sfx], s['un_' + sfx]];
    if (bp.every(o => o > 1) && sp.every(o => o > 1)) {
      const fair = d2(sp[0], sp[1]);
      const tot = b.fav_ft + b.dog_ft;
      if (Math.abs(tot - btl) > 0.01) {
        out.push({ month: b.month, side: 'OVER', price: bp[0], fair: fair[0], edge: (bp[0] / fair[0] - 1) * 100, won: tot > btl, tier: b.league_tier });
        out.push({ month: b.month, side: 'UNDER', price: bp[1], fair: fair[1], edge: (bp[1] / fair[1] - 1) * 100, won: tot < btl, tier: b.league_tier });
      }
    }
  }
  return out;
}

// ── reporting ────────────────────────────────────────────────────────────────
function roi(rows) {
  let staked = 0, ret = 0, wins = 0;
  for (const r of rows) { staked += 1; ret += r.won ? r.price : 0; if (r.won) wins++; }
  return { n: rows.length, hit: rows.length ? wins / rows.length * 100 : 0,
           roi: staked ? (ret - staked) / staked * 100 : 0 };
}

function report(label, rows, opts) {
  const bySide = opts && opts.bySide;
  console.log('\n' + label);
  console.log('  thresh       n    hit%    ROI%  months+   worst          best');
  for (const t of THRESHOLDS) {
    const picked = rows.filter(r => r.edge >= t && r.edge < MAX_EDGE);
    const o = roi(picked);
    const byMonth = new Map();
    for (const r of picked) {
      if (!byMonth.has(r.month)) byMonth.set(r.month, []);
      byMonth.get(r.month).push(r);
    }
    const months = [...byMonth.entries()].map(([m, rs]) => Object.assign({ m }, roi(rs)))
      .filter(x => x.n >= 10).sort((a, b) => a.roi - b.roi);
    const pos = months.filter(x => x.roi > 0).length;
    const w = months[0], bst = months[months.length - 1];
    console.log('  >=' + String(t).padStart(2) + '%  ' + String(o.n).padStart(6) +
      '  ' + o.hit.toFixed(1).padStart(6) + '  ' + o.roi.toFixed(1).padStart(6) +
      '  ' + (pos + '/' + months.length).padStart(7) + '  ' +
      (w ? w.m + ' ' + (w.roi.toFixed(0) + '%').padStart(5) + '  ' + bst.m + ' ' + (bst.roi.toFixed(0) + '%').padStart(5) : '-'));
  }
  if (DETAIL) {
    const t = THRESHOLDS[0];
    const byMonth = new Map();
    for (const r of rows.filter(r => r.edge >= t && r.edge < MAX_EDGE)) {
      if (!byMonth.has(r.month)) byMonth.set(r.month, []);
      byMonth.get(r.month).push(r);
    }
    for (const m of [...byMonth.keys()].sort()) {
      const o = roi(byMonth.get(m));
      console.log('    ' + m + '  n=' + String(o.n).padStart(5) + '  hit ' +
        o.hit.toFixed(1).padStart(5) + '%  ROI ' + o.roi.toFixed(1).padStart(6) + '%');
    }
  }
  if (bySide) {
    const t = THRESHOLDS[0];
    const picked = rows.filter(r => r.edge >= t && r.edge < MAX_EDGE);
    for (const side of [...new Set(picked.map(r => r.side))]) {
      const o = roi(picked.filter(r => r.side === side));
      console.log('    >=' + t + '% ' + side.padEnd(7) + ' n=' + String(o.n).padStart(6) +
        '  hit ' + o.hit.toFixed(1) + '%  ROI ' + o.roi.toFixed(1) + '%');
    }
  }
}

// ── main ─────────────────────────────────────────────────────────────────────
const b365 = loadBook('Bet365');
const sbo  = loadBook('Sbobet');
const pairsAll = mergeBooks(b365.rows, sbo.rows);
const pairs = pairsAll.filter(p => tierOk(p.b));

console.log('data root      ' + DATA_ROOT);
console.log('Bet365         ' + b365.rows.length + ' rows (' + b365.dropped + ' of ' + b365.raw + ' dropped by processRow)');
console.log('Sbobet         ' + sbo.rows.length + ' rows (' + sbo.dropped + ' of ' + sbo.raw + ' dropped by processRow)');
console.log('merged pairs   ' + pairsAll.length + ' -> ' + pairs.length + ' after tier=' + TIER);
console.log('months         ' + [...new Set(pairs.map(p => p.b.month))].sort().join(' '));
console.log('settings       max-edge <' + MAX_EDGE + '%  price ' + MIN_PRICE + '-' + MAX_PRICE + '  thresholds ' + THRESHOLDS.join(','));

const priceOk = r => r.price >= MIN_PRICE && r.price <= MAX_PRICE;
const methods = DEVIG === 'all' ? Object.keys(DEVIGS) : [DEVIG];

for (const m of methods) {
  const fn = DEVIGS[m];
  if (!fn) throw new Error('unknown devig: ' + m);
  for (const phase of ['open', 'close']) {
    const rows = [];
    for (const p of pairs) for (const r of x12Rows(p, phase, fn)) if (priceOk(r)) rows.push(r);
    report('1X2 - Bet365 vs Sbobet de-vigged (' + m + '), ' +
      (phase === 'open' ? 'opening vs opening' : 'closing vs closing') +
      ' - ' + rows.length + ' comparisons', rows, { bySide: true });
  }
}

if (CONTROL) {
  for (const phase of ['open', 'close']) {
    const rows = [];
    for (const p of pairs) for (const r of controlRows(p, phase)) if (priceOk(r)) rows.push(r);
    report('CONTROL AH+O/U same line (two-way proportional), ' +
      (phase === 'open' ? 'opening' : 'closing') +
      ' - ' + rows.length + ' comparisons', rows, { bySide: true });
  }
}

// ── --lead: is the opening edge real, or just "whose snapshot came later"? ───
// Three diagnostics, in the order they matter:
//   1. each book's own margin, 1X2 vs AH — tells you how much de-vig has to
//      guess at, and therefore how much the de-vig method can fabricate;
//   2. who leads — does Bet365 close toward Sbobet's opening, or the reverse;
//   3. the opening-flagged picks re-priced against Sbobet's CLOSING fair — if
//      the gap were only Sbobet's opening being early/uninformed, it would
//      disappear once Sbobet has seen the same information.
function leadDiagnostics() {
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  const okX2 = r => ['x2_home', 'x2_draw', 'x2_away'].every(k => r[k + '_o'] > 1 && r[k + '_c'] > 1);

  const x2 = { b_o: [], b_c: [], s_o: [], s_c: [] };
  const ah = { b_o: [], b_c: [], s_o: [], s_c: [] };
  for (const { b, s } of pairs) {
    for (const [r, tag] of [[b, 'b'], [s, 's']]) {
      for (const [sfx, key] of [['_o', '_o'], ['_c', '_c']]) {
        const o = [r['x2_home' + sfx], r['x2_draw' + sfx], r['x2_away' + sfx]];
        if (o.every(x => x > 1)) x2[tag + key].push(o.reduce((a, x) => a + 1 / x, 0));
      }
      if (r.fav_oo > 1 && r.dog_oo > 1) ah[tag + '_o'].push(1 / r.fav_oo + 1 / r.dog_oo);
      if (r.fav_oc > 1 && r.dog_oc > 1) ah[tag + '_c'].push(1 / r.fav_oc + 1 / r.dog_oc);
    }
  }
  console.log('\nbook margin (sum of 1/odds), mean — b=Bet365 s=Sbobet, _o opening _c closing');
  console.log('  1X2 (three-way)  ' + Object.keys(x2).map(k => k + ' ' + mean(x2[k]).toFixed(4)).join('   '));
  console.log('  AH  (two-way)    ' + Object.keys(ah).map(k => k + ' ' + mean(ah[k]).toFixed(4)).join('   '));

  const fn = devigPower;
  let bToS = 0, sToB = 0, tot = 0;
  for (const { b, s } of pairs) {
    if (!okX2(b) || !okX2(s)) continue;
    const bo = fn([b.x2_home_o, b.x2_draw_o, b.x2_away_o]), bc = fn([b.x2_home_c, b.x2_draw_c, b.x2_away_c]);
    const so = fn([s.x2_home_o, s.x2_draw_o, s.x2_away_o]), sc = fn([s.x2_home_c, s.x2_draw_c, s.x2_away_c]);
    for (let i = 0; i < 3; i++) {
      const gap = so[i] - bo[i];
      if (Math.abs(gap) < 0.01) continue;   // 1pp apart or more, else it is noise
      tot++;
      if (Math.sign(bc[i] - bo[i]) === Math.sign(gap)) bToS++;   // Bet365 moved toward Sbobet's open
      if (Math.sign(sc[i] - so[i]) === Math.sign(-gap)) sToB++;  // Sbobet moved toward Bet365's open
    }
  }
  console.log('\nwho leads on 1X2 (power de-vig, gaps >= 1pp), n=' + tot);
  console.log('  Bet365 closed toward Sbobet opening   ' + (bToS / tot * 100).toFixed(1) + '%');
  console.log('  Sbobet closed toward Bet365 opening   ' + (sToB / tot * 100).toFixed(1) + '%');

  const rows = [];
  for (const { b, s } of pairs) {
    if (!okX2(b) || !okX2(s)) continue;
    const fairO = fn([s.x2_home_o, s.x2_draw_o, s.x2_away_o]).map(p => 1 / p);
    const fairC = fn([s.x2_home_c, s.x2_draw_c, s.x2_away_c]).map(p => 1 / p);
    const bo = [b.x2_home_o, b.x2_draw_o, b.x2_away_o];
    const bc = [b.x2_home_c, b.x2_draw_c, b.x2_away_c];
    const won = [b.homeWinsFT, b.drawFT, b.awayWinsFT];
    for (let i = 0; i < 3; i++) rows.push({
      edgeOO: (bo[i] / fairO[i] - 1) * 100, edgeOC: (bo[i] / fairC[i] - 1) * 100,
      price: bo[i], closePrice: bc[i], won: won[i], month: b.month,
    });
  }
  const t = THRESHOLDS[0];
  const flagged = rows.filter(r => r.edgeOO >= t && r.edgeOO < MAX_EDGE);
  const f = x => JSON.stringify(roi(x), (k, v) => typeof v === 'number' ? +v.toFixed(1) : v);
  console.log('\nopening-flagged picks (>=' + t + '% vs Sbobet opening fair, power), n=' + flagged.length);
  console.log('  taken at Bet365 OPENING price   ' + f(flagged));
  console.log('  taken at Bet365 CLOSING price   ' + f(flagged.map(r => ({ won: r.won, price: r.closePrice }))));
  console.log('  mean edge vs Sbobet opening fair  ' + mean(flagged.map(r => r.edgeOO)).toFixed(2) + '%');
  console.log('  mean edge vs Sbobet CLOSING fair  ' + mean(flagged.map(r => r.edgeOC)).toFixed(2) + '%');
  const still = flagged.filter(r => r.edgeOC >= t);
  console.log('  still >=' + t + '% vs Sbobet closing fair: ' + still.length +
    ' (' + (still.length / flagged.length * 100).toFixed(1) + '%)  ' + f(still));
}

if (LEAD) leadDiagnostics();
