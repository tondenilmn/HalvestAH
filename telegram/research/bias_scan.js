// telegram/research/bias_scan.js
//
// Part F1 of LIVE_BETTING_PLAN.md — "pricing-bias scan": for every outcome in
// 1X2 / Asian Handicap / Totals, at closing AND opening price, bucketed by
// price band (1X2) or line magnitude (AH/Totals) and by league tier, compute
// the realised flat-stake ROI of blindly backing that outcome across the
// ~240k Bet365 rows in static/data/Bet365/*.csv.
//
// A cell is flagged as a candidate only if the Wilson-style CI lower bound
// on ROI is positive in >= 2 of 3 chronological thirds of the dataset (walk-
// forward-ish: this is pure historical measurement, no training happens).
//
// Run: node telegram/research/bias_scan.js
//
// Exploratory script — deliberately flat, no class hierarchy.

const fs = require('fs');
const path = require('path');
const Papa = require('papaparse');
const { classifyLeague } = require('../engine.js');

const DATA_DIR = path.resolve(__dirname, '../../static/data/Bet365');
const REPORT_DIR = path.resolve(__dirname, 'reports');
const MIN_N = 500;
const Z = 1.96;

// ── odds bands / buckets ──────────────────────────────────────────────────
const PRICE_BANDS = [
  { lo: 0, hi: 1.5, label: '<1.5' },
  { lo: 1.5, hi: 2, label: '1.5-2' },
  { lo: 2, hi: 3, label: '2-3' },
  { lo: 3, hi: 5, label: '3-5' },
  { lo: 5, hi: 10, label: '5-10' },
  { lo: 10, hi: Infinity, label: '>10' },
];
const AH_LINE_BANDS = [
  { lo: 0, hi: 0.25, label: '0-0.25' },
  { lo: 0.5, hi: 0.75, label: '0.5-0.75' },
  { lo: 1, hi: 1.25, label: '1-1.25' },
  { lo: 1.5, hi: Infinity, label: '1.5+' },
];
const TL_BANDS = [
  { lo: 0, hi: 2, label: '<2' },
  { lo: 2, hi: 2.5, label: '2-2.5' },
  { lo: 2.5, hi: 3, label: '2.5-3' },
  { lo: 3, hi: Infinity, label: '>3' },
];
const TIERS = ['TOP', 'MAJOR', 'OTHER'];

function bandFor(bands, v) {
  for (const b of bands) if (v >= b.lo && v < b.hi) return b.label;
  // top-of-range edge (e.g. exactly the last band's hi, which is Infinity so
  // this only matters for internal bands whose hi is exclusive but equals lo
  // of the next — nothing falls through in practice, but guard anyway)
  return null;
}

// ── numeric parse helper ──────────────────────────────────────────────────
function sf(v) {
  const f = parseFloat(String(v == null ? '' : v).trim());
  return Number.isFinite(f) ? f : null;
}

// ── AH / Totals settlement (handles quarter lines via half-half split) ────
// adj > 0 => backed side wins the (sub-)line; adj < 0 => loses; adj == 0 => push.
function subReturn(adj, odds) {
  if (adj > 1e-9) return odds - 1;
  if (adj < -1e-9) return -1;
  return 0; // push
}

// margin: backed side's goal margin (backedGoals - oppGoals) for AH,
//         or totalGoals for Over, or -totalGoals for Under (see callers).
// line:   the AH/TL line from the backed side's perspective (already signed
//         so that adj = margin + line > 0 means a win).
function lineReturn(margin, line, odds) {
  const quarterish = Math.abs(Math.abs(line * 4) % 2) > 1e-6; // .25/.75 fractional
  if (quarterish) {
    const lo = line - 0.25;
    const hi = line + 0.25;
    return (subReturn(margin + lo, odds) + subReturn(margin + hi, odds)) / 2;
  }
  return subReturn(margin + line, odds);
}

// ── stats: mean-return CI (normal approximation on the sample mean) ───────
// More appropriate here than a binomial Wilson CI since AH/Totals returns
// are continuous (pushes, half-wins from quarter lines), not pure win/lose.
// For pure win/lose markets (1X2) this reduces to the same shape a Wilson
// interval would give at this sample size.
function meanCI(returns) {
  const n = returns.length;
  if (n === 0) return { n: 0, roi: null, lo: null, hi: null };
  const mean = returns.reduce((a, b) => a + b, 0) / n;
  const variance = n > 1
    ? returns.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1)
    : 0;
  const se = Math.sqrt(variance / n);
  return {
    n,
    roi: mean,
    lo: mean - Z * se,
    hi: mean + Z * se,
  };
}

function pct1(x) { return x == null ? 'n/a' : (x * 100).toFixed(1) + '%'; }

// ── load & normalise rows ──────────────────────────────────────────────────
function loadRows() {
  const files = fs.readdirSync(DATA_DIR).filter(f => f.toLowerCase().endsWith('.csv'));
  const rows = [];
  const skipped = { badDate: 0, badFtResult: 0, badAh: 0, badTotals: 0, bad1x2: 0, total: 0 };

  for (const f of files) {
    const csv = fs.readFileSync(path.join(DATA_DIR, f), 'utf8');
    const { data } = Papa.parse(csv, { header: true, skipEmptyLines: true });
    for (const r of data) {
      skipped.total++;
      const dateStr = (r['Date'] || '').trim();
      const d = dateStr ? new Date(dateStr + 'T00:00:00Z') : null;
      if (!d || isNaN(d.getTime())) { skipped.badDate++; continue; }

      const ftRaw = (r['FT Result'] || '').trim();
      const m = /^(\d+)\s*-\s*(\d+)$/.exec(ftRaw);
      if (!m) { skipped.badFtResult++; continue; }
      const homeG = parseInt(m[1], 10), awayG = parseInt(m[2], 10);

      const league = r['League'] || '';
      const tier = classifyLeague(league);

      const ahHc = sf(r['Home AH Closing']), ahHo = sf(r['Home AH Opening']);
      const ahAc = sf(r['Away AH Closing']), ahAo = sf(r['Away AH Opening']);
      const hoC = sf(r['Home Odds Closing']), hoO = sf(r['Home Odds Opening']);
      const aoC = sf(r['Away Odds Closing']), aoO = sf(r['Away Odds Opening']);
      const ahOk = [ahHc, ahHo, ahAc, ahAo, hoC, hoO, aoC, aoO].every(v => v != null) &&
                   hoC > 1 && hoO > 1 && aoC > 1 && aoO > 1;
      if (!ahOk) skipped.badAh++;

      const tlC = sf(r['Total Line Closing']), tlO = sf(r['Total Line Opening']);
      const ovC = sf(r['Over Odds Closing']), ovO = sf(r['Over Odds Opening']);
      const unC = sf(r['Under Odds Closing']), unO = sf(r['Under Odds Opening']);
      const totOk = [tlC, tlO, ovC, ovO, unC, unO].every(v => v != null) &&
                    ovC > 1 && ovO > 1 && unC > 1 && unO > 1;
      if (!totOk) skipped.badTotals++;

      const x1hc = sf(r['1X2 Home Closing']), x1dc = sf(r['1X2 Draw Closing']), x1ac = sf(r['1X2 Away Closing']);
      const x1ho = sf(r['1X2 Home Opening']), x1do = sf(r['1X2 Draw Opening']), x1ao = sf(r['1X2 Away Opening']);
      const x1Ok = [x1hc, x1dc, x1ac, x1ho, x1do, x1ao].every(v => v != null) &&
                   x1hc > 1 && x1dc > 1 && x1ac > 1 && x1ho > 1 && x1do > 1 && x1ao > 1;
      if (!x1Ok) skipped.bad1x2++;

      if (!ahOk && !totOk && !x1Ok) continue; // nothing usable on this row at all

      rows.push({
        date: d, tier, homeG, awayG,
        ahOk, ahHc, ahHo, ahAc, ahAo, hoC, hoO, aoC, aoO,
        totOk, tlC, tlO, ovC, ovO, unC, unO,
        x1Ok, x1hc, x1dc, x1ac, x1ho, x1do, x1ao,
      });
    }
  }

  rows.sort((a, b) => a.date - b.date);
  rows.forEach((r, i) => {
    r.monthKey = `${r.date.getUTCFullYear()}-${String(r.date.getUTCMonth() + 1).padStart(2, '0')}`;
    r.slice = Math.min(2, Math.floor((i / rows.length) * 3)); // thirds by chronological position
  });

  return { rows, skipped };
}

// ── generic cell accumulator ────────────────────────────────────────────
// key -> { returns: number[], byMonth: Map<monthKey, number[]>, bySlice: [ [],[],[] ] }
function makeCell() {
  return { returns: [], byMonth: new Map(), bySlice: [[], [], []] };
}
function push(cell, ret, monthKey, slice) {
  cell.returns.push(ret);
  if (!cell.byMonth.has(monthKey)) cell.byMonth.set(monthKey, []);
  cell.byMonth.get(monthKey).push(ret);
  cell.bySlice[slice].push(ret);
}

function summariseCell(key, cell) {
  const overall = meanCI(cell.returns);
  if (overall.n < MIN_N) return null;

  const perMonth = {};
  for (const [mk, arr] of [...cell.byMonth.entries()].sort()) {
    perMonth[mk] = meanCI(arr);
  }
  const perSlice = cell.bySlice.map(meanCI);
  const slicesPositive = perSlice.filter(s => s.n > 0 && s.lo != null && s.lo > 0).length;
  const slicesWithData = perSlice.filter(s => s.n > 0).length;
  const candidate = slicesWithData === 3 && slicesPositive >= 2;

  return { key, ...overall, perMonth, perSlice, slicesPositive, candidate };
}

// ── build all cells ──────────────────────────────────────────────────────
function runScan(rows) {
  const cells = new Map(); // key -> cell
  const get = k => cells.get(k) || (cells.set(k, makeCell()), cells.get(k));

  // overround accumulators: tier -> { market -> {sum, n} }, closing+opening separate
  const overround = {};
  for (const t of TIERS) overround[t] = {
    x1_c: { sum: 0, n: 0 }, x1_o: { sum: 0, n: 0 },
    ah_c: { sum: 0, n: 0 }, ah_o: { sum: 0, n: 0 },
    ou_c: { sum: 0, n: 0 }, ou_o: { sum: 0, n: 0 },
  };

  for (const r of rows) {
    if (!TIERS.includes(r.tier)) continue;
    const or = overround[r.tier];

    // ── 1X2 ──────────────────────────────────────────────────────────────
    if (r.x1Ok) {
      or.x1_c.sum += 1 / r.x1hc + 1 / r.x1dc + 1 / r.x1ac - 1; or.x1_c.n++;
      or.x1_o.sum += 1 / r.x1ho + 1 / r.x1do + 1 / r.x1ao - 1; or.x1_o.n++;

      const homeWin = r.homeG > r.awayG, awayWin = r.awayG > r.homeG, draw = r.homeG === r.awayG;
      for (const priceType of ['closing', 'opening']) {
        const [ho, dOdd, ao] = priceType === 'closing'
          ? [r.x1hc, r.x1dc, r.x1ac] : [r.x1ho, r.x1do, r.x1ao];
        const homeBand = bandFor(PRICE_BANDS, ho);
        const drawBand = bandFor(PRICE_BANDS, dOdd);
        const awayBand = bandFor(PRICE_BANDS, ao);
        if (homeBand) push(get(`1X2|home|${priceType}|band=${homeBand}|tier=${r.tier}`),
          homeWin ? ho - 1 : -1, r.monthKey, r.slice);
        if (drawBand) push(get(`1X2|draw|${priceType}|band=${drawBand}|tier=${r.tier}`),
          draw ? dOdd - 1 : -1, r.monthKey, r.slice);
        if (awayBand) push(get(`1X2|away|${priceType}|band=${awayBand}|tier=${r.tier}`),
          awayWin ? ao - 1 : -1, r.monthKey, r.slice);
      }
    }

    // ── Asian Handicap ─────────────────────────────────────────────────
    if (r.ahOk) {
      or.ah_c.sum += 1 / r.hoC + 1 / r.aoC - 1; or.ah_c.n++;
      or.ah_o.sum += 1 / r.hoO + 1 / r.aoO - 1; or.ah_o.n++;

      const margin = r.homeG - r.awayG;
      for (const priceType of ['closing', 'opening']) {
        const [ahH, ahA, ho, ao] = priceType === 'closing'
          ? [r.ahHc, r.ahAc, r.hoC, r.aoC] : [r.ahHo, r.ahAo, r.hoO, r.aoO];
        // favourite = negative-line side; for level ball (line ~ 0), the
        // lower-odds side is the favourite instead (mirrors CLAUDE.md's
        // "Level Ball (0.00 Line)" rule for app.js).
        const favIsHome = ahH < 0 || (Math.abs(ahH) < 1e-9 && ho <= ao);
        const favLine = favIsHome ? ahH : ahA;
        const lineMag = Math.abs(favLine);
        const band = bandFor(AH_LINE_BANDS, lineMag);
        if (!band) continue;

        const homeRet = lineReturn(margin, ahH, ho);
        const awayRet = lineReturn(-margin, ahA, ao);
        const favRet = favIsHome ? homeRet : awayRet;
        const dogRet = favIsHome ? awayRet : homeRet;
        push(get(`AH|favourite|${priceType}|line=${band}|tier=${r.tier}`), favRet, r.monthKey, r.slice);
        push(get(`AH|dog|${priceType}|line=${band}|tier=${r.tier}`), dogRet, r.monthKey, r.slice);
      }
    }

    // ── Totals (O/U) ────────────────────────────────────────────────────
    if (r.totOk) {
      or.ou_c.sum += 1 / r.ovC + 1 / r.unC - 1; or.ou_c.n++;
      or.ou_o.sum += 1 / r.ovO + 1 / r.unO - 1; or.ou_o.n++;

      const totalGoals = r.homeG + r.awayG;
      for (const priceType of ['closing', 'opening']) {
        const [tl, ov, un] = priceType === 'closing'
          ? [r.tlC, r.ovC, r.unC] : [r.tlO, r.ovO, r.unO];
        const band = bandFor(TL_BANDS, tl);
        if (!band) continue;

        const overRet = lineReturn(totalGoals, -tl, ov);   // adj = totalGoals - tl
        const underRet = lineReturn(-totalGoals, tl, un);  // adj = tl - totalGoals
        push(get(`Totals|over|${priceType}|tl=${band}|tier=${r.tier}`), overRet, r.monthKey, r.slice);
        push(get(`Totals|under|${priceType}|tl=${band}|tier=${r.tier}`), underRet, r.monthKey, r.slice);
      }
    }
  }

  const summaries = [];
  for (const [key, cell] of cells.entries()) {
    const s = summariseCell(key, cell);
    if (s) summaries.push(s);
  }
  summaries.sort((a, b) => b.roi - a.roi);

  // overround averages
  const overroundReport = {};
  for (const t of TIERS) {
    const or = overround[t];
    overroundReport[t] = {};
    for (const k of Object.keys(or)) {
      overroundReport[t][k] = or[k].n ? or[k].sum / or[k].n : null;
    }
  }

  return { summaries, overroundReport };
}

// ── console report ─────────────────────────────────────────────────────
function printTable(rows, cols) {
  const widths = cols.map(c => Math.max(c.label.length, ...rows.map(r => String(c.fmt(r)).length)));
  const line = cols.map((c, i) => c.label.padEnd(widths[i])).join('  ');
  console.log(line);
  console.log(cols.map((c, i) => '-'.repeat(widths[i])).join('  '));
  for (const r of rows) {
    console.log(cols.map((c, i) => String(c.fmt(r)).padEnd(widths[i])).join('  '));
  }
}

function main() {
  console.log(`Loading Bet365 CSVs from ${DATA_DIR} ...`);
  const { rows, skipped } = loadRows();
  console.log(`Loaded ${rows.length} usable rows (of ${skipped.total} scanned).`);
  console.log(`Skipped: badDate=${skipped.badDate} badFtResult=${skipped.badFtResult} ` +
    `badAhOdds(row-level, still may be usable for other markets)=${skipped.badAh} ` +
    `badTotalsOdds=${skipped.badTotals} bad1X2Odds=${skipped.bad1x2}`);

  const months = [...new Set(rows.map(r => r.monthKey))].sort();
  console.log(`Months present: ${months.join(', ')}`);

  const { summaries, overroundReport } = runScan(rows);

  console.log('\n=== Overround (vig) by tier, market, closing/opening ===');
  const orRows = TIERS.map(t => ({ tier: t, ...overroundReport[t] }));
  printTable(orRows, [
    { label: 'Tier', fmt: r => r.tier },
    { label: '1X2-close', fmt: r => pct1(r.x1_c) },
    { label: '1X2-open', fmt: r => pct1(r.x1_o) },
    { label: 'AH-close', fmt: r => pct1(r.ah_c) },
    { label: 'AH-open', fmt: r => pct1(r.ah_o) },
    { label: 'O/U-close', fmt: r => pct1(r.ou_c) },
    { label: 'O/U-open', fmt: r => pct1(r.ou_o) },
  ]);

  console.log(`\n=== All cells with n >= ${MIN_N} (sorted by pooled ROI desc), ${summaries.length} total ===`);
  printTable(summaries, [
    { label: 'Cell', fmt: r => r.key },
    { label: 'n', fmt: r => r.n },
    { label: 'ROI', fmt: r => pct1(r.roi) },
    { label: 'CI-lo', fmt: r => pct1(r.lo) },
    { label: 'CI-hi', fmt: r => pct1(r.hi) },
    { label: 'SlicesPos', fmt: r => `${r.slicesPositive}/3` },
    { label: 'Candidate', fmt: r => r.candidate ? 'YES' : '' },
  ]);

  const candidates = summaries.filter(s => s.candidate);
  console.log(`\n=== CANDIDATES (Wilson-CI-lower ROI > 0 in >=2/3 chronological slices), n=${candidates.length} ===`);
  if (candidates.length === 0) {
    console.log('(none)');
  } else {
    printTable(candidates, [
      { label: 'Cell', fmt: r => r.key },
      { label: 'n', fmt: r => r.n },
      { label: 'ROI', fmt: r => pct1(r.roi) },
      { label: 'CI-lo', fmt: r => pct1(r.lo) },
      { label: 'SlicesPos', fmt: r => `${r.slicesPositive}/3` },
    ]);
  }

  // ── write JSON report ──────────────────────────────────────────────
  if (!fs.existsSync(REPORT_DIR)) fs.mkdirSync(REPORT_DIR, { recursive: true });
  const today = new Date().toISOString().slice(0, 10);
  const outPath = path.join(REPORT_DIR, `bias_scan_${today}.json`);
  const out = {
    generatedAt: new Date().toISOString(),
    rowCount: rows.length,
    skipped,
    months,
    minN: MIN_N,
    overround: overroundReport,
    cells: summaries,
    candidates: candidates.map(c => c.key),
  };
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2));
  console.log(`\nWrote JSON report to ${outPath}`);
}

main();
