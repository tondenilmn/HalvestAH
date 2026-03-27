'use strict';
// Quick format test — sends a fake notification to Telegram to preview layout.
// Usage: node test_format.js

const { formatMessage, formatHtMessage } = require('./notify_exports');

// If notify.js doesn't export these, run this instead:
// node -e "require('./notify'); process.exit()" will fail, so we inline the test.

// ── Patch: inline the formatters directly for testing ─────────────────────────
const cfg = require('./config');

function nowStamp() {
  const d = new Date();
  const dd   = String(d.getDate()).padStart(2, '0');
  const mm   = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = d.getFullYear();
  const hh   = String(d.getHours()).padStart(2, '0');
  const min  = String(d.getMinutes()).padStart(2, '0');
  return { date: `${dd}/${mm}/${yyyy}`, time: `${hh}:${min}` };
}
function betTypeInfo(minute) {
  const n = minute ? parseInt(minute, 10) : NaN;
  if (isNaN(n)) return { label: 'PreMatch', icon: '⏳' };
  if (n > 45)   return { label: 'Live 2T',  icon: '🔴' };
  return           { label: 'Live 1T',  icon: '🟡' };
}
function zIcon(z) {
  if (z >= 3.0) return '🔥';
  if (z >= 2.5) return '⚡';
  return '📈';
}
function timeLeft(minute) {
  const n = parseInt(minute, 10);
  if (isNaN(n)) return null;
  if (n <= 45) { const left = 47 - n; return left > 0 ? `≈${left}' left` : null; }
  if (n <= 90) { const left = 93 - n; return left > 0 ? `≈${left}' left` : null; }
  return 'ET';
}
const CIRCLED = ['①','②','③','④','⑤','⑥','⑦','⑧','⑨','⑩'];
function ahSignalSuffix(signals) {
  const parts = [];
  if (signals.lineMove === 'DEEPER' || signals.lineMove === 'SHRANK') parts.push(signals.lineMove);
  return parts.length ? ` <i>(${parts.join('  ·  ')})</i>` : '';
}
function tlLine(odds) {
  const { tl_c, tl_o } = odds;
  if (tl_c == null) return null;
  let dir = '';
  if (tl_o != null && tl_c !== tl_o) dir = tl_c > tl_o ? ' <i>(UP)</i>' : ' <i>(DOWN)</i>';
  return `📏 <b>${tl_c}</b>${dir}`;
}
function formatBetLines(bets) {
  return [...bets].sort((a, b) => b.z - a.z).map((b, i) => {
    const zStr    = (b.z    >= 0 ? '+' : '') + b.z.toFixed(1);
    const edgeStr = (b.edge >= 0 ? '+' : '') + b.edge.toFixed(1) + 'pp';
    const odds    = `<code>${b.mo_p} – ${b.mo}</code>`;
    const num     = CIRCLED[i] || `${i + 1}.`;
    return [
      `${zIcon(b.z)} <b>${b.label}</b>`,
      `    💰 Odds: [<b>${odds}</b>]`,
      `    <i>📊 ${b.p.toFixed(0)}% vs ${b.bl.toFixed(0)}%  ${edgeStr}  -  z= ${zStr}  -  n= ${b.n}</i>`,
    ].join('\n');
  }).join('\n\n');
}

// ── Fake match data ────────────────────────────────────────────────────────────
const fakeMatch = {
  home_team: 'Arsenal',
  away_team: 'Chelsea',
  league:    'Premier League',
  minute:    '67\'',
  score:     '1-0',
  odds: { tl_c: 2.75, tl_o: 2.50, ah_hc: -0.75, ah_ho: -0.75 },
};

const fakeMatchCfg = {
  fav_side: 'HOME',
  fav_line: '0.75',
  signals: { lineMove: 'DEEPER', favOddsMove: 'STABLE', dogOddsMove: 'STABLE' },
};

const fakeBets = [
  { label: 'Home Wins 2H', k: 'homeWins2H', bl: 58, p: 72, edge: 14, z: 3.1, n: 48, mo_p: '1.58', mo: '1.67' },
  { label: 'Over 2.5 FT',  k: 'over25FT',  bl: 51, p: 60, edge:  9, z: 2.6, n: 62, mo_p: '1.72', mo: '1.81' },
  { label: 'Fav Scores 2H',k: 'favScored2H',bl: 63, p: 70, edge:  7, z: 2.1, n: 55, mo_p: '1.45', mo: '1.51' },
];

// ── Build and send ─────────────────────────────────────────────────────────────
const { date, time } = nowStamp();
const { label: btLabel, icon: btIcon } = betTypeInfo(fakeMatch.minute);
const maxZ   = Math.max(...fakeBets.map(b => b.z));
const status = `<b>${fakeMatch.score}</b>  ·  <b>${fakeMatch.minute}</b>`;
const count  = fakeBets.length;

const header = [
  `${zIcon(maxZ)} <b>${count} Signals  ·  ${date}  ·  ${time}</b>`,
  `${btIcon} <b>${btLabel}</b>`,
  ``,
  `🏆 <i>${fakeMatch.league}</i>`,
  `⚽ <b>${fakeMatch.home_team} vs ${fakeMatch.away_team}</b>`,
  `📍 ${status}`,
  `⚖️ AH Line: <b>${fakeMatchCfg.fav_side === 'HOME' ? 'Home' : 'Away'} -${fakeMatchCfg.fav_line}</b>${ahSignalSuffix(fakeMatchCfg.signals)}`,
  tlLine(fakeMatch.odds),
].filter(Boolean).join('\n');

const msg = `${header}\n\n${formatBetLines(fakeBets)}\n\n<code>─────────────────────</code>`;

console.log('\n── RAW TEXT (what Telegram receives) ──\n');
console.log(msg);
console.log('\n── SENDING TO TELEGRAM ──\n');

const url = `https://api.telegram.org/bot${cfg.TELEGRAM_TOKEN}/sendMessage`;
fetch(url, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ chat_id: cfg.TELEGRAM_CHAT_ID, text: msg, parse_mode: 'HTML' }),
})
  .then(r => r.json())
  .then(r => {
    if (r.ok) console.log('✅ Sent successfully');
    else      console.error('❌ Telegram error:', r.description);
  })
  .catch(e => console.error('❌ Fetch failed:', e.message));
