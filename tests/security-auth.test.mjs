import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPasswordCredential, verifyPasswordCredential } from '../api/_lib/authCredentialSchema.js';
import { enforceAccessPolicy, enforceSameOriginWrite } from '../api/_lib/accessPolicy.js';
import { decryptPrivateConfigRow, encryptPrivateConfigValue } from '../api/_lib/privateConfig.js';

function response() {
  return {
    headers: {}, statusCode: null, body: null,
    setHeader(name, value) { this.headers[name] = value; },
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

async function freshAuth() {
  return import(`../api/_lib/auth.js?auth=${Date.now()}-${Math.random()}`);
}

test('AUTH_DISABLED cannot restore an anonymous bypass', async () => {
  const previous = { disabled: process.env.AUTH_DISABLED, jwt: process.env.JWT_SECRET };
  process.env.AUTH_DISABLED = 'true';
  process.env.JWT_SECRET = 'focused-test-signing-secret';
  try {
    const auth = await freshAuth();
    const res = response();
    const result = await auth.requireAuth({ headers: {}, body: {} }, res, { roles: ['sales'] });
    assert.equal(auth.authEnabled(), true);
    assert.equal(result, null);
    assert.equal(res.statusCode, 401);
  } finally {
    if (previous.disabled === undefined) delete process.env.AUTH_DISABLED; else process.env.AUTH_DISABLED = previous.disabled;
    if (previous.jwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous.jwt;
  }
});

test('existing JWT_SECRET format remains valid and invalid Bearer cannot fall back to cookie', async () => {
  const previous = process.env.JWT_SECRET;
  process.env.JWT_SECRET = 'focused-test-signing-secret';
  try {
    const auth = await freshAuth();
    await auth.ensureSigningSecret();
    const token = auth.issueToken({ role: 'sales', actor: '신은철' });
    const validReq = { headers: { authorization: `Bearer ${token}` }, body: {} };
    assert.equal((await auth.requireAuth(validReq, response(), { roles: ['sales'] })).actor, '신은철');
    const invalidReq = { headers: { authorization: 'Bearer invalid', cookie: `production_status_auth=${token}` }, body: {} };
    const invalidRes = response();
    assert.equal(await auth.requireAuth(invalidReq, invalidRes), null);
    assert.equal(invalidRes.statusCode, 401);
  } finally {
    if (previous === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous;
  }
});

test('worker actions use a verified session actor and reject an asserted different name', async () => {
  const auth = await freshAuth();
  const res = response();
  const req = { headers: {}, body: { actor: '이먼' }, auth: { role: 'worker', actor: '거니' } };
  assert.equal(await auth.requireWorkerAction(req, res), null);
  assert.equal(res.statusCode, 403);
});

test('scrypt credentials use independent salts and reject a wrong password', async () => {
  const first = await createPasswordCredential('abcdefghijklmnop');
  const second = await createPasswordCredential('abcdefghijklmnop');
  assert.notEqual(first.salt, second.salt);
  assert.equal(await verifyPasswordCredential('abcdefghijklmnop', { salt: first.salt, password_hash: first.passwordHash }), true);
  assert.equal(await verifyPasswordCredential('wrong-password-value', { salt: first.salt, password_hash: first.passwordHash }), false);
});

test('private configuration uses a fresh GCM IV and binds key plus version as AAD', () => {
  const previous = process.env.POSTGRES_URL;
  process.env.POSTGRES_URL = 'postgresql://app:wrapping-password@localhost/example';
  try {
    const first = encryptPrivateConfigValue('auth.signing_secret', 'sensitive-value', 1);
    const second = encryptPrivateConfigValue('auth.signing_secret', 'sensitive-value', 1);
    assert.notEqual(first.iv, second.iv);
    assert.equal(decryptPrivateConfigRow({ key: first.key, ciphertext: first.ciphertext, iv: first.iv, auth_tag: first.authTag, key_version: first.keyVersion }), 'sensitive-value');
    assert.throws(() => decryptPrivateConfigRow({ key: 'different.key', ciphertext: first.ciphertext, iv: first.iv, auth_tag: first.authTag, key_version: first.keyVersion }));
  } finally {
    if (previous === undefined) delete process.env.POSTGRES_URL; else process.env.POSTGRES_URL = previous;
  }
});

test('cookie writes require exact same origin while Bearer writes remain supported', () => {
  const denied = response();
  assert.equal(enforceSameOriginWrite({ method: 'POST', headers: { origin: 'https://evil.example', host: 'production-status.vercel.app' }, authSource: 'cookie' }, denied), false);
  assert.equal(denied.statusCode, 403);
  assert.equal(enforceSameOriginWrite({ method: 'POST', headers: {}, authSource: 'bearer' }, response()), true);
  assert.equal(enforceSameOriginWrite({ method: 'POST', headers: { origin: 'https://production-status.vercel.app', host: 'production-status.vercel.app' }, authSource: 'cookie' }, response()), true);
});

test('access policy keeps customer tracking public and disables test-send routes', async () => {
  assert.equal(await enforceAccessPolicy({ method: 'GET', url: '/api/track/public-token', headers: {} }, response()), true);
  const res = response();
  assert.equal(await enforceAccessPolicy({ method: 'POST', url: '/api/cron/test-send', headers: {} }, res), false);
  assert.equal(res.statusCode, 404);
});

test('access policy preserves exact sales mutation and authenticated read roles', async () => {
  const workerRead = response();
  assert.equal(await enforceAccessPolicy({ method: 'GET', url: '/api/orders', headers: {}, auth: { role: 'worker', actor: '이먼' } }, workerRead), true);
  assert.equal(workerRead.headers['Cache-Control'], 'no-store');

  const adminMutation = response();
  assert.equal(await enforceAccessPolicy({ method: 'PATCH', url: '/api/orders/10', headers: {}, auth: { role: 'admin', actor: '관리자' } }, adminMutation), false);
  assert.equal(adminMutation.statusCode, 403);

  const salesMutation = response();
  assert.equal(await enforceAccessPolicy({ method: 'PATCH', url: '/api/orders/10', headers: {}, auth: { role: 'sales', actor: '신은철' }, authSource: 'bearer' }, salesMutation), true);
});

test('public login write still requires browser same-origin proof', async () => {
  const denied = response();
  assert.equal(await enforceAccessPolicy({ method: 'POST', url: '/api/auth/worker', headers: {} }, denied), false);
  assert.equal(denied.statusCode, 403);
  const allowed = response();
  assert.equal(await enforceAccessPolicy({ method: 'POST', url: '/api/auth/worker', headers: { origin: 'https://production-status.vercel.app', host: 'production-status.vercel.app' } }, allowed), true);
});

test('existing environment sales login issues both Bearer response and strict cookie', async () => {
  const previous = { sales: process.env.SALES_PASSWORD, jwt: process.env.JWT_SECRET };
  process.env.SALES_PASSWORD = 'existing-sales-password';
  process.env.JWT_SECRET = 'focused-test-signing-secret';
  try {
    const { default: handler } = await import(`../api/auth/sales.js?handler=${Date.now()}-${Math.random()}`);
    const res = response();
    await handler({
      method: 'POST', url: '/api/auth/sales',
      headers: { origin: 'https://production-status.vercel.app', host: 'production-status.vercel.app' },
      body: { actor: '신은철', password: 'existing-sales-password' },
      socket: { remoteAddress: '127.0.0.1' },
    }, res);
    assert.equal(res.statusCode, null);
    assert.equal(res.body.role, 'sales');
    assert.equal(typeof res.body.token, 'string');
    assert.match(res.headers['Set-Cookie'], /HttpOnly; Secure; SameSite=Strict/);
  } finally {
    if (previous.sales === undefined) delete process.env.SALES_PASSWORD; else process.env.SALES_PASSWORD = previous.sales;
    if (previous.jwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = previous.jwt;
  }
});
