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

test('orders POST prepares the optional schema before opening its write transaction', async () => {
  assert.equal(
    typeof ordersModule.handlePost,
    'function',
    'orders POST needs an injectable handler export for behavioral regression coverage',
  );

  const transactionReached = new Error('transaction reached');
  const events = [];
  const db = {
    async execute(query) {
      events.push({ kind: 'execute', sql: querySql(query) });
      return { rows: [] };
    },
    async transaction(mode) {
      events.push({ kind: 'transaction', mode });
      throw transactionReached;
    },
  };

  await assert.rejects(
    () => ordersModule.handlePost({
      body: { client_name: 'schema preparation regression' },
    }, mockResponse(), db),
    (error) => error === transactionReached,
  );

  assert.deepEqual(
    events.filter((event) => event.kind === 'execute').map((event) => event.sql),
    OPTIONAL_ORDER_COLUMN_STATEMENTS,
  );
  assert.deepEqual(events.at(-1), { kind: 'transaction', mode: 'write' });
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
