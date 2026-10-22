import assert from 'node:assert/strict';
import test from 'node:test';

import { handleGet as handleWorkOrderImageGet } from '../api/orders/[id]/work-order-image.js';
import { handleWorkInstructionReceipt } from '../api/orders/[id]/work-instruction-receipt.js';
import { handleShip } from '../api/orders/[id]/ship.js';
import { handleWorkerShip } from '../api/orders/[id]/worker-ship.js';
import { handleTrackLink } from '../api/orders/[id]/track-link.js';
import { handleCompleteProcess } from '../api/processes/[id]/complete.js';
import { handleRevertProcess } from '../api/processes/[id]/revert.js';
import { handleGet as handlePhotosGet, handlePost as handlePhotoPost } from '../api/photos/index.js';
import { handleDelete as handlePhotoDelete, handleGet as handlePhotoGet } from '../api/photos/[id].js';
import { PROCESS_UNDO_MANAGER } from '../shared/processUndoPermission.js';

function createResponse() {
  return {
    statusCode: 200,
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return value; },
    setHeader() {},
    send(value) { this.body = value; return value; },
  };
}

test('invalid route IDs stop before database and external side effects', async () => {
  for (const invalidId of ['-1', '1.5', '1e3', '2147483648', ['1', '2']]) {
    let dbCalls = 0;
    let blobCalls = 0;
    const db = {
      async execute() { dbCalls += 1; throw new Error('database should not be called'); },
      async atomicBatch() { dbCalls += 1; throw new Error('database should not be called'); },
    };

    const cases = [
      () => handleShip(
        { method: 'PATCH', query: { id: invalidId } },
        createResponse(),
        { rateLimitCheck: () => true, requireAuth: () => ({ role: 'sales' }), db,
          completeOrderShipping: async () => { throw new Error('shipping should not be called'); } },
      ),
      () => handleWorkerShip(
        { method: 'PATCH', query: { id: invalidId } },
        createResponse(),
        { rateLimitCheck: () => true, requireWorkerAction: () => ({ actor: 'worker' }), db,
          completeOrderShipping: async () => { throw new Error('shipping should not be called'); } },
      ),
      () => handleTrackLink(
        { method: 'GET', query: { id: invalidId } },
        createResponse(),
        { rateLimitCheck: () => true, requireAuth: () => ({ role: 'sales' }), db,
          ensureTrackToken: async () => { throw new Error('token generation should not be called'); } },
      ),
      () => handleWorkOrderImageGet({ query: { id: invalidId } }, createResponse(), { db }),
      () => handleWorkInstructionReceipt(
        { method: 'PATCH', query: { id: invalidId }, body: { expected_revision: 1 } },
        createResponse(),
        { rateLimitCheck: () => true, requireWorkerAction: () => ({ actor: 'worker' }), db },
      ),
      () => handleCompleteProcess(
        { method: 'PATCH', query: { id: invalidId }, body: {} },
        createResponse(),
        { rateLimitCheck: () => true, requireWorkerAction: () => ({ actor: 'worker' }), db },
      ),
      () => handleRevertProcess(
        { method: 'PATCH', query: { id: invalidId }, body: {} },
        createResponse(),
        { rateLimitCheck: () => true, requireWorkerAction: () => ({ actor: PROCESS_UNDO_MANAGER }), db },
      ),
      () => handlePhotosGet({ query: { order_id: invalidId } }, createResponse(), { db }),
      () => handlePhotoGet({ query: { id: invalidId } }, createResponse(), { db }),
      () => handlePhotoDelete(
        { query: { id: invalidId } },
        createResponse(),
        { requireAuth: () => ({ role: 'sales' }), db, deleteBlob: async () => { blobCalls += 1; } },
      ),
    ];

    for (const run of cases) {
      const result = await run();
      assert.equal(result.error.status, 400);
    }
    assert.equal(dbCalls, 0);
    assert.equal(blobCalls, 0);
  }
});

test('valid route IDs are normalized to numbers at the database boundary', async () => {
  for (const [input, expected] of [['0001', 1], ['2147483647', 2147483647]]) {
    const seenArgs = [];
    const db = {
      async execute(statement) {
        seenArgs.push(statement.args);
        return { rows: [] };
      },
    };
    const res = createResponse();
    await handlePhotoGet({ query: { id: input } }, res, { db });
    assert.equal(res.statusCode, 404);
    assert.deepEqual(seenArgs, [[expected]]);
  }
});

test('valid tracking IDs reach the token boundary as normalized numbers', async () => {
  for (const [input, expected] of [['0001', 1], ['2147483647', 2147483647]]) {
    const seenIds = [];
    const res = createResponse();
    await handleTrackLink(
      { method: 'GET', query: { id: input } },
      res,
      {
        rateLimitCheck: () => true,
        requireAuth: () => ({ role: 'sales' }),
        db: {},
        ensureTrackToken: async (_db, id) => { seenIds.push(id); return `token-${id}`; },
      },
    );
    assert.deepEqual(seenIds, [expected]);
    assert.equal(res.body.token, `token-${expected}`);
  }
});

test('photo list keeps an omitted order filter optional but rejects an empty one', async () => {
  let dbCalls = 0;
  const db = {
    async execute() {
      dbCalls += 1;
      return { rows: [] };
    },
  };

  const unfilteredRes = createResponse();
  await handlePhotosGet({ query: {} }, unfilteredRes, { db });
  assert.equal(unfilteredRes.statusCode, 200);
  assert.equal(dbCalls, 1);

  const emptyRes = createResponse();
  await handlePhotosGet({ query: { order_id: '' } }, emptyRes, { db });
  assert.equal(emptyRes.statusCode, 400);
  assert.equal(dbCalls, 1);
});

test('photo POST rejects invalid required order and optional process IDs before DB or storage', async () => {
  for (const fields of [
    { order_id: '1.5', process_id: null },
    { order_id: '1', process_id: '2147483648' },
    { order_id: '1', process_id: '' },
  ]) {
    const parts = Object.entries(fields)
      .filter(([, value]) => value !== null)
      .map(([name, value]) => ({ name, filename: null, data: Buffer.from(value) }));
    let authCalls = 0;
    let dbCalls = 0;
    let storageCalls = 0;
    const res = createResponse();
    await handlePhotoPost(
      { headers: {} },
      res,
      {
        parseMultipart: async () => parts,
        authorizePhotoUpload: () => { authCalls += 1; return true; },
        db: { async execute() { dbCalls += 1; return { rows: [] }; } },
        storeImageFile: async () => { storageCalls += 1; return { url: 'unused', rollbackUrl: null }; },
      },
    );
    assert.equal(res.statusCode, 400);
    assert.equal(authCalls, 1);
    assert.equal(dbCalls, 0);
    assert.equal(storageCalls, 0);
  }
});
