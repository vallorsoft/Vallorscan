// Reputáció-beküldés: képernyőképek → AI komment-kinyerés (preview) → mentés (commit).
import crypto from 'node:crypto';
import { db, now, uid, audit } from './db.js';
import { extractCommentsFromImages, COMMENT_TAGS } from './ai.js';
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
         tags, amount, currency, due_text,
         comment_date, date_text, dedup_key, created_by, created_at)
      VALUES (@id,@company_id,@report_id,@author,@text,@sentiment,@pay_signal,
         @tags,@amount,@currency,@due_text,
         @comment_date,@date_text,@dedup_key,@created_by,@created_at)
    `);
    let inserted = 0;
    for (const c of comments) {
      const text = String(c.text || '').trim();
      if (!text) continue;
      const commentDate = c.comment_date || null;
      const tags = Array.isArray(c.tags) ? c.tags.filter((t) => COMMENT_TAGS.includes(t)) : [];
      const r = ins.run({
        id: uid(), company_id: company.id, report_id: reportId,
        author: c.author?.trim() || null, text,
        sentiment: SENT(c.sentiment), pay_signal: PAY(c.pay_signal),
        tags: tags.length ? JSON.stringify(tags) : null,
        amount: numOrNull(c.amount), currency: c.currency?.trim() || null,
        due_text: c.due_text?.trim() || null,
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

// ===================== Háttér-feldolgozás (megerősítésre vár) =====================

/** Feltöltés sorba állítása: azonnal visszatér, az AI a háttérben fut (a kliens kiléphet). */
export function queueReport({ company_id, company_name, cui, images }, userId) {
  if (!Array.isArray(images) || !images.length) throw new Error('Legalább egy képernyőkép kell.');
  const id = uid(), ts = now();
  db.prepare(`INSERT INTO reports (id, company_id, company_name, cui, status, created_by, created_at, updated_at)
    VALUES (?,?,?,?, 'processing', ?, ?, ?)`)
    .run(id, company_id || null, company_name || null, cui || null, userId, ts, ts);
  processReport(id, images).catch(() => {}); // nem várjuk meg – a háttérben fut
  broadcast('report.updated', { id });
  return { id, status: 'processing' };
}

/** A tényleges AI-feldolgozás a háttérben; a végén frissíti a reports sort. A képeket nem tároljuk. */
async function processReport(id, images) {
  try {
    const out = await extractCommentsFromImages(images, todayISO());
    db.prepare("UPDATE reports SET status='pending_review', result=?, updated_at=? WHERE id=?")
      .run(JSON.stringify(out), now(), id);
  } catch (e) {
    db.prepare("UPDATE reports SET status='error', error=?, updated_at=? WHERE id=?")
      .run(String(e.message || e), now(), id);
  }
  broadcast('report.updated', { id });
}

/** Függőben lévő beküldések listája (feldolgozás alatt / megerősítésre vár / hibás). */
export function listPendingReports() {
  const rows = db.prepare(`SELECT id, company_id, company_name, cui, status, error, created_at, updated_at, result
    FROM reports WHERE status IN ('processing','pending_review','error') ORDER BY created_at DESC`).all();
  return rows.map(({ result, ...r }) => {
    let comment_count = 0;
    if (result) { try { comment_count = (JSON.parse(result).comments || []).length; } catch {} }
    return { ...r, comment_count };
  });
}

/** Egy beküldés a felülvizsgálathoz (a kinyert kommentekkel). */
export function getReport(id) {
  const r = db.prepare('SELECT * FROM reports WHERE id = ?').get(id);
  if (!r) return null;
  let result = null;
  try { result = r.result ? JSON.parse(r.result) : null; } catch {}
  return { ...r, result };
}

/** Jóváhagyás: a (felhasználó által ellenőrzött) kommentek mentése, majd a beküldés törlése. */
export function approveReport(id, fields, userId) {
  if (!db.prepare('SELECT id FROM reports WHERE id = ?').get(id)) throw new Error('Ismeretlen beküldés.');
  const res = commitReport(fields, userId);
  db.prepare('DELETE FROM reports WHERE id = ?').run(id);
  broadcast('report.updated', { id });
  return res;
}

/** Egy függő beküldés eldobása (pl. hibás vagy fölösleges). */
export function discardReport(id) {
  db.prepare('DELETE FROM reports WHERE id = ?').run(id);
  broadcast('report.updated', { id });
  return { ok: true };
}

const SENT = (s) => (['positive', 'negative', 'neutral'].includes(s) ? s : 'neutral');
const PAY = (s) => (['pays', 'nonpay', 'unknown'].includes(s) ? s : 'unknown');
const numOrNull = (v) => { if (v == null || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; };

/** Duplikátum-kulcs: ugyanaz a komment (cég + normalizált szöveg + dátum) ne kerüljön be kétszer. */
function dedupKey(companyId, text, date) {
  const norm = stripDiacritics(String(text)).toLowerCase().replace(/\s+/g, ' ').trim();
  return crypto.createHash('sha256').update(`${companyId}\n${norm}\n${date || ''}`).digest('hex');
}
