// Vallorscan offline cache – IndexedDB lokális gyorsítótár + inkrementális szinkron.
// Böngészőben (PWA) és Capacitor WebView-ben is fut; háló nélkül a cache-ből olvas.
window.Store = (() => {
  const DB_NAME = 'vallorscan';
  const DB_VER = 1;
  const STORES = ['companies', 'details', 'meta'];

  // IndexedDB elérhető? (node --check alatt és régi WebView-ben nincs)
  const hasIDB = (() => { try { return typeof indexedDB !== 'undefined' && !!indexedDB; } catch { return false; } })();

  // ---- In-memory fallback (degradált mód, ha nincs/elromlik az IndexedDB) ----
  const mem = { companies: new Map(), details: new Map(), meta: new Map() };
  let useMem = !hasIDB;

  // ---- IndexedDB segédek: callback → Promise ----
  function req2promise(req) {
    return new Promise((resolve, reject) => {
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  function tx2promise(tx) {
    return new Promise((resolve, reject) => {
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error);
    });
  }

  // ---- DB megnyitás (egyszer, gyorsítótárazott ígéret) ----
  let dbPromise = null;
  function openDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
      let req;
      try { req = indexedDB.open(DB_NAME, DB_VER); }
      catch (e) { return reject(e); }
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('companies')) db.createObjectStore('companies', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('details')) db.createObjectStore('details', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('meta')) db.createObjectStore('meta', { keyPath: 'k' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('idb blocked'));
    });
    return dbPromise;
  }

  // Tranzakció-store kérése; hiba esetén in-memory módra váltunk.
  async function withStore(name, mode, fn) {
    if (useMem) return fn(null);
    try {
      const db = await openDB();
      const tx = db.transaction(name, mode);
      const store = tx.objectStore(name);
      const out = await fn(store);
      if (mode === 'readwrite') await tx2promise(tx);
      return out;
    } catch {
      // Tartós hiba → degradált memóriamódra váltunk és onnan szolgálunk ki.
      useMem = true;
      return fn(null);
    }
  }

  // ---- Sorrend: last_post_at desc (null a végére), majd updated_at desc ----
  function cmp(a, b) {
    const la = a && a.last_post_at, lb = b && b.last_post_at;
    if (la && !lb) return -1;
    if (!la && lb) return 1;
    if (la && lb) {
      const d = new Date(lb) - new Date(la);
      if (d) return d;
    }
    const ua = (a && a.updated_at) || '', ub = (b && b.updated_at) || '';
    return new Date(ub) - new Date(ua);
  }

  // ---- API ----

  // DB megnyitás/upgrade. Többször hívható; hiba esetén memóriamódra esik vissza.
  async function init() {
    if (useMem) return;
    try { await openDB(); }
    catch { useMem = true; }
  }

  // Összes gyorsítótárazott aggregált cég, a lista által várt sorrendben.
  async function getCompanies() {
    try {
      if (useMem) return Array.from(mem.companies.values()).sort(cmp);
      const all = await withStore('companies', 'readonly', (s) => s ? req2promise(s.getAll()) : Array.from(mem.companies.values()));
      return (all || []).slice().sort(cmp);
    } catch { return []; }
  }

  // Aggregált cégek tömeges upsertje (egy tranzakció).
  async function putCompanies(list) {
    if (!Array.isArray(list) || !list.length) return;
    try {
      await withStore('companies', 'readwrite', (s) => {
        for (const c of list) {
          if (!c || c.id == null) continue;
          if (s) s.put(c); else mem.companies.set(c.id, c);
        }
      });
    } catch {}
  }

  // companies store kiürítése, majd a megadott teljes lista beírása.
  async function replaceCompanies(list) {
    const arr = Array.isArray(list) ? list : [];
    try {
      await withStore('companies', 'readwrite', (s) => {
        if (s) {
          s.clear();
          for (const c of arr) if (c && c.id != null) s.put(c);
        } else {
          mem.companies.clear();
          for (const c of arr) if (c && c.id != null) mem.companies.set(c.id, c);
        }
      });
    } catch {}
  }

  // Gyorsítótárazott teljes cégrészlet vagy null.
  async function getCompany(id) {
    try {
      if (useMem) return mem.details.get(id) || null;
      const r = await withStore('details', 'readonly', (s) => s ? req2promise(s.get(id)) : (mem.details.get(id) || null));
      return r || null;
    } catch { return null; }
  }

  // Egy teljes cégrészlet upsertje (posts-szal együtt). Csak a details store-t írja.
  async function putCompany(detail) {
    if (!detail || detail.id == null) return;
    try {
      await withStore('details', 'readwrite', (s) => { if (s) s.put(detail); else mem.details.set(detail.id, detail); });
    } catch {}
  }

  // Tárolt szinkron-kurzor (ISO) vagy '' ha nincs.
  async function getCursor() {
    try {
      if (useMem) { const r = mem.meta.get('cursor'); return (r && r.v) || ''; }
      const r = await withStore('meta', 'readonly', (s) => s ? req2promise(s.get('cursor')) : mem.meta.get('cursor'));
      return (r && r.v) || '';
    } catch { return ''; }
  }

  // Szinkron-kurzor beállítása.
  async function setCursor(iso) {
    const row = { k: 'cursor', v: iso || '' };
    try {
      await withStore('meta', 'readwrite', (s) => { if (s) s.put(row); else mem.meta.set('cursor', row); });
    } catch {}
  }

  // Inkrementális szinkron: kurzortól kéri a változott cégeket, beírja, kurzort lépteti.
  // Offline/hiba esetén nem dob – {updated:0, cursor} választ ad.
  async function sync() {
    const cursor = await getCursor();
    let r;
    try {
      const VS = window.VS;
      r = await VS.api('/sync?since=' + encodeURIComponent(cursor));
    } catch {
      return { updated: 0, cursor };
    }
    const companies = (r && Array.isArray(r.companies)) ? r.companies : [];
    await putCompanies(companies);
    const next = (r && r.now) || cursor;
    if (next !== cursor) await setCursor(next);
    return { updated: companies.length, cursor: next };
  }

  // Minden store kiürítése (kijelentkezés / felhasználóváltás).
  async function clear() {
    try {
      if (!useMem) {
        const db = await openDB();
        const tx = db.transaction(STORES, 'readwrite');
        for (const n of STORES) tx.objectStore(n).clear();
        await tx2promise(tx);
      }
    } catch { useMem = true; }
    mem.companies.clear(); mem.details.clear(); mem.meta.clear();
  }

  return {
    init, getCompanies, putCompanies, replaceCompanies,
    getCompany, putCompany, getCursor, setCursor, sync, clear,
  };
})();
