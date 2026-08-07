import assert from 'node:assert/strict';
import test from 'node:test';

const revertProcessUrl = new URL('../api/processes/[id]/revert.js', import.meta.url);

const ORDER_ID = 80;
const PROCESS_ID = 880;

// complete.js:230 이 남기는 문구 (출고 공정 완료 경로에만 존재하는 마커)
const COMPLETE_ROUTE_DESCRIPTION = '한성거래처 주문이 출고 처리되었습니다. (출고 공정 완료)';
// directShipping.js:75 가 남기는 문구 (영업 ship / 작업자 worker-ship 공용, 마커 없음)
const DIRECT_SHIPPING_DESCRIPTION = '한성거래처 주문이 출고 처리되었습니다.';

function makeDb({
  stepName = '출고',
  processStatus = 'completed',
  completedAt = '2026-08-04T23:57:31.000Z',
  completedBy = '작업자 A',
  orderStatus = 'shipped',
  shipDate = '2026-08-05',
  laterProcesses = [],
  shippingJobs = [{ order_id: ORDER_ID, ship_date: '2026-08-05', status: 'pending' }],
  activity = [{
    order_id: ORDER_ID,
    action_type: '출고완료',
    description: DIRECT_SHIPPING_DESCRIPTION,
    actor: '작업자 A',
  }],
  processClaimSucceeds = true,
  deleteJobFails = false,
} = {}) {
  const state = {
    process: {
      id: PROCESS_ID,
      order_id: ORDER_ID,
      step_name: stepName,
      status: processStatus,
      started_at: '2026-08-04T23:50:00.000Z',
      started_by: completedBy,
      completed_at: completedAt,
      completed_date: null,
      completed_by: completedBy,
    },
    laterProcesses: laterProcesses.map((row) => ({ ...row })),
    order: {
      id: ORDER_ID,
      client_name: '한성거래처',
      status: orderStatus,
      ship_date: shipDate,
      order_date: '2026-08-01',
      due_date: '2026-08-10',
      sales_person: '김담당',
      phone: '010-1234-5678',
      product_type: '쇼케이스',
      width: 900,
      depth: 600,
      height: 1800,
      quantity: 2,
      color: '무광블랙',
    },
    activity: activity.map((row) => ({ ...row })),
    shippingJobs: shippingJobs.map((row) => ({ ...row })),
    markerQueries: 0,
    jobDeletes: 0,
    statements: [],
  };

  return {
    state,
    async execute({ sql, args }) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      state.statements.push(statement);

      if (statement === 'SELECT * FROM processes WHERE id = ?') {
        return { rows: [{ ...state.process }] };
      }
      if (statement === 'SELECT * FROM processes WHERE order_id = ?') {
        return { rows: [{ ...state.process }, ...state.laterProcesses] };
      }
      if (statement.startsWith("UPDATE processes SET status = 'in_progress'")) {
        if (!processClaimSucceeds || state.process.status !== 'completed') return { rows: [] };
        state.process.status = 'in_progress';
        state.process.completed_at = null;
        state.process.completed_by = null;
        state.process.completed_date = null;
        return { rows: [{ id: state.process.id }] };
      }
      if (statement.startsWith("UPDATE processes SET status = 'waiting'")) {
        if (!processClaimSucceeds || state.process.status !== 'in_progress') return { rows: [] };
        state.process.status = 'waiting';
        state.process.started_at = null;
        state.process.started_by = null;
        state.process.completed_at = null;
        return { rows: [{ id: state.process.id }] };
      }
      // 되돌리기가 활동로그 문구에 기대던 옛 경로. 실제 LIKE 조건까지 그대로 흉내낸다.
      if (statement.startsWith('SELECT id FROM activity_feed')) {
        state.markerQueries += 1;
        const [orderId, actor] = args;
        const rows = state.activity.filter((row) => (
          String(row.order_id) === String(orderId)
          && row.action_type === '출고완료'
          && row.actor === actor
          && row.description.includes('출고 공정 완료')
        ));
        return { rows: rows.map((_, index) => ({ id: index + 1 })) };
      }
      if (statement.startsWith("UPDATE orders SET status = 'in_production'")) {
        const [orderId, completedDate] = args;
        if (String(state.order.id) !== String(orderId)) return { rows: [] };
        if (state.order.status !== 'shipped') return { rows: [] };
        if (completedDate != null && state.order.ship_date !== completedDate) return { rows: [] };
        state.order.status = 'in_production';
        state.order.ship_date = null;
        return { rows: [{ id: state.order.id }] };
      }
      if (statement === 'SELECT * FROM orders WHERE id = ?') {
        return { rows: [{ ...state.order }] };
      }
      if (statement.startsWith('INSERT INTO activity_feed')) {
        state.activity.push({
          order_id: args[0],
          action_type: args[1],
          description: args[2],
          actor: args[3],
        });
        return { rows: [] };
      }
      if (statement.startsWith('DELETE FROM sheet_shipping_sync_jobs')) {
        state.jobDeletes += 1;
        if (deleteJobFails) {
          throw new Error('relation "sheet_shipping_sync_jobs" does not exist');
        }
        state.shippingJobs = state.shippingJobs.filter(
          (job) => String(job.order_id) !== String(args[0]),
        );
        return { rows: [] };
      }
      throw new Error(`Unhandled SQL in revert fake DB: ${statement}`);
    },
  };
}

function makeRequest() {
  return {
    method: 'PATCH',
    query: { id: String(PROCESS_ID) },
    body: { actor: '작업자 A' },
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
    json(body) {
      this.body = body;
      return this;
    },
  };
}

async function loadHandleRevertProcess() {
  const module = await import(`${revertProcessUrl.href}?cacheBust=${Date.now()}-${Math.random()}`);
  assert.equal(
    typeof module.handleRevertProcess,
    'function',
    'revert route must export its dependency-injectable handler for behavior verification',
  );
  if (typeof module.handleRevertProcess !== 'function') return null;
  return module.handleRevertProcess;
}

function dependencies(db, { clearShippedSheet } = {}) {
  return {
    db,
    rateLimitCheck: () => true,
    requireWorkerAction: () => ({ actor: '작업자 A' }),
    clearShippedSheet: clearShippedSheet || (async () => ({ updatedRow: 6 })),
  };
}

async function runRevert(db, options = {}) {
  const handleRevertProcess = await loadHandleRevertProcess();
  if (!handleRevertProcess) return null;
  const res = makeResponse();
  const originalDateNow = Date.now;
  const originalWarn = console.warn;
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  Date.now = () => Date.parse(options.now || '2026-08-05T00:10:00.000Z');
  try {
    await handleRevertProcess(makeRequest(), res, dependencies(db, options));
  } finally {
    Date.now = originalDateNow;
    console.warn = originalWarn;
  }
  return { res, warnings };
}

// ── 결함 1: KST/UTC 어긋남 ─────────────────────────────────────────

test('a KST 08:57 shipment stored as UTC 23:57 the previous day still reverts its order', async () => {
  // 실측 주문 80: ship_date '2026-08-05'(KST), completed_at '2026-08-04T23:57:31Z'(UTC).
  const db = makeDb({ completedAt: '2026-08-04T23:57:31.000Z', shipDate: '2026-08-05' });

  const run = await runRevert(db);
  if (!run) return;

  assert.equal(run.res.statusCode, 200);
  assert.equal(db.state.process.status, 'in_progress');
  assert.equal(db.state.order.status, 'in_production', '주문이 실제로 되돌아가야 한다');
  assert.equal(db.state.order.ship_date, null);
});

test('every KST 00:00~09:00 shipment hour reverts its order, not just the safe afternoon hours', async () => {
  const cases = [
    ['2026-08-04T15:00:00.000Z', '2026-08-05'], // KST 2026-08-05 00:00
    ['2026-08-04T18:30:00.000Z', '2026-08-05'], // KST 2026-08-05 03:30
    ['2026-08-04T23:59:59.000Z', '2026-08-05'], // KST 2026-08-05 08:59
    ['2026-08-05T00:00:00.000Z', '2026-08-05'], // KST 2026-08-05 09:00
    ['2026-08-05T05:00:00.000Z', '2026-08-05'], // KST 2026-08-05 14:00
  ];

  for (const [completedAt, shipDate] of cases) {
    const db = makeDb({ completedAt, shipDate });
    const run = await runRevert(db, { now: '2026-08-05T06:00:00.000Z' });
    if (!run) return;

    assert.equal(run.res.statusCode, 200, completedAt);
    assert.equal(db.state.order.status, 'in_production', `${completedAt} 은 되돌아가야 한다`);
    assert.equal(db.state.order.ship_date, null, completedAt);
  }
});

test('a shipment date that does not belong to this process is left alone', async () => {
  // 이 공정 완료(KST 2026-08-05)와 다른 날짜로 shipped 된 주문은 건드리지 않는다.
  const db = makeDb({ completedAt: '2026-08-04T23:57:31.000Z', shipDate: '2026-07-20' });

  const run = await runRevert(db);
  if (!run) return;

  assert.equal(run.res.statusCode, 200);
  assert.equal(db.state.process.status, 'in_progress');
  assert.equal(db.state.order.status, 'shipped');
  assert.equal(db.state.order.ship_date, '2026-07-20');
  assert.deepEqual(db.state.shippingJobs, [
    { order_id: ORDER_ID, ship_date: '2026-08-05', status: 'pending' },
  ]);
});

// ── 결함 2: 활동로그 문구 의존 제거 ────────────────────────────────

test('an order shipped through directShipping reverts even though it left no 출고 공정 완료 marker', async () => {
  const db = makeDb({
    activity: [{
      order_id: ORDER_ID,
      action_type: '출고완료',
      description: DIRECT_SHIPPING_DESCRIPTION,
      actor: '작업자 A',
    }],
  });

  const run = await runRevert(db);
  if (!run) return;

  assert.equal(run.res.statusCode, 200);
  assert.equal(db.state.order.status, 'in_production');
  assert.equal(db.state.order.ship_date, null);
});

test('reverting never reads the activity log to decide whether the order ships back', async () => {
  const db = makeDb({ activity: [] });

  const run = await runRevert(db);
  if (!run) return;

  assert.equal(run.res.statusCode, 200);
  assert.equal(db.state.order.status, 'in_production');
  assert.equal(db.state.markerQueries, 0, '되돌리기는 활동로그 문구에 기대면 안 된다');
  assert.ok(
    db.state.statements.every((statement) => !statement.includes('출고 공정 완료')),
    '활동로그 문구를 SQL 조건으로 쓰면 안 된다',
  );
});

test('an order shipped through the 출고 공정 완료 route still reverts', async () => {
  const db = makeDb({
    activity: [{
      order_id: ORDER_ID,
      action_type: '출고완료',
      description: COMPLETE_ROUTE_DESCRIPTION,
      actor: '작업자 A',
    }],
  });

  const run = await runRevert(db);
  if (!run) return;

  assert.equal(run.res.statusCode, 200);
  assert.equal(db.state.order.status, 'in_production');
  assert.equal(db.state.order.ship_date, null);
});

test('an order shipped by a different actor than the reverting worker still reverts', async () => {
  const db = makeDb({
    completedBy: '영업 담당',
    activity: [{
      order_id: ORDER_ID,
      action_type: '출고완료',
      description: DIRECT_SHIPPING_DESCRIPTION,
      actor: '영업 담당',
    }],
  });

  const run = await runRevert(db);
  if (!run) return;

  assert.equal(run.res.statusCode, 200);
  assert.equal(db.state.order.status, 'in_production');
});

test('the revert activity log wording is unchanged', async () => {
  const db = makeDb({ activity: [] });

  const run = await runRevert(db);
  if (!run) return;

  assert.deepEqual(db.state.activity, [{
    order_id: ORDER_ID,
    action_type: '공정되돌리기',
    description: '한성거래처 - 출고 공정이 되돌려졌습니다.',
    actor: '작업자 A',
  }]);
});

// ── 기존 가드 유지 ────────────────────────────────────────────────

test('the 3 day undo window still blocks a stale revert without touching the order', async () => {
  const db = makeDb({ completedAt: '2026-08-01T00:00:00.000Z', shipDate: '2026-08-01' });

  const run = await runRevert(db, { now: '2026-08-05T00:10:00.000Z' });
  if (!run) return;

  assert.equal(run.res.statusCode, 400);
  assert.match(run.res.body.error.message, /3일/);
  assert.equal(db.state.process.status, 'completed');
  assert.equal(db.state.order.status, 'shipped');
  assert.equal(db.state.jobDeletes, 0);
  assert.deepEqual(db.state.shippingJobs, [
    { order_id: ORDER_ID, ship_date: '2026-08-05', status: 'pending' },
  ]);
});

test('a waiting process is still rejected and a lost claim still returns 409', async () => {
  const waiting = makeDb({ processStatus: 'waiting' });
  const waitingRun = await runRevert(waiting);
  if (!waitingRun) return;
  assert.equal(waitingRun.res.statusCode, 400);
  assert.equal(waiting.state.order.status, 'shipped');

  const lost = makeDb({ processClaimSucceeds: false });
  const lostRun = await runRevert(lost);
  assert.equal(lostRun.res.statusCode, 409);
  assert.equal(lost.state.order.status, 'shipped');
  assert.equal(lost.state.jobDeletes, 0);
});

test('a later started step still blocks the revert', async () => {
  const db = makeDb({
    stepName: '포장',
    laterProcesses: [{ id: 881, order_id: ORDER_ID, step_name: '출고', status: 'completed' }],
  });

  const run = await runRevert(db);
  if (!run) return;

  assert.equal(run.res.statusCode, 400);
  assert.match(run.res.body.error.message, /이후 공정/);
  assert.equal(db.state.order.status, 'shipped');
});

test('reverting a non shipping step never touches the order, its job, or the sheet', async () => {
  const db = makeDb({ stepName: '포장', orderStatus: 'in_production', shipDate: null });
  let clearCalls = 0;

  const run = await runRevert(db, { clearShippedSheet: async () => { clearCalls += 1; } });
  if (!run) return;

  assert.equal(run.res.statusCode, 200);
  assert.equal(db.state.process.status, 'in_progress');
  assert.equal(db.state.order.status, 'in_production');
  assert.equal(db.state.jobDeletes, 0);
  assert.equal(clearCalls, 0);
});

// ── 결함 3-A: 대기 중인 시트 동기화 잡 정리 ───────────────────────

test('a real order revert deletes the pending sheet sync job so no cron writes 출고완료 later', async () => {
  const db = makeDb();

  const run = await runRevert(db);
  if (!run) return;

  assert.equal(run.res.statusCode, 200);
  assert.equal(db.state.order.status, 'in_production');
  assert.equal(db.state.jobDeletes, 1);
  assert.deepEqual(db.state.shippingJobs, [], '되돌린 주문의 잡은 남아 있으면 안 된다');
});

test('a synced sheet sync job is deleted too', async () => {
  const db = makeDb({
    shippingJobs: [{ order_id: ORDER_ID, ship_date: '2026-08-05', status: 'synced' }],
  });

  const run = await runRevert(db);
  if (!run) return;

  assert.equal(run.res.statusCode, 200);
  assert.deepEqual(db.state.shippingJobs, []);
});

test('a job delete failure keeps the revert a 200 success', async () => {
  const db = makeDb({ deleteJobFails: true });

  const run = await runRevert(db);
  if (!run) return;

  assert.equal(run.res.statusCode, 200);
  assert.equal(run.res.body.id, PROCESS_ID);
  assert.equal(db.state.process.status, 'in_progress');
  assert.equal(db.state.order.status, 'in_production');
  assert.equal(db.state.jobDeletes, 1);
});

test('a revert that changes no order status deletes no job at all', async () => {
  const db = makeDb({ shipDate: '2026-07-20' });

  const run = await runRevert(db);
  if (!run) return;

  assert.equal(run.res.statusCode, 200);
  assert.equal(db.state.jobDeletes, 0);
  assert.equal(db.state.shippingJobs.length, 1);
});

// ── 결함 3-B: 시트 출고완료 표시 제거 ─────────────────────────────

test('a real order revert asks the sheet to clear the exact shipping value it wrote', async () => {
  const db = makeDb({ completedAt: '2026-08-04T23:57:31.000Z', shipDate: '2026-08-05' });
  const clearCalls = [];

  const run = await runRevert(db, {
    clearShippedSheet: async (order, shipDate) => {
      clearCalls.push({ order, shipDate });
      return { updatedRow: 6 };
    },
  });
  if (!run) return;

  assert.equal(run.res.statusCode, 200);
  assert.equal(clearCalls.length, 1);
  assert.equal(clearCalls[0].order.id, ORDER_ID);
  assert.equal(clearCalls[0].order.client_name, '한성거래처');
  assert.equal(clearCalls[0].shipDate, '2026-08-05', '시트에 적힌 KST 날짜를 지워야 한다');
});

test('the sheet clear runs only after the sync job is gone', async () => {
  const db = makeDb();
  let deletesAtClearTime = null;

  const run = await runRevert(db, {
    clearShippedSheet: async () => {
      deletesAtClearTime = db.state.jobDeletes;
      return { updatedRow: 6 };
    },
  });
  if (!run) return;

  assert.equal(run.res.statusCode, 200);
  assert.equal(deletesAtClearTime, 1, '크론이 다시 쓰지 못하도록 잡부터 지운 뒤 시트를 정리해야 한다');
});

test('a sheet clear failure keeps the revert a 200 success and warns', async () => {
  const db = makeDb();

  const run = await runRevert(db, {
    clearShippedSheet: async () => { throw new Error('shipping clear webhook unavailable'); },
  });
  if (!run) return;

  assert.equal(run.res.statusCode, 200);
  assert.equal(run.res.body.id, PROCESS_ID);
  assert.equal(db.state.process.status, 'in_progress');
  assert.equal(db.state.order.status, 'in_production');
  assert.deepEqual(db.state.shippingJobs, []);
  assert.match(run.warnings.join('\n'), /shipping clear webhook unavailable/);
});

test('an order whose status did not change never asks the sheet to clear anything', async () => {
  const db = makeDb({ shipDate: '2026-07-20' });
  let clearCalls = 0;

  const run = await runRevert(db, { clearShippedSheet: async () => { clearCalls += 1; } });
  if (!run) return;

  assert.equal(run.res.statusCode, 200);
  assert.equal(clearCalls, 0);
});
