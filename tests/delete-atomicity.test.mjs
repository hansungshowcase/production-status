import assert from 'node:assert/strict';
import test from 'node:test';

import * as orderRoute from '../api/orders/[id]/index.js';
import * as photoRoute from '../api/photos/[id].js';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
  };
}

function deleteRequest(id, body = { actor: '삭제 담당자', delete_context: 'sales-management' }) {
  return { method: 'DELETE', query: { id: String(id) }, body };
}

function makeOrderDeleteDb({ fail = false } = {}) {
  const state = {
    order: { id: 71, client_name: '삭제 거래처' },
    photos: [
      { id: 1, order_id: 71, file_path: 'https://blob.example/a.jpg' },
      { id: 2, order_id: 71, file_path: null },
    ],
    activity: [],
    batches: [],
  };
  return {
    state,
    async atomicBatch(queries) {
      state.batches.push(queries);
      assert.equal(queries.length, 3);
      assert.match(queries[0].sql, /SELECT \* FROM orders WHERE id = \? FOR UPDATE/i);
      assert.match(queries[1].sql, /SELECT file_path FROM photos WHERE order_id = \?/i);
      assert.match(queries[2].sql, /WITH cleanup_candidates AS/i);
      assert.match(queries[2].sql, /INSERT INTO external_cleanup_jobs/i);
      assert.match(queries[2].sql, /INSERT INTO activity_feed/i);
      assert.match(queries[2].sql, /DELETE FROM orders/i);
      assert.match(queries[2].sql, /FROM delete_audit/i);
      if (fail) throw new Error('simulated atomic order delete failure');
      const order = state.order ? { ...state.order } : null;
      const files = state.photos.map(({ file_path }) => ({ file_path }));
      if (!order) return [{ rows: [] }, { rows: [] }, { rows: [] }];
      state.activity.push({
        order_id: null,
        action_type: '주문삭제',
        description: `${order.client_name} 주문(ID: ${order.id})이 삭제되었습니다.`,
        actor: '삭제 담당자',
      });
      state.order = null;
      state.photos = [];
      return [{ rows: [order] }, { rows: files }, { rows: [{ id: order.id }] }];
    },
  };
}

function makePhotoDeleteDb({ fail = false } = {}) {
  const state = {
    photo: { id: 8, order_id: 71, file_path: 'https://blob.example/photo.jpg' },
    order: { id: 71, client_name: '사진 거래처' },
    activity: [],
    batches: [],
  };
  return {
    state,
    async atomicBatch(queries) {
      state.batches.push(queries);
      assert.equal(queries.length, 1);
      assert.match(queries[0].sql, /WITH selected_photo AS/i);
      assert.match(queries[0].sql, /FOR UPDATE/i);
      assert.match(queries[0].sql, /DELETE FROM photos/i);
      assert.match(queries[0].sql, /INSERT INTO activity_feed/i);
      assert.match(queries[0].sql, /FROM deleted_photo/i);
      if (fail) throw new Error('simulated atomic photo delete failure');
      if (!state.photo) return [{ rows: [] }];
      const deleted = { ...state.photo, client_name: state.order.client_name };
      state.photo = null;
      state.activity.push({
        order_id: deleted.order_id,
        action_type: '사진삭제',
        description: `${deleted.client_name} - 사진이 삭제되었습니다.`,
        actor: '삭제 담당자',
      });
      return [{ rows: [deleted] }];
    },
  };
}

test('order delete commits its surviving audit before Blob and Sheets cleanup', async () => {
  assert.equal(typeof orderRoute.handleDelete, 'function');
  const db = makeOrderDeleteDb();
  const external = [];
  const res = response();

  await orderRoute.handleDelete('71', deleteRequest(71), res, {
    db,
    requireAuth: () => ({ role: 'sales', actor: '삭제 담당자' }),
    ensureExternalCleanupSchema: async () => {},
    processExternalCleanupJob: async (_db, targetKey) => external.push([targetKey, db.state.order]),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(db.state.order, null);
  assert.deepEqual(db.state.photos, []);
  assert.deepEqual(db.state.activity, [{
    order_id: null,
    action_type: '주문삭제',
    description: '삭제 거래처 주문(ID: 71)이 삭제되었습니다.',
    actor: '삭제 담당자',
  }]);
  assert.deepEqual(external, [
    ['sheet:order:71', null],
    ['blob:https://blob.example/a.jpg', null],
  ]);
});

test('order delete database failure leaves every row and invokes zero external cleanup', async () => {
  assert.equal(typeof orderRoute.handleDelete, 'function');
  const db = makeOrderDeleteDb({ fail: true });
  const before = structuredClone(db.state);
  let externalCalls = 0;

  await assert.rejects(
    orderRoute.handleDelete('71', deleteRequest(71), response(), {
      db,
      requireAuth: () => ({ role: 'sales', actor: '삭제 담당자' }),
      ensureExternalCleanupSchema: async () => {},
      processExternalCleanupJob: async () => { externalCalls += 1; },
    }),
    /simulated atomic order delete failure/,
  );

  assert.deepEqual({ ...db.state, batches: [] }, { ...before, batches: [] });
  assert.equal(externalCalls, 0);
});

test('order delete keeps committed success when Blob or Sheets cleanup fails', async () => {
  assert.equal(typeof orderRoute.handleDelete, 'function');
  const db = makeOrderDeleteDb();
  const res = response();
  const oldWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  try {
    await orderRoute.handleDelete('71', deleteRequest(71), res, {
      db,
      requireAuth: () => ({ role: 'sales', actor: '삭제 담당자' }),
      ensureExternalCleanupSchema: async () => {},
      processExternalCleanupJob: async (_db, targetKey) => { throw new Error(`${targetKey} unavailable`); },
    });
  } finally {
    console.warn = oldWarn;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(db.state.order, null);
  assert.match(warnings.join('\n'), /blob:https:\/\/blob\.example\/a\.jpg unavailable/);
  assert.match(warnings.join('\n'), /sheet:order:71 unavailable/);
});

test('photo delete commits its audit before Blob cleanup', async () => {
  assert.equal(typeof photoRoute.handleDelete, 'function');
  const db = makePhotoDeleteDb();
  const external = [];
  const res = response();

  await photoRoute.handleDelete(deleteRequest(8), res, {
    db,
    requireAuth: () => ({ role: 'sales', actor: '삭제 담당자' }),
    ensureExternalCleanupSchema: async () => {},
    processExternalCleanupJob: async (_db, targetKey) => external.push([targetKey, db.state.photo]),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(db.state.photo, null);
  assert.deepEqual(db.state.activity, [{
    order_id: 71,
    action_type: '사진삭제',
    description: '사진 거래처 - 사진이 삭제되었습니다.',
    actor: '삭제 담당자',
  }]);
  assert.deepEqual(external, [['blob:https://blob.example/photo.jpg', null]]);
});

test('photo delete database failure leaves the row and invokes zero Blob cleanup', async () => {
  assert.equal(typeof photoRoute.handleDelete, 'function');
  const db = makePhotoDeleteDb({ fail: true });
  const before = structuredClone(db.state);
  let blobCalls = 0;

  await assert.rejects(
    photoRoute.handleDelete(deleteRequest(8), response(), {
      db,
      requireAuth: () => ({ role: 'sales', actor: '삭제 담당자' }),
      ensureExternalCleanupSchema: async () => {},
      processExternalCleanupJob: async () => { blobCalls += 1; },
    }),
    /simulated atomic photo delete failure/,
  );

  assert.deepEqual({ ...db.state, batches: [] }, { ...before, batches: [] });
  assert.equal(blobCalls, 0);
});
