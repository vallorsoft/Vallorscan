// Egyszerű token-alapú hitelesítés (Bearer). Zárt, cégen belüli használatra.
const tokens = new Map(); // token -> felhasználónév
(process.env.AUTH_TOKENS || '').split(',').map((s) => s.trim()).filter(Boolean).forEach((pair) => {
  const [name, token] = pair.split(':');
  if (name && token) tokens.set(token.trim(), name.trim());
});

export const authEnabled = tokens.size > 0;

export function authMiddleware(req, res, next) {
  if (!authEnabled) { req.user = 'local'; return next(); } // nyitott mód csak teszthez
  const hdr = req.headers.authorization || '';
  const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : (req.query.token || '');
  const user = tokens.get(String(token).trim());
  if (!user) return res.status(401).json({ error: 'unauthorized' });
  req.user = user;
  next();
}
