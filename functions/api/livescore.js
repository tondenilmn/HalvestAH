/**
 * Cloudflare Pages Function: GET /api/livescore
 *
 * Fetches the asianbetsoccer.com/it/livescore page server-side (CORS bypass)
 * and extracts match IDs + metadata from the HTML.
 *
 * NOTE: If the livescore page is a JS-rendered SPA, the server-side fetch
 * will return only the shell HTML with no match links. In that case the
 * response contains { matches: [], note: "..." } and the UI shows a clear
 * error message rather than crashing.
 */
export async function onRequest(context) {
  const cors = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Content-Type': 'application/json',
  };

  if (context.request.method === 'OPTIONS') {
    return new Response(null, { headers: cors });
  }

  let html;
  try {
    const resp = await fetch('https://www.asianbetsoccer.com/it/livescore', {
      headers: {
        Origin:            'https://www.asianbetsoccer.com',
        Referer:           'https://www.asianbetsoccer.com/',
        'User-Agent':      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept:            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });
    if (!resp.ok) {
      return new Response(JSON.stringify({ error: `Livescore page returned HTTP ${resp.status}` }), { headers: cors });
    }
    html = await resp.text();
  } catch (e) {
    return new Response(JSON.stringify({ error: `Network error: ${e.message}` }), { headers: cors });
  }

  const matches = parseMatches(html);
  if (!matches.length) {
    return new Response(
      JSON.stringify({
        matches: [],
        note: 'No matches found — page may be JS-rendered (SPA) or no live matches are currently playing.',
      }),
      { headers: cors }
    );
  }

  return new Response(JSON.stringify({ matches }), { headers: cors });
}

function parseMatches(html) {
  const matches = [];
  const seen = new Set();
  // Extract all hrefs containing ?id=HEX
  const linkRe = /href="([^"]*[?&]id=([a-fA-F0-9]+)[^"]*)"/g;
  let m;

  while ((m = linkRe.exec(html)) !== null) {
    const id = m[2];
    if (seen.has(id)) continue;
    seen.add(id);

    const href = m[1];
    const url = href.startsWith('http')
      ? href
      : 'https://www.asianbetsoccer.com' + (href.startsWith('/') ? href : '/' + href);

    // Extract ~700 chars of surrounding context for team names and score
    const ctx = html.slice(Math.max(0, m.index - 100), m.index + 700);
    const text = ctx.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

    // Score: "1-0", "0-0", "2-1"
    const scoreM = text.match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/);
    const score  = scoreM ? `${scoreM[1]}-${scoreM[2]}` : null;

    // Team names: <td> text nodes, skip short/numeric strings
    const tdNames = [...ctx.matchAll(/<td[^>]*>\s*([A-Za-z0-9 '.&\-]{3,40})\s*<\/td>/g)]
      .map(n => n[1].trim())
      .filter(n => !/^\d/.test(n) && n.length > 2);

    matches.push({
      id,
      url,
      home_team: tdNames[0] || '',
      away_team: tdNames[1] || '',
      score,
    });
  }

  return matches;
}
