// Keresés és lekérdezések: cégnév, CUI, rendszám, kulcsszó (FTS) – mind támogatva.
import { db } from './db.js';
import { normalizeCui, normalizePlate, normalizeCompanyName } from './normalize.js';

const companyAgg = `
  SELECT c.*,
    (SELECT COUNT(*) FROM posts p WHERE p.company_id = c.id) AS post_count,
    (SELECT COALESCE(SUM(p.debt_amount),0) FROM posts p WHERE p.company_id = c.id) AS total_debt,
    (SELECT MAX(p.delay_days) FROM posts p WHERE p.company_id = c.id) AS max_delay,
    (SELECT MAX(p.created_at) FROM posts p WHERE p.company_id = c.id) AS last_post_at,
    (SELECT GROUP_CONCAT(DISTINCT p.problem_type) FROM posts p WHERE p.company_id = c.id) AS problem_types,
    (SELECT GROUP_CONCAT(plate_norm) FROM plates pl WHERE pl.company_id = c.id) AS plates
  FROM companies c
`;

export function listCompanies({ limit = 50, offset = 0 } = {}) {
  return db.prepare(`${companyAgg} ORDER BY last_post_at DESC NULLS LAST, c.updated_at DESC LIMIT ? OFFSET ?`)
    .all(limit, offset);
}

export function getCompany(id) {
  const company = db.prepare(`${companyAgg} WHERE c.id = ?`).get(id);
  if (!company) return null;
  const posts = db.prepare(
    `SELECT * FROM posts WHERE company_id = ? ORDER BY COALESCE(occurred_at, created_at) DESC`
  ).all(id);
  const plates = db.prepare('SELECT plate_norm, plate_raw FROM plates WHERE company_id = ?').all(id);
  return { ...company, posts, plate_list: plates };
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
    if (c.length) return { mode: 'cui', companies: c };
  }
  // Rendszám?
  const plate = normalizePlate(q);
  if (plate) {
    const c = db.prepare(`${companyAgg} WHERE c.id IN (SELECT company_id FROM plates WHERE plate_norm LIKE ?)`)
      .all(`%${plate}%`);
    if (c.length) return { mode: 'plate', companies: c };
  }
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

  // Egyesítés, duplikátum nélkül.
  const map = new Map();
  for (const c of [...byName, ...byKeyword]) map.set(c.id, c);
  return { mode: 'search', companies: [...map.values()].slice(0, limit) };
}

export function stats() {
  return {
    companies: db.prepare('SELECT COUNT(*) n FROM companies').get().n,
    posts: db.prepare('SELECT COUNT(*) n FROM posts').get().n,
    needs_review: db.prepare("SELECT COUNT(*) n FROM posts WHERE status = 'needs_review'").get().n,
  };
}
