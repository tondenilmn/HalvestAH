'use strict';
/**
 * LIVEGAP settlement — confirmed full-time scores from the match page.
 *
 * The live list only tells us a match's last score while it was listed, and
 * botbot3 blackouts (every feed empty for ~30-60 s) or extra time make a match
 * vanish without being finished. So nothing is settled from the live list:
 * once a recorded/alerted match has gone (blackout-safe, see livegap.js's
 * updatePresence) — or 10 min after it was last seen, for matches re-queued
 * after a restart — the bot reads the match page itself (botbot3
 * oddsComp/<id>.js, the file the asianbetsoccer match page loads) and writes
 * a `res` line only when the page says the match is finished:
 *
 *   {t, id, res:'2-1', ht:'1-0', m}            confirmed full time
 *   {t, id, res:'2-2', et:true, reg:'1-1', m}  went to extra time; reg = the
 *                                              90' score from the live feed
 *                                              (null if it wasn't seen at 90')
 *   {t, id, nores:true, status, m}             no result 6 h after first seen
 *
 * A finished page reverts timeval to the kick-off ISO time and its H/A rows
 * lose class='live' but keep the HT and final score (checked 2026-10-07 on
 * the day's finished matches). Extra time shows timeval OT and the match
 * drops out of the live list's minute rows while it is played.
 */
const fs = require('fs');
const path = require('path');

const CHECK_EVERY_MS = 10 * 60000;
const GIVE_UP_MS = 6 * 3600000;
const HEADERS = {
  Origin: 'https://www.asianbetsoccer.com',
  Referer: 'https://www.asianbetsoccer.com/',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  Accept: '*/*',
};

// tablematch1's HTML out of the jQuery .html("…") call (same as scrape.js's extractHtml).
function tablematch1(js) {
  const marker = '$("#tablematch1").html("';
  const start = js.indexOf(marker);
  if (start < 0) return null;
  let out = '';
  for (let i = start + marker.length; i < js.length; i++) {
    const ch = js[i];
    if (ch === '\\' && i + 1 < js.length) { out += js[++i]; continue; }
    if (ch === '"') break;
    out += ch;
  }
  return out;
}

// Status + score from the page header — the same reading as
// functions/api/scrape.js's parseMatchHeader, plus extra time (timeval OT).
function parseResult(tm1) {
  const rowOf = side => (tm1.match(new RegExp(`<tr[^>]*><td>${side}<\\/td>(.*?)<\\/tr>`)) || [])[1] || '';
  const hRow = rowOf('H'), aRow = rowOf('A');
  const goalOf = row => { const m = row.match(/<td colspan='2'>(\d+)<\/td>/); return m ? +m[1] : null; };
  const hg = goalOf(hRow), ag = goalOf(aRow);
  const ht = hRow.match(/<td class='info'>ht<\/td><td[^>]*>(\d+)\s*-\s*(\d+)<\/td>/);
  const tv = tm1.match(/id='timeval'\s+value=([^>]*?)>/);
  const v = tv ? tv[1].replace(/'$/, '').replace(/^['"]|['"]$/g, '').trim() : '';
  const isLiveRow = /<tr class='live'><td>H<\/td>/.test(tm1);
  let status;
  if (/^FT$/i.test(v)) status = 'FT';
  else if (/^(OT|ET|AET|PEN|P)$/i.test(v)) status = 'ET';
  else if (/^HT$/i.test(v) || /^\d+'?(\+\d*)?'?$/.test(v)) status = 'LIVE';
  else if (ht && !isLiveRow) status = 'FT';
  else status = isLiveRow ? 'LIVE' : 'PRE';
  return {
    status,
    score: hg != null && ag != null && status !== 'PRE' ? `${hg}-${ag}` : null,
    ht: ht ? `${ht[1]}-${ht[2]}` : null,
  };
}

async function fetchResult(id) {
  const r = await fetch(`https://botbot3.space/tables/v4/oddsComp/${id}.js`, { headers: HEADERS, signal: AbortSignal.timeout(20000) });
  if (!r.ok) return { status: `HTTP ${r.status}` };
  const tm1 = tablematch1(await r.text());
  return tm1 ? parseResult(tm1) : { status: 'no header' };
}

// ── Queue of matches waiting for a confirmed result ──
// entry: {id, m, firstT, lastSeen, gone, nextCheck, et, reg, regMin}
function noteSeen(pending, id, label, score, minute, now) {
  let p = pending.get(id);
  if (!p) pending.set(id, p = { id, m: label, firstT: now, lastSeen: now, gone: false, nextCheck: 0, et: false, reg: null, regMin: null });
  p.lastSeen = now; p.gone = false; p.m = label || p.m;
  if (score && minute != null && minute >= 85) { p.reg = score; p.regMin = minute; }
  return p;
}

function markGone(pending, id, now) {
  const p = pending.get(id);
  if (p && !p.gone) { p.gone = true; p.nextCheck = Math.max(p.nextCheck, now); }
}

// Checks the due matches (at most `max` page fetches per call) and returns
// the lines to append.
async function settleDue(pending, now, fetcher = fetchResult, max = 6) {
  const lines = [];
  let fetched = 0;
  for (const p of [...pending.values()]) {
    if (!(p.gone || now - p.lastSeen >= CHECK_EVERY_MS) || now < p.nextCheck) continue;
    if (fetched++ >= max) break; // the rest on the next scan
    let r;
    try { r = await fetcher(p.id); } catch (e) { r = { status: e.message }; }
    if (r.status === 'FT' && r.score) {
      const line = { t: now, id: p.id, res: r.score, ht: r.ht, m: p.m };
      if (p.et) Object.assign(line, { et: true, reg: p.regMin >= 90 ? p.reg : null });
      lines.push(line); pending.delete(p.id); continue;
    }
    if (r.status === 'ET') p.et = true;
    p.nextCheck = now + CHECK_EVERY_MS;
    if (now - p.firstT > GIVE_UP_MS) { lines.push({ t: now, id: p.id, nores: true, status: r.status, m: p.m }); pending.delete(p.id); }
  }
  return lines;
}

// After a restart: every match recorded or alerted in the last `days` files
// with no res/nores line yet goes back on the queue.
function recoverPending(dir, now, days = 2) {
  const pending = new Map(), done = new Set();
  if (!fs.existsSync(dir)) return pending;
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl')).sort().slice(-days);
  for (const f of files) {
    for (const line of fs.readFileSync(path.join(dir, f), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      if (o.res !== undefined || o.nores) { done.add(o.id); continue; }
      const r = o.alert || (o.k ? o : null);
      if (!r || !r.id) continue;
      let p = pending.get(r.id);
      if (!p) pending.set(r.id, p = { id: r.id, m: r.m, firstT: r.t, lastSeen: r.t, gone: false, nextCheck: 0, et: false, reg: null, regMin: null });
      p.lastSeen = Math.max(p.lastSeen, r.t);
      if (r.min != null && r.min >= 85 && r.t >= p.lastSeen) { p.reg = r.sc; p.regMin = r.min; }
    }
  }
  for (const id of done) pending.delete(id);
  return pending;
}

module.exports = { parseResult, tablematch1, fetchResult, noteSeen, markGone, settleDue, recoverPending, CHECK_EVERY_MS, GIVE_UP_MS };
