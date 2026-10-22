import crypto from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(crypto.scrypt);

export const SCRYPT_PARAMETERS = Object.freeze({
  N: 16384,
  r: 8,
  p: 1,
  keyLength: 64,
  saltBytes: 16,
  maxmem: 64 * 1024 * 1024,
});

export const AUTH_CREDENTIALS_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS auth_credentials (
  id BIGSERIAL PRIMARY KEY,
  role TEXT NOT NULL CHECK (role IN ('sales', 'admin', 'worker')),
  actor TEXT NOT NULL,
  salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  credential_version INTEGER NOT NULL DEFAULT 1 CHECK (credential_version > 0),
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (role, actor)
)`;

export const APP_PRIVATE_CONFIG_SCHEMA_SQL = `CREATE TABLE IF NOT EXISTS app_private_config (
  key TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  iv TEXT NOT NULL,
  auth_tag TEXT NOT NULL,
  key_version INTEGER NOT NULL DEFAULT 1 CHECK (key_version > 0),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
)`;

let schemaPromise = null;

export async function ensureAuthCredentialSchema(db) {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.execute({ sql: AUTH_CREDENTIALS_SCHEMA_SQL, args: [] });
      await db.execute({ sql: APP_PRIVATE_CONFIG_SCHEMA_SQL, args: [] });
    })().catch((error) => {
      schemaPromise = null;
      throw error;
    });
  }
  await schemaPromise;
}

function decodeBase64(value) {
  if (typeof value !== 'string' || value.length === 0) return null;
  try {
    const decoded = Buffer.from(value, 'base64');
    return decoded.length > 0 ? decoded : null;
  } catch {
    return null;
  }
}

async function derivePasswordHash(password, salt) {
  return scryptAsync(String(password || ''), salt, SCRYPT_PARAMETERS.keyLength, {
    N: SCRYPT_PARAMETERS.N,
    r: SCRYPT_PARAMETERS.r,
    p: SCRYPT_PARAMETERS.p,
    maxmem: SCRYPT_PARAMETERS.maxmem,
  });
}

export async function createPasswordCredential(password) {
  const input = String(password || '');
  if (Buffer.byteLength(input, 'utf8') < 16) {
    throw new Error('Credential password must contain at least 16 bytes.');
  }
  const salt = crypto.randomBytes(SCRYPT_PARAMETERS.saltBytes);
  const passwordHash = await derivePasswordHash(input, salt);
  return {
    salt: salt.toString('base64'),
    passwordHash: Buffer.from(passwordHash).toString('base64'),
  };
}

const DUMMY_SALT = Buffer.alloc(SCRYPT_PARAMETERS.saltBytes, 0x5a);
let dummyHashPromise = null;

async function getDummyHash() {
  if (!dummyHashPromise) dummyHashPromise = derivePasswordHash('invalid-credential-placeholder', DUMMY_SALT);
  return dummyHashPromise;
}

export async function verifyPasswordCredential(password, credential) {
  const salt = decodeBase64(credential?.salt) || DUMMY_SALT;
  const expected = decodeBase64(credential?.password_hash) || await getDummyHash();
  let actual;
  try {
    actual = await derivePasswordHash(password, salt);
  } catch {
    return false;
  }
  if (actual.length !== expected.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

export function resetAuthCredentialSchemaForTests() {
  schemaPromise = null;
}
