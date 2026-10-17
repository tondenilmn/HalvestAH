'use strict';
/**
 * Pre-match trading on Betfair Exchange 1X2 toward the sharp books (research,
 * added 2026-10-17, user question: "scalp pre-match with the Pinnacle-predicted
 * movement").
 *
 * The idea: when Sbobet's (or Pinnacle's) 1X2, de-vigged, says a side is worth
 * more than Betfair's back price, back it on Betfair now and lay it later, once
 * Betfair has moved toward the sharp price — a profit whatever the result. The
 * reverse when Betfair is too short: lay now, back later.
 *
 * Data:
 *   - Betfair best back price per side, one point a minute from up to ~36 h
 *     before kick-off (oddsmonitor.eu chart histories: the bot's
 *     GET /data/oddsmonitor/<day> day files, or single <slug>.json.gz files);
 *   - Sbobet ('16') and Pinnacle ('23') 1X2 price changes with timestamps from
 *     7msport (static-data-expansion.7mdt.com/football/luck/type/1/sdt/<id>.json),
 *     the match found by name + kick-off in 7msport's results / fixtures lists.
 *
 * Simulation, per match + side + direction, first minute the gap reaches X%
 * with kick-off ≥ 30 min away: enter at Betfair's price, exit 15 min / 60 min
 * later or 2 min before kick-off (whichever comes first). There is no lay price
 * in the histories, so the other side of the book is taken as ONE TICK away
 * from the back price (a liquid market; thin markets are wider, so the numbers
 * for small matched amounts are optimistic). Green = entry / exit − 1 on the
 * stake, minus 4.5% commission when positive. Control = the same trade entered
 * at every eligible minute with no signal (what the spread costs).
 *
 *   node research_bf_scalp.js --bf <dir> [--cache dir] [--min 2,3,5] [--ref sbo|pin|both]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const FM = require('./fair_model.js');
const S7 = require('./sevenm');
const { dice } = require('./livegap');
const { kindOf } = require('./pinngap');

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const BF_DIR = opt('--bf');
const CACHE = opt('--cache', path.join(__dirname, 'data', 'bf_scalp_cache'));
const MINS = opt('--min', '2,3,5').split(',').map(Number);
const COMM = 0.045;
if (!BF_DIR) { console.log('usage: node research_bf_scalp.js --bf <dir> [--cache dir] [--min 2,3,5]'); process.exit(1); }
fs.mkdirSync(CACHE, { recursive: true });

const UA = { headers: { 'User-Agent': 'Mozilla/5.0' } };
const getText = async (u, ms = 20000) => { const r = await fetch(u, { ...UA, signal: AbortSignal.timeout(ms) }); if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); };
const utc = s => Date.parse(String(s).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? '' : 'Z'));

// ── Betfair ticks ──
const BANDS = [[2, 0.01], [3, 0.02], [4, 0.05], [6, 0.1], [10, 0.2], [20, 0.5], [30, 1], [50, 2], [100, 5], [1000, 10]];
const tickUp = p => { for (const [hi, s] of BANDS) if (p < hi - 1e-9) return +(p + s).toFixed(2); return p; };

// ── load Betfair histories ──
function loadBf(dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const fp = path.join(dir, f);
    if (!/\.gz$/.test(f)) continue;
    const txt = zlib.gunzipSync(fs.readFileSync(fp)).toString('utf8');
    for (const line of txt.split('\n')) { if (!line.trim()) continue; try { out.push(JSON.parse(line)); } catch { /* skip */ } }
  }
  const seen = new Set();
  return out.filter(r => r && r.slug && !seen.has(r.slug) && seen.add(r.slug)).map(r => {
    const ko = r.markers?.find(m => m.type === 'KickOff');
    const koMs = ko ? utc(ko.at) : r.ko ? Date.parse(r.ko) : null;
    const t0 = utc(r.t0);
    const [h, a] = String(r.name || '').split(/\s+v\s+/);
    return { ...r, koMs, t0ms: t0, home: h, away: a };
  }).filter(r => r.koMs && r.home && r.away);
}

// ── 7msport ids by name + kick-off ──
async function sevenIndex(days) {
  const idx = [];
  for (const d of days) {
    const f = path.join(CACHE, `res_${d}.json`);
    let list = null;
    if (fs.existsSync(f)) list = JSON.parse(fs.readFileSync(f, 'utf8'));
    else {
      try { list = S7.parseFixtures(await getText(`https://data.7msport.com/result/${d}/index_en.js`)); fs.writeFileSync(f, JSON.stringify(list)); }
      catch { list = []; }
    }
    idx.push(...list);
  }
  try { idx.push(...await S7.refreshIndex(Date.now(), true)); } catch { /* fixtures/live pages: today's matches */ }
  const byId = new Map();
  for (const e of idx) if (!byId.has(e.id) || (byId.get(e.id).ko == null && e.ko != null)) byId.set(e.id, { ...e, home: e.home || S7.norm(e.rawH), away: e.away || S7.norm(e.rawA), kind: e.kind || [kindOf(e.rawH, ''), kindOf(e.rawA, '')] });
  return [...byId.values()];
}
function findSeven(idx, m) {
  const h = S7.norm(m.home), a = S7.norm(m.away), kh = kindOf(m.home, m.comp), ka = kindOf(m.away, m.comp);
  let best = null;
  for (const e of idx) {
    if (e.ko != null && Math.abs(e.ko - m.koMs) > 45 * 60000) continue;
    if (e.kind[0] !== kh || e.kind[1] !== ka) continue;
    const sh = dice(h, e.home), sa = dice(a, e.away);
    if (Math.min(sh, sa) < 0.4) continue;
    const s = (sh + sa) / 2 - (e.ko == null ? 0.05 : 0);
    if (!best || s > best.s) best = { e, s };
  }
  return best && best.s >= (best.e.ko == null ? 0.75 : 0.65) ? best.e : null;
}
async function refRows(id) {
  const f = path.join(CACHE, `x12_${id}.json`);
  let j;
  if (fs.existsSync(f)) j = JSON.parse(fs.readFileSync(f, 'utf8'));
  else { j = JSON.parse(await getText(`https://static-data-expansion.7mdt.com/football/luck/type/1/sdt/${id}.json`)); fs.writeFileSync(f, JSON.stringify(j)); }
  const rows = c => (j[c]?.data || []).filter(r => !r.time && r.p_1 > 1 && r.p_2 > 1 && r.p_3 > 1)
    .map(r => ({ t: r.updateTime * 1000, fair: FM.devigPower([+r.p_1, +r.p_2, +r.p_3])?.fair })).filter(r => r.fair).sort((a, b) => a.t - b.t);
  return { sbo: rows('16'), pin: rows('23') };
}

// ── simulation ──
const SIDES = ['home', 'draw', 'away'];
function points(m) {
  const P = [];
  for (let i = 0; i < m.t.length; i++) {
    const at = m.t0ms + m.t[i] * 1000;
    if (at > m.koMs - 2 * 60000) break;
    const b = SIDES.map(s => m.odds[s][i]);
    if (b.some(x => !(x > 1))) continue;
    const book = b.reduce((s, x) => s + 1 / x, 0);
    if (book < 0.97 || book > 1.15) continue; // suspended / broken snapshot
    P.push({ at, b });
  }
  return P;
}
const priceAt = (P, at) => { let r = null; for (const p of P) { if (p.at <= at) r = p; else break; } return r; };
const green = (entry, exit) => { const g = entry / exit - 1; return g > 0 ? g * (1 - COMM) : g; };
const H = [['15 min', 15], ['60 min', 60], ['KO−2', 1e9]];

function simulate(m, refs, X) {
  const P = points(m), out = [];
  if (P.length < 10) return out;
  const done = new Set();
  let ri = 0;
  for (const p of P) {
    if (m.koMs - p.at < 30 * 60000) break;
    while (ri + 1 < refs.length && refs[ri + 1].t <= p.at) ri++;
    const ref = refs[ri];
    if (!ref || ref.t > p.at) continue;
    for (let s = 0; s < 3; s++) {
      const back = p.b[s], lay = tickUp(back), fair = ref.fair[s];
      for (const [dir, edge] of [['back', back / fair - 1], ['lay', fair / lay - 1]]) {
        if (edge * 100 < X || edge > 0.5 || done.has(`${s}|${dir}`)) continue;
        done.add(`${s}|${dir}`);
        const tr = { side: SIDES[s], dir, edge, price: dir === 'back' ? back : lay, hrs: (m.koMs - p.at) / 3600e3, matched: m.matched, g: {} };
        for (const [lab, mins] of H) {
          const x = priceAt(P, Math.min(p.at + mins * 60000, m.koMs - 2 * 60000));
          if (!x) continue;
          const xb = x.b[s], xl = tickUp(xb);
          tr.g[lab] = dir === 'back' ? green(back, xl) : green(lay, xb);
        }
        // Did Betfair move toward the sharp price by KO? (mid-price move, no spread)
        const last = P[P.length - 1].b[s];
        tr.toward = dir === 'back' ? last < back : last > back;
        out.push(tr);
      }
    }
  }
  return out;
}
function control(m) {
  const P = points(m), out = [];
  for (const p of P) {
    if (m.koMs - p.at < 30 * 60000) break;
    for (let s = 0; s < 3; s++) {
      const x = priceAt(P, Math.min(p.at + 60 * 60000, m.koMs - 2 * 60000));
      if (x) out.push(green(p.b[s], tickUp(x.b[s])));
    }
  }
  return out;
}

const pct = x => `${x >= 0 ? '+' : ''}${(x * 100).toFixed(2)}%`;
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const se = a => Math.sqrt(a.reduce((s, x) => s + (x - mean(a)) ** 2, 0) / Math.max(1, a.length - 1) / a.length);
function line(label, trades) {
  if (!trades.length) return `  ${label.padEnd(26)}     0`;
  const cols = H.map(([lab]) => { const v = trades.map(t => t.g[lab]).filter(v => v != null); return v.length ? `${lab} ${pct(mean(v)).padStart(7)} ±${(se(v) * 100).toFixed(2)} (${Math.round(v.filter(x => x > 0).length / v.length * 100)}% up)` : ''; });
  return `  ${label.padEnd(26)} ${String(trades.length).padStart(5)} · ${cols.join(' · ')} · moved toward by KO ${Math.round(trades.filter(t => t.toward).length / trades.length * 100)}%`;
}

(async () => {
  const bf = loadBf(BF_DIR);
  const days = new Set();
  for (const m of bf) for (const d of [0, 1]) days.add(new Date(m.koMs + 8 * 3600e3 - d * 86400e3).toISOString().slice(0, 10));
  const idx = await sevenIndex([...days].sort());
  const paired = [];
  for (const m of bf) {
    const e = findSeven(idx, m);
    if (!e) continue;
    try { const r = await refRows(e.id); if (r.sbo.length || r.pin.length) paired.push({ m, r }); } catch { /* skip */ }
  }
  const hrsAvail = bf.map(m => (m.koMs - m.t0ms) / 3600e3);
  console.log(`BETFAIR PRE-MATCH TRADING TOWARD THE SHARP BOOKS — ${bf.length} Betfair histories (median ${hrsAvail.sort((a, b) => a - b)[hrsAvail.length >> 1]?.toFixed(1)} h before KO), ${paired.length} paired with 7msport (${paired.filter(p => p.r.sbo.length).length} with Sbobet 1X2, ${paired.filter(p => p.r.pin.length).length} with Pinnacle 1X2)`);
  const ctl = paired.flatMap(p => control(p.m));
  console.log(`\nCONTROL — no signal, every minute, back then lay 60 min later (the spread's cost): ${ctl.length ? pct(mean(ctl)) : '—'} (${ctl.length} trades)`);
  for (const [refKey, refName] of [['sbo', 'Sbobet'], ['pin', 'Pinnacle']]) {
    for (const X of MINS) {
      const T = paired.filter(p => p.r[refKey].length).flatMap(p => simulate(p.m, p.r[refKey], X).map(t => ({ ...t, comp: p.m.comp })));
      console.log(`\n── Betfair ≥ ${X}% off ${refName}'s de-vigged 1X2 (power) ── ${T.length} trades on ${new Set(T.map(t => t.comp)).size} competitions · green after 4.5% commission when positive, ± 1 s.e.`);
      console.log(line('all', T));
      console.log(line('back first (Betfair long)', T.filter(t => t.dir === 'back')));
      console.log(line('lay first (Betfair short)', T.filter(t => t.dir === 'lay')));
      for (const [lab, lo, hi] of [['≥ 6 h before KO', 6, 1e9], ['1–6 h', 1, 6], ['30 min–1 h', 0, 1]]) console.log(line(lab, T.filter(t => t.hrs >= lo && t.hrs < hi)));
      for (const [lab, lo, hi] of [['matched < 10k', 0, 1e4], ['matched 10k–100k', 1e4, 1e5], ['matched ≥ 100k', 1e5, 1e12]]) console.log(line(lab, T.filter(t => t.matched >= lo && t.matched < hi)));
      for (const sd of SIDES) console.log(line(sd, T.filter(t => t.side === sd)));
      for (const [lab, lo, hi] of [['price < 2.5', 0, 2.5], ['2.5–5', 2.5, 5], ['≥ 5', 5, 1e9]]) console.log(line(lab, T.filter(t => t.price >= lo && t.price < hi)));
    }
  }
  console.log('\nLay price assumed one tick above the back price (no lay in the histories): optimistic on thin markets. Exit = the price at that moment, no queueing. Matched = total matched on the market by the end.');
})().catch(e => { console.error(e); process.exit(1); });
