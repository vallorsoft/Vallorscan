// Vallorscan – felhasználókezelés (superadmin/admin). Teljes overlay, sheet-mintás szerkesztők.
// Csak a window.VS futásidejű szerződésre támaszkodik.
window.Users = (() => {
  const VS = window.VS;

  const ROLE_LABELS = { superadmin: 'Superadmin', admin: 'Admin', user: 'Felhasználó' };

  // ---- Minimális CSS (badge-ek, kód-doboz) ----
  function injectStyle() {
    if (document.getElementById('users-style')) return;
    const css = `
    .users-overlay { position: fixed; inset: 0; z-index: 800; background: var(--bg); overflow-y: auto;
      padding-bottom: calc(24px + env(safe-area-inset-bottom)); }
    .users-head { position: sticky; top: 0; z-index: 5; display: flex; align-items: center;
      justify-content: space-between; gap: 10px; padding: 14px 16px;
      padding-top: max(14px, env(safe-area-inset-top)); background: var(--bg); border-bottom: 1px solid var(--line); }
    .users-head strong { font-size: 18px; }
    .users-body { padding: 14px 16px; }
    .u-row-top { display: flex; justify-content: space-between; gap: 8px; align-items: flex-start; }
    .u-name { font-weight: 700; font-size: 16px; }
    .u-actions { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 12px; }
    .u-actions .btn { width: auto; margin: 0; padding: 9px 14px; font-size: 14px; }
    .b-role-superadmin { background: #581c87; color: #e9d5ff; }
    .b-role-admin { background: #075985; color: #bae6fd; }
    .b-role-user { background: #334155; color: #cbd5e1; }
    .b-st-active { background: #14532d; color: #bbf7d0; }
    .b-st-disabled { background: #7f1d1d; color: #fecaca; }
    .b-st-invited { background: #78350f; color: #fde68a; }
    .code-box { border: 2px dashed var(--accent); border-radius: 12px; padding: 16px; margin-top: 8px;
      background: var(--bg); text-align: center; }
    .code-val { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 24px;
      font-weight: 800; letter-spacing: 2px; word-break: break-all; color: var(--text); }
    .code-note { color: var(--muted); font-size: 13px; margin-top: 12px; line-height: 1.4; }`;
    const el = document.createElement('style');
    el.id = 'users-style'; el.textContent = css;
    document.head.appendChild(el);
  }

  let overlay = null;
  let users = [];

  function hide() { if (overlay) { overlay.remove(); overlay = null; } }
  const isSuper = () => VS.currentUser && VS.currentUser.role === 'superadmin';

  // ---- Státusz: meghívott = még sosem lépett be ----
  function statusInfo(u) {
    if (u.status === 'disabled') return { cls: 'b-st-disabled', txt: 'Letiltva' };
    if (!u.last_login_at) return { cls: 'b-st-invited', txt: 'Meghívva' };
    return { cls: 'b-st-active', txt: 'Aktív' };
  }

  // ---- Egy felhasználó kártya ----
  function userCard(u) {
    const st = statusInfo(u);
    const me = VS.currentUser && VS.currentUser.id === u.id;
    // Törlés: nem önmagamon, és superadmint csak superadmin törölhet.
    const canDelete = !me && (u.role !== 'superadmin' || isSuper());
    return `<div class="card" style="cursor:default" data-id="${VS.esc(u.id)}">
      <div class="u-row-top">
        <div>
          <div class="u-name">${VS.esc(u.display_name || '—')}</div>
          <div class="meta">
            <span>${VS.esc(u.email)}</span>
            ${u.phone ? `<span>${VS.esc(u.phone)}</span>` : ''}
          </div>
        </div>
        <div style="display:flex;flex-direction:column;gap:4px;align-items:flex-end">
          <span class="badge b-role-${VS.esc(u.role)}">${ROLE_LABELS[u.role] || VS.esc(u.role)}</span>
          <span class="badge ${st.cls}">${st.txt}</span>
        </div>
      </div>
      <div class="u-actions">
        <button class="btn btn-ghost" data-act="edit" data-id="${VS.esc(u.id)}">Szerkesztés</button>
        <button class="btn btn-ghost" data-act="code" data-id="${VS.esc(u.id)}">Új kód</button>
        ${canDelete ? `<button class="btn btn-ghost" data-act="del" data-id="${VS.esc(u.id)}" style="color:var(--red)">Törlés</button>` : ''}
      </div>
    </div>`;
  }

  // ---- Lista betöltése + render ----
  async function load() {
    const body = overlay.querySelector('#users-body');
    body.innerHTML = `<div class="empty">Betöltés…</div>`;
    try {
      const r = await VS.api('/users');
      users = r.users || [];
      renderList();
    } catch (err) {
      body.innerHTML = `<div class="empty">${VS.esc((err && err.body && err.body.error) || 'Nem sikerült betölteni')}</div>`;
    }
  }

  function renderList() {
    const body = overlay.querySelector('#users-body');
    body.innerHTML = `
      <button class="btn btn-primary" id="u-new">＋ Új kolléga</button>
      ${users.length ? users.map(userCard).join('') : `<div class="empty">Nincs felhasználó.</div>`}`;
    body.querySelector('#u-new').onclick = openCreate;
    body.querySelectorAll('[data-act]').forEach((b) => {
      const id = b.dataset.id;
      const u = users.find((x) => String(x.id) === String(id));
      if (b.dataset.act === 'edit') b.onclick = () => openEdit(u);
      else if (b.dataset.act === 'code') b.onclick = () => doResetCode(u);
      else if (b.dataset.act === 'del') b.onclick = () => doDelete(u);
    });
  }

  // ---- Sheet segéd (a meglévő .sheet mintára, dinamikusan) ----
  function openSheet(title, innerHtml) {
    closeSheet();
    const sheet = document.createElement('div');
    sheet.className = 'sheet';
    sheet.id = 'u-sheet';
    sheet.innerHTML = `
      <div class="sheet-card">
        <div class="sheet-head">
          <strong>${VS.esc(title)}</strong>
          <button class="icon-btn" id="u-sheet-x">✕</button>
        </div>
        <div class="sheet-body" id="u-sheet-body">${innerHtml}</div>
      </div>`;
    overlay.appendChild(sheet);
    sheet.querySelector('#u-sheet-x').onclick = closeSheet;
    sheet.addEventListener('click', (e) => { if (e.target === sheet) closeSheet(); });
    return sheet.querySelector('#u-sheet-body');
  }
  function closeSheet() {
    const s = overlay && overlay.querySelector('#u-sheet');
    if (s) s.remove();
  }

  // ---- Kód-doboz (egyszer látható meghívó/visszaállító kód) ----
  function codeDisplay(container, code) {
    container.innerHTML = `
      <div class="code-box">
        <div class="code-val" id="cd-val">${VS.esc(code)}</div>
        <button class="btn btn-primary" id="cd-copy" style="margin-top:14px">Másolás</button>
        <p class="code-note">Ez a kód csak most jelenik meg. Add át a kollégának — ezzel és az email-címével lép be először, majd jelszót állít be.</p>
      </div>
      <button class="btn btn-ghost" id="cd-close">Bezárás</button>`;
    container.querySelector('#cd-copy').onclick = () => copyCode(code, container.querySelector('#cd-val'));
    container.querySelector('#cd-close').onclick = closeSheet;
  }
  function copyCode(code, valEl) {
    const done = () => VS.toast('Kód másolva');
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(code).then(done).catch(() => selectFallback(valEl));
    } else selectFallback(valEl);
  }
  function selectFallback(valEl) {
    try {
      const range = document.createRange(); range.selectNodeContents(valEl);
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range);
      VS.toast('Jelöld ki és másold a kódot');
    } catch { VS.toast('A másolás nem sikerült'); }
  }

  // ---- Új kolléga ----
  function roleOptions(selected) {
    let opts = `<option value="user" ${selected === 'user' ? 'selected' : ''}>Felhasználó</option>`;
    if (isSuper()) opts += `<option value="admin" ${selected === 'admin' ? 'selected' : ''}>Admin</option>`;
    return opts;
  }

  function openCreate() {
    const body = openSheet('Új kolléga', `
      <label>Email *</label>
      <input class="f" id="nc-email" type="email" inputmode="email" placeholder="email@cég.hu" />
      <label>Név</label>
      <input class="f" id="nc-name" placeholder="Teljes név" />
      <label>Telefon</label>
      <input class="f" id="nc-phone" type="tel" inputmode="tel" placeholder="+36…" />
      <label>Szerepkör</label>
      <select class="f" id="nc-role">${roleOptions('user')}</select>
      <button class="btn btn-primary" id="nc-submit">Létrehozás</button>`);
    body.querySelector('#nc-submit').onclick = async (e) => {
      const btn = e.currentTarget;
      const email = body.querySelector('#nc-email').value.trim();
      const display_name = body.querySelector('#nc-name').value.trim();
      const phone = body.querySelector('#nc-phone').value.trim();
      const role = body.querySelector('#nc-role').value;
      if (!email) return VS.toast('Az email kötelező');
      btn.disabled = true; const old = btn.textContent; btn.textContent = 'Mentés…';
      try {
        const r = await VS.api('/users', { method: 'POST', body: JSON.stringify({ email, phone, display_name, role }) });
        codeDisplay(body, r.code); // a sheet-ben mutatjuk a kódot
        load(); // lista frissítése a háttérben
      } catch (err) {
        VS.toast((err && err.body && err.body.error) || 'Nem sikerült létrehozni');
        btn.disabled = false; btn.textContent = old;
      }
    };
  }

  // ---- Szerkesztés ----
  function openEdit(u) {
    const body = openSheet('Szerkesztés', `
      <label>Név</label>
      <input class="f" id="ed-name" value="${VS.esc(u.display_name || '')}" />
      <label>Telefon</label>
      <input class="f" id="ed-phone" type="tel" inputmode="tel" value="${VS.esc(u.phone || '')}" />
      ${isSuper() && u.role !== 'superadmin' ? `
        <label>Szerepkör</label>
        <select class="f" id="ed-role">${roleOptions(u.role)}</select>` : ''}
      <label>Státusz</label>
      <select class="f" id="ed-status">
        <option value="active" ${u.status !== 'disabled' ? 'selected' : ''}>Aktív</option>
        <option value="disabled" ${u.status === 'disabled' ? 'selected' : ''}>Letiltva</option>
      </select>
      <button class="btn btn-primary" id="ed-submit">Mentés</button>`);
    body.querySelector('#ed-submit').onclick = async (e) => {
      const btn = e.currentTarget;
      const patch = {
        display_name: body.querySelector('#ed-name').value.trim(),
        phone: body.querySelector('#ed-phone').value.trim(),
        status: body.querySelector('#ed-status').value,
      };
      const roleSel = body.querySelector('#ed-role');
      if (roleSel) patch.role = roleSel.value;
      btn.disabled = true; const old = btn.textContent; btn.textContent = 'Mentés…';
      try {
        await VS.api('/users/' + encodeURIComponent(u.id), { method: 'PATCH', body: JSON.stringify(patch) });
        VS.toast('Mentve');
        closeSheet(); load();
      } catch (err) {
        VS.toast((err && err.body && err.body.error) || 'Nem sikerült menteni');
        btn.disabled = false; btn.textContent = old;
      }
    };
  }

  // ---- Új kód ----
  async function doResetCode(u) {
    try {
      const r = await VS.api('/users/' + encodeURIComponent(u.id) + '/reset-code', { method: 'POST' });
      const body = openSheet('Új kód – ' + (u.display_name || u.email), '');
      codeDisplay(body, r.code);
    } catch (err) {
      VS.toast((err && err.body && err.body.error) || 'Nem sikerült új kódot generálni');
    }
  }

  // ---- Törlés ----
  async function doDelete(u) {
    if (!confirm(`Biztosan törlöd: ${u.display_name || u.email}?`)) return;
    try {
      await VS.api('/users/' + encodeURIComponent(u.id), { method: 'DELETE' });
      VS.toast('Törölve');
      load();
    } catch (err) {
      VS.toast((err && err.body && err.body.error) || 'Nem sikerült törölni');
    }
  }

  // ---- Publikus API ----
  function show() {
    injectStyle();
    hide();
    overlay = document.createElement('div');
    overlay.className = 'users-overlay';
    overlay.innerHTML = `
      <div class="users-head">
        <strong>Felhasználók kezelése</strong>
        <button class="icon-btn" id="users-close">✕</button>
      </div>
      <div class="users-body" id="users-body"></div>`;
    document.body.appendChild(overlay);
    overlay.querySelector('#users-close').onclick = hide;
    load();
  }

  return { show };
})();
