// Központi SQLite adatbázis – séma, indexek, FTS5 full-text keresés.
import Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';

const DB_PATH = process.env.DB_PATH || './data/vallorscan.sqlite';
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

export const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS companies (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  normalized_name TEXT NOT NULL,
  cui             TEXT,
  country         TEXT DEFAULT 'RO',
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
-- CUI egyediség: csak ott kényszerítve, ahol nem NULL.
CREATE UNIQUE INDEX IF NOT EXISTS ux_companies_cui ON companies(cui) WHERE cui IS NOT NULL;
CREATE INDEX IF NOT EXISTS ix_companies_norm ON companies(normalized_name);

CREATE TABLE IF NOT EXISTS plates (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  plate_raw   TEXT,
  plate_norm  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_plates_norm ON plates(plate_norm);
CREATE INDEX IF NOT EXISTS ix_plates_company ON plates(company_id);

CREATE TABLE IF NOT EXISTS company_aliases (
  id          TEXT PRIMARY KEY,
  company_id  TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  alias_norm  TEXT NOT NULL,
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_aliases_norm ON company_aliases(alias_norm);

CREATE TABLE IF NOT EXISTS posts (
  id            TEXT PRIMARY KEY,
  company_id    TEXT REFERENCES companies(id) ON DELETE SET NULL,
  raw_text      TEXT NOT NULL,
  source_url    TEXT,
  source_type   TEXT DEFAULT 'manual',
  content_hash  TEXT NOT NULL UNIQUE,
  language      TEXT,
  debt_amount   REAL,
  currency      TEXT,
  delay_days    INTEGER,
  problem_type  TEXT,
  summary       TEXT,
  ai_confidence TEXT,
  status        TEXT DEFAULT 'confirmed',
  created_by    TEXT,
  created_at    TEXT NOT NULL,
  occurred_at   TEXT
);
CREATE INDEX IF NOT EXISTS ix_posts_company ON posts(company_id, created_at DESC);
CREATE INDEX IF NOT EXISTS ix_posts_created ON posts(created_at DESC);

-- Full-text keresés a nyers szövegre és összefoglalóra.
CREATE VIRTUAL TABLE IF NOT EXISTS posts_fts USING fts5(
  raw_text, summary, company_name,
  content='', tokenize='unicode61 remove_diacritics 2'
);

-- Audit napló: ki, mit, mikor.
CREATE TABLE IF NOT EXISTS audit_log (
  id         TEXT PRIMARY KEY,
  user_id    TEXT,
  action     TEXT NOT NULL,
  entity     TEXT,
  entity_id  TEXT,
  detail     TEXT,
  created_at TEXT NOT NULL
);

-- Facebook-kommentek (képernyőképekből, AI-val kinyerve). Dátummal + hangulattal,
-- hogy a cég reputációja időben (trend) is értékelhető legyen.
CREATE TABLE IF NOT EXISTS comments (
  id           TEXT PRIMARY KEY,
  company_id   TEXT NOT NULL REFERENCES companies(id) ON DELETE CASCADE,
  report_id    TEXT,                 -- egy beküldés (screenshot-batch) azonosítója
  author       TEXT,
  text         TEXT NOT NULL,
  sentiment    TEXT,                 -- 'positive' | 'negative' | 'neutral'
  pay_signal   TEXT,                 -- 'pays' | 'nonpay' | 'unknown'
  comment_date TEXT,                 -- 'YYYY-MM-DD' (relatívból számolva), lehet NULL
  date_text    TEXT,                 -- eredeti időbélyeg szöveg, pl. "1 éve"
  dedup_key    TEXT,                 -- cég+szöveg+dátum hash → duplikátum-védelem
  created_by   TEXT,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_comments_company ON comments(company_id, comment_date DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ux_comments_dedup ON comments(dedup_key) WHERE dedup_key IS NOT NULL;
`);

// --- Migrációk: meglévő adatbázisnál a hiányzó oszlopok pótlása (adatvesztés nélkül) ---
function addColumnIfMissing(table, col, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === col)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${type}`);
  }
}
addColumnIfMissing('comments', 'tags', 'TEXT');       // JSON tömb: problématípus-címkék
addColumnIfMissing('comments', 'amount', 'REAL');     // említett tartozás összege
addColumnIfMissing('comments', 'currency', 'TEXT');   // pénznem
addColumnIfMissing('comments', 'due_text', 'TEXT');   // számla/lejárat megnevezése

export function now() {
  return new Date().toISOString();
}

export function uid() {
  return crypto.randomUUID();
}

export function audit(userId, action, entity, entityId, detail) {
  db.prepare(
    `INSERT INTO audit_log (id, user_id, action, entity, entity_id, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(uid(), userId || null, action, entity || null, entityId || null,
        detail ? JSON.stringify(detail) : null, now());
}
