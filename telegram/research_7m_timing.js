'use strict';
/**
 * How long do pre-match price gaps stay bettable? (added 2026-10-11)
 *
 *   node research_7m_timing.js --from 2026-10-01 --to 2026-10-09 [--cache dir] [--fetch-only] [--min 3,5]
 *
 * The backtests behind PRICEGAP / PINNGAP / OPENWATCH only had an opening and a
 * closing price per match, so "how long does a gap last, and does it still pay
 * if you are a minute / an hour late?" was never measured. 7msport keeps every
 * Bet365, Sbobet and Pinnacle price change per match with a timestamp to the
 * second (see check7m.js / CLAUDE.md), so the whole pre-match timeline can be
 * replayed.
 *
 * Fetch: 7msport's results list per GMT+8 day → each match's book list (info
 *   file) → for matches with Bet365 + Sbobet or Pinnacle, the AH and goal-line
 *   histories; only the three books' pre-match rows are kept, compacted, one
 *   gzipped file per day (the raw files are ~140 KB each).
 * Replay, per match, market (AH / goal line) and reference book (Sbobet, Pinnacle):
 *   at every price change, Bet365's price on each side vs the reference's
 *   price on the SAME line with the margin removed (proportional, two-way —
 *   as pricegap.js / pinngap.js). A gap opens when the edge reaches the
 *   threshold and lasts until it falls below it, either line moves, or kick-off.
 *   Per gap: hours before kick-off, how long it lasted, who closed it (Bet365's
 *   price came down vs the reference's fair moved up), ROI at the opening price
 *   (settled on the FT score, quarter lines split) and closing-line value vs
 *   the reference's last fair price; then the same bet placed 1 / 5 / 15 / 60
 *   min later — share still ≥ the threshold and ROI at the price then.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { payout } = require('./livegap_report');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const CACHE = opt('--cache', path.join(__dirname, 'data', '7m_timing'));
const FROM = opt('--from'), TO = opt('--to');
const MINS = opt('--min', '3,5').split(',').map(Number);
fs.mkdirSync(CACHE, { recursive: true });
const UA = { headers: { 'User-Agent': 'Mozilla/5.0' } };
const BOOK = { b365: '2', sbo: '16', pin: '23' };
// --all-books (added 2026-10-17): keep every bookmaker 7msport lists, as `c<id>` (Bet365 /
// Sbobet / Pinnacle keep their names), so other soft books can be tested as the target with
// --targets <id,id,…> — e.g. 7 William Hill, 8 1xbet, 5 Bwin, 10 Interwetten, 22 Ladbrokes.
const ALL_BOOKS = args.includes('--all-books');
const keyOf = cid => (Object.entries(BOOK).find(([, v]) => v === String(cid)) || [`c${cid}`])[0];
const NAMES = { 2: 'Bet365', 3: 'Crown', 4: 'Macau', 5: 'Bwin', 7: 'William Hill', 8: '1xbet', 9: 'Betfair', 10: 'Interwetten', 12: 'Victor Chandler', 14: '10BET', 15: '188BET', 16: 'Sbobet', 17: 'Mansion88', 18: 'YSB88', 19: '12BET', 20: 'wewbet', 22: 'Ladbrokes', 23: 'Pinnacle' };
const TARGETS = opt('--targets', '2').split(',').map(x => x.trim()).filter(Boolean);
let TARGET = keyOf(TARGETS[0]);

async function getText(url) {
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { ...UA, signal: AbortSignal.timeout(25000) });
      if (r.status === 404) return '';
      if (r.ok) return await r.text();
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) { const x = items[i++]; await fn(x); } })); }
const days = (a, b) => { const out = []; for (let t = Date.parse(a + 'T00:00:00Z'); t <= Date.parse(b + 'T00:00:00Z'); t += 86400e3) out.push(new Date(t).toISOString().slice(0, 10)); return out; };

// ── fetch one GMT+8 day ──
async function fetchDay(day) {
  const file = path.join(CACHE, `day_${day}.json.gz`);
  if (fs.existsSync(file)) return;
  const txt = await getText(`https://data.7msport.com/result/${day}/index_en.js`);
  if (!txt) { console.error(`${day}: no results list`); return; }
  const arr = n => { const m = txt.match(new RegExp(`var ${n}\\s*=\\s*(\\[[\\s\\S]*?\\]);`)); try { return m ? Function(`return ${m[1]}`)() : []; } catch { return []; } };
  const ids = arr('live_bh_Arr'), st = arr('Start_time_Arr'), A = arr('Team_A_Arr'), B = arr('Team_B_Arr'), ga = arr('live_a_Arr'), gb = arr('live_b_Arr'), lg = arr('Match_name_Arr');
  const out = [];
  let withBooks = 0;
  await pool(ids.map((id, i) => i), 6, async i => {
    const id = ids[i], p = String(st[i] || '').split(',').map(Number);
    if (p.length < 5 || ga[i] == null) return;
    const ko = Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4]) - 8 * 3600e3;
    const info = await getText(`https://static-data-expansion.7mdt.com/football/luck/info/sdt/${id}.json`);
    let inf; try { inf = JSON.parse(info); } catch { return; }
    const m = { id, ko, ft: `${ga[i]}-${gb[i]}`, lg: lg[i], h: A[i], a: B[i] };
    let any = false;
    for (const [ty, k] of [[2, 'ah'], [3, 'ou']]) {
      const c = inf[ty] || {};
      if (!(c[BOOK.sbo] || c[BOOK.pin]) || !(ALL_BOOKS || c[BOOK.b365])) continue;
      const h = await getText(`https://static-data-expansion.7mdt.com/football/luck/type/${ty}/sdt/${id}.json`);
      let d; try { d = JSON.parse(h); } catch { continue; }
      m[k] = {};
      const books = ALL_BOOKS ? Object.keys(d).map(cid => [keyOf(cid), cid]) : Object.entries(BOOK);
      for (const [name, cid] of books) {
        const rows = (d[cid]?.data || []).filter(r => !r.time && r.updateTime * 1000 < ko && r.p_1 > 1 && r.p_3 > 1)
          .map(r => [r.updateTime, r.p_1, r.p_2, r.p_3, r.is_lock ? 1 : 0]).sort((x, y) => x[0] - y[0]);
        if (rows.length) m[k][name] = rows;
      }
      if (ALL_BOOKS ? Object.keys(m[k]).length >= 2 : m[k].b365) any = true;
    }
    if (any) { out.push(m); withBooks++; }
  });
  fs.writeFileSync(file, zlib.gzipSync(JSON.stringify(out)));
  console.error(`${day}: ${ids.length} matches listed · ${withBooks} with Bet365 + Sbobet/Pinnacle history kept`);
}

// ── replay ──
const stateAt = (rows, t) => { let lo = 0, hi = rows.length; while (lo < hi) { const m = (lo + hi) >> 1; if (rows[m][0] <= t) lo = m + 1; else hi = m; } return lo ? rows[lo - 1] : null; };
// [price, line] per side; AH line = the side's own handicap.
const sideOf = (mk, side, r) => mk === 'AH' ? (side === 'home' ? [r[1], r[2]] : [r[3], -r[2]]) : (side === 'over' ? [r[1], r[2]] : [r[3], r[2]]);
const fairOf = (mk, side, r) => { const a = 1 / r[1], b = 1 / r[3], s = a + b; const first = side === 'home' || side === 'over'; return s / (first ? a : b); };
function edgeAt(mk, side, b, ref) {
  if (!b || !ref || b[4] || ref[4] || Math.abs(b[2] - ref[2]) > 1e-6) return null;
  const [price, line] = sideOf(mk, side, b);
  const fair = fairOf(mk, side, ref);
  return { price, line, fair, edge: price / fair - 1 };
}

function replay(matches, X) {
  const gaps = [];
  for (const m of matches) for (const [k, mk, sides] of [['ah', 'AH', ['home', 'away']], ['ou', 'OU', ['over', 'under']]]) {
    const bk = m[k]; if (!bk?.[TARGET]) continue;
    for (const refName of ['sbo', 'pin']) {
      const ref = bk[refName]; if (!ref) continue;
      const times = [...new Set([...bk[TARGET].map(r => r[0]), ...ref.map(r => r[0])])].sort((x, y) => x - y)
        .filter(t => t >= Math.max(bk[TARGET][0][0], ref[0][0]));
      const koS = m.ko / 1000;
      const refClose = ref[ref.length - 1];
      for (const side of sides) {
        let open = null, n = 0;
        const close = (t, cause) => {
          gaps.push({ ...open, end: t, dur: t - open.t, cause, n: n++ });
          open = null;
        };
        for (const t of times) {
          const b = stateAt(bk[TARGET], t), r = stateAt(ref, t), e = edgeAt(mk, side, b, r);
          if (open) {
            if (e && e.edge * 100 >= X) continue;
            let cause;
            if (!b || Math.abs(b[2] - open.b[2]) > 1e-6) cause = 'Bet365 line';
            else if (!r || Math.abs(r[2] - open.r[2]) > 1e-6) cause = 'ref line';
            else if (b[4] || r[4]) cause = 'suspended';
            else { const bk2 = Math.log(open.price / sideOf(mk, side, b)[0]), rf = Math.log(fairOf(mk, side, r) / open.fair); cause = bk2 >= rf ? 'Bet365 came down' : 'ref moved up'; }
            close(t, cause);
          } else if (e && e.edge * 100 >= X && e.edge < 0.25) {
            open = { m, mk, side, ref: refName, t, hrs: (koS - t) / 3600, price: e.price, line: e.line, fair: e.fair, edge: e.edge, b, r,
              clv: Math.abs(refClose[2] - r[2]) < 1e-6 ? e.price / fairOf(mk, side, refClose) - 1 : null };
          }
        }
        if (open) close(koS, 'kick-off');
      }
    }
  }
  return gaps;
}
// The bet placed d seconds after the gap opened: Bet365's price then, if still ≥ X.
function late(g, d, X) {
  const bk = g.m[g.mk === 'AH' ? 'ah' : 'ou'], t = g.t + d;
  if (t >= g.m.ko / 1000) return { gone: true, why: 'kick-off' };
  const e = edgeAt(g.mk, g.side, stateAt(bk[TARGET], t), stateAt(bk[g.ref], t));
  if (!e || Math.abs(e.line - g.line) > 1e-6) return { gone: true };
  return e.edge * 100 >= X ? { price: e.price } : { gone: true };
}
const ret = (g, price) => payout({ mk: g.mk, side: g.side, line: g.line, sc: '0-0' }, g.m.ft, price);

function report(matches) {
  const pct = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  const roiOf = L => { const s = L.map(x => x.r).filter(v => v != null); return s.length ? `${pct(s.reduce((a, b) => a + b - 1, 0) / s.length)} (${s.length})` : '-'; };
  const q = (L, p) => { const s = L.slice().sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : null; };
  const fmtDur = s => s == null ? '-' : s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
  const out = [`PRE-MATCH GAP TIMING — ${matches.length} matches (Bet365 + Sbobet/Pinnacle history on 7msport), ${new Date(Math.min(...matches.map(m => m.ko))).toISOString().slice(0, 10)} → ${new Date(Math.max(...matches.map(m => m.ko))).toISOString().slice(0, 10)}`, ''];
  for (const X of MINS) {
    const gaps = replay(matches, X);
    for (const ref of ['sbo', 'pin']) {
      const G = gaps.filter(g => g.ref === ref);
      if (!G.length) continue;
      // first gap per match+market+side (one bet each), as the strategies would alert
      const firsts = G.filter(g => g.n === 0).map(g => ({ ...g, r: ret(g, g.price) }));
      out.push(`── ${NAMES[TARGETS.find(t => keyOf(t) === TARGET)] || TARGET} ≥ ${X}% above ${ref === 'sbo' ? 'Sbobet' : 'Pinnacle'}'s fair, same line ── ${G.length} gaps · ${firsts.length} first per match+side`);
      const durs = G.filter(g => g.cause !== 'kick-off').map(g => g.dur);
      out.push(`  how long: median ${fmtDur(q(durs, 0.5))} · 25% under ${fmtDur(q(durs, 0.25))} · 75% under ${fmtDur(q(durs, 0.75))} · open at kick-off ${G.filter(g => g.cause === 'kick-off').length}`);
      const causes = {}; for (const g of G) causes[g.cause] = (causes[g.cause] || 0) + 1;
      out.push(`  closed by: ${Object.entries(causes).sort((a, b) => b[1] - a[1]).map(([c, n]) => `${c} ${(n / G.length * 100).toFixed(0)}%`).join(' · ')}`);
      const clv = firsts.filter(g => g.clv != null);
      out.push(`  first gap per side, bet at once: ROI ${roiOf(firsts)} · CLV vs the reference's last fair ${clv.length ? pct(clv.reduce((a, g) => a + g.clv, 0) / clv.length) : '-'} (${clv.length})`);
      for (const d of [60, 300, 900, 3600]) {
        const L = firsts.map(g => { const l = late(g, d, X); return l.gone ? null : { ...g, r: ret(g, l.price) }; });
        const still = L.filter(Boolean);
        out.push(`    placed ${String(d / 60).padStart(2)} min later: still ≥ ${X}% ${(still.length / firsts.length * 100).toFixed(0)}% · ROI ${roiOf(still)}`);
      }
      out.push('  by hours before kick-off (first gap per side):');
      for (const [lo, hi] of [[0, 1], [1, 3], [3, 12], [12, 24], [24, 72], [72, 1e9]]) {
        const L = firsts.filter(g => g.hrs >= lo && g.hrs < hi); if (!L.length) continue;
        const d = L.filter(g => g.cause !== 'kick-off').map(g => g.dur);
        const st5 = L.filter(g => !late(g, 300, X).gone).length;
        out.push(`    ${`${lo}–${hi > 1e8 ? '+' : hi} h`.padEnd(8)} ${String(L.length).padStart(5)} · median life ${fmtDur(q(d, 0.5)).padStart(7)} · still there after 5 min ${(st5 / L.length * 100).toFixed(0).padStart(3)}% · ROI ${roiOf(L)}`);
      }
      // Month by month (kick-off month), and by how often 7msport recorded Bet365 moving on
      // that market (few changes = thinly followed league, where gap lifetimes are least reliable).
      const byMonth = new Map();
      for (const g of firsts) { const k = new Date(g.m.ko).toISOString().slice(0, 7); if (!byMonth.has(k)) byMonth.set(k, []); byMonth.get(k).push(g); }
      const months = [...byMonth.entries()].sort();
      const pos = months.filter(([, L]) => L.reduce((a, g) => a + (g.r ?? 1) - 1, 0) > 0).length;
      out.push(`  by month: ${pos}/${months.length} positive · ${months.map(([k, L]) => `${k.slice(2)} ${roiOf(L)}`).join(' · ')}`);
      const nCh = g => g.m[g.mk === 'AH' ? 'ah' : 'ou'][TARGET].length;
      out.push(`  by Bet365 changes recorded: <8 ${roiOf(firsts.filter(g => nCh(g) < 8))} · 8–20 ${roiOf(firsts.filter(g => nCh(g) >= 8 && nCh(g) <= 20))} · >20 ${roiOf(firsts.filter(g => nCh(g) > 20))}`);
      out.push('  by market:');
      for (const mk of ['AH', 'OU']) { const L = firsts.filter(g => g.mk === mk); if (L.length) out.push(`    ${mk.padEnd(3)} ${String(L.length).padStart(5)} · ROI ${roiOf(L)}`); }
      out.push('');
    }
  }
  out.push('ROI = 1 unit at Bet365\'s price when the gap opened, settled on the FT score (quarter lines split). "placed N min later" = the same side at Bet365\'s price N minutes on, counted only if still ≥ the threshold then.',
    'CLV = Bet365\'s price at the gap vs the reference book\'s last pre-match fair on the same line (+ = beat the close).');
  return out.join('\n');
}

(async () => {
  if (!FROM || !TO) { console.log('usage: node research_7m_timing.js --from YYYY-MM-DD --to YYYY-MM-DD [--cache dir] [--fetch-only] [--min 3,5]'); return; }
  for (const d of days(FROM, TO)) await fetchDay(d);
  if (args.includes('--fetch-only')) return;
  const matches = days(FROM, TO).flatMap(d => { const f = path.join(CACHE, `day_${d}.json.gz`); return fs.existsSync(f) ? JSON.parse(zlib.gunzipSync(fs.readFileSync(f))) : []; });
  for (const t of TARGETS) {
    TARGET = keyOf(t);
    const withBook = matches.filter(m => m.ah?.[TARGET] || m.ou?.[TARGET]);
    if (!withBook.length) { console.log(`${NAMES[t] || t}: no matches with its prices\n`); continue; }
    console.log(report(withBook) + '\n');
  }
})();
