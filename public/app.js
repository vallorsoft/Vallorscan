// Vallorscan PWA kliens – keresés, idővonal, megosztás-review, offline outbox, valós idejű frissítés.
const App = (() => {
  const PROBLEM_LABELS = {
    non_payment: 'Nem fizet', late_payment: 'Késés', fraud: 'Csalás',
    damage: 'Kár', dispute: 'Vita', other: 'Egyéb',
  };
  const CURRENCIES = ['RON', 'EUR', 'HUF'];
  let state = { view: 'list', filter: '', q: '', config: null };
  const view = document.getElementById('view');

  // ---- API ----
  function token() { return localStorage.getItem('vs_token') || ''; }
  function base() { return localStorage.getItem('vs_server') || ''; }
  async function api(path, opts = {}) {
    const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
    const t = token(); if (t) headers.authorization = `Bearer ${t}`;
    const res = await fetch(base() + '/api' + path, { ...opts, headers });
    if (res.status === 401) { toast('Belépés szükséges – nyisd meg a ⚙ Beállításokat'); throw new Error('401'); }
    if (!res.ok) throw new Error('HTTP ' + res.status);
    return res.json();
  }

  // ---- Segédek ----
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (a, c) => a == null ? '' : `${Number(a).toLocaleString('hu-HU')} ${c || ''}`.trim();
  const dateStr = (s) => s ? new Date(s).toLocaleDateString('hu-HU') : '';
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.add('hidden'), 3000);
  }

  // ---- Render: lista ----
  function companyCard(c) {
    const types = (c.problem_types || '').split(',').filter(Boolean);
    const badge = types[0] ? `<span class="badge b-${types[0]}">${PROBLEM_LABELS[types[0]] || types[0]}</span>` : '';
    return `<div class="card" onclick="App.openCompany('${c.id}')">
      <div class="card-top">
        <div>
          <div class="cname">${esc(c.name)}</div>
          <div class="meta">
            ${c.cui ? `<span class="pill">CUI ${esc(c.cui)}</span>` : ''}
            ${c.plates ? `<span class="pill">🚚 ${esc(c.plates.split(',')[0])}${c.plates.split(',').length > 1 ? '…' : ''}</span>` : ''}
          </div>
        </div>
        ${badge}
      </div>
      <div class="meta" style="margin-top:8px">
        <span>${c.post_count} bejegyzés</span>
        ${c.total_debt > 0 ? `<span class="debt">${money(c.total_debt, 'RON')}</span>` : ''}
        ${c.max_delay ? `<span>${c.max_delay} nap késés</span>` : ''}
        ${c.last_post_at ? `<span class="muted">${dateStr(c.last_post_at)}</span>` : ''}
      </div>
    </div>`;
  }

  function renderList(companies) {
    let list = companies;
    if (state.filter) list = list.filter((c) => (c.problem_types || '').split(',').includes(state.filter));
    view.innerHTML = list.length
      ? list.map(companyCard).join('')
      : `<div class="empty">Nincs találat.<br/>Oszd meg egy bejegyzést a Facebookból, vagy nyomd meg a ＋ gombot.</div>`;
  }

  async function loadList() {
    state.view = 'list';
    try {
      const r = state.q ? await api('/search?q=' + encodeURIComponent(state.q)) : { companies: await api('/companies') };
      renderList(r.companies);
    } catch { renderList([]); }
  }

  // ---- Render: cég idővonal ----
  async function openCompany(id) {
    state.view = 'company';
    try {
      const c = await api('/companies/' + id);
      const items = (c.posts || []).map((p) => `
        <div class="tl-item">
          <div class="tl-date">${dateStr(p.occurred_at || p.created_at)}
            ${p.problem_type ? `· <span class="badge b-${p.problem_type}">${PROBLEM_LABELS[p.problem_type] || p.problem_type}</span>` : ''}
            ${p.status === 'needs_review' ? '· ⚠ ellenőrzésre vár' : ''}</div>
          <div class="meta">
            ${p.debt_amount ? `<span class="debt">${money(p.debt_amount, p.currency)}</span>` : ''}
            ${p.delay_days ? `<span>${p.delay_days} nap</span>` : ''}
            ${p.source_url ? `<a href="${esc(p.source_url)}" target="_blank" class="muted">forrás ↗</a>` : ''}
          </div>
          <p class="tl-text">${esc(p.summary || p.raw_text)}</p>
        </div>`).join('');
      view.innerHTML = `
        <div style="margin-bottom:12px">
          <button class="btn-ghost btn" style="margin:0 0 12px;width:auto;padding:8px 14px" onclick="App.go('list')">← Vissza</button>
          <div class="cname" style="font-size:20px">${esc(c.name)}</div>
          <div class="meta">
            ${c.cui ? `<span class="pill">CUI ${esc(c.cui)}</span>` : ''}
            ${(c.plate_list || []).map((p) => `<span class="pill">🚚 ${esc(p.plate_raw || p.plate_norm)}</span>`).join('')}
          </div>
          <div class="meta" style="margin-top:6px">
            <span>${c.post_count} bejegyzés</span>
            ${c.total_debt > 0 ? `<span class="debt">összesen ${money(c.total_debt, 'RON')}</span>` : ''}
          </div>
        </div>
        <h3 class="muted" style="font-size:14px">Előzmény (időrend)</h3>
        <div class="timeline">${items || '<p class="muted">Nincs bejegyzés.</p>'}</div>`;
    } catch { toast('Nem sikerült betölteni a céget'); }
  }

  // ---- Megosztás / új bejegyzés (review sheet) ----
  const sheet = document.getElementById('sheet');
  function closeSheet() { sheet.classList.add('hidden'); document.getElementById('sheet-body').innerHTML = ''; }

  async function openCompose(prefill) {
    pendingFromShare = !!prefill?.fromShare;
    sheet.classList.remove('hidden');
    document.getElementById('sheet-title').textContent = 'Új bejegyzés';
    const body = document.getElementById('sheet-body');
    body.innerHTML = `
      <label>Megosztott szöveg / link</label>
      <textarea class="f" id="c-raw" placeholder="Illeszd be a Facebook bejegyzést vagy linket…">${esc(prefill?.text || '')}</textarea>
      <input class="f" id="c-url" style="margin-top:8px" placeholder="Forrás URL (opcionális)" value="${esc(prefill?.url || '')}" />
      <button class="btn btn-primary" onclick="App.runPreview()">🤖 AI feldolgozás</button>`;
    if (prefill?.text) runPreview();
  }

  let lastAi = null;
  let pendingFromShare = false;
  async function runPreview() {
    const text = document.getElementById('c-raw').value.trim();
    const url = document.getElementById('c-url').value.trim();
    if (!text && !url) return toast('Adj meg szöveget vagy linket');
    toast('AI feldolgozás…');
    let r;
    try { r = await api('/share/preview', { method: 'POST', body: JSON.stringify({ text, url }) }); }
    catch { return toast('Nincs kapcsolat – mentés vázlatként offline.'); }
    lastAi = { text, url, fromShare: pendingFromShare, ...r };
    renderReview(text, url, r);
  }

  function renderReview(text, url, r) {
    const a = r.ai;
    const opts = (state.config?.problem_types || Object.keys(PROBLEM_LABELS))
      .map((t) => `<option value="${t}" ${a.problem_type === t ? 'selected' : ''}>${PROBLEM_LABELS[t] || t}</option>`).join('');
    const cur = CURRENCIES.map((c) => `<option ${a.currency === c ? 'selected' : ''}>${c}</option>`).join('');
    const dupWarn = r.duplicate ? `<div class="review-flag">⚠ Ez a bejegyzés már szerepel az adatbázisban (duplikátum).</div>` : '';
    const sugg = (r.suggestions || []).length
      ? `<div class="suggest">🔎 Lehetséges egyező cég(ek):<br/>${r.suggestions.map((s) =>
          `${esc(s.company.name)} (${Math.round(s.similarity * 100)}%) <button class="btn-ghost" style="display:inline;width:auto;padding:4px 8px;margin:4px 0 0" onclick="App.useCompany('${s.company.id}','${esc(s.company.name)}')">Ehhez kötöm</button>`).join('<br/>')}</div>`
      : '';
    const reviewFlag = r.needs_review ? `<div class="review-flag">⚠ Alacsony AI-biztonság – kérlek ellenőrizd az adatokat.</div>` : '';
    document.getElementById('sheet-body').innerHTML = `
      ${dupWarn}${reviewFlag}${sugg}
      <label>Cégnév</label><input class="f" id="f-name" value="${esc(a.company_name || '')}" />
      <input type="hidden" id="f-force" value="" />
      <div class="row2">
        <div><label>CUI</label><input class="f" id="f-cui" value="${esc(a.cui || '')}" /></div>
        <div><label>Rendszám(ok)</label><input class="f" id="f-plates" value="${esc((a.license_plates || []).join(', '))}" /></div>
      </div>
      <div class="row2">
        <div><label>Tartozás</label><input class="f" id="f-debt" inputmode="decimal" value="${a.debt_amount ?? ''}" /></div>
        <div><label>Pénznem</label><select class="f" id="f-cur">${cur}</select></div>
      </div>
      <div class="row2">
        <div><label>Késés (nap)</label><input class="f" id="f-delay" inputmode="numeric" value="${a.delay_days ?? ''}" /></div>
        <div><label>Probléma típus</label><select class="f" id="f-type">${opts}</select></div>
      </div>
      <label>Összefoglaló</label><textarea class="f" id="f-summary">${esc(a.summary || '')}</textarea>
      <div class="ai-tag">Motor: ${esc(r.ai.engine)} · nyelv: ${esc(a.original_language)} · biztonság: ${Math.round((a.confidence || 0) * 100)}%</div>
      <button class="btn btn-primary" onclick="App.commit()">💾 Mentés</button>
      <button class="btn btn-ghost" onclick="App.closeSheet()">Mégse</button>`;
  }

  function useCompany(id, name) {
    document.getElementById('f-force').value = id;
    document.getElementById('f-name').value = name;
    toast('Ehhez a céghez kötve: ' + name);
  }

  async function commit() {
    const fields = {
      raw_text: lastAi.text, source_url: lastAi.url || null, source_type: lastAi.fromShare ? 'facebook' : 'manual',
      company_name: val('f-name'), cui: val('f-cui'),
      license_plates: val('f-plates').split(',').map((s) => s.trim()).filter(Boolean),
      debt_amount: val('f-debt'), currency: val('f-cur'), delay_days: val('f-delay'),
      problem_type: val('f-type'), summary: val('f-summary'),
      original_language: lastAi.ai.original_language, confidence: lastAi.ai.confidence,
      force_company_id: val('f-force') || undefined,
    };
    try {
      const r = await api('/share/commit', { method: 'POST', body: JSON.stringify(fields) });
      if (r.duplicate) toast('Már létezik ez a bejegyzés.');
      else toast('Mentve ✓');
      closeSheet(); loadList();
    } catch {
      Outbox.add(fields); closeSheet();
      toast('Offline – elmentve, szinkron netnél.');
    }
  }
  const val = (id) => (document.getElementById(id)?.value || '').trim();

  // ---- Offline outbox ----
  const Outbox = {
    key: 'vs_outbox',
    all() { try { return JSON.parse(localStorage.getItem(this.key) || '[]'); } catch { return []; } },
    save(a) { localStorage.setItem(this.key, JSON.stringify(a)); updateNet(); },
    add(f) { const a = this.all(); a.push(f); this.save(a); },
    async flush() {
      let a = this.all(); if (!a.length) return;
      const left = [];
      for (const f of a) {
        try { await api('/share/commit', { method: 'POST', body: JSON.stringify(f) }); }
        catch { left.push(f); }
      }
      this.save(left);
      if (a.length && !left.length) { toast(`${a.length} offline bejegyzés szinkronizálva ✓`); loadList(); }
    },
  };

  // ---- Hálózat + valós idő ----
  function updateNet() {
    const dot = document.getElementById('net-dot');
    const online = navigator.onLine;
    dot.className = 'dot' + (online ? '' : ' off');
    const n = Outbox.all().length;
    dot.title = online ? (n ? `${n} szinkronra vár` : 'online') : 'offline';
    if (online) Outbox.flush();
  }
  function connectSSE() {
    if (!window.EventSource) return;
    const t = token();
    const es = new EventSource(base() + '/api/events' + (t ? `?token=${encodeURIComponent(t)}` : ''));
    es.addEventListener('post.created', () => { if (state.view === 'list') loadList(); });
    es.onerror = () => {}; // EventSource automatikusan újracsatlakozik
  }

  // ---- Beállítások ----
  function settings() {
    state.view = 'settings';
    view.innerHTML = `
      <h3>Beállítások</h3>
      <label>Szerver cím (üres = ez a kiszolgáló)</label>
      <input class="f" id="s-server" placeholder="https://szerver.example.com" value="${esc(base())}" />
      <label>Belépési token</label>
      <input class="f" id="s-token" placeholder="token" value="${esc(token())}" />
      <button class="btn btn-primary" onclick="App.saveSettings()">Mentés</button>
      <button class="btn btn-ghost" onclick="App.go('list')">Vissza</button>
      <p class="muted" style="margin-top:16px;font-size:13px">Tipp: telepítsd kezdőképernyőre (Hozzáadás a kezdőképernyőhöz), majd a Facebookban „Megosztás → Vallorscan”.</p>`;
  }
  function saveSettings() {
    localStorage.setItem('vs_server', val('s-server'));
    localStorage.setItem('vs_token', val('s-token'));
    toast('Mentve'); go('list');
  }

  // ---- Router ----
  function go(v) {
    if (v === 'list') loadList();
    else if (v === 'settings') settings();
    state.view = v;
  }

  // ---- Megosztott tartalom fogadása (Web Share Target → ?shared=1) ----
  function handleSharedParam() {
    const p = new URLSearchParams(location.search);
    if (p.get('shared')) {
      history.replaceState({}, '', '/');
      openCompose({ text: p.get('text') || '', url: p.get('url') || '', fromShare: true });
    }
  }

  // ---- Natív megosztás fogadása (Android share sheet → send-intent plugin) ----
  function isNative() {
    return !!(window.Capacitor && typeof window.Capacitor.isNativePlatform === 'function' && window.Capacitor.isNativePlatform());
  }
  const safeDecode = (s) => { try { return decodeURIComponent(s); } catch { return s; } };
  function ingestSharedText(raw) {
    const s = (raw || '').trim();
    if (!s) return;
    const m = s.match(/https?:\/\/\S+/);
    openCompose({ text: s, url: m ? m[0] : '', fromShare: true });
  }
  async function initNativeShare() {
    if (!isNative()) return;
    const plugins = window.Capacitor.Plugins || {};
    const SendIntent = plugins.SendIntent;
    const AppPlugin = plugins.App;
    const consume = (res) => {
      if (!res) return;
      const raw = res.text || res.url || res.title || res.description || '';
      if (raw) ingestSharedText(safeDecode(raw));
    };
    const check = async () => {
      if (!SendIntent || !SendIntent.checkSendIntentReceived) return;
      try { consume(await SendIntent.checkSendIntentReceived()); } catch {}
    };
    await check(); // hidegindításkor érkezett megosztás
    window.addEventListener('sendIntentReceived', check); // futás közbeni megosztás
    if (AppPlugin && AppPlugin.addListener) {
      AppPlugin.addListener('appStateChange', ({ isActive }) => { if (isActive) check(); });
    }
  }

  // ---- Init ----
  async function init() {
    try { state.config = await api('/config'); } catch {}
    // keresés (debounce)
    let t;
    document.getElementById('q').addEventListener('input', (e) => {
      clearTimeout(t); state.q = e.target.value.trim();
      t = setTimeout(loadList, 250);
    });
    document.getElementById('chips').addEventListener('click', (e) => {
      const b = e.target.closest('.chip'); if (!b) return;
      document.querySelectorAll('.chip').forEach((c) => c.classList.remove('active'));
      b.classList.add('active'); state.filter = b.dataset.f; loadList();
    });
    window.addEventListener('online', updateNet);
    window.addEventListener('offline', updateNet);
    updateNet(); connectSSE(); loadList(); handleSharedParam(); initNativeShare();
    // Service worker csak a böngészős/PWA módban kell (natív appban nincs rá szükség).
    if (!isNative() && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
    // Natív appban a szerver címét kötelező megadni (nincs azonos eredetű kiszolgáló).
    if (isNative() && !base()) { toast('Add meg a szerver címét a ⚙ Beállításokban'); settings(); }
  }

  document.addEventListener('DOMContentLoaded', init);
  return { go, openCompany, openCompose, runPreview, commit, useCompany, closeSheet, saveSettings };
})();
