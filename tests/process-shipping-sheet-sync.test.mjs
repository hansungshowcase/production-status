import assert from 'node:assert/strict';
import test from 'node:test';

const completeProcessUrl = new URL('../api/processes/[id]/complete.js', import.meta.url);

function makeDb({
  stepName = '출고',
  orderStatus = 'in_production',
  processClaimSucceeds = true,
  shippingClaimSucceeds = true,
  schemaFails = false,
} = {}) {
  const state = {
    process: {
      id: 73,
      order_id: 173,
      step_name: stepName,
      status: 'in_progress',
      completed_at: null,
      completed_date: null,
      completed_by: null,
    },
    order: {
      id: 173,
      client_name: '공정 출고 거래처',
      status: orderStatus,
      ship_date: orderStatus === 'shipped' ? '2026-08-03' : null,
    },
    activity: [],
    shippingJobs: [],
    schemaInstalled: false,
    statements: [],
  };

  return {
    state,
    async execute({ sql, args }) {
      const statement = sql.replace(/\s+/g, ' ').trim();
      state.statements.push(statement);

      if (statement.startsWith('CREATE TABLE IF NOT EXISTS sheet_shipping_sync_jobs')) {
        if (schemaFails) throw new Error('shipping schema installation failed');
        state.schemaInstalled = true;
        return { rows: [] };
      }
      if (statement === 'SELECT * FROM processes WHERE id = ?') {
        return { rows: [{ ...state.process }] };
      }
      if (statement.startsWith("UPDATE processes SET status = 'completed'")) {
        if (!processClaimSucceeds || state.process.status !== 'in_progress') return { rows: [] };
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
        state.activity.push({
          order_id: args[0],
          action_type: args[1],
          description: args[2],
          actor: args[3],
        });
        return { rows: [] };
      }
      if (statement.startsWith('WITH claimed_order AS')) {
        if (!state.schemaInstalled) {
          throw new Error('shipping schema must be installed before the shipment CTE');
        }
        if (!statement.includes('INSERT INTO sheet_shipping_sync_jobs')) {
          throw new Error('winning final shipment claim must queue a shipping Sheet job in the same CTE');
        }
        if (
          !statement.includes("WHERE sheet_shipping_sync_jobs.status != 'synced'")
          || !statement.includes('sheet_shipping_sync_jobs.ship_date IS DISTINCT FROM EXCLUDED.ship_date')
        ) {
          throw new Error('final shipping conflict update must preserve a same-date synced job only');
        }
        if (!shippingClaimSucceeds || state.order.status === 'shipped') return { rows: [] };
        const [shipDate, orderId, queuedShipDate] = args;
        state.order.status = 'shipped';
        state.order.ship_date = shipDate;
        state.shippingJobs.push({
          order_id: Number(orderId),
          ship_date: queuedShipDate,
          status: 'pending',
          attempts: 0,
        });
        return { rows: [{ ...state.order }] };
      }
      throw new Error(`Unhandled SQL in process fake DB: ${statement}`);
    },
  };
}

function makeRequest() {
  return {
    method: 'PATCH',
    query: { id: '73' },
    body: { actor: '공정 작업자' },
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

async function loadHandleCompleteProcess(t) {
  const module = await import(`${completeProcessUrl.href}?cacheBust=${Date.now()}-${Math.random()}`);
  assert.equal(
    typeof module.handleCompleteProcess,
    'function',
    'complete process route must export its dependency-injectable handler for behavior verification',
  );
  if (typeof module.handleCompleteProcess !== 'function') return null;
  return module.handleCompleteProcess;
}

function dependencies(db, { notify, syncShippingSheet } = {}) {
  return {
    db,
    rateLimitCheck: () => true,
    requireWorkerAction: () => ({ actor: '공정 작업자' }),
    notify: notify || (async () => {}),
    syncShippingSheet: syncShippingSheet || (async () => ({ status: 'synced', updatedRow: 173 })),
  };
}

test('final shipping completion atomically queues the KST date and attempts one immediate sync', async (t) => {
  const handleCompleteProcess = await loadHandleCompleteProcess(t);
  if (!handleCompleteProcess) return;
  const db = makeDb();
  const res = makeResponse();
  const originalDateNow = Date.now;
  Date.now = () => Date.parse('2026-08-03T15:30:00.000Z');
  const syncCalls = [];
  let notificationCount = 0;

  try {
    await handleCompleteProcess(makeRequest(), res, dependencies(db, {
      notify: async () => { notificationCount += 1; },
      syncShippingSheet: async (receivedDb, receivedOrder) => {
        syncCalls.push({ receivedDb, receivedOrder });
        return { status: 'synced', updatedRow: 173 };
      },
    }));
  } finally {
    Date.now = originalDateNow;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(db.state.process.status, 'completed');
  assert.equal(db.state.order.status, 'shipped');
  assert.equal(db.state.order.ship_date, '2026-08-04');
  assert.deepEqual(db.state.shippingJobs, [{
    order_id: 173,
    ship_date: '2026-08-04',
    status: 'pending',
    attempts: 0,
  }]);
  assert.equal(syncCalls.length, 1);
  assert.equal(syncCalls[0].receivedDb, db);
  assert.equal(syncCalls[0].receivedOrder.ship_date, '2026-08-04');
  assert.equal(notificationCount, 1);
  assert.deepEqual(db.state.activity.map(({ action_type }) => action_type), ['공정완료', '출고완료']);
  const schemaIndex = db.state.statements.findIndex((statement) => statement.startsWith('CREATE TABLE IF NOT EXISTS sheet_shipping_sync_jobs'));
  const processClaimIndex = db.state.statements.findIndex((statement) => statement.startsWith("UPDATE processes SET status = 'completed'"));
  const shippingCteIndex = db.state.statements.findIndex((statement) => statement.startsWith('WITH claimed_order AS'));
  assert.ok(schemaIndex >= 0 && schemaIndex < processClaimIndex && processClaimIndex < shippingCteIndex);
});

test('a non-shipping process completion creates no shipping job and makes no sync attempt', async (t) => {
  const handleCompleteProcess = await loadHandleCompleteProcess(t);
  if (!handleCompleteProcess) return;
  const db = makeDb({ stepName: '절곡작업' });
  const res = makeResponse();
  let syncCount = 0;

  await handleCompleteProcess(makeRequest(), res, dependencies(db, {
    syncShippingSheet: async () => { syncCount += 1; },
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(db.state.process.status, 'completed');
  assert.equal(db.state.order.status, 'in_production');
  assert.deepEqual(db.state.shippingJobs, []);
  assert.equal(syncCount, 0);
  assert.equal(db.state.schemaInstalled, false);
  assert.deepEqual(db.state.activity.map(({ action_type }) => action_type), ['공정완료']);
});

test('a lost final order claim preserves process success without a job, shipping activity, notification, or sync', async (t) => {
  const handleCompleteProcess = await loadHandleCompleteProcess(t);
  if (!handleCompleteProcess) return;
  const db = makeDb({ shippingClaimSucceeds: false });
  const res = makeResponse();
  let syncCount = 0;
  let notificationCount = 0;

  await handleCompleteProcess(makeRequest(), res, dependencies(db, {
    notify: async () => { notificationCount += 1; },
    syncShippingSheet: async () => { syncCount += 1; },
  }));

  assert.equal(res.statusCode, 200);
  assert.equal(db.state.process.status, 'completed');
  assert.equal(db.state.order.status, 'in_production');
  assert.deepEqual(db.state.shippingJobs, []);
  assert.equal(syncCount, 0);
  assert.equal(notificationCount, 0);
  assert.deepEqual(db.state.activity.map(({ action_type }) => action_type), ['공정완료']);
});

test('final shipping sync failure stays HTTP 200, retryable, and emits one actionable warning', async (t) => {
  const handleCompleteProcess = await loadHandleCompleteProcess(t);
  if (!handleCompleteProcess) return;
  const db = makeDb();
  const res = makeResponse();
  const originalDateNow = Date.now;
  const originalWarn = console.warn;
  Date.now = () => Date.parse('2026-08-03T15:30:00.000Z');
  const warnings = [];
  console.warn = (...args) => warnings.push(args.join(' '));
  let syncCount = 0;

  try {
    await handleCompleteProcess(makeRequest(), res, dependencies(db, {
      syncShippingSheet: async () => {
        syncCount += 1;
        return { status: 'pending', error: 'process shipping webhook unavailable' };
      },
    }));
  } finally {
    Date.now = originalDateNow;
    console.warn = originalWarn;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(syncCount, 1);
  assert.equal(db.state.shippingJobs[0].status, 'pending');
  assert.match(warnings.join('\n'), /process shipping webhook unavailable/);
  assert.match(warnings.join('\n'), /retry/i);
  assert.match(warnings.join('\n'), /order 173/i);
  assert.match(warnings.join('\n'), /2026-08-04/);
});

test('a lost process claim returns 409 and creates no shipping job or immediate sync', async (t) => {
  const handleCompleteProcess = await loadHandleCompleteProcess(t);
  if (!handleCompleteProcess) return;
  const db = makeDb({ processClaimSucceeds: false });
  const res = makeResponse();
  let syncCount = 0;

  await handleCompleteProcess(makeRequest(), res, dependencies(db, {
    syncShippingSheet: async () => { syncCount += 1; },
  }));

  assert.equal(res.statusCode, 409);
  assert.equal(db.state.process.status, 'in_progress');
  assert.deepEqual(db.state.shippingJobs, []);
  assert.equal(syncCount, 0);
});

test('shipping schema failure happens before the final process is irreversibly completed', async (t) => {
  const handleCompleteProcess = await loadHandleCompleteProcess(t);
  if (!handleCompleteProcess) return;
  const db = makeDb({ schemaFails: true });
  const res = makeResponse();

  await assert.rejects(
    handleCompleteProcess(makeRequest(), res, dependencies(db)),
    /shipping schema installation failed/,
  );

  assert.equal(db.state.process.status, 'in_progress');
  assert.deepEqual(db.state.shippingJobs, []);
});
