// Vallorscan PWA kliens – keresés, cég-értékelés, screenshot→AI komment-elemzés, valós idő.
const App = (() => {
  const PROBLEM_LABELS = {
    non_payment: 'Nem fizet', late_payment: 'Késés', fraud: 'Csalás',
    damage: 'Kár', dispute: 'Vita', other: 'Egyéb',
  };
  const VERDICT_LABELS = { pays: 'Fizető', nonpay: 'Nem fizető', mixed: 'Vegyes', unknown: 'Nincs adat' };
  const SENT_ICON = { positive: '👍', negative: '👎', neutral: '😐' };
  const TAG_LABELS = {
    non_payment: 'nem fizet', late_payment: 'késve fizet', no_contact: 'nem elérhető',
    pays_only_on_report: 'csak feljelentésre fizet', blocked_on_exchange: 'börzén tiltva',
    eventually_paid: 'végül fizetett', fraud: 'csalás', damage: 'kár', dispute: 'vita',
    recommended: 'ajánlott', good_payer: 'korrekt fizető', other: 'egyéb',
  };
  const parseTags = (t) => Array.isArray(t) ? t : (() => { try { return JSON.parse(t) || []; } catch { return []; } })();
  // Kis/nagybetűtől és ékezettől független névösszehasonlítás (a felülírás-gomb megjelenítéséhez).
  const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const tagsHtml = (tags) => tags.length ? `<div class="tagrow">${tags.map((t) => `<span class="tag">${TAG_LABELS[t] || t}</span>`).join('')}</div>` : '';
  let state = { view: 'list', filter: '', q: '', config: null };
  let report = { images: [], preview: null, company: { id: '', name: '', cui: '' } };
  let acMatches = [];
  const view = document.getElementById('view');

  // ---- API ----
  function token() { return localStorage.getItem('vs_token') || ''; }
  function base() { return localStorage.getItem('vs_server') || ''; }
  async function api(path, opts = {}) {
    const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
    const t = token(); if (t) headers.authorization = `Bearer ${t}`;
    const res = await fetch(base() + '/api' + path, { ...opts, headers });
    if (res.status === 401) { toast('Belépés szükséges – nyisd meg a ⚙ Beállításokat'); throw new Error('401'); }
    if (!res.ok) {
      let msg = 'HTTP ' + res.status;
      try { const j = await res.json(); if (j.error) msg = j.error; } catch {}
      throw new Error(msg);
    }
    return res.json();
  }

  // ---- Segédek ----
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const money = (a, c) => a == null ? '' : `${Number(a).toLocaleString('hu-HU')} ${c || ''}`.trim();
  const dateStr = (s) => s ? new Date(s).toLocaleDateString('hu-HU') : '';
  const val = (id) => (document.getElementById(id)?.value || '').trim();
  function toast(msg) {
    const el = document.getElementById('toast');
    el.textContent = msg; el.classList.remove('hidden');
    clearTimeout(toast._t); toast._t = setTimeout(() => el.classList.add('hidden'), 3500);
  }

  // ---- Render: lista ----
  function companyCard(c) {
    const v = c.verdict || 'unknown';
    const trend = c.trend === 'improving' ? ' ↗' : c.trend === 'worsening' ? ' ↘' : '';
    const stats = c.comment_count > 0
      ? `<span>💬 ${c.comment_count}</span>
         <span class="s-pos">👍 ${c.pos_count}</span>
         <span class="s-neg">👎 ${c.neg_count}</span>
         ${c.neu_count ? `<span class="s-neu">😐 ${c.neu_count}</span>` : ''}
         ${c.last_comment_at ? `<span class="muted">· ${dateStr(c.last_comment_at)}</span>` : ''}`
      : (c.post_count > 0
          ? `<span>${c.post_count} bejegyzés</span>${c.total_debt > 0 ? `<span class="debt">${money(c.total_debt, 'RON')}</span>` : ''}`
          : `<span class="muted">nincs komment</span>`);
    return `<div class="card" onclick="App.openCompany('${c.id}')">
      <div class="card-top">
        <div>
          <div class="cname">${esc(c.name)}</div>
          <div class="meta">
            ${c.cui ? `<span class="pill">CUI ${esc(c.cui)}</span>` : ''}
            ${c.plates ? `<span class="pill">🚚 ${esc(c.plates.split(',')[0])}${c.plates.split(',').length > 1 ? '…' : ''}</span>` : ''}
          </div>
        </div>
        <span class="vbadge v-${v}">${VERDICT_LABELS[v]}${trend}</span>
      </div>
      <div class="meta sumbar">${stats}</div>
    </div>`;
  }

  function renderList(companies) {
    let list = companies;
    if (state.filter) list = list.filter((c) => (c.verdict || 'unknown') === state.filter);
    view.innerHTML = list.length
      ? list.map(companyCard).join('')
      : `<div class="empty">Nincs találat.<br/>Nyomd meg a ＋ gombot, vagy ossz meg egy posztot a Facebookból.</div>`;
  }

  async function loadList() {
    state.view = 'list';
    try {
      const r = state.q ? await api('/search?q=' + encodeURIComponent(state.q)) : { companies: await api('/companies') };
      renderList(r.companies);
    } catch { renderList([]); }
  }

  // ---- Render: cég részletek (értékelés + komment-idővonal) ----
  async function openCompany(id) {
    state.view = 'company';
    try {
      const c = await api('/companies/' + id);
      const v = c.verdict || 'unknown';
      const trend = c.trend === 'improving' ? '<span class="trend up">↗ javuló</span>'
        : c.trend === 'worsening' ? '<span class="trend down">↘ romló</span>' : '';
      const comments = (c.comments || []).map((cm) => `
        <div class="tl-item tl-${cm.sentiment}">
          <div class="tl-date">${SENT_ICON[cm.sentiment] || ''}
            ${cm.comment_date ? dateStr(cm.comment_date) : (cm.date_text ? esc(cm.date_text) : '')}
            ${cm.author ? `· ${esc(cm.author)}` : ''}</div>
          <p class="tl-text">${esc(cm.text)}</p>
          ${cm.amount ? `<div class="debt">💶 ${money(cm.amount, cm.currency)}</div>` : ''}
          ${cm.due_text ? `<div class="muted">📅 ${esc(cm.due_text)}</div>` : ''}
          ${tagsHtml(parseTags(cm.tags))}
        </div>`).join('');
      const posts = (c.posts || []).map((p) => `
        <div class="tl-item">
          <div class="tl-date">${dateStr(p.occurred_at || p.created_at)}
            ${p.problem_type ? `· <span class="badge b-${p.problem_type}">${PROBLEM_LABELS[p.problem_type] || p.problem_type}</span>` : ''}</div>
          <p class="tl-text">${esc(p.summary || p.raw_text)}</p>
        </div>`).join('');
      view.innerHTML = `
        <button class="btn btn-ghost" style="margin:0 0 12px;width:auto;padding:8px 14px" onclick="App.go('list')">← Vissza</button>
        <div class="cname" style="font-size:20px">${esc(c.name)}</div>
        <div class="meta">
          ${c.cui ? `<span class="pill">CUI ${esc(c.cui)}</span>` : ''}
          ${(c.plate_list || []).map((p) => `<span class="pill">🚚 ${esc(p.plate_raw || p.plate_norm)}</span>`).join('')}
        </div>
        <div class="verdict-head">
          <span class="vbadge v-${v} big">${VERDICT_LABELS[v]}</span> ${trend}
          ${c.comment_count > 0 ? `<div class="meta" style="margin-top:8px">
            <span class="s-pos">👍 ${c.pos_count}</span>
            <span class="s-neg">👎 ${c.neg_count}</span>
            <span class="s-neu">😐 ${c.neu_count}</span>
            <span class="muted">· ${c.comment_count} komment</span>
          </div>` : ''}
        </div>
        ${comments ? `<h3 class="muted sec">Kommentek (időrend)</h3><div class="timeline">${comments}</div>` : ''}
        ${posts ? `<h3 class="muted sec">Korábbi bejegyzések</h3><div class="timeline">${posts}</div>` : ''}
        ${!comments && !posts ? '<p class="muted">Még nincs adat ennél a cégnél.</p>' : ''}`;
    } catch { toast('Nem sikerült betölteni a céget'); }
  }

  // ---- Új beküldés: cég + képernyőképek → AI ----
  const sheet = document.getElementById('sheet');
  function closeSheet() { sheet.classList.add('hidden'); document.getElementById('sheet-body').innerHTML = ''; }

  function openCompose() {
    report = { images: [], preview: null, company: { id: '', name: '', cui: '' } };
    acMatches = [];
    sheet.classList.remove('hidden');
    document.getElementById('sheet-title').textContent = 'Új beküldés';
    document.getElementById('sheet-body').innerHTML = `
      <label>Cég (opcionális – írj 3+ betűt kereséshez, vagy az AI felismeri)</label>
      <input class="f" id="r-company" placeholder="Cég neve" autocomplete="off" />
      <input type="hidden" id="r-company-id" />
      <div id="r-ac" class="ac-list"></div>
      <input class="f" id="r-cui" style="margin-top:8px" placeholder="CUI (opcionális, új cégnél)" />
      <label>Képernyőképek a posztról + kommentekről (max 5)</label>
      <input type="file" id="r-files" accept="image/*" multiple style="display:none" />
      <button type="button" class="btn btn-ghost" id="r-addbtn">📷 Képek hozzáadása</button>
      <div id="r-thumbs" class="thumbs"></div>
      <button class="btn btn-primary" id="r-analyze">🤖 Kommentek elemzése (AI)</button>`;
    // listeners
    let t;
    document.getElementById('r-company').addEventListener('input', (e) => {
      document.getElementById('r-company-id').value = ''; // gépelés = (esetleg) új cég
      clearTimeout(t); const q = e.target.value.trim();
      t = setTimeout(() => acSearch(q), 250);
    });
    document.getElementById('r-addbtn').addEventListener('click', () => document.getElementById('r-files').click());
    document.getElementById('r-files').addEventListener('change', handleFiles);
    document.getElementById('r-analyze').addEventListener('click', analyzeReport);
  }

  async function acSearch(q) {
    const ac = document.getElementById('r-ac');
    if (!ac) return;
    if (q.length < 3) { ac.innerHTML = ''; return; }
    let r; try { r = await api('/search?q=' + encodeURIComponent(q)); } catch { return; }
    acMatches = (r.companies || []).slice(0, 6);
    ac.innerHTML = acMatches.map((c, i) =>
      `<div class="ac-item" onclick="App.pickCompany(${i})">${esc(c.name)}
        ${c.cui ? `<span class="muted">· CUI ${esc(c.cui)}</span>` : ''}
        <span class="vbadge v-${c.verdict || 'unknown'}">${VERDICT_LABELS[c.verdict || 'unknown']}</span></div>`).join('');
  }
  function pickCompany(i) {
    const c = acMatches[i]; if (!c) return;
    document.getElementById('r-company').value = c.name;
    document.getElementById('r-company-id').value = c.id;
    document.getElementById('r-ac').innerHTML = '';
  }

  async function handleFiles(ev) {
    const files = [...ev.target.files].slice(0, 5 - report.images.length);
    for (const f of files) {
      try {
        const dataUrl = await compressImage(f);
        report.images.push({ mimeType: 'image/jpeg', data: dataUrl.split(',')[1], thumb: dataUrl });
      } catch {}
    }
    ev.target.value = '';
    renderThumbs();
  }
  function renderThumbs() {
    const el = document.getElementById('r-thumbs');
    el.innerHTML = report.images.map((im, i) =>
      `<div class="thumb"><img src="${im.thumb}" alt=""/><button onclick="App.removeImg(${i})">✕</button></div>`).join('')
      + (report.images.length ? `<div class="muted thumb-count">${report.images.length}/5 kép</div>` : '');
  }
  function removeImg(i) { report.images.splice(i, 1); renderThumbs(); }

  /** Kép kicsinyítése + JPEG tömörítés (kisebb feltöltés, gyorsabb AI). */
  function compressImage(file, maxW = 1080, quality = 0.7) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        URL.revokeObjectURL(url);
        const scale = Math.min(1, maxW / img.width);
        const w = Math.round(img.width * scale), h = Math.round(img.height * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', quality));
      };
      img.onerror = reject;
      img.src = url;
    });
  }

  function renderProcessing() {
    document.getElementById('sheet-title').textContent = 'Feldolgozás';
    document.getElementById('sheet-body').innerHTML = `
      <div class="processing">
        <div class="spinner"></div>
        <p><strong>🤖 Az AI elemzi a képeket…</strong></p>
        <p class="muted">Kiolvassa a kommenteket, összegeket, dátumokat és a problémákat. Ez pár másodperc.</p>
      </div>`;
  }

  async function analyzeReport() {
    if (!report.images.length) return toast('Tölts fel legalább egy képernyőképet');
    // A cégnév itt NEM kötelező – ha üres, az AI által kiolvasottat ajánljuk fel utána.
    report.company = { id: val('r-company-id'), name: val('r-company'), cui: val('r-cui') };
    renderProcessing(); // azonnal ugrunk a feldolgozás ablakba (nem fagyott képernyő)
    let r;
    try {
      r = await api('/reports/preview', {
        method: 'POST',
        body: JSON.stringify({ images: report.images.map(({ mimeType, data }) => ({ mimeType, data })) }),
      });
    } catch (e) {
      document.getElementById('sheet-body').innerHTML = `
        <div class="review-flag">❌ Elemzés sikertelen: ${esc(e.message)}</div>
        <button class="btn btn-ghost" onclick="App.closeSheet()">Bezár</button>`;
      return;
    }
    report.preview = r;
    if (r.company_name && !report.company.name) report.company.name = r.company_name;
    renderReportReview(r);
  }

  function tally(cs) {
    return cs.reduce((a, c) => (a[c.sentiment] = (a[c.sentiment] || 0) + 1, a), {});
  }
  function sentOptions(sel) {
    return ['positive', 'negative', 'neutral'].map((v) =>
      `<option value="${v}" ${sel === v ? 'selected' : ''}>${SENT_ICON[v]} ${v === 'positive' ? 'jó' : v === 'negative' ? 'rossz' : 'semleges'}</option>`).join('');
  }
  function renderReportReview(r) {
    const cs = r.comments || [];
    const t = tally(cs);
    const ai = r.company_name;
    const typed = (report.company.name || '').trim();
    // Az AI által kiolvasott cégnév – üres mezőbe beilleszthető, eltérés esetén felülírható.
    const aiHint = ai
      ? `<div class="suggest">🔎 Az AI ezt a cégnevet olvasta ki a posztból: <strong>${esc(ai)}</strong>
          ${normName(ai) !== normName(typed)
            ? `<br/><button class="btn-ghost" style="display:inline;width:auto;padding:5px 12px;margin-top:6px" onclick="App.useAiName()">${typed ? 'Felülírás ezzel' : 'Cégnév beillesztése'}</button>`
            : ' ✓'}</div>`
      : `<div class="review-flag">ℹ️ Az AI nem talált egyértelmű cégnevet – írd be kézzel a mentéshez.</div>`;
    document.getElementById('sheet-title').textContent = 'Ellenőrzés & mentés';
    document.getElementById('sheet-body').innerHTML = `
      <div class="review-flag">📋 ${cs.length} komment felismerve. Ellenőrizd/javítsd, majd mentsd.</div>
      <label>Cég (kötelező)</label>
      <input class="f" id="rv-company" value="${esc(report.company.name)}" placeholder="Cég neve" />
      <input type="hidden" id="rv-company-id" value="${esc(report.company.id)}" />
      ${aiHint}
      <input class="f" id="rv-cui" style="margin-top:8px" value="${esc(report.company.cui)}" placeholder="CUI (opcionális)" />
      <div class="tally"><span class="s-pos">👍 ${t.positive || 0}</span>
        <span class="s-neg">👎 ${t.negative || 0}</span>
        <span class="s-neu">😐 ${t.neutral || 0}</span></div>
      <div id="rv-comments">${cs.map(commentEditHtml).join('')}</div>
      <button class="btn btn-primary" onclick="App.saveReport()">💾 Mentés (${cs.length})</button>
      <button class="btn btn-ghost" onclick="App.closeSheet()">Mégse</button>`;
  }
  function commentEditHtml(c, i) {
    return `<div class="cmt" data-i="${i}">
      <div class="cmt-row">
        <select class="f cmt-sent">${sentOptions(c.sentiment)}</select>
        <input class="f cmt-date" value="${esc(c.comment_date || '')}" placeholder="ÉÉÉÉ-HH-NN" />
        <button class="cmt-del" onclick="App.delComment(${i})">🗑</button>
      </div>
      <textarea class="f cmt-text">${esc(c.text)}</textarea>
      <div class="cmt-extra">
        <input class="f cmt-amount" inputmode="decimal" value="${c.amount ?? ''}" placeholder="összeg" />
        <input class="f cmt-cur" value="${esc(c.currency || '')}" placeholder="pénznem" />
      </div>
      ${c.due_text ? `<div class="cmt-due muted">📅 ${esc(c.due_text)}</div>` : ''}
      ${tagsHtml(c.tags || [])}
      ${c.author ? `<div class="muted cmt-author">— ${esc(c.author)}</div>` : ''}
    </div>`;
  }
  function syncReview() {
    const rows = [...document.querySelectorAll('#rv-comments .cmt')];
    report.preview.comments = rows.map((row) => {
      const prev = report.preview.comments[Number(row.dataset.i)] || {};
      return {
        author: prev.author || null,
        tags: prev.tags || [],
        due_text: prev.due_text || null,
        sentiment: row.querySelector('.cmt-sent').value,
        comment_date: row.querySelector('.cmt-date').value.trim() || null,
        amount: row.querySelector('.cmt-amount').value.trim() || null,
        currency: row.querySelector('.cmt-cur').value.trim() || null,
        text: row.querySelector('.cmt-text').value.trim(),
      };
    });
    report.company = { id: val('rv-company-id'), name: val('rv-company'), cui: val('rv-cui') };
  }
  function delComment(i) { syncReview(); report.preview.comments.splice(i, 1); renderReportReview(report.preview); }
  function useAiName() {
    const n = report.preview?.company_name; if (!n) return;
    syncReview();                                  // megőrizzük a komment-szerkesztéseket
    report.company = { ...report.company, name: n, id: '' };
    renderReportReview(report.preview);
    toast('Cégnév felülírva: ' + n);
  }

  function saveReport() {
    syncReview();
    const cs = report.preview.comments.filter((c) => c.text);
    if (!cs.length) return toast('Nincs menthető komment');
    const co = report.company;
    if (!co.id && !co.name) return toast('Adj meg egy céget');
    const payload = {
      company_id: co.id || undefined, company_name: co.name, cui: co.cui || undefined,
      comments: cs.map((c) => ({
        text: c.text, sentiment: c.sentiment, comment_date: c.comment_date,
        author: c.author, tags: c.tags || [], amount: c.amount, currency: c.currency, due_text: c.due_text,
        pay_signal: c.sentiment === 'positive' ? 'pays' : c.sentiment === 'negative' ? 'nonpay' : 'unknown',
      })),
    };
    api('/reports/commit', { method: 'POST', body: JSON.stringify(payload) })
      .then((r) => { toast(`Mentve ✓ (${r.inserted} új komment${r.skipped ? `, ${r.skipped} duplikátum` : ''})`); closeSheet(); loadList(); })
      .catch((e) => toast('Mentés sikertelen: ' + e.message));
  }

  // ---- Offline outbox (régi share-bejegyzésekhez, ha maradt) ----
  const Outbox = {
    key: 'vs_outbox',
    all() { try { return JSON.parse(localStorage.getItem(this.key) || '[]'); } catch { return []; } },
    save(a) { localStorage.setItem(this.key, JSON.stringify(a)); updateNet(); },
    async flush() {
      let a = this.all(); if (!a.length) return;
      const left = [];
      for (const f of a) {
        try { await api('/share/commit', { method: 'POST', body: JSON.stringify(f) }); } catch { left.push(f); }
      }
      this.save(left);
      if (a.length && !left.length) { toast(`${a.length} offline tétel szinkronizálva ✓`); loadList(); }
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
    es.onerror = () => {};
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
      <p class="muted" style="margin-top:16px;font-size:13px">Tipp: telepítsd kezdőképernyőre, majd a Facebookban „Megosztás → Vallorscan”, vagy nyomd meg a ＋ gombot és tölts fel képernyőképeket.</p>`;
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
      openCompose();
      toast('Tölts fel képernyőképeket a posztról + kommentekről');
    }
  }

  // ---- Init ----
  async function init() {
    try { state.config = await api('/config'); } catch {}
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
    updateNet(); connectSSE(); loadList(); handleSharedParam();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  document.addEventListener('DOMContentLoaded', init);
  return { go, openCompany, openCompose, closeSheet, saveSettings, pickCompany, removeImg, analyzeReport, delComment, saveReport, useAiName };
})();
