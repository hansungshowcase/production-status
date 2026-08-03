import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';

const directShippingUrl = new URL('../api/_lib/directShipping.js', import.meta.url);
const workerShipRouteUrl = new URL('../api/orders/[id]/worker-ship.js', import.meta.url);

function makeDb({ order, processes, shippingClaimSucceeds = true, atomicShippingMutationFails = false }) {
  const state = {
    order: order ? { ...order } : null,
    processes: processes.map((process) => ({ ...process })),
    activity: [],
  };
  let nextProcessId = 100;

  return {
    state,
    async execute({ sql, args }) {
      const statement = sql.replace(/\s+/g, ' ').trim();
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
        const [today, orderId, existingStartedAt, existingCompletedAt, existingCompletedDate, existingStartedBy, existingCompletedBy, insertedStartedAt, insertedCompletedAt, insertedCompletedDate, insertedStartedBy, insertedCompletedBy, activityActor] = args;
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

test('direct shipping creates only shipping, records the worker, and ignores notification failure', async (t) => {
  const completeOrderShipping = await loadCompleteOrderShipping(t);
  if (!completeOrderShipping) return;
  const db = makeDb({
    order: { id: 41, client_name: '테스트 거래처', status: 'in_production' },
    processes: [{ id: 3, order_id: 41, step_name: '절곡', status: 'in_progress' }],
  });

  const result = await completeOrderShipping({
    db,
    orderId: 41,
    actor: '작업자 A',
    notify: async () => { throw new Error('notification offline'); },
  });

  assert.equal(result.status, 200);
  assert.equal(db.state.order.status, 'shipped');
  assert.equal(db.state.order.ship_date, new Date().toISOString().slice(0, 10));
  assert.equal(db.state.processes.filter((process) => process.step_name === '출고').length, 1);
  assert.equal(db.state.processes.find((process) => process.step_name === '출고').status, 'completed');
  assert.equal(db.state.processes.find((process) => process.step_name === '절곡').status, 'in_progress');
  assert.equal(db.state.activity[0].action_type, '출고완료');
  assert.equal(db.state.activity[0].actor, '작업자 A');
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

  const result = await completeOrderShipping({ db, orderId: 42, actor: '작업자 B', notify: async () => {} });

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

  const result = await completeOrderShipping({ db, orderId: 43, actor: '작업자 A', notify: async () => {} });

  assert.equal(result.status, 400);
  assert.equal(db.state.order.ship_date, '2026-08-03');
  assert.deepEqual(db.state.activity, []);
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

  const result = await completeOrderShipping({
    db,
    orderId: 44,
    actor: '작업자 C',
    notify: async () => { notificationCount += 1; },
  });

  assert.equal(result.status, 400);
  assert.equal(db.state.order.status, 'in_production');
  assert.equal(db.state.processes.filter((process) => process.step_name === '출고').length, 0);
  assert.deepEqual(db.state.activity, []);
  assert.equal(notificationCount, 0);
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

  await assert.rejects(
    completeOrderShipping({
      db,
      orderId: 45,
      actor: '작업자 D',
      notify: async () => { notificationCount += 1; },
    }),
    /atomic shipment mutation failed/
  );

  assert.equal(db.state.order.status, 'in_production');
  assert.equal(db.state.processes.filter((process) => process.step_name === '출고').length, 0);
  assert.deepEqual(db.state.activity, []);
  assert.equal(notificationCount, 0);
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
  assert.match(salesRoute, /requireAuth\(req, res, \{ roles: \['sales'\] \}\)/);
  assert.match(salesRoute, /canShipFromSales\(actor\)/);
});
