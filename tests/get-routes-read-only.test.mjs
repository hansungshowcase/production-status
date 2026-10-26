import assert from 'node:assert/strict';
import test from 'node:test';

import * as internalNotificationsModule from '../api/internal-notifications.js';
import * as orderDetailModule from '../api/orders/[id]/index.js';
import * as workOrderImageModule from '../api/orders/[id]/work-order-image.js';
import * as trackModule from '../api/track/[token].js';

const MUTATION_PATTERN = /\b(?:ALTER|CREATE|DELETE|DROP|GRANT|INSERT|RENAME|REVOKE|TRUNCATE|UPDATE)\b/i;

function response() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name] = value;
    },
  };
}

function selectOnlyDb(respond) {
  const statements = [];
  return {
    statements,
    async execute(query) {
      const sql = String(query?.sql || query).replace(/\s+/g, ' ').trim();
      statements.push(sql);
      assert.match(sql, /^SELECT\b/i, `GET issued a non-SELECT statement: ${sql}`);
      assert.doesNotMatch(sql, MUTATION_PATTERN);
      return respond(sql, query?.args || []);
    },
  };
}

test('order detail GET reads the order graph without schema or data writes', async () => {
  assert.equal(typeof orderDetailModule.handleGet, 'function');
  const order = { id: 17, client_name: '조회 거래처', work_order_image_url: null };
  const db = selectOnlyDb((sql) => {
    if (sql === 'SELECT * FROM orders WHERE id = ?') return { rows: [order] };
    if (/^SELECT \* FROM processes p /.test(sql)) return { rows: [] };
    if (sql === 'SELECT * FROM pre_production WHERE order_id = ?') return { rows: [] };
    if (/^SELECT \* FROM issues /.test(sql)) return { rows: [] };
    if (/^SELECT \* FROM photos /.test(sql)) return { rows: [] };
    throw new Error(`Unexpected order detail query: ${sql}`);
  });
  const res = response();

  await orderDetailModule.handleGet('17', { query: { id: '17' } }, res, { db });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, {
    ...order,
    processes: [],
    pre_production: null,
    issues: [],
    photos: [],
  });
  assert.equal(db.statements.length, 5);
});

test('work-order image GET returns the stored URL with one SELECT', async () => {
  assert.equal(typeof workOrderImageModule.handleGet, 'function');
  const db = selectOnlyDb(() => ({ rows: [{ work_order_image_url: 'https://blob.example/work-order.webp' }] }));
  const res = response();

  await workOrderImageModule.handleGet({ query: { id: '17' } }, res, { db });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body, { url: 'https://blob.example/work-order.webp' });
  assert.deepEqual(db.statements, ['SELECT work_order_image_url FROM orders WHERE id = ?']);
});

test('customer track GET preserves rate limiting and response fields with SELECTs only', async () => {
  assert.equal(typeof trackModule.handleTrack, 'function');
  const order = {
    id: 17,
    order_date: '2026-10-01',
    client_name: '조회 거래처',
    sales_person: '이준형',
    door_type: '여닫이',
    width: 1200,
    depth: 600,
    height: 900,
    quantity: 2,
    color: '블랙',
    status: 'in_production',
    due_date: '2026-10-30',
    ship_scheduled_date: null,
    ship_date: null,
  };
  const processes = [{ step_name: '도면설계', status: 'in_progress' }];
  const db = selectOnlyDb((sql) => {
    if (sql === 'SELECT * FROM orders WHERE track_token = ?') return { rows: [order] };
    if (sql === 'SELECT step_name, status FROM processes WHERE order_id = ? ORDER BY id') {
      return { rows: processes };
    }
    throw new Error(`Unexpected track query: ${sql}`);
  });
  const rateLimitCalls = [];
  const res = response();

  await trackModule.handleTrack({
    method: 'GET',
    query: { token: 'abcdefghij1234567890' },
    headers: { 'x-forwarded-for': '127.0.0.1' },
    socket: { remoteAddress: '127.0.0.1' },
  }, res, {
    db,
    rateLimitCheck: (req, _res, options) => {
      rateLimitCalls.push({ url: req.url, options });
      return true;
    },
  });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.order_no, 'HS-2026-0017');
  assert.equal(res.body.client_name, '조회 거래처');
  assert.equal(res.body.manager_name, '이준형');
  assert.deepEqual(res.body.steps, processes.map(({ step_name: name, status }) => ({ name, status })));
  assert.deepEqual(rateLimitCalls, [{ url: '/api/track', options: { windowMs: 60000, max: 30 } }]);
  assert.equal(db.statements.length, 2);
});

test('internal notification history GET executes only its count and page SELECTs', async () => {
  const db = selectOnlyDb((sql) => (
    /^SELECT COUNT\(\*\) AS total/.test(sql)
      ? { rows: [{ total: 0, success: 0, failed: 0, dry_run: 0 }] }
      : { rows: [] }
  ));
  const res = response();

  await internalNotificationsModule.handleInternalNotifications({
    method: 'GET',
    query: {},
  }, res, {
    db,
    rateLimitCheck: () => true,
  });

  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.items, []);
  assert.deepEqual(res.body.counts, { total: 0, success: 0, failed: 0, dry_run: 0, delivery: { received: 0, failed: 0, pending: 0, unknown: 0 } });
  assert.equal(db.statements.length, 2);
});
