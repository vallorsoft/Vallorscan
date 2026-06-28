// Vallorscan szerver – központi API + statikus PWA kiszolgálás + valós idejű SSE.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authMiddleware, requireRole, tokenFromReq } from './auth.js';
import { sseHandler } from './events.js';
import { previewShare, commitShare } from './posts.js';
import { listCompanies, getCompany, search, stats } from './queries.js';
import { mergeCompanies } from './dedup.js';
import { PROBLEM_TYPES } from './ai.js';
import { syncSince } from './sync.js';
import {
  bootstrapSuperadmin, login, logout, changePassword,
  listUsers, createUser, updateUser, resetCode, deleteUser,
} from './users.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();

// CORS – a natív Android app (Capacitor https://localhost eredet) és egyéb
// eredetű kliensek számára. A token a kérésben (Bearer / SSE query) utazik,
// így sütik nélkül nyitható meg; személyes/zárt használatra megfelelő.
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.header('Access-Control-Allow-Headers', 'authorization, content-type');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
  res.header('Vary', 'Origin');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true })); // Web Share Target POST-hoz

const PORT = process.env.PORT || 4000;
const PUBLIC = path.join(__dirname, '..', 'public');

// --- Valós idejű események (auth a query token alapján is mehet EventSource-nál) ---
app.get('/api/events', authMiddleware, sseHandler);

// --- Web Share Target: a Facebook "Megosztás" ide POST-ol (manifest action) ---
// Átirányítunk az SPA review nézetébe a megosztott tartalommal.
app.post('/share-target', (req, res) => {
  const text = req.body.text || req.body.title || '';
  const url = req.body.url || '';
  const qs = new URLSearchParams({ shared: '1', text, url }).toString();
  res.redirect(303, `/?${qs}`);
});

// --- Publikus auth: bejelentkezés (még nem kell munkamenet) ---
const pub = express.Router();
pub.post('/auth/login', (req, res) => {
  try {
    const { email, secret } = req.body || {};
    res.json(login(email, secret)); // { token, user }
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
app.use('/api', pub);

// --- API (munkamenet kötelező) ---
const api = express.Router();
api.use(authMiddleware);

// Auth – belépés utáni műveletek.
api.get('/auth/me', (req, res) => res.json({ user: req.user }));
api.post('/auth/logout', (req, res) => { logout(tokenFromReq(req)); res.json({ ok: true }); });
api.post('/auth/change-password', (req, res) => {
  try {
    const user = changePassword(req.user.id, req.body.new_password);
    res.json({ user });
  } catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Felhasználó-kezelés (superadmin/admin).
api.get('/users', requireRole('superadmin', 'admin'), (req, res) => {
  res.json({ users: listUsers() });
});
api.post('/users', requireRole('superadmin', 'admin'), (req, res) => {
  try { res.json(createUser(req.body, req.user)); } // { user, code }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
api.patch('/users/:id', requireRole('superadmin', 'admin'), (req, res) => {
  try { res.json({ user: updateUser(req.params.id, req.body, req.user) }); }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
api.post('/users/:id/reset-code', requireRole('superadmin', 'admin'), (req, res) => {
  try { res.json(resetCode(req.params.id, req.user)); } // { code }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});
api.delete('/users/:id', requireRole('superadmin', 'admin'), (req, res) => {
  try { res.json(deleteUser(req.params.id, req.user)); } // { ok }
  catch (e) { res.status(e.status || 500).json({ error: e.message }); }
});

// Inkrementális szinkron.
api.get('/sync', (req, res) => res.json(syncSince(req.query.since)));

api.get('/config', (req, res) => res.json({ problem_types: PROBLEM_TYPES, user: req.user }));
api.get('/stats', (req, res) => res.json(stats()));

api.post('/share/preview', async (req, res) => {
  try {
    const { text, url } = req.body;
    if (!text && !url) return res.status(400).json({ error: 'text vagy url kötelező' });
    res.json(await previewShare({ text: text || '', url: url || '' }));
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

api.post('/share/commit', (req, res) => {
  try {
    const result = commitShare(req.body, req.user.id);
    res.json(result);
  } catch (e) { res.status(500).json({ error: String(e.message || e) }); }
});

api.get('/companies', (req, res) => res.json(listCompanies({
  limit: Number(req.query.limit) || 50, offset: Number(req.query.offset) || 0,
})));

api.get('/companies/:id', (req, res) => {
  const c = getCompany(req.params.id);
  if (!c) return res.status(404).json({ error: 'not found' });
  res.json(c);
});

api.post('/companies/:id/merge', (req, res) => {
  try {
    mergeCompanies(req.params.id, req.body.source_id, req.user.id);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

api.get('/search', (req, res) => res.json(search(req.query.q, { limit: Number(req.query.limit) || 50 })));

app.use('/api', api);

// --- Statikus PWA ---
app.use(express.static(PUBLIC));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

bootstrapSuperadmin(); // induláskor: superadmin biztosítása

app.listen(PORT, () => {
  console.log(`Vallorscan fut: http://localhost:${PORT}`);
});
