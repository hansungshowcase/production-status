import assert from 'node:assert/strict';
import test from 'node:test';

function createStorage() {
  const values = new Map();
  return {
    getItem(key) { return values.has(key) ? values.get(key) : null; },
    setItem(key, value) { values.set(key, String(value)); },
    removeItem(key) { values.delete(key); },
  };
}

async function importAuthClient() {
  globalThis.localStorage = createStorage();
  return import(`../src/utils/authClient.js?astra=${Date.now()}-${Math.random()}`);
}

test('auth status failures reject, clear the cached promise, and preserve explicit disabled responses', async () => {
  const { fetchAuthStatus } = await importAuthClient();
  const responses = [
    { ok: false, status: 503, json: async () => ({}) },
    { ok: true, status: 200, json: async () => { throw new SyntaxError('invalid json'); } },
    { ok: true, status: 200, json: async () => ({ enabled: false, authenticated: false }) },
  ];
  let calls = 0;
  globalThis.fetch = async () => responses[calls++];

  await assert.rejects(fetchAuthStatus(), /인증 상태/);
  await assert.rejects(fetchAuthStatus(), /인증 상태/);
  assert.deepEqual(await fetchAuthStatus(), { enabled: false, authenticated: false });
  assert.equal(calls, 3, 'each failure must allow a real retry');
});
