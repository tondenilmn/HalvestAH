'use strict';
/**
 * 7msport Bet365 price check for PRICEGAP alerts (added 2026-10-11).
 *
 * Our Bet365 prices come from asianbetsoccer's tablenext files, which can be a
 * refresh behind Bet365 (Vendsyssel v HB Køge, 2026-10-10: alerted @1.88, the
 * site already showed 1.70). 7msport keeps every Bet365 price change per match
 * with a timestamp (see check7m.js / research_7m_timing.js), so before a
 * PRICEGAP alert is sent the bot reads that match's Bet365 history there and:
 *   - same line, 7m price ≥ ours − tolerance → send ("ok");
 *   - same line, lower but still ≥ the alert's minimum → send at 7m's price;
 *   - same line, below the minimum → block ("lower");
 *   - different line → block ("line": our feed is behind);
 *   - match / market not found, or 7msport unreachable → send as before
 *     ("nf" / "err") — the check never stops an alert it can't verify.
 *
 * Match ids: 7msport's fixtures pages (`data.7msport.com/fixture/en_<N>.js`,
 * N = 1..7, ids + names + kick-off, GMT+8) and, for today's remaining matches
 * (en_1 starts at 13:00 GMT+8 of the next day), its livescore page (ids + names
 * in the analyse links' titles, no kick-off). Rebuilt every INDEX_MS.
 * Unofficial source — plain fetch, small files, ≤ 2 history reads per alert.
 */
const { dice } = require('./livegap');
const { kindOf } = require('./pinngap');

const UA = { headers: { 'User-Agent': 'Mozilla/5.0' } };
const INDEX_MS = 30 * 60000;
const TYPE = { AH: 2, OU: 3 };

const norm = s => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/\(w\)|women'?s?/g, ' ').replace(/\(?u-?\d\d\)?/g, ' ').replace(/\b(ii|reserves?|b)\b|\(r\)/g, ' ')
  .replace(/\b(fc|cf|cd|sc|ac|fk|nk|sk|ud|rcd|ca|us|club|f\.c\.|calcio|sd|cs|afc|cp|ec|se)\b/g, ' ')
  .replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();

async function getText(url, ms = 10000) {
  const r = await fetch(url, { ...UA, signal: AbortSignal.timeout(ms) });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}
const arrOf = (txt, n) => { const m = txt.match(new RegExp(`var ${n}\\s*=\\s*(\\[[\\s\\S]*?\\]);`)); try { return m ? Function(`return ${m[1]}`)() : []; } catch { return []; } };

// Fixture page → [{id, home, away, ko}] (kick-off GMT+8 → UTC ms).
function parseFixtures(txt) {
  const ids = arrOf(txt, 'live_bh_Arr'), st = arrOf(txt, 'Start_time_Arr'), A = arrOf(txt, 'Team_A_Arr'), B = arrOf(txt, 'Team_B_Arr');
  return ids.map((id, i) => {
    const p = String(st[i] || '').split(',').map(Number);
    return { id: String(id), rawH: A[i], rawA: B[i], ko: p.length >= 5 ? Date.UTC(p[0], p[1] - 1, p[2], p[3], p[4]) - 8 * 3600e3 : null };
  });
}
// Livescore page → [{id, home, away, ko: null}] from `analyse.7msport.com/<id>/… title="Home vs Away"`.
function parseLivePage(html) {
  const out = [], re = /analyse\.7msport\.com\/(\d+)\/index\.shtml"[^>]*title="([^"]+?) vs ([^"]+?)"/g;
  let m; while ((m = re.exec(html))) out.push({ id: m[1], rawH: m[2].replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&'), rawA: m[3].replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, '&'), ko: null });
  return out;
}

const state = { idx: [], at: 0, building: null, err: null, checks: { ok: 0, adj: 0, lower: 0, line: 0, nf: 0, err: 0 } };

async function refreshIndex(now = Date.now(), force = false) {
  if (!force && now - state.at < INDEX_MS && state.idx.length) return state.idx;
  if (state.building) return state.building;
  state.building = (async () => {
    const pages = await Promise.allSettled([
      getText('https://live.7msport.com/', 15000).then(parseLivePage),
      ...[1, 2, 3, 4, 5, 6, 7].map(n => getText(`https://data.7msport.com/fixture/en_${n}.js`, 15000).then(parseFixtures)),
    ]);
    const byId = new Map();
    for (const p of pages) if (p.status === 'fulfilled') for (const e of p.value) {
      const prev = byId.get(e.id);
      if (!prev || (prev.ko == null && e.ko != null)) byId.set(e.id, { ...e, home: norm(e.rawH), away: norm(e.rawA), kind: [kindOf(e.rawH, ''), kindOf(e.rawA, '')] });
    }
    if (byId.size) { state.idx = [...byId.values()]; state.at = now; state.err = null; }
    else state.err = pages.find(p => p.status === 'rejected')?.reason?.message || 'empty';
    return state.idx;
  })().finally(() => { state.building = null; });
  return state.building;
}

// Best 7msport entry for a Bet365 fixture: same kind of side (women/youth/reserves),
// Dice names; kick-off within 45 min when 7msport has one (livescore entries don't).
function findMatch(idx, home, away, koMs) {
  const h = norm(home), a = norm(away), kh = kindOf(home, ''), ka = kindOf(away, '');
  let best = null;
  for (const e of idx || []) {
    if (e.ko != null && koMs != null && Math.abs(e.ko - koMs) > 45 * 60000) continue;
    if (e.kind[0] !== kh || e.kind[1] !== ka) continue;
    const sh = dice(h, e.home), sa = dice(a, e.away);
    if (Math.min(sh, sa) < 0.4) continue;
    const s = (sh + sa) / 2 - (e.ko == null ? 0.05 : 0); // a dated entry wins a tie
    if (!best || s > best.s) best = { e, s };
  }
  return best && best.s >= (best.e.ko == null ? 0.75 : 0.65) ? best.e : null;
}

// Bet365's latest pre-match row on 7msport for one market → { line (home handicap / total), p1, p3, t } or null.
async function latestBet365(id, mk) {
  const txt = await getText(`https://static-data-expansion.7mdt.com/football/luck/type/${TYPE[mk]}/sdt/${id}.json?d=${Math.floor(Date.now() / 30000)}`, 8000);
  const rows = (JSON.parse(txt)['2']?.data || []).filter(r => !r.time && r.p_1 > 1 && r.p_3 > 1);
  if (!rows.length) return null;
  const r = rows.reduce((x, y) => (y.updateTime > x.updateTime ? y : x));
  return { line: +r.p_2, p1: +r.p_1, p3: +r.p_3, t: r.updateTime * 1000, lock: !!r.is_lock };
}

/**
 * Verdict for one PRICEGAP row (pricegap.js shape: AH line = home handicap for
 * both sides). minOdds = the alert's minimum price. Returns
 * { st: 'ok' | 'adj' | 'lower' | 'line' | 'nf' | 'err', p7, line7, ageS }.
 */
function verdict(r, b, minOdds, tol = 0.02, now = Date.now()) {
  if (!b || b.lock) return { st: 'nf' };
  const ageS = Math.round((now - b.t) / 1000);
  if (Math.abs(b.line - r.line) > 1e-6) return { st: 'line', line7: b.line, ageS };
  const p7 = (r.market === 'AH' ? r.side === 'home' : r.side === 'over') ? b.p1 : b.p3;
  if (p7 >= r.price - tol) return { st: 'ok', p7, ageS };
  if (p7 >= minOdds) return { st: 'adj', p7, ageS };
  return { st: 'lower', p7, ageS };
}

async function checkGap(match, r, minOdds, o = {}) {
  if (!TYPE[r.market]) return { st: 'nf' }; // 1X2: not checked
  try {
    const idx = await refreshIndex();
    const e = findMatch(idx, match.home_team, match.away_team, match.kickoff_time ? Date.parse(match.kickoff_time) : null);
    if (!e) return { st: 'nf' };
    const v = verdict(r, await latestBet365(e.id, r.market), minOdds, o.tol);
    return { ...v, id7: e.id };
  } catch (err) { return { st: 'err', why: err.message }; }
}

const count = st => { state.checks[st] = (state.checks[st] || 0) + 1; };
const statusLine = () => `7msport check: index ${state.idx.length} matches${state.at ? ` (${Math.round((Date.now() - state.at) / 60000)} min old)` : ''}${state.err ? ` · error ${state.err}` : ''} · ${Object.entries(state.checks).map(([k, v]) => `${k} ${v}`).join(' · ')}`;

module.exports = { checkGap, verdict, findMatch, parseFixtures, parseLivePage, refreshIndex, latestBet365, norm, count, statusLine, _state: state };
