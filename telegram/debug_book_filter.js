'use strict';
// Dump every #book_filter option (label + hash) from asianbetsoccer's
// livescore page, to see the exact "Bet365 Live" entry the user pointed to
// (distinct from plain "Bet365") and its hash. Run manually.

const HEADER_SETS = [
  {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
    'Accept-Language': 'it-IT,it;q=0.9,en-US;q=0.8,en;q=0.7',
  },
  { 'User-Agent': 'Mozilla/5.0' },
];

async function fetchHtml() {
  for (const headers of HEADER_SETS) {
    try {
      const resp = await fetch('https://www.asianbetsoccer.com/it/livescore.html', { headers });
      console.log(`UA "${headers['User-Agent'].slice(0, 30)}…" → HTTP ${resp.status}`);
      if (resp.ok) return await resp.text();
    } catch (e) {
      console.log(`  fetch threw: ${e.message}`);
    }
  }
  return null;
}

async function main() {
  const html = await fetchHtml();
  if (!html) { console.log('Could not fetch livescore.html at all.'); return; }
  console.log(`\nHTML length: ${html.length}\n`);

  const optRe = /value="([a-f0-9]{40})"[^>]*>\s*([^<]+)/gi;
  let m, count = 0;
  console.log('--- #book_filter-style options found (hash + label) ---');
  while ((m = optRe.exec(html)) !== null) {
    console.log(`  ${m[1]}  ->  "${m[2].trim()}"`);
    count++;
  }
  console.log(`\n${count} option(s) found total.`);

  // Also show raw context around any "live" (case-insens) mention near a hash,
  // in case the select markup differs from the generic 40-hex-value pattern.
  const liveIdx = html.toLowerCase().indexOf('bet365 live');
  if (liveIdx >= 0) {
    console.log('\n--- raw context around "bet365 live" ---');
    console.log(html.slice(Math.max(0, liveIdx - 200), liveIdx + 200));
  } else {
    console.log('\n(no literal "bet365 live" substring found in HTML — label may differ in casing/spacing)');
  }
}

main().catch(e => { console.error('FATAL:', e); process.exit(1); });
