// Bejegyzés-feldolgozás: AI kinyerés (preview) → mentés (commit) dedup-pal.
import { db, now, uid, audit } from './db.js';
import { contentHash } from './normalize.js';
import { extract } from './ai.js';
import { resolveCompany } from './dedup.js';
import { broadcast } from './events.js';

const NEEDS_REVIEW = 0.6; // e alatt az AI-bizonyosság → "ellenőrzésre vár"

/** Preview: AI feldolgozás MENTÉS NÉLKÜL. Visszaadja a szerkeszthető mezőket + dedup-javaslatot. */
export async function previewShare({ text, url }) {
  const ai = await extract(text, url);
  const hash = contentHash(text, url);
  const existing = db.prepare('SELECT id, company_id FROM posts WHERE content_hash = ?').get(hash);
  // Lehetséges cég-egyezés megmutatása már a preview-ban (csak olvasás, nem ír).
  let suggestions = [];
  if (ai.company_name || ai.cui || ai.license_plates?.length) {
    const probe = db.transaction(() => {
      const r = resolveCompany(
        { name: ai.company_name, cui: ai.cui, plates: ai.license_plates }, 'preview',
      );
      throw { __rollback: true, r };
    });
    try { probe(); } catch (e) { if (e.__rollback) suggestions = e.r.suggestions || []; else throw e; }
  }
  return {
    ai,
    duplicate: existing ? { post_id: existing.id, company_id: existing.company_id } : null,
    suggestions,
    needs_review: ai.confidence < NEEDS_REVIEW,
  };
}

/**
 * Commit: a (felhasználó által ellenőrzött) mezők mentése.
 * fields: { company_name, cui, license_plates[], debt_amount, currency, delay_days,
 *           problem_type, summary, original_language, raw_text, source_url, source_type,
 *           confidence, force_company_id? }
 */
export function commitShare(fields, userId) {
  const text = fields.raw_text || '';
  const url = fields.source_url || null;
  const hash = contentHash(text, url);

  const dup = db.prepare('SELECT * FROM posts WHERE content_hash = ?').get(hash);
  if (dup) return { duplicate: true, post: dup };

  const tx = db.transaction(() => {
    let company, matchedBy, suggestions = [];
    if (fields.force_company_id) {
      company = db.prepare('SELECT * FROM companies WHERE id = ?').get(fields.force_company_id);
      if (!company) throw new Error('force_company_id ismeretlen');
      matchedBy = 'forced';
    } else {
      ({ company, matchedBy, suggestions } = resolveCompany({
        name: fields.company_name, cui: fields.cui, plates: fields.license_plates || [],
      }, userId));
    }

    const id = uid();
    const ts = now();
    const conf = Number(fields.confidence ?? 0.5);
    const status = conf < NEEDS_REVIEW ? 'needs_review' : 'confirmed';
    db.prepare(`
      INSERT INTO posts (id, company_id, raw_text, source_url, source_type, content_hash,
        language, debt_amount, currency, delay_days, problem_type, summary, ai_confidence,
        status, created_by, created_at, occurred_at)
      VALUES (@id,@company_id,@raw_text,@source_url,@source_type,@content_hash,@language,
        @debt_amount,@currency,@delay_days,@problem_type,@summary,@ai_confidence,@status,
        @created_by,@created_at,@occurred_at)
    `).run({
      id, company_id: company.id, raw_text: text, source_url: url,
      source_type: fields.source_type || 'manual', content_hash: hash,
      language: fields.original_language || null,
      debt_amount: numOrNull(fields.debt_amount), currency: fields.currency || null,
      delay_days: intOrNull(fields.delay_days), problem_type: fields.problem_type || null,
      summary: fields.summary || null, ai_confidence: JSON.stringify({ confidence: conf }),
      status, created_by: userId, created_at: ts, occurred_at: fields.occurred_at || ts,
    });

    db.prepare('INSERT INTO posts_fts (rowid, raw_text, summary, company_name) VALUES ((SELECT rowid FROM posts WHERE id=?), ?, ?, ?)')
      .run(id, text, fields.summary || '', company.name);
    db.prepare('UPDATE companies SET updated_at = ? WHERE id = ?').run(ts, company.id);
    audit(userId, 'post.create', 'post', id, { company_id: company.id, matchedBy });

    return { post: db.prepare('SELECT * FROM posts WHERE id = ?').get(id), company, matchedBy, suggestions };
  });

  const result = tx();
  broadcast('post.created', { company_id: result.company.id });
  return result;
}

function numOrNull(v) { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function intOrNull(v) { if (v == null || v === '') return null; const n = parseInt(v, 10); return Number.isFinite(n) ? n : null; }
