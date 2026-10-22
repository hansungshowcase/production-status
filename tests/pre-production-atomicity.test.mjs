import assert from 'node:assert/strict';
import test from 'node:test';

import { handleGet, handlePatch } from '../api/pre-production/[orderId].js';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function preProductionDb({ before = null, atomicRows, atomicError } = {}) {
  const state = { calls: [], batches: [] };
  return {
    state,
    async execute(query) {
      state.calls.push(query);
      if (query.sql === 'SELECT * FROM orders WHERE id = ?') {
        return { rows: [{ id: 71, client_name: '사전생산 거래처' }] };
      }
      if (query.sql === 'SELECT * FROM pre_production WHERE order_id = ?') {
        return { rows: before ? [{ ...before }] : [] };
      }
      throw new Error(`Unexpected SQL: ${query.sql}`);
    },
    async atomicBatch(queries) {
      state.batches.push(queries);
      assert.equal(queries.length, 1);
      assert.match(queries[0].sql, /^WITH upserted_pre_production AS/i);
      assert.match(queries[0].sql, /ON CONFLICT\s*\(order_id\) DO UPDATE/i);
      assert.match(queries[0].sql, /INSERT INTO activity_feed/i);
      if (atomicError) throw atomicError;
      return [{ rows: atomicRows || [] }];
    },
  };
}

function dependencies(db) {
  return { db, requireAuth: async () => ({ role: 'sales', actor: '관리자' }) };
}

test('사전생산 PATCH는 엄격한 boolean/0/1만 받아 upsert와 감사를 한 원자 CTE로 저장한다', async () => {
  const row = { order_id: 71, instruction_check: 1, material_drawing: 0 };
  const db = preProductionDb({ atomicRows: [{ pre_production_row: row }] });
  const res = response();

  await handlePatch({
    query: { orderId: '00071' },
    body: { instruction_check: true, material_drawing: 0, actor: '관리자' },
  }, res, dependencies(db));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { ...row, client_name: '사전생산 거래처' });
  assert.equal(db.state.batches.length, 1);
  assert.deepEqual(db.state.batches[0][0].args.slice(0, 3), [71, 1, 0]);
});

test('사전생산 PATCH는 문자열 boolean과 0/1 이외 숫자를 DB 전에 400으로 거절한다', async () => {
  for (const value of ['false', 'true', null, [], {}, 2, -1]) {
    const db = preProductionDb();
    const res = response();
    await handlePatch({ query: { orderId: '71' }, body: { instruction_check: value } }, res, dependencies(db));
    assert.equal(res.statusCode, 400);
    assert.equal(db.state.calls.length, 0);
    assert.equal(db.state.batches.length, 0);
  }
});

test('사전생산 PATCH는 유효 필드가 없으면 DB 전에 400으로 거절한다', async () => {
  const db = preProductionDb();
  const res = response();
  await handlePatch({ query: { orderId: '71' }, body: { actor: '관리자' } }, res, dependencies(db));
  assert.equal(res.statusCode, 400);
  assert.equal(db.state.calls.length, 0);
});

test('사전생산 PATCH 감사 실패는 원자 배치 실패로 전파된다', async () => {
  const db = preProductionDb({
    before: { order_id: 71, instruction_check: 0 },
    atomicError: new Error('pre-production audit failed'),
  });
  await assert.rejects(
    handlePatch({ query: { orderId: '71' }, body: { instruction_check: 1 } }, response(), dependencies(db)),
    /pre-production audit failed/,
  );
  assert.equal(db.state.batches.length, 1);
});

test('사전생산 GET/PATCH는 잘못된 int4 ID를 DB 전에 400으로 거절한다', async () => {
  for (const handler of [handleGet, handlePatch]) {
    for (const orderId of ['1.5', '2147483648']) {
      const db = preProductionDb();
      const res = response();
      await handler(
        { query: { orderId }, body: { instruction_check: true } },
        res,
        handler === handlePatch ? dependencies(db) : { db },
      );
      assert.equal(res.statusCode, 400);
      assert.equal(db.state.calls.length, 0);
      assert.equal(db.state.batches.length, 0);
    }
  }
});
