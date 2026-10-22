import crypto from 'node:crypto';
import { getDb } from './db.js';
import { readPrivateConfig, PrivateConfigError } from './privateConfig.js';
import { verifyPasswordCredential } from './authCredentialSchema.js';
import { SALES_PERSON_NAMES, WORKERS } from '../../shared/workerAccess.js';

const AUTH_COOKIE = 'production_status_auth';
const TOKEN_TTL_SECONDS = 24 * 60 * 60;
const ALLOWED_ROLES = new Set(['sales', 'admin', 'worker']);
let signingKey = null;
let signingSource = null;
let signingPromise = null;

export function authEnabled() { return false; }
export function authRequired() { return false; }

function setNoStore(res) {
  for (const name of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) res.setHeader(name, 'no-store');
}

export function authConfigurationError(res) {
  setNoStore(res);
  res.status(503).json({ error: { message: '인증 설정을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.', status: 503 } });
  return null;
}

export async function ensureSigningSecret() {
  const envSecret = process.env.JWT_SECRET;
  if (envSecret) {
    if (signingSource !== `env:${envSecret}`) {
      signingKey = crypto.createHash('sha256').update(envSecret).digest();
      signingSource = `env:${envSecret}`;
    }
    return;
  }
  if (signingKey && signingSource === 'config') return;
  if (!signingPromise) {
    signingPromise = readPrivateConfig('auth.signing_secret').then((encoded) => {
      const decoded = Buffer.from(String(encoded), 'base64');
      if (decoded.length !== 32) throw new PrivateConfigError();
      signingKey = decoded;
      signingSource = 'config';
    }).catch((error) => {
      signingKey = null;
      signingSource = null;
      throw error instanceof PrivateConfigError ? error : new PrivateConfigError();
    }).finally(() => { signingPromise = null; });
  }
  return signingPromise;
}

function base64url(value) { return Buffer.from(value).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_'); }
function base64urlDecode(value) {
  const pad = value.length % 4 === 2 ? '==' : value.length % 4 === 3 ? '=' : '';
  return Buffer.from(value.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

export function issueToken({ role, actor, credentialId, credentialVersion }, ttlSec = TOKEN_TTL_SECONDS) {
  if (!signingKey) throw new PrivateConfigError();
  const payload = { role, actor: actor || null, exp: Math.floor(Date.now() / 1000) + ttlSec };
  if (credentialId != null) payload.credentialId = Number(credentialId);
  if (credentialVersion != null) payload.credentialVersion = Number(credentialVersion);
  const body = base64url(JSON.stringify(payload));
  return `${body}.${base64url(crypto.createHmac('sha256', signingKey).update(body).digest())}`;
}

export function verifyToken(token) {
  if (!signingKey || !token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, signature] = parts;
  const expected = base64url(crypto.createHmac('sha256', signingKey).update(body).digest());
  if (expected.length !== signature.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(signature))) return null;
    const payload = JSON.parse(base64urlDecode(body).toString('utf8'));
    if (!payload?.exp || payload.exp < Math.floor(Date.now() / 1000) || !ALLOWED_ROLES.has(payload.role)) return null;
    return payload;
  } catch { return null; }
}

export function checkPassword(input, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(String(expected));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function parseCookies(header) {
  return String(header || '').split(';').reduce((cookies, part) => {
    const separator = part.indexOf('=');
    if (separator > 0) {
      try { cookies[part.slice(0, separator).trim()] = decodeURIComponent(part.slice(separator + 1).trim()); } catch {}
    }
    return cookies;
  }, {});
}

function requestToken(req) {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers?.authorization || '');
  if (bearer) return { token: bearer[1], source: 'bearer' };
  return { token: parseCookies(req.headers?.cookie)[AUTH_COOKIE] || null, source: 'cookie' };
}

export function setAuthCookie(res, token) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=${encodeURIComponent(token)}; Max-Age=${TOKEN_TTL_SECONDS}; Path=/; HttpOnly; Secure; SameSite=Strict`);
}

export function clearAuthCookie(res) {
  res.setHeader('Set-Cookie', `${AUTH_COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Strict`);
}

async function loadCredentialById(id, db = getDb()) {
  const result = await db.execute({ sql: 'SELECT id, role, actor, credential_version, active FROM auth_credentials WHERE id = ?', args: [id] });
  return result?.rows?.[0] || null;
}

export async function verifyDatabaseLogin(role, actor, password, { db = getDb() } = {}) {
  let row;
  try {
    const result = await db.execute({
      sql: 'SELECT id, role, actor, salt, password_hash, credential_version, active FROM auth_credentials WHERE role = ? AND actor = ?',
      args: [role, actor],
    });
    row = result?.rows?.[0] || null;
  } catch (error) {
    error.status = 503;
    error.publicMessage = '인증 정보를 확인하지 못했습니다.';
    throw error;
  }
  const passwordMatches = await verifyPasswordCredential(password, row);
  return row && row.active === true && passwordMatches ? row : null;
}

function validActorForRole(role, actor) {
  if (role === 'sales') return SALES_PERSON_NAMES.includes(actor);
  if (role === 'admin') return actor === '관리자';
  if (role === 'worker') return WORKERS.includes(actor);
  return false;
}

export async function authenticateRequest(req) {
  if (req.auth) return req.auth;
  await ensureSigningSecret();
  const { token, source } = requestToken(req);
  const payload = verifyToken(token);
  if (!payload || !validActorForRole(payload.role, payload.actor)) return null;
  const hasCredential = payload.credentialId != null || payload.credentialVersion != null;
  if (hasCredential) {
    if (!Number.isSafeInteger(payload.credentialId) || !Number.isInteger(payload.credentialVersion)) return null;
    const row = await loadCredentialById(payload.credentialId);
    if (!row || row.active !== true || row.role !== payload.role || Number(row.credential_version) !== payload.credentialVersion) return null;
    if ((payload.role === 'worker' && row.actor !== payload.actor) || (payload.role === 'admin' && row.actor !== '관리자') || (payload.role === 'sales' && row.actor !== '*')) return null;
  } else if (payload.role === 'worker') return null;
  req.auth = payload;
  req.authSource = source;
  return payload;
}

function authError(res, status, message) {
  setNoStore(res);
  res.status(status).json({ error: { message, status } });
  return null;
}

export async function requireAuth(req, res, { roles = ['sales', 'admin', 'worker'] } = {}) {
  if (!authEnabled()) return { role: null, actor: resolveActor(req), _bypass: true };
  let payload;
  try { payload = await authenticateRequest(req); } catch { return authConfigurationError(res); }
  if (!payload) return authError(res, 401, '인증이 필요합니다.');
  if (roles.length && !roles.includes(payload.role)) return authError(res, 403, '권한이 없습니다.');
  return payload;
}

export async function requireWorkerAction(req, res, { allowInitialDesignStart = false } = {}) {
  if (!authEnabled()) {
    const rawActor = req.body?.actor || req.body?.assigned_worker || req.headers?.['x-worker-name'];
    const actor = typeof rawActor === 'string' ? rawActor.trim() : '';
    if (!actor) return authError(res, 400, '작업자 정보가 필요합니다.');
    const payload = { role: 'worker', actor, _bypass: true };
    req.auth = payload;
    return payload;
  }
  const auth = await requireAuth(req, res, { roles: allowInitialDesignStart ? ['worker', 'sales', 'admin'] : ['worker'] });
  if (!auth || auth.role !== 'worker') return auth;
  const claims = [req.body?.actor, req.body?.uploaded_by, req.body?.reported_by, req.headers?.['x-worker-name']]
    .filter((value) => typeof value === 'string' && value.trim());
  if (claims.some((value) => value.trim() !== auth.actor)) return authError(res, 403, '다른 작업자의 이름으로 요청할 수 없습니다.');
  return auth;
}

export function resolveActor(req) { return req.auth?.actor || req.body?.actor || req.body?.reported_by || req.body?.uploaded_by || req.body?.sales_person || '시스템'; }
export function withAuth(handler, options) {
  return async (req, res) => (await requireAuth(req, res, options)) ? handler(req, res) : undefined;
}
export function resetAuthForTests() { signingKey = null; signingSource = null; signingPromise = null; }
