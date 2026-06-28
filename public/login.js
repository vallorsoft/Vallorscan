// Vallorscan – bejelentkezés + kötelező jelszócsere teljes képernyős overlay.
// Csak a window.VS futásidejű szerződésre támaszkodik (hálózat/segédek).
window.Login = (() => {
  const VS = window.VS;

  // ---- Minimális CSS (csak az overlay/középre igazítás) ----
  function injectStyle() {
    if (document.getElementById('login-style')) return;
    const css = `
    .login-overlay { position: fixed; inset: 0; z-index: 1000; background: var(--bg);
      display: flex; align-items: center; justify-content: center; overflow-y: auto;
      padding: 24px 18px calc(24px + env(safe-area-inset-bottom));
      padding-top: max(24px, env(safe-area-inset-top)); }
    .login-card { width: 100%; max-width: 380px; background: var(--card);
      border: 1px solid var(--line); border-radius: 18px; padding: 24px 20px;
      box-shadow: 0 10px 40px rgba(0,0,0,.45); }
    .login-title { font-size: 26px; font-weight: 800; text-align: center; }
    .login-sub { color: var(--muted); text-align: center; margin-top: 4px; font-size: 14px; }
    .login-srv-toggle { background: none; border: none; color: var(--muted); font-size: 13px;
      cursor: pointer; margin-top: 14px; padding: 4px 0; }
    .login-srv.hidden { display: none; }
    .login-hint { color: var(--muted); font-size: 13px; margin-top: 12px; text-align: center; }`;
    const el = document.createElement('style');
    el.id = 'login-style'; el.textContent = css;
    document.head.appendChild(el);
  }

  let overlay = null;
  let onSuccessCb = null;

  function hide() {
    if (overlay) { overlay.remove(); overlay = null; }
  }

  // ---- Belépés képernyő ----
  function renderLogin() {
    overlay.innerHTML = `
      <div class="login-card">
        <div class="login-title">🚚 Vallorscan</div>
        <div class="login-sub">Bejelentkezés</div>
        <label>Email</label>
        <input class="f" id="lg-email" type="email" inputmode="email" autocomplete="username" placeholder="email@cég.hu" />
        <label>Jelszó vagy meghívó kód</label>
        <input class="f" id="lg-secret" type="password" autocomplete="current-password" placeholder="••••••••" />
        <button class="login-srv-toggle" id="lg-srv-toggle" type="button">⚙ Szerver</button>
        <div class="login-srv hidden" id="lg-srv-wrap">
          <label>Szerver cím</label>
          <input class="f" id="lg-server" type="url" inputmode="url" placeholder="https://..." value="${VS.esc(VS.base())}" />
        </div>
        <button class="btn btn-primary" id="lg-submit" type="button">Belépés</button>
      </div>`;

    const srvWrap = overlay.querySelector('#lg-srv-wrap');
    // Ha már van beállított szerver, nyitva mutatjuk (natív app esetén kell).
    if (VS.base()) srvWrap.classList.remove('hidden');
    overlay.querySelector('#lg-srv-toggle').onclick = () => srvWrap.classList.toggle('hidden');

    const btn = overlay.querySelector('#lg-submit');
    btn.onclick = doLogin;
    // Enter az utolsó mezőben → belépés.
    overlay.querySelector('#lg-secret').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
    overlay.querySelector('#lg-email').focus();
  }

  async function doLogin() {
    const btn = overlay.querySelector('#lg-submit');
    const email = overlay.querySelector('#lg-email').value.trim();
    const secret = overlay.querySelector('#lg-secret').value;
    const server = overlay.querySelector('#lg-server').value.trim();
    if (!email || !secret) return VS.toast('Add meg az emailt és a jelszót/kódot');
    // Szerver címet a kérés ELŐTT állítjuk be (natív app, nincs azonos eredet).
    if (server) VS.setBase(server);
    btn.disabled = true; const old = btn.textContent; btn.textContent = 'Belépés…';
    try {
      const res = await VS.api('/auth/login', { method: 'POST', body: JSON.stringify({ email, secret }) });
      VS.setToken(res.token);
      VS.currentUser = res.user;
      if (res.user && res.user.must_change_password) {
        renderChangePassword(); // még nem hívjuk az onSuccess-t
      } else {
        hide();
        if (onSuccessCb) onSuccessCb(res.user);
      }
    } catch (err) {
      if (err && err.status === 401) VS.toast('Hibás email vagy jelszó/kód');
      else VS.toast((err && err.body && err.body.error) || 'Bejelentkezési hiba');
      btn.disabled = false; btn.textContent = old;
    }
  }

  // ---- Kötelező jelszócsere képernyő ----
  function renderChangePassword() {
    overlay.innerHTML = `
      <div class="login-card">
        <div class="login-title">🚚 Vallorscan</div>
        <div class="login-sub">Új jelszó beállítása</div>
        <p class="login-hint">A folytatás előtt új jelszót kell beállítanod.</p>
        <label>Új jelszó</label>
        <input class="f" id="cp-pw1" type="password" autocomplete="new-password" placeholder="legalább 8 karakter" />
        <label>Új jelszó újra</label>
        <input class="f" id="cp-pw2" type="password" autocomplete="new-password" placeholder="ismételd meg" />
        <button class="btn btn-primary" id="cp-submit" type="button">Jelszó beállítása</button>
      </div>`;
    const btn = overlay.querySelector('#cp-submit');
    btn.onclick = doChangePassword;
    overlay.querySelector('#cp-pw2').addEventListener('keydown', (e) => { if (e.key === 'Enter') doChangePassword(); });
    overlay.querySelector('#cp-pw1').focus();
  }

  async function doChangePassword() {
    const btn = overlay.querySelector('#cp-submit');
    const pw1 = overlay.querySelector('#cp-pw1').value;
    const pw2 = overlay.querySelector('#cp-pw2').value;
    if (pw1.length < 8) return VS.toast('A jelszó legalább 8 karakter legyen');
    if (pw1 !== pw2) return VS.toast('A két jelszó nem egyezik');
    btn.disabled = true; const old = btn.textContent; btn.textContent = 'Beállítás…';
    try {
      const res = await VS.api('/auth/change-password', { method: 'POST', body: JSON.stringify({ new_password: pw1 }) });
      VS.currentUser = res.user;
      hide();
      VS.toast('Jelszó beállítva');
      if (onSuccessCb) onSuccessCb(res.user);
    } catch (err) {
      VS.toast((err && err.body && err.body.error) || 'Nem sikerült a jelszócsere');
      btn.disabled = false; btn.textContent = old;
    }
  }

  // ---- Publikus API ----
  function show(onSuccess) {
    injectStyle();
    onSuccessCb = onSuccess;
    hide(); // ne legyen kettő
    overlay = document.createElement('div');
    overlay.className = 'login-overlay';
    document.body.appendChild(overlay);
    renderLogin();
  }

  return { show, hide };
})();
