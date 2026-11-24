import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

import { parseResponseBody, shouldRetryRequest } from '../src/api/clientCore.js';

test('mutating requests are not retried after network or timeout failures', () => {
  assert.equal(shouldRetryRequest({ method: 'GET', status: 0, retryCount: 0 }), true);
  assert.equal(shouldRetryRequest({ method: 'POST', status: 0, retryCount: 0 }), false);
  assert.equal(shouldRetryRequest({ method: 'PATCH', status: 0, retryCount: 0 }), false);
  assert.equal(shouldRetryRequest({ method: 'DELETE', status: 0, retryCount: 0 }), false);
});

test('requests are retried at most once', () => {
  assert.equal(shouldRetryRequest({ method: 'GET', status: 0, retryCount: 1 }), false);
});

test('empty successful response bodies parse as null instead of throwing', async () => {
  const response = {
    status: 204,
    headers: {
      get() {
        return '';
      },
    },
    async text() {
      return '';
    },
  };

  assert.equal(await parseResponseBody(response), null);
});

test('json response bodies are parsed normally', async () => {
  const response = {
    status: 200,
    headers: {
      get(name) {
        return name.toLowerCase() === 'content-type' ? 'application/json; charset=utf-8' : '';
      },
    },
    async text() {
      return '{"ok":true}';
    },
  };

  assert.deepEqual(await parseResponseBody(response), { ok: true });
});

test('api client keeps 15s read timeout, uses 25s mutation timeout, honors timeoutMs, and createOrder uses 25s', async () => {
  const clientSrc = await readFile(new URL('../src/api/client.js', import.meta.url), 'utf8');
  const ordersSrc = await readFile(new URL('../src/api/orders.js', import.meta.url), 'utf8');

  assert.match(clientSrc, /const REQUEST_TIMEOUT = 15000;/);
  assert.match(clientSrc, /const MUTATION_TIMEOUT = 25000;/);
  assert.match(clientSrc, /const MUTATING_METHODS = new Set\(\['POST', 'PUT', 'PATCH', 'DELETE'\]\);/);
  assert.match(clientSrc, /MUTATING_METHODS\.has\(normalizedMethod\) \? MUTATION_TIMEOUT : REQUEST_TIMEOUT/);
  assert.match(clientSrc, /Number\.isFinite\(timeoutMs\) && timeoutMs > 0 \? timeoutMs : defaultTimeout/);
  assert.match(clientSrc, /setTimeout\(\(\) => controller\.abort\(\), effectiveTimeout\)/);
  assert.match(ordersSrc, /request\('\/orders', \{ method: 'POST', body: data, timeoutMs: 25000 \}\)/);
});
