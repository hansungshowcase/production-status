import assert from 'node:assert/strict';
import test from 'node:test';

import { handleStartProcess } from '../api/processes/[id]/start.js';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function request(id = '73') {
  return {
    method: 'PATCH',
    query: { id },
    body: { actor: '공정 작업자', work_date: '2026-10-22T01:02:03.000Z' },
  };
}

function startDb({ atomicRows, atomicError = null } = {}) {
  const process = { id: 73, order_id: 173, step_name: '용접작업', status: 'waiting' };
  const order = { id: 173, client_name: '공정 시작 거래처', status: 'in_production' };
  const previous = ['도면설계', '레이저작업', 'V-커팅작업', '절곡작업'].map((step_name, index) => ({
    id: index + 1,
    order_id: 173,
    step_name,
    status: 'completed',
  }));
  const state = { batches: [], writesOutsideAtomic: 0, dbCalls: 0 };
  return {
    state,
    async execute({ sql }) {
      state.dbCalls += 1;
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      if (/^(?:INSERT|UPDATE|DELETE)\b/i.test(statement)) state.writesOutsideAtomic += 1;
      if (statement === 'SELECT * FROM processes WHERE id = ?') return { rows: [{ ...process }] };
      if (statement === 'SELECT * FROM processes WHERE order_id = ?') return { rows: [...previous, { ...process }] };
      if (statement === 'SELECT * FROM orders WHERE id = ?') return { rows: [{ ...order }] };
      if (statement.startsWith("UPDATE processes SET status = 'in_progress'")) {
        process.status = 'in_progress';
        return { rows: [{ id: 73 }] };
      }
      if (statement.startsWith('INSERT INTO activity_feed')) throw new Error('audit insert failed');
      throw new Error(`Unexpected start SQL: ${statement}`);
    },
    async atomicBatch(queries) {
      state.batches.push(queries);
      assert.equal(queries.length, 1);
      assert.match(queries[0].sql, /^WITH eligible_process AS/i);
      assert.match(queries[0].sql, /claimed_process AS/i);
      assert.match(queries[0].sql, /INSERT INTO activity_feed/i);
      assert.match(queries[0].sql, /FROM claimed_process/i);
      if (atomicError) throw atomicError;
      return [{ rows: atomicRows || [] }];
    },
  };
}

function dependencies(db, external) {
  return {
    db,
    rateLimitCheck: () => true,
    requireWorkerAction: () => ({ actor: '공정 작업자' }),
    notifyInternalStart: async () => external.push('internal'),
  };
}

test('일반 공정 시작은 상태 CAS와 감사를 한 guarded CTE로 커밋한 뒤 알림을 호출한다', async () => {
  const process = {
    id: 73,
    order_id: 173,
    step_name: '용접작업',
    status: 'in_progress',
    started_at: '2026-10-22T01:02:03.000Z',
    started_by: '공정 작업자',
  };
  const db = startDb({
    atomicRows: [{
      process_row: process,
      order_row: { id: 173, client_name: '공정 시작 거래처', status: 'in_production' },
    }],
  });
  const external = [];
  const res = response();

  await handleStartProcess(request(), res, dependencies(db, external));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, process);
  assert.equal(db.state.batches.length, 1);
  assert.equal(db.state.writesOutsideAtomic, 0);
  assert.deepEqual(external, ['internal']);
});

test('일반 공정 시작 감사 실패는 전체 rollback되어 외부 알림을 호출하지 않는다', async () => {
  const db = startDb({ atomicError: new Error('audit insert failed') });
  const external = [];

  await assert.rejects(
    handleStartProcess(request(), response(), dependencies(db, external)),
    /audit insert failed/,
  );

  assert.equal(db.state.batches.length, 1);
  assert.equal(db.state.writesOutsideAtomic, 0);
  assert.deepEqual(external, []);
});

test('일반 공정 시작 CAS 0행은 감사와 알림 없이 기존 409를 반환한다', async () => {
  const db = startDb({ atomicRows: [] });
  const external = [];
  const res = response();

  await handleStartProcess(request(), res, dependencies(db, external));

  assert.equal(res.statusCode, 409);
  assert.equal(db.state.batches.length, 1);
  assert.deepEqual(external, []);
});

test('일반 공정 시작은 잘못된 int4 ID를 DB 접근 전에 400으로 거절한다', async () => {
  for (const id of ['1.5', '2147483648']) {
    const db = startDb();
    const res = response();

    await handleStartProcess(request(id), res, dependencies(db, []));

    assert.equal(res.statusCode, 400);
    assert.equal(db.state.dbCalls, 0);
    assert.equal(db.state.batches.length, 0);
  }
});
