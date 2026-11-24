import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  _resetOrderIdempotencySchemaForTest,
  normalizeClientRequestId,
} from '../api/_lib/orderIdempotencySchema.js';
import { handlePost as handleOrderPost } from '../api/orders/index.js';
import { handleDelete as handleOrderDelete } from '../api/orders/[id]/index.js';
import { handleRevertProcess } from '../api/processes/[id]/revert.js';
import { SHIPPING_WEBHOOK_IMMEDIATE_TIMEOUT_MS } from '../api/_lib/googleSheets.js';
import { INLINE_PROCESS_AUTO_SEND_BUDGET_MS } from '../api/_lib/smsEventSend.js';
import { cors } from '../api/_lib/cors.js';
import { STEPS } from '../api/_lib/steps.js';

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
    headers: {},
    headersSent: false,
    setHeader(name, value) {
      this.headers[name] = value;
      return this;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    end() {
      this.headersSent = true;
      return this;
    },
  };
}

class FakeIdempotentOrderDb {
  constructor({ raceDuplicateOnInsert = false, unrecoverableUniqueError = false } = {}) {
    this.nextId = 950;
    this.orders = new Map();
    this.processes = new Map();
    this.idempotency = new Map();
    this.statements = [];
    this.raceDuplicateOnInsert = raceDuplicateOnInsert;
    this.unrecoverableUniqueError = unrecoverableUniqueError;
  }

  makeProcesses(orderId) {
    return STEPS.map((step, index) => ({
      id: orderId * 100 + index + 1,
      order_id: orderId,
      step_name: step,
      status: 'waiting',
    }));
  }

  async execute(query) {
    const sql = compactSql(querySql(query));
    const args = typeof query === 'string' ? [] : (query.args || []);
    this.statements.push({ sql, args });

    if (/^(?:ALTER TABLE|CREATE TABLE IF NOT EXISTS|CREATE UNIQUE INDEX IF NOT EXISTS)\b/i.test(sql)
      || /information_schema\.columns|pg_constraint/i.test(sql)) {
      return { rows: [] };
    }

    if (/FROM order_create_idempotency idem JOIN orders o ON o\.id = idem\.order_id/i.test(sql)) {
      const key = args[0];
      const entry = this.idempotency.get(key);
      if (!entry) return { rows: [] };
      const order = this.orders.get(entry.orderId);
      if (!order) return { rows: [] };
      return {
        rows: [{
          order_row: { ...order },
          process_rows: this.processes.get(entry.orderId) || [],
          pre_production_row: { id: 1, order_id: entry.orderId },
        }],
      };
    }

    if (/^WITH inserted_order AS\b/i.test(sql)) {
      if (this.unrecoverableUniqueError) {
        throw new Error('duplicate key value violates unique constraint "orders_pkey"');
      }
      const hasIdempotency = /inserted_idempotency AS/i.test(sql);
      const clientName = args[3];
      const trackToken = args[25];
      if (this.raceDuplicateOnInsert && hasIdempotency) {
        const key = args[args.length - 2];
        const racedId = this.nextId++;
        const racedOrder = {
          id: racedId,
          client_name: clientName,
          quantity: args[10],
          status: 'in_production',
          track_token: trackToken,
        };
        const racedProcs = this.makeProcesses(racedId);
        racedProcs[0].status = 'in_progress';
        this.orders.set(racedId, racedOrder);
        this.processes.set(racedId, racedProcs);
        this.idempotency.set(key, { orderId: racedId });
        throw new Error('duplicate key value violates unique constraint "order_create_idempotency_pkey"');
      }

      const id = this.nextId++;
      const order = {
        id,
        client_name: clientName,
        quantity: args[10],
        status: 'in_production',
        track_token: trackToken,
      };
      const procs = this.makeProcesses(id);
      this.orders.set(id, order);
      this.processes.set(id, procs);
      if (hasIdempotency) {
        const key = args[args.length - 2];
        this.idempotency.set(key, { orderId: id });
      }
      return {
        rows: [{
          order_row: { ...order },
          process_rows: procs,
          pre_production_row: { id: 1, order_id: id },
        }],
      };
    }

    throw new Error(`Unexpected SQL in FakeIdempotentOrderDb: ${sql}`);
  }
}

test('normalizeClientRequestId accepts valid idempotency keys and rejects invalid shapes', () => {
  assert.equal(normalizeClientRequestId('ord-123e4567-e89b-12d3-a456-426614174000'), 'ord-123e4567-e89b-12d3-a456-426614174000');
  assert.equal(normalizeClientRequestId('  123e4567-e89b-12d3-a456-426614174000  '), '123e4567-e89b-12d3-a456-426614174000');
  assert.equal(normalizeClientRequestId('short-key'), null);
  assert.equal(normalizeClientRequestId('bad key with spaces!!'), null);
  assert.equal(normalizeClientRequestId('x'.repeat(129)), null);
  assert.equal(normalizeClientRequestId(null), null);
  assert.equal(normalizeClientRequestId(12345678901234567), null);
});

test('handlePost deduplicates retries with the same client_request_id without duplicating orders or SMS', async () => {
  _resetOrderIdempotencySchemaForTest();
  const db = new FakeIdempotentOrderDb();
  let notifyCalls = 0;
  const deps = {
    requireAuth: async () => ({ role: 'sales', actor: '신은철' }),
    ensureTrackToken: async (_db, order) => order.track_token,
    notify: async () => { notifyCalls += 1; },
  };
  const key = 'ord-retry-safe-key-0001';

  const firstRes = mockResponse();
  await handleOrderPost(
    { headers: {}, body: { client_name: '중복방지거래처', quantity: 1, client_request_id: key } },
    firstRes,
    db,
    deps,
  );
  assert.equal(firstRes.statusCode, 201);
  assert.equal(firstRes.body.deduplicated, undefined);
  assert.equal(notifyCalls, 1);
  assert.equal(db.orders.size, 1);
  assert.equal(
    db.statements.some((s) => /^CREATE TABLE IF NOT EXISTS order_create_idempotency\b/i.test(s.sql)),
    true,
  );

  // Pretend the first request also started 도면설계 before retry hits server
  db.processes.get(firstRes.body.id)[0].status = 'in_progress';

  const retryRes = mockResponse();
  await handleOrderPost(
    { headers: {}, body: { client_name: '중복방지거래처', quantity: 1, client_request_id: key } },
    retryRes,
    db,
    deps,
  );
  assert.equal(retryRes.statusCode, 200);
  assert.equal(retryRes.body.deduplicated, true);
  assert.equal(retryRes.body.id, firstRes.body.id);
  assert.equal(retryRes.body.processes[0].status, 'in_progress');
  assert.deepEqual(retryRes.body.sheet_sync, { status: 'pending' });
  assert.equal(db.orders.size, 1);
  assert.equal(notifyCalls, 1, '중복 재시도에는 접수 문자를 다시 보내면 안 된다');
});

test('handlePost recovers a concurrent idempotency unique collision as 200 deduplicated', async () => {
  const db = new FakeIdempotentOrderDb({ raceDuplicateOnInsert: true });
  let notifyCalls = 0;
  const res = mockResponse();

  await handleOrderPost(
    {
      headers: { 'idempotency-key': 'ord-concurrent-race-key-0001' },
      body: { client_name: '경합거래처', quantity: 1 },
    },
    res,
    db,
    {
      requireAuth: async () => ({ role: 'sales', actor: '이준형' }),
      ensureTrackToken: async (_db, order) => order.track_token,
      notify: async () => { notifyCalls += 1; },
    },
  );

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.deduplicated, true);
  assert.equal(notifyCalls, 0);

  const errDb = new FakeIdempotentOrderDb({ unrecoverableUniqueError: true });
  const errRes = mockResponse();
  await handleOrderPost(
    { headers: {}, body: { client_name: '충돌거래처', quantity: 1 } },
    errRes,
    errDb,
    { requireAuth: async () => ({ role: 'sales', actor: '이준형' }) },
  );
  assert.equal(errRes.statusCode, 409);
});

test('handlePost without client_request_id keeps idempotency table untouched', async () => {
  const db = new FakeIdempotentOrderDb();
  const res = mockResponse();
  await handleOrderPost(
    { headers: {}, body: { client_name: '일반거래처', quantity: 1 } },
    res,
    db,
    {
      requireAuth: async () => ({ role: 'sales', actor: '황보민수' }),
      ensureTrackToken: async (_db, order) => order.track_token,
      notify: async () => {},
    },
  );

  assert.equal(res.statusCode, 201);
  assert.equal(db.statements.some((s) => /order_create_idempotency/i.test(s.sql)), false);
});

test('OrderEntryPage preserves submitIdempotencyKeyRef across retries and guards 도면설계 auto-start', async () => {
  const source = await readFile(new URL('../src/pages/OrderEntryPage.jsx', import.meta.url), 'utf8');

  assert.match(source, /const submitIdempotencyKeyRef = useRef\(null\);/);
  assert.match(source, /payload\.client_request_id = submitIdempotencyKeyRef\.current;/);
  assert.match(source, /await createOrder\(payload\);\s*submitIdempotencyKeyRef\.current = null;/);
  assert.match(source, /if \(firstProcess && firstProcess\.status === 'waiting'\)/);
  assert.match(source, /다시 눌러도 중복 등록되지 않습니다/);
  assert.ok(
    (source.match(/submitIdempotencyKeyRef\.current = null;/g) || []).length >= 6,
    '새 주문/OCR/폼 수정/성공 후에는 멱등 키를 초기화해야 한다',
  );
});

test('handleRevertProcess bounds inline clearShippedSheet with SHIPPING_WEBHOOK_IMMEDIATE_TIMEOUT_MS', async () => {
  const clearCalls = [];
  const db = {
    async execute({ sql }) {
      const stmt = compactSql(sql);
      if (stmt === 'SELECT * FROM processes WHERE id = ?') {
        return {
          rows: [{
            id: 880,
            order_id: 80,
            step_name: '출고',
            status: 'completed',
            completed_at: '2026-08-04T23:57:31.000Z',
          }],
        };
      }
      if (stmt === 'SELECT * FROM processes WHERE order_id = ?') {
        return {
          rows: [{
            id: 880,
            order_id: 80,
            step_name: '출고',
            status: 'completed',
            completed_at: '2026-08-04T23:57:31.000Z',
          }],
        };
      }
      throw new Error(`Unexpected revert SQL: ${stmt}`);
    },
    async atomicBatch() {
      return [{
        rows: [{
          process_row: { id: 880, order_id: 80, step_name: '출고', status: 'in_progress' },
          order_row: { id: 80, client_name: '되돌리기거래처', status: 'in_production', ship_date: null },
          reverted_ship_date: '2026-08-05',
        }],
      }];
    },
  };
  const res = mockResponse();
  const originalNow = Date.now;
  Date.now = () => Date.parse('2026-08-05T00:10:00.000Z');
  try {
    await handleRevertProcess(
      { method: 'PATCH', query: { id: '880' }, body: {} },
      res,
      {
        db,
        rateLimitCheck: () => true,
        requireWorkerAction: () => ({ actor: '김보수 팀장' }),
        clearShippedSheet: async (order, shipDate, opts) => {
          clearCalls.push({ orderId: order.id, shipDate, opts });
          return { updatedRow: 6 };
        },
      },
    );
  } finally {
    Date.now = originalNow;
  }

  assert.equal(res.statusCode, 200);
  assert.equal(clearCalls.length, 1);
  assert.deepEqual(clearCalls[0].opts, { timeoutMs: SHIPPING_WEBHOOK_IMMEDIATE_TIMEOUT_MS });
  assert.equal(SHIPPING_WEBHOOK_IMMEDIATE_TIMEOUT_MS, 5000);
});

test('handleDelete bounds inline external cleanup budget and leaves remaining targets for cron', async () => {
  let clock = 10_000;
  const cleanupCalls = [];
  const db = {
    async atomicBatch() {
      return [
        { rows: [{ id: 71, client_name: '예산거래처' }] },
        {
          rows: [
            { file_path: 'https://blob.example/1.jpg' },
            { file_path: 'https://blob.example/2.jpg' },
            { file_path: 'https://blob.example/3.jpg' },
          ],
        },
        { rows: [{ id: 71 }] },
      ];
    },
  };
  const res = mockResponse();

  await handleOrderDelete(
    '71',
    { method: 'DELETE', query: { id: '71' }, body: { actor: '삭제자', delete_context: 'sales-management' } },
    res,
    {
      db,
      requireAuth: () => ({ role: 'sales', actor: '삭제자' }),
      ensureExternalCleanupSchema: async () => {},
      inlineCleanupBudgetMs: 3500,
      now: () => clock,
      processExternalCleanupJob: async (_db, targetKey, deps) => {
        cleanupCalls.push({ targetKey, timeoutMs: deps.timeoutMs });
        clock += 2000;
      },
    },
  );

  assert.equal(res.statusCode, 200);
  assert.deepEqual(cleanupCalls, [
    { targetKey: 'sheet:order:71', timeoutMs: 3000 },
    { targetKey: 'blob:https://blob.example/1.jpg', timeoutMs: 1500 },
  ]);
});

test('interactive auto-send, photo routes, and cors slow-route warnings enforce safe bounds', async () => {
  assert.ok(INLINE_PROCESS_AUTO_SEND_BUDGET_MS <= 8000);
  const smsSrc = await readFile(new URL('../api/_lib/smsEventSend.js', import.meta.url), 'utf8');
  assert.match(smsSrc, /\+ INLINE_PROCESS_AUTO_SEND_BUDGET_MS/);

  const photoSrc = await readFile(new URL('../api/photos/[id].js', import.meta.url), 'utf8');
  assert.match(photoSrc, /fetch\(photo\.file_path, \{ signal: AbortSignal\.timeout\(10000\) \}\)/);
  assert.match(photoSrc, /timeoutMs: Math\.min\(Number\(dependencies\.timeoutMs\) \|\| 3000, 5000\)/);

  const optionsRes = mockResponse();
  await cors(async () => {})({ method: 'OPTIONS', headers: {}, url: '/api/orders' }, optionsRes);
  assert.equal(optionsRes.statusCode, 200);
  assert.match(optionsRes.headers['Access-Control-Allow-Headers'], /Idempotency-Key/);

  const warnings = [];
  const origWarn = console.warn;
  const origNow = Date.now;
  let tick = 1000;
  console.warn = (...args) => warnings.push(args.join(' '));
  Date.now = () => tick;
  try {
    await cors(async (_req, res) => {
      tick += 9000;
      return res.status(200).json({ ok: true });
    })({ method: 'GET', url: '/api/track/PRIVATE_TOKEN?secret=123', headers: {}, body: {}, auth: { role: 'sales' } }, mockResponse());

    await cors(async (_req, res) => {
      tick += 9000;
      return res.status(200).json({ ok: true });
    })({ method: 'GET', url: '/api/cron/sheet-sync', headers: {}, body: {} }, mockResponse());

    await cors(async (_req, res) => {
      tick += 9000;
      return res.status(200).json({ ok: true });
    })({ method: 'POST', url: '/api/ocr/work-order', headers: {}, body: {}, auth: { role: 'sales' } }, mockResponse());
  } finally {
    console.warn = origWarn;
    Date.now = origNow;
  }

  assert.equal(warnings.length, 1);
  assert.equal(warnings[0], '[Slow API] GET /api/track/[token] took 9000ms');
  assert.equal(warnings[0].includes('PRIVATE_TOKEN'), false);
  assert.equal(warnings[0].includes('secret=123'), false);
});
