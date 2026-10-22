import assert from 'node:assert/strict';
import test from 'node:test';

import { handleRevertProcess } from '../api/processes/[id]/revert.js';
import { PROCESS_UNDO_MANAGER } from '../shared/processUndoPermission.js';

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

function request({ actor, id = '123' } = {}) {
  return {
    method: 'PATCH',
    query: { id },
    body: actor === undefined ? {} : { actor },
  };
}

function untouchedDependencies(overrides = {}) {
  const state = { executeCalls: 0, atomicCalls: 0, sheetCalls: 0 };
  const db = {
    async execute() {
      state.executeCalls += 1;
      throw new Error('권한 거부 전에 DB에 접근하면 안 됩니다.');
    },
    async atomicBatch() {
      state.atomicCalls += 1;
      throw new Error('권한 거부 전에 atomicBatch에 접근하면 안 됩니다.');
    },
  };
  return {
    state,
    dependencies: {
      db,
      rateLimitCheck: () => true,
      clearShippedSheet: async () => { state.sheetCalls += 1; },
      ...overrides,
    },
  };
}

test('비관리자 되돌리기는 DB·원자배치·시트 호출 전에 403으로 거부한다', async () => {
  const { state, dependencies } = untouchedDependencies({
    requireWorkerAction: () => ({ actor: '작업자 A' }),
  });
  const res = response();

  await handleRevertProcess(request({ actor: '작업자 A' }), res, dependencies);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.message, '김보수 팀장만 공정을 되돌릴 수 있습니다.');
  assert.equal(state.executeCalls, 0);
  assert.equal(state.atomicCalls, 0);
  assert.equal(state.sheetCalls, 0);
});

test('권한 판정은 requireWorkerAction 반환 actor를 사용한다', async () => {
  const { state, dependencies } = untouchedDependencies({
    requireWorkerAction: () => ({ actor: '작업자 A' }),
  });
  const res = response();

  await handleRevertProcess(request({ actor: PROCESS_UNDO_MANAGER }), res, dependencies);

  assert.equal(res.statusCode, 403);
  assert.equal(res.body.error.message, '김보수 팀장만 공정을 되돌릴 수 있습니다.');
  assert.equal(state.executeCalls, 0);
  assert.equal(state.atomicCalls, 0);
  assert.equal(state.sheetCalls, 0);
});

test('인증되지 않은 되돌리기는 DB 전에 401로 거부한다', async () => {
  const { state, dependencies } = untouchedDependencies({
    requireWorkerAction: (_req, res) => {
      res.status(401).json({ error: { message: '인증이 필요합니다.', status: 401 } });
      return null;
    },
  });
  const res = response();

  await handleRevertProcess(request(), res, dependencies);

  assert.equal(res.statusCode, 401);
  assert.equal(res.body.error.message, '인증이 필요합니다.');
  assert.equal(state.executeCalls, 0);
  assert.equal(state.atomicCalls, 0);
});

test('허용된 김보수 팀장으로 실행한 되돌리기 감사 actor는 요청 body와 무관하게 정규화된다', async () => {
  const process = {
    id: 123,
    order_id: 456,
    step_name: '레이저작업',
    status: 'in_progress',
  };
  const order = { id: 456, client_name: '감사 actor 검증 거래처' };
  const state = { activityActor: null, status: process.status };
  const db = {
    async execute({ sql, args }) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (statement === 'SELECT * FROM processes WHERE id = ?') {
        return { rows: [{ ...process, status: state.status }] };
      }
      if (statement === 'SELECT * FROM processes WHERE order_id = ?') {
        return { rows: [{ ...process, status: state.status }] };
      }
      if (statement.startsWith("UPDATE processes SET status = 'waiting'")) {
        state.status = 'waiting';
        return { rows: [{ id: process.id }] };
      }
      if (statement === 'SELECT * FROM orders WHERE id = ?') {
        assert.deepEqual(args, [order.id]);
        return { rows: [order] };
      }
      if (statement.startsWith('INSERT INTO activity_feed')) {
        state.activityActor = args[3];
        return { rows: [] };
      }
      throw new Error(`예상하지 않은 SQL: ${statement}`);
    },
    async atomicBatch(queries) {
      assert.equal(queries.length, 1);
      assert.match(queries[0].sql, /^WITH claimed_process AS/i);
      state.status = 'waiting';
      state.activityActor = queries[0].args[5];
      return [{ rows: [{
        process_row: { ...process, status: state.status },
        order_row: { ...order },
        reverted_ship_date: null,
      }] }];
    },
  };
  const res = response();

  await handleRevertProcess(request({ actor: '작업자 A' }), res, {
    db,
    rateLimitCheck: () => true,
    requireWorkerAction: () => ({ actor: PROCESS_UNDO_MANAGER }),
  });

  assert.equal(res.statusCode, 200);
  assert.equal(state.status, 'waiting');
  assert.equal(state.activityActor, PROCESS_UNDO_MANAGER);
  assert.notEqual(state.activityActor, '작업자 A');
});
