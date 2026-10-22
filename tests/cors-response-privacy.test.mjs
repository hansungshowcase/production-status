import assert from 'node:assert/strict';
import test from 'node:test';

import { cors } from '../api/_lib/cors.js';

function createResponse() {
  return {
    headers: {},
    headersSent: false,
    statusCode: null,
    body: null,
    ended: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(value) {
      this.body = value;
      return this;
    },
    end() {
      this.ended = true;
      return this;
    },
  };
}

const noStoreHeaders = {
  'Cache-Control': 'no-store',
  'CDN-Cache-Control': 'no-store',
  'Vercel-CDN-Cache-Control': 'no-store',
};

test('GET /api/export/csv uses no-store in every cache-control layer', async () => {
  const req = { method: 'GET', url: '/api/export/csv?status=all', headers: {}, body: null };
  const res = createResponse();
  const handler = cors(async (_req, response) => response.status(200).json({ ok: true }));

  await handler(req, res);

  assert.deepEqual(
    Object.fromEntries(Object.keys(noStoreHeaders).map((name) => [name, res.headers[name]])),
    noStoreHeaders,
  );
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ok: true });
});

test('caught errors replace every cache-control layer with no-store', async () => {
  const req = { method: 'GET', url: '/api/feed?private=value', headers: {}, body: {} };
  const res = createResponse();
  const error = Object.assign(new Error('synthetic missing'), {
    status: 404,
    publicMessage: 'Not found',
  });
  const originalError = console.error;
  console.error = () => {};

  try {
    await cors(async () => {
      throw error;
    })(req, res);
  } finally {
    console.error = originalError;
  }

  assert.deepEqual(
    Object.fromEntries(Object.keys(noStoreHeaders).map((name) => [name, res.headers[name]])),
    noStoreHeaders,
  );
  assert.equal(res.statusCode, 404);
  assert.deepEqual(res.body, { error: { message: 'Not found', status: 404 } });
});

test('caught-error logs omit query and hash values and mask track tokens', async () => {
  const cases = [
    ['/api/orders?customer=PRIVATE_QUERY#PRIVATE_HASH', '/api/orders'],
    ['/api/track/PRIVATE_TRACK_TOKEN?source=PRIVATE_QUERY', '/api/track/[token]'],
  ];
  const originalError = console.error;

  try {
    for (const [url, expectedRoute] of cases) {
      const calls = [];
      const req = { method: 'GET', url, headers: {}, body: {} };
      const res = createResponse();
      const error = new Error('synthetic failure');
      console.error = (...args) => calls.push(args);

      await cors(async () => {
        throw error;
      })(req, res);

      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], `[API Error] GET ${expectedRoute}:`);
      assert.equal(calls[0][1], error);
      assert.equal(calls.flat().join(' ').includes('PRIVATE_'), false);
      assert.equal(res.statusCode, 500);
    }
  } finally {
    console.error = originalError;
  }
});

test('successful public feed and health responses retain their existing TTLs', async () => {
  const expected = new Map([
    ['/api/feed?limit=20', 'public, s-maxage=30, stale-while-revalidate=120'],
    ['/api/health', 'public, s-maxage=60'],
  ]);

  for (const [url, policy] of expected) {
    const req = { method: 'GET', url, headers: {}, body: undefined };
    const res = createResponse();
    await cors(async (_request, response) => response.status(200).json({ ok: true }))(req, res);

    assert.equal(res.headers['Cache-Control'], policy);
    assert.equal(res.headers['CDN-Cache-Control'], policy);
    assert.equal(res.headers['Vercel-CDN-Cache-Control'], policy);
    assert.equal(res.statusCode, 200);
  }
});
