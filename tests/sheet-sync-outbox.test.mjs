import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { handlePost } from '../api/orders/index.js';

const FIVE_MINUTES_MS = 5 * 60 * 1000;
const fixedNow = Date.parse('2026-08-03T12:00:00.000Z');

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

async function loadSheetSync() {
  return import('../api/_lib/sheetSync.js');
}

let sheetSyncSchemaLoads = 0;

// ensureSheetSyncSchema 는 모듈 단위로 "이미 보정했음" 플래그를 들고 있다.
// 테스트마다 새 인스턴스를 받아야 보정 SQL 을 실제로 관찰할 수 있다.
async function loadSheetSyncSchema() {
  sheetSyncSchemaLoads += 1;
  return import(`../api/_lib/sheetSyncSchema.js?load=${sheetSyncSchemaLoads}`);
}

class FakeOutboxDb {
  constructor({ orderId = 801, status = 'pending', lastAttemptAt = null } = {}) {
    this.now = fixedNow;
    this.orders = new Map([[orderId, {
      id: orderId,
      order_date: '2026-08-03',
      due_date: '2026-08-10',
      sales_person: 'manager',
      client_name: 'outbox client',
      phone: '',
      product_type: 'door',
      width: 100,
      depth: 200,
      height: 300,
      quantity: 1,
      color: 'white',
      track_token: 'existing-token',
    }]]);
    this.jobs = new Map([[orderId, {
      order_id: orderId,
      status,
      attempts: 0,
      last_error: null,
      last_attempt_at: lastAttemptAt,
      synced_at: null,
      sheet_row: null,
    }]]);
    this.statements = [];
    this.failSyncedUpdateOnce = false;
  }

  isEligible(job) {
    if (job.status === 'pending' || job.status === 'failed') return true;
    if (job.status !== 'sending') return false;
    if (!job.last_attempt_at) return true;
    return Date.parse(job.last_attempt_at) <= this.now - FIVE_MINUTES_MS;
  }

  async execute(query) {
    const sql = compactSql(querySql(query));
    const args = typeof query === 'string' ? [] : (query.args || []);
    this.statements.push({ sql, args });

    if (/^CREATE TABLE IF NOT EXISTS sheet_sync_jobs\b/i.test(sql)) {
      return { rows: [] };
    }

    // 레거시 테이블 보정 SQL. 이 하네스는 신규 스키마를 흉내내므로 action 컬럼은 없다.
    if (/^ALTER TABLE sheet_sync_jobs\b/i.test(sql)) {
      return { rows: [] };
    }

    if (/information_schema\.columns/i.test(sql)) {
      return { rows: [] };
    }

    if (/^UPDATE sheet_sync_jobs SET status = 'sending'/i.test(sql)) {
      const orderId = Number(args[0]);
      const job = this.jobs.get(orderId);
      if (!job || !this.isEligible(job)) return { rows: [] };
      job.status = 'sending';
      job.attempts += 1;
      job.last_attempt_at = new Date(this.now).toISOString();
      job.last_error = null;
      return { rows: [{ ...job }] };
    }

    if (/^UPDATE sheet_sync_jobs SET status = 'synced'/i.test(sql)) {
      if (this.failSyncedUpdateOnce) {
        this.failSyncedUpdateOnce = false;
        throw new Error('simulated status update loss');
      }
      const [sheetRow, orderIdValue] = args;
      const job = this.jobs.get(Number(orderIdValue));
      if (!job || job.status !== 'sending') return { rows: [] };
      job.status = 'synced';
      job.sheet_row = Number(sheetRow);
      job.synced_at = new Date(this.now).toISOString();
      job.last_error = null;
      return { rows: [{ ...job }] };
    }

    if (/^UPDATE sheet_sync_jobs SET status = \?/i.test(sql)) {
      const [status, error, orderIdValue] = args;
      const job = this.jobs.get(Number(orderIdValue));
      if (!job || job.status !== 'sending') return { rows: [] };
      job.status = status;
      job.last_error = error;
      return { rows: [{ ...job }] };
    }

    if (/^SELECT o\.\* FROM sheet_sync_jobs j JOIN orders o ON o\.id = j\.order_id/i.test(sql)) {
      const limit = Number(args.at(-1));
      const rows = [...this.jobs.values()]
        .filter((job) => this.isEligible(job))
        .sort((left, right) => left.order_id - right.order_id)
        .slice(0, limit)
        .map((job) => ({ ...this.orders.get(job.order_id) }));
      return { rows };
    }

    throw new Error(`Unexpected fake outbox SQL: ${sql}`);
  }
}

class FakeOrderDb extends FakeOutboxDb {
  constructor(options = {}) {
    super({ orderId: 801 });
    this.orders.clear();
    this.jobs.clear();
    this.failProcessInsert = options.failProcessInsert === true;
    this.createdJob = false;
    this.cleanupDeletes = 0;
    this.commits = 0;
  }

  async transaction() {
    return {
      execute: async (query) => this.executeTransaction(query),
      commit: async () => { this.commits += 1; },
      rollback: async () => {},
    };
  }

  async executeTransaction(query) {
    const sql = compactSql(querySql(query));
    const args = query.args || [];
    this.statements.push({ sql, args, transaction: true });

    if (/^CREATE TABLE IF NOT EXISTS sheet_sync_jobs\b/i.test(sql)) {
      return { rows: [] };
    }

    // 레거시 테이블 보정 SQL. 이 하네스는 신규 스키마를 흉내내므로 action 컬럼은 없다.
    if (/^ALTER TABLE sheet_sync_jobs\b/i.test(sql)) {
      return { rows: [] };
    }

    if (/information_schema\.columns/i.test(sql)) {
      return { rows: [] };
    }

    if (/INSERT INTO orders\b/i.test(sql)) {
      const order = {
        id: 801,
        order_date: '2026-08-03',
        due_date: '2026-08-10',
        sales_person: 'manager',
        client_name: 'atomic order',
        phone: '',
        product_type: 'door',
        width: 100,
        depth: 200,
        height: 300,
        quantity: 1,
        color: 'white',
        status: 'in_production',
        track_token: 'existing-token',
      };
      this.orders.set(order.id, order);
      if (/INSERT INTO sheet_sync_jobs\b/i.test(sql)) {
        this.jobs.set(order.id, {
          order_id: order.id,
          status: 'pending',
          attempts: 0,
          last_error: null,
          last_attempt_at: null,
          synced_at: null,
          sheet_row: null,
        });
        this.createdJob = true;
      }
      return { rows: [{ id: order.id }] };
    }

    if (/^INSERT INTO processes\b/i.test(sql)) {
      if (this.failProcessInsert) throw new Error('simulated process insert failure');
      return { rows: [] };
    }
    if (/^INSERT INTO pre_production\b/i.test(sql)) return { rows: [] };
    if (/^INSERT INTO activity_feed\b/i.test(sql)) return { rows: [] };

    throw new Error(`Unexpected fake transaction SQL: ${sql}`);
  }

  async execute(query) {
    const sql = compactSql(querySql(query));
    const args = query.args || [];

    if (/^ALTER TABLE orders ADD COLUMN IF NOT EXISTS\b/i.test(sql)
      || /^CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_track_token\b/i.test(sql)
      || /^CREATE TABLE IF NOT EXISTS notification_log\b/i.test(sql)) {
      this.statements.push({ sql, args });
      return { rows: [] };
    }

    if (/^SELECT \* FROM orders WHERE id = \?/i.test(sql)) {
      this.statements.push({ sql, args });
      const order = this.orders.get(Number(args[0]));
      return { rows: order ? [{ ...order }] : [] };
    }
    if (/^SELECT \* FROM processes WHERE order_id = \?/i.test(sql)) {
      this.statements.push({ sql, args });
      return { rows: [] };
    }
    if (/^SELECT \* FROM pre_production WHERE order_id = \?/i.test(sql)) {
      this.statements.push({ sql, args });
      return { rows: [{ order_id: Number(args[0]) }] };
    }
    if (/^UPDATE orders SET notify_state\b/i.test(sql)) {
      this.statements.push({ sql, args });
      return { rows: [] };
    }
    if (/^DELETE FROM orders WHERE id = \?/i.test(sql)) {
      this.statements.push({ sql, args });
      const orderId = Number(args[0]);
      this.orders.delete(orderId);
      this.jobs.delete(orderId);
      this.cleanupDeletes += 1;
      return { rows: [], rowsAffected: 1 };
    }

    return super.execute(query);
  }
}

test('schema and migration install the durable order-keyed job with FK cascade', async () => {
  const { ensureSheetSyncSchema } = await loadSheetSyncSchema();
  const statements = [];
  await ensureSheetSyncSchema({
    async execute(query) {
      statements.push(compactSql(querySql(query)));
      return { rows: [] };
    },
  });

  assert.match(statements[0], /order_id INTEGER PRIMARY KEY REFERENCES orders\(id\) ON DELETE CASCADE/i);
  for (const column of [
    'status', 'attempts', 'last_error', 'last_attempt_at', 'synced_at',
    'sheet_row', 'created_at', 'updated_at',
  ]) {
    assert.match(statements[0], new RegExp(`\\b${column}\\b`, 'i'));
  }

  const { runMigrationStatements } = await import('../scripts/migrate.js');
  const migrated = [];
  await runMigrationStatements({ async query(sql) { migrated.push(compactSql(sql)); } });
  assert.equal(migrated.filter((sql) => /^CREATE TABLE IF NOT EXISTS sheet_sync_jobs\b/i.test(sql)).length, 1);
});

// 2026-08-04 등록 장애: 프로덕션 테이블이 예전 스키마(action NOT NULL, 기본값 없음,
// last_attempt_at/synced_at/sheet_row 없음)로 남아 있어 주문 등록이 통째로 실패했다.
test('a legacy table gets its missing columns and an action default so order inserts survive', async () => {
  const { ensureSheetSyncSchema } = await loadSheetSyncSchema();
  const statements = [];
  await ensureSheetSyncSchema({
    async execute(query) {
      const sql = compactSql(querySql(query));
      statements.push(sql);
      // 레거시 테이블에는 action 컬럼이 있다.
      if (/information_schema\.columns/i.test(sql)) return { rows: [{ present: 1 }] };
      return { rows: [] };
    },
  });

  for (const column of ['last_attempt_at', 'synced_at', 'sheet_row']) {
    assert.equal(
      statements.filter((sql) => new RegExp(`ADD COLUMN IF NOT EXISTS ${column}\\b`, 'i').test(sql)).length,
      1,
      `${column} 보정이 정확히 한 번 실행되어야 한다`,
    );
  }
  assert.equal(
    statements.filter((sql) => /ALTER COLUMN action SET DEFAULT 'upsertOrder'/i.test(sql)).length,
    1,
  );
  // 테이블 생성이 컬럼 보정보다 먼저여야 한다.
  assert.ok(statements.findIndex((s) => /CREATE TABLE IF NOT EXISTS/i.test(s))
    < statements.findIndex((s) => /ADD COLUMN IF NOT EXISTS/i.test(s)));
});

test('a fresh table has no action column so the legacy default is never attempted', async () => {
  const { ensureSheetSyncSchema } = await loadSheetSyncSchema();
  const statements = [];
  await ensureSheetSyncSchema({
    async execute(query) {
      statements.push(compactSql(querySql(query)));
      return { rows: [] };
    },
  });

  assert.equal(statements.filter((sql) => /ALTER COLUMN action/i.test(sql)).length, 0);
  assert.equal(statements.filter((sql) => /ADD COLUMN IF NOT EXISTS/i.test(sql)).length, 3);
});

test('schema reconciliation never drops or rewrites existing job data', async () => {
  const { ensureSheetSyncSchema } = await loadSheetSyncSchema();
  const statements = [];
  await ensureSheetSyncSchema({
    async execute(query) {
      const sql = compactSql(querySql(query));
      statements.push(sql);
      if (/information_schema\.columns/i.test(sql)) return { rows: [{ present: 1 }] };
      return { rows: [] };
    },
  });

  for (const sql of statements) {
    assert.doesNotMatch(sql, /\bDROP\b/i);
    assert.doesNotMatch(sql, /\bTRUNCATE\b/i);
    assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
    assert.doesNotMatch(sql, /\bUPDATE\s+sheet_sync_jobs\s+SET\b/i);
  }
});

test('order creation executes the order insert and pending job insert in one data-modifying CTE', async () => {
  const stopAfterAtomicInsert = new Error('stop after atomic insert');
  const db = new FakeOrderDb();
  const originalExecuteTransaction = db.executeTransaction.bind(db);
  db.executeTransaction = async (query) => {
    const sql = compactSql(querySql(query));
    if (/INSERT INTO orders\b/i.test(sql)) {
      db.statements.push({ sql, args: query.args || [], transaction: true });
      throw stopAfterAtomicInsert;
    }
    return originalExecuteTransaction(query);
  };

  await assert.rejects(
    () => handlePost({ body: { client_name: 'atomic order' } }, mockResponse(), db),
    (error) => error === stopAfterAtomicInsert,
  );

  const statement = db.statements.find(({ sql }) => /INSERT INTO orders\b/i.test(sql)).sql;
  assert.match(statement, /^WITH inserted_order AS \( INSERT INTO orders\b/i);
  assert.match(statement, /\), inserted_sheet_sync_job AS \( INSERT INTO sheet_sync_jobs \(order_id, status\)/i);
  assert.match(statement, /SELECT id, 'pending' FROM inserted_order/i);
});

test('failed immediate append returns 201 with pending sync and keeps the committed order/job', async () => {
  const db = new FakeOrderDb();
  const res = mockResponse();
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('network must not be used by injected append'); };
  try {
    await handlePost(
      { body: { client_name: 'atomic order' } },
      res,
      db,
      { append: async () => { throw new Error('sheet unavailable'); } },
    );
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.equal(res.statusCode, 201);
  assert.equal(res.body.id, 801);
  assert.equal(res.body.sheet_sync.status, 'pending');
  assert.match(res.body.sheet_sync.error, /sheet unavailable/);
  assert.equal(db.orders.has(801), true);
  assert.equal(db.jobs.get(801).status, 'pending');
  assert.equal(db.cleanupDeletes, 0);
});

test('a later retry syncs a pending immediate failure and persists the returned sheet row', async () => {
  const { retryPendingSheetSync, syncOrderToSheet } = await loadSheetSync();
  const db = new FakeOutboxDb();
  const order = db.orders.get(801);

  const immediate = await syncOrderToSheet(db, order, {
    append: async () => { throw new Error('temporary sheet failure'); },
  });
  assert.equal(immediate.status, 'pending');
  assert.equal(db.jobs.get(801).status, 'pending');

  const retried = await retryPendingSheetSync(db, {
    limit: 10,
    deadlineMs: 20_000,
    append: async () => ({ row: 77, deduplicated: false }),
  });

  assert.equal(retried.synced, 1);
  assert.equal(db.jobs.get(801).status, 'synced');
  assert.equal(db.jobs.get(801).sheet_row, 77);
});

test('successful immediate sync stores row and exposes a boolean deduplication result', async () => {
  const { syncOrderToSheet } = await loadSheetSync();
  const db = new FakeOutboxDb();

  const result = await syncOrderToSheet(db, db.orders.get(801), {
    append: async () => ({ row: 88, deduplicated: true }),
  });

  assert.deepEqual(result, { status: 'synced', row: 88, deduplicated: true });
  assert.equal(db.jobs.get(801).status, 'synced');
  assert.equal(db.jobs.get(801).sheet_row, 88);
});

test('append success followed by status-update loss remains safely replayable by order ID', async () => {
  const { retryPendingSheetSync, syncOrderToSheet } = await loadSheetSync();
  const db = new FakeOutboxDb();
  db.failSyncedUpdateOnce = true;
  const appendResults = [
    { row: 99, deduplicated: false },
    { row: 99, deduplicated: true },
  ];
  let sends = 0;
  const append = async (order) => {
    assert.equal(order.id, 801, 'the stable order ID must be replayed');
    const result = appendResults[sends];
    sends += 1;
    return result;
  };

  const first = await syncOrderToSheet(db, db.orders.get(801), { append });
  assert.equal(first.status, 'pending');
  assert.equal(db.jobs.get(801).status, 'pending');

  const retried = await retryPendingSheetSync(db, { limit: 10, deadlineMs: 20_000, append });
  assert.equal(retried.synced, 1);
  assert.equal(sends, 2);
  assert.equal(db.jobs.get(801).sheet_row, 99);
});

test('conditional claim allows only one sender for concurrent workers', async () => {
  const { syncOrderToSheet } = await loadSheetSync();
  const db = new FakeOutboxDb();
  let releaseAppend;
  const appendGate = new Promise((resolve) => { releaseAppend = resolve; });
  let sends = 0;
  const append = async () => {
    sends += 1;
    await appendGate;
    return { row: 111, deduplicated: false };
  };

  const first = syncOrderToSheet(db, db.orders.get(801), { append });
  await new Promise((resolve) => setImmediate(resolve));
  const second = syncOrderToSheet(db, db.orders.get(801), { append });
  releaseAppend();
  const results = await Promise.all([first, second]);

  assert.equal(sends, 1);
  assert.equal(results.filter((result) => result.status === 'synced').length, 1);
  assert.equal(db.jobs.get(801).status, 'synced');
});

test('a five-minute-stale sending claim is recovered while a fresh claim is not', async () => {
  const { syncOrderToSheet } = await loadSheetSync();
  const staleDb = new FakeOutboxDb({
    status: 'sending',
    lastAttemptAt: new Date(fixedNow - FIVE_MINUTES_MS - 1).toISOString(),
  });
  let staleSends = 0;
  const recovered = await syncOrderToSheet(staleDb, staleDb.orders.get(801), {
    append: async () => {
      staleSends += 1;
      return { row: 121, deduplicated: true };
    },
  });
  assert.equal(recovered.status, 'synced');
  assert.equal(staleSends, 1);

  const freshDb = new FakeOutboxDb({
    status: 'sending',
    lastAttemptAt: new Date(fixedNow - FIVE_MINUTES_MS + 1).toISOString(),
  });
  let freshSends = 0;
  const skipped = await syncOrderToSheet(freshDb, freshDb.orders.get(801), {
    append: async () => {
      freshSends += 1;
      return { row: 122, deduplicated: false };
    },
  });
  assert.equal(skipped.status, 'pending');
  assert.equal(freshSends, 0);
});

test('retry failures are durable failed jobs and a zero deadline starts no sender', async () => {
  const { retryPendingSheetSync } = await loadSheetSync();
  const db = new FakeOutboxDb();

  const bounded = await retryPendingSheetSync(db, {
    limit: 10,
    deadlineMs: 0,
    append: async () => ({ row: 1, deduplicated: false }),
  });
  assert.equal(bounded.attempted, 0);
  assert.equal(db.jobs.get(801).status, 'pending');

  const failed = await retryPendingSheetSync(db, {
    limit: 10,
    deadlineMs: 20_000,
    append: async () => { throw new Error('retry failed'); },
  });
  assert.equal(failed.failed, 1);
  assert.equal(db.jobs.get(801).status, 'failed');
  assert.match(db.jobs.get(801).last_error, /retry failed/);
});

test('retry does not claim another job without a full append-and-persist deadline reserve', async () => {
  const { retryPendingSheetSync } = await loadSheetSync();
  const db = new FakeOutboxDb();
  db.orders.set(802, { ...db.orders.get(801), id: 802, client_name: 'second client' });
  db.jobs.set(802, { ...db.jobs.get(801), order_id: 802 });

  const originalDateNow = Date.now;
  let now = fixedNow;
  Date.now = () => now;
  const sentOrderIds = [];
  try {
    const summary = await retryPendingSheetSync(db, {
      limit: 10,
      deadlineMs: 20_000,
      append: async (order) => {
        sentOrderIds.push(order.id);
        now += 4_100;
        return { row: 130 + sentOrderIds.length, deduplicated: false };
      },
    });

    assert.deepEqual(sentOrderIds, [801]);
    assert.equal(summary.attempted, 1);
    assert.equal(summary.synced, 1);
    assert.equal(db.jobs.get(801).status, 'synced');
    assert.equal(db.jobs.get(802).status, 'pending');
    assert.equal(db.jobs.get(802).attempts, 0, 'the next job must not be claimed without time to finish it');
  } finally {
    Date.now = originalDateNow;
  }
});

test('order cleanup deletes its CTE-created job through the cascade lifecycle', async () => {
  const db = new FakeOrderDb({ failProcessInsert: true });

  await assert.rejects(
    () => handlePost({ body: { client_name: 'cleanup order' } }, mockResponse(), db),
    /simulated process insert failure/,
  );

  assert.equal(db.createdJob, true, 'the outbox job must exist before the later write fails');
  assert.equal(db.cleanupDeletes, 1);
  assert.equal(db.orders.has(801), false);
  assert.equal(db.jobs.has(801), false);
});

// 필수 INSERT 가 아직 끝나지 않았다면 보상 삭제는 그대로 살아 있어야 한다 (마지막 필수 INSERT 기준).
test('a failure on the last required insert still cleans up the order it created', async () => {
  const db = new FakeOrderDb();
  const originalExecuteTransaction = db.executeTransaction.bind(db);
  db.executeTransaction = async (query) => {
    const sql = compactSql(querySql(query));
    if (/^INSERT INTO activity_feed\b/i.test(sql)) {
      throw new Error('simulated activity feed insert failure');
    }
    return originalExecuteTransaction(query);
  };

  await assert.rejects(
    () => handlePost({ body: { client_name: 'cleanup order' } }, mockResponse(), db),
    /simulated activity feed insert failure/,
  );

  assert.equal(db.cleanupDeletes, 1);
  assert.equal(db.orders.has(801), false);
  assert.equal(db.jobs.has(801), false);
});

// 2026-08 데이터 손실: 모든 필수 INSERT 가 끝난 뒤 순수 조회 SELECT 가 Neon 한도 오류를 내면
// catch 의 보상 삭제가 멀쩡한 주문을 CASCADE 로 통째 지웠다.
test('a read-back failure after the required inserts keeps the order alive', async () => {
  const db = new FakeOrderDb();
  const readFailure = new Error('Your account or project has exceeded the data transfer quota');
  readFailure.status = 503;
  const originalExecute = db.execute.bind(db);
  db.execute = async (query) => {
    const sql = compactSql(querySql(query));
    if (/^SELECT \* FROM orders WHERE id = \?/i.test(sql)) throw readFailure;
    return originalExecute(query);
  };

  await assert.rejects(
    () => handlePost({ body: { client_name: 'atomic order' } }, mockResponse(), db),
    (error) => error === readFailure,
  );

  assert.equal(db.cleanupDeletes, 0, '조회 실패로는 절대 주문을 지우면 안 된다');
  assert.equal(db.orders.has(801), true);
  assert.equal(db.jobs.has(801), true);
});

// 필수 INSERT 이후 단계(토큰/알림/시트)는 각자 삼키지만, 그 경계 자체도 삭제 대상 밖이어야 한다.
test('a failure after the required inserts never deletes the created order', async () => {
  const db = new FakeOrderDb();
  const originalExecute = db.execute.bind(db);
  db.execute = async (query) => {
    const sql = compactSql(querySql(query));
    if (/^SELECT \* FROM pre_production WHERE order_id = \?/i.test(sql)) {
      throw new Error('simulated read outage');
    }
    return originalExecute(query);
  };

  await assert.rejects(
    () => handlePost({ body: { client_name: 'atomic order' } }, mockResponse(), db),
    /simulated read outage/,
  );

  assert.equal(db.cleanupDeletes, 0);
  assert.equal(db.orders.has(801), true);
});

test('dedicated sheet-sync cron is CRON_SECRET protected and leaves notification sweep unchanged', async () => {
  const { handleSheetSyncCron } = await import('../api/cron/sheet-sync.js');
  const originalSecret = process.env.CRON_SECRET;
  process.env.CRON_SECRET = 'sheet-sync-secret';
  try {
    let retryCalls = 0;
    const db = { async execute() { return { rows: [] }; } };
    const unauthorized = mockResponse();
    await handleSheetSyncCron({ method: 'GET', headers: {} }, unauthorized, db, {
      retry: async () => { retryCalls += 1; },
    });
    assert.equal(unauthorized.statusCode, 401);
    assert.equal(retryCalls, 0);

    const authorized = mockResponse();
    await handleSheetSyncCron({
      method: 'GET',
      headers: { authorization: 'Bearer sheet-sync-secret' },
    }, authorized, db, {
      retry: async (_db, options) => {
        retryCalls += 1;
        assert.deepEqual(options, { limit: 10, deadlineMs: 20_000 });
        return { attempted: 1, synced: 1, failed: 0, skipped: 0, errors: [] };
      },
    });
    assert.equal(authorized.statusCode, 200);
    assert.equal(authorized.body.ok, true);
    assert.equal(authorized.body.synced, 1);
    assert.equal(retryCalls, 1);
  } finally {
    if (originalSecret === undefined) delete process.env.CRON_SECRET;
    else process.env.CRON_SECRET = originalSecret;
  }

  const vercelConfig = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(
    vercelConfig.crons.find((cron) => cron.path === '/api/cron/sweep'),
    { path: '/api/cron/sweep', schedule: '30 23 * * *' },
  );
  const sheetCron = vercelConfig.crons.filter((cron) => cron.path === '/api/cron/sheet-sync');
  assert.equal(sheetCron.length, 1);
  assert.match(sheetCron[0].schedule, /^\S+ \S+ \* \* \*$/);
});
