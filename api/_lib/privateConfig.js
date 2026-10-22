import crypto from 'node:crypto';
import { getDb } from './db.js';

const WRAPPING_SALT = Buffer.from('hansungshowcase/production-status/private-config/wrapping-salt/v1', 'utf8');
const WRAPPING_PURPOSE = Buffer.from('production-status/private-config/v1', 'utf8');
const PROJECT_AAD_PREFIX = 'hansungshowcase/production-status';

export class PrivateConfigError extends Error {
  constructor(message = '보안 설정을 불러올 수 없습니다.') {
    super(message);
    this.name = 'PrivateConfigError';
    this.status = 503;
    this.publicMessage = '보안 설정을 불러올 수 없습니다. 잠시 후 다시 시도해 주세요.';
  }
}

function getDatabasePassword() {
  const rawUrl = process.env.POSTGRES_URL;
  if (!rawUrl) throw new PrivateConfigError();
  try {
    const parsed = new URL(rawUrl);
    const password = decodeURIComponent(parsed.password || '');
    if (!password) throw new PrivateConfigError();
    return password;
  } catch (error) {
    if (error instanceof PrivateConfigError) throw error;
    throw new PrivateConfigError();
  }
}

function deriveWrappingKey() {
  try {
    return Buffer.from(crypto.hkdfSync(
      'sha256',
      Buffer.from(getDatabasePassword(), 'utf8'),
      WRAPPING_SALT,
      WRAPPING_PURPOSE,
      32,
    ));
  } catch (error) {
    if (error instanceof PrivateConfigError) throw error;
    throw new PrivateConfigError();
  }
}

function buildAad(key, keyVersion) {
  return Buffer.from(`${PROJECT_AAD_PREFIX}:${key}:${keyVersion}`, 'utf8');
}

function decodeField(value, expectedLength = null) {
  if (typeof value !== 'string' || !value) throw new PrivateConfigError();
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length === 0 || (expectedLength !== null && decoded.length !== expectedLength)) {
    throw new PrivateConfigError();
  }
  return decoded;
}

export function encryptPrivateConfigValue(key, value, keyVersion = 1) {
  if (typeof key !== 'string' || !key.trim() || typeof value !== 'string' || !value) {
    throw new PrivateConfigError();
  }
  if (!Number.isInteger(keyVersion) || keyVersion < 1) throw new PrivateConfigError();

  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveWrappingKey(), iv);
  cipher.setAAD(buildAad(key, keyVersion));
  const ciphertext = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  return {
    key,
    ciphertext: ciphertext.toString('base64'),
    iv: iv.toString('base64'),
    authTag: cipher.getAuthTag().toString('base64'),
    keyVersion,
  };
}

export function decryptPrivateConfigRow(row) {
  const key = String(row?.key || '');
  const keyVersion = Number(row?.key_version);
  if (!key || !Number.isInteger(keyVersion) || keyVersion < 1) throw new PrivateConfigError();
  try {
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      deriveWrappingKey(),
      decodeField(row.iv, 12),
    );
    decipher.setAAD(buildAad(key, keyVersion));
    decipher.setAuthTag(decodeField(row.auth_tag, 16));
    const plaintext = Buffer.concat([
      decipher.update(decodeField(row.ciphertext)),
      decipher.final(),
    ]).toString('utf8');
    if (!plaintext) throw new PrivateConfigError();
    return plaintext;
  } catch (error) {
    if (error instanceof PrivateConfigError) throw error;
    throw new PrivateConfigError();
  }
}

export async function readPrivateConfig(key, { db = getDb() } = {}) {
  if (typeof key !== 'string' || !key.trim()) throw new PrivateConfigError();
  let result;
  try {
    result = await db.execute({
      sql: 'SELECT key, ciphertext, iv, auth_tag, key_version FROM app_private_config WHERE key = ?',
      args: [key],
    });
  } catch {
    throw new PrivateConfigError();
  }
  const row = result?.rows?.[0];
  if (!row) throw new PrivateConfigError();
  return decryptPrivateConfigRow(row);
}
