// AI kinyerés: Gemini structured output, determinisztikus regex-fallbackkel.
import { normalizeCui, normalizePlate } from './normalize.js';

const API_KEY = process.env.GEMINI_API_KEY || '';
const MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';

const PROBLEM_TYPES = ['non_payment', 'late_payment', 'fraud', 'damage', 'dispute', 'other'];

const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    company_name: { type: 'string', nullable: true },
    cui: { type: 'string', nullable: true },
    license_plates: { type: 'array', items: { type: 'string' } },
    debt_amount: { type: 'number', nullable: true },
    currency: { type: 'string', nullable: true },
    delay_days: { type: 'integer', nullable: true },
    problem_type: { type: 'string', enum: PROBLEM_TYPES, nullable: true },
    original_language: { type: 'string' },
    summary: { type: 'string' },
    confidence: { type: 'number' },
  },
  required: ['license_plates', 'original_language', 'summary', 'confidence'],
};

const SYSTEM_PROMPT = `Te egy fuvarozói feketelistát építő asszisztens vagy.
A bemenet egy Facebook-csoportból vagy nyilvános forrásból megosztott szöveg, ami
egy NEM FIZETŐ vagy PROBLÉMÁS fuvarozó/szállítmányozó cégről szól. A szöveg lehet
román, magyar vagy angol nyelvű.

Nyerd ki a következőket (ha valami nem szerepel, hagyd null / üres):
- company_name: a cég neve (jogi forma nélkül is elég, pl. "Transport Marfa").
- cui: román adószám (CUI/CIF), pl. "RO12345678" vagy "12345678".
- license_plates: rendszámok listája (pl. "B 123 ABC", "CJ-12-XYZ").
- debt_amount: a tartozás összege számként (csak a szám).
- currency: pénznem (RON, EUR, HUF).
- delay_days: fizetési késés napokban, egész szám.
- problem_type: ${PROBLEM_TYPES.join(' | ')}.
- original_language: 'ro' | 'hu' | 'en' | 'other'.
- summary: 1-2 mondatos magyar összefoglaló a problémáról.
- confidence: 0..1, mennyire vagy biztos a kinyert adatokban.

CSAK a tényekre támaszkodj a szövegből, ne találj ki adatot.`;

export async function extract(text, url) {
  const input = [text, url].filter(Boolean).join('\n');
  if (!API_KEY) return { ...fallbackExtract(input), engine: 'fallback' };
  try {
    const out = await geminiExtract(input);
    return { ...sanitize(out), engine: 'gemini' };
  } catch (err) {
    return { ...fallbackExtract(input), engine: 'fallback', error: String(err.message || err) };
  }
}

async function geminiExtract(input) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent?key=${API_KEY}`;
  const body = {
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: input }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: RESPONSE_SCHEMA,
      temperature: 0,
    },
  };
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 20000);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
    const json = await res.json();
    const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error('Gemini: üres válasz');
    return JSON.parse(raw);
  } finally {
    clearTimeout(t);
  }
}

/** Az AI kimenet tisztítása + determinisztikus normalizálás (kódban, nem AI-ban). */
function sanitize(o) {
  const plates = (o.license_plates || []).map(normalizePlate).filter(Boolean);
  return {
    company_name: o.company_name?.trim() || null,
    cui: normalizeCui(o.cui),
    license_plates: [...new Set(plates)],
    debt_amount: numOrNull(o.debt_amount),
    currency: normCurrency(o.currency),
    delay_days: intOrNull(o.delay_days),
    problem_type: PROBLEM_TYPES.includes(o.problem_type) ? o.problem_type : null,
    original_language: (o.original_language || 'other').toLowerCase().slice(0, 5),
    summary: o.summary?.trim() || '',
    confidence: clamp01(o.confidence ?? 0.5),
  };
}

// --- Fallback: kulcs nélküli, regex alapú kinyerés (offline / no-key) ---
export function fallbackExtract(text) {
  const t = String(text || '');
  const cuiMatch = t.match(/\b(?:RO|CUI|CIF)[\s:]*?(\d{2,10})\b/i) || t.match(/\bRO\s?(\d{2,10})\b/i);
  const cui = normalizeCui(cuiMatch ? cuiMatch[1] : null);

  // Rendszámok: RO minta (1-2 betű megye + 2-3 szám + 3 betű) és magyar (3 betű + 3 szám).
  // A nagybetűsítés miatt gyakori szavak (pl. "60 nap") álpozitívak lehetnek → végződés-szűrés.
  const PLATE_STOP = new Set(['NAP', 'LEI', 'RON', 'EUR', 'HUF', 'SRL', 'ZRT', 'KFT', 'CUI', 'CIF', 'ZILE']);
  const plateRe = /\b([A-Z]{1,2}[\s-]?\d{2,3}[\s-]?[A-Z]{3}|[A-Z]{3}[\s-]?\d{3})\b/g;
  const plates = [...new Set(
    (t.toUpperCase().match(plateRe) || [])
      .map(normalizePlate)
      .filter((p) => p && !PLATE_STOP.has(p.slice(-3)))
  )];

  // Összeg + pénznem.
  const amtMatch = t.match(/(\d[\d.\s]{0,12}\d|\d)\s*(ron|lei|eur|€|huf|ft)\b/i);
  let debt_amount = null, currency = null;
  if (amtMatch) {
    debt_amount = numOrNull(amtMatch[1].replace(/[.\s]/g, ''));
    currency = normCurrency(amtMatch[2]);
  }

  // Késés napokban.
  const dayMatch = t.match(/(\d{1,4})\s*(nap|zile|days?|napja|napos)/i);
  const delay_days = dayMatch ? intOrNull(dayMatch[1]) : null;

  // Probléma típus kulcsszó alapján.
  const low = t.toLowerCase();
  let problem_type = null;
  if (/nem fizet|nu plate|nu plătește|neplata|unpaid|not pay/.test(low)) problem_type = 'non_payment';
  else if (/csal|fraud|insel|escroc|hamis/.test(low)) problem_type = 'fraud';
  else if (/kar |kár|damage|avarie|paguba/.test(low)) problem_type = 'damage';
  else if (/kes|kés|late|intarz|întârz|restant/.test(low)) problem_type = 'late_payment';

  // Cégnév: jogi forma köré eső szó(ak).
  const nameMatch = t.match(/([A-ZÁÉÍÓÖŐÚÜŰ][\wÁÉÍÓÖŐÚÜŰáéíóöőúüű.&-]*(?:\s+[A-ZÁÉÍÓÖŐÚÜŰ0-9][\wÁÉÍÓÖŐÚÜŰáéíóöőúüű.&-]*){0,3})\s+(?:SRL|SA|SC|KFT|ZRT|BT|GMBH|LTD)\b/i);
  const company_name = nameMatch ? nameMatch[0].trim() : null;

  const lang = /[ăâîșț]/i.test(t) ? 'ro' : /[őűáéíóöúü]/i.test(t) ? 'hu' : 'en';

  return {
    company_name,
    cui,
    license_plates: plates,
    debt_amount,
    currency,
    delay_days,
    problem_type,
    original_language: lang,
    summary: t.replace(/\s+/g, ' ').trim().slice(0, 180),
    confidence: 0.4, // fallback → mindig alacsony → "ellenőrzésre vár"
  };
}

function numOrNull(v) { const n = Number(v); return Number.isFinite(n) ? n : null; }
function intOrNull(v) { const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
function clamp01(v) { const n = Number(v); return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5; }
function normCurrency(c) {
  if (!c) return null;
  const x = String(c).toLowerCase();
  if (x.includes('eur') || x === '€') return 'EUR';
  if (x.includes('huf') || x === 'ft') return 'HUF';
  if (x.includes('ron') || x.includes('lei')) return 'RON';
  return c.toUpperCase().slice(0, 3);
}

export { PROBLEM_TYPES };
