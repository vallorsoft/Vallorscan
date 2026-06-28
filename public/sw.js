// Service worker – app-shell cache az offline működéshez.
const CACHE = 'vallorscan-v4';
const SHELL = ['/', '/index.html', '/app.js', '/styles.css', '/manifest.webmanifest',
  '/icons/icon-192.png', '/icons/icon-512.png'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) =>
    Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  // API: ne cache-eljük (mindig friss adat); offline a kliens outbox kezeli.
  if (url.pathname.startsWith('/api') || url.pathname === '/share-target') return;
  // App-shell: cache-first, hálózati frissítéssel.
  e.respondWith(
    caches.match(req).then((cached) =>
      cached || fetch(req).then((res) => {
        if (req.method === 'GET' && res.ok && url.origin === location.origin) {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
        }
        return res;
      }).catch(() => cached))
  );
});
