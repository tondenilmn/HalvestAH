'use strict';
/**
 * Do live Bet365-vs-Pinnacle gaps pay? Reads the LIVEGAP recorder
 * (telegram/data/livegap/*.jsonl, written by notify.js's runLiveGapScan).
 *
 *   node livegap_report.js [--min 5] [--dir data/livegap]
 *   GET <bot>/livegap/report  (notify.js's relay server — same text)
 *
 * 1. ALERTS SENT — every Telegram alert, settled from the final score at two
 *    prices: the Bet365 price shown in the alert, and the "bet at X or
 *    higher" minimum (the worst price the alert told you to accept). Alerts
 *    are logged as `alert` lines since 2026-10-07; older ones are rebuilt
 *    from the recorded rows with the same gates (tagged "reconstructed" — the
 *    quiet window after a goal is approximated from the rows).
 * 2. ALL GAPS — every recorded gap at first sight and at alert timing (2nd
 *    scan in a row): how it closed within 15 min at the same score (Bet365
 *    came down = good price; Pinnacle moved up = lag) and ROI at entry.
 *    Also by Bet365 price band.
 * Settlement: only the CONFIRMED full-time score the bot read from the
 * match page after the match (`res` lines, livegap_result.js) — never the
 * live list's last score. O/U and 1X2 on the full-time score, AH on goals
 * after the alert, quarter lines split; a match that went to extra time is
 * settled on its 90' score from the live feed (Bet365 settles at 90'), or
 * left unsettled if that wasn't seen. 1 unit per bet. Each alert shows
 * "settled (confirmed FT)", "waiting for FT" or "no result found".
 */
const fs = require('fs');
const path = require('path');

const sc = s => { const m = /^(\d+)-(\d+)$/.exec(String(s || '')); return m ? [+m[1], +m[2]] : null; };
const part = (x, price) => (x > 1e-9 ? price : x < -1e-9 ? 0 : 1);
const split = (base, line, price) => (Math.abs(Math.abs(line * 4) % 2 - 1) < 1e-6 ? (part(base + line - 0.25, price) + part(base + line + 0.25, price)) / 2 : part(base + line, price));
// Return per unit staked at `price` (price for a full win, 0 for a loss).
function payout(o, final, price) {
  const g = sc(final), s0 = sc(o.sc); if (!g || !s0) return null;
  if (o.mk === '1X2') { const d = g[0] - g[1]; return (o.side === 'home' ? d > 0 : o.side === 'away' ? d < 0 : d === 0) ? price : 0; }
  if (o.mk === 'OU') { const t = g[0] + g[1]; return o.side === 'over' ? split(t, -o.line, price) : split(-t, o.line, price); }
  if (o.mk === 'AH') { const d = (g[0] - s0[0]) - (g[1] - s0[1]); return split(o.side === 'home' ? d : -d, o.line, price); }
  return null;
}
const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(1)}%`;
const units = x => `${x >= 0 ? '+' : ''}${x.toFixed(2)}u`;

function load(dir) {
  const rows = [], fin = new Map(), noRes = new Map(), alerts = [];
  let scans = 0, first = null, last = null;
  if (!fs.existsSync(dir)) return null;
  for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort()) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.hb) { scans++; first = first ?? o.hb.t; last = o.hb.t; }
      else if (o.alert) alerts.push(o.alert);
      else if (o.res !== undefined) {
        // score: what to settle on — the 90' score when it went to extra time.
        fin.set(o.id, { score: o.et ? o.reg : o.res, ft: o.res, et: !!o.et });
        noRes.delete(o.id);
      }
      else if (o.nores) { if (!fin.has(o.id)) noRes.set(o.id, o.status || '?'); }
      else if (o.fin !== undefined || o.gone !== undefined) continue; // left the live list — not a result
      else rows.push(o);
    }
  }
  return { rows, fin, noRes, alerts, scans, first, last };
}

// Alerts from before they were logged: the first row per match+market+line
// that passes the alert gates (edge, price range, Pinnacle age, minute, 2nd
// scan in a row, quiet ≥ 3 min at the same score), at most one per 30 min.
function reconstructAlerts(rows, g) {
  const byKey = new Map(), byMatch = new Map();
  for (const o of rows) {
    const k = `${o.id}|${o.k}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(o);
    if (!byMatch.has(o.id)) byMatch.set(o.id, []); byMatch.get(o.id).push(o);
  }
  for (const l of byMatch.values()) l.sort((a, b) => a.t - b.t);
  const out = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => a.t - b.t);
    let lastAlert = -Infinity;
    for (let i = 1; i < list.length; i++) {
      const o = list[i], prev = list[i - 1];
      if (!(o.e >= g.minEdge && o.e < g.maxEdge && o.p >= g.minOdds && o.p <= g.maxOdds && o.pa <= g.maxPinAge && (o.min == null || o.min <= g.maxMinute))) continue;
      if (!(prev.e >= g.minEdge && o.t - prev.t <= 150000 && prev.sc === o.sc)) continue;
      const m = byMatch.get(o.id);
      const sameScoreSince = m.filter(x => x.t <= o.t).reverse().find(x => x.sc !== o.sc);
      const since = sameScoreSince ? sameScoreSince.t : m[0].t;
      if (o.t - since < g.quietMin * 60000) continue;
      if (o.t - lastAlert < 30 * 60000) continue;
      lastAlert = o.t;
      out.push({ ...o, mo: +(o.f * (1 + g.minEdge / 100)).toFixed(3), reconstructed: true });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

function buildReport(dir, opts = {}) {
  const MIN = opts.min ?? 5;
  const g = { minEdge: MIN, maxEdge: opts.maxEdge ?? 15, minOdds: opts.minOdds ?? 1.7, maxOdds: opts.maxOdds ?? 2.5, maxPinAge: opts.maxPinAge ?? 60, maxMinute: opts.maxMinute ?? 85, quietMin: opts.quietMin ?? 3 };
  const tz = opts.tz || 'Europe/Rome';
  const d = load(dir);
  if (!d) return `No recorder data yet (${dir}). It needs the Railway volume mounted at /app/data, and alerts recorded since the last redeploy.`;
  const { rows, fin, noRes, scans } = d;
  // Score to settle on, or null; and the alert's result status.
  const finalOf = id => fin.get(id)?.score ?? null;
  const statusOf = id => {
    const f = fin.get(id);
    if (f) return f.score != null ? null : `no result found — went to extra time (FT ${f.ft} after extra time), 90' score not seen`;
    if (noRes.has(id)) return `no result found — match page still says ${noRes.get(id)} 6 h after the alert`;
    return 'waiting for FT — result not confirmed on the match page yet';
  };
  const out = [];
  const when = t => new Date(t).toLocaleString('it-IT', { timeZone: tz, day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  out.push(`LIVEGAP report · ${scans} scans recorded${d.first ? ` from ${when(d.first)} to ${when(d.last)}` : ''} · ${fin.size} matches with a confirmed FT score`);

  // ── 1. Alerts sent ──
  const logged = d.alerts.map(a => ({ ...a }));
  const loggedKeys = new Set(logged.map(a => `${a.id}|${a.k}`));
  const firstLogged = logged.length ? Math.min(...logged.map(a => a.t)) : Infinity;
  const rebuilt = reconstructAlerts(rows, g).filter(a => a.t < firstLogged && !loggedKeys.has(`${a.id}|${a.k}`));
  const all = [...rebuilt, ...logged].sort((a, b) => a.t - b.t);
  out.push('', `ALERTS SENT: ${all.length}${rebuilt.length ? ` (${rebuilt.length} reconstructed from the recordings — sent before alerts were logged)` : ''}`);
  let n = 0, plShown = 0, plMin = 0, waiting = 0, noResult = 0;
  const tally = { WON: 0, 'HALF WON': 0, VOID: 0, 'HALF LOST': 0, LOST: 0 };
  for (const a of all) {
    const final = finalOf(a.id);
    const pShown = final != null ? payout(a, final, a.p) : null;
    const pMin = final != null ? payout(a, final, a.mo) : null;
    let res = statusOf(a.id);
    if (pShown != null) {
      n++; plShown += pShown - 1; plMin += pMin - 1;
      const outcome = pShown > 1.001 ? (pShown < a.p - 1e-9 ? 'HALF WON' : 'WON') : pShown < 0.999 ? (pShown > 1e-9 ? 'HALF LOST' : 'LOST') : 'VOID';
      tally[outcome]++;
      const f = fin.get(a.id);
      res = `${outcome} · settled (confirmed FT ${final}${f.et ? ` at 90', ${f.ft} after extra time` : ''}) ${units(pShown - 1)} @${a.p} · ${units(pMin - 1)} @${(+a.mo).toFixed(2)}`;
    } else if (/^waiting/.test(res)) waiting++; else noResult++;
    out.push(`  ${when(a.t)}  ${a.m} · ${a.min ?? '?'}' ${a.sc} · ${a.k.split('|')[1]} · Bet365 ${a.p} (min ${(+a.mo).toFixed(2)}, edge +${a.e}%)${a.reconstructed ? ' [reconstructed]' : ''}\n      → ${res}`);
  }
  if (n) {
    out.push('', `  Settled ${n} (confirmed FT): ${Object.entries(tally).filter(([, c]) => c).map(([k, c]) => `${c} ${k.toLowerCase()}`).join(', ')} · waiting for FT ${waiting} · no result found ${noResult}`,
      `  At the Bet365 price shown:  ${units(plShown)} on ${n} units staked → ROI ${pct(plShown / n)}`,
      `  At the minimum odds:        ${units(plMin)} on ${n} units staked → ROI ${pct(plMin / n)}`,
      `  (1 unit per bet; an alert's actual stake was ⅛ Kelly. ${n < 100 ? `${n} bets is far too few to judge — luck dominates below a few hundred.` : ''})`);
  } else if (all.length) out.push('', `  None settled yet (waiting for FT ${waiting} · no result found ${noResult}).`);

  // ── 2. All recorded gaps ──
  const byKey = new Map();
  for (const o of rows) { const k = `${o.id}|${o.k}`; if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(o); }
  for (const l of byKey.values()) l.sort((a, b) => a.t - b.t);
  const line = (label, pickEntry, band = null) => {
    let k = 0, settled = 0, pl = 0, byB = 0, byR = 0, still = 0;
    for (const list of byKey.values()) {
      const e = pickEntry(list); if (!e) continue;
      if (band && !(e.p >= band[0] && e.p < band[1])) continue;
      k++;
      const last = list.filter(o => o.t > e.t && o.t - e.t <= 15 * 60000 && o.sc === e.sc).pop();
      if (last) {
        const bk = Math.log(e.p / last.p), rf = Math.log(last.f / e.f);
        if (last.e >= MIN) still++; else if (bk + rf > 0) (bk >= rf ? byB++ : byR++);
      }
      const final = finalOf(e.id);
      const pay = final != null ? payout(e, final, e.p) : null;
      if (pay != null) { settled++; pl += pay - 1; }
    }
    out.push(`${label.padEnd(34)} ${String(k).padStart(5)} gaps · closed by Bet365 ${byB} · by Pinnacle ${byR} · still open ${still} · settled ${settled}${settled ? ` · ROI ${pct(pl / settled)}` : ''}`);
  };
  const atAlert = l => l.find((o, i) => o.e >= MIN && i > 0 && l[i - 1].e >= MIN && o.t - l[i - 1].t <= 150000 && l[i - 1].sc === o.sc);
  out.push('', `ALL RECORDED GAPS ≥ ${MIN}% (any price, before the alert's other gates):`);
  line('first scan at threshold', l => l.find(o => o.e >= MIN));
  line('2nd scan in a row (alert timing)', atAlert);
  out.push('By Bet365 price (alert timing):');
  for (const band of [[1, 1.5], [1.5, 1.7], [1.7, 2.1], [2.1, 2.5], [2.5, 4], [4, 1e9]]) line(`  ${band[0]}–${band[1] > 100 ? '+' : band[1]}`, atAlert, band);
  out.push('', '"Closed by Bet365" = Bet365 came down to Pinnacle (the price was good); "by Pinnacle" = Pinnacle moved up (the gap was lag).');
  return out.join('\n');
}

module.exports = { buildReport, reconstructAlerts, payout };

if (require.main === module) {
  const arg = (n, dflt) => { const i = process.argv.indexOf(n); return i > 0 ? process.argv[i + 1] : dflt; };
  console.log(buildReport(path.resolve(__dirname, arg('--dir', 'data/livegap')), { min: parseFloat(arg('--min', '5')) }));
}
