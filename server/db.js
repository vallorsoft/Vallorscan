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

-- Felhasználók: szerepkör, jelszó-hash, meghívókód-hash.
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,         -- store lowercased
  phone TEXT,
  display_name TEXT,
  role TEXT NOT NULL DEFAULT 'user',  -- 'superadmin' | 'admin' | 'user'
  password_hash TEXT,                 -- null until set
  invite_code_hash TEXT,             -- null after used
  status TEXT NOT NULL DEFAULT 'invited', -- 'invited' | 'active' | 'disabled'
  must_change_password INTEGER NOT NULL DEFAULT 0,
  last_login_at TEXT,
  created_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Munkamenetek: a nyers token sha256 hash-e a kulcs.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,        -- sha256 hex of the raw token
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS ix_sessions_user ON sessions(user_id);
`);

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
