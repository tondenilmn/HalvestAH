var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// api/livescore.js
var PINNACLE_HASH = "43fe2ceaef3c97c30c1653416175a8a5a73865ff";
var BOOK_CANDIDATES = [
  PINNACLE_HASH,
  // confirmed Pinnacle hash
  "pinnacle",
  "pin",
  "p55",
  "ps3838"
];
var GS_CANDIDATES = ["Q", "1", "2", "3", "AH", "S", "EU", "A", "ah", "s", "4", "5", "10", "6", "7", "8", "B", "F"];
function makeBotbotHeaders(gS, book) {
  return {
    Origin: "https://www.asianbetsoccer.com",
    Referer: "https://www.asianbetsoccer.com/it/livescore.html",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
    Accept: "*/*",
    "Accept-Language": "it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7",
    "Cache-Control": "no-cache",
    Pragma: "no-cache",
    Cookie: `_cookie_Stats=${gS}; _cookie_Book=${book}; _cookie_LAN=it; _cookie_GMT=1`
  };
}
__name(makeBotbotHeaders, "makeBotbotHeaders");
async function onRequest(context) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json"
  };
  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }
  const reqUrl = new URL(context.request.url);
  const isDebug = reqUrl.searchParams.get("debug") === "1";
  if (isDebug) {
    const ts = Date.now();
    const url = `https://botbot3.space/tables/v4/Q/livegame/${PINNACLE_HASH}.js?date=${ts}&_=${ts + 1}`;
    const r = await fetch(url, { headers: makeBotbotHeaders("Q", PINNACLE_HASH) }).catch((e) => ({ ok: false, status: 0, text: /* @__PURE__ */ __name(async () => e.message, "text") }));
    const body = await r.text();
    const oddsRows = parseGetData2Calls(body);
    let metaRows = parseGetData1Calls(body);
    if (metaRows.length === 0) {
      const tm1Html = extractHtmlFromJs(body, "tablematch1") ?? extractVarFromJs(body, "match1text");
      if (tm1Html) metaRows = parseMatch1HtmlForMeta(tm1Html);
    }
    const matches = mergeMatchData(oddsRows, metaRows);
    const findSample = /* @__PURE__ */ __name((pattern) => {
      const m = new RegExp(pattern).exec(body);
      return m ? body.slice(m.index, m.index + 500) : null;
    }, "findSample");
    return new Response(
      JSON.stringify({
        status: r.status,
        ok: r.ok,
        url,
        raw_len: body.length,
        getData2_count: oddsRows.length,
        getData1_count: metaRows.length,
        meta_count: metaRows.length,
        match_count: matches.length,
        matches_preview: matches.slice(0, 3),
        getData1_sample: findSample("\\bmatch1text\\s*\\+=\\s*getDatalive1\\s*\\("),
        getData2_sample: findSample("\\bmatch2text\\s*\\+=\\s*getData2\\s*\\("),
        m1_assigns_n: (body.match(/match1text\s*\+=/g) || []).length,
        m2_assigns_n: (body.match(/match2text\s*\+=/g) || []).length
      }),
      { headers: cors }
    );
  }
  const timestamp = Date.now();
  let lastError = "";
  for (const book of BOOK_CANDIDATES) {
    for (const gS of GS_CANDIDATES) {
      const dataUrl = `https://botbot3.space/tables/v4/${gS}/livegame/${book}.js?date=${timestamp}&_=${timestamp + 1}`;
      let jsText;
      try {
        const resp = await fetch(dataUrl, { headers: makeBotbotHeaders(gS, book) });
        if (!resp.ok) {
          lastError = `HTTP ${resp.status} (gS=${gS}, book=${book.slice(0, 8)}\u2026)`;
          continue;
        }
        jsText = await resp.text();
      } catch (e) {
        lastError = e.message;
        continue;
      }
      const oddsRows = parseGetData2Calls(jsText);
      if (oddsRows.length === 0) {
        const tm1Html = extractHtmlFromJs(jsText, "tablematch1") ?? extractVarFromJs(jsText, "match1text");
        const tm2Html = extractHtmlFromJs(jsText, "tablematch2") ?? extractVarFromJs(jsText, "match2text");
        if (tm1Html && tm2Html) {
          const matches2 = parseLivegameTables(tm1Html, tm2Html);
          if (matches2.length > 0) {
            return new Response(JSON.stringify({ matches: matches2, gS, book, method: "html" }), { headers: cors });
          }
          return new Response(
            JSON.stringify({ matches: [], note: `No live matches right now (gS=${gS}, book=${book})` }),
            { headers: cors }
          );
        }
        lastError = `200 OK but no getData2() calls or HTML tables (gS=${gS}, book=${book})`;
        continue;
      }
      let metaRows = parseGetData1Calls(jsText);
      if (metaRows.length === 0) {
        const tm1Html = extractHtmlFromJs(jsText, "tablematch1") ?? extractVarFromJs(jsText, "match1text");
        if (tm1Html) metaRows = parseMatch1HtmlForMeta(tm1Html);
      }
      const matches = mergeMatchData(oddsRows, metaRows);
      if (matches.length > 0) {
        return new Response(JSON.stringify({ matches, gS, book, method: "args" }), { headers: cors });
      }
      return new Response(
        JSON.stringify({ matches: [], note: `No live matches right now (gS=${gS}, book=${book})` }),
        { headers: cors }
      );
    }
  }
  return new Response(
    JSON.stringify({
      matches: [],
      note: `Could not reach livegame data. ${lastError}. Add ?debug=1 to /api/livescore to diagnose.`
    }),
    { headers: cors }
  );
}
__name(onRequest, "onRequest");
function extractCallArgs(text, start) {
  let i = start, depth = 0, buf = "", inStr = false, strChar = "";
  const args = [];
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      if (ch === "\\" && i + 1 < text.length) {
        buf += ch + text[i + 1];
        i += 2;
        continue;
      }
      if (ch === strChar) inStr = false;
      buf += ch;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") {
      inStr = true;
      strChar = ch;
      buf += ch;
    } else if ("([{".includes(ch)) {
      depth++;
      buf += ch;
    } else if (")]}".includes(ch)) {
      if (depth === 0) {
        const t = buf.trim();
        if (t) args.push(parseArgValue(t));
        break;
      }
      depth--;
      buf += ch;
    } else if (ch === "," && depth === 0) {
      args.push(parseArgValue(buf.trim()));
      buf = "";
    } else {
      buf += ch;
    }
    i++;
  }
  return args;
}
__name(extractCallArgs, "extractCallArgs");
function parseArgValue(s) {
  if (!s || s === "null" || s === "undefined") return null;
  if ((s[0] === '"' || s[0] === "'") && s.length >= 2 && s[s.length - 1] === s[0]) {
    return s.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "	").replace(/\\r/g, "\r").replace(/\\"/g, '"').replace(/\\'/g, "'").replace(/\\\\/g, "\\");
  }
  const n = parseFloat(s);
  return isNaN(n) ? s : n;
}
__name(parseArgValue, "parseArgValue");
function parseGetData2Calls(jsText) {
  const re = /\bmatch2text\s*\+=\s*getData2\s*\(/g;
  const results = [];
  let m;
  while ((m = re.exec(jsText)) !== null) {
    const args = extractCallArgs(jsText, m.index + m[0].length);
    if (args.length < 31) continue;
    const pf = /* @__PURE__ */ __name((v) => {
      const n = typeof v === "number" ? v : parseFloat(v);
      return isNaN(n) ? null : n;
    }, "pf");
    const matchId = typeof args[4] === "string" && args[4].length >= 20 ? args[4] : null;
    results.push({
      matchId,
      odds: {
        ah_hc: pf(args[5]),
        ah_ho: pf(args[6]),
        ho_c: pf(args[11]),
        ho_o: pf(args[12]),
        ao_c: pf(args[16]),
        ao_o: pf(args[17]),
        tl_c: pf(args[21]),
        tl_o: pf(args[22]),
        ov_c: pf(args[24]),
        ov_o: pf(args[25]),
        un_c: pf(args[29]),
        un_o: pf(args[30])
      }
    });
  }
  return results;
}
__name(parseGetData2Calls, "parseGetData2Calls");
function parseGetData1Calls(jsText) {
  const re = /\bmatch1text\s*\+=\s*getData(?:live|last)1\s*\(/g;
  const results = [];
  let m;
  while ((m = re.exec(jsText)) !== null) {
    const args = extractCallArgs(jsText, m.index + m[0].length);
    if (args.length < 23) continue;
    const matchId = typeof args[5] === "string" && /^[a-f0-9]{20,}$/i.test(args[5]) ? args[5] : null;
    const homeTeam = typeof args[9] === "string" ? args[9] : "";
    const awayTeam = typeof args[22] === "string" ? args[22] : "";
    const league = typeof args[6] === "string" ? args[6] : "";
    const rawTime = typeof args[10] === "string" ? args[10].replace(/\\'/g, "'") : null;
    const minute = rawTime && !rawTime.includes("T") ? rawTime : null;
    let score = null;
    const statusCode = typeof args[4] === "string" ? args[4] : "";
    const scoreM = statusCode.match(/FD(\d{1,2})(\d{1,2})/);
    if (scoreM) score = `${scoreM[1]}-${scoreM[2]}`;
    results.push({ matchId, homeTeam, awayTeam, league, minute, score });
  }
  return results;
}
__name(parseGetData1Calls, "parseGetData1Calls");
function parseMatch1HtmlForMeta(tm1Html) {
  const H_ROW = /<tr[^>]+class=['"][^'"]*tr\d+[^'"]*['"][^>]*>\s*<td[^>]*>H<\/td>([\s\S]*?)<\/tr>/gi;
  const A_ROW = /<tr[^>]+class=['"][^'"]*tr\d+[^'"]*['"][^>]*>\s*<td[^>]*>A<\/td>([\s\S]*?)<\/tr>/gi;
  const hRows = [...tm1Html.matchAll(H_ROW)].map((m) => m[1]);
  const aRows = [...tm1Html.matchAll(A_ROW)].map((m) => m[1]);
  const count = Math.min(hRows.length, aRows.length);
  const results = [];
  for (let i = 0; i < count; i++) {
    const h1 = parseTds(hRows[i]);
    const a1 = parseTds(aRows[i]);
    const matchId = getMatchId(hRows[i]) ?? getMatchId(aRows[i]);
    const homeTeam = h1[0] != null ? getText(h1[0]) : "";
    const awayTeam = a1[0] != null ? getText(a1[0]) : "";
    const rowText = (hRows[i] + aRows[i]).replace(/<[^>]+>/g, " ");
    const scoreM = rowText.match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/);
    const score = scoreM ? `${scoreM[1]}-${scoreM[2]}` : null;
    results.push({ matchId, homeTeam, awayTeam, score });
  }
  return results;
}
__name(parseMatch1HtmlForMeta, "parseMatch1HtmlForMeta");
function mergeMatchData(oddsRows, metaRows) {
  const metaByMatchId = /* @__PURE__ */ new Map();
  for (const meta of metaRows) {
    if (meta.matchId) metaByMatchId.set(meta.matchId, meta);
  }
  const matches = [];
  for (let i = 0; i < oddsRows.length; i++) {
    const { matchId, odds } = oddsRows[i];
    const meta = matchId && metaByMatchId.has(matchId) ? metaByMatchId.get(matchId) : metaRows[i] || {};
    const id = matchId || meta.matchId || null;
    const url = id ? `https://www.asianbetsoccer.com/it/match.html?id=${id}` : null;
    if (odds.ah_hc === null && odds.ho_c === null && odds.tl_c === null) continue;
    matches.push({
      id,
      url,
      home_team: meta.homeTeam || "",
      away_team: meta.awayTeam || "",
      league: meta.league || "",
      minute: meta.minute || null,
      score: meta.score || null,
      odds
    });
  }
  return matches;
}
__name(mergeMatchData, "mergeMatchData");
function extractHtmlFromJs(jsText, tableId) {
  const marker = `$("#${tableId}").html("`;
  const start = jsText.indexOf(marker);
  if (start === -1) return null;
  let i = start + marker.length;
  const chars = [];
  while (i < jsText.length) {
    const ch = jsText[i];
    if (ch === "\\" && i + 1 < jsText.length) {
      const nx = jsText[i + 1];
      if (nx === '"') chars.push('"');
      else if (nx === "'") chars.push("'");
      else if (nx === "\\") chars.push("\\");
      else if (nx === "n") chars.push("\n");
      else if (nx === "r") chars.push("\r");
      else if (nx === "t") chars.push("	");
      else chars.push(nx);
      i += 2;
    } else if (ch === '"') {
      break;
    } else {
      chars.push(ch);
      i++;
    }
  }
  return chars.join("");
}
__name(extractHtmlFromJs, "extractHtmlFromJs");
function extractQuotedString(text, startIdx) {
  let i = startIdx;
  while (i < text.length && (text[i] === " " || text[i] === "	")) i++;
  if (i >= text.length) return null;
  const quote = text[i];
  if (quote !== '"' && quote !== "'") return null;
  i++;
  const chars = [];
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\" && i + 1 < text.length) {
      const nx = text[i + 1];
      if (nx === '"') chars.push('"');
      else if (nx === "'") chars.push("'");
      else if (nx === "\\") chars.push("\\");
      else if (nx === "n") chars.push("\n");
      else if (nx === "r") chars.push("\r");
      else if (nx === "t") chars.push("	");
      else chars.push(nx);
      i += 2;
    } else if (ch === quote) {
      break;
    } else {
      chars.push(ch);
      i++;
    }
  }
  return chars.join("");
}
__name(extractQuotedString, "extractQuotedString");
function extractVarFromJs(jsText, varName) {
  const appendRe = new RegExp(`\\b${varName}\\s*\\+=\\s*["']`, "g");
  const parts = [];
  let m;
  while ((m = appendRe.exec(jsText)) !== null) {
    const chunk = extractQuotedString(jsText, m.index + m[0].length - 1);
    if (chunk !== null) parts.push(chunk);
  }
  if (parts.length > 0) return parts.join("");
  const assignRe = new RegExp(`\\b${varName}\\s*=\\s*["']`);
  const am = assignRe.exec(jsText);
  if (!am) return null;
  const result = extractQuotedString(jsText, am.index + am[0].length - 1);
  return result && result.length > 0 ? result : null;
}
__name(extractVarFromJs, "extractVarFromJs");
var parseTds = /* @__PURE__ */ __name((html) => [...html.matchAll(/<td[^>]*>([\s\S]*?)<\/td>/g)].map((m) => m[1]), "parseTds");
var getText = /* @__PURE__ */ __name((s) => s.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(), "getText");
var pfHtml = /* @__PURE__ */ __name((s) => {
  const n = parseFloat(getText(s));
  return isNaN(n) ? null : n;
}, "pfHtml");
var getMatchId = /* @__PURE__ */ __name((html) => {
  const m = html.match(/href=["'][^"']*[?&]id=([a-fA-F0-9]+)/i);
  return m ? m[1] : null;
}, "getMatchId");
function parseLivegameTables(tm1Html, tm2Html) {
  const H_ROW = /<tr[^>]+class=['"][^'"]*tr\d+[^'"]*['"][^>]*>\s*<td[^>]*>H<\/td>([\s\S]*?)<\/tr>/gi;
  const A_ROW = /<tr[^>]+class=['"][^'"]*tr\d+[^'"]*['"][^>]*>\s*<td[^>]*>A<\/td>([\s\S]*?)<\/tr>/gi;
  const hRows1 = [...tm1Html.matchAll(H_ROW)].map((m) => m[1]);
  const aRows1 = [...tm1Html.matchAll(A_ROW)].map((m) => m[1]);
  const hRows2 = [...tm2Html.matchAll(H_ROW)].map((m) => m[1]);
  const aRows2 = [...tm2Html.matchAll(A_ROW)].map((m) => m[1]);
  const count = Math.min(hRows1.length, aRows1.length, hRows2.length, aRows2.length);
  const matches = [];
  for (let i = 0; i < count; i++) {
    const h1 = parseTds(hRows1[i]);
    const a1 = parseTds(aRows1[i]);
    const h2 = parseTds(hRows2[i]);
    const a2 = parseTds(aRows2[i]);
    const id = getMatchId(hRows1[i]) ?? getMatchId(aRows1[i]);
    const url = id ? `https://www.asianbetsoccer.com/it/match.html?id=${id}` : null;
    const homeName = h1[0] != null ? getText(h1[0]) : "";
    const awayName = a1[0] != null ? getText(a1[0]) : "";
    const rowText = (hRows1[i] + aRows1[i]).replace(/<[^>]+>/g, " ");
    const scoreM = rowText.match(/\b(\d{1,2})\s*[-–]\s*(\d{1,2})\b/);
    const score = scoreM ? `${scoreM[1]}-${scoreM[2]}` : null;
    const odds = {
      ah_hc: pfHtml(h2[0]),
      ah_ho: pfHtml(h2[1]),
      ho_c: pfHtml(h2[3]),
      ho_o: pfHtml(h2[4]),
      ao_c: pfHtml(a2[3]),
      ao_o: pfHtml(a2[4]),
      tl_c: pfHtml(h2[5]),
      tl_o: pfHtml(h2[6]),
      ov_c: pfHtml(h2[9]),
      ov_o: pfHtml(h2[10]),
      un_c: pfHtml(a2[7]),
      un_o: pfHtml(a2[8])
    };
    if (!homeName && !awayName) continue;
    if (odds.ah_hc === null && odds.ho_c === null) continue;
    matches.push({ id, url, home_team: homeName, away_team: awayName, score, odds });
  }
  return matches;
}
__name(parseLivegameTables, "parseLivegameTables");

// api/scrape.js
async function onRequest2(context) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Content-Type": "application/json"
  };
  if (context.request.method === "OPTIONS") {
    return new Response(null, { headers: cors });
  }
  const reqUrl = new URL(context.request.url);
  const matchUrl = reqUrl.searchParams.get("url");
  if (!matchUrl) {
    return new Response(JSON.stringify({ error: "Missing url parameter" }), { status: 400, headers: cors });
  }
  const idMatch = matchUrl.match(/[?&]id=([a-fA-F0-9]+)/);
  if (!idMatch) {
    return new Response(
      JSON.stringify({ error: "Invalid URL \u2014 expected an asianbetsoccer.com match link containing ?id=\u2026" }),
      { status: 400, headers: cors }
    );
  }
  const matchId = idMatch[1];
  const dataUrl = `https://botbot3.space/tables/v4/oddsComp/${matchId}.js`;
  let jsText;
  try {
    const resp = await fetch(dataUrl, {
      headers: {
        Origin: "https://www.asianbetsoccer.com",
        Referer: "https://www.asianbetsoccer.com/",
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "*/*",
        "Accept-Language": "en-US,en;q=0.9"
      }
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
__name(onRequest2, "onRequest");
function extractHtml(jsText, tableId) {
  const marker = `$("#${tableId}").html("`;
  const start = jsText.indexOf(marker);
  if (start === -1) return null;
  let i = start + marker.length;
  const chars = [];
  while (i < jsText.length) {
    const ch = jsText[i];
    if (ch === "\\" && i + 1 < jsText.length) {
      const nx = jsText[i + 1];
      if (nx === '"') chars.push('"');
      else if (nx === "'") chars.push("'");
      else if (nx === "\\") chars.push("\\");
      else if (nx === "n") chars.push("\n");
      else if (nx === "r") chars.push("\r");
      else if (nx === "t") chars.push("	");
      else chars.push(nx);
      i += 2;
    } else if (ch === '"') {
      break;
    } else {
      chars.push(ch);
      i++;
    }
  }
  return chars.join("");
}
__name(extractHtml, "extractHtml");
function parseMatchData(jsText) {
  const tm1Html = extractHtml(jsText, "tablematch1");
  if (!tm1Html) {
    const preview = jsText.slice(0, 120).replace(/\n/g, " ");
    return { error: `Could not extract match data. Response preview: "${preview}"` };
  }
  const bookmakers = [...tm1Html.matchAll(/class='bnfsd'>([^<]+)</g)].map((m) => m[1].trim());
  const pinIdx = bookmakers.findIndex((b) => b.includes("Pinnacle"));
  if (pinIdx === -1) {
    return { error: "Pinnacle odds not found \u2014 make sure the URL points to a match that includes Pinnacle." };
  }
  const tm2Html = extractHtml(jsText, "tablematch2");
  if (!tm2Html) {
    return { error: "Could not extract AH/TL data \u2014 source format may have changed" };
  }
  const groups = tm2Html.split("<tr class='vrng'><td colspan='25'></td></tr>");
  if (pinIdx >= groups.length) {
    return { error: "Pinnacle AH odds not available for this match." };
  }
  const pinGroup = groups[pinIdx];
  const hRowMatch = pinGroup.match(/<tr[^>]*><td>H<\/td>(.*?)<\/tr>/);
  const aRowMatch = pinGroup.match(/<tr[^>]*><td>A<\/td>(.*?)<\/tr>/);
  if (!hRowMatch || !aRowMatch) {
    return { error: "Could not parse Pinnacle AH row structure." };
  }
  const parseTds2 = /* @__PURE__ */ __name((html) => [...html.matchAll(/<td[^>]*>([^<]*)<\/td>/g)].map((m) => m[1].trim()), "parseTds");
  const pf = /* @__PURE__ */ __name((v) => {
    const n = parseFloat(v);
    return isNaN(n) ? null : n;
  }, "pf");
  const h = parseTds2(hRowMatch[1]);
  const a = parseTds2(aRowMatch[1]);
  const result = {
    ah_hc: pf(h[0]),
    // AH home closing line
    ah_ho: pf(h[1]),
    // AH home opening line
    ho_c: pf(h[3]),
    // Home odds closing
    ho_o: pf(h[4]),
    // Home odds opening
    tl_c: pf(h[5]),
    // Total line closing (rowspan=2 cell)
    tl_o: pf(h[6]),
    // Total line opening (rowspan=2 cell)
    ov_c: pf(h[9]),
    // Over odds closing
    ov_o: pf(h[10]),
    // Over odds opening
    ao_c: pf(a[3]),
    // Away odds closing
    ao_o: pf(a[4]),
    // Away odds opening
    un_c: pf(a[7]),
    // Under odds closing
    un_o: pf(a[8])
    // Under odds opening
  };
  const hasData = Object.values(result).some((v) => v !== null);
  if (!hasData) {
    return { error: "Parsed Pinnacle section but could not extract odds values \u2014 structure may differ for this match." };
  }
  return result;
}
__name(parseMatchData, "parseMatchData");

// ../.wrangler/tmp/pages-8fIAjJ/functionsRoutes-0.7924813637302343.mjs
var routes = [
  {
    routePath: "/api/livescore",
    mountPath: "/api",
    method: "",
    middlewares: [],
    modules: [onRequest]
  },
  {
    routePath: "/api/scrape",
    mountPath: "/api",
    method: "",
    middlewares: [],
    modules: [onRequest2]
  }
];

// ../../../../../../../AppData/Roaming/npm/node_modules/wrangler/node_modules/path-to-regexp/dist.es2015/index.js
function lexer(str) {
  var tokens = [];
  var i = 0;
  while (i < str.length) {
    var char = str[i];
    if (char === "*" || char === "+" || char === "?") {
      tokens.push({ type: "MODIFIER", index: i, value: str[i++] });
      continue;
    }
    if (char === "\\") {
      tokens.push({ type: "ESCAPED_CHAR", index: i++, value: str[i++] });
      continue;
    }
    if (char === "{") {
      tokens.push({ type: "OPEN", index: i, value: str[i++] });
      continue;
    }
    if (char === "}") {
      tokens.push({ type: "CLOSE", index: i, value: str[i++] });
      continue;
    }
    if (char === ":") {
      var name = "";
      var j = i + 1;
      while (j < str.length) {
        var code = str.charCodeAt(j);
        if (
          // `0-9`
          code >= 48 && code <= 57 || // `A-Z`
          code >= 65 && code <= 90 || // `a-z`
          code >= 97 && code <= 122 || // `_`
          code === 95
        ) {
          name += str[j++];
          continue;
        }
        break;
      }
      if (!name)
        throw new TypeError("Missing parameter name at ".concat(i));
      tokens.push({ type: "NAME", index: i, value: name });
      i = j;
      continue;
    }
    if (char === "(") {
      var count = 1;
      var pattern = "";
      var j = i + 1;
      if (str[j] === "?") {
        throw new TypeError('Pattern cannot start with "?" at '.concat(j));
      }
      while (j < str.length) {
        if (str[j] === "\\") {
          pattern += str[j++] + str[j++];
          continue;
        }
        if (str[j] === ")") {
          count--;
          if (count === 0) {
            j++;
            break;
          }
        } else if (str[j] === "(") {
          count++;
          if (str[j + 1] !== "?") {
            throw new TypeError("Capturing groups are not allowed at ".concat(j));
          }
        }
        pattern += str[j++];
      }
      if (count)
        throw new TypeError("Unbalanced pattern at ".concat(i));
      if (!pattern)
        throw new TypeError("Missing pattern at ".concat(i));
      tokens.push({ type: "PATTERN", index: i, value: pattern });
      i = j;
      continue;
    }
    tokens.push({ type: "CHAR", index: i, value: str[i++] });
  }
  tokens.push({ type: "END", index: i, value: "" });
  return tokens;
}
__name(lexer, "lexer");
function parse(str, options) {
  if (options === void 0) {
    options = {};
  }
  var tokens = lexer(str);
  var _a = options.prefixes, prefixes = _a === void 0 ? "./" : _a, _b = options.delimiter, delimiter = _b === void 0 ? "/#?" : _b;
  var result = [];
  var key = 0;
  var i = 0;
  var path = "";
  var tryConsume = /* @__PURE__ */ __name(function(type) {
    if (i < tokens.length && tokens[i].type === type)
      return tokens[i++].value;
  }, "tryConsume");
  var mustConsume = /* @__PURE__ */ __name(function(type) {
    var value2 = tryConsume(type);
    if (value2 !== void 0)
      return value2;
    var _a2 = tokens[i], nextType = _a2.type, index = _a2.index;
    throw new TypeError("Unexpected ".concat(nextType, " at ").concat(index, ", expected ").concat(type));
  }, "mustConsume");
  var consumeText = /* @__PURE__ */ __name(function() {
    var result2 = "";
    var value2;
    while (value2 = tryConsume("CHAR") || tryConsume("ESCAPED_CHAR")) {
      result2 += value2;
    }
    return result2;
  }, "consumeText");
  var isSafe = /* @__PURE__ */ __name(function(value2) {
    for (var _i = 0, delimiter_1 = delimiter; _i < delimiter_1.length; _i++) {
      var char2 = delimiter_1[_i];
      if (value2.indexOf(char2) > -1)
        return true;
    }
    return false;
  }, "isSafe");
  var safePattern = /* @__PURE__ */ __name(function(prefix2) {
    var prev = result[result.length - 1];
    var prevText = prefix2 || (prev && typeof prev === "string" ? prev : "");
    if (prev && !prevText) {
      throw new TypeError('Must have text between two parameters, missing text after "'.concat(prev.name, '"'));
    }
    if (!prevText || isSafe(prevText))
      return "[^".concat(escapeString(delimiter), "]+?");
    return "(?:(?!".concat(escapeString(prevText), ")[^").concat(escapeString(delimiter), "])+?");
  }, "safePattern");
  while (i < tokens.length) {
    var char = tryConsume("CHAR");
    var name = tryConsume("NAME");
    var pattern = tryConsume("PATTERN");
    if (name || pattern) {
      var prefix = char || "";
      if (prefixes.indexOf(prefix) === -1) {
        path += prefix;
        prefix = "";
      }
      if (path) {
        result.push(path);
        path = "";
      }
      result.push({
        name: name || key++,
        prefix,
        suffix: "",
        pattern: pattern || safePattern(prefix),
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    var value = char || tryConsume("ESCAPED_CHAR");
    if (value) {
      path += value;
      continue;
    }
    if (path) {
      result.push(path);
      path = "";
    }
    var open = tryConsume("OPEN");
    if (open) {
      var prefix = consumeText();
      var name_1 = tryConsume("NAME") || "";
      var pattern_1 = tryConsume("PATTERN") || "";
      var suffix = consumeText();
      mustConsume("CLOSE");
      result.push({
        name: name_1 || (pattern_1 ? key++ : ""),
        pattern: name_1 && !pattern_1 ? safePattern(prefix) : pattern_1,
        prefix,
        suffix,
        modifier: tryConsume("MODIFIER") || ""
      });
      continue;
    }
    mustConsume("END");
  }
  return result;
}
__name(parse, "parse");
function match(str, options) {
  var keys = [];
  var re = pathToRegexp(str, keys, options);
  return regexpToFunction(re, keys, options);
}
__name(match, "match");
function regexpToFunction(re, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.decode, decode = _a === void 0 ? function(x) {
    return x;
  } : _a;
  return function(pathname) {
    var m = re.exec(pathname);
    if (!m)
      return false;
    var path = m[0], index = m.index;
    var params = /* @__PURE__ */ Object.create(null);
    var _loop_1 = /* @__PURE__ */ __name(function(i2) {
      if (m[i2] === void 0)
        return "continue";
      var key = keys[i2 - 1];
      if (key.modifier === "*" || key.modifier === "+") {
        params[key.name] = m[i2].split(key.prefix + key.suffix).map(function(value) {
          return decode(value, key);
        });
      } else {
        params[key.name] = decode(m[i2], key);
      }
    }, "_loop_1");
    for (var i = 1; i < m.length; i++) {
      _loop_1(i);
    }
    return { path, index, params };
  };
}
__name(regexpToFunction, "regexpToFunction");
function escapeString(str) {
  return str.replace(/([.+*?=^!:${}()[\]|/\\])/g, "\\$1");
}
__name(escapeString, "escapeString");
function flags(options) {
  return options && options.sensitive ? "" : "i";
}
__name(flags, "flags");
function regexpToRegexp(path, keys) {
  if (!keys)
    return path;
  var groupsRegex = /\((?:\?<(.*?)>)?(?!\?)/g;
  var index = 0;
  var execResult = groupsRegex.exec(path.source);
  while (execResult) {
    keys.push({
      // Use parenthesized substring match if available, index otherwise
      name: execResult[1] || index++,
      prefix: "",
      suffix: "",
      modifier: "",
      pattern: ""
    });
    execResult = groupsRegex.exec(path.source);
  }
  return path;
}
__name(regexpToRegexp, "regexpToRegexp");
function arrayToRegexp(paths, keys, options) {
  var parts = paths.map(function(path) {
    return pathToRegexp(path, keys, options).source;
  });
  return new RegExp("(?:".concat(parts.join("|"), ")"), flags(options));
}
__name(arrayToRegexp, "arrayToRegexp");
function stringToRegexp(path, keys, options) {
  return tokensToRegexp(parse(path, options), keys, options);
}
__name(stringToRegexp, "stringToRegexp");
function tokensToRegexp(tokens, keys, options) {
  if (options === void 0) {
    options = {};
  }
  var _a = options.strict, strict = _a === void 0 ? false : _a, _b = options.start, start = _b === void 0 ? true : _b, _c = options.end, end = _c === void 0 ? true : _c, _d = options.encode, encode = _d === void 0 ? function(x) {
    return x;
  } : _d, _e = options.delimiter, delimiter = _e === void 0 ? "/#?" : _e, _f = options.endsWith, endsWith = _f === void 0 ? "" : _f;
  var endsWithRe = "[".concat(escapeString(endsWith), "]|$");
  var delimiterRe = "[".concat(escapeString(delimiter), "]");
  var route = start ? "^" : "";
  for (var _i = 0, tokens_1 = tokens; _i < tokens_1.length; _i++) {
    var token = tokens_1[_i];
    if (typeof token === "string") {
      route += escapeString(encode(token));
    } else {
      var prefix = escapeString(encode(token.prefix));
      var suffix = escapeString(encode(token.suffix));
      if (token.pattern) {
        if (keys)
          keys.push(token);
        if (prefix || suffix) {
          if (token.modifier === "+" || token.modifier === "*") {
            var mod = token.modifier === "*" ? "?" : "";
            route += "(?:".concat(prefix, "((?:").concat(token.pattern, ")(?:").concat(suffix).concat(prefix, "(?:").concat(token.pattern, "))*)").concat(suffix, ")").concat(mod);
          } else {
            route += "(?:".concat(prefix, "(").concat(token.pattern, ")").concat(suffix, ")").concat(token.modifier);
          }
        } else {
          if (token.modifier === "+" || token.modifier === "*") {
            throw new TypeError('Can not repeat "'.concat(token.name, '" without a prefix and suffix'));
          }
          route += "(".concat(token.pattern, ")").concat(token.modifier);
        }
      } else {
        route += "(?:".concat(prefix).concat(suffix, ")").concat(token.modifier);
      }
    }
  }
  if (end) {
    if (!strict)
      route += "".concat(delimiterRe, "?");
    route += !options.endsWith ? "$" : "(?=".concat(endsWithRe, ")");
  } else {
    var endToken = tokens[tokens.length - 1];
    var isEndDelimited = typeof endToken === "string" ? delimiterRe.indexOf(endToken[endToken.length - 1]) > -1 : endToken === void 0;
    if (!strict) {
      route += "(?:".concat(delimiterRe, "(?=").concat(endsWithRe, "))?");
    }
    if (!isEndDelimited) {
      route += "(?=".concat(delimiterRe, "|").concat(endsWithRe, ")");
    }
  }
  return new RegExp(route, flags(options));
}
__name(tokensToRegexp, "tokensToRegexp");
function pathToRegexp(path, keys, options) {
  if (path instanceof RegExp)
    return regexpToRegexp(path, keys);
  if (Array.isArray(path))
    return arrayToRegexp(path, keys, options);
  return stringToRegexp(path, keys, options);
}
__name(pathToRegexp, "pathToRegexp");

// ../../../../../../../AppData/Roaming/npm/node_modules/wrangler/templates/pages-template-worker.ts
var escapeRegex = /[.+?^${}()|[\]\\]/g;
function* executeRequest(request) {
  const requestPath = new URL(request.url).pathname;
  for (const route of [...routes].reverse()) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult) {
      for (const handler of route.middlewares.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: mountMatchResult.path
        };
      }
    }
  }
  for (const route of routes) {
    if (route.method && route.method !== request.method) {
      continue;
    }
    const routeMatcher = match(route.routePath.replace(escapeRegex, "\\$&"), {
      end: true
    });
    const mountMatcher = match(route.mountPath.replace(escapeRegex, "\\$&"), {
      end: false
    });
    const matchResult = routeMatcher(requestPath);
    const mountMatchResult = mountMatcher(requestPath);
    if (matchResult && mountMatchResult && route.modules.length) {
      for (const handler of route.modules.flat()) {
        yield {
          handler,
          params: matchResult.params,
          path: matchResult.path
        };
      }
      break;
    }
  }
}
__name(executeRequest, "executeRequest");
var pages_template_worker_default = {
  async fetch(originalRequest, env, workerContext) {
    let request = originalRequest;
    const handlerIterator = executeRequest(request);
    let data = {};
    let isFailOpen = false;
    const next = /* @__PURE__ */ __name(async (input, init) => {
      if (input !== void 0) {
        let url = input;
        if (typeof input === "string") {
          url = new URL(input, request.url).toString();
        }
        request = new Request(url, init);
      }
      const result = handlerIterator.next();
      if (result.done === false) {
        const { handler, params, path } = result.value;
        const context = {
          request: new Request(request.clone()),
          functionPath: path,
          next,
          params,
          get data() {
            return data;
          },
          set data(value) {
            if (typeof value !== "object" || value === null) {
              throw new Error("context.data must be an object");
            }
            data = value;
          },
          env,
          waitUntil: workerContext.waitUntil.bind(workerContext),
          passThroughOnException: /* @__PURE__ */ __name(() => {
            isFailOpen = true;
          }, "passThroughOnException")
        };
        const response = await handler(context);
        if (!(response instanceof Response)) {
          throw new Error("Your Pages function should return a Response");
        }
        return cloneResponse(response);
      } else if ("ASSETS") {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      } else {
        const response = await fetch(request);
        return cloneResponse(response);
      }
    }, "next");
    try {
      return await next();
    } catch (error) {
      if (isFailOpen) {
        const response = await env["ASSETS"].fetch(request);
        return cloneResponse(response);
      }
      throw error;
    }
  }
};
var cloneResponse = /* @__PURE__ */ __name((response) => (
  // https://fetch.spec.whatwg.org/#null-body-status
  new Response(
    [101, 204, 205, 304].includes(response.status) ? null : response.body,
    response
  )
), "cloneResponse");

// ../../../../../../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-ensure-req-body-drained.ts
var drainBody = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } finally {
    try {
      if (request.body !== null && !request.bodyUsed) {
        const reader = request.body.getReader();
        while (!(await reader.read()).done) {
        }
      }
    } catch (e) {
      console.error("Failed to drain the unused request body.", e);
    }
  }
}, "drainBody");
var middleware_ensure_req_body_drained_default = drainBody;

// ../../../../../../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/middleware-miniflare3-json-error.ts
function reduceError(e) {
  return {
    name: e?.name,
    message: e?.message ?? String(e),
    stack: e?.stack,
    cause: e?.cause === void 0 ? void 0 : reduceError(e.cause)
  };
}
__name(reduceError, "reduceError");
var jsonError = /* @__PURE__ */ __name(async (request, env, _ctx, middlewareCtx) => {
  try {
    return await middlewareCtx.next(request, env);
  } catch (e) {
    const error = reduceError(e);
    return Response.json(error, {
      status: 500,
      headers: { "MF-Experimental-Error-Stack": "true" }
    });
  }
}, "jsonError");
var middleware_miniflare3_json_error_default = jsonError;

// ../.wrangler/tmp/bundle-XlB9h6/middleware-insertion-facade.js
var __INTERNAL_WRANGLER_MIDDLEWARE__ = [
  middleware_ensure_req_body_drained_default,
  middleware_miniflare3_json_error_default
];
var middleware_insertion_facade_default = pages_template_worker_default;

// ../../../../../../../AppData/Roaming/npm/node_modules/wrangler/templates/middleware/common.ts
var __facade_middleware__ = [];
function __facade_register__(...args) {
  __facade_middleware__.push(...args.flat());
}
__name(__facade_register__, "__facade_register__");
function __facade_invokeChain__(request, env, ctx, dispatch, middlewareChain) {
  const [head, ...tail] = middlewareChain;
  const middlewareCtx = {
    dispatch,
    next(newRequest, newEnv) {
      return __facade_invokeChain__(newRequest, newEnv, ctx, dispatch, tail);
    }
  };
  return head(request, env, ctx, middlewareCtx);
}
__name(__facade_invokeChain__, "__facade_invokeChain__");
function __facade_invoke__(request, env, ctx, dispatch, finalMiddleware) {
  return __facade_invokeChain__(request, env, ctx, dispatch, [
    ...__facade_middleware__,
    finalMiddleware
  ]);
}
__name(__facade_invoke__, "__facade_invoke__");

// ../.wrangler/tmp/bundle-XlB9h6/middleware-loader.entry.ts
var __Facade_ScheduledController__ = class ___Facade_ScheduledController__ {
  constructor(scheduledTime, cron, noRetry) {
    this.scheduledTime = scheduledTime;
    this.cron = cron;
    this.#noRetry = noRetry;
  }
  static {
    __name(this, "__Facade_ScheduledController__");
  }
  #noRetry;
  noRetry() {
    if (!(this instanceof ___Facade_ScheduledController__)) {
      throw new TypeError("Illegal invocation");
    }
    this.#noRetry();
  }
};
function wrapExportedHandler(worker) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return worker;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  const fetchDispatcher = /* @__PURE__ */ __name(function(request, env, ctx) {
    if (worker.fetch === void 0) {
      throw new Error("Handler does not export a fetch() function.");
    }
    return worker.fetch(request, env, ctx);
  }, "fetchDispatcher");
  return {
    ...worker,
    fetch(request, env, ctx) {
      const dispatcher = /* @__PURE__ */ __name(function(type, init) {
        if (type === "scheduled" && worker.scheduled !== void 0) {
          const controller = new __Facade_ScheduledController__(
            Date.now(),
            init.cron ?? "",
            () => {
            }
          );
          return worker.scheduled(controller, env, ctx);
        }
      }, "dispatcher");
      return __facade_invoke__(request, env, ctx, dispatcher, fetchDispatcher);
    }
  };
}
__name(wrapExportedHandler, "wrapExportedHandler");
function wrapWorkerEntrypoint(klass) {
  if (__INTERNAL_WRANGLER_MIDDLEWARE__ === void 0 || __INTERNAL_WRANGLER_MIDDLEWARE__.length === 0) {
    return klass;
  }
  for (const middleware of __INTERNAL_WRANGLER_MIDDLEWARE__) {
    __facade_register__(middleware);
  }
  return class extends klass {
    #fetchDispatcher = /* @__PURE__ */ __name((request, env, ctx) => {
      this.env = env;
      this.ctx = ctx;
      if (super.fetch === void 0) {
        throw new Error("Entrypoint class does not define a fetch() function.");
      }
      return super.fetch(request);
    }, "#fetchDispatcher");
    #dispatcher = /* @__PURE__ */ __name((type, init) => {
      if (type === "scheduled" && super.scheduled !== void 0) {
        const controller = new __Facade_ScheduledController__(
          Date.now(),
          init.cron ?? "",
          () => {
          }
        );
        return super.scheduled(controller);
      }
    }, "#dispatcher");
    fetch(request) {
      return __facade_invoke__(
        request,
        this.env,
        this.ctx,
        this.#dispatcher,
        this.#fetchDispatcher
      );
    }
  };
}
__name(wrapWorkerEntrypoint, "wrapWorkerEntrypoint");
var WRAPPED_ENTRY;
if (typeof middleware_insertion_facade_default === "object") {
  WRAPPED_ENTRY = wrapExportedHandler(middleware_insertion_facade_default);
} else if (typeof middleware_insertion_facade_default === "function") {
  WRAPPED_ENTRY = wrapWorkerEntrypoint(middleware_insertion_facade_default);
}
var middleware_loader_entry_default = WRAPPED_ENTRY;
export {
  __INTERNAL_WRANGLER_MIDDLEWARE__,
  middleware_loader_entry_default as default
};
//# sourceMappingURL=functionsWorker-0.8480685121507974.mjs.map
