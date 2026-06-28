// Reputáció-beküldés: képernyőképek → AI komment-kinyerés (preview) → mentés (commit).
import crypto from 'node:crypto';
import { db, now, uid, audit } from './db.js';
import { extractCommentsFromImages } from './ai.js';
import { resolveCompany } from './dedup.js';
import { stripDiacritics } from './normalize.js';
import { broadcast } from './events.js';

const todayISO = () => new Date().toISOString().slice(0, 10);

/** Preview: AI elemzi a képeket, MENTÉS NÉLKÜL. Visszaadja a szerkeszthető kommenteket. */
export async function previewReport({ images }) {
  if (!Array.isArray(images) || !images.length) {
    throw new Error('Legalább egy képernyőkép kell.');
  }
  return extractCommentsFromImages(images, todayISO());
}

/**
 * Commit: a (felhasználó által ellenőrzött) kommentek mentése egy céghez.
 * fields: { company_id?, company_name?, cui?, comments: [{text, sentiment, pay_signal,
 *           comment_date, date_text, author}] }
 */
export function commitReport(fields, userId) {
  const comments = Array.isArray(fields.comments) ? fields.comments : [];
  if (!comments.length) throw new Error('Nincs menthető komment.');

  const tx = db.transaction(() => {
    // 1) Cég: vagy a kiválasztott meglévő, vagy névből feloldva/létrehozva.
    let company, matchedBy;
    if (fields.company_id) {
      company = db.prepare('SELECT * FROM companies WHERE id = ?').get(fields.company_id);
      if (!company) throw new Error('Ismeretlen company_id.');
      matchedBy = 'selected';
    } else {
      const name = (fields.company_name || '').trim();
      if (!name) throw new Error('Cégnév vagy cég kiválasztása kötelező.');
      ({ company, matchedBy } = resolveCompany({ name, cui: fields.cui, plates: [] }, userId));
    }

    // 2) Kommentek beszúrása (duplikátum-védelemmel).
    const reportId = uid();
    const ts = now();
    const ins = db.prepare(`
      INSERT OR IGNORE INTO comments
        (id, company_id, report_id, author, text, sentiment, pay_signal,
         comment_date, date_text, dedup_key, created_by, created_at)
      VALUES (@id,@company_id,@report_id,@author,@text,@sentiment,@pay_signal,
         @comment_date,@date_text,@dedup_key,@created_by,@created_at)
    `);
    let inserted = 0;
    for (const c of comments) {
      const text = String(c.text || '').trim();
      if (!text) continue;
      const commentDate = c.comment_date || null;
      const r = ins.run({
        id: uid(), company_id: company.id, report_id: reportId,
        author: c.author?.trim() || null, text,
        sentiment: SENT(c.sentiment), pay_signal: PAY(c.pay_signal),
        comment_date: commentDate, date_text: c.date_text?.trim() || null,
        dedup_key: dedupKey(company.id, text, commentDate),
        created_by: userId, created_at: ts,
      });
      inserted += r.changes;
    }

    db.prepare('UPDATE companies SET updated_at = ? WHERE id = ?').run(ts, company.id);
    audit(userId, 'report.create', 'company', company.id,
      { report_id: reportId, comments: comments.length, inserted, matchedBy });

    return { company, inserted, skipped: comments.length - inserted, matchedBy };
  });

  const result = tx();
  broadcast('post.created', { company_id: result.company.id });
  return result;
}

const SENT = (s) => (['positive', 'negative', 'neutral'].includes(s) ? s : 'neutral');
const PAY = (s) => (['pays', 'nonpay', 'unknown'].includes(s) ? s : 'unknown');

/** Duplikátum-kulcs: ugyanaz a komment (cég + normalizált szöveg + dátum) ne kerüljön be kétszer. */
function dedupKey(companyId, text, date) {
  const norm = stripDiacritics(String(text)).toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(`${companyId}\n${norm}\n${date || ''}`).digest('hex');
}
