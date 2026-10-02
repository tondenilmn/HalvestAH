/**
 * Cloudflare Pages Function: GET /api/scrape?url=<asianbetsoccer URL>
 *
 * Fetches the botbot3.space JS data file (server-side, bypassing CORS),
 * extracts AH/TL odds from the embedded HTML table, and returns clean JSON
 * for the webapp to pre-fill its inputs.
 *
 * Bookmaker priority: Bet365 first, falling back to Pinnacle if the match
 * page doesn't list Bet365 or its row can't be parsed. The bundled
 * historical dataset (static/data/Bet365/*.csv) is itself Bet365-sourced,
 * so Bet365 is what the analysis is actually calibrated against — Pinnacle
 * is kept only as a fallback for match pages that don't carry Bet365.
 *
 * Strategy:
 *   1. Parse tablematch1 (1X2 table) to find each bookmaker's index —
 *      bookmaker names only appear here, not in tablematch2.
 *   2. Parse tablematch2 (AH/TL table) — split into per-bookmaker groups
 *      by <tr class='vrng'> separator rows (same order as tablematch1).
 *   3. Extract the primary bookmaker's group and parse H/A rows by cell
 *      position — CSS classes (SU/SD/SN/V3/V4) encode movement direction
 *      and vary per match, so positional parsing is the only reliable
 *      approach.
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

const parseTds = html => [...html.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map(m => m[1].trim());
const pf = v => { const n = parseFloat(v); return isNaN(n) ? null : n; };

// Extract H/A odds for one bookmaker's group out of tablematch2 (see cell-position
// comment block at the top of this file for what each index means).
function parseBookmakerGroup(group) {
  const hRowMatch = group.match(/<tr[^>]*><td>H<\/td>(.*?)<\/tr>/);
  const aRowMatch = group.match(/<tr[^>]*><td>A<\/td>(.*?)<\/tr>/);
  if (!hRowMatch || !aRowMatch) return null;

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

  return Object.values(result).some(v => v !== null) ? result : null;
}

/* ── Main parser ────────────────────────────────────────────────────── */
function parseMatchData(jsText) {
  // Step 1: read the bookmaker name list from tablematch1 (names only appear here)
  const tm1Html = extractHtml(jsText, 'tablematch1');
  if (!tm1Html) {
    const preview = jsText.slice(0, 120).replace(/\n/g, ' ');
    return { error: `Could not extract match data. Response preview: "${preview}"` };
  }

  const bookmakers = [...tm1Html.matchAll(/class='bnfsd'>([^<]+)</g)].map(m => m[1].trim());
  const pinIdx    = bookmakers.findIndex(b => b.includes('Pinnacle'));
  const bet365Idx = bookmakers.findIndex(b => /bet\s*365/i.test(b));

  if (pinIdx === -1 && bet365Idx === -1) {
    return { error: 'Neither Bet365 nor Pinnacle odds found — make sure the URL points to a valid match page.' };
  }

  // Step 2: extract tablematch2 and split into per-bookmaker groups
  // Groups are separated by <tr class='vrng'> rows; order matches tablematch1
  const tm2Html = extractHtml(jsText, 'tablematch2');
  if (!tm2Html) {
    return { error: 'Could not extract AH/TL data — source format may have changed' };
  }

  const groups = tm2Html.split("<tr class='vrng'><td colspan='25'></td></tr>");

  // Step 3: Bet365 first (matches the bundled historical dataset), Pinnacle
  // as a fallback for matches that don't list Bet365 or fail to parse.
  let result = null, source = null;
  if (bet365Idx !== -1 && bet365Idx < groups.length) {
    result = parseBookmakerGroup(groups[bet365Idx]);
    if (result) source = 'bet365';
  }
  if (!result && pinIdx !== -1 && pinIdx < groups.length) {
    result = parseBookmakerGroup(groups[pinIdx]);
    if (result) source = 'pinnacle';
  }
  if (!result) {
    return { error: 'Could not parse Bet365 or Pinnacle odds for this match — source format may have changed.' };
  }
  result.source = source;

  // Step 4: parse the other bookmaker too, if listed — reference odds only,
  // never fed into the analysis engine itself.
  if (source === 'bet365' && pinIdx !== -1 && pinIdx < groups.length) {
    result.pinnacle = parseBookmakerGroup(groups[pinIdx]);
  } else if (source === 'pinnacle' && bet365Idx !== -1 && bet365Idx < groups.length) {
    result.bet365 = parseBookmakerGroup(groups[bet365Idx]);
  }

  // Step 5 (MATCH tab): every listed bookmaker's AH/TL/O-U + 1X2, keyed by
  // a normalised name (bet365, sbobet, crown, 188bet, 12bet, 18bet, avg…),
  // plus the match header (league, teams, minute/kickoff, score, cards,
  // corners). Additive — the fields above are unchanged for the Manual tab.
  const x12 = parse1x2ByBook(tm1Html);
  result.books = {};
  bookmakers.forEach((name, i) => {
    const key = bookKey(name);
    const odds = i < groups.length ? parseBookmakerGroup(groups[i]) : null;
    result.books[key] = Object.assign({ name }, odds || {}, { x12: x12[i] || null });
  });
  result.match = parseMatchHeader(tm1Html);

  return result;
}

function bookKey(name) {
  const n = name.toLowerCase();
  if (n.startsWith('avg')) return 'avg';
  return n.replace(/[^a-z0-9]/g, '');
}

/* ── 1X2 per bookmaker, from tablematch1 ─────────────────────────────── */
// Each book is two consecutive <tr class='bnfs'> rows: the first carries the
// book name + current 1/X/2 (cell classes f-red/f-blue mark movement), the
// second the opening 1/X/2 — same current-then-opening order as tablematch2.
function parse1x2ByBook(tm1Html) {
  const rows = [...tm1Html.matchAll(/<tr class='bnfs'>(.*?)<\/tr>/g)].map(m => m[1]);
  const out = [];
  for (let i = 0; i + 1 < rows.length; i += 2) {
    if (!/class='bnfsd'/.test(rows[i])) { i--; continue; } // resync if a row is missing
    const cur = [...rows[i].matchAll(/<td class='(?:f-red|f-blue|)'>([^<]*)<\/td>/g)].map(m => pf(m[1]));
    const open = parseTds(rows[i + 1]).map(pf);
    out.push({
      h_c: cur[0] ?? null, d_c: cur[1] ?? null, a_c: cur[2] ?? null,
      h_o: open[0] ?? null, d_o: open[1] ?? null, a_o: open[2] ?? null,
    });
  }
  return out;
}

/* ── Match header, from tablematch1 ──────────────────────────────────── */
// <tr><td colspan='9'>League</td></tr>
// <tr class='live'><td>H</td><td class='name'><span class='yellowcard'>1</span>Home</td>
//     <td id='timeval' value=23'></td><td>0</td><td class='info'>ht</td><td>0 - 1</td></tr>
// <tr class='live'><td>A</td><td class='name'>Away</td><td>1</td><td class='info'>ck</td><td class='corner'>0 - 3</td></tr>
// Pre-match pages may use a different row class and no score — every field
// is optional and parsed independently.
function parseMatchHeader(tm1Html) {
  const out = { league: null, home: null, away: null, status: null, minute: null, kickoff: null,
                score: null, htScore: null, corners: null, cards: { home: {}, away: {} } };
  const lg = tm1Html.match(/<tr><td colspan='9'>([^<]+)<\/td><\/tr>/);
  if (lg) out.league = lg[1].trim();

  const rowOf = side => (tm1Html.match(new RegExp(`<tr[^>]*><td>${side}<\\/td>(.*?)<\\/tr>`)) || [])[1] || '';
  const hRow = rowOf('H'), aRow = rowOf('A');
  const nameOf = row => {
    const m = row.match(/<td class='name'[^>]*>(.*?)<\/td>/);
    return m ? m[1].replace(/<span[^>]*>[^<]*<\/span>/g, '').replace(/<[^>]+>/g, '').trim() : null;
  };
  const cardsOf = row => {
    const c = {};
    for (const m of row.matchAll(/<span class='(yellowcard|redcard)'>(\d+)<\/span>/g)) c[m[1] === 'redcard' ? 'red' : 'yellow'] = +m[2];
    return c;
  };
  out.home = nameOf(hRow); out.away = nameOf(aRow);
  out.cards = { home: cardsOf(hRow), away: cardsOf(aRow) };

  const tv = tm1Html.match(/id='timeval'\s+value=([^>]*?)>/);
  if (tv) {
    const v = tv[1].replace(/\\?'$/, '').replace(/^['"]|['"]$/g, '').trim();
    if (/^HT$/i.test(v)) { out.status = 'HT'; out.minute = 45; }
    else if (/^FT$/i.test(v)) { out.status = 'FT'; out.minute = 90; }
    else if (/^\d+(\+\d+)?'?$/.test(v)) { out.status = 'LIVE'; out.minute = parseInt(v, 10); }
    else if (v) { out.status = 'PRE'; out.kickoff = v; }
  }

  // Goals: the first plain <td colspan='2'>N</td> after the time cell / name.
  const goalOf = row => { const m = row.match(/<td colspan='2'>(\d+)<\/td>/); return m ? +m[1] : null; };
  const hg = goalOf(hRow), ag = goalOf(aRow);
  const ht = hRow.match(/<td class='info'>ht<\/td><td[^>]*>(\d+)\s*-\s*(\d+)<\/td>/);
  if (ht) out.htScore = { home: +ht[1], away: +ht[2] };
  // A finished match goes back to showing the kick-off time in timeval, and
  // its H/A rows lose class='live' — but it keeps the HT and final score.
  const isLiveRow = /<tr class='live'><td>H<\/td>/.test(tm1Html);
  if (out.status === 'PRE' && out.htScore && !isLiveRow) out.status = 'FT';
  if (out.status && out.status !== 'PRE' && hg != null && ag != null) out.score = { home: hg, away: ag };
  const ck = aRow.match(/<td class='corner'>(\d+)\s*-\s*(\d+)<\/td>/);
  if (ck) out.corners = { home: +ck[1], away: +ck[2] };
  if (!out.status) out.status = out.score ? 'LIVE' : 'PRE';
  return out;
}
