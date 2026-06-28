// Inkrementális szinkron: csak a megadott időpont óta módosult cégek aggregált alakban.
import { db, now } from './db.js';

// Ugyanaz az aggregáció, mint a queries.listCompanies (companyAgg) – itt szűrve.
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

/** A sinceIso óta módosult cégek (vagy mind, ha falsy). */
export function syncSince(sinceIso) {
  const since = sinceIso ? String(sinceIso) : null;
  const companies = since
    ? db.prepare(`${companyAgg} WHERE c.updated_at > ? ORDER BY c.updated_at ASC`).all(since)
    : db.prepare(`${companyAgg} ORDER BY c.updated_at ASC`).all();
  return { now: now(), companies };
}
