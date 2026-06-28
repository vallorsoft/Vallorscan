// AI kinyerés: Gemini structured output, determinisztikus regex-fallbackkel.
import { normalizeCui, normalizePlate } from './normalize.js';

const API_KEY = process.env.GEMINI_API_KEY || '';

// Több ingyenes Gemini modell, sorrendben. Ha az egyik túlterhelt (503) vagy elfogyott
// az ingyenes kerete (429), automatikusan a következőre váltunk. Env-ből felülírható
// (GEMINI_MODELS=vesszővel; a régi GEMINI_MODEL is tiszteletben tartva, elsőként).
const DEFAULT_MODELS = ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.0-flash', 'gemini-2.0-flash-lite'];
const MODELS = (() => {
  const fromEnv = (process.env.GEMINI_MODELS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const list = fromEnv.length ? fromEnv : [...DEFAULT_MODELS];
  const single = (process.env.GEMINI_MODEL || '').trim();
  if (single && !list.includes(single)) list.unshift(single);
  return list;
})();

/** Egy konkrét modell hívása. Hibánál a HTTP státuszt is felteszi az errorra. */
async function geminiCall(model, body, timeoutMs) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${API_KEY}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = new Error(`Gemini HTTP ${res.status}: ${await res.text()}`);
      err.status = res.status;
      throw err;
    }
    const json = await res.json();
    const raw = json?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!raw) throw new Error('Gemini: üres válasz');
    return JSON.parse(raw);
  } finally {
    clearTimeout(t);
  }
}

/** Átmeneti/keret-hiba? Ilyenkor érdemes a következő modellel próbálkozni. */
function isRetryableModelError(e) {
  if (e.status && [429, 500, 503].includes(e.status)) return true; // rate limit / kvóta / túlterhelt
  const m = String(e.message || '').toUpperCase();
  return e.name === 'AbortError'
    || m.includes('OVERLOAD') || m.includes('UNAVAILABLE')
    || m.includes('RESOURCE_EXHAUSTED') || m.includes('QUOTA');
}

/** Végigpróbálja a modelleket: ha egy nem elérhető / elfogyott a kerete, jön a következő. */
async function geminiJSON(body, timeoutMs) {
  let lastErr;
  for (const model of MODELS) {
    try {
      const data = await geminiCall(model, body, timeoutMs);
      if (model !== MODELS[0]) console.log(`Gemini: a(z) ${model} modellt használtuk (az előző nem volt elérhető).`);
      return data;
    } catch (e) {
      lastErr = e;
      if (!isRetryableModelError(e)) throw e; // pl. 400 (hibás kérés) → nincs értelme váltani
      console.warn(`Gemini ${model} nem elérhető (${e.status || e.message}), próbálom a következő modellt…`);
    }
  }
  throw lastErr;
}

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

function geminiExtract(input) {
  return geminiJSON({
    systemInstruction: { parts: [{ text: SYSTEM_PROMPT }] },
    contents: [{ role: 'user', parts: [{ text: input }] }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: RESPONSE_SCHEMA, temperature: 0 },
  }, 20000);
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

// ===================== Képernyőkép-elemzés (kommentek) =====================

const SENTIMENTS = ['positive', 'negative', 'neutral'];
const PAY_SIGNALS = ['pays', 'nonpay', 'unknown'];
// Komment-címkék (problématípus / viselkedés) – ennél több infót adnak, mint a puszta fizet/nem.
export const COMMENT_TAGS = [
  'non_payment',          // nem fizet
  'late_payment',         // késve fizet
  'no_contact',           // nem veszi fel / nem válaszol
  'pays_only_on_report',  // csak incidens/feljelentés/nyomásra fizet
  'blocked_on_exchange',  // fuvarbörzén tiltva/blokkolva
  'eventually_paid',      // végül fizetett (nehezen / nyomásra)
  'fraud',                // csalás/átverés (găinari, javre, escroc)
  'damage',               // káresemény
  'dispute',              // vita / reklamáció
  'recommended',          // ajánlják
  'good_payer',           // korrekt / jól fizet
  'other',
];

const COMMENT_SCHEMA = {
  type: 'object',
  properties: {
    company_name: { type: 'string', nullable: true },
    comments: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          author: { type: 'string', nullable: true },
          text: { type: 'string' },
          sentiment: { type: 'string', enum: SENTIMENTS },
          pay_signal: { type: 'string', enum: PAY_SIGNALS },
          tags: { type: 'array', items: { type: 'string', enum: COMMENT_TAGS } },
          amount: { type: 'number', nullable: true },
          currency: { type: 'string', nullable: true },
          due_text: { type: 'string', nullable: true },
          date_text: { type: 'string', nullable: true },
          date_iso: { type: 'string', nullable: true },
        },
        required: ['text', 'sentiment', 'pay_signal'],
      },
    },
    original_language: { type: 'string' },
  },
  required: ['comments', 'original_language'],
};

function commentSystemPrompt(today) {
  return `Te egy fuvarozói reputáció-elemző asszisztens vagy. A bemenet Facebook-képernyőképek
egy fuvarozó/szállítmányozó cégről szóló posztról ÉS a hozzá tartozó kommentekről.
A szöveg lehet román, magyar vagy angol nyelvű.

Olvasd ki a posztot és MINDEN kommentet a képekről. Minden egyes kommenthez add meg:
- author: a hozzászóló neve, ha látszik (különben null).
- text: a komment szövege tömören, az eredeti nyelven.
- sentiment: a cégre nézve 'positive' (korrekt, fizet, ajánlják), 'negative'
  (nem fizet, csalás, panasz, megkárosít), vagy 'neutral' (kérdés, nem egyértelmű).
- pay_signal: 'pays' (fizet/korrekt), 'nonpay' (nem fizet/megkárosít), 'unknown'.
- tags: a kommentre illő címkék listája az alábbiakból (0 vagy több):
    non_payment (nem fizet), late_payment (késve fizet),
    no_contact (nem veszi fel a telefont / nem válaszol, pl. "nu răspund la telefon"),
    pays_only_on_report (csak incidens/feljelentés/nyomásra fizet, pl. "plătesc doar la incident"),
    blocked_on_exchange (fuvarbörzén tiltva/blokkolva, pl. "blocați de pe Bursă"),
    eventually_paid (végül fizetett, nehezen/nyomásra, pl. sok hívás után),
    fraud (csalás/átverés, pl. "găinari", "javre", "escroc", "țepari"),
    damage (káresemény), dispute (vita/reklamáció),
    recommended (ajánlják), good_payer (korrekt / jól fizet), other.
- amount: ha említenek konkrét tartozás-összeget, a szám (csak a szám). Pl. "4800 euro" -> 4800.
- currency: a pénznem (EUR, RON, HUF), ha van.
- due_text: a számla/lejárat megnevezése, ha említik (pl. "factura din decembrie", "scadentă 22-01-2026").
- date_text: a kommentnél látható időbélyeg EREDETI szövege (pl. "17 h", "7 h", "1 éve", "2 z").
- date_iso: ebből számított dátum 'YYYY-MM-DD' formában. MA: ${today}.
  A relatív időt EHHEZ képest számold vissza. Ha nincs látható időpont, hagyd null.

A poszt szövegéből próbáld kiolvasni az érintett cég nevét is (company_name).
Ha egy komment egy táblázat/incidens-kártya képét tartalmazza (összeg, lejárat, státusz),
abból is nyerd ki az összeget, lejáratot és a vonatkozó címkéket.
CSAK a képeken ténylegesen látható tartalomra támaszkodj, ne találj ki kommentet.`;
}

/**
 * Képernyőképekből kinyeri a kommenteket (csak Gemini kulccsal megy – a kép-OCR-hez
 * többmodellű AI kell). images: [{ mimeType, data(base64) }]. today: 'YYYY-MM-DD'.
 */
export async function extractCommentsFromImages(images, today) {
  if (!API_KEY) {
    const err = new Error('A képernyőkép-elemzéshez Gemini API-kulcs kell (GEMINI_API_KEY).');
    err.code = 'NO_AI_KEY';
    throw err;
  }
  const parts = [
    { text: 'Elemezd a következő Facebook-képernyőképeket a fenti szabályok szerint.' },
    ...images.map((im) => ({ inlineData: { mimeType: im.mimeType || 'image/jpeg', data: im.data } })),
  ];
  const data = await geminiJSON({
    systemInstruction: { parts: [{ text: commentSystemPrompt(today) }] },
    contents: [{ role: 'user', parts }],
    generationConfig: { responseMimeType: 'application/json', responseSchema: COMMENT_SCHEMA, temperature: 0 },
  }, 60000);
  return sanitizeComments(data);
}

function sanitizeComments(o) {
  const comments = (o.comments || [])
    .map((c) => ({
      author: c.author?.trim() || null,
      text: String(c.text || '').trim(),
      sentiment: SENTIMENTS.includes(c.sentiment) ? c.sentiment : 'neutral',
      pay_signal: PAY_SIGNALS.includes(c.pay_signal) ? c.pay_signal : 'unknown',
      tags: [...new Set((c.tags || []).filter((t) => COMMENT_TAGS.includes(t)))],
      amount: numOrNull(c.amount),
      currency: normCurrency(c.currency),
      due_text: c.due_text?.trim() || null,
      date_text: c.date_text?.trim() || null,
      comment_date: isoDateOrNull(c.date_iso),
    }))
    .filter((c) => c.text);
  return {
    company_name: o.company_name?.trim() || null,
    original_language: (o.original_language || 'other').toLowerCase().slice(0, 5),
    comments,
    engine: 'gemini',
  };
}

/** Csak érvényes 'YYYY-MM-DD' dátumot fogad el, egyébként null. */
export function isoDateOrNull(v) {
  if (!v) return null;
  const m = String(v).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(`${m[1]}-${m[2]}-${m[3]}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? null : `${m[1]}-${m[2]}-${m[3]}`;
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
