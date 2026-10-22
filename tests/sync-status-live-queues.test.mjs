import assert from 'node:assert/strict';
import test from 'node:test';
import * as syncStatus from '../api/sync/status.js';

function response() {
  return { code: 200, status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; }, setHeader() {} };
}

test('sync status reports the actual append and shipping queues using SELECT only', async () => {
  const statements = [];
  const db = { async execute(query) {
    statements.push(query.sql);
    assert.ok(query.sql.includes("'%not found%'"), "classify the real webhook error");
    assert.ok(query.sql.includes("'%aborted%'"), "classify a fetch timeout abort");
    assert.match(query.sql.trim(), /^SELECT\b/i);
    assert.doesNotMatch(query.sql, /\b(CREATE|ALTER|INSERT|UPDATE|DELETE)\b/i);
    return { rows: [
      { queue: 'append', status: 'pending', count: 11, last_attempt_at: '2026-10-20T00:00:00Z', last_synced_at: null, not_found: 0, timeout: 0 },
      { queue: 'shipping', status: 'failed', count: 11, last_attempt_at: '2026-10-22T00:00:00Z', last_synced_at: null, not_found: 8, timeout: 3 },
      { queue: 'shipping', status: 'synced', count: 20, last_attempt_at: '2026-10-22T01:00:00Z', last_synced_at: '2026-10-22T01:00:00Z', not_found: 0, timeout: 0 },
    ] };
  } };
  const res = response();
  const handler = syncStatus.handleSyncStatus || syncStatus.default;
  await handler({ method: 'GET', headers: {} }, res, { db, env: { CRON_SECRET: 'configured' } });
  assert.equal(res.body.enabled, true);
  assert.equal(statements.length, 1);
  assert.equal(res.body.append.pending, 11);
  assert.equal(res.body.shipping.failed, 11);
  assert.equal(res.body.shipping.errors.not_found, 8);
  assert.equal(res.body.shipping.errors.timeout, 3);
  assert.equal(res.body.lastSync, '2026-10-22T01:00:00.000Z');
  assert.ok(Array.isArray(res.body.recentSyncs));
  assert.doesNotMatch(JSON.stringify(res.body), /configured|비활성화/);
});

test('sync status rejects mutations before touching a database', async () => {
  const res = response();
  const handler = syncStatus.handleSyncStatus || syncStatus.default;
  await handler({ method: 'POST', headers: {} }, res, { db: { execute() { throw new Error('DB must not be called'); } } });
  assert.equal(res.code, 405);
});
