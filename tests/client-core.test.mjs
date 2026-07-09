import assert from 'node:assert/strict';
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
