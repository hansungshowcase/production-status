import assert from 'node:assert/strict';
import test from 'node:test';

import { handleCompleteProcess } from '../api/processes/[id]/complete.js';
import { handleRevertProcess } from '../api/processes/[id]/revert.js';
import { handleStartProcess } from '../api/processes/[id]/start.js';

const ORDER_ID = 901;
const PROCESS_ID = 9901;

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

function dependencies(db, extra = {}) {
  return {
    db,
    rateLimitCheck: () => true,
    requireWorkerAction: () => ({ actor: '이정섭 부장' }),
    notifyInternalStart: async () => {},
    notifyInternalCompletion: async () => {},
    notify: async () => {},
    clearShippedSheet: async () => {},
    ...extra,
  };
}

function processRequest(body = {}) {
  return {
    method: 'PATCH',
    query: { id: String(PROCESS_ID) },
    body: { actor: '이정섭 부장', ...body },
  };
}

function makeLaserStartDb({ receiptValid = false } = {}) {
  const state = {
    process: { id: PROCESS_ID, order_id: ORDER_ID, step_name: '레이저작업', status: 'waiting' },
    order: {
      id: ORDER_ID,
      client_name: '레이저 시작 거래처',
      status: 'in_production',
      work_instruction_revision: 2,
      work_instruction_received_revision: receiptValid ? 2 : null,
      work_instruction_received_at: receiptValid ? '2026-10-07T01:00:00.000Z' : null,
      work_instruction_received_by: receiptValid ? '이정섭 부장' : null,
    },
    processes: [
      { id: 1, order_id: ORDER_ID, step_name: '도면설계', status: 'completed' },
      { id: PROCESS_ID, order_id: ORDER_ID, step_name: '레이저작업', status: 'waiting' },
    ],
    atomicCalls: [],
    writesOutsideAtomic: 0,
  };
  return {
    state,
    async execute({ sql }) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (statement === 'SELECT * FROM processes WHERE id = ?') return { rows: [{ ...state.process }] };
      if (/^(UPDATE|INSERT|DELETE)/i.test(statement)) state.writesOutsideAtomic += 1;
      if (statement === 'SELECT * FROM processes WHERE order_id = ?') return { rows: state.processes.map(row => ({ ...row })) };
      if (statement === 'SELECT * FROM orders WHERE id = ?') return { rows: [{ ...state.order }] };
      return { rows: [] };
    },
    async atomicBatch(queries) {
      state.atomicCalls.push(queries);
      assert.match(queries[0].sql, /orders[\s\S]*FOR UPDATE/i);
      assert.match(queries[2].sql, /work_instruction_received_revision\s*=\s*o\.work_instruction_revision/i);
      const canStart = receiptValid && state.process.status === 'waiting';
      if (canStart) state.process.status = 'in_progress';
      return [
        { rows: [{ ...state.order }] },
        { rows: state.processes.map(row => ({ ...row })) },
        { rows: canStart ? [{ ...state.process, started_by: '이정섭 부장' }] : [] },
      ];
    },
  };
}

test('레이저 직접 시작은 수령이 없으면 주문 잠금 안에서 거부하고 외부 쓰기·알림을 만들지 않는다', async () => {
  const db = makeLaserStartDb({ receiptValid: false });
  let notifyCalls = 0;
  const res = response();
  await handleStartProcess(processRequest(), res, dependencies(db, {
    notifyInternalStart: async () => { notifyCalls += 1; },
  }));

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error.message, /작업지시서.*수령/);
  assert.equal(db.state.process.status, 'waiting');
  assert.equal(db.state.atomicCalls.length, 1);
  assert.equal(db.state.writesOutsideAtomic, 0);
  assert.equal(notifyCalls, 0);
});

test('유효 수령 뒤 레이저 시작은 같은 주문 잠금 배치에서 한 번만 waiting을 선점한다', async () => {
  const db = makeLaserStartDb({ receiptValid: true });
  const res = response();
  await handleStartProcess(processRequest(), res, dependencies(db));

  assert.equal(res.statusCode, 200);
  assert.equal(db.state.process.status, 'in_progress');
  assert.equal(db.state.atomicCalls.length, 1);
  assert.equal(db.state.writesOutsideAtomic, 0);
});

test('도면 완료와 임의 다음 공정 시작 요청은 ensure 훅과 첫 쓰기 전에 거부한다', async () => {
  const state = { writes: 0, ensureCalls: 0 };
  const db = {
    async execute({ sql }) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (statement === 'SELECT * FROM processes WHERE id = ?') {
        return { rows: [{ id: PROCESS_ID, order_id: ORDER_ID, step_name: '도면설계', status: 'in_progress' }] };
      }
      if (/^(UPDATE|INSERT|DELETE)/i.test(statement)) state.writes += 1;
      throw new Error(`도면 전달 가드는 여기까지 오면 안 됩니다: ${statement}`);
    },
  };
  const res = response();
  await handleCompleteProcess(
    processRequest({ start_next_step: '출고', assigned_worker: '이정섭 부장' }),
    res,
    dependencies(db, {
      ensureShippingProcessUniqueIndex: async () => { state.ensureCalls += 1; },
      ensureShippingSheetSyncSchema: async () => { state.ensureCalls += 1; },
    }),
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error.message, /작업지시서 수령 대기/);
  assert.equal(state.writes, 0);
  assert.equal(state.ensureCalls, 0);
});

test('도면 완료는 빈 start_next_step 필드도 자동 전달 요청으로 보아 쓰기 전에 거부한다', async () => {
  let writes = 0;
  const db = {
    async execute(statement) {
      if (/SELECT \* FROM processes WHERE id = \?/i.test(statement.sql)) {
        return { rows: [{ id: PROCESS_ID, order_id: ORDER_ID, step_name: '도면설계', status: 'in_progress' }] };
      }
      writes += 1;
      throw new Error('도면 전달 가드 뒤 쓰기에 도달하면 안 됩니다.');
    },
  };
  const res = response();
  await handleCompleteProcess(
    processRequest({ start_next_step: '' }),
    res,
    {
      db,
      rateLimitCheck: () => true,
      requireWorkerAction: () => ({ actor: '김보수 팀장' }),
    },
  );

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error.message, /작업지시서 수령 대기/);
  assert.equal(writes, 0);
});

function makeDrawingRevertDb() {
  const state = {
    process: {
      id: PROCESS_ID,
      order_id: ORDER_ID,
      step_name: '도면설계',
      status: 'completed',
      completed_at: '2026-10-07T01:00:00.000Z',
      completed_by: '김보수 팀장',
    },
    order: {
      id: ORDER_ID,
      client_name: '도면 되돌리기 거래처',
      status: 'in_production',
      work_instruction_revision: 5,
      work_instruction_received_revision: 5,
      work_instruction_received_at: '2026-10-07T01:10:00.000Z',
      work_instruction_received_by: '이정섭 부장',
    },
    processes: [],
    feed: [],
    atomicCalls: [],
  };
  state.processes = [
    state.process,
    { id: 2, order_id: ORDER_ID, step_name: '레이저작업', status: 'waiting' },
  ];
  return {
    state,
    async execute({ sql, args }) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (statement === 'SELECT * FROM processes WHERE id = ?') return { rows: [{ ...state.process }] };
      if (statement.startsWith('INSERT INTO activity_feed')) {
        state.feed.push({ order_id: args[0], action_type: args[1], actor: args[3] });
        return { rows: [] };
      }
      throw new Error(`Unexpected drawing revert SQL outside atomic batch: ${statement}`);
    },
    async atomicBatch(queries) {
      state.atomicCalls.push(queries);
      assert.match(queries[0].sql, /orders[\s\S]*FOR UPDATE/i);
      assert.match(queries[2].sql, /work_instruction_revision\s*=\s*work_instruction_revision\s*\+\s*1/i);
      assert.match(queries[2].sql, /work_instruction_received_at\s*=\s*NULL/i);
      const processSnapshot = state.processes.map(row => ({ ...row }));
      state.process.status = 'in_progress';
      state.process.completed_at = null;
      state.process.completed_by = null;
      state.order.work_instruction_revision += 1;
      state.order.work_instruction_received_revision = null;
      state.order.work_instruction_received_at = null;
      state.order.work_instruction_received_by = null;
      return [
        { rows: [{ ...state.order, work_instruction_revision: 5 }] },
        { rows: processSnapshot },
        { rows: [{ ...state.process, work_instruction_revision: state.order.work_instruction_revision }] },
      ];
    },
  };
}

test('도면 되돌리기는 공정 복구와 개정 증가·수령 3필드 무효화를 한 원자 배치에서 수행한다', async () => {
  const db = makeDrawingRevertDb();
  const res = response();
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-10-07T02:00:00.000Z');
  try {
    await handleRevertProcess(processRequest(), res, dependencies(db));
  } finally {
    Date.now = originalNow;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(db.state.process.status, 'in_progress');
  assert.equal(db.state.order.work_instruction_revision, 6);
  assert.equal(db.state.order.work_instruction_received_revision, null);
  assert.equal(db.state.order.work_instruction_received_at, null);
  assert.equal(db.state.order.work_instruction_received_by, null);
  assert.equal(db.state.atomicCalls.length, 1);
  assert.equal(db.state.feed.length, 1);
});

test('레이저 시작만 되돌리면 유효 수령 정보와 개정은 그대로 유지된다', async () => {
  const order = {
    id: ORDER_ID,
    client_name: '레이저 되돌리기 거래처',
    status: 'in_production',
    work_instruction_revision: 7,
    work_instruction_received_revision: 7,
    work_instruction_received_at: '2026-10-07T01:00:00.000Z',
    work_instruction_received_by: '이정섭 부장',
  };
  const process = {
    id: PROCESS_ID,
    order_id: ORDER_ID,
    step_name: '레이저작업',
    status: 'in_progress',
    started_at: '2026-10-07T01:05:00.000Z',
    started_by: '이정섭 부장',
  };
  const db = {
    async execute({ sql }) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      if (statement === 'SELECT * FROM processes WHERE id = ?') return { rows: [{ ...process }] };
      if (statement === 'SELECT * FROM processes WHERE order_id = ?') return { rows: [{ ...process }] };
      if (statement.startsWith("UPDATE processes SET status = 'waiting'")) {
        process.status = 'waiting';
        return { rows: [{ id: PROCESS_ID }] };
      }
      if (statement === 'SELECT * FROM orders WHERE id = ?') return { rows: [{ ...order }] };
      if (statement.startsWith('INSERT INTO activity_feed')) return { rows: [] };
      throw new Error(`Unexpected laser revert SQL: ${statement}`);
    },
  };
  const res = response();
  await handleRevertProcess(processRequest(), res, dependencies(db));

  assert.equal(res.statusCode, 200);
  assert.equal(process.status, 'waiting');
  assert.equal(order.work_instruction_revision, 7);
  assert.equal(order.work_instruction_received_revision, 7);
  assert.equal(order.work_instruction_received_at, '2026-10-07T01:00:00.000Z');
  assert.equal(order.work_instruction_received_by, '이정섭 부장');
});
