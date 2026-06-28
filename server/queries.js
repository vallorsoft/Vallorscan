// Keresés és lekérdezések: cégnév, CUI, rendszám, börze-kód, kulcsszó (FTS).
import { db, now, uid, audit } from './db.js';
import { normalizeCui, normalizePlate, normalizeCompanyName } from './normalize.js';
import { computeVerdict } from './verdict.js';

export { computeVerdict };

const companyAgg = `
  SELECT c.*,
    (SELECT COUNT(*) FROM posts p WHERE p.company_id = c.id) AS post_count,
    (SELECT COALESCE(SUM(p.debt_amount),0) FROM posts p WHERE p.company_id = c.id) AS total_debt,
    (SELECT MAX(p.delay_days) FROM posts p WHERE p.company_id = c.id) AS max_delay,
    (SELECT MAX(p.created_at) FROM posts p WHERE p.company_id = c.id) AS last_post_at,
    (SELECT GROUP_CONCAT(DISTINCT p.problem_type) FROM posts p WHERE p.company_id = c.id) AS problem_types,
    (SELECT GROUP_CONCAT(plate_norm) FROM plates pl WHERE pl.company_id = c.id) AS plates,
    (SELECT COUNT(*) FROM comments cm WHERE cm.company_id = c.id) AS comment_count,
    (SELECT COUNT(*) FROM comments cm WHERE cm.company_id = c.id AND cm.sentiment='positive') AS pos_count,
    (SELECT COUNT(*) FROM comments cm WHERE cm.company_id = c.id AND cm.sentiment='negative') AS neg_count,
    (SELECT COUNT(*) FROM comments cm WHERE cm.company_id = c.id AND cm.sentiment='neutral') AS neu_count,
    (SELECT COUNT(*) FROM comments cm WHERE cm.company_id = c.id AND cm.sentiment='positive'
       AND cm.comment_date >= date('now','-6 months')) AS recent_pos,
    (SELECT COUNT(*) FROM comments cm WHERE cm.company_id = c.id AND cm.sentiment='negative'
       AND cm.comment_date >= date('now','-6 months')) AS recent_neg,
    (SELECT MAX(comment_date) FROM comments cm WHERE cm.company_id = c.id) AS last_comment_at
  FROM companies c
`;

function decorate(row) {
  return { ...row, ...computeVerdict(row) };
}

export function listCompanies({ limit = 50, offset = 0 } = {}) {
  return db.prepare(`${companyAgg} ORDER BY last_comment_at DESC NULLS LAST, last_post_at DESC NULLS LAST, c.updated_at DESC LIMIT ? OFFSET ?`)
    .all(limit, offset).map(decorate);
}

export function getCompany(id) {
  const company = db.prepare(`${companyAgg} WHERE c.id = ?`).get(id);
  if (!company) return null;
  const posts = db.prepare(
    `SELECT * FROM posts WHERE company_id = ? ORDER BY COALESCE(occurred_at, created_at) DESC`
  ).all(id);
  const comments = db.prepare(
    `SELECT * FROM comments WHERE company_id = ? ORDER BY COALESCE(comment_date, created_at) DESC`
  ).all(id);
  const plates = db.prepare('SELECT plate_norm, plate_raw FROM plates WHERE company_id = ?').all(id);
  const refs = db.prepare('SELECT exchange, ref_code FROM company_refs WHERE company_id = ? ORDER BY exchange').all(id);
  return { ...decorate(company), posts, comments, plate_list: plates, refs };
}

/** Cég börze-azonosítójának hozzáadása (Bursa Transport, Timocom, ...). */
export function addCompanyRef(companyId, exchange, refCode) {
  const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId);
  if (!company) throw new Error('Ismeretlen cég.');
  const ex = (String(exchange || 'egyeb').trim().toLowerCase().replace(/[^a-z0-9_]/g, '_') || 'egyeb').slice(0, 32);
  const code = String(refCode || '').trim();
  if (!code) throw new Error('A börze-kód kötelező.');
  db.prepare('INSERT OR IGNORE INTO company_refs (id, company_id, exchange, ref_code, created_at) VALUES (?,?,?,?,?)')
    .run(uid(), companyId, ex, code, now());
  return db.prepare('SELECT exchange, ref_code FROM company_refs WHERE company_id = ? ORDER BY exchange').all(companyId);
}

/** Cég börze-azonosítójának törlése. */
export function removeCompanyRef(companyId, exchange, refCode) {
  db.prepare('DELETE FROM company_refs WHERE company_id = ? AND exchange = ? AND ref_code = ?')
    .run(companyId, exchange, refCode);
  return db.prepare('SELECT exchange, ref_code FROM company_refs WHERE company_id = ? ORDER BY exchange').all(companyId);
}

/** Egyetlen komment törlése. */
export function deleteComment(commentId, userId) {
  db.prepare('DELETE FROM comments WHERE id = ?').run(commentId);
  audit(userId, 'comment.delete', 'comment', commentId);
  return { ok: true };
}

/** Cég törlése – a kommentek/rendszámok/börze-kódok kaszkádolva törlődnek. */
export function deleteCompany(companyId, userId) {
  db.prepare('DELETE FROM companies WHERE id = ?').run(companyId);
  audit(userId, 'company.delete', 'company', companyId);
  return { ok: true };
}

/** Cég átnevezése (név + CUI javítása). Visszaadja a frissített cég-sort. */
export function renameCompany(companyId, name, cui, userId) {
  const n = String(name || '').trim();
  if (!n) throw new Error('A cégnév kötelező.');
  const company = db.prepare('SELECT id FROM companies WHERE id = ?').get(companyId);
  if (!company) throw new Error('Ismeretlen cég.');
  const cuiN = normalizeCui(cui) || null;
  db.prepare('UPDATE companies SET name = ?, normalized_name = ?, cui = ?, updated_at = ? WHERE id = ?')
    .run(n, normalizeCompanyName(n), cuiN, now(), companyId);
  audit(userId, 'company.rename', 'company', companyId, { name: n, cui: cuiN });
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(companyId);
}

/**
 * Univerzális keresés. Felismeri, ha a kifejezés CUI vagy rendszám mintát ad,
 * egyébként cégnév + kulcsszó (FTS) keresést végez.
 */
export function search(qRaw, { limit = 50 } = {}) {
  const q = String(qRaw || '').trim();
  if (!q) return { mode: 'recent', companies: listCompanies({ limit }) };

  // CUI?
  const cui = normalizeCui(q);
  if (cui) {
    const c = db.prepare(`${companyAgg} WHERE c.cui = ?`).all(cui);
    if (c.length) return { mode: 'cui', companies: c.map(decorate) };
  }
  // Rendszám?
  const plate = normalizePlate(q);
  if (plate) {
    const c = db.prepare(`${companyAgg} WHERE c.id IN (SELECT company_id FROM plates WHERE plate_norm LIKE ?)`)
      .all(`%${plate}%`);
    if (c.length) return { mode: 'plate', companies: c.map(decorate) };
  }
  // Börze-azonosító (Bursa Transport / Timocom / ... kód)?
  const byRef = db.prepare(`${companyAgg} WHERE c.id IN (SELECT company_id FROM company_refs WHERE ref_code LIKE ?)`)
    .all(`%${q}%`);
  if (byRef.length) return { mode: 'ref', companies: byRef.map(decorate) };
  // Cégnév (normalizált, részleges).
  const nameN = normalizeCompanyName(q);
  const byName = nameN
    ? db.prepare(`${companyAgg} WHERE c.normalized_name LIKE ? ORDER BY post_count DESC LIMIT ?`)
        .all(`%${nameN}%`, limit)
    : [];

  // Kulcsszó FTS a bejegyzések szövegében → érintett cégek.
  let byKeyword = [];
  try {
    const ftsQuery = q.split(/\s+/).filter(Boolean).map((w) => `"${w.replace(/"/g, '')}"*`).join(' OR ');
    const rows = db.prepare(`
      SELECT DISTINCT p.company_id FROM posts_fts f
      JOIN posts p ON p.rowid = f.rowid
      WHERE posts_fts MATCH ? AND p.company_id IS NOT NULL LIMIT ?
    `).all(ftsQuery, limit);
    const ids = rows.map((r) => r.company_id);
    if (ids.length) {
      byKeyword = db.prepare(`${companyAgg} WHERE c.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
    }
  } catch { /* FTS szintaxis hiba esetén kihagyjuk */ }

  // Kulcsszó a hozzászólások szövegében (egyszerű LIKE) → érintett cégek.
  let byComment = [];
  try {
    const words = q.split(/\s+/).filter(Boolean);
    if (words.length) {
      const likeClause = words.map(() => 'cm.text LIKE ?').join(' OR ');
      const params = words.map((w) => `%${w}%`);
      const rows = db.prepare(`
        SELECT DISTINCT cm.company_id FROM comments cm
        WHERE (${likeClause}) AND cm.company_id IS NOT NULL LIMIT ?
      `).all(...params, limit);
      const ids = rows.map((r) => r.company_id);
      if (ids.length) {
        byComment = db.prepare(`${companyAgg} WHERE c.id IN (${ids.map(() => '?').join(',')})`).all(...ids);
      }
    }
  } catch { /* hibás bemenet esetén kihagyjuk */ }

  // Egyesítés, duplikátum nélkül.
  const map = new Map();
  for (const c of [...byName, ...byKeyword, ...byComment]) map.set(c.id, c);
  return { mode: 'search', companies: [...map.values()].slice(0, limit).map(decorate) };
}

export function stats() {
  return {
    companies: db.prepare('SELECT COUNT(*) n FROM companies').get().n,
    posts: db.prepare('SELECT COUNT(*) n FROM posts').get().n,
    needs_review: db.prepare("SELECT COUNT(*) n FROM posts WHERE status = 'needs_review'").get().n,
  };
}
