// Determinisztikus normalizálás és hasonlóság – minden dedup ezen alapul.
import crypto from 'node:crypto';

const LEGAL_FORMS = [
  // Román
  'srl', 'sa', 'sca', 'snc', 'pfa', 'ii', 'if', 'sc',
  // Magyar
  'kft', 'zrt', 'nyrt', 'bt', 'rt', 'kkt', 'ev',
  // Egyéb gyakori
  'gmbh', 'ltd', 'llc', 'inc', 'spzoo', 'sro', 'doo',
];

/** Ékezetek eltávolítása (RO + HU). */
export function stripDiacritics(s) {
  return s.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Cégnév normalizálása: kisbetű, ékezet nélkül, jogi forma nélkül, tömörített. */
export function normalizeCompanyName(raw) {
  if (!raw) return '';
  let s = stripDiacritics(String(raw)).toLowerCase();
  s = s.replace(/[._]/g, ' ').replace(/[^a-z0-9 ]/g, ' ');
  let tokens = s.split(/\s+/).filter(Boolean);
  tokens = tokens.filter((t) => !LEGAL_FORMS.includes(t));
  return tokens.join(' ').trim();
}

/** Román CUI normalizálása: csak számjegyek, RO prefix nélkül. */
export function normalizeCui(raw) {
  if (!raw) return null;
  let s = stripDiacritics(String(raw)).toUpperCase().replace(/[^A-Z0-9]/g, '');
  s = s.replace(/^(?:CUI|CIF|RO)+/, ''); // címke/ország-előtag eltávolítása
  if (!/^\d{2,10}$/.test(s)) return null; // RO CUI jellemzően 2-10 számjegy
  return s;
}

/** Rendszám normalizálása: nagybetű, szóköz/kötőjel nélkül. */
export function normalizePlate(raw) {
  if (!raw) return null;
  const s = stripDiacritics(String(raw)).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (s.length < 4 || s.length > 10) return null;
  return s;
}

/** Tartalom-hash a bejegyzés-duplikációhoz (normalizált szöveg + url). */
export function contentHash(text, url) {
  const norm = stripDiacritics(String(text || ''))
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  const u = String(url || '').trim().toLowerCase();
  return crypto.createHash('sha256').update(`${norm}\n${u}`).digest('hex');
}

/** Karakter-bigram Dice-együttható (0..1) – cégnév hasonlósághoz. */
export function diceSimilarity(a, b) {
  a = normalizeCompanyName(a);
  b = normalizeCompanyName(b);
  if (!a || !b) return 0;
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return a === b ? 1 : 0;
  const bigrams = (s) => {
    const m = new Map();
    for (let i = 0; i < s.length - 1; i++) {
      const g = s.slice(i, i + 2);
      m.set(g, (m.get(g) || 0) + 1);
    }
    return m;
  };
  const ma = bigrams(a);
  const mb = bigrams(b);
  let overlap = 0;
  for (const [g, c] of ma) {
    if (mb.has(g)) overlap += Math.min(c, mb.get(g));
  }
  const total = (a.length - 1) + (b.length - 1);
  return (2 * overlap) / total;
}

export { LEGAL_FORMS };
