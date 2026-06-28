// Jelszó/titok kezelés node:crypto scrypt-tel – külső függőség nélkül.
import crypto from 'node:crypto';

const SCRYPT_KEYLEN = 64;
const SALT_BYTES = 16;

/** Titok hash-elése: `scrypt$<saltHex>$<keyHex>`. */
export function hashSecret(plain) {
  const salt = crypto.randomBytes(SALT_BYTES);
  const key = crypto.scryptSync(String(plain), salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

/** Titok ellenőrzése időállandó összehasonlítással. Rossz/hibás bemenetre false. */
export function verifySecret(plain, stored) {
  try {
    if (typeof stored !== 'string' || typeof plain !== 'string') return false;
    const parts = stored.split('$');
    if (parts.length !== 3 || parts[0] !== 'scrypt') return false;
    const salt = Buffer.from(parts[1], 'hex');
    const expected = Buffer.from(parts[2], 'hex');
    if (salt.length === 0 || expected.length === 0) return false;
    const actual = crypto.scryptSync(plain, salt, expected.length);
    return crypto.timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

/** Véletlen token hex stringként (alapból 32 byte). */
export function randomToken(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

/** SHA-256 hex. */
export function sha256hex(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// Félreérthetetlen ábécé (nincs 0/O/1/I/L).
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** Ember-barát egyszer használatos meghívókód, pl. ABCD-EFGH-JK. */
export function randomCode() {
  let out = '';
  for (let i = 0; i < 10; i++) {
    out += ALPHABET[crypto.randomInt(ALPHABET.length)];
  }
  return `${out.slice(0, 4)}-${out.slice(4, 8)}-${out.slice(8, 10)}`;
}
