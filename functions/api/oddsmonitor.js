/**
 * Cloudflare Pages Function: /api/oddsmonitor — relay for oddsmonitor.eu's two
 * public JSON endpoints (Betfair Exchange Match Odds), for the Railway bot.
 * oddsmonitor answers 403 to Railway's IP (seen 2026-10-17) but serves other
 * networks; telegram/oddsmonitor.js falls back to this when it gets a 403.
 *
 *   GET /api/oddsmonitor?p=events        → wp-json/oddsmonitor/v1/events
 *   GET /api/oddsmonitor?p=chart/<slug>  → wp-json/oddsmonitor/v1/chart/<slug>
 *
 * Only those two paths; the answer is passed through unchanged.
 */
const BASE = 'https://oddsmonitor.eu/wp-json/oddsmonitor/v1/';

export async function onRequestGet({ request }) {
  const p = new URL(request.url).searchParams.get('p') || '';
  if (!/^(events|chart\/[a-z0-9-]{1,200})$/i.test(p)) return new Response('bad path', { status: 400 });
  try {
    const r = await fetch(BASE + p, { headers: { 'User-Agent': 'Mozilla/5.0', Accept: 'application/json' } });
    return new Response(await r.text(), { status: r.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'X-Upstream-Status': String(r.status) } });
  } catch (e) {
    return new Response(JSON.stringify({ error: e.message }), { status: 502, headers: { 'Content-Type': 'application/json' } });
  }
}
