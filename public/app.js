// Vallorscan PWA kliens – keresés, idővonal, megosztás-review, offline outbox, valós idejű frissítés.
const App = (() => {
  const PROBLEM_LABELS = {
    non_payment: 'Nem fizet', late_payment: 'Késés', fraud: 'Csalás',
    damage: 'Kár', dispute: 'Vita', other: 'Egyéb',
  };
  const CURRENCIES = ['RON', 'EUR', 'HUF'];
  let state = { view: 'list', filter: '', q: '', config: null };
  const view = document.getElementById('view');

  // ---- API / közös runtime (window.VS) ----
  function token() { return localStorage.getItem('vs_token') || ''; }
  function base() { return localStorage.getItem('vs_server') || ''; }
  function setToken(t) { localStorage.setItem('vs_token', t || ''); }
  function setBase(b) { localStorage.setItem('vs_server', b || ''); }
  async function api(path, opts = {}) {
    const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
    const t = token(); if (t) headers.authorization = `Bearer ${t}`;
    const res = await fetch(base() + '/api' + path, { ...opts, headers });
    let body;
    if ((res.headers.get('content-type') || '').includes('application/json')) {
      try { body = await res.json(); } catch {}
    }
    if (!res.ok) {
      const err = new Error((body && body.error) || ('HTTP ' + res.status));
      err.status = res.status; err.body = body;
      throw err;
    }
    return body;
  }
  // Megosztott runtime a login.js / users.js / store.js moduloknak.
  window.VS = { base, token, setToken, setBase, api, toast, esc, currentUser: null };

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
      let companies;
      if (state.q) {
        companies = (await api('/search?q=' + encodeURIComponent(state.q))).companies;
      } else {
        companies = await api('/companies');
        Store.replaceCompanies(companies); // offline cache frissítése
      }
      renderList(companies);
    } catch (e) {
      if (e.status === 401) { setToken(''); window.VS.currentUser = null; return Login.show(onLoginSuccess); }
      renderList(await Store.getCompanies()); // offline → helyi cache
    }
  }

  // ---- Render: cég idővonal ----
  async function openCompany(id) {
    state.view = 'company';
    try {
      const c = await api('/companies/' + id);
      Store.putCompany(c); // offline cache
      renderCompany(c);
    } catch (e) {
      if (e.status === 401) { setToken(''); window.VS.currentUser = null; return Login.show(onLoginSuccess); }
      const c = await Store.getCompany(id);
      if (c) renderCompany(c); else toast('Nem sikerült betölteni a céget (offline)');
    }
  }

  function renderCompany(c) {
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
  let sse = null;
  function connectSSE() {
    if (!window.EventSource) return;
    if (sse) { try { sse.close(); } catch {} }
    const t = token();
    sse = new EventSource(base() + '/api/events' + (t ? `?token=${encodeURIComponent(t)}` : ''));
    // Más eszköz mentett → szinkronizáljuk a helyi cache-t, és frissítjük a listát.
    sse.addEventListener('post.created', () => {
      Store.sync().then(() => { if (state.view === 'list') loadList(); }).catch(() => {});
    });
    sse.onerror = () => {}; // EventSource automatikusan újracsatlakozik
  }

  // ---- Beállítások ----
  function settings() {
    state.view = 'settings';
    const u = window.VS.currentUser;
    const isAdmin = u && (u.role === 'superadmin' || u.role === 'admin');
    const roleLabel = u ? ({ superadmin: 'Superadmin', admin: 'Admin', user: 'Felhasználó' }[u.role] || u.role) : '';
    view.innerHTML = `
      <h3>Beállítások</h3>
      ${u ? `<div class="card" style="cursor:default">
          <div class="cname">${esc(u.display_name || u.email)}</div>
          <div class="meta"><span class="pill">${esc(u.email)}</span><span class="badge b-other">${esc(roleLabel)}</span></div>
        </div>` : ''}
      <label>Szerver cím (üres = ez a kiszolgáló)</label>
      <input class="f" id="s-server" placeholder="https://szerver.example.com" value="${esc(base())}" />
      <button class="btn btn-primary" onclick="App.saveSettings()">Mentés</button>
      ${isAdmin ? `<button class="btn btn-ghost" onclick="App.openUsers()">👥 Felhasználók kezelése</button>` : ''}
      <button class="btn btn-ghost" onclick="App.logout()">Kijelentkezés</button>
      <button class="btn btn-ghost" onclick="App.go('list')">Vissza</button>
      <p class="muted" style="margin-top:16px;font-size:13px">Tipp: a Facebookban „Megosztás → Vallorscan”.</p>`;
  }
  function saveSettings() {
    setBase(val('s-server'));
    toast('Mentve'); afterAuth(); go('list');
  }
  function openUsers() { if (window.Users) window.Users.show(); else toast('A felhasználókezelő nem érhető el'); }

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

  // ---- Auth-kapu ----
  async function ensureAuth() {
    if (!token()) return false;
    try { const r = await api('/auth/me'); window.VS.currentUser = r.user; return true; }
    catch (e) {
      if (e.status === 401) { setToken(''); window.VS.currentUser = null; return false; }
      return true; // hálózati hiba (offline) – engedjük a cache-elt offline használatot
    }
  }
  function onLoginSuccess(user) { window.VS.currentUser = user; afterAuth(); }
  async function afterAuth() {
    try { state.config = await api('/config'); } catch {}
    updateNet(); connectSSE(); loadList(); handleSharedParam(); initNativeShare();
    Store.sync().then((r) => { if (r.updated) loadList(); }).catch(() => {});
  }
  async function logout() {
    try { await api('/auth/logout', { method: 'POST' }); } catch {}
    setToken(''); window.VS.currentUser = null;
    try { await Store.clear(); } catch {}
    if (sse) { try { sse.close(); } catch {} sse = null; }
    Login.show(onLoginSuccess);
  }

  // ---- Init ----
  async function init() {
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
    // Service worker csak a böngészős/PWA módban kell (natív appban nincs rá szükség).
    if (!isNative() && 'serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});

    await Store.init();
    renderList(await Store.getCompanies()); // azonnali offline lista a cache-ből

    // Belépés kötelező: érvényes munkamenet kell (offline a cache-ből dolgozunk).
    if (await ensureAuth()) afterAuth();
    else Login.show(onLoginSuccess);
  }

  document.addEventListener('DOMContentLoaded', init);
  return { go, openCompany, openCompose, runPreview, commit, useCompany, closeSheet, saveSettings, openUsers, logout };
})();
