import assert from 'node:assert/strict';
import test from 'node:test';

import { handleCompleteProcess } from '../api/processes/[id]/complete.js';

// ensureShippingProcessUniqueIndex 는 모듈 단위 캐시를 쓴다(성공 시에만 캐시).
// 그래서 이 파일의 테스트는 선언 순서대로 캐시 상태를 이어받는다:
//   1) 인덱스 생성 실패 → 캐시 안 됨
//   2) 인덱스 생성 성공 → 캐시됨
//   3) 두 번째 요청 → DDL 재실행 없음
//   4) 유니크 위반 → 500 아님
// node:test 는 한 파일의 top-level 테스트를 순차 실행하므로 순서가 보장된다.

const SHIPPING_INSERT_PREFIX = "INSERT INTO processes (order_id, step_name, status) SELECT ?, '출고'";
const INDEX_PREFIX = 'CREATE UNIQUE INDEX IF NOT EXISTS idx_processes_unique_shipping';

function makeDb({ indexFails = false, shippingInsertError = null } = {}) {
  const state = {
    process: {
      id: 41,
      order_id: 141,
      step_name: '포장',
      status: 'in_progress',
      completed_at: null,
      completed_date: null,
      completed_by: null,
    },
    order: { id: 141, client_name: '포장 거래처', status: 'in_production' },
    shippingRowsCreated: 0,
    activity: [],
    statements: [],
  };

  return {
    state,
    async execute({ sql, args }) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      state.statements.push(statement);

      if (statement.startsWith(INDEX_PREFIX)) {
        if (indexFails) {
          throw new Error('could not create unique index "idx_processes_unique_shipping"');
        }
        return { rows: [] };
      }
      if (statement === 'SELECT * FROM processes WHERE id = ?') {
        return { rows: [{ ...state.process }] };
      }
      if (statement.startsWith(SHIPPING_INSERT_PREFIX)) {
        if (shippingInsertError) throw shippingInsertError;
        state.shippingRowsCreated += 1;
        return { rows: [] };
      }
      if (statement === 'SELECT id FROM photos WHERE process_id = ? LIMIT 1') {
        return { rows: [{ id: 9 }] };
      }
      if (statement.startsWith("UPDATE processes SET status = 'completed'")) {
        if (state.process.status !== 'in_progress') return { rows: [] };
        state.process.status = 'completed';
        state.process.completed_at = args[0];
        state.process.completed_date = args[1];
        state.process.completed_by = args[2];
        return { rows: [{ id: state.process.id }] };
      }
      if (statement === 'SELECT * FROM orders WHERE id = ?') {
        return { rows: [{ ...state.order }] };
      }
      if (statement.startsWith('INSERT INTO activity_feed')) {
        state.activity.push({ order_id: args[0], action_type: args[1] });
        return { rows: [] };
      }

      throw new Error(`Unhandled SQL in shipping index fake DB: ${statement}`);
    },
  };
}

function makeRequest() {
  return {
    method: 'PATCH',
    query: { id: '41' },
    body: { actor: '포장 작업자' },
  };
}

function makeResponse() {
  return {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

function dependencies(db) {
  return {
    db,
    rateLimitCheck: () => true,
    requireWorkerAction: () => ({ actor: '포장 작업자' }),
    notify: async () => {},
  };
}

test('출고 중복 방지 인덱스 생성이 실패해도 포장 공정 완료는 계속된다', async () => {
  const db = makeDb({ indexFails: true });
  const res = makeResponse();
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));

  try {
    await handleCompleteProcess(makeRequest(), res, dependencies(db));
  } finally {
    console.warn = originalWarn;
  }

  assert.ok(
    db.state.statements.some((statement) => statement.startsWith(INDEX_PREFIX)),
    '출고 INSERT 전에 부분 유니크 인덱스 보장이 시도되어야 한다',
  );
  assert.equal(res.statusCode, 200);
  assert.equal(db.state.process.status, 'completed');
  assert.equal(db.state.shippingRowsCreated, 1);
  assert.match(warnings.join('\n'), /인덱스/);
});

test('출고 공정 INSERT 직전에 부분 유니크 인덱스를 보장한다', async () => {
  const db = makeDb();
  const res = makeResponse();

  await handleCompleteProcess(makeRequest(), res, dependencies(db));

  const indexAt = db.state.statements.findIndex((statement) => statement.startsWith(INDEX_PREFIX));
  const insertAt = db.state.statements.findIndex((statement) => statement.startsWith(SHIPPING_INSERT_PREFIX));
  assert.ok(indexAt >= 0, '유니크 인덱스 보장이 실제로 호출되어야 한다');
  assert.ok(insertAt >= 0);
  assert.ok(indexAt < insertAt, '인덱스 보장은 출고 INSERT 보다 먼저 실행되어야 한다');
  assert.equal(res.statusCode, 200);
  assert.equal(db.state.shippingRowsCreated, 1);
});

test('인덱스 보장은 모듈 캐시로 두 번째 요청에서 다시 실행되지 않는다', async () => {
  const db = makeDb();
  const res = makeResponse();

  await handleCompleteProcess(makeRequest(), res, dependencies(db));

  assert.equal(res.statusCode, 200);
  assert.equal(
    db.state.statements.filter((statement) => statement.startsWith(INDEX_PREFIX)).length,
    0,
    '이미 보장된 뒤에는 매 요청마다 DDL 왕복을 돌면 안 된다',
  );
  assert.equal(db.state.shippingRowsCreated, 1);
});

test('출고 공정 유니크 위반은 500 이 아니라 정상 흐름으로 수렴한다', async () => {
  const uniqueViolation = new Error(
    'duplicate key value violates unique constraint "idx_processes_unique_shipping"',
  );
  uniqueViolation.code = '23505';
  const db = makeDb({ shippingInsertError: uniqueViolation });
  const res = makeResponse();

  await handleCompleteProcess(makeRequest(), res, dependencies(db));

  assert.equal(res.statusCode, 200);
  assert.equal(db.state.process.status, 'completed');
  assert.equal(db.state.shippingRowsCreated, 0);
  assert.deepEqual(db.state.activity.map(({ action_type }) => action_type), ['공정완료']);
});

test('유니크 위반이 아닌 INSERT 오류는 삼키지 않고 그대로 드러낸다', async () => {
  const db = makeDb({ shippingInsertError: new Error('relation "processes" does not exist') });
  const res = makeResponse();

  await assert.rejects(
    handleCompleteProcess(makeRequest(), res, dependencies(db)),
    /relation "processes" does not exist/,
  );
  assert.equal(db.state.process.status, 'in_progress');
});

test('인덱스 보장 함수는 DDL 실패를 삼키고 예외를 올리지 않는다', async () => {
  const module = await import(`../api/_lib/ensureShippingProcess.js?cacheBust=${Date.now()}-${Math.random()}`);
  assert.equal(typeof module.ensureShippingProcessUniqueIndex, 'function');

  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  let calls = 0;
  const failingDb = {
    async execute() {
      calls += 1;
      throw new Error('duplicate key value violates unique constraint');
    },
  };

  try {
    await module.ensureShippingProcessUniqueIndex(failingDb);
    await module.ensureShippingProcessUniqueIndex(failingDb);
  } finally {
    console.warn = originalWarn;
  }

  assert.equal(calls, 2, '실패는 캐시하지 않아 원인이 정리되면 다시 시도한다');
  assert.equal(warnings.length, 2);
});
