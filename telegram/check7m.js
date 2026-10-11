'use strict';
/**
 * Were the LIVEGAP / LIVEMODEL alert prices real? (added 2026-10-11)
 *
 *   node check7m.js <livegap dir> <livemodel dir> [--cache dir]
 *
 * Our in-play Bet365 prices come from asianbetsoccer's "Bet365 Live" feed. A
 * side-by-side run against 7msport's Bet365 rows (2026-10-11, 23 matches, 6
 * min) found most markets moving together but some frozen in our feed for
 * minutes on lines Bet365 had left — the user confirmed in the Bet365 app that
 * 7msport was the closer of the two. 7msport keeps every Bet365 price change
 * of a match with a timestamp to the second, in play included (minute, score),
 * so each recorded alert can be checked against what Bet365 showed then.
 *
 * Per alert (the `alert` lines of both recorders, sent or silent):
 *   1. pair the match with 7msport's results list of that day (GMT+8 dates;
 *      Dice team names, kick-off estimated from the minute, final score);
 *   2. read 7msport's Bet365 history for that market (1X2 / AH / goal line);
 *   3. classify against Bet365's rows from 90 s before to 30 s after the alert:
 *        confirmed  — same line, a price ≥ ours − 0.02 was showing;
 *        lower      — same line, Bet365's price was lower than ours;
 *        other line — Bet365 was on a different line;
 *        other score / locked — 7msport had a different score, or the market suspended;
 *        no data    — match not found on 7msport or no Bet365 history;
 *   4. settle on the confirmed FT score (the recorders' `res` lines), at our
 *      price and, for same-line rows, at Bet365's actual price.
 * Unofficial source; requests are cached on disk and made 4 at a time.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { payout } = require('./livegap_report');
const { dice } = require('./livegap');

const args = process.argv.slice(2);
const opt = (n, d) => { const i = args.indexOf(n); return i >= 0 ? args[i + 1] : d; };
const CACHE = opt('--cache', path.join(__dirname, 'data', '7m_cache'));
const dirs = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--cache');
fs.mkdirSync(CACHE, { recursive: true });

const UA = { headers: { 'User-Agent': 'Mozilla/5.0' } };
async function cached(name, url, maxAgeMs = Infinity) {
  const f = path.join(CACHE, name);
  if (fs.existsSync(f) && Date.now() - fs.statSync(f).mtimeMs < maxAgeMs) return fs.readFileSync(f, 'utf8');
  for (let i = 0; i < 3; i++) {
    try {
      const r = await fetch(url, { ...UA, signal: AbortSignal.timeout(20000) });
      if (r.status === 404) { fs.writeFileSync(f, ''); return ''; }
      if (r.ok) { const t = await r.text(); fs.writeFileSync(f, t); return t; }
    } catch { /* retry */ }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
  }
  return null;
}
async function pool(items, n, fn) { let i = 0; await Promise.all(Array.from({ length: n }, async () => { while (i < items.length) await fn(items[i++]); })); }

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\(w\)|women'?s?|\bwomen\b/g, ' w ').replace(/\b(fc|cf|cd|sc|ac|fk|nk|sk|ud|rcd|ca|us|club|f\.c\.|calcio|sd|cs|afc)\b/g, ' ')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
const gmt8Day = t => new Date(t + 8 * 3600e3).toISOString().slice(0, 10);

// ── our recordings ──
function loadDir(dir, strat) {
  const alerts = [], res = new Map();
  for (const f of fs.readdirSync(dir).filter(f => /\.jsonl(\.gz)?$/.test(f)).sort()) {
    let txt = fs.readFileSync(path.join(dir, f));
    if (f.endsWith('.gz')) txt = zlib.gunzipSync(txt);
    for (const line of txt.toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.alert) alerts.push({ ...o.alert, strat });
      else if (o.res !== undefined) res.set(o.id, o.et ? o.reg : o.res);
    }
  }
  return { alerts, res };
}

// ── 7msport ──
async function dayList(day) {
  const txt = await cached(`list_${day}.js`, `https://data.7msport.com/result/${day}/index_en.js`, day >= gmt8Day(Date.now() - 86400e3) ? 3600e3 : Infinity);
  if (!txt) return [];
  const arr = n => { const m = txt.match(new RegExp(`var ${n}\\s*=\\s*(\\[[\\s\\S]*?\\]);`)); try { return m ? Function(`return ${m[1]}`)() : []; } catch { return []; } };
  const ids = arr('live_bh_Arr'), st = arr('Start_time_Arr'), A = arr('Team_A_Arr'), B = arr('Team_B_Arr'), ga = arr('live_a_Arr'), gb = arr('live_b_Arr');
  return ids.map((id, i) => {
    const p = String(st[i] || '').split(',').map(Number);
    const ko = p.length >= 5 ? Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4]) - 8 * 3600e3 : null;
    return { id, ko, home: norm(A[i]), away: norm(B[i]), ft: ga[i] != null ? `${ga[i]}-${gb[i]}` : null, rawH: A[i], rawA: B[i] };
  });
}
// Days whose results page isn't out yet (the current GMT+8 day): the matches in
// 7msport's current Bet365 list (~600, finished ones included), named from
// each match's info file.
let _recent = null;
async function recentList() {
  if (_recent) return _recent;
  const txt = await cached('recent_list.json', `https://oss-static-data-expansion.7mdt.com/football/luck/list/sdt/company/2.json?t=${Date.now()}`, 600e3);
  let ids = []; try { ids = JSON.parse(txt).matchs.map(m => m.id); } catch {}
  const out = [];
  await pool(ids, 6, async id => {
    const gi = await cached(`gi_${id}.js`, `https://px-analyse.7mdt.com/${id}/data/gameinfo_en.js`);
    try { const g = JSON.parse(gi.replace(/^[^{]*/, '').replace(/;\s*$/, '')); out.push({ id, ko: +g.time, home: norm(g.taname), away: norm(g.tbname), ft: null }); } catch {}
  });
  return (_recent = out);
}
const TYPE = { '1X2': 1, AH: 2, OU: 3 };
async function history(id, mk) {
  const txt = await cached(`h_${id}_${TYPE[mk]}.json`, `https://static-data-expansion.7mdt.com/football/luck/type/${TYPE[mk]}/sdt/${id}.json`);
  if (!txt) return null;
  try { const b = JSON.parse(txt)['2']; return b ? b.data.slice().sort((x, y) => x.updateTime - y.updateTime) : null; } catch { return null; }
}

// Estimated kick-off from the minute in play (15-min half-time break after 45').
const koOf = a => { const m = a.min ?? 0; return a.t - ((m > 45 ? m + 15 : m) * 60e3); };
function pair(a, list, ft) {
  const h = norm(a.m.split(' v ')[0]), w = norm(a.m.split(' v ').slice(1).join(' v ')), ko = koOf(a);
  let best = null;
  for (const x of list) {
    if (x.ko && Math.abs(x.ko - ko) > 45 * 60e3) continue;
    const sh = dice(h, x.home), sa = dice(w, x.away);
    if (Math.min(sh, sa) < 0.35) continue;
    let s = (sh + sa) / 2 + (ft && x.ft === ft ? 0.15 : 0);
    if (!best || s > best.s) best = { x, s };
  }
  return best && best.s >= 0.65 ? best.x : null;
}

// Bet365's line and price for our side in one 7m row.
function sideOf(a, r) {
  if (a.mk === '1X2') return { line: null, price: a.side === 'home' ? r.p_1 : a.side === 'draw' ? r.p_2 : r.p_3 };
  if (a.mk === 'AH') return a.side === 'home' ? { line: r.p_2, price: r.p_1 } : { line: -r.p_2, price: r.p_3 };
  return { line: r.p_2, price: a.side === 'over' ? r.p_1 : r.p_3 };
}
function classify(a, rows) {
  // In-play rows only (they carry the minute): a pre-match row says nothing about the live price.
  rows = (rows || []).filter(r => r.time);
  if (!rows.length) return { cls: 'no data' };
  const t = a.t / 1000;
  const before = rows.filter(r => r.updateTime <= t - 90).pop();
  const win = [...(before ? [before] : []), ...rows.filter(r => r.updateTime > t - 90 && r.updateTime <= t + 30)];
  if (!win.length) return { cls: 'no data' };
  const at = rows.filter(r => r.updateTime <= t).pop() || win[0];
  const sc = s => String(s).replace(/\s/g, '');
  if (at.home_score != null && at.time && `${at.home_score}-${at.away_score}` !== sc(a.sc)) return { cls: 'other score', at };
  const same = win.filter(r => !r.is_lock && (a.mk === '1X2' || Math.abs(sideOf(a, r).line - a.line) < 1e-6));
  if (!same.length) return { cls: win.every(r => r.is_lock) ? 'locked' : 'other line', at, theirs: sideOf(a, at) };
  const best = Math.max(...same.map(r => sideOf(a, r).price));
  const atSame = same.filter(r => r.updateTime <= t).pop() || same[0];
  return { cls: best >= a.p - 0.02 ? 'confirmed' : 'lower', at: atSame, real: sideOf(a, atSame).price, best };
}

(async () => {
  if (!dirs.length) { console.log('usage: node check7m.js <livegap dir> [<livemodel dir>] [--cache dir]'); return; }
  const data = dirs.map(d => loadDir(d, /livemodel/i.test(d) ? 'LIVEMODEL' : 'LIVEGAP'));
  const alerts = data.flatMap(d => d.alerts).filter(a => a.m && a.mk);
  const resOf = (a) => data.find(d => d.alerts.includes(a))?.res.get(a.id) ?? data.map(d => d.res.get(a.id)).find(x => x != null) ?? null;
  const days = [...new Set(alerts.flatMap(a => [gmt8Day(koOf(a)), gmt8Day(koOf(a) - 86400e3), gmt8Day(koOf(a) + 86400e3)]))].sort();
  const lists = new Map();
  await pool(days, 3, async d => lists.set(d, await dayList(d)));
  console.error(`7msport result lists: ${days.length} days, ${[...lists.values()].reduce((s, l) => s + l.length, 0)} matches`);
  const pairs = new Map();
  for (const a of alerts) {
    if (pairs.has(a.id)) continue;
    const ko = koOf(a), cands = [gmt8Day(ko), gmt8Day(ko - 86400e3), gmt8Day(ko + 86400e3)].flatMap(d => lists.get(d) || []);
    let x = pair(a, cands, resOf(a));
    if (!x && !(lists.get(gmt8Day(ko)) || []).length) x = pair(a, await recentList(), null);
    pairs.set(a.id, x);
  }
  const need = [...new Set(alerts.map(a => pairs.get(a.id) && `${pairs.get(a.id).id}|${a.mk}`).filter(Boolean))];
  const hist = new Map();
  let done = 0;
  await pool(need, 4, async k => { const [id, mk] = k.split('|'); hist.set(k, await history(id, mk)); if (++done % 200 === 0) console.error(`  histories ${done}/${need.length}`); });

  const out = [];
  for (const a of alerts) {
    const x = pairs.get(a.id);
    const c = x ? classify(a, hist.get(`${x.id}|${a.mk}`)) : { cls: 'no data' };
    const final = resOf(a);
    const pay = final != null ? payout(a, final, a.p) : null;
    const payReal = final != null && c.real > 1 ? payout(a, final, c.real) : null;
    out.push({ a, x, c, pay, payReal });
  }

  const pct = v => `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
  const lines = [`WERE THE ALERT PRICES REAL? — ${alerts.length} LIVEGAP/LIVEMODEL alerts checked against 7msport's Bet365 history (rows 90 s before → 30 s after each alert)`, ''];
  const CLS = ['confirmed', 'lower', 'other line', 'other score', 'locked', 'no data'];
  for (const strat of ['LIVEGAP', 'LIVEMODEL', 'ALL']) {
    const L = out.filter(o => strat === 'ALL' || o.a.strat === strat);
    if (!L.length) continue;
    lines.push(`${strat}: ${L.length} alerts · ${L.filter(o => o.x).length} found on 7msport`);
    for (const cl of CLS) {
      const g = L.filter(o => o.c.cls === cl); if (!g.length) continue;
      const s = g.filter(o => o.pay != null), r = g.filter(o => o.payReal != null);
      const roi = s.length ? s.reduce((v, o) => v + o.pay - 1, 0) / s.length : null;
      const roiR = r.length ? r.reduce((v, o) => v + o.payReal - 1, 0) / r.length : null;
      const drop = cl === 'lower' ? ` · Bet365 really ${(g.reduce((v, o) => v + (o.c.real / o.a.p - 1), 0) / g.length * 100).toFixed(1)}% lower on average` : '';
      lines.push(`  ${cl.padEnd(12)} ${String(g.length).padStart(5)} (${(g.length / L.length * 100).toFixed(0).padStart(2)}%) · settled ${String(s.length).padStart(4)}${roi != null ? ` · ROI at our price ${pct(roi)}` : ''}${roiR != null && cl !== 'confirmed' ? ` · at Bet365's real price ${pct(roiR)}` : ''}${drop}`);
    }
    lines.push('');
  }
  lines.push('"confirmed" = Bet365 (per 7msport) was showing our line at our price or better: the bettable alerts. Their ROI is the real test of the strategy.',
    'Others: the alert price was not on offer (lower price, different line, different score / suspended) — what our feed showed was stale.', '', 'EXAMPLES (not confirmed):');
  for (const o of out.filter(o => ['lower', 'other line', 'other score'].includes(o.c.cls)).slice(-25)) {
    const at = o.c.at, th = at ? sideOf(o.a, at) : null;
    lines.push(`  ${new Date(o.a.t).toISOString().slice(5, 16)} ${o.a.strat} ${o.a.m} ${o.a.min}' ${o.a.sc} · ours ${o.a.k} @${o.a.p} · 7m Bet365 ${at ? `${at.time || ''} ${at.home_score ?? ''}-${at.away_score ?? ''} line ${th.line ?? '-'} @${th.price}${at.is_lock ? ' locked' : ''}` : '-'} → ${o.c.cls}`);
  }
  console.log(lines.join('\n'));
  fs.writeFileSync(path.join(CACHE, 'check7m_rows.json'), JSON.stringify(out.map(o => ({ t: o.a.t, strat: o.a.strat, id: o.a.id, m: o.a.m, k: o.a.k, p: o.a.p, e: o.a.e, cls: o.c.cls, real: o.c.real ?? null, id7m: o.x?.id ?? null, pay: o.pay, payReal: o.payReal }))));
})();
