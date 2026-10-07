import assert from 'node:assert/strict';
import test from 'node:test';

import { handleWorkInstructionReceipt } from '../api/orders/[id]/work-instruction-receipt.js';

const ORDER_ID = 417;

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

function request({ actor = '이정섭 부장', expectedRevision = 0 } = {}) {
  return {
    method: 'PATCH',
    query: { id: String(ORDER_ID) },
    headers: {},
    body: { actor, expected_revision: expectedRevision },
  };
}

function validReceipt(order) {
  return order.work_instruction_revision !== null
    && order.work_instruction_revision !== undefined
    && order.work_instruction_received_revision !== null
    && order.work_instruction_received_revision !== undefined
    && Number(order.work_instruction_revision) === Number(order.work_instruction_received_revision)
    && Boolean(order.work_instruction_received_at)
    && Boolean(String(order.work_instruction_received_by || '').trim());
}

function makeDb({
  order = {},
  processes,
  now = '2026-10-07T03:04:05.000Z',
} = {}) {
  const state = {
    order: {
      id: ORDER_ID,
      client_name: '레이저 수령 거래처',
      status: 'in_production',
      work_instruction_revision: 0,
      work_instruction_received_revision: null,
      work_instruction_received_at: null,
      work_instruction_received_by: null,
      ...order,
    },
    processes: (processes || [
      { id: 1, order_id: ORDER_ID, step_name: '도면설계', status: 'completed' },
      { id: 2, order_id: ORDER_ID, step_name: '레이저작업', status: 'waiting' },
      { id: 3, order_id: ORDER_ID, step_name: 'V-커팅작업', status: 'waiting' },
    ]).map((row) => ({ ...row })),
    feed: [],
    atomicCalls: [],
  };

  return {
    state,
    async execute() {
      throw new Error('receipt route must not write or validate outside atomicBatch');
    },
    async atomicBatch(queries, options) {
      state.atomicCalls.push({ queries, options });
      assert.match(queries[0].sql, /FOR UPDATE/i);
      assert.match(queries[2].sql, /UPDATE orders/i);
      assert.match(queries[2].sql, /INSERT INTO activity_feed/i);
      assert.match(queries[2].sql, /NOT COALESCE\(\([\s\S]*work_instruction_received_revision/i);

      const locked = state.order ? [{ ...state.order }] : [];
      const processRows = state.order ? state.processes.map((row) => ({ ...row })) : [];
      const expectedRevision = Number(queries[2].args[1]);
      const actor = queries[2].args[2];
      const drawings = processRows.filter((row) => row.step_name === '도면설계');
      const lasers = processRows.filter((row) => row.step_name === '레이저작업');
      const downstream = processRows.filter((row) => [
        'V-커팅작업', '절곡작업', '용접작업', '분체작업', '조립작업', '설비작업', '포장', '출고',
      ].includes(row.step_name));
      const eligible = locked.length === 1
        && state.order.status === 'in_production'
        && state.order.work_instruction_revision === expectedRevision
        && !validReceipt(state.order)
        && drawings.length > 0
        && drawings.every((row) => row.status === 'completed')
        && lasers.length === 1
        && lasers[0].status === 'waiting'
        && downstream.every((row) => row.status !== 'in_progress' && row.status !== 'completed');

      let updateRows = [];
      if (eligible) {
        state.order.work_instruction_received_revision = state.order.work_instruction_revision;
        state.order.work_instruction_received_at = now;
        state.order.work_instruction_received_by = actor;
        state.feed.push({
          order_id: ORDER_ID,
          action_type: '작업지시서수령',
          actor,
        });
        updateRows = [{ ...state.order, receipt_logged: true }];
      }
      return [
        { rows: locked },
        { rows: processRows },
        { rows: updateRows },
      ];
    },
  };
}

function dependencies(db, actor = '이정섭 부장') {
  return {
    db,
    rateLimitCheck: () => true,
    requireWorkerAction: () => ({ actor }),
  };
}

async function run(db, options = {}) {
  const res = response();
  const actor = options.actor || '이정섭 부장';
  await handleWorkInstructionReceipt(
    request({ actor, expectedRevision: options.expectedRevision ?? 0 }),
    res,
    dependencies(db, actor),
  );
  return res;
}

test('허용 수령자는 서버 시각과 현재 개정을 원자적으로 저장하고 활동 피드를 한 번 남긴다', async () => {
  const db = makeDb();
  const res = await run(db);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.idempotent, false);
  assert.equal(res.body.receipt_valid, true);
  assert.equal(db.state.order.work_instruction_received_revision, 0);
  assert.equal(db.state.order.work_instruction_received_at, '2026-10-07T03:04:05.000Z');
  assert.equal(db.state.order.work_instruction_received_by, '이정섭 부장');
  assert.deepEqual(db.state.feed, [{ order_id: ORDER_ID, action_type: '작업지시서수령', actor: '이정섭 부장' }]);
  assert.equal(db.state.atomicCalls.length, 1);
});

test('같은 개정의 중복 수령은 최초 수령자와 시간을 유지하고 피드를 중복 생성하지 않는다', async () => {
  const db = makeDb({
    order: {
      work_instruction_revision: 2,
      work_instruction_received_revision: 2,
      work_instruction_received_at: '2026-10-07T01:00:00.000Z',
      work_instruction_received_by: '이정섭 부장',
    },
  });
  const res = await run(db, { expectedRevision: 2 });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.idempotent, true);
  assert.equal(res.body.work_instruction_received_at, '2026-10-07T01:00:00.000Z');
  assert.equal(db.state.feed.length, 0);
});

test('비허용 작업자는 DB를 열기 전에 거부한다', async () => {
  const db = makeDb();
  const res = await run(db, { actor: '김보수 팀장' });

  assert.equal(res.statusCode, 403);
  assert.match(res.body.error.message, /수령 권한/);
  assert.equal(db.state.atomicCalls.length, 0);
});

test('예상 개정이 누락되거나 null이면 0으로 바꾸지 않고 DB 전에 거부한다', async () => {
  for (const invalidRevision of [null, undefined, '']) {
    const db = makeDb();
    const req = request();
    if (invalidRevision === undefined) delete req.body.expected_revision;
    else req.body.expected_revision = invalidRevision;
    const res = response();
    await handleWorkInstructionReceipt(req, res, dependencies(db));

    assert.equal(res.statusCode, 400);
    assert.match(res.body.error.message, /개정 번호/);
    assert.equal(db.state.atomicCalls.length, 0);
  }
});

test('수령 개정 NULL은 다른 수령 필드가 있어도 신규 수령 대상이다', async () => {
  const db = makeDb({
    order: {
      work_instruction_revision: 0,
      work_instruction_received_revision: null,
      work_instruction_received_at: '2026-10-07T01:00:00.000Z',
      work_instruction_received_by: '이정섭 부장',
    },
  });
  const res = await run(db);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.idempotent, false);
  assert.equal(res.body.receipt_valid, true);
  assert.equal(db.state.feed.length, 1);
});

test('오래된 화면의 예상 개정은 수령 정보를 쓰지 않고 409를 반환한다', async () => {
  const db = makeDb({ order: { work_instruction_revision: 3 } });
  const res = await run(db, { expectedRevision: 2 });

  assert.equal(res.statusCode, 409);
  assert.match(res.body.error.message, /도면이 변경/);
  assert.equal(db.state.order.work_instruction_received_at, null);
  assert.equal(db.state.feed.length, 0);
});

test('도면 누락·미완료, 레이저 중복, 이후 공정 진행은 각각 수령을 막는다', async () => {
  const cases = [
    {
      label: '도면 누락',
      processes: [{ id: 2, order_id: ORDER_ID, step_name: '레이저작업', status: 'waiting' }],
      message: /도면 공정/,
    },
    {
      label: '도면 미완료',
      processes: [
        { id: 1, order_id: ORDER_ID, step_name: '도면설계', status: 'in_progress' },
        { id: 2, order_id: ORDER_ID, step_name: '레이저작업', status: 'waiting' },
      ],
      message: /도면 공정/,
    },
    {
      label: '레이저 중복',
      processes: [
        { id: 1, order_id: ORDER_ID, step_name: '도면설계', status: 'completed' },
        { id: 2, order_id: ORDER_ID, step_name: '레이저작업', status: 'waiting' },
        { id: 4, order_id: ORDER_ID, step_name: '레이저작업', status: 'waiting' },
      ],
      message: /레이저 공정.*중복/,
    },
    {
      label: '이후 공정 진행',
      processes: [
        { id: 1, order_id: ORDER_ID, step_name: '도면설계', status: 'completed' },
        { id: 2, order_id: ORDER_ID, step_name: '레이저작업', status: 'waiting' },
        { id: 3, order_id: ORDER_ID, step_name: 'V-커팅작업', status: 'completed' },
      ],
      message: /이후 공정/,
    },
  ];

  for (const fixture of cases) {
    const db = makeDb({ processes: fixture.processes });
    const res = await run(db);
    assert.equal(res.statusCode, 409, fixture.label);
    assert.match(res.body.error.message, fixture.message, fixture.label);
    assert.equal(db.state.order.work_instruction_received_at, null, fixture.label);
    assert.equal(db.state.feed.length, 0, fixture.label);
  }
});
