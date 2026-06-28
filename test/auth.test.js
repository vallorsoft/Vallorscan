// Auth/felhasználó tesztek – izolált, ideiglenes DB-vel.
// FONTOS: a DB_PATH-ot az ELSŐ szerver-import ELŐTT kell beállítani. Mivel az
// ESM static importok hoist-olódnak, dinamikus import()-tal töltjük be a modulokat,
// hogy a beállítás garantáltan előbb fusson.
process.env.DB_PATH = `/tmp/vallorscan-test-${process.pid}.sqlite`;

import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

let crypto, users, db;
before(async () => {
  crypto = await import('../server/crypto.js');
  users = await import('../server/users.js');
  ({ db } = await import('../server/db.js'));
});

test('crypto hashSecret/verifySecret oda-vissza', () => {
  const stored = crypto.hashSecret('titok123');
  assert.equal(crypto.verifySecret('titok123', stored), true);
  assert.equal(crypto.verifySecret('rossz', stored), false);
  assert.equal(crypto.verifySecret('titok123', 'badformat'), false);
  assert.equal(crypto.verifySecret(null, stored), false);
});

test('bootstrapSuperadmin pontosan egy superadmint hoz létre, idempotens', () => {
  users.bootstrapSuperadmin();
  users.bootstrapSuperadmin();
  const n = db.prepare("SELECT COUNT(*) n FROM users WHERE role='superadmin'").get().n;
  assert.equal(n, 1);
});

test('meghívókód → belépés → jelszócsere folyamat', () => {
  const sa = db.prepare("SELECT * FROM users WHERE role='superadmin'").get();
  const actor = { id: sa.id, role: 'superadmin' };
  const { user, code } = users.createUser({ email: 'Sofor1@Example.com', role: 'user' }, actor);
  assert.ok(code);
  assert.equal(user.email, 'sofor1@example.com');

  // Belépés a kóddal: must_change_password igaz.
  const r1 = users.login('sofor1@example.com', code);
  assert.ok(r1.token);
  assert.equal(r1.user.must_change_password, true);

  // Jelszócsere, majd belépés az új jelszóval.
  users.changePassword(r1.user.id, 'ujJelszo123');
  const r2 = users.login('sofor1@example.com', 'ujJelszo123');
  assert.ok(r2.token);
  assert.equal(r2.user.must_change_password, false);

  // A régi kód már nem működik.
  assert.throws(() => users.login('sofor1@example.com', code), (e) => e.status === 401);
});

test('rossz jelszó/kód → 401', () => {
  assert.throws(() => users.login('nincs@ilyen.com', 'akarmi'), (e) => e.status === 401);
  assert.throws(() => users.login('sofor1@example.com', 'rosszJelszo'), (e) => e.status === 401);
});

test('jogosultság: admin nem hozhat létre admint, nem törölheti az utolsó superadmint', () => {
  const sa = db.prepare("SELECT * FROM users WHERE role='superadmin'").get();
  const saActor = { id: sa.id, role: 'superadmin' };
  const { user: adminUser, code } = users.createUser({ email: 'admin1@example.com', role: 'admin' }, saActor);
  users.login('admin1@example.com', code);
  users.changePassword(adminUser.id, 'adminJelszo1');
  const adminActor = { id: adminUser.id, role: 'admin' };

  // Admin nem hozhat létre admint.
  assert.throws(() => users.createUser({ email: 'x@example.com', role: 'admin' }, adminActor), (e) => e.status === 403);
  // Admin nem törölheti a superadmint.
  assert.throws(() => users.deleteUser(sa.id, adminActor), (e) => e.status === 403);
  // Superadmin nem törölheti az utolsó superadmint.
  assert.throws(() => users.deleteUser(sa.id, saActor), (e) => e.status === 400);
});

after(() => {
  try {
    db.close();
    for (const ext of ['', '-wal', '-shm']) fs.rmSync(`${process.env.DB_PATH}${ext}`, { force: true });
  } catch { /* best-effort */ }
});
