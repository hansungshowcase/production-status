import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const directShippingUrl = new URL('../api/_lib/directShipping.js', import.meta.url);
const workerShipRouteUrl = new URL('../api/orders/[id]/worker-ship.js', import.meta.url);

function makeDb({
  order,
  processes,
  shippingJobs = [],
  shippingClaimSucceeds = true,
  atomicShippingMutationFails = false,
}) {
  const state = {
    order: order ? { ...order } : null,
    processes: processes.map((process) => ({ ...process })),
    activity: [],
    shippingJobs: shippingJobs.map((job) => ({ ...job })),
    schemaInstalled: false,
    statements: [],
  };
  let nextProcessId = 100;

  return {
    state,
    async execute({ sql, args }) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      state.statements.push(statement);
      if (statement.startsWith('CREATE TABLE IF NOT EXISTS sheet_shipping_sync_jobs')) {
        state.schemaInstalled = true;
        return { rows: [] };
      }
      if (statement === 'SELECT * FROM orders WHERE id = ?') {
        return { rows: state.order ? [state.order] : [] };
      }
      if (statement === 'SELECT id, step_name, status FROM processes WHERE order_id = ?') {
        return { rows: state.processes.filter((process) => String(process.order_id) === String(args[0])) };
      }
      if (statement.startsWith('WITH claimed_order AS')) {
        if (atomicShippingMutationFails) {
          throw new Error('atomic shipment mutation failed');
        }
        if (!shippingClaimSucceeds || state.order.status === 'shipped') {
          return { rows: [] };
        }
        const queuesShippingJob = statement.includes('INSERT INTO sheet_shipping_sync_jobs');
        if (queuesShippingJob && !state.schemaInstalled) {
          throw new Error('shipping schema must be installed before the shipment CTE');
        }
        if (queuesShippingJob && (
          !statement.includes("WHERE sheet_shipping_sync_jobs.status != 'synced'")
          || !statement.includes('sheet_shipping_sync_jobs.ship_date IS DISTINCT FROM EXCLUDED.ship_date')
        )) {
          throw new Error('shipping job conflict update must preserve a same-date synced job only');
        }
        const [today, orderId] = args;
        const processArgs = args.slice(queuesShippingJob ? 3 : 2);
        const [existingStartedAt, existingCompletedAt, existingCompletedDate, existingStartedBy, existingCompletedBy, insertedStartedAt, insertedCompletedAt, insertedCompletedDate, insertedStartedBy, insertedCompletedBy, activityActor] = processArgs;
        if (queuesShippingJob) {
          const queuedShipDate = args[2];
          const existingJob = state.shippingJobs.find((job) => String(job.order_id) === String(orderId));
          if (!existingJob) {
            state.shippingJobs.push({
              order_id: Number(orderId),
              ship_date: queuedShipDate,
              status: 'pending',
              attempts: 0,
              last_error: null,
              last_attempt_at: null,
              synced_at: null,
              sheet_row: null,
            });
          } else if (existingJob.status !== 'synced' || existingJob.ship_date !== queuedShipDate) {
            Object.assign(existingJob, {
              ship_date: queuedShipDate,
              status: 'pending',
              last_error: null,
              last_attempt_at: null,
              synced_at: null,
              sheet_row: null,
            });
          }
        }
        const shippingRows = state.processes.filter((process) => String(process.order_id) === String(orderId) && process.step_name === '출고');
        if (shippingRows.length === 0) {
          state.processes.push({
            id: nextProcessId++,
            order_id: orderId,
            step_name: '출고',
            status: 'completed',
            started_at: insertedStartedAt,
            completed_at: insertedCompletedAt,
            completed_date: insertedCompletedDate,
            started_by: insertedStartedBy,
            completed_by: insertedCompletedBy,
          });
        } else {
          shippingRows.forEach((process) => {
            process.status = 'completed';
            process.started_at ||= existingStartedAt;
            process.completed_at ||= existingCompletedAt;
            process.completed_date ||= existingCompletedDate;
            process.started_by ||= existingStartedBy;
            process.completed_by ||= existingCompletedBy;
          });
        }
        state.order.status = 'shipped';
        state.order.ship_date = today;
        state.activity.push({
          order_id: orderId,
          action_type: '출고완료',
          description: `${state.order.client_name} 주문이 출고 처리되었습니다.`,
          actor: activityActor,
        });
        return { rows: [state.order] };
      }
      if (statement.startsWith('INSERT INTO processes')) {
        state.processes.push({
          id: nextProcessId++,
          order_id: args[0],
          step_name: args[1],
          status: 'completed',
          started_at: args[2],
          completed_at: args[3],
          completed_date: args[4],
          started_by: args[5],
          completed_by: args[6],
        });
        return { rows: [] };
      }
      if (statement.startsWith('UPDATE processes')) {
        const processIds = args.slice(3).map(String);
        state.processes.forEach((process) => {
          if (processIds.includes(String(process.id)) && process.status !== 'completed') {
            process.status = 'completed';
            process.completed_at ||= args[0];
            process.completed_date ||= args[1];
            process.completed_by ||= args[2];
          }
        });
        return { rows: [] };
      }
      if (statement.includes("AND status != 'shipped' RETURNING *")) {
        if (!shippingClaimSucceeds || state.order.status === 'shipped') {
          return { rows: [] };
        }
        state.order.status = 'shipped';
        state.order.ship_date = args[0];
        return { rows: [state.order] };
      }
      if (statement.startsWith("UPDATE orders SET status = 'shipped'")) {
        state.order.status = 'shipped';
        state.order.ship_date = args[0];
        return { rows: [] };
      }
      if (statement.startsWith('INSERT INTO activity_feed')) {
        if (atomicShippingMutationFails) {
          throw new Error('atomic shipment mutation failed');
        }
        state.activity.push({
          order_id: args[0],
          action_type: args[1],
          description: args[2],
          actor: args[3],
        });
        return { rows: [] };
      }
      throw new Error(`Unhandled SQL in fake DB: ${statement}`);
    },
  };
}

async function loadCompleteOrderShipping(t) {
  assert.equal(existsSync(directShippingUrl), true, 'shared direct-shipping helper must exist');
  if (!existsSync(directShippingUrl)) return null;
  const module = await import(`${directShippingUrl.href}?cacheBust=${Date.now()}-${Math.random()}`);
  assert.equal(typeof module.completeOrderShipping, 'function', 'shared direct-shipping helper must be exported');
  if (typeof module.completeOrderShipping !== 'function') return null;
  return module.completeOrderShipping;
}

test('direct shipping creates only shipping, records the worker, ignores notification failure, and never calls the sheet in-request', async (t) => {
  const completeOrderShipping = await loadCompleteOrderShipping(t);
  if (!completeOrderShipping) return;
  const db = makeDb({
    order: { id: 41, client_name: '테스트 거래처', status: 'in_production' },
    processes: [{ id: 3, order_id: 41, step_name: '절곡', status: 'in_progress' }],
  });
  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;
  Date.now = () => Date.parse('2026-08-03T15:30:00.000Z');
  const syncCalls = [];
  let webhookCalls = 0;
  // 구글 시트 왕복이 3~4초라 출고 버튼이 그만큼 느려졌다. 이제 시트 기입은 크론만 한다.
  globalThis.fetch = async () => {
    webhookCalls += 1;
    throw new Error('출고 요청 경로에서 시트 웹훅을 부르면 안 된다');
  };

  let result;
  try {
    result = await completeOrderShipping({
      db,
      orderId: 41,
      actor: '작업자 A',
      notify: async () => { throw new Error('notification offline'); },
      // 즉시 동기화 주입 지점 자체가 사라졌다. 넘겨도 무시되어야 한다.
      syncShippingSheet: async (receivedDb, receivedOrder) => {
        syncCalls.push({ receivedDb, receivedOrder });
        return { status: 'synced', updatedRow: 41 };
      },
    });
  } finally {
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }

  assert.equal(result.status, 200);
  assert.equal(db.state.order.status, 'shipped');
  assert.equal(db.state.order.ship_date, '2026-08-04');
  assert.equal(db.state.processes.filter((process) => process.step_name === '출고').length, 1);
  assert.equal(db.state.processes.find((process) => process.step_name === '출고').status, 'completed');
  assert.equal(db.state.processes.find((process) => process.step_name === '절곡').status, 'in_progress');
  assert.equal(db.state.activity[0].action_type, '출고완료');
  assert.equal(db.state.activity[0].actor, '작업자 A');
  // 잡 적재는 주문 UPDATE 와 같은 CTE 안에서 그대로 일어나야 한다 — 크론이 이걸 보고 시트를 채운다.
  assert.deepEqual(db.state.shippingJobs.map(({ order_id, ship_date, status }) => ({ order_id, ship_date, status })), [
    { order_id: 41, ship_date: '2026-08-04', status: 'pending' },
  ]);
  assert.equal(syncCalls.length, 0, '출고 요청 안에서는 시트 동기화를 시도하지 않는다');
  assert.equal(webhookCalls, 0, '출고 요청 중 시트 웹훅 호출은 0회여야 한다');
  assert.ok(
    db.state.statements.findIndex((statement) => statement.startsWith('CREATE TABLE IF NOT EXISTS sheet_shipping_sync_jobs'))
      < db.state.statements.findIndex((statement) => statement.startsWith('WITH claimed_order AS')),
    'shipping schema must be installed before the atomic shipment CTE',
  );
});

test('direct shipping completes an existing shipping row without duplicating it', async (t) => {
  const completeOrderShipping = await loadCompleteOrderShipping(t);
  if (!completeOrderShipping) return;
  const db = makeDb({
    order: { id: 42, client_name: '테스트 거래처', status: 'in_production' },
    processes: [
      { id: 4, order_id: 42, step_name: '절곡', status: 'in_progress' },
      { id: 10, order_id: 42, step_name: '출고', status: 'waiting' },
    ],
  });

  const result = await completeOrderShipping({
    db,
    orderId: 42,
    actor: '작업자 B',
    notify: async () => {},
    syncShippingSheet: async () => ({ status: 'synced', updatedRow: 42 }),
  });

  assert.equal(result.status, 200);
  assert.equal(db.state.processes.filter((process) => process.step_name === '출고').length, 1);
  assert.equal(db.state.processes.find((process) => process.step_name === '출고').status, 'completed');
  assert.equal(db.state.processes.find((process) => process.step_name === '절곡').status, 'in_progress');
});

test('an already shipped order is not changed', async (t) => {
  const completeOrderShipping = await loadCompleteOrderShipping(t);
  if (!completeOrderShipping) return;
  const db = makeDb({
    order: { id: 43, client_name: '테스트 거래처', status: 'shipped', ship_date: '2026-08-03' },
    processes: [],
  });

  let syncCount = 0;
  const result = await completeOrderShipping({
    db,
    orderId: 43,
    actor: '작업자 A',
    notify: async () => {},
    syncShippingSheet: async () => { syncCount += 1; },
  });

  assert.equal(result.status, 400);
  assert.equal(db.state.order.ship_date, '2026-08-03');
  assert.deepEqual(db.state.activity, []);
  assert.deepEqual(db.state.shippingJobs, []);
  assert.equal(syncCount, 0);
});

test('direct shipping does not write a duplicate process, feed entry, or notification when another request claims shipment first', async (t) => {
  const completeOrderShipping = await loadCompleteOrderShipping(t);
  if (!completeOrderShipping) return;
  const db = makeDb({
    order: { id: 44, client_name: '테스트 거래처', status: 'in_production' },
    processes: [{ id: 5, order_id: 44, step_name: '절곡', status: 'in_progress' }],
    shippingClaimSucceeds: false,
  });
  let notificationCount = 0;
  let syncCount = 0;

  const result = await completeOrderShipping({
    db,
    orderId: 44,
    actor: '작업자 C',
    notify: async () => { notificationCount += 1; },
    syncShippingSheet: async () => { syncCount += 1; },
  });

  assert.equal(result.status, 400);
  assert.equal(db.state.order.status, 'in_production');
  assert.equal(db.state.processes.filter((process) => process.step_name === '출고').length, 0);
  assert.deepEqual(db.state.activity, []);
  assert.deepEqual(db.state.shippingJobs, []);
  assert.equal(notificationCount, 0);
  assert.equal(syncCount, 0);
});

test('direct shipping keeps a same-date synced job terminal without any in-request sync attempt', async (t) => {
  const completeOrderShipping = await loadCompleteOrderShipping(t);
  if (!completeOrderShipping) return;
  const originalDateNow = Date.now;
  Date.now = () => Date.parse('2026-08-03T15:30:00.000Z');
  const db = makeDb({
    order: { id: 46, client_name: '동일 날짜 거래처', status: 'in_production' },
    processes: [],
    shippingJobs: [{
      order_id: 46,
      ship_date: '2026-08-04',
      status: 'synced',
      attempts: 3,
      last_error: null,
      last_attempt_at: '2026-08-04T01:00:00.000Z',
      synced_at: '2026-08-04T01:00:01.000Z',
      sheet_row: 46,
    }],
  });
  let syncCount = 0;

  try {
    const result = await completeOrderShipping({
      db,
      orderId: 46,
      actor: '작업자 E',
      notify: async () => {},
      syncShippingSheet: async () => {
        syncCount += 1;
        return { status: 'pending', skipped: true };
      },
    });
    assert.equal(result.status, 200);
  } finally {
    Date.now = originalDateNow;
  }

  assert.equal(syncCount, 0, '이미 같은 날짜로 동기화된 잡에도 즉시 시도를 하지 않는다');
  assert.deepEqual(db.state.shippingJobs[0], {
    order_id: 46,
    ship_date: '2026-08-04',
    status: 'synced',
    attempts: 3,
    last_error: null,
    last_attempt_at: '2026-08-04T01:00:00.000Z',
    synced_at: '2026-08-04T01:00:01.000Z',
    sheet_row: 46,
  });
});

test('direct shipping reopens a different-date synced job without resetting its claim generation', async (t) => {
  const completeOrderShipping = await loadCompleteOrderShipping(t);
  if (!completeOrderShipping) return;
  const originalDateNow = Date.now;
  Date.now = () => Date.parse('2026-08-03T15:30:00.000Z');
  const db = makeDb({
    order: { id: 47, client_name: '재출고 거래처', status: 'in_production' },
    processes: [],
    shippingJobs: [{
      order_id: 47,
      ship_date: '2026-08-03',
      status: 'synced',
      attempts: 4,
      last_error: 'old error',
      last_attempt_at: '2026-08-03T01:00:00.000Z',
      synced_at: '2026-08-03T01:00:01.000Z',
      sheet_row: 47,
    }],
  });

  try {
    const result = await completeOrderShipping({
      db,
      orderId: 47,
      actor: '작업자 F',
      notify: async () => {},
      syncShippingSheet: async () => ({ status: 'pending', skipped: true }),
    });
    assert.equal(result.status, 200);
  } finally {
    Date.now = originalDateNow;
  }

  assert.deepEqual(db.state.shippingJobs[0], {
    order_id: 47,
    ship_date: '2026-08-04',
    status: 'pending',
    attempts: 4,
    last_error: null,
    last_attempt_at: null,
    synced_at: null,
    sheet_row: null,
  });
});

test('direct shipping returns 200 with a retryable queued job even when the sheet is unreachable', async (t) => {
  const completeOrderShipping = await loadCompleteOrderShipping(t);
  if (!completeOrderShipping) return;
  const db = makeDb({
    order: { id: 48, client_name: '실패 거래처', status: 'in_production' },
    processes: [],
  });
  const warnings = [];
  const originalWarn = console.warn;
  const originalDateNow = Date.now;
  const originalFetch = globalThis.fetch;
  Date.now = () => Date.parse('2026-08-03T15:30:00.000Z');
  console.warn = (...args) => warnings.push(args.join(' '));
  let syncCount = 0;
  let webhookCalls = 0;
  // 시트가 죽어 있어도 출고 요청은 시트를 부르지 않으므로 아예 영향을 받지 않아야 한다.
  globalThis.fetch = async () => {
    webhookCalls += 1;
    throw new Error('shipping webhook unavailable');
  };

  try {
    const result = await completeOrderShipping({
      db,
      orderId: 48,
      actor: '작업자 G',
      notify: async () => {},
      syncShippingSheet: async () => {
        syncCount += 1;
        return { status: 'pending', error: 'shipping webhook unavailable' };
      },
    });
    assert.equal(result.status, 200);
  } finally {
    console.warn = originalWarn;
    Date.now = originalDateNow;
    globalThis.fetch = originalFetch;
  }

  assert.equal(syncCount, 0, '출고 요청 안에서는 시트 동기화를 시도하지 않는다');
  assert.equal(webhookCalls, 0, '출고 요청 중 시트 웹훅 호출은 0회여야 한다');
  assert.equal(db.state.order.status, 'shipped');
  assert.equal(db.state.shippingJobs.length, 1);
  assert.deepEqual(db.state.shippingJobs[0], {
    order_id: 48,
    ship_date: '2026-08-04',
    status: 'pending',
    attempts: 0,
    last_error: null,
    last_attempt_at: null,
    synced_at: null,
    sheet_row: null,
  });
  // 시도 자체를 안 하므로 실패 경고도 없어야 한다(있으면 요청 경로가 아직 시트를 만지고 있다는 뜻).
  assert.equal(warnings.join('\n'), '', '출고 요청 경로는 시트 동기화 경고를 남기지 않는다');
});

test('direct shipping rolls back the order claim when its atomic shipment mutation fails', async (t) => {
  const completeOrderShipping = await loadCompleteOrderShipping(t);
  if (!completeOrderShipping) return;
  const db = makeDb({
    order: { id: 45, client_name: '테스트 거래처', status: 'in_production' },
    processes: [{ id: 6, order_id: 45, step_name: '절곡', status: 'in_progress' }],
    atomicShippingMutationFails: true,
  });
  let notificationCount = 0;
  let syncCount = 0;

  await assert.rejects(
    completeOrderShipping({
      db,
      orderId: 45,
      actor: '작업자 D',
      notify: async () => { notificationCount += 1; },
      syncShippingSheet: async () => { syncCount += 1; },
    }),
    /atomic shipment mutation failed/
  );

  assert.equal(db.state.order.status, 'in_production');
  assert.equal(db.state.processes.filter((process) => process.step_name === '출고').length, 0);
  assert.deepEqual(db.state.activity, []);
  assert.deepEqual(db.state.shippingJobs, []);
  assert.equal(notificationCount, 0);
  assert.equal(syncCount, 0);
});

test('the exact worker-station action area has separate worker shipping and normal completion controls', () => {
  assert.equal(existsSync(workerShipRouteUrl), true, 'worker shipping route must exist');
  if (!existsSync(workerShipRouteUrl)) return;
  const workerRoute = readFileSync(workerShipRouteUrl, 'utf8');
  const workerPage = readFileSync(new URL('../src/pages/WorkerStationViewPage.jsx', import.meta.url), 'utf8');
  const client = readFileSync(new URL('../src/api/orders.js', import.meta.url), 'utf8');
  const salesRoute = readFileSync(new URL('../api/orders/[id]/ship.js', import.meta.url), 'utf8');

  assert.match(workerRoute, /requireWorkerAction\s*\(/);
  assert.doesNotMatch(workerRoute, /requireAuth\s*\(/);
  assert.match(client, /export function shipOrderFromWorker\(id, actor\)/);
  assert.match(workerPage, /onClick=\{\(\) => requestDirectShip\(item\)\}/);
  assert.match(workerPage, /shipOrderFromWorker\(directShipTarget\.orderId, workerName\)/);
  assert.match(workerPage, /onClick=\{\(\) => requestComplete\(item\.process_id\)\}/);
  assert.match(workerPage, /setDirectShipTarget\(null\)/);
  assert.match(workerPage, /!directShipTarget/);
  const actionAreaStart = workerPage.indexOf('className="station-view__row-actions"');
  const workOrderIndex = workerPage.indexOf('station-view__row-btn--work-order', actionAreaStart);
  const directShipIndex = workerPage.indexOf('station-view__row-btn--direct-ship', actionAreaStart);
  const completeIndex = workerPage.indexOf('station-view__row-btn--complete', actionAreaStart);
  const undoIndex = workerPage.indexOf('station-view__row-btn--undo', actionAreaStart);
  assert.ok(
    actionAreaStart >= 0 && workOrderIndex < directShipIndex && directShipIndex < completeIndex && completeIndex < undoIndex,
    'worker action controls must be ordered as view/attach, direct ship, normal completion, then optional undo'
  );
  assert.match(salesRoute, /requireAuth\(req, res, \{ roles: \['sales'\] \}\)/);
  assert.match(salesRoute, /canShipFromSales\(actor\)/);
});
