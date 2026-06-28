// Vallorscan szerver – központi API + statikus PWA kiszolgálás + valós idejű SSE.
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { authMiddleware, authEnabled } from './auth.js';
import { sseHandler } from './events.js';
import { previewShare, commitShare } from './posts.js';
import { listCompanies, getCompany, search, stats } from './queries.js';
import { mergeCompanies } from './dedup.js';
import { PROBLEM_TYPES } from './ai.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true })); // Web Share Target POST-hoz

const PORT = process.env.PORT || 4000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC = path.join(__dirname, '..', 'public');

// --- Health check (Fly.io / load balancer figyeli, auth nélkül) ---
app.get('/healthz', (req, res) => res.json({ ok: true }));

// --- TWA / PWABuilder APK: Digital Asset Links (a böngészősáv elrejtéséhez).
// A tartalmat az ASSETLINKS_JSON env-ből szolgáljuk ki – a PWABuilder adja meg. ---
app.get('/.well-known/assetlinks.json', (req, res) => {
  res.type('application/json').send(process.env.ASSETLINKS_JSON || '[]');
});

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

// --- API ---
const api = express.Router();
api.use(authMiddleware);

api.get('/config', (req, res) => res.json({ problem_types: PROBLEM_TYPES, auth: authEnabled, user: req.user }));
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
    const result = commitShare(req.body, req.user);
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
    mergeCompanies(req.params.id, req.body.source_id, req.user);
    res.json({ ok: true });
  } catch (e) { res.status(400).json({ error: String(e.message || e) }); }
});

api.get('/search', (req, res) => res.json(search(req.query.q, { limit: Number(req.query.limit) || 50 })));

app.use('/api', api);

// --- Statikus PWA ---
app.use(express.static(PUBLIC));
app.get('*', (req, res) => res.sendFile(path.join(PUBLIC, 'index.html')));

app.listen(PORT, HOST, () => {
  console.log(`Vallorscan fut: http://${HOST}:${PORT}  (auth: ${authEnabled ? 'BE' : 'KI – csak teszthez'})`);
});
