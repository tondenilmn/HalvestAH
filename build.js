// Scans static/data/ recursively and writes manifest.json automatically.
// Supports nested folders, e.g. data/Pinnacle/January25/file.csv
// Run: node build.js
// Cloudflare Pages build command: node build.js

const fs   = require('fs');
const path = require('path');

const dataDir      = path.join(__dirname, 'static', 'data');
const manifestPath = path.join(dataDir, 'manifest.json');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

function collectCsvs(dir, prefix) {
  const results = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...collectCsvs(path.join(dir, entry.name), rel));
    } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.csv')) {
      results.push(rel);
    }
  }
  return results.sort();
}

const files = collectCsvs(dataDir, '');

fs.writeFileSync(manifestPath, JSON.stringify({ files }, null, 2));
console.log(`manifest.json updated — ${files.length} file(s):`);
files.forEach(f => console.log(`  · ${f}`));
