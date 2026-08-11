import assert from 'node:assert/strict';
import test from 'node:test';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const fixedNow = Date.parse('2026-08-04T03:00:00.000Z');

function compactSql(sql) {
  return String(sql).replace(/\s+/g, ' ').trim();
}

function querySql(query) {
  return typeof query === 'string' ? query : query.sql;
}

function mockResponse() {
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

async function loadShippingSheetSync() {
  return import('../api/_lib/shippingSheetSync.js');
}

async function loadShippingSheetSyncSchema() {
  return import('../api/_lib/shippingSheetSyncSchema.js');
}

class FakeShippingOutboxDb {
  constructor({
    orderId = 73,
    shipDate = '2026-08-04',
    status = 'pending',
    lastAttemptAt = null,
    withJob = true,
    onSchema = null,
  } = {}) {
    this.now = fixedNow;
    this.schemaInstalled = false;
    this.onSchema = onSchema;
    this.orders = new Map([[orderId, {
      id: orderId,
      client_name: 'shipping client',
      status: 'shipped',
      ship_date: shipDate,
    }]]);
    this.jobs = new Map();
    if (withJob) {
      this.jobs.set(orderId, {
        order_id: orderId,
        ship_date: shipDate,
        status,
        attempts: 0,
        last_error: null,
        last_attempt_at: lastAttemptAt,
        synced_at: null,
        sheet_row: null,
        created_at: new Date(fixedNow - 60_000).toISOString(),
        updated_at: new Date(fixedNow - 60_000).toISOString(),
      });
    }
    this.statements = [];
    this.failSyncedUpdateOnce = false;
  }

  isEligible(job) {
    if (job.status === 'pending' || job.status === 'failed') return true;
    if (job.status !== 'sending') return false;
    if (!job.last_attempt_at) return true;
    return Date.parse(job.last_attempt_at) <= this.now - FIVE_MINUTES_MS;
  }

  requireSchema(sql) {
    if (!this.schemaInstalled) {
      throw new Error(`shipping schema was not installed before first use: ${sql}`);
    }
  }

  async execute(query) {
    const sql = compactSql(querySql(query));
    const args = typeof query === 'string' ? [] : (query.args || []);
    this.statements.push({ sql, args });

    if (/^CREATE TABLE IF NOT EXISTS sheet_shipping_sync_jobs\b/i.test(sql)) {
      this.schemaInstalled = true;
      this.onSchema?.();
      return { rows: [] };
    }

    if (/^INSERT INTO sheet_shipping_sync_jobs\b/i.test(sql)) {
      this.requireSchema(sql);
      const [orderIdValue, shipDate] = args;
      const orderId = Number(orderIdValue);
      let job = this.jobs.get(orderId);
      if (!job) {
        job = {
          order_id: orderId,
          ship_date: shipDate,
          status: 'pending',
          attempts: 0,
          last_error: null,
          last_attempt_at: null,
          synced_at: null,
          sheet_row: null,
          created_at: new Date(this.now).toISOString(),
          updated_at: new Date(this.now).toISOString(),
        };
        this.jobs.set(orderId, job);
      }
      return { rows: [{ ...job }] };
    }

    if (/^UPDATE sheet_shipping_sync_jobs SET status = 'sending'/i.test(sql)) {
      this.requireSchema(sql);
      const orderId = Number(args[0]);
      const job = this.jobs.get(orderId);
      if (!job || !this.isEligible(job)) return { rows: [] };
      job.status = 'sending';
      job.attempts += 1;
      job.last_error = null;
      job.last_attempt_at = new Date(this.now).toISOString();
      job.updated_at = new Date(this.now).toISOString();
      return { rows: [{ ...job }] };
    }

    if (/^UPDATE sheet_shipping_sync_jobs SET status = 'synced'/i.test(sql)) {
      this.requireSchema(sql);
      if (this.failSyncedUpdateOnce) {
        this.failSyncedUpdateOnce = false;
        throw new Error('simulated shipping status update loss');
      }
      const [sheetRowValue, orderIdValue, claimedAttempt] = args;
      const job = this.jobs.get(Number(orderIdValue));
      if (!job || job.status !== 'sending') return { rows: [] };
      if (claimedAttempt !== undefined && job.attempts !== Number(claimedAttempt)) return { rows: [] };
      job.status = 'synced';
      job.last_error = null;
      job.synced_at = new Date(this.now).toISOString();
      job.sheet_row = Number(sheetRowValue);
      job.updated_at = new Date(this.now).toISOString();
      return { rows: [{ ...job }] };
    }

    if (/^UPDATE sheet_shipping_sync_jobs SET status = \?/i.test(sql)) {
      this.requireSchema(sql);
      const [status, error, orderIdValue, claimedAttempt] = args;
      const job = this.jobs.get(Number(orderIdValue));
      if (!job || job.status !== 'sending') return { rows: [] };
      if (claimedAttempt !== undefined && job.attempts !== Number(claimedAttempt)) return { rows: [] };
      job.status = status;
      job.last_error = error;
      job.updated_at = new Date(this.now).toISOString();
      return { rows: [{ ...job }] };
    }

    if (/^SELECT o\.\*, j\.ship_date AS shipping_sheet_sync_ship_date FROM sheet_shipping_sync_jobs j JOIN orders o ON o\.id = j\.order_id/i.test(sql)) {
      this.requireSchema(sql);
      const limit = Number(args.at(-1));
      const rows = [...this.jobs.values()]
        .filter((job) => this.isEligible(job))
        .sort((left, right) => left.order_id - right.order_id)
        .slice(0, limit)
        .map((job) => ({
          ...this.orders.get(job.order_id),
          shipping_sheet_sync_ship_date: job.ship_date,
        }));
      return { rows };
    }

    throw new Error(`Unexpected fake shipping outbox SQL: ${sql}`);
  }
}

test('schema defines a durable order-keyed shipping job with ship date and FK cascade', async () => {
  const { ensureShippingSheetSyncSchema } = await loadShippingSheetSyncSchema();
  const statements = [];
  await ensureShippingSheetSyncSchema({
    async execute(query) {
      statements.push(compactSql(querySql(query)));
      return { rows: [] };
    },
  });

  assert.equal(statements.length, 1);
  assert.match(
    statements[0],
    /order_id INTEGER PRIMARY KEY REFERENCES orders\(id\) ON DELETE CASCADE/i,
  );
  for (const column of [
    'ship_date', 'status', 'attempts', 'last_error', 'last_attempt_at',
    'synced_at', 'sheet_row', 'created_at', 'updated_at',
  ]) {
    assert.match(statements[0], new RegExp(`\\b${column}\\b`, 'i'));
  }
});

test('enqueue installs the schema first and preserves an existing synced job on replay', async () => {
  const { enqueueShippingSheetSync } = await loadShippingSheetSync();
  const db = new FakeShippingOutboxDb({ withJob: false });

  const enqueued = await enqueueShippingSheetSync(db, 73, '2026-08-04');
  assert.equal(db.statements[0].sql.startsWith('CREATE TABLE IF NOT EXISTS sheet_shipping_sync_jobs'), true);
  assert.equal(db.statements[1].sql.startsWith('INSERT INTO sheet_shipping_sync_jobs'), true);
  assert.equal(enqueued.order_id, 73);
  assert.equal(enqueued.ship_date, '2026-08-04');
  assert.equal(enqueued.status, 'pending');

  db.jobs.get(73).status = 'synced';
  db.jobs.get(73).sheet_row = 44;
  await enqueueShippingSheetSync(db, 73, '2026-08-04');
  assert.equal(db.jobs.size, 1);
  assert.equal(db.jobs.get(73).status, 'synced');
  assert.equal(db.jobs.get(73).sheet_row, 44);
});

test('immediate client failure stays retryable and a later retry persists updatedRow', async () => {
  const { retryPendingShippingSheetSync, syncShippedOrderToSheet } = await loadShippingSheetSync();
  const db = new FakeShippingOutboxDb();
  const order = db.orders.get(73);
  const deliveries = [];

  const immediate = await syncShippedOrderToSheet(db, order, {
    markShipped: async (receivedOrder, shipDate) => {
      deliveries.push([receivedOrder.id, shipDate]);
      throw new Error('shipping webhook unavailable');
    },
  });
  assert.equal(immediate.status, 'pending');
  assert.match(immediate.error, /shipping webhook unavailable/);
  assert.equal(db.jobs.get(73).status, 'pending');
  assert.equal(db.jobs.get(73).attempts, 1);
  assert.match(db.jobs.get(73).last_error, /shipping webhook unavailable/);

  const retried = await retryPendingShippingSheetSync(db, {
    limit: 10,
    deadlineMs: 20_000,
    markShipped: async (receivedOrder, shipDate) => {
      deliveries.push([receivedOrder.id, shipDate]);
      return { updatedRow: 77 };
    },
  });

  assert.deepEqual(deliveries, [[73, '2026-08-04'], [73, '2026-08-04']]);
  assert.equal(retried.synced, 1);
  assert.equal(db.jobs.get(73).status, 'synced');
  assert.equal(db.jobs.get(73).sheet_row, 77);
});

test('successful shipping sync persists the positive updated row', async () => {
  const { syncShippedOrderToSheet } = await loadShippingSheetSync();
  const db = new FakeShippingOutboxDb();

  const result = await syncShippedOrderToSheet(db, db.orders.get(73), {
    markShipped: async () => ({ updatedRow: 88 }),
  });

  assert.deepEqual(result, { status: 'synced', updatedRow: 88 });
  assert.equal(db.jobs.get(73).status, 'synced');
  assert.equal(db.jobs.get(73).sheet_row, 88);
});

test('shipping delivery uses the durable job ship date when caller data has drifted', async () => {
  const { syncShippedOrderToSheet } = await loadShippingSheetSync();
  const db = new FakeShippingOutboxDb({ shipDate: '2026-08-04' });
  const driftedOrder = { ...db.orders.get(73), ship_date: '2026-08-05' };
  let deliveredShipDate;

  const result = await syncShippedOrderToSheet(db, driftedOrder, {
    markShipped: async (_order, shipDate) => {
      deliveredShipDate = shipDate;
      return { updatedRow: 88 };
    },
  });

  assert.equal(result.status, 'synced');
  assert.equal(deliveredShipDate, '2026-08-04');
});

test('a conditional claim permits only one shipping sender', async () => {
  const { syncShippedOrderToSheet } = await loadShippingSheetSync();
  const db = new FakeShippingOutboxDb();
  let releaseDelivery;
  const deliveryGate = new Promise((resolve) => { releaseDelivery = resolve; });
  let deliveries = 0;
  const markShipped = async () => {
    deliveries += 1;
    await deliveryGate;
    return { updatedRow: 89 };
  };

  const first = syncShippedOrderToSheet(db, db.orders.get(73), { markShipped });
  await new Promise((resolve) => setImmediate(resolve));
  const second = syncShippedOrderToSheet(db, db.orders.get(73), { markShipped });
  releaseDelivery();
  const results = await Promise.all([first, second]);

  assert.equal(deliveries, 1);
  assert.equal(results.filter((result) => result.status === 'synced').length, 1);
  assert.equal(results.filter((result) => result.skipped === true).length, 1);
  assert.equal(db.jobs.get(73).status, 'synced');
});

test('a stale sender cannot acknowledge a newer reclaimed generation', async () => {
  const { syncShippedOrderToSheet } = await loadShippingSheetSync();
  const db = new FakeShippingOutboxDb();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let releaseSecond;
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });

  const first = syncShippedOrderToSheet(db, db.orders.get(73), {
    markShipped: async () => {
      await firstGate;
      return { updatedRow: 92 };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  db.now += FIVE_MINUTES_MS + 1;
  const second = syncShippedOrderToSheet(db, db.orders.get(73), {
    markShipped: async () => {
      await secondGate;
      return { updatedRow: 93 };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(db.jobs.get(73).attempts, 2);
  assert.equal(db.jobs.get(73).status, 'sending');

  releaseFirst();
  const firstResult = await first;
  assert.equal(firstResult.status, 'pending');
  assert.equal(db.jobs.get(73).status, 'sending');
  assert.equal(db.jobs.get(73).sheet_row, null);

  releaseSecond();
  const secondResult = await second;
  assert.deepEqual(secondResult, { status: 'synced', updatedRow: 93 });
  assert.equal(db.jobs.get(73).status, 'synced');
  assert.equal(db.jobs.get(73).sheet_row, 93);
});

test('a stale sender failure cannot downgrade a newer live claim', async () => {
  const { syncShippedOrderToSheet } = await loadShippingSheetSync();
  const db = new FakeShippingOutboxDb();
  let releaseFirst;
  const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
  let releaseSecond;
  const secondGate = new Promise((resolve) => { releaseSecond = resolve; });

  const first = syncShippedOrderToSheet(db, db.orders.get(73), {
    markShipped: async () => {
      await firstGate;
      throw new Error('late stale failure');
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  db.now += FIVE_MINUTES_MS + 1;
  const second = syncShippedOrderToSheet(db, db.orders.get(73), {
    markShipped: async () => {
      await secondGate;
      return { updatedRow: 94 };
    },
  });
  await new Promise((resolve) => setImmediate(resolve));

  releaseFirst();
  const firstResult = await first;
  assert.equal(firstResult.status, 'pending');
  assert.match(firstResult.error, /late stale failure/);
  assert.equal(db.jobs.get(73).status, 'sending');
  assert.equal(db.jobs.get(73).attempts, 2);

  releaseSecond();
  const secondResult = await second;
  assert.deepEqual(secondResult, { status: 'synced', updatedRow: 94 });
  assert.equal(db.jobs.get(73).status, 'synced');
  assert.equal(db.jobs.get(73).sheet_row, 94);
});

test('a stale sending job is recovered while a fresh sending job is not claimed', async () => {
  const { syncShippedOrderToSheet } = await loadShippingSheetSync();
  const staleDb = new FakeShippingOutboxDb({
    status: 'sending',
    lastAttemptAt: new Date(fixedNow - FIVE_MINUTES_MS - 1).toISOString(),
  });
  let staleDeliveries = 0;
  const recovered = await syncShippedOrderToSheet(staleDb, staleDb.orders.get(73), {
    markShipped: async () => {
      staleDeliveries += 1;
      return { updatedRow: 90 };
    },
  });
  assert.equal(recovered.status, 'synced');
  assert.equal(staleDeliveries, 1);

  const freshDb = new FakeShippingOutboxDb({
    status: 'sending',
    lastAttemptAt: new Date(fixedNow - FIVE_MINUTES_MS + 1).toISOString(),
  });
  let freshDeliveries = 0;
  const skipped = await syncShippedOrderToSheet(freshDb, freshDb.orders.get(73), {
    markShipped: async () => {
      freshDeliveries += 1;
      return { updatedRow: 91 };
    },
  });
  assert.equal(skipped.skipped, true);
  assert.equal(freshDeliveries, 0);
  assert.equal(freshDb.jobs.get(73).status, 'sending');
});

test('a replay after status-write loss repeats only the idempotent markShipped delivery', async () => {
  const { retryPendingShippingSheetSync, syncShippedOrderToSheet } = await loadShippingSheetSync();
  const db = new FakeShippingOutboxDb();
  db.failSyncedUpdateOnce = true;
  const deliveries = [];
  const markShipped = async (receivedOrder, shipDate) => {
    deliveries.push({ orderId: receivedOrder.id, shipDate });
    return { updatedRow: 91 };
  };

  const first = await syncShippedOrderToSheet(db, db.orders.get(73), { markShipped });
  assert.equal(first.status, 'pending');
  assert.equal(db.jobs.get(73).status, 'pending');

  const replay = await retryPendingShippingSheetSync(db, {
    limit: 10,
    deadlineMs: 20_000,
    markShipped,
  });
  assert.equal(replay.synced, 1);
  assert.deepEqual(deliveries, [
    { orderId: 73, shipDate: '2026-08-04' },
    { orderId: 73, shipDate: '2026-08-04' },
  ]);
  assert.equal(db.jobs.get(73).sheet_row, 91);
  assert.equal(
    db.statements.some(({ sql }) => /^INSERT INTO orders\b/i.test(sql)),
    false,
    'shipping replay must never append an order row',
  );
});

test('a DATE-typed ship_date returned as a Date object still claims the job and delivers the KST date', async () => {
  const { syncShippedOrderToSheet } = await loadShippingSheetSync();
  // Neon 드라이버가 DATE 컬럼을 JS Date 로 돌려주는 실측 형태 (KST 2026-08-04 = UTC 2026-08-03T15:00Z)
  const db = new FakeShippingOutboxDb({ shipDate: new Date('2026-08-03T15:00:00.000Z') });
  const deliveries = [];

  const result = await syncShippedOrderToSheet(db, db.orders.get(73), {
    markShipped: async (receivedOrder, shipDate) => {
      deliveries.push([receivedOrder.id, shipDate]);
      return { updatedRow: 101 };
    },
  });

  assert.deepEqual(deliveries, [[73, '2026-08-04']], 'UTC 자정 해석으로 하루 밀리면 안 된다');
  assert.deepEqual(result, { status: 'synced', updatedRow: 101 });
  assert.equal(db.jobs.get(73).status, 'synced');
  assert.equal(db.jobs.get(73).attempts, 1);
  assert.equal(db.jobs.get(73).sheet_row, 101);
});

test('a Date-typed ship_date retried by the cron increments attempts instead of stalling at pending', async () => {
  const { retryPendingShippingSheetSync } = await loadShippingSheetSync();
  const db = new FakeShippingOutboxDb({ shipDate: new Date('2026-08-03T15:00:00.000Z') });
  const deliveries = [];

  const firstSweep = await retryPendingShippingSheetSync(db, {
    limit: 10,
    deadlineMs: 20_000,
    markShipped: async (receivedOrder, shipDate) => {
      deliveries.push(shipDate);
      throw new Error('shipping webhook unavailable');
    },
  });

  assert.equal(firstSweep.attempted, 1);
  assert.equal(firstSweep.failed, 1);
  assert.equal(db.jobs.get(73).attempts, 1, 'claimJob 에 도달하지 못하면 attempts 가 영원히 안 오른다');
  assert.equal(db.jobs.get(73).status, 'failed');

  const secondSweep = await retryPendingShippingSheetSync(db, {
    limit: 10,
    deadlineMs: 20_000,
    markShipped: async (receivedOrder, shipDate) => {
      deliveries.push(shipDate);
      return { updatedRow: 102 };
    },
  });

  assert.equal(secondSweep.synced, 1);
  assert.deepEqual(deliveries, ['2026-08-04', '2026-08-04']);
  assert.equal(db.jobs.get(73).attempts, 2);
  assert.equal(db.jobs.get(73).status, 'synced');
  assert.equal(db.jobs.get(73).sheet_row, 102);
});

test('unusable ship dates are still rejected before any claim', async () => {
  const { syncShippedOrderToSheet } = await loadShippingSheetSync();

  for (const shipDate of [null, undefined, '', '2026/08/04', new Date('nonsense'), 1_754_265_600_000, {}]) {
    const db = new FakeShippingOutboxDb();
    let deliveries = 0;
    const result = await syncShippedOrderToSheet(db, { ...db.orders.get(73), ship_date: shipDate }, {
      shipDate,
      markShipped: async () => {
        deliveries += 1;
        return { updatedRow: 103 };
      },
    });

    assert.equal(result.status, 'pending', String(shipDate));
    assert.match(result.error, /Invalid ship date/);
    assert.equal(deliveries, 0);
    assert.equal(db.jobs.get(73).attempts, 0);
    assert.equal(db.jobs.get(73).status, 'pending');
  }
});

test('retry client failures persist a durable failed state', async () => {
  const { retryPendingShippingSheetSync } = await loadShippingSheetSync();
  const db = new FakeShippingOutboxDb();

  const summary = await retryPendingShippingSheetSync(db, {
    limit: 10,
    deadlineMs: 20_000,
    markShipped: async () => { throw new Error('retry delivery failed'); },
  });

  assert.equal(summary.failed, 1);
  assert.equal(db.jobs.get(73).status, 'failed');
  assert.match(db.jobs.get(73).last_error, /retry delivery failed/);
});

test('one cron sweep spends the 10s attempt budget on several jobs instead of stalling after one', async () => {
  const { retryPendingShippingSheetSync } = await loadShippingSheetSync();
  const db = new FakeShippingOutboxDb();
  for (const orderId of [74, 75, 76, 77, 78, 79]) {
    db.orders.set(orderId, {
      id: orderId,
      client_name: `shipping client ${orderId}`,
      status: 'shipped',
      ship_date: '2026-08-04',
    });
    db.jobs.set(orderId, {
      order_id: orderId,
      ship_date: '2026-08-04',
      status: 'pending',
      attempts: 0,
      last_error: null,
      last_attempt_at: null,
      synced_at: null,
      sheet_row: null,
      created_at: new Date(fixedNow - 60_000).toISOString(),
      updated_at: new Date(fixedNow - 60_000).toISOString(),
    });
  }

  const originalDateNow = Date.now;
  let clock = fixedNow;
  Date.now = () => clock;
  const delivered = [];
  let summary;

  try {
    summary = await retryPendingShippingSheetSync(db, {
      limit: 25,
      deadlineMs: 25_000,
      markShipped: async (order) => {
        delivered.push(order.id);
        clock += 3_500; // 실측 왕복 3~4초
        return { updatedRow: 200 + order.id };
      },
    });
  } finally {
    Date.now = originalDateNow;
  }

  // 건당 예약 예산이 10초(+상태 기록 1초)라 25초 예산에 5건이 들어간다.
  // 예전 15초 예약이었다면 같은 조건에서 3건에서 멈췄다.
  assert.equal(summary.attempted, 5, '한 번 실행에 여러 건을 처리해야 한다');
  assert.equal(summary.synced, 5);
  assert.equal(summary.failed, 0);
  assert.deepEqual(delivered, [73, 74, 75, 76, 77]);
  for (const orderId of delivered) {
    assert.equal(db.jobs.get(orderId).status, 'synced');
    assert.equal(db.jobs.get(orderId).sheet_row, 200 + orderId);
  }
  // 남은 건은 손대지 않은 채 다음 실행으로 넘어가야 한다(5분 뒤 크론).
  for (const orderId of [78, 79]) {
    assert.equal(db.jobs.get(orderId).status, 'pending');
    assert.equal(db.jobs.get(orderId).attempts, 0);
  }
});

test('cron authorizes first, installs shipping schema, then retries append before shipping', async () => {
  const { handleSheetSyncCron } = await import('../api/cron/sheet-sync.js');
  const originalSecret = process.env.CRON_SECRET;
  const originalDateNow = Date.now;
  process.env.CRON_SECRET = 'shipping-cron-secret';
  Date.now = () => fixedNow;
  const events = [];
  const db = {
    async execute(query) {
      const sql = compactSql(querySql(query));
      if (/^CREATE TABLE IF NOT EXISTS sheet_shipping_sync_jobs\b/i.test(sql)) {
        events.push('shipping-schema');
      }
      return { rows: [] };
    },
  };
  const appendSummary = { attempted: 1, synced: 1, failed: 0, skipped: 0, errors: [] };
  const shippingSummary = { attempted: 1, synced: 0, failed: 1, skipped: 0, errors: ['order 73'] };

  try {
    const unauthorized = mockResponse();
    await handleSheetSyncCron({ method: 'GET', headers: {} }, unauthorized, db, {
      retry: async () => { events.push('append-retry'); },
      retryShipping: async () => { events.push('shipping-retry'); },
    });
    assert.equal(unauthorized.statusCode, 401);
    assert.deepEqual(events, []);

    const authorized = mockResponse();
    await handleSheetSyncCron({
      method: 'POST',
      headers: { authorization: 'Bearer shipping-cron-secret' },
    }, authorized, db, {
      retry: async (_db, options) => {
        events.push('append-retry');
        // Vercel 함수 한도 30초 안에서 25초까지 쓴다.
        assert.deepEqual(options, { limit: 25, deadlineMs: 25_000 });
        return appendSummary;
      },
      retryShipping: async (_db, options) => {
        events.push('shipping-retry');
        // 출고 재시도는 append 가 쓰고 남은 예산을 받는다(Date.now 고정이라 25초 그대로).
        assert.deepEqual(options, { limit: 25, deadlineMs: 25_000 });
        return shippingSummary;
      },
    });

    assert.equal(authorized.statusCode, 200);
    assert.deepEqual(events, ['shipping-schema', 'append-retry', 'shipping-retry']);
    assert.deepEqual(authorized.body.append, appendSummary);
    assert.deepEqual(authorized.body.shipping, shippingSummary);
    assert.equal(authorized.body.synced, 1, 'legacy top-level append summary remains available');
  } finally {
    Date.now = originalDateNow;
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }
});
