// Duplikáció-kezelés: cég-feloldás (CUI → rendszám → fuzzy név) és bejegyzés-dedup.
import { db, now, uid, audit } from './db.js';
import {
  normalizeCompanyName, normalizeCui, normalizePlate, diceSimilarity,
} from './normalize.js';

const THRESHOLD = Number(process.env.COMPANY_MATCH_THRESHOLD || 0.82);

/**
 * Megkeresi vagy létrehozza a céget az AI által kinyert adatokból.
 * Visszaad: { company, matchedBy, suggestions }.
 *  - matchedBy: 'cui' | 'plate' | 'name' | 'created'
 *  - suggestions: lehetséges duplikátumok kézi összevonáshoz (név-hasonlóság alapján)
 */
export function resolveCompany({ name, cui, plates = [] }, userId) {
  const cuiN = normalizeCui(cui);
  const nameN = normalizeCompanyName(name);
  const plateNs = [...new Set(plates.map(normalizePlate).filter(Boolean))];

  // 1) CUI – legerősebb azonosító, automatikus egyezés.
  if (cuiN) {
    const found = db.prepare('SELECT * FROM companies WHERE cui = ?').get(cuiN);
    if (found) {
      attachPlates(found.id, plateNs, plates);
      return { company: found, matchedBy: 'cui', suggestions: [] };
    }
  }

  // 2) Rendszám – ha már egy céghez tartozik, automatikus egyezés.
  for (const pn of plateNs) {
    const row = db.prepare(
      `SELECT c.* FROM plates p JOIN companies c ON c.id = p.company_id WHERE p.plate_norm = ?`
    ).get(pn);
    if (row) {
      if (cuiN && !row.cui) {
        db.prepare('UPDATE companies SET cui = ?, updated_at = ? WHERE id = ?')
          .run(cuiN, now(), row.id);
        row.cui = cuiN;
      }
      attachPlates(row.id, plateNs, plates);
      return { company: row, matchedBy: 'plate', suggestions: [] };
    }
  }

  // 3) Fuzzy név – NEM automatikus. Erős egyezésnél összekapcsol, gyengénél javasol.
  let best = null;
  const suggestions = [];
  if (nameN) {
    const candidates = db.prepare('SELECT * FROM companies').all();
    for (const c of candidates) {
      const sim = Math.max(
        diceSimilarity(nameN, c.normalized_name),
        ...aliasSims(c.id, nameN),
      );
      if (sim >= 0.6) suggestions.push({ company: c, similarity: Number(sim.toFixed(3)) });
      if (!best || sim > best.sim) best = { company: c, sim };
    }
    suggestions.sort((a, b) => b.similarity - a.similarity);
  }

  // Nagyon erős név-egyezés (és nincs ütköző CUI) → összekapcsolás.
  if (best && best.sim >= 0.93 && !(cuiN && best.company.cui && best.company.cui !== cuiN)) {
    if (cuiN && !best.company.cui) {
      db.prepare('UPDATE companies SET cui = ?, updated_at = ? WHERE id = ?')
        .run(cuiN, now(), best.company.id);
      best.company.cui = cuiN;
    }
    attachPlates(best.company.id, plateNs, plates);
    return { company: best.company, matchedBy: 'name', suggestions: suggestions.slice(0, 5) };
  }

  // 4) Új cég.
  const company = createCompany({ name: name || '(ismeretlen cég)', cuiN, nameN }, userId);
  attachPlates(company.id, plateNs, plates);
  return {
    company,
    matchedBy: 'created',
    suggestions: suggestions.filter((s) => s.similarity >= THRESHOLD).slice(0, 5),
  };
}

function aliasSims(companyId, nameN) {
  const rows = db.prepare('SELECT alias_norm FROM company_aliases WHERE company_id = ?').all(companyId);
  return rows.length ? rows.map((r) => diceSimilarity(nameN, r.alias_norm)) : [0];
}

function createCompany({ name, cuiN, nameN }, userId) {
  const id = uid();
  const ts = now();
  db.prepare(
    `INSERT INTO companies (id, name, normalized_name, cui, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, name, nameN, cuiN, ts, ts);
  audit(userId, 'company.create', 'company', id, { name, cui: cuiN });
  return db.prepare('SELECT * FROM companies WHERE id = ?').get(id);
}

function attachPlates(companyId, plateNs, raws) {
  const ins = db.prepare(
    `INSERT OR IGNORE INTO plates (id, company_id, plate_raw, plate_norm, created_at)
     VALUES (?, ?, ?, ?, ?)`
  );
  for (const pn of plateNs) {
    const raw = raws.find((r) => normalizePlate(r) === pn) || pn;
    ins.run(uid(), companyId, raw, pn, now());
  }
}

/** Két cég összevonása (kézi). minden bejegyzés/rendszám/alias a targetbe kerül. */
export function mergeCompanies(targetId, sourceId, userId) {
  if (targetId === sourceId) return;
  const tx = db.transaction(() => {
    const src = db.prepare('SELECT * FROM companies WHERE id = ?').get(sourceId);
    const tgt = db.prepare('SELECT * FROM companies WHERE id = ?').get(targetId);
    if (!src || !tgt) throw new Error('company not found');

    db.prepare('UPDATE posts SET company_id = ? WHERE company_id = ?').run(targetId, sourceId);
    db.prepare('UPDATE OR IGNORE plates SET company_id = ? WHERE company_id = ?').run(targetId, sourceId);
    // A forrás neve aliasként megmarad a target alatt (jövőbeli egyezésekhez).
    db.prepare(
      `INSERT INTO company_aliases (id, company_id, alias_norm, created_at) VALUES (?, ?, ?, ?)`
    ).run(uid(), targetId, src.normalized_name, now());
    if (!tgt.cui && src.cui) {
      db.prepare('UPDATE companies SET cui = ?, updated_at = ? WHERE id = ?').run(src.cui, now(), targetId);
    }
    db.prepare('DELETE FROM companies WHERE id = ?').run(sourceId);
    audit(userId, 'company.merge', 'company', targetId, { merged: sourceId });
  });
  tx();
}
