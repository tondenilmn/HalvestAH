/**
 * Cloudflare Pages Function: GET /api/scrape?url=<asianbetsoccer URL>
 *
 * Fetches the botbot3.space JS data file (server-side, bypassing CORS),
 * extracts the Pinnacle AH/TL odds from the embedded HTML table,
 * and returns clean JSON for the webapp to pre-fill its inputs.
 *
 * Strategy:
 *   1. Parse tablematch1 (1X2 table) to find Pinnacle's bookmaker index —
 *      bookmaker names only appear here, not in tablematch2.
 *   2. Parse tablematch2 (AH/TL table) — split into per-bookmaker groups
 *      by <tr class='vrng'> separator rows (same order as tablematch1).
 *   3. Extract the Pinnacle group and parse H/A rows by cell position —
 *      CSS classes (SU/SD/SN/V3/V4) encode movement direction and vary
 *      per match, so positional parsing is the only reliable approach.
 *
 * H row cell positions (after the "H" label cell):
 *   [0] AH closing line  [1] AH opening line  [2] movement (empty)
 *   [3] home odds C      [4] home odds O
 *   [5] TL closing (rowspan=2)  [6] TL opening (rowspan=2)
 *   [7] "O" label        [8] movement (empty)
 *   [9] over odds C      [10] over odds O  ...
 *
 * A row cell positions (after the "A" label cell):
 *   [0] AH closing line  [1] AH opening line  [2] movement (empty)
 *   [3] away odds C      [4] away odds O
 *   [5] "U" label        [6] movement (empty)
 *   [7] under odds C     [8] under odds O  ...
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

  const reqUrl = new URL(context.request.url);
  const matchUrl = reqUrl.searchParams.get('url');

  if (!matchUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), { status: 400, headers: cors });
  }

  // Extract match ID from asianbetsoccer URL (?id=<hex>)
  const idMatch = matchUrl.match(/[?&]id=([a-fA-F0-9]+)/);
  if (!idMatch) {
    return new Response(
      JSON.stringify({ error: 'Invalid URL — expected an asianbetsoccer.com match link containing ?id=…' }),
      { status: 400, headers: cors }
    );
  }

  const matchId = idMatch[1];
  const dataUrl = `https://botbot3.space/tables/v4/oddsComp/${matchId}.js`;

  let jsText;
  try {
    const resp = await fetch(dataUrl, {
      headers: {
        Origin:           'https://www.asianbetsoccer.com',
        Referer:          'https://www.asianbetsoccer.com/',
        'User-Agent':     'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
        Accept:           '*/*',
        'Accept-Language':'en-US,en;q=0.9',
      },
    });

    if (!resp.ok) {
      return new Response(
        JSON.stringify({ error: `Data source returned HTTP ${resp.status}. Check the URL is a valid match page.` }),
        { status: 502, headers: cors }
      );
    }
    jsText = await resp.text();
  } catch (e) {
    return new Response(
      JSON.stringify({ error: `Network error: ${e.message}` }),
      { status: 502, headers: cors }
    );
  }

  const data = parseMatchData(jsText);
  return new Response(JSON.stringify(data), { headers: cors });
}

/* ── HTML extraction from the jQuery .html("...") call ─────────────── */
function extractHtml(jsText, tableId) {
  const marker = `$("#${tableId}").html("`;
  const start = jsText.indexOf(marker);
  if (start === -1) return null;

  let i = start + marker.length;
  const chars = [];

  while (i < jsText.length) {
    const ch = jsText[i];
    if (ch === '\\' && i + 1 < jsText.length) {
      const nx = jsText[i + 1];
      if      (nx === '"')  chars.push('"');
      else if (nx === "'")  chars.push("'");
      else if (nx === '\\') chars.push('\\');
      else if (nx === 'n')  chars.push('\n');
      else if (nx === 'r')  chars.push('\r');
      else if (nx === 't')  chars.push('\t');
      else                  chars.push(nx);
      i += 2;
    } else if (ch === '"') {
      break;  // end of the string argument
    } else {
      chars.push(ch);
      i++;
    }
  }
  return chars.join('');
}

/* ── Main parser ────────────────────────────────────────────────────── */
function parseMatchData(jsText) {
  // Step 1: find Pinnacle's bookmaker index from tablematch1
  const tm1Html = extractHtml(jsText, 'tablematch1');
  if (!tm1Html) {
    const preview = jsText.slice(0, 120).replace(/\n/g, ' ');
    return { error: `Could not extract match data. Response preview: "${preview}"` };
  }

  const bookmakers = [...tm1Html.matchAll(/class='bnfsd'>([^<]+)</g)].map(m => m[1].trim());
  const pinIdx = bookmakers.findIndex(b => b.includes('Pinnacle'));

  if (pinIdx === -1) {
    return { error: 'Pinnacle odds not found — make sure the URL points to a match that includes Pinnacle.' };
  }

  // Step 2: extract tablematch2 and split into per-bookmaker groups
  // Groups are separated by <tr class='vrng'> rows; order matches tablematch1
  const tm2Html = extractHtml(jsText, 'tablematch2');
  if (!tm2Html) {
    return { error: 'Could not extract AH/TL data — source format may have changed' };
  }

  const groups = tm2Html.split("<tr class='vrng'><td colspan='25'></td></tr>");

  if (pinIdx >= groups.length) {
    return { error: 'Pinnacle AH odds not available for this match.' };
  }

  const pinGroup = groups[pinIdx];

  // Step 3: extract H and A rows from the Pinnacle group
  const hRowMatch = pinGroup.match(/<tr[^>]*><td>H<\/td>(.*?)<\/tr>/);
  const aRowMatch = pinGroup.match(/<tr[^>]*><td>A<\/td>(.*?)<\/tr>/);

  if (!hRowMatch || !aRowMatch) {
    return { error: 'Could not parse Pinnacle AH row structure.' };
  }

  // Extract all TD text values in order (positional — CSS classes vary by match)
  const parseTds = html => [...html.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(m => m[1].trim());
  const pf = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };

  const h = parseTds(hRowMatch[1]);
  const a = parseTds(aRowMatch[1]);

  const result = {
    ah_hc: pf(h[0]),   // AH home closing line
    ah_ho: pf(h[1]),   // AH home opening line
    ho_c:  pf(h[3]),   // Home odds closing
    ho_o:  pf(h[4]),   // Home odds opening
    tl_c:  pf(h[5]),   // Total line closing (rowspan=2 cell)
    tl_o:  pf(h[6]),   // Total line opening (rowspan=2 cell)
    ov_c:  pf(h[9]),   // Over odds closing
    ov_o:  pf(h[10]),  // Over odds opening
    ao_c:  pf(a[3]),   // Away odds closing
    ao_o:  pf(a[4]),   // Away odds opening
    un_c:  pf(a[7]),   // Under odds closing
    un_o:  pf(a[8]),   // Under odds opening
  };

  const hasData = Object.values(result).some(v => v !== null);
  if (!hasData) {
    return { error: 'Parsed Pinnacle section but could not extract odds values — structure may differ for this match.' };
  }

  return result;
}
