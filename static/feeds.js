/* ══════════════════════════════════════════════════════════════════════
   feeds.js — the FEEDS card (MATCHES tab, left panel): health of the
   three botbot3 book hashes every function depends on, and a paste box to
   replace a stale one from the phone — no Cloudflare dashboard, no redeploy.

   GET  /api/hashes → per book: hash, where it comes from (saved in the app
        = KV, env var, built-in), status ok / stale / wrong / unverified.
        The server also tries one auto-discovery round for a stale feed.
   POST /api/hashes { book, url, key? } → checked against botbot3 (right kind
        of feed, has data), then saved to KV (functions/api/hashes.js).

   Depends on: match.js (mtEsc), matches.js (runMatchesScan).
   ══════════════════════════════════════════════════════════════════════ */

const FD_KEY_STORE = 'halvest_hash_admin_key';
const _fd = { data: null, loading: false, msg: null, msgCls: '' };

async function loadFeedStatus() {
  if (_fd.loading) return;
  _fd.loading = true;
  renderFeedCard();
  try {
    const resp = await fetch('/api/hashes');
    _fd.data = await resp.json();
    if (_fd.data.error) throw new Error(_fd.data.error);
  } catch (e) {
    _fd.data = null;
    _fd.msg = '✗ Could not check the feeds: ' + e.message; _fd.msgCls = 'error';
  } finally {
    _fd.loading = false;
    renderFeedCard();
  }
}

async function saveFeedHash() {
  const book = document.getElementById('fd-book')?.value;
  const url = document.getElementById('fd-url')?.value.trim();
  const keyEl = document.getElementById('fd-key');
  const key = keyEl?.value.trim() || undefined;
  if (!url) return;
  const btn = document.getElementById('fd-save');
  if (btn) btn.disabled = true;
  _fd.msg = 'Checking the hash against botbot3…'; _fd.msgCls = 'loading'; renderFeedMsg();
  try {
    const resp = await fetch('/api/hashes', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ book, url, key }) });
    const r = await resp.json();
    if (!r.ok) throw new Error(r.error || `HTTP ${resp.status}`);
    if (key) try { localStorage.setItem(FD_KEY_STORE, key); } catch (_) {}
    _fd.msg = `✓ Saved ${r.hash.slice(0, 8)}… for ${_fd.data?.books?.[book]?.label || book} — ${r.detail}. Every page uses it from now on.`;
    _fd.msgCls = 'ok';
    document.getElementById('fd-url').value = '';
    await loadFeedStatus();
    if (typeof runMatchesScan === 'function') runMatchesScan();
  } catch (e) {
    _fd.msg = '✗ ' + e.message; _fd.msgCls = 'error'; renderFeedMsg();
  } finally {
    if (btn) btn.disabled = false;
  }
}

const FD_SOURCE = { kv: 'saved in the app', env: 'Cloudflare env var', default: 'built-in', discovered: 'auto-found (not saved — no KV)' };
const FD_DOT = { ok: 'ok', stale: 'bad', wrong: 'bad', unverified: 'warn' };

function fdAgo(ms) {
  if (!ms) return '';
  const m = Math.round((Date.now() - ms) / 60000);
  return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`;
}

function renderFeedMsg() {
  const el = document.getElementById('fd-msg');
  if (el) { el.textContent = _fd.msg || ''; el.className = 'url-import-status ' + (_fd.msgCls || ''); }
}

function renderFeedCard() {
  const el = document.getElementById('fd-body');
  if (!el) return;
  const d = _fd.data;
  if (!d) { el.innerHTML = `<div class="mt-dim">${_fd.loading ? 'Checking feeds…' : 'Not checked yet.'}</div>`; renderFeedMsg(); return; }
  const books = Object.entries(d.books);
  const bad = books.filter(([, b]) => b.status === 'stale' || b.status === 'wrong');
  const sel = document.getElementById('fd-book');
  const keep = sel?.value;
  el.innerHTML = `
    ${books.map(([k, b]) => `
      <div class="fd-row" title="${mtEsc(b.hash)}">
        <span class="fd-dot ${FD_DOT[b.status] || 'warn'}"></span>
        <span class="fd-name">${mtEsc(b.label)}</span>
        <span class="fd-hash">${mtEsc(b.hash.slice(0, 8))}…</span>
        <div class="fd-detail">${mtEsc(b.status === 'ok' ? 'working' : b.status)}${b.healed ? ' · auto-fixed' : ''} — ${mtEsc(b.detail)}<br>
          <span class="mt-dim">${mtEsc(FD_SOURCE[b.source] || b.source)}${b.at ? ' · ' + fdAgo(b.at) + (b.by === 'auto' ? ' (auto)' : '') : ''}</span></div>
      </div>`).join('')}
    ${d.kv ? '' : `<div class="mt-banner warn" style="margin-top:8px">Saving from here needs a one-time Cloudflare setup: Workers &amp; Pages → your project → Settings → Bindings → add a <b>KV namespace</b> with variable name <b>HASHES_KV</b>, then redeploy. Until then, fixes have to go in the env vars.</div>`}
    <div class="fd-form">
      <div class="mt-sub">${bad.length ? `<b>${mtEsc(bad.map(([, b]) => b.label).join(' and '))}</b> needs a new hash.` : 'All feeds working.'} To replace one: on asianbetsoccer's livescore page pick that book, then copy the <code>…/livegame/&lt;hash&gt;.js</code> link (or just the hash) here.</div>
      <select id="fd-book" class="disc-select">${books.map(([k, b]) => `<option value="${k}">${mtEsc(b.label)}</option>`).join('')}</select>
      <input id="fd-url" class="mt-input" placeholder="https://botbot3.space/tables/v4/Q/livegame/….js" autocomplete="off">
      ${d.keyRequired ? '<input id="fd-key" class="mt-input" type="password" placeholder="Admin key">' : ''}
      <div class="fd-actions">
        <button id="fd-save" class="run-btn" onclick="saveFeedHash()"${d.kv ? '' : ' disabled'}>Check &amp; save</button>
        <button class="ml-lg-clear" onclick="loadFeedStatus()">Re-check</button>
      </div>
    </div>`;
  const sum = document.getElementById('fd-summary');
  if (sum) { sum.textContent = bad.length ? `${bad.length} broken` : books.every(([, b]) => b.status === 'ok') ? 'all working' : 'check'; sum.className = 'fd-summary ' + (bad.length ? 'bad' : 'ok'); }
  if (bad.length) document.getElementById('fd-card')?.setAttribute('open', '');
  const newSel = document.getElementById('fd-book');
  if (newSel) newSel.value = keep && d.books[keep] ? keep : (bad[0]?.[0] || 'bet365live');
  const keyEl = document.getElementById('fd-key');
  if (keyEl) try { keyEl.value = localStorage.getItem(FD_KEY_STORE) || ''; } catch (_) {}
  renderFeedMsg();
}
