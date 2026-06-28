// Felhasználó- és munkamenet-logika tiszta függvényekként (tesztelhető).
import { db, now, uid, audit } from './db.js';
import {
  hashSecret, verifySecret, randomToken, sha256hex, randomCode,
} from './crypto.js';

const SESSION_DAYS = 30;

/** Hibadobás HTTP-státusszal és rövid kóddal. */
function err(code, status) {
  const e = new Error(code);
  e.status = status;
  return e;
}

/** Hash nélküli, kliensnek visszaadható felhasználó. */
export function safeUser(row) {
  if (!row) return null;
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    display_name: row.display_name,
    role: row.role,
    status: row.status,
    must_change_password: !!row.must_change_password,
    last_login_at: row.last_login_at,
    created_at: row.created_at,
  };
}

function countSuperadmins() {
  return db.prepare("SELECT COUNT(*) n FROM users WHERE role = 'superadmin'").get().n;
}

/** Az első indításkor superadmin létrehozása, ha nincs. Idempotens. */
export function bootstrapSuperadmin() {
  if (countSuperadmins() > 0) return;
  const email = (process.env.SUPERADMIN_EMAIL || 'vallorsoft@gmail.com').toLowerCase();
  const provided = process.env.SUPERADMIN_PASSWORD;
  const password = provided || randomToken(6); // 12 hex karakter, ha nincs megadva
  const ts = now();
  // Ha az email valamiért már létezik (más szereppel), inkább lépjünk superadminra.
  const existing = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (existing) {
    db.prepare(`UPDATE users SET role='superadmin', status='active', updated_at=? WHERE id=?`)
      .run(ts, existing.id);
    return;
  }
  const id = uid();
  db.prepare(`
    INSERT INTO users (id, email, role, password_hash, status, must_change_password, created_at, updated_at)
    VALUES (?, ?, 'superadmin', ?, 'active', 1, ?, ?)
  `).run(id, email, hashSecret(password), ts, ts);
  audit(id, 'user.bootstrap', 'user', id, { email });
  if (!provided) {
    const line = '─'.repeat(54);
    console.log(`\n┌${line}┐`);
    console.log('│  SUPERADMIN létrehozva – jegyezd fel ezt a jelszót!');
    console.log(`│  Email:  ${email}`);
    console.log(`│  Jelszó: ${password}`);
    console.log('│  Az első belépéskor kötelező megváltoztatni.');
    console.log(`└${line}┘\n`);
  }
}

/** Munkamenet létrehozása, nyers token visszaadása. */
export function createSession(userId) {
  const raw = randomToken();
  const ts = now();
  const expires = new Date(Date.now() + SESSION_DAYS * 86400_000).toISOString();
  db.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(sha256hex(raw), userId, ts, expires);
  return raw;
}

/** Érvényes (le nem járt) munkamenethez tartozó teljes user sor, különben null. */
export function validateSession(rawToken) {
  if (!rawToken) return null;
  const hash = sha256hex(rawToken);
  const sess = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash);
  if (!sess) return null;
  if (sess.expires_at <= now()) {
    db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash); // lusta lejárat-takarítás
    return null;
  }
  return db.prepare('SELECT * FROM users WHERE id = ?').get(sess.user_id) || null;
}

/** Kijelentkezés: munkamenet törlése. */
export function logout(rawToken) {
  if (!rawToken) return;
  db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256hex(rawToken));
}

/** Bejelentkezés jelszóval vagy meghívókóddal. */
export function login(email, secret) {
  const e = String(email || '').toLowerCase().trim();
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(e);
  // Konstans ráfordítás: akkor is hash-elünk, ha nincs user.
  if (!u || u.status === 'disabled') {
    verifySecret(String(secret || ''), 'scrypt$00$00');
    throw err('invalid_credentials', 401);
  }

  if (u.status === 'invited') {
    if (!u.invite_code_hash || !verifySecret(String(secret || '').toUpperCase().trim(), u.invite_code_hash)) {
      throw err('invalid_credentials', 401);
    }
  } else {
    if (!u.password_hash || !verifySecret(String(secret || ''), u.password_hash)) {
      throw err('invalid_credentials', 401);
    }
  }

  const ts = now();
  db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?').run(ts, u.id);
  u.last_login_at = ts;
  const token = createSession(u.id);
  audit(u.id, 'auth.login', 'user', u.id, null);
  return { token, user: safeUser(u) };
}

/** Jelszó-csere: hash beállítása, státusz aktívra, meghívókód törlése. */
export function changePassword(userId, newPassword) {
  if (typeof newPassword !== 'string' || newPassword.length < 8) {
    throw err('weak_password', 400);
  }
  const ts = now();
  db.prepare(`
    UPDATE users SET password_hash = ?, must_change_password = 0, status = 'active',
      invite_code_hash = NULL, updated_at = ? WHERE id = ?
  `).run(hashSecret(newPassword), ts, userId);
  audit(userId, 'password.change', 'user', userId, null);
  return safeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(userId));
}

/** Összes felhasználó (hash nélkül), létrehozás szerint rendezve. */
export function listUsers() {
  return db.prepare('SELECT * FROM users ORDER BY created_at').all().map(safeUser);
}

/** Jogosultság-ellenőrzés egy célfelhasználón (updateUser/resetCode/deleteUser). */
function assertCanManage(actor, target) {
  if (actor.role === 'superadmin') return;
  if (actor.role === 'admin') {
    if (target.role !== 'user') throw err('forbidden', 403);
    return;
  }
  throw err('forbidden', 403);
}

/** Új felhasználó meghívása. Visszaad: { user, code } – a kód csak EGYSZER. */
export function createUser({ email, phone, display_name, role } = {}, actor) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) throw err('email_required', 400);
  const r = role || 'user';
  if (r !== 'user' && r !== 'admin') throw err('invalid_role', 400);
  // Csak superadmin hozhat létre admint; admin csak user-t.
  if (r === 'admin' && actor.role !== 'superadmin') throw err('forbidden', 403);
  if (actor.role !== 'superadmin' && actor.role !== 'admin') throw err('forbidden', 403);

  const exists = db.prepare('SELECT 1 FROM users WHERE email = ?').get(e);
  if (exists) throw err('email_taken', 409);

  const code = randomCode();
  const id = uid();
  const ts = now();
  db.prepare(`
    INSERT INTO users (id, email, phone, display_name, role, invite_code_hash, status,
      password_hash, must_change_password, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'invited', NULL, 1, ?, ?, ?)
  `).run(id, e, phone || null, display_name || null, r, hashSecret(code), actor.id, ts, ts);
  audit(actor.id, 'user.create', 'user', id, { email: e, role: r });
  return { user: safeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id)), code };
}

/** Felhasználó módosítása (role, status, display_name, phone). */
export function updateUser(id, patch = {}, actor) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw err('not_found', 404);
  assertCanManage(actor, target);

  const fields = {};
  if ('display_name' in patch) fields.display_name = patch.display_name || null;
  if ('phone' in patch) fields.phone = patch.phone || null;

  if ('role' in patch && patch.role !== undefined) {
    const r = patch.role;
    if (r !== 'user' && r !== 'admin') throw err('invalid_role', 400); // soha superadmin API-n át
    if (actor.role !== 'superadmin') throw err('forbidden', 403); // admin nem állíthat szerepet
    if (actor.id === id) throw err('forbidden', 403); // saját magát nem módosíthatja
    // Az utolsó superadmin szerepét nem lehet elvenni.
    if (target.role === 'superadmin' && r !== 'superadmin' && countSuperadmins() <= 1) {
      throw err('last_superadmin', 400);
    }
    fields.role = r;
  }

  if ('status' in patch && patch.status !== undefined) {
    const s = patch.status;
    if (s !== 'active' && s !== 'disabled' && s !== 'invited') throw err('invalid_status', 400);
    if (actor.id === id) throw err('forbidden', 403); // saját magát nem tilthatja le
    if (target.role === 'superadmin' && s !== 'active' && countSuperadmins() <= 1) {
      throw err('last_superadmin', 400);
    }
    fields.status = s;
  }

  const keys = Object.keys(fields);
  if (keys.length) {
    fields.updated_at = now();
    const sets = Object.keys(fields).map((k) => `${k} = @${k}`).join(', ');
    db.prepare(`UPDATE users SET ${sets} WHERE id = @id`).run({ ...fields, id });
    audit(actor.id, 'user.update', 'user', id, fields);
  }
  return safeUser(db.prepare('SELECT * FROM users WHERE id = ?').get(id));
}

/** Új meghívókód kiadása (a felhasználó visszaesik 'invited' állapotba). */
export function resetCode(id, actor) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw err('not_found', 404);
  assertCanManage(actor, target);

  const code = randomCode();
  db.prepare(`
    UPDATE users SET invite_code_hash = ?, status = 'invited', password_hash = NULL,
      must_change_password = 1, updated_at = ? WHERE id = ?
  `).run(hashSecret(code), now(), id);
  audit(actor.id, 'user.reset_code', 'user', id, null);
  return { code };
}

/** Felhasználó törlése (a munkamenetek kaszkádolva törlődnek). */
export function deleteUser(id, actor) {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  if (!target) throw err('not_found', 404);
  assertCanManage(actor, target);
  if (target.role === 'superadmin' && countSuperadmins() <= 1) throw err('last_superadmin', 400);
  if (actor.id === id) throw err('forbidden', 403); // saját magát nem törölheti

  db.prepare('DELETE FROM users WHERE id = ?').run(id);
  audit(actor.id, 'user.delete', 'user', id, { email: target.email });
  return { ok: true };
}
