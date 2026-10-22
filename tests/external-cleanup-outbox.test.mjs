import assert from 'node:assert/strict';
import test from 'node:test';

import { processExternalCleanupJob, runExternalCleanup } from '../api/_lib/externalCleanup.js';

const blobUrl = 'https://ggbhax5zgrdqymby.public.blob.vercel-storage.com/orders/example.png';

function createDb(job, { referenced = false, finishCurrent = true } = {}) {
  const calls = [];
  return {
    calls,
    async execute(query) {
      calls.push(query);
      if (query.sql.includes('SET status = \'sending\'')) {
        return {
          rows: [{ ...job, attempts: job.attempts + 1, lease_token: query.args[0] }],
        };
      }
      if (query.sql.includes('SELECT EXISTS')) return { rows: [{ referenced }] };
      if (query.sql.includes("SET status = 'failed'")) {
        return { rows: finishCurrent ? [{ id: job.id }] : [] };
      }
      if (query.sql.includes('SET status = ?')) {
        return { rows: finishCurrent ? [{ id: job.id }] : [] };
      }
      throw new Error(`unexpected SQL: ${query.sql}`);
    },
  };
}

function blobJob(overrides = {}) {
  return {
    id: 1,
    target_key: `blob:${blobUrl}`,
    kind: 'blob_delete',
    payload: { url: blobUrl },
    attempts: 0,
    ...overrides,
  };
}

function sheetJob(overrides = {}) {
  return {
    id: 2,
    target_key: 'sheet:order:101',
    kind: 'sheet_delete',
    payload: { orderId: 101 },
    attempts: 0,
    ...overrides,
  };
}

test('a referenced blob is held without calling Blob deletion', async () => {
  const db = createDb(blobJob(), { referenced: true });
  let deletes = 0;

  const result = await processExternalCleanupJob(db, `blob:${blobUrl}`, {
    deleteBlob: async () => { deletes += 1; },
  });

  assert.deepEqual(result, { claimed: true, status: 'held_shared' });
  assert.equal(deletes, 0);
  const finish = db.calls.find((call) => call.sql.includes('SET status = ?'));
  assert.equal(finish.args[0], 'held_shared');
});

test('an unapproved blob host is held before reference lookup or deletion', async () => {
  const unsafeUrl = 'https://example.com/orders/example.png';
  const db = createDb(blobJob({ target_key: `blob:${unsafeUrl}`, payload: { url: unsafeUrl } }));
  let deletes = 0;

  const result = await processExternalCleanupJob(db, `blob:${unsafeUrl}`, {
    deleteBlob: async () => { deletes += 1; },
  });

  assert.deepEqual(result, { claimed: true, status: 'held_host' });
  assert.equal(deletes, 0);
  assert.equal(db.calls.some((call) => call.sql.includes('SELECT EXISTS')), false);
});

test('Blob 404 is treated as an idempotent completed deletion', async () => {
  const db = createDb(blobJob());

  const result = await processExternalCleanupJob(db, `blob:${blobUrl}`, {
    deleteBlob: async () => { throw Object.assign(new Error('not found'), { status: 404 }); },
  });

  assert.deepEqual(result, { claimed: true, status: 'completed' });
});

test('a sheet endpoint without strict AR identity is held before deletion', async () => {
  const db = createDb(sheetJob());
  let deletes = 0;

  const result = await processExternalCleanupJob(db, 'sheet:order:101', {
    probeSheet: async () => ({ strictOrderId: true, idColumn: 20, idSchema: 'legacy' }),
    deleteSheetOrder: async () => { deletes += 1; },
  });

  assert.deepEqual(result, { claimed: true, status: 'held_manual' });
  assert.equal(deletes, 0);
});

test('an unresolved strict sheet ID is held for reconciliation', async () => {
  const db = createDb(sheetJob());

  const result = await processExternalCleanupJob(db, 'sheet:order:101', {
    probeSheet: async () => ({ strictOrderId: true, idColumn: 44, idSchema: 'ar-v1' }),
    deleteSheetOrder: async () => {
      throw Object.assign(new Error('unresolved'), { code: 'SHEET_ID_UNRESOLVED' });
    },
  });

  assert.deepEqual(result, { claimed: true, status: 'held_manual' });
  const finish = db.calls.find((call) => call.sql.includes('SET status = ?'));
  assert.equal(finish.args[0], 'held_manual');
});

test('a transient external failure records the first five-minute backoff', async () => {
  const db = createDb(blobJob());

  const result = await processExternalCleanupJob(db, `blob:${blobUrl}`, {
    deleteBlob: async () => { throw new Error('temporary outage'); },
  });

  assert.equal(result.status, 'failed');
  const failure = db.calls.find((call) => call.sql.includes("SET status = 'failed'"));
  assert.deepEqual(failure.args.slice(0, 2), ['temporary outage', 300]);
});

test('a lost lease reports stale instead of completing the job', async () => {
  const db = createDb(blobJob(), { finishCurrent: false });

  const result = await processExternalCleanupJob(db, `blob:${blobUrl}`, {
    deleteBlob: async () => {},
  });

  assert.deepEqual(result, { claimed: true, status: 'stale' });
});


test('the cron does not claim a sheet job without two timeouts plus DB margin remaining', async () => {
  const calls = [];
  const db = {
    async execute(query) {
      calls.push(query);
      if (query.sql.includes('SELECT target_key, kind')) {
        return { rows: [{ target_key: 'sheet:order:101', kind: 'sheet_delete' }] };
      }
      throw new Error('a job was claimed after the budget gate');
    },
  };
  let probes = 0;
  let deletes = 0;

  const summary = await runExternalCleanup(db, {
    deadlineMs: 10_000,
    timeoutMs: 5_000,
    probeSheet: async () => { probes += 1; },
    deleteSheetOrder: async () => { deletes += 1; },
  });

  assert.deepEqual(summary, { attempted: 0, completed: 0, failed: 0, held: 0 });
  assert.equal(calls.length, 1);
  assert.equal(probes, 0);
  assert.equal(deletes, 0);
});
