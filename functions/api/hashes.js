/**
 * Cloudflare Pages Function: /api/hashes — the book-hash store behind every
 * other function (see livescore.js's "Hash store" block).
 *
 *   GET  → health of each feed: { kv, keyRequired, books: { bet365, sbobet,
 *          bet365live: { hash, source: 'kv'|'env'|'default', at, by,
 *          status: 'ok'|'stale'|'wrong'|'unverified', detail, healed? } } }
 *        A stale feed gets one discovery round; a working replacement is saved.
 *   GET ?raw=1 → just the stored hashes { kv, books: { book: { hash, source, at, by } } },
 *        no feed checks — polled by the Railway notifier (telegram/livescore.js syncHashesFromApp)
 *   POST { book: 'bet365'|'sbobet'|'bet365live', url | hash, key? }
 *        → checks the hash against botbot3 (right kind of feed, has data)
 *          and saves it to KV. The next request of every function uses it —
 *          no dashboard edit, no redeploy.
 *
 * Needs a KV namespace bound as HASHES_KV (Pages → Settings → Functions →
 * KV namespace bindings) to save; GET works without it. If HASH_ADMIN_KEY is
 * set, POST must send the same `key` — without it, any hash that passes the
 * botbot3 check can be saved (it can only ever point a feed at real data).
 *
 * How the checks tell the feeds apart: see probe() below.
 */
import {
  parseGetData2Calls, parseGetData2NoneCalls, parseGetData1Calls,
  resolveHashes, saveHashes, healHashes, fetchBotbotFile, botbotUrl, isHash40, STORE_BOOKS,
} from './livescore.js';

const LABEL = { bet365: 'Bet365', sbobet: 'Sbobet', bet365live: 'Bet365 Live' };

// What a hash's livegame file holds. Pre-match books (Bet365, Sbobet) are
// mostly getData2 rows with a handful of getData2none; "Bet365 Live" is
// getData2none only (checked 2026-10-04: 219 none / 0 getData2 vs 251 / 8 for
// Bet365). A rotated hash 404s, or answers 200 with no rows for hours first —
// which looks exactly like botbot3's own brief blackouts (every feed empty for
// ~30-60 s, seen several times 2026-10-04), so "empty" is only called stale
// when another feed has data at the same moment.
// The livegame file only lists matches in play or about to start, so with
// nothing being played a pre-match book's file is empty or holds just a stray
// getData2none row or two — which looks like the Live feed (seen 2026-10-05:
// Bet365 = 0 getData2 / 1 none). So whenever there are no getData2 rows the
// next-games list (tablenext day0, else day1) decides: a working Bet365 /
// Sbobet hash fills it with upcoming fixtures, a rotated one leaves it empty
// too, and the Bet365 Live hash has none (its tablenext 404s).
async function probe(hash, ts) {
  const r = await fetchBotbotFile(botbotUrl('livegame', hash, ts), hash);
  if (r.status !== 200) return { http: r.status, error: r.error, pre: 0, live: 0, inPlay: 0, next: 0 };
  const p = {
    http: 200,
    pre: parseGetData2Calls(r.text).length,
    live: parseGetData2NoneCalls(r.text).length,
    inPlay: parseGetData1Calls(r.text).filter(m => m.minute).length,
    next: 0,
  };
  if (p.pre === 0) {
    for (const day of [0, 1]) {
      const n = await fetchBotbotFile(botbotUrl(`tablenext/day${day}`, hash, ts), hash);
      if (n.status === 200) p.next = parseGetData2Calls(n.text).length;
      if (p.next > 0) break;
    }
  }
  return p;
}
const hasData = p => p.pre > 0 || p.live > 0 || p.next > 0;
const kindOf = p => p.http === 404 ? 'gone' : p.http !== 200 ? 'error'
  : p.pre > 0 ? 'prematch' : p.next > 0 ? 'upcoming' : p.live > 0 ? 'live' : 'empty';

// Status of one book from its probe, given whether botbot3 is serving data
// at all right now and how many matches Bet365 shows in play (the Live feed
// is legitimately empty when nothing is being played).
function verdict(book, p, anyData, inPlay = null) {
  const k = kindOf(p);
  if (k === 'gone') return { status: 'stale', detail: 'HTTP 404 — hash rotated' };
  if (k === 'error') return { status: 'unverified', detail: p.error || `HTTP ${p.http}` };
  if (k === 'empty' && book === 'bet365live' && anyData && !(inPlay >= 3))
    return { status: 'unverified', reason: 'quiet', detail: 'no live prices, but hardly any matches are in play to check against' };
  if (k === 'empty') return anyData
    ? { status: 'stale', detail: 'answers but empty while the other feeds have data — hash rotated' }
    : { status: 'unverified', reason: 'blackout', detail: 'botbot3 is serving empty tables right now (short blackout) — check again in a minute' };
  if (book === 'bet365live') return k === 'live'
    ? { status: 'ok', detail: `${p.live} live prices` }
    : { status: 'wrong', detail: 'this hash is a pre-match feed, not Bet365 Live' };
  if (k === 'upcoming') return { status: 'ok', detail: `no match in play right now — ${p.next} upcoming fixtures in the next-games list` };
  return k === 'prematch'
    ? { status: 'ok', detail: `${p.pre} matches in the live/upcoming table` }
    : { status: 'wrong', detail: `this hash is the Bet365 Live feed, not ${LABEL[book]}` };
}

export async function onRequest(context) {
  const cors = {
    'Access-Control-Allow-Origin':  '*',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type':                 'application/json',
    'Cache-Control':                'no-store',
  };
  const { request, env = {} } = context;
  if (request.method === 'OPTIONS') return new Response(null, { headers: cors });
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
  const ts = Date.now();

  // ?raw=1 — the stored hashes only, no feed checks (1 KV read): what the
  // Railway notifier polls every few minutes to pick up a hash pasted here.
  if (request.method === 'GET' && new URL(request.url).searchParams.get('raw') === '1') {
    const { hashes, source, stored, kv } = await resolveHashes(env);
    const books = {};
    for (const book of STORE_BOOKS) {
      books[book] = { hash: hashes[book], source: source[book],
        at: source[book] === 'kv' ? stored[book]?.at || null : null,
        by: source[book] === 'kv' ? stored[book]?.by || null : null };
    }
    return json({ kv, books });
  }

  if (request.method === 'GET') {
    const { hashes, source, stored, kv } = await resolveHashes(env);
    const probes = Object.fromEntries(await Promise.all(STORE_BOOKS.map(async b => [b, await probe(hashes[b], ts)])));
    const anyData = Object.values(probes).some(hasData);
    const inPlay = probes.bet365.inPlay;
    const health = Object.fromEntries(STORE_BOOKS.map(b => [b, verdict(b, probes[b], anyData, inPlay)]));

    // Self-repair: a feed that's definitely stale gets one discovery round
    // (the same path the other functions use); a working replacement is saved.
    const failing = Object.fromEntries(STORE_BOOKS.filter(b => ['stale', 'wrong'].includes(health[b].status)).map(b => [b, hashes[b]]));
    if (Object.keys(failing).length) {
      const healed = await healHashes(env, failing, async (book, h) => {
        const p = await probe(h, ts);
        return verdict(book, p, true, inPlay).status === 'ok' ? p : null;
      });
      for (const [b, v] of Object.entries(healed)) {
        hashes[b] = v.hash; source[b] = kv ? 'kv' : 'discovered';
        health[b] = { ...verdict(b, v.result, true, inPlay), healed: true };
        stored[b] = { at: Date.now(), by: 'auto' };
      }
    }

    const books = {};
    for (const book of STORE_BOOKS) {
      books[book] = {
        label: LABEL[book], hash: hashes[book], source: source[book],
        at: source[book] === 'kv' ? stored[book]?.at || null : null,
        by: source[book] === 'kv' ? stored[book]?.by || null : null,
        ...health[book],
      };
    }
    return json({ kv, keyRequired: !!env.HASH_ADMIN_KEY, liveNow: inPlay, books });
  }

  if (request.method !== 'POST') return json({ error: 'Use GET or POST' }, 405);

  let body;
  try { body = await request.json(); } catch { return json({ error: 'Send JSON: { book, url }' }, 400); }
  const book = body?.book;
  if (!STORE_BOOKS.includes(book)) return json({ error: `book must be one of ${STORE_BOOKS.join(', ')}` }, 400);
  if (env.HASH_ADMIN_KEY && body.key !== env.HASH_ADMIN_KEY) return json({ error: 'Wrong or missing admin key.' }, 401);
  if (!env.HASHES_KV) {
    return json({ error: 'Saving needs a KV namespace bound as HASHES_KV (Cloudflare → Workers & Pages → your project → Settings → Bindings → add KV namespace, variable name HASHES_KV), then redeploy once.' }, 400);
  }
  const m = String(body.hash || body.url || '').match(/[a-f0-9]{40}/i);
  const hash = m ? m[0].toLowerCase() : null;
  if (!isHash40(hash)) return json({ error: 'No 40-character hash found — paste the botbot3.space …/livegame/<hash>.js URL or the hash itself.' }, 400);

  // Is it the right kind of feed, and does it have data? When it comes back
  // empty, compare with the feed currently stored for the other side to tell
  // a dead hash from one of botbot3's short blackouts.
  const p = await probe(hash, ts);
  let check = verdict(book, p, true, 99);
  if (check.status === 'stale' && p.http === 200) {
    const { hashes } = await resolveHashes(env);
    const ref = await probe(hashes.bet365 === hash ? hashes.sbobet : hashes.bet365, ts);
    check = verdict(book, p, hasData(ref), ref.inPlay);
  }
  if (check.status === 'stale' || check.status === 'wrong') return json({ error: `Not saved — ${check.detail}.` }, 400);
  // A Live hash pasted when nothing is in play can't be checked — save it anyway.
  const unchecked = check.reason === 'quiet' && book === 'bet365live';
  if (check.status !== 'ok' && !unchecked) return json({ error: `Not saved — couldn't check it: ${check.detail}.` }, 503);

  const saved = await saveHashes(env, { [book]: hash }, 'manual');
  return json({ ok: true, saved, book, hash, ...check });
}
