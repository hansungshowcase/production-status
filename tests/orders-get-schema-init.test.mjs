import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

import * as ordersModule from '../api/orders/index.js';

const OPTIONAL_ORDER_COLUMN_STATEMENTS = [
  'ALTER TABLE orders ADD COLUMN IF NOT EXISTS work_order_image_url TEXT',
  'ALTER TABLE orders ADD COLUMN IF NOT EXISTS delivery_address TEXT',
  'ALTER TABLE orders ADD COLUMN IF NOT EXISTS sale_amount DOUBLE PRECISION',
  'ALTER TABLE orders ADD COLUMN IF NOT EXISTS balance DOUBLE PRECISION',
  'ALTER TABLE orders ADD COLUMN IF NOT EXISTS freight_payment TEXT',
];

// 고객 조회 링크(track_token)는 주문 INSERT 가 직접 채우므로,
// 쓰기 트랜잭션 전에 컬럼/인덱스 보정이 끝나 있어야 한다.
const TRACK_TOKEN_SCHEMA_STATEMENTS = [
  'ALTER TABLE orders ADD COLUMN IF NOT EXISTS track_token TEXT',
  'CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_track_token ON orders (track_token)',
  "ALTER TABLE orders ADD COLUMN IF NOT EXISTS notify_state JSONB DEFAULT '{}'::jsonb",
];

const SCHEMA_DDL_PATTERN = /\b(?:ALTER|CREATE|DROP|TRUNCATE|RENAME|COMMENT|GRANT|REVOKE)\b/i;

function querySql(query) {
  return typeof query === 'string' ? query : query.sql;
}

function mockResponse() {
  return {
    body: null,
    json(payload) {
      this.body = payload;
      return this;
    },
  };
}

test('orders GET executes only read queries and never schema DDL', async () => {
  assert.equal(
    typeof ordersModule.handleGet,
    'function',
    'orders GET needs an injectable handler export for behavioral regression coverage',
  );

  const statements = [];
  const db = {
    async execute(query) {
      const sql = querySql(query);
      statements.push(sql);
      return /^\s*SELECT COUNT\(\*\) AS count\b/i.test(sql)
        ? { rows: [{ count: 0 }] }
        : { rows: [] };
    },
  };
  const res = mockResponse();

  await ordersModule.handleGet({ query: {} }, res, db);

  assert.deepEqual(res.body, { orders: [], total: 0 });
  assert.equal(statements.length, 2, 'GET should execute the list and count reads');
  for (const statement of statements) {
    assert.match(statement, /^\s*SELECT\b/i);
  }
  assert.doesNotMatch(statements.join('\n'), SCHEMA_DDL_PATTERN);
});

test('orders POST prepares the optional schema before its single atomic creation CTE', async () => {
  assert.equal(
    typeof ordersModule.handlePost,
    'function',
    'orders POST needs an injectable handler export for behavioral regression coverage',
  );

  const creationReached = new Error('creation CTE reached');
  const events = [];
  const db = {
    async execute(query) {
      const sql = querySql(query);
      events.push({ kind: 'execute', sql });
      if (/^\s*WITH inserted_order AS\s*\(/i.test(sql)) throw creationReached;
      return { rows: [] };
    },
    async transaction() {
      events.push({ kind: 'transaction' });
      throw new Error('legacy transaction API must not be used');
    },
  };

  await assert.rejects(
    () => ordersModule.handlePost({
      body: { client_name: 'schema preparation regression', quantity: 1 },
    }, mockResponse(), db, {
      requireAuth: async () => ({ role: 'sales', actor: '신은철' }),
    }),
    (error) => error === creationReached,
  );

  const creationEvent = events.at(-1);
  const executedBeforeCreation = events
    .slice(0, -1)
    .filter((event) => event.kind === 'execute')
    .map((event) => event.sql);
  assert.deepEqual(
    executedBeforeCreation.slice(0, OPTIONAL_ORDER_COLUMN_STATEMENTS.length),
    OPTIONAL_ORDER_COLUMN_STATEMENTS,
  );
  for (const statement of TRACK_TOKEN_SCHEMA_STATEMENTS) {
    assert.ok(
      executedBeforeCreation.includes(statement),
      `단일 생성 CTE 전에 실행되어야 한다: ${statement}`,
    );
  }
  assert.equal(executedBeforeCreation.some((statement) => /^\s*WITH inserted_order AS\s*\(/i.test(statement)), false);
  assert.equal(creationEvent.kind, 'execute');
  assert.match(creationEvent.sql, /^\s*WITH inserted_order AS\s*\(/i);
  assert.equal(events.some((event) => event.kind === 'transaction'), false);
});

test('migration runner executes all five optional columns with exact schema types', () => {
  const migrationUrl = new URL('../scripts/migrate.js', import.meta.url);
  const probe = `
    const executed = [];
    const { runMigrationStatements } = await import(${JSON.stringify(migrationUrl.href)});
    await runMigrationStatements({
      async query(statement) {
        executed.push(statement);
      },
    });
    process.stdout.write('\\nMIGRATION_STATEMENTS=' + JSON.stringify(executed));
  `;
  const result = spawnSync(
    process.execPath,
    ['--input-type=module', '--eval', probe],
    {
      encoding: 'utf8',
      env: { ...process.env, POSTGRES_URL: '' },
      timeout: 10_000,
    },
  );

  assert.equal(
    result.status,
    0,
    `migration probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );

  const marker = 'MIGRATION_STATEMENTS=';
  const markerIndex = result.stdout.lastIndexOf(marker);
  assert.ok(markerIndex >= 0, 'migration probe should report the statements it executed');
  const executed = JSON.parse(result.stdout.slice(markerIndex + marker.length).trim());

  for (const expected of OPTIONAL_ORDER_COLUMN_STATEMENTS) {
    const prefix = expected.slice(0, expected.lastIndexOf(' '));
    assert.deepEqual(
      executed.filter((statement) => statement.startsWith(prefix)),
      [expected],
    );
  }
});
