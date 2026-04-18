'use strict';
// Pinnacle closing value baseline — calibration + multi-signal comparison
//
// For every bucket prints 5 sub-rows:
//   BASE   — all matches in bucket
//   LINE   — fav AH line steamed (closing > opening + 0.12)
//   L+O    — fav line steamed AND fav odds steamed (closing odds < opening - 0.06)
//   Δ LINE — LINE% − BASE%
//   Δ L+O  — L+O%  − BASE%
//
// Usage:
//   node backtest_baseline.js          # TOP+MAJOR leagues
//   node backtest_baseline.js --all    # all leagues
//   node backtest_baseline.js --tl     # also break down by TL band
//   node backtest_baseline.js --ci     # append Wilson 95% CI lower bound to signal rows

const path = require('path');
const { loadDatabase } = require('./engine');

const DATA_DIR = path.resolve(__dirname, '../static/data');
const TIER     = process.argv.includes('--all') ? 'ALL' : 'TOP+MAJOR';
const BY_TL    = process.argv.includes('--tl');
const SHOW_CI  = process.argv.includes('--ci');

// ── Bets to report ────────────────────────────────────────────────────────────
const REPORT_BETS = [
  { key: 'homeWinsFT', label: '1(H)' },
  { key: 'drawFT',     label: 'X' },
  { key: 'awayWinsFT', label: '2(A)' },
  { key: 'over05_1H',  label: 'O0.5_1H' },
  { key: 'ahCover',    label: 'AH_Fav' },
  { key: 'dogCover',   label: 'AH_Dog' },
  { key: 'over05_2H',  label: 'O0.5_2H' },
  { key: 'over15_2H',  label: 'O1.5_2H' },
  { key: 'over15FT',   label: 'O1.5FT' },
  { key: 'over25FT',   label: 'O2.5FT' },
  { key: 'btts',       label: 'BTTS' },
  { key: 'under25FT',  label: 'U2.5FT' },
  { key: 'under15_2H', label: 'U1.5_2H' },
];

// ── Band definitions ──────────────────────────────────────────────────────────
const FAV_OC_BANDS = [
  [null, 1.80, '<1.80'],
  [1.80, 2.00, '1.80-2.00'],
  [2.00, null, '>2.00'],
];

const TL_BANDS = [
  [null, 2.25, '≤2.25'],
  [2.25, 2.75, '2.25-2.75'],
  [2.75, 3.25, '2.75-3.25'],
  [3.25, null, '≥3.25'],
];

const VALID_LINES = [0.00, 0.25, 0.50, 0.75, 1.00, 1.25, 1.50];

// ── Helpers ───────────────────────────────────────────────────────────────────
function applyTier(rows, tier) {
  if (tier === 'ALL') return rows;
  if (tier === 'TOP')       return rows.filter(r => r.league_tier === 'TOP');
  if (tier === 'TOP+MAJOR') return rows.filter(r => r.league_tier === 'TOP' || r.league_tier === 'MAJOR');
  return rows;
}

function inBand(val, lo, hi) {
  return (lo == null || val >= lo) && (hi == null || val < hi);
}

function hitRate(rows, key) {
  if (!rows.length) return null;
  return rows.filter(r => r[key]).length / rows.length * 100;
}

function wilsonCI(p100, n) {
  if (!n || p100 == null) return [null, null];
  const p = p100 / 100, z = 1.96;
  const d = 1 + z * z / n;
  const c = (p + z * z / (2 * n)) / d;
  const m = z * Math.sqrt(p * (1 - p) / n + z * z / (4 * n * n)) / d;
  return [
    Math.round(Math.max(0, c - m) * 1000) / 10,
    Math.round(Math.min(1, c + m) * 1000) / 10,
  ];
}

function zScore(base, signal, key) {
  const n1 = base.length, n2 = signal.length;
  if (n1 < 5 || n2 < 5) return 0;
  const p1 = base.filter(r => r[key]).length / n1;
  const p2 = signal.filter(r => r[key]).length / n2;
  const pp = (p1 * n1 + p2 * n2) / (n1 + n2);
  if (pp <= 0 || pp >= 1) return 0;
  const se = Math.sqrt(pp * (1 - pp) * (1 / n1 + 1 / n2));
  return se > 0 ? (p2 - p1) / se : 0;
}

function avgOf(rows, key) {
  const valid = rows.filter(r => r[key] != null);
  if (!valid.length) return null;
  return valid.reduce((s, r) => s + r[key], 0) / valid.length;
}

// ── Comparison printer ────────────────────────────────────────────────────────
// groups: [{ label, base, line, lo }, ...]
//   base = all rows in bucket
//   line = fav line steam only
//   lo   = fav line steam + fav odds steam
// Prints: BASE / LINE / L+O / Δ(LINE) / Δ(L+O)
function printComparison(title, groups) {
  const W = 8;
  const LINE_W = 100 + REPORT_BETS.length * W;
  const BET_HDR = REPORT_BETS.map(b => b.label.padStart(W)).join('');

  console.log(`\n${'═'.repeat(LINE_W)}`);
  console.log(`  ${title}`);
  console.log('═'.repeat(LINE_W));
  console.log(
    'Tag   '.padEnd(7) +
    'Rows'.padStart(6) + '  ' +
    'HomFav'.padStart(7) + '  ' +
    'AvgFavOc'.padStart(9) + '  ' +
    'Mkt_AH'.padStart(7) + '  ' +
    BET_HDR
  );

  let anyPrinted = false;

  for (const { label, base, line, lo } of groups) {
    if (!base.length) continue;
    anyPrinted = true;

    const nb   = base.length;
    const nl   = line.length;
    const nlo  = lo.length;

    console.log('─'.repeat(LINE_W));
    console.log(
      `  ${label}` +
      `   base N=${nb}` +
      `  |  LINE N=${nl} (${(nl/nb*100).toFixed(1)}%)` +
      `  |  L+O N=${nlo} (${(nlo/nb*100).toFixed(1)}%)`
    );
    console.log('─'.repeat(LINE_W));

    // Print a data row (BASE, LINE, or L+O)
    const dataRow = (tag, rows) => {
      if (!rows.length) {
        console.log(tag.padEnd(7) + '  (no data)');
        return;
      }
      const n      = rows.length;
      const homFav = (rows.filter(r => r.fav_side === 'HOME').length / n * 100).toFixed(0) + '%';
      const favOcA = avgOf(rows, 'fav_oc');
      const mktAH  = favOcA ? (1 / favOcA * 100).toFixed(1) + '%' : '—';

      const meta =
        tag.padEnd(7) +
        String(n).padStart(6) + '  ' +
        homFav.padStart(7) + '  ' +
        (favOcA ? favOcA.toFixed(2) : '—').padStart(9) + '  ' +
        mktAH.padStart(7) + '  ';

      const cells = REPORT_BETS.map(b => {
        const hr = hitRate(rows, b.key);
        if (hr == null) return '—'.padStart(W);
        if (tag !== 'BASE' && SHOW_CI) {
          const [lo_ci] = wilsonCI(hr, n);
          if (lo_ci != null) return `${hr.toFixed(1)}[${lo_ci}]`.padStart(W);
        }
        return (hr.toFixed(1) + '%').padStart(W);
      });

      console.log(meta + cells.join(''));
    };

    // Print a delta row (signal vs base)
    const deltaRow = (tag, signal) => {
      if (!signal.length) {
        console.log(tag.padEnd(7) + '  (no data)');
        return;
      }
      const meta =
        tag.padEnd(7) +
        ''.padStart(6) + '  ' +
        ''.padStart(7) + '  ' +
        ''.padStart(9) + '  ' +
        ''.padStart(7) + '  ';

      const cells = REPORT_BETS.map(b => {
        const hr_base = hitRate(base, b.key);
        const hr_sig  = hitRate(signal, b.key);
        if (hr_base == null || hr_sig == null) return '—'.padStart(W);
        const d   = hr_sig - hr_base;
        const z   = zScore(base, signal, b.key);
        const sig = Math.abs(z) >= 2.0 ? '**' : Math.abs(z) >= 1.5 ? '*' : '';
        const sign = d >= 0 ? '+' : '';
        return (sign + d.toFixed(1) + sig).padStart(W);
      });

      console.log(meta + cells.join(''));
    };

    dataRow('BASE',     base);
    dataRow('LINE',     line);
    dataRow('L+O',      lo);
    deltaRow('Δ LINE',  line);
    deltaRow('Δ L+O',   lo);
  }

  if (!anyPrinted) console.log('  (no data)');
  console.log('═'.repeat(LINE_W));
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  console.log(`\nLoading database from ${DATA_DIR}…`);
  const fullDb = loadDatabase(DATA_DIR);
  const db     = applyTier(fullDb, TIER);

  // Signal definitions
  const lineSteam = db.filter(r => r.line_move === 'DEEPER');
  const lineAndOdds = db.filter(r => r.line_move === 'DEEPER' && r.fav_odds_move === 'IN');

  console.log(`Total rows         : ${fullDb.length}`);
  console.log(`Tier ${TIER}  : ${db.length} rows`);
  console.log(`  LINE steam only  : ${lineSteam.length}  (${(lineSteam.length/db.length*100).toFixed(1)}%)`);
  console.log(`  LINE + ODDS IN   : ${lineAndOdds.length}  (${(lineAndOdds.length/db.length*100).toFixed(1)}%)`);
  console.log(`\nLegend:`);
  console.log(`  LINE  = fav AH line steamed (closing > opening + 0.12)`);
  console.log(`  L+O   = LINE + fav odds steamed (closing odds < opening - 0.06)`);
  console.log(`  Δ     = signal% − base%    ** z≥2.0 · * z≥1.5`);
  console.log(`  Mkt_AH% = avg(1/fav_oc)   1(H)/X/2(A) = raw home·draw·away FT\n`);

  // Helper: build group array for printComparison
  function mkGroups(buckets) {
    return buckets.map(({ label, filter }) => ({
      label,
      base: db.filter(filter),
      line: lineSteam.filter(filter),
      lo:   lineAndOdds.filter(filter),
    }));
  }

  // ── 1. Overall ────────────────────────────────────────────────────────────
  printComparison(`OVERALL  (tier=${TIER})`, [{
    label: 'ALL',
    base: db,
    line: lineSteam,
    lo:   lineAndOdds,
  }]);

  // ── 2. By AH line ─────────────────────────────────────────────────────────
  printComparison(`BY FAV LINE  (tier=${TIER})`,
    VALID_LINES.map(fl => ({
      label: `Line ${fl.toFixed(2)}`,
      base:  db.filter(r => r.fav_lc === fl),
      line:  lineSteam.filter(r => r.fav_lc === fl),
      lo:    lineAndOdds.filter(r => r.fav_lc === fl),
    }))
  );

  // ── 3. By AH line × fav_oc band ───────────────────────────────────────────
  for (const fl of VALID_LINES) {
    const lineBase = db.filter(r => r.fav_lc === fl);
    const lineSt   = lineSteam.filter(r => r.fav_lc === fl);
    const lineLO   = lineAndOdds.filter(r => r.fav_lc === fl);
    if (lineBase.length < 30) continue;

    const groups = FAV_OC_BANDS.map(([lo, hi, label]) => ({
      label,
      base: lineBase.filter(r => r.fav_oc != null && inBand(r.fav_oc, lo, hi)),
      line: lineSt.filter(r => r.fav_oc != null && inBand(r.fav_oc, lo, hi)),
      lo:   lineLO.filter(r => r.fav_oc != null && inBand(r.fav_oc, lo, hi)),
    })).filter(g => g.base.length >= 20);

    if (groups.length) {
      printComparison(
        `LINE ${fl.toFixed(2)} × FAV ODDS BAND  (base N=${lineBase.length} / LINE N=${lineSt.length} / L+O N=${lineLO.length})`,
        groups
      );
    }
  }

  // ── 4. Optional: by TL band ───────────────────────────────────────────────
  if (BY_TL) {
    const withTL = db.filter(r => r.tl_c != null);
    printComparison(`BY TL BAND  (tier=${TIER}, N=${withTL.length})`,
      TL_BANDS.map(([lo, hi, label]) => ({
        label,
        base: withTL.filter(r => inBand(r.tl_c, lo, hi)),
        line: lineSteam.filter(r => r.tl_c != null && inBand(r.tl_c, lo, hi)),
        lo:   lineAndOdds.filter(r => r.tl_c != null && inBand(r.tl_c, lo, hi)),
      }))
    );

    for (const fl of VALID_LINES) {
      const lineBase = withTL.filter(r => r.fav_lc === fl);
      if (lineBase.length < 30) continue;
      const groups = TL_BANDS.map(([lo, hi, label]) => ({
        label,
        base: lineBase.filter(r => inBand(r.tl_c, lo, hi)),
        line: lineSteam.filter(r => r.fav_lc === fl && r.tl_c != null && inBand(r.tl_c, lo, hi)),
        lo:   lineAndOdds.filter(r => r.fav_lc === fl && r.tl_c != null && inBand(r.tl_c, lo, hi)),
      })).filter(g => g.base.length >= 20);
      if (groups.length) printComparison(`LINE ${fl.toFixed(2)} × TL BAND`, groups);
    }
  }

  // ── 5. Calibration: all lines × fav_oc band ──────────────────────────────
  printComparison(`CALIBRATION: ALL LINES × FAV ODDS BAND  (tier=${TIER})`,
    FAV_OC_BANDS.map(([lo, hi, label]) => ({
      label,
      base: db.filter(r => r.fav_oc != null && inBand(r.fav_oc, lo, hi)),
      line: lineSteam.filter(r => r.fav_oc != null && inBand(r.fav_oc, lo, hi)),
      lo:   lineAndOdds.filter(r => r.fav_oc != null && inBand(r.fav_oc, lo, hi)),
    })).filter(g => g.base.length >= 20)
  );
}

main();
