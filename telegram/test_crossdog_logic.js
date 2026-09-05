'use strict';
// Isolated logic test for Strategy CROSSDOG's gate — mirrors
// test_livewatch_logic.js's convention of testing strategy logic WITHOUT
// requiring notify.js (which has no require.main guard and runs a real live
// scan + sends real Telegram alerts as a side effect of being required).

const assert = require('assert');
const { buildCfgFromMatch } = require('./engine');
const crossdogLib = require('./crossdog_lib');

// ── 1. cellKey must match between offline generation and live lookup ────────
{
  const k1 = crossdogLib.cellKey(0.5, 'HOME', 'MAJOR');
  const k2 = crossdogLib.cellKey(0.5, 'HOME', 'TOP');
  assert.strictEqual(k1, k2, 'MAJOR and TOP must bucket to the same TOP_MAJOR cell');
  assert.strictEqual(k1, '0.5|HOME|TOP_MAJOR');
  console.log('PASS: cellKey buckets TOP/MAJOR together, matches expected format');
}

// ── 2. buildCfgFromMatch agrees on fav_side/fav_line for identical odds ─────
{
  const odds = { ah_hc: -0.5, ah_ho: -0.5, ho_c: 1.70, ho_o: 1.75, ao_c: 2.20, ao_o: 2.10, tl_c: 2.5, tl_o: 2.5 };
  const cfgB = buildCfgFromMatch(odds, {});
  const cfgS = buildCfgFromMatch({ ...odds }, {});
  assert.strictEqual(cfgB.signals.favSide, 'HOME');
  assert.strictEqual(cfgB.signals.favLine, 0.5);
  assert.strictEqual(cfgB.signals.favSide, cfgS.signals.favSide);
  assert.strictEqual(cfgB.signals.favLine, cfgS.signals.favLine);
  console.log('PASS: buildCfgFromMatch is consistent when run independently on two identical odds objects (Bet365 vs Sbobet call sites)');
}

// ── 3. DOWN-bucket detection: Sbobet fav_line lower than Bet365's ───────────
{
  // Bet365: HOME favoured by 0.75. Sbobet: HOME favoured by only 0.5 (weaker) → DOWN.
  const b365Odds = { ah_hc: -0.75, ah_ho: -0.75, ho_c: 1.60, ho_o: 1.65, ao_c: 2.40, ao_o: 2.30 };
  const sboOdds  = { ah_hc: -0.5,  ah_ho: -0.5,  ho_c: 1.75, ho_o: 1.80, ao_c: 2.10, ao_o: 2.00 };
  const b365Cfg = buildCfgFromMatch(b365Odds, {});
  const sboCfg  = buildCfgFromMatch(sboOdds, {});
  assert.strictEqual(b365Cfg.signals.favSide, sboCfg.signals.favSide, 'both books favour HOME here');
  const lineDelta = sboCfg.signals.favLine - b365Cfg.signals.favLine;
  assert.ok(lineDelta <= -crossdogLib.LINE_DELTA_THRESH, `expected a DOWN bucket, got delta=${lineDelta}`);
  console.log(`PASS: DOWN bucket detected correctly (Bet365 favLine=${b365Cfg.signals.favLine}, Sbobet favLine=${sboCfg.signals.favLine}, delta=${lineDelta})`);
}

// ── 4. Orientation mismatch is detected (books disagree on WHICH side) ──────
{
  const b365Odds = { ah_hc: -0.25, ah_ho: -0.25, ho_c: 1.95, ho_o: 1.95, ao_c: 1.90, ao_o: 1.90 };
  const sboOdds  = { ah_hc: 0.25,  ah_ho: 0.25,  ho_c: 2.05, ho_o: 2.05, ao_c: 1.80, ao_o: 1.80 };
  const b365Cfg = buildCfgFromMatch(b365Odds, {});
  const sboCfg  = buildCfgFromMatch(sboOdds, {});
  assert.notStrictEqual(b365Cfg.signals.favSide, sboCfg.signals.favSide, 'expected orientation disagreement');
  console.log(`PASS: orientation mismatch detected (Bet365=${b365Cfg.signals.favSide} favours differently than Sbobet=${sboCfg.signals.favSide})`);
}

// ── 5. Cell table loads and a known-good cell clears a realistic live price ─
{
  const { cells } = crossdogLib.loadCells();
  const key = '0.25|HOME|OTHER';
  const cell = cells[key];
  assert.ok(cell, `expected ${key} to exist in crossdog_cells.json — run crossdog_config_search.js first`);
  const impliedPrice = 100 / cell.ciLo;
  assert.ok(impliedPrice < 2.0, `sanity: 0.25-line dog cover implied price should be well under 2.0, got ${impliedPrice.toFixed(2)}`);
  console.log(`PASS: ${key} cell loaded — n=${cell.n} ciLo=${cell.ciLo.toFixed(1)}% impliedPrice=${impliedPrice.toFixed(2)}`);
}

// ── 6. fav_line=1.0's known-weak cell should NOT clear a typical dog price ──
{
  const { cells } = crossdogLib.loadCells();
  const cell = cells['1|HOME|OTHER'];
  assert.ok(cell, 'expected 1|HOME|OTHER to exist');
  const impliedPrice = 100 / cell.ciLo;
  const typicalDogPriceAtLine1 = 2.00; // realistic Bet365 dog price at a 1.0 AH line
  assert.ok(impliedPrice > typicalDogPriceAtLine1, `expected fav_line=1.0's gate to be too strict to clear a typical ~2.00 dog price (impliedPrice=${impliedPrice.toFixed(2)}) — this is what protects against the -8.7% ROI slice found in the concentration check, with no manual exclusion needed`);
  console.log(`PASS: fav_line=1.0 cell self-protects — impliedPrice=${impliedPrice.toFixed(2)} > typical live price ${typicalDogPriceAtLine1}, so it would correctly be SKIPped live`);
}

console.log('\nAll CROSSDOG logic tests passed.');
