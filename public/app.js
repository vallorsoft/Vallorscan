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
  const EXCHANGE_LABELS = {
    bursa_transport: 'Bursa Transport', timocom: 'Timocom', trans_eu: 'Trans.eu',
    load123: '123load', teleroute: 'Teleroute', egyeb: 'Egyéb',
  };
  const parseTags = (t) => Array.isArray(t) ? t : (() => { try { return JSON.parse(t) || []; } catch { return []; } })();
  // Kis/nagybetűtől és ékezettől független névösszehasonlítás (a felülírás-gomb megjelenítéséhez).
  const normName = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/\s+/g, ' ').trim();
  const tagsHtml = (tags) => tags.length ? `<div class="tagrow">${tags.map((t) => `<span class="tag">${TAG_LABELS[t] || t}</span>`).join('')}</div>` : '';
  let state = { view: 'list', filter: '', q: '', config: null };
  let report = { images: [], preview: null, company: { id: '', name: '', cui: '' } };
  let acMatches = [];
  let companyRefs = [];
  let mergeMatches = [];
  let manualVerdict = '';
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

  // Mentés után: ha létezik nagyon hasonló nevű MÁSIK cég, jelezzük (összevonáshoz).
  async function checkDuplicate(savedId, savedName) {
    const n = (savedName || '').trim();
    if (n.length < 3) return;
    let r; try { r = await api('/search?q=' + encodeURIComponent(n)); } catch { return; }
    const norm = (s) => String(s || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/[^a-z0-9]/g, '');
    const target = norm(n);
    const dup = (r.companies || []).find((c) => c.id !== savedId && target && (norm(c.name).includes(target) || target.includes(norm(c.name))));
    if (dup) toast('Hasonló cég is létezik: ' + dup.name + ' — a cég oldalán összevonhatod.');
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
            ${cm.author ? `· ${esc(cm.author)}` : ''}
            <button class="tl-del" onclick="App.deleteComment('${c.id}','${cm.id}')" title="Komment törlése">🗑</button></div>
          <p class="tl-text">${esc(cm.text_hu || cm.text)}</p>
          ${cm.text_hu && cm.text && cm.text.trim() !== cm.text_hu.trim()
            ? `<button class="lang-toggle" onclick="App.toggleOrig(this)">🌐 eredeti nyelv</button>
               <p class="tl-orig muted" style="display:none">${esc(cm.text)}</p>` : ''}
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
      companyRefs = c.refs || [];
      const refList = companyRefs.length
        ? companyRefs.map((r, i) => `<span class="pill ref">${esc(EXCHANGE_LABELS[r.exchange] || r.exchange)}: <strong>${esc(r.ref_code)}</strong> <button class="ref-x" onclick="App.delRefByIndex('${c.id}',${i})">✕</button></span>`).join('')
        : '<span class="muted">nincs még börze-kód</span>';
      const refsHtml = `
        <h3 class="muted sec">Börze-azonosítók</h3>
        <div class="refs">${refList}</div>
        <div class="ref-add">
          <select class="f" id="ref-ex">${Object.entries(EXCHANGE_LABELS).map(([k, vL]) => `<option value="${k}">${vL}</option>`).join('')}</select>
          <input class="f" id="ref-code" placeholder="azonosító / kód" />
          <button class="btn-ghost ref-addbtn" onclick="App.addRef('${c.id}')">+</button>
        </div>`;
      // Cég kezelése: átnevezés, összevonás másik céggel, törlés.
      mergeMatches = [];
      const manageHtml = `
        <h3 class="muted sec">Cég kezelése</h3>
        <label>Cégnév + CUI javítása</label>
        <input class="f" id="ed-name" value="${esc(c.name)}" placeholder="Cég neve" />
        <input class="f" id="ed-cui" style="margin-top:8px" value="${esc(c.cui || '')}" placeholder="CUI (opcionális)" />
        <button class="btn btn-ghost" onclick="App.renameCompany('${c.id}')">💾 Mentés</button>
        <label>Összevonás másik céggel (a megtalált cég ebbe olvad be)</label>
        <input class="f" id="mg-q" placeholder="Másik cég keresése (3+ betű)" autocomplete="off" />
        <div id="mg-ac" class="ac-list"></div>
        <button class="btn btn-ghost danger" onclick="App.deleteCompany('${c.id}')">🗑 Cég törlése</button>`;
      const aiSection = c.comment_count > 0 ? `
        <h3 class="muted sec">🤖 AI vélemény – vállaljunk fuvart?</h3>
        <div id="ai-opinion">${c.ai_opinion
          ? opinionHtml(c.ai_opinion, c.id, c.opinion_stale)
          : '<div class="opinion"><div class="spinner"></div><p class="muted">Vélemény készül…</p></div>'}</div>` : '';
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
        ${aiSection}
        ${refsHtml}
        ${comments ? `<h3 class="muted sec">Kommentek (időrend)</h3><div class="timeline">${comments}</div>` : ''}
        ${posts ? `<h3 class="muted sec">Korábbi bejegyzések</h3><div class="timeline">${posts}</div>` : ''}
        ${!comments && !posts ? '<p class="muted">Még nincs adat ennél a cégnél.</p>' : ''}
        ${manageHtml}`;
      // Összevonás-kereső (debounce), az aktuális céget kihagyva.
      let mt;
      document.getElementById('mg-q').addEventListener('input', (e) => {
        clearTimeout(mt); const q = e.target.value.trim();
        mt = setTimeout(() => mergeSearch(c.id, q), 250);
      });
      // Ha még nincs AI-vélemény, automatikusan legeneráljuk (a háttérben).
      if (c.comment_count > 0 && !c.ai_opinion) requestOpinion(c.id);
    } catch { toast('Nem sikerült betölteni a céget'); }
  }

  // ---- AI cég-vélemény (vállaljunk-e fuvart) ----
  const REC = {
    take: { label: 'Vállalható', cls: 'v-pays', icon: '✅' },
    caution: { label: 'Óvatosan', cls: 'v-mixed', icon: '⚠️' },
    avoid: { label: 'Kerülendő', cls: 'v-nonpay', icon: '⛔' },
  };
  const CONF = { high: 'biztos', medium: 'valószínű', low: 'bizonytalan (kevés érdemi adat)' };
  function opinionHtml(op, id, stale) {
    const r = REC[op.recommendation] || REC.caution;
    const conf = CONF[op.confidence] || CONF.medium;
    const basis = op.relevant_count != null ? ` · ${op.relevant_count} érdemi vélemény alapján` : '';
    return `<div class="opinion">
      <span class="vbadge ${r.cls} big">${r.icon} ${r.label}</span>
      <div class="op-conf muted">megbízhatóság: ${conf}${basis}</div>
      <p class="op-headline">${esc(op.headline)}</p>
      <p><strong>Miért:</strong> ${esc(op.reasoning)}</p>
      <p><strong>Mire számíts:</strong> ${esc(op.what_to_expect)}</p>
      <button class="lang-toggle" onclick="App.requestOpinion('${id}')">🔄 Frissítés${stale ? ' – új vélemények érkeztek' : ''}</button>
    </div>`;
  }
  async function requestOpinion(id) {
    const box = document.getElementById('ai-opinion');
    if (box) box.innerHTML = '<div class="opinion"><div class="spinner"></div><p class="muted">Vélemény készül… (pár másodperc)</p></div>';
    let op;
    try { op = await api('/companies/' + id + '/opinion', { method: 'POST' }); }
    catch (e) { if (box) box.innerHTML = `<div class="review-flag">❌ AI vélemény nem készült: ${esc(e.message)}</div>`; return; }
    if (box) box.innerHTML = opinionHtml(op, id, false);
  }

  // ---- Börze-azonosítók (Bursa Transport, Timocom, ...) ----
  async function addRef(companyId) {
    const exchange = val('ref-ex'), ref_code = val('ref-code');
    if (!ref_code) return toast('Add meg a börze-kódot');
    try { await api('/companies/' + companyId + '/refs', { method: 'POST', body: JSON.stringify({ exchange, ref_code }) }); openCompany(companyId); toast('Hozzáadva'); }
    catch (e) { toast('Hiba: ' + e.message); }
  }
  function delRefByIndex(companyId, i) {
    const r = companyRefs[i]; if (!r) return;
    api('/companies/' + companyId + '/refs', { method: 'DELETE', body: JSON.stringify({ exchange: r.exchange, ref_code: r.ref_code }) })
      .then(() => openCompany(companyId)).catch((e) => toast('Hiba: ' + e.message));
  }

  // ---- Cég kezelése: átnevezés, összevonás, törlés ----
  function renameCompany(id) {
    const name = val('ed-name'); if (!name) return toast('Add meg a cégnevet');
    api('/companies/' + id, { method: 'PATCH', body: JSON.stringify({ name, cui: val('ed-cui') }) })
      .then(() => { openCompany(id); toast('Mentve ✓'); })
      .catch((e) => toast('Hiba: ' + e.message));
  }
  function deleteCompany(id) {
    if (!confirm('Biztos törlöd a céget és minden kommentjét?')) return;
    api('/companies/' + id, { method: 'DELETE' })
      .then(() => { go('list'); toast('Cég törölve'); })
      .catch((e) => toast('Hiba: ' + e.message));
  }
  function deleteComment(companyId, commentId) {
    if (!confirm('Biztos törlöd ezt a kommentet?')) return;
    api('/comments/' + commentId, { method: 'DELETE' })
      .then(() => { openCompany(companyId); toast('Komment törölve'); })
      .catch((e) => toast('Hiba: ' + e.message));
  }
  async function mergeSearch(currentId, q) {
    const ac = document.getElementById('mg-ac');
    if (!ac) return;
    if (q.length < 3) { ac.innerHTML = ''; return; }
    let r; try { r = await api('/search?q=' + encodeURIComponent(q)); } catch { return; }
    mergeMatches = (r.companies || []).filter((c) => c.id !== currentId).slice(0, 6);
    ac.innerHTML = mergeMatches.length
      ? mergeMatches.map((c, i) =>
          `<div class="ac-item" onclick="App.pickMerge('${currentId}',${i})">${esc(c.name)}
            ${c.cui ? `<span class="muted">· CUI ${esc(c.cui)}</span>` : ''}
            <span class="vbadge v-${c.verdict || 'unknown'}">${VERDICT_LABELS[c.verdict || 'unknown']}</span></div>`).join('')
      : '<div class="muted" style="padding:8px 2px">Nincs másik találat.</div>';
  }
  function pickMerge(currentId, i) {
    const src = mergeMatches[i]; if (!src) return;
    if (!confirm(`Biztos összevonod? A(z) ${src.name} beolvad ebbe a cégbe, és törlődik.`)) return;
    api('/companies/' + currentId + '/merge', { method: 'POST', body: JSON.stringify({ source_id: src.id }) })
      .then(() => { openCompany(currentId); toast('Cégek összevonva ✓'); })
      .catch((e) => toast('Hiba: ' + e.message));
  }

  // ---- Új beküldés: cég + képernyőképek → AI ----
  const sheet = document.getElementById('sheet');
  function closeSheet() { sheet.classList.add('hidden'); document.getElementById('sheet-body').innerHTML = ''; }

  function openCompose() {
    report = { images: [], preview: null, company: { id: '', name: '', cui: '' } };
    acMatches = []; manualVerdict = '';
    sheet.classList.remove('hidden');
    document.getElementById('sheet-title').textContent = 'Új beküldés';
    renderComposeBody('image');
  }
  function composeMode(mode) { renderComposeBody(mode); }

  function attachCompanyAutocomplete() {
    let t;
    document.getElementById('r-company').addEventListener('input', (e) => {
      document.getElementById('r-company-id').value = ''; // gépelés = (esetleg) új cég
      clearTimeout(t); const q = e.target.value.trim();
      t = setTimeout(() => acSearch(q), 250);
    });
  }

  function renderComposeBody(mode) {
    const seg = `<div class="seg">
      <button class="seg-btn ${mode === 'image' ? 'active' : ''}" onclick="App.composeMode('image')">📷 Képből</button>
      <button class="seg-btn ${mode === 'manual' ? 'active' : ''}" onclick="App.composeMode('manual')">✍️ Kézi</button>
    </div>`;
    const company = (hint) => `
      <label>Cég ${hint}</label>
      <input class="f" id="r-company" placeholder="Cég neve" autocomplete="off" />
      <input type="hidden" id="r-company-id" />
      <div id="r-ac" class="ac-list"></div>
      <input class="f" id="r-cui" style="margin-top:8px" placeholder="CUI (opcionális, új cégnél)" />`;
    const body = document.getElementById('sheet-body');
    if (mode === 'manual') {
      report.images = [];
      body.innerHTML = seg + company('(írj 3+ betűt kereséshez)') + manualFormHtml();
      attachCompanyAutocomplete();
    } else {
      body.innerHTML = seg + company('(opcionális – az AI is felismeri)') + `
        <label>Képernyőképek a posztról + kommentekről (max 5)</label>
        <input type="file" id="r-files" accept="image/*" multiple style="display:none" />
        <button type="button" class="btn btn-ghost" id="r-addbtn">📷 Képek hozzáadása</button>
        <div id="r-thumbs" class="thumbs"></div>
        <button class="btn btn-primary" id="r-analyze">📤 Feltöltés (a háttérben feldolgozza)</button>
        <p class="muted" style="font-size:12px;margin-top:8px">Feltöltés után nyugodtan kiléphetsz – a háttérben feldolgozza, és a 📥 listában jelenik meg.</p>`;
      attachCompanyAutocomplete();
      document.getElementById('r-addbtn').addEventListener('click', () => document.getElementById('r-files').click());
      document.getElementById('r-files').addEventListener('change', handleFiles);
      document.getElementById('r-analyze').addEventListener('click', queueUpload);
      renderThumbs();
    }
  }

  // ---- Kézi bevitel (saját tapasztalat) ----
  function manualFormHtml() {
    const chips = Object.keys(TAG_LABELS).map((k) =>
      `<button type="button" class="tagchip" data-t="${k}" onclick="this.classList.toggle('on')">${TAG_LABELS[k]}</button>`).join('');
    const exOpts = Object.entries(EXCHANGE_LABELS).map(([k, vL]) => `<option value="${k}">${vL}</option>`).join('');
    return `
      <label>Értékelés (a te tapasztalatod)</label>
      <div class="verdict-pick" id="m-verdict">
        <button type="button" class="vpick" data-v="positive" onclick="App.pickVerdict(this)">✅ Fizet</button>
        <button type="button" class="vpick" data-v="neutral" onclick="App.pickVerdict(this)">⚠️ Semleges</button>
        <button type="button" class="vpick" data-v="negative" onclick="App.pickVerdict(this)">⛔ Nem fizet</button>
      </div>
      <label>Címkék (pipáld, ami igaz)</label>
      <div class="tagpick" id="m-tags">${chips}</div>
      <div class="row2" style="margin-top:10px">
        <input class="f" id="m-amount" inputmode="decimal" placeholder="összeg (opcionális)" />
        <input class="f" id="m-cur" placeholder="pénznem" />
      </div>
      <label>Börze-kód (opcionális)</label>
      <div class="ref-add">
        <select class="f" id="m-ex">${exOpts}</select>
        <input class="f" id="m-code" placeholder="azonosító / kód" />
      </div>
      <label>Saját tapasztalat / megjegyzés</label>
      <textarea class="f" id="m-note" placeholder="pl. Fizet, de 10 nap késéssel"></textarea>
      <button class="btn btn-primary" onclick="App.saveManual()">💾 Mentés</button>`;
  }
  function pickVerdict(btn) {
    document.querySelectorAll('#m-verdict .vpick').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active'); manualVerdict = btn.dataset.v;
  }
  async function saveManual() {
    const co = { id: val('r-company-id'), name: val('r-company'), cui: val('r-cui') };
    if (!co.id && !co.name) return toast('Adj meg egy céget');
    if (!manualVerdict) return toast('Válassz értékelést (Fizet / Semleges / Nem fizet)');
    const tags = [...document.querySelectorAll('#m-tags .tagchip.on')].map((b) => b.dataset.t);
    const note = val('m-note');
    const vLabel = manualVerdict === 'positive' ? 'Fizet' : manualVerdict === 'negative' ? 'Nem fizet' : 'Semleges';
    const text = note || `${vLabel}${tags.length ? ' – ' + tags.map((t) => TAG_LABELS[t]).join(', ') : ''}`;
    const comment = {
      text, text_hu: text, sentiment: manualVerdict,
      pay_signal: manualVerdict === 'positive' ? 'pays' : manualVerdict === 'negative' ? 'nonpay' : 'unknown',
      tags, amount: val('m-amount') || null, currency: val('m-cur') || null, due_text: null,
      author: (state.config && state.config.user) || 'saját', comment_date: new Date().toISOString().slice(0, 10),
    };
    let res;
    try {
      res = await api('/reports/commit', { method: 'POST', body: JSON.stringify({
        company_id: co.id || undefined, company_name: co.name, cui: co.cui || undefined, comments: [comment],
      }) });
    } catch (e) { return toast('Mentés sikertelen: ' + e.message); }
    const code = val('m-code');
    if (code && res.company && res.company.id) {
      try { await api('/companies/' + res.company.id + '/refs', { method: 'POST', body: JSON.stringify({ exchange: val('m-ex'), ref_code: code }) }); } catch {}
    }
    toast('Mentve ✓'); closeSheet(); loadList();
    if (res.company) checkDuplicate(res.company.id, res.company.name);
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

  // Feltöltés sorba: azonnal visszatér, a háttérben dolgozza fel. A kliens kiléphet.
  async function queueUpload() {
    if (!report.images.length) return toast('Tölts fel legalább egy képernyőképet');
    const co = { id: val('r-company-id'), name: val('r-company'), cui: val('r-cui') };
    const payload = {
      company_id: co.id || undefined, company_name: co.name || undefined, cui: co.cui || undefined,
      images: report.images.map(({ mimeType, data }) => ({ mimeType, data })),
    };
    try { await api('/reports/queue', { method: 'POST', body: JSON.stringify(payload) }); }
    catch (e) { return toast('Feltöltés sikertelen: ' + e.message); }
    closeSheet();
    toast('Feltöltve ✓ A háttérben feldolgozza – nézd a 📥 listát.');
    refreshPendingCount();
  }

  // ---- Megerősítésre vár (háttér-feldolgozás eredménye) ----
  async function openPending() {
    state.view = 'pending';
    let rows; try { rows = await api('/reports/pending'); } catch { rows = []; }
    view.innerHTML = `
      <button class="btn btn-ghost" style="margin:0 0 12px;width:auto;padding:8px 14px" onclick="App.go('list')">← Vissza</button>
      <h3 class="sec">Megerősítésre vár (${rows.length})</h3>
      ${rows.length ? rows.map(pendingCard).join('') : '<p class="muted">Nincs függőben lévő beküldés.</p>'}`;
  }
  function pendingCard(r) {
    const name = r.company_name || '(név nélkül)';
    if (r.status === 'processing') {
      return `<div class="card" style="cursor:default"><div class="cname">${esc(name)}</div>
        <div class="meta">⏳ feldolgozás alatt…</div></div>`;
    }
    if (r.status === 'error') {
      return `<div class="card" style="cursor:default"><div class="cname">${esc(name)}</div>
        <div class="meta s-neg">❌ ${esc(r.error || 'hiba')}</div>
        <button class="btn btn-ghost" style="width:auto;padding:6px 12px;margin-top:8px" onclick="App.discardReport('${r.id}')">Eldobás</button></div>`;
    }
    return `<div class="card" onclick="App.openReport('${r.id}')"><div class="cname">${esc(name)}</div>
      <div class="meta sumbar"><span class="vbadge v-mixed">${r.comment_count} komment · átnézésre vár</span>
      <span class="muted">${dateStr(r.created_at)}</span></div></div>`;
  }
  async function openReport(id) {
    let r; try { r = await api('/reports/' + id); } catch (e) { return toast('Hiba: ' + e.message); }
    if (r.status !== 'pending_review' || !r.result) return toast('Ez a beküldés még nincs kész vagy hibás.');
    report = { id, images: [], preview: r.result, company: { id: r.company_id || '', name: r.company_name || '', cui: r.cui || '' } };
    sheet.classList.remove('hidden');
    renderReportReview(r.result);
  }
  function discardReport(id) {
    if (!confirm('Biztos eldobod ezt a beküldést?')) return;
    api('/reports/' + id, { method: 'DELETE' }).then(() => { openPending(); refreshPendingCount(); }).catch((e) => toast('Hiba: ' + e.message));
  }
  async function refreshPendingCount() {
    let rows; try { rows = await api('/reports/pending'); } catch { return; }
    const n = rows.length;
    const btn = document.getElementById('pending-btn'), badge = document.getElementById('pending-count');
    if (btn) btn.style.display = n ? '' : 'none';
    if (badge) badge.textContent = n ? String(n) : '';
  }

  function tally(cs) {
    return cs.reduce((a, c) => (a[c.sentiment] = (a[c.sentiment] || 0) + 1, a), {});
  }
  function sentOptions(sel) {
    return ['positive', 'negative', 'neutral'].map((v) =>
      `<option value="${v}" ${sel === v ? 'selected' : ''}>${SENT_ICON[v]} ${v === 'positive' ? 'jó' : v === 'negative' ? 'rossz' : 'semleges'}</option>`).join('');
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
    return `<div class="cmt${c.about_other_company ? ' cmt-other' : ''}" data-i="${i}">
      ${c.about_other_company ? `<div class="review-flag">⚠ Lehet, hogy MÁS cégről szól${c.other_company_name ? ` (${esc(c.other_company_name)})` : ''} – ellenőrizd, és töröld (🗑), ha nem ehhez a céghez tartozik.</div>` : ''}
      <div class="cmt-row">
        <select class="f cmt-sent">${sentOptions(c.sentiment)}</select>
        <input class="f cmt-date" value="${esc(c.comment_date || '')}" placeholder="ÉÉÉÉ-HH-NN" />
        <button class="cmt-del" onclick="App.delComment(${i})">🗑</button>
      </div>
      <textarea class="f cmt-text">${esc(c.text_hu || c.text)}</textarea>
      ${c.text && c.text_hu && c.text.trim() !== c.text_hu.trim() ? `<div class="cmt-orig muted">eredeti: ${esc(c.text)}</div>` : ''}
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
      const huText = row.querySelector('.cmt-text').value.trim(); // a szerkesztett (magyar) szöveg
      return {
        author: prev.author || null,
        tags: prev.tags || [],
        due_text: prev.due_text || null,
        about_other_company: prev.about_other_company || false,
        other_company_name: prev.other_company_name || null,
        sentiment: row.querySelector('.cmt-sent').value,
        comment_date: row.querySelector('.cmt-date').value.trim() || null,
        amount: row.querySelector('.cmt-amount').value.trim() || null,
        currency: row.querySelector('.cmt-cur').value.trim() || null,
        text: prev.text || huText, // eredeti nyelvű szöveg megőrizve
        text_hu: huText,
      };
    });
    report.company = { id: val('rv-company-id'), name: val('rv-company'), cui: val('rv-cui') };
  }
  function delComment(i) { syncReview(); report.preview.comments.splice(i, 1); renderReportReview(report.preview); }
  // Eredeti nyelvű komment mutatása/elrejtése (a magyar fordítás alatt).
  function toggleOrig(btn) {
    const o = btn.nextElementSibling;
    if (!o) return;
    const show = o.style.display === 'none';
    o.style.display = show ? 'block' : 'none';
    btn.textContent = show ? '🇭🇺 magyar nézet' : '🌐 eredeti nyelv';
  }
  function useAiName() {
    const n = report.preview?.company_name; if (!n) return;
    syncReview();                                  // megőrizzük a komment-szerkesztéseket
    report.company = { ...report.company, name: n, id: '' };
    renderReportReview(report.preview);
    toast('Cégnév felülírva: ' + n);
  }

  function saveReport() {
    syncReview();
    const cs = report.preview.comments.filter((c) => c.text || c.text_hu);
    if (!cs.length) return toast('Nincs menthető komment');
    const co = report.company;
    if (!co.id && !co.name) return toast('Adj meg egy céget');
    const payload = {
      company_id: co.id || undefined, company_name: co.name, cui: co.cui || undefined,
      comments: cs.map((c) => ({
        text: c.text || c.text_hu, text_hu: c.text_hu, sentiment: c.sentiment, comment_date: c.comment_date,
        author: c.author, tags: c.tags || [], amount: c.amount, currency: c.currency, due_text: c.due_text,
        pay_signal: c.sentiment === 'positive' ? 'pays' : c.sentiment === 'negative' ? 'nonpay' : 'unknown',
      })),
    };
    // Jóváhagyás: a háttérben feldolgozott beküldés véglegesítése (a kommentek mentése + a beküldés törlése).
    api('/reports/' + report.id + '/commit', { method: 'POST', body: JSON.stringify(payload) })
      .then((r) => {
        toast(`Jóváhagyva ✓ (${r.inserted} új komment${r.skipped ? `, ${r.skipped} duplikátum` : ''})`);
        closeSheet(); refreshPendingCount(); openPending();
        if (r.company) checkDuplicate(r.company.id, r.company.name);
      })
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
    es.addEventListener('report.updated', () => { refreshPendingCount(); if (state.view === 'pending') openPending(); });
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
      <hr style="border:none;border-top:1px solid var(--line);margin:20px 0" />
      <h3 style="font-size:15px">Karbantartás</h3>
      <button class="btn btn-ghost" onclick="App.translateOld()">🌐 Régi kommentek lefordítása magyarra</button>
      <p class="muted" style="margin-top:16px;font-size:13px">Tipp: telepítsd kezdőképernyőre, majd a Facebookban „Megosztás → Vallorscan”, vagy nyomd meg a ＋ gombot és tölts fel képernyőképeket.</p>`;
  }
  function saveSettings() {
    localStorage.setItem('vs_server', val('s-server'));
    localStorage.setItem('vs_token', val('s-token'));
    toast('Mentve'); go('list');
  }
  // Régi (fordítás nélküli) kommentek lefordítása magyarra – ismételhető, ha sok maradt.
  async function translateOld() {
    toast('🌐 Fordítás folyamatban… (pár másodperc)');
    let r;
    try { r = await api('/admin/translate', { method: 'POST', body: JSON.stringify({ limit: 200 }) }); }
    catch (e) { return toast('Fordítás sikertelen: ' + e.message); }
    if (!r.translated && !r.remaining) return toast('Nincs fordítandó komment ✓');
    toast(`${r.translated} komment lefordítva${r.remaining ? `, még ${r.remaining} maradt – nyomd meg újra` : ' ✓'}`);
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
    updateNet(); connectSSE(); loadList(); handleSharedParam(); refreshPendingCount();
    if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  document.addEventListener('DOMContentLoaded', init);
  return { go, openCompany, openCompose, closeSheet, saveSettings, pickCompany, removeImg, delComment, saveReport, useAiName, addRef, delRefByIndex, renameCompany, deleteCompany, deleteComment, pickMerge, queueUpload, openPending, openReport, discardReport, toggleOrig, translateOld, composeMode, pickVerdict, saveManual, requestOpinion };
})();
