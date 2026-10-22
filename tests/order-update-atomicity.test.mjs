import assert from 'node:assert/strict';
import test from 'node:test';

import { handleUpdate } from '../api/orders/[id]/index.js';

function response() {
  return {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
}

function orderDb({ atomicRows, atomicError = null } = {}) {
  const state = {
    order: {
      id: 41,
      client_name: '주문 수정 거래처',
      sale_amount: 100,
      ship_scheduled_date: '2026-10-25',
      status: 'in_production',
      work_order_image_url: null,
    },
    batches: [],
    writesOutsideAtomic: 0,
    dbCalls: 0,
  };
  return {
    state,
    async execute({ sql, args }) {
      state.dbCalls += 1;
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      if (/^(?:INSERT|UPDATE|DELETE)\b/i.test(statement)) state.writesOutsideAtomic += 1;
      if (statement === 'SELECT * FROM orders WHERE id = ?') return { rows: [{ ...state.order }] };
      if (statement.startsWith('UPDATE orders SET')) {
        state.order.ship_scheduled_date = args[0];
        return { rows: [{ ...state.order }] };
      }
      if (statement.startsWith('INSERT INTO activity_feed')) throw new Error('audit insert failed');
      throw new Error(`Unexpected order update SQL: ${statement}`);
    },
    async atomicBatch(queries) {
      state.batches.push(queries);
      assert.equal(queries.length, 1);
      assert.match(queries[0].sql, /^WITH locked_order AS/i);
      assert.match(queries[0].sql, /FOR UPDATE/i);
      assert.match(queries[0].sql, /UPDATE orders o/i);
      assert.match(queries[0].sql, /INSERT INTO activity_feed/i);
      assert.match(queries[0].sql, /FROM updated_order/i);
      if (atomicError) throw atomicError;
      return [{ rows: atomicRows || [] }];
    },
  };
}

function dependencies(db, external) {
  return {
    db,
    requireAuth: () => ({ role: 'sales', actor: '영업 담당자' }),
    ensureOrderImageColumn: async () => {},
    notify: async (_db, order, milestone, extra) => external.push({ order, milestone, extra }),
  };
}

test('주문 PATCH는 UPDATE와 감사를 한 guarded CTE로 커밋한 뒤 rescheduled 알림을 호출한다', async () => {
  const updated = {
    id: 41,
    client_name: '주문 수정 거래처',
    sale_amount: 100,
    ship_scheduled_date: '2026-11-01',
    status: 'in_production',
    work_order_image_url: null,
  };
  const db = orderDb({ atomicRows: [{ order_row: updated }] });
  const external = [];
  const res = response();

  await handleUpdate('41', {
    body: { ship_scheduled_date: '2026-11-01', actor: '영업 담당자' },
  }, res, dependencies(db, external));

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, updated);
  assert.equal(db.state.batches.length, 1);
  assert.equal(db.state.writesOutsideAtomic, 0);
  const mutation = db.state.batches[0][0];
  assert.match(mutation.sql, /notify_state = COALESCE\(locked\.notify_state/i);
  assert.match(mutation.sql, /jsonb_exists\(COALESCE\(locked\.notify_state/i);
  assert.ok(mutation.args.includes('rescheduled:2026-11-01'));
  const queued = mutation.args.map(value => {
    try { return JSON.parse(value); } catch { return null; }
  }).find(value => value?.status === 'queued');
  assert.match(queued.at, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(queued.queued_at, undefined);
  assert.equal(external.length, 1);
  assert.equal(external[0].milestone, 'rescheduled');
  assert.deepEqual(external[0].extra, { date: '2026-11-01' });
});

test('주문 PATCH의 rescheduled 알림 실패는 200과 커밋된 intent를 보존한다', async () => {
  const updated = {
    ...orderDb().state.order,
    ship_scheduled_date: '2026-11-02',
  };
  const db = orderDb({ atomicRows: [{ order_row: updated }] });
  const res = response();

  await handleUpdate('41', {
    body: { ship_scheduled_date: '2026-11-02', actor: '영업 담당자' },
  }, res, {
    ...dependencies(db, []),
    notify: async () => { throw new Error('simulated notify claim failure'); },
  });

  assert.equal(res.statusCode, 200);
  assert.ok(db.state.batches[0][0].args.includes('rescheduled:2026-11-02'));
});

test('동일 일정 재저장은 rescheduled intent와 hook을 활성화하지 않는다', async () => {
  const unchanged = { ...orderDb().state.order };
  const db = orderDb({ atomicRows: [{ order_row: unchanged }] });
  const external = [];

  await handleUpdate('41', {
    body: { ship_scheduled_date: '2026-10-25', actor: '영업 담당자' },
  }, response(), dependencies(db, external));

  const args = db.state.batches[0][0].args;
  assert.equal(args.includes('rescheduled:2026-10-25'), false);
  assert.deepEqual(external, []);
});

test('주문 PATCH 감사 실패는 값을 rollback하고 알림을 호출하지 않는다', async () => {
  const db = orderDb({ atomicError: new Error('audit insert failed') });
  const external = [];

  await assert.rejects(
    handleUpdate('41', {
      body: { ship_scheduled_date: '2026-11-01', actor: '영업 담당자' },
    }, response(), dependencies(db, external)),
    /audit insert failed/,
  );

  assert.equal(db.state.order.ship_scheduled_date, '2026-10-25');
  assert.equal(db.state.writesOutsideAtomic, 0);
  assert.deepEqual(external, []);
});

test('주문 PATCH CAS 0행은 감사와 알림 없이 기존 409를 반환한다', async () => {
  const db = orderDb({ atomicRows: [] });
  const external = [];
  const res = response();

  await handleUpdate('41', {
    body: { ship_scheduled_date: '2026-11-01', actor: '영업 담당자' },
  }, res, dependencies(db, external));

  assert.equal(res.statusCode, 409);
  assert.equal(db.state.batches.length, 1);
  assert.deepEqual(external, []);
});

test('주문 PATCH 감사 설명은 숫자 표기만 바뀐 필드를 변경으로 기록하지 않는다', async () => {
  const updated = { ...orderDb().state.order, sale_amount: 100 };
  const db = orderDb({ atomicRows: [{ order_row: updated }] });

  await handleUpdate('41', {
    body: { sale_amount: '100.00', actor: '영업 담당자' },
  }, response(), dependencies(db, []));

  const args = db.state.batches[0][0].args;
  assert.ok(args.includes('주문 수정 거래처 주문이 수정되었습니다.'));
  assert.ok(!args.some(value => typeof value === 'string' && value.includes('판매금액')));
});

test('주문 PATCH는 잘못된 int4 ID를 DB 접근 전에 400으로 거절한다', async () => {
  for (const id of ['1.5', '2147483648']) {
    const db = orderDb();
    const res = response();

    await handleUpdate(id, { body: { client_name: '변경' } }, res, dependencies(db, []));

    assert.equal(res.statusCode, 400);
    assert.equal(db.state.dbCalls, 0);
    assert.equal(db.state.batches.length, 0);
  }
});
