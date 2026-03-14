/**
 * Cloudflare Pages Function: GET /api/scrape?url=<asianbetsoccer URL>
 *
 * Fetches the botbot3.space JS data file (server-side, bypassing CORS),
 * extracts the Pinnacle AH/TL odds from the embedded HTML table,
 * and returns clean JSON for the webapp to pre-fill its inputs.
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
        'Accept-Encoding':'gzip, deflate, br',
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

  const data = await parseMatchData(jsText);
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

/* ── Table parser using HTMLRewriter ───────────────────────────────── */
async function parseMatchData(jsText) {
  const tm2Html = extractHtml(jsText, 'tablematch2');
  if (!tm2Html) {
    return { error: 'Could not extract match data — source format may have changed' };
  }

  /**
   * State machine phases:
   *   searching  → scanning for the Pinnacle bookmaker name cell
   *   h_row      → inside Pinnacle's H (home/first) data row
   *   a_row      → inside Pinnacle's A (away/second) data row
   *   done       → finished collecting
   *
   * Column layout in tablematch2 (Pinnacle section):
   *   H row: [SU=AH line C] [plain=AH line O] [V3=home odds C] [V4=home odds O]
   *          [SD=TL C] [rowspan=2=TL O] [V3=over C] [V4=over O] …
   *   A row: [SU=away AH line C] [plain=away AH line O] [V3=away odds C] [V4=away odds O]
   *          [V3=under C] [V4=under O] …
   */
  const s = {
    phase: 'searching',
    currentText: '',
    currentClass: '',
    currentRowspan: '',
    lastWasSU: false,
    // H row accumulations
    h_su:     null,   // AH line closing text  e.g. "-0.5"
    h_plain:  null,   // AH line opening value e.g. -0.75
    h_v3s:    [],     // closing odds (in order)
    h_v4s:    [],     // opening odds (bold, in order)
    h_sd:     null,   // TL closing
    h_tlopen: null,   // TL opening (rowspan=2 cell)
    // A row accumulations
    a_v3s:    [],
    a_v4s:    [],
  };

  // AH lines are multiples of 0.25 in range 0–2.0;
  // TL values are multiples of 0.25 in range 1.5–4.5
  const isValidHandicapLine = v => {
    const a = Math.abs(v);
    return a >= 0 && a <= 2.25 && Math.abs(a * 4 - Math.round(a * 4)) < 0.01;
  };
  const isValidTlLine = v => {
    return v >= 1.25 && v <= 5.0 && Math.abs(v * 4 - Math.round(v * 4)) < 0.01;
  };

  const rewriter = new HTMLRewriter()
    .on('tr', {
      element() {
        if (s.phase === 'h_row') {
          s.phase = 'a_row';
          s.lastWasSU = false;
        } else if (s.phase === 'a_row') {
          s.phase = 'done';
        }
      },
    })
    .on('td', {
      element(el) {
        s.currentClass   = (el.getAttribute('class') || '').trim();
        s.currentRowspan = el.getAttribute('rowspan') || '';
        s.currentText    = '';
      },
      text(chunk) {
        s.currentText += chunk.text;
        if (!chunk.lastInTextNode) return;

        const txt = s.currentText.trim();
        const cls = s.currentClass;
        const val = parseFloat(txt);

        if (s.phase === 'searching') {
          if (txt === 'Pinnacle') {
            s.phase = 'h_row';
            s.lastWasSU = false;
          }
          return;
        }

        if (s.phase === 'h_row') {
          if (cls.includes('SU')) {
            s.h_su = txt;
            s.lastWasSU = true;
          } else if (cls.includes('SD')) {
            if (!isNaN(val)) s.h_sd = val;
            s.lastWasSU = false;
          } else if (cls.includes('V3')) {
            if (!isNaN(val)) s.h_v3s.push(val);
            s.lastWasSU = false;
          } else if (cls.includes('V4')) {
            if (!isNaN(val)) s.h_v4s.push(val);
            s.lastWasSU = false;
          } else if (s.lastWasSU && !isNaN(val) && isValidHandicapLine(val)) {
            // Plain <td> right after SU = AH line opening
            s.h_plain = val;
            s.lastWasSU = false;
          } else if (s.currentRowspan === '2' && s.h_sd !== null && !isNaN(val) && isValidTlLine(val)) {
            // rowspan=2 cell after SD = TL opening
            s.h_tlopen = val;
            s.lastWasSU = false;
          } else {
            s.lastWasSU = false;
          }
          return;
        }

        if (s.phase === 'a_row') {
          if (cls.includes('V3')) {
            if (!isNaN(val)) s.a_v3s.push(val);
          } else if (cls.includes('V4')) {
            if (!isNaN(val)) s.a_v4s.push(val);
          }
        }
      },
    });

  await rewriter.transform(new Response(tm2Html)).text();

  if (s.phase === 'searching') {
    return { error: 'Pinnacle odds not found — make sure the URL points to a match that includes Pinnacle.' };
  }

  const result = {
    // AH line (Home perspective, negative = Home gives handicap)
    ah_hc: s.h_su    !== null ? parseFloat(s.h_su) : null,
    ah_ho: s.h_plain !== null ? s.h_plain           : null,
    // AH closing odds
    ho_c:  s.h_v3s[0] ?? null,  // Home odds closing
    ho_o:  s.h_v4s[0] ?? null,  // Home odds opening
    ao_c:  s.a_v3s[0] ?? null,  // Away odds closing
    ao_o:  s.a_v4s[0] ?? null,  // Away odds opening
    // Total Line
    tl_c:  s.h_sd      ?? null,
    tl_o:  s.h_tlopen  ?? null,
    // Over/Under odds
    ov_c:  s.h_v3s[1]  ?? null,
    ov_o:  s.h_v4s[1]  ?? null,
    un_c:  s.a_v3s[1]  ?? null,
    un_o:  s.a_v4s[1]  ?? null,
  };

  const hasData = Object.values(result).some(v => v !== null);
  if (!hasData) {
    return { error: 'Parsed Pinnacle section but could not extract odds values — structure may differ for this match.' };
  }

  return result;
}
