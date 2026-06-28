// Adatbázis visszaállítás/egyesítés: feltöltött SQLite fájl adatait beolvasztja a központi DB-be.
// Nem írja felül a meglévőt – INSERT OR IGNORE-ral csak a hiányzó sorokat adja hozzá.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db } from './db.js';
import { broadcast } from './events.js';

// Szülő → gyerek sorrend (idegen kulcsok miatt a cégek mennek elöl).
const MERGE_TABLES = ['companies', 'plates', 'company_aliases', 'posts', 'comments', 'company_refs'];

/** base64 SQLite fájl beolvasztása a központi adatbázisba. Visszaadja, táblánként hány új sor jött. */
export function restoreFromBase64(b64) {
  if (!b64) throw new Error('Nincs feltöltött fájl.');
  const buf = Buffer.from(String(b64), 'base64');
  // SQLite fájl-e? (magic header: "SQLite format 3\0")
  if (buf.length < 16 || buf.slice(0, 15).toString('latin1') !== 'SQLite format 3') {
    throw new Error('Ez nem SQLite adatbázis fájl.');
  }
  const tmp = path.join(os.tmpdir(), `vs-restore-${process.pid}-${buf.length}.sqlite`);
  fs.writeFileSync(tmp, buf);
  try {
    // Validáció: tényleg Vallorscan adatbázis?
    const src = new Database(tmp, { readonly: true });
    const tables = src.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    src.close();
    if (!tables.includes('companies') || !tables.includes('comments')) {
      throw new Error('Nem Vallorscan adatbázis (hiányzó táblák).');
    }

    db.exec(`ATTACH DATABASE '${tmp.replace(/'/g, "''")}' AS src`);
    const added = {};
    try {
      db.transaction(() => {
        for (const t of MERGE_TABLES) {
          const liveCols = db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name);
          const srcCols = db.prepare(`PRAGMA src.table_info(${t})`).all().map((c) => c.name);
          const common = liveCols.filter((c) => srcCols.includes(c));
          if (!common.length) continue;
          const cols = common.map((c) => `"${c}"`).join(',');
          const before = db.prepare(`SELECT COUNT(*) n FROM main.${t}`).get().n;
          db.prepare(`INSERT OR IGNORE INTO main.${t} (${cols}) SELECT ${cols} FROM src.${t}`).run();
          added[t] = db.prepare(`SELECT COUNT(*) n FROM main.${t}`).get().n - before;
        }
      })();
    } finally {
      db.exec('DETACH DATABASE src');
    }
    broadcast('post.created', {});
    return { ok: true, added };
  } finally {
    try { fs.unlinkSync(tmp); } catch {}
  }
}
