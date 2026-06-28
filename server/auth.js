// Munkamenet-alapú hitelesítés: Bearer token vagy ?token= (SSE EventSource-hoz).
import { validateSession, safeUser } from './users.js';

/** Nyers token kiolvasása a kérésből. */
export function tokenFromReq(req) {
  const hdr = req.headers.authorization || '';
  if (hdr.startsWith('Bearer ')) return hdr.slice(7).trim();
  return String(req.query.token || '').trim();
}

export function authMiddleware(req, res, next) {
  const raw = tokenFromReq(req);
  const row = validateSession(raw);
  if (!row) return res.status(401).json({ error: 'unauthorized' });
  req.user = safeUser(row);
  next();
}

/** Szerepkör-kényszerítés: req.user.role a megadottak közül legyen. */
export function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden' });
    }
    next();
  };
}
