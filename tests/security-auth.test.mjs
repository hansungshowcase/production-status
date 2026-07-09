import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

function mockResponse() {
  return {
    statusCode: null,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

async function importAuthModule() {
  return import(`../api/_lib/auth.js?cacheBust=${Date.now()}-${Math.random()}`);
}

test('requireAuth fails closed when auth is explicitly required and auth secrets are missing', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalAuthRequired = process.env.AUTH_REQUIRED;
  const originalAuthDisabled = process.env.AUTH_DISABLED;
  const originalSales = process.env.SALES_PASSWORD;
  const originalAdmin = process.env.ADMIN_PASSWORD;
  const originalJwt = process.env.JWT_SECRET;
  process.env.AUTH_REQUIRED = 'true';
  delete process.env.AUTH_DISABLED;
  delete process.env.SALES_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.JWT_SECRET;

  try {
    const { requireAuth } = await importAuthModule();
    const res = mockResponse();
    const result = requireAuth({ headers: {}, body: {} }, res, { roles: ['sales'] });

    assert.equal(result, null);
    assert.equal(res.statusCode, 500);
    assert.equal(res.body?.error?.status, 500);
    const responseText = JSON.stringify(res.body);
    assert.doesNotMatch(responseText, /Authentication is required/);
    assert.doesNotMatch(responseText, /SALES_PASSWORD|ADMIN_PASSWORD/);
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalAuthRequired === undefined) delete process.env.AUTH_REQUIRED; else process.env.AUTH_REQUIRED = originalAuthRequired;
    if (originalAuthDisabled === undefined) delete process.env.AUTH_DISABLED; else process.env.AUTH_DISABLED = originalAuthDisabled;
    if (originalSales === undefined) delete process.env.SALES_PASSWORD; else process.env.SALES_PASSWORD = originalSales;
    if (originalAdmin === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = originalAdmin;
    if (originalJwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalJwt;
  }
});

test('auth can be explicitly disabled even when password env vars exist', async () => {
  const originalAuthDisabled = process.env.AUTH_DISABLED;
  const originalSales = process.env.SALES_PASSWORD;
  const originalAdmin = process.env.ADMIN_PASSWORD;
  process.env.AUTH_DISABLED = 'true';
  process.env.SALES_PASSWORD = 'configured-sales-password';
  process.env.ADMIN_PASSWORD = 'configured-admin-password';

  try {
    const { authEnabled, authRequired, requireAuth } = await importAuthModule();
    const res = mockResponse();
    const result = requireAuth({ headers: {}, body: {} }, res, { roles: ['sales'] });

    assert.equal(authEnabled(), false);
    assert.equal(authRequired(), false);
    assert.equal(res.statusCode, null);
    assert.deepEqual(result, { role: null, actor: null, _bypass: true });
  } finally {
    if (originalAuthDisabled === undefined) delete process.env.AUTH_DISABLED; else process.env.AUTH_DISABLED = originalAuthDisabled;
    if (originalSales === undefined) delete process.env.SALES_PASSWORD; else process.env.SALES_PASSWORD = originalSales;
    if (originalAdmin === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = originalAdmin;
  }
});

test('worker process actions are not blocked by missing sales/admin auth secrets', async () => {
  const originalNodeEnv = process.env.NODE_ENV;
  const originalSales = process.env.SALES_PASSWORD;
  const originalAdmin = process.env.ADMIN_PASSWORD;
  const originalJwt = process.env.JWT_SECRET;
  process.env.NODE_ENV = 'production';
  delete process.env.SALES_PASSWORD;
  delete process.env.ADMIN_PASSWORD;
  delete process.env.JWT_SECRET;

  try {
    const { requireWorkerAction } = await importAuthModule();
    const res = mockResponse();
    const result = requireWorkerAction({ headers: {}, body: { actor: '도면설계' } }, res);

    assert.equal(res.statusCode, null);
    assert.deepEqual(result, { role: 'worker', actor: '도면설계' });
  } finally {
    process.env.NODE_ENV = originalNodeEnv;
    if (originalSales === undefined) delete process.env.SALES_PASSWORD; else process.env.SALES_PASSWORD = originalSales;
    if (originalAdmin === undefined) delete process.env.ADMIN_PASSWORD; else process.env.ADMIN_PASSWORD = originalAdmin;
    if (originalJwt === undefined) delete process.env.JWT_SECRET; else process.env.JWT_SECRET = originalJwt;
  }
});

test('worker process actions require an actor', async () => {
  const { requireWorkerAction } = await importAuthModule();
  const res = mockResponse();
  const result = requireWorkerAction({ headers: {}, body: {} }, res);

  assert.equal(result, null);
  assert.equal(res.statusCode, 400);
  assert.equal(res.body?.error?.status, 400);
});

test('admin/sales state-changing and export API routes call requireAuth', async () => {
  const files = [
    'api/issues/index.js',
    'api/issues/[id]/resolve.js',
    'api/pre-production/[orderId].js',
    'api/photos/index.js',
    'api/export/csv.js',
  ];

  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /requireAuth\s*\(/, `${file} must enforce auth`);
  }
});

test('work order image registration routes do not require sales/admin auth', async () => {
  const files = [
    'api/orders/[id]/work-order-image.js',
    'api/work-order-images.js',
    'api/ocr/work-order.js',
  ];

  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /requireAuth\s*\(/, `${file} must not be blocked by sales/admin auth`);
  }
});

test('order creation route does not require sales/admin auth', async () => {
  const source = await readFile(new URL('../api/orders/index.js', import.meta.url), 'utf8');
  const postHandlerStart = source.indexOf('async function handlePost');
  assert.notEqual(postHandlerStart, -1, 'api/orders/index.js must define handlePost');
  const postHandlerSource = source.slice(postHandlerStart);
  assert.doesNotMatch(postHandlerSource, /requireAuth\s*\(/, 'order creation must not be blocked by sales/admin auth');
});

test('worker process API routes call requireWorkerAction', async () => {
  const files = [
    'api/processes/[id]/start.js',
    'api/processes/[id]/complete.js',
    'api/processes/[id]/revert.js',
  ];

  for (const file of files) {
    const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
    assert.match(source, /requireWorkerAction\s*\(/, `${file} must allow worker process actions`);
  }
});

test('packing photo uploads allow worker actor authentication without sales admin token', async () => {
  const source = await readFile(new URL('../api/photos/index.js', import.meta.url), 'utf8');

  assert.match(source, /requireAuth\s*\(/, 'general photo uploads must still enforce sales/admin auth');
  assert.match(source, /requireWorkerAction\s*\(/, 'packing photo uploads must allow worker actor auth');
  assert.match(source, /uploaded_by/, 'worker actor should come from multipart uploaded_by');
});

test('worker issue reporting and resolving are not blocked by sales/admin auth', async () => {
  const issueSource = await readFile(new URL('../api/issues/index.js', import.meta.url), 'utf8');
  const resolveSource = await readFile(new URL('../api/issues/[id]/resolve.js', import.meta.url), 'utf8');

  assert.match(issueSource, /requireAuth\s*\(/, 'non-worker issue writes must still enforce sales/admin auth');
  assert.match(issueSource, /requireWorkerAction\s*\(/, 'worker issue reports must allow worker actor auth');
  assert.match(issueSource, /reported_by/, 'worker actor should come from reported_by');
  assert.match(resolveSource, /requireAuth\s*\(/, 'non-worker issue resolve must still enforce sales/admin auth');
  assert.match(resolveSource, /requireWorkerAction\s*\(/, 'worker issue resolve must allow worker actor auth');
  assert.match(resolveSource, /actor/, 'worker actor should come from actor');
});
