// Scans static/data/ and writes manifest.json automatically.
// Run: node build.js
// Cloudflare Pages build command: node build.js

const fs   = require('fs');
const path = require('path');

const dataDir    = path.join(__dirname, 'static', 'data');
const manifestPath = path.join(dataDir, 'manifest.json');

if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const files = fs.readdirSync(dataDir)
  .filter(f => f.toLowerCase().endsWith('.csv'))
  .sort();

fs.writeFileSync(manifestPath, JSON.stringify({ files }, null, 2));
console.log(`manifest.json updated — ${files.length} file(s):`);
files.forEach(f => console.log(`  · ${f}`));
