import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { handlePost } from '../api/orders/index.js';
import { handleCsvImport } from '../api/import/csv.js';

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

// api/orders/index.js handlePost 의 SQL 만 알아듣는 최소 가짜 DB.
// 모르는 SQL 은 던져서 예상 못한 경로가 드러나게 한다.
class FakeOrderDb {
  constructor({ failAfterCommit = false } = {}) {
    this.orders = new Map();
    this.statements = [];
    this.nextId = 901;
    this.failAfterCommit = failAfterCommit;
    this.orderInsertColumns = null;
  }

  async transaction() {
    return {
      execute: (query) => this.execute(query),
      commit: async () => {},
      rollback: async () => {},
    };
  }

  async execute(query) {
    const sql = compactSql(querySql(query));
    const args = typeof query === 'string' ? [] : (query.args || []);
    this.statements.push({ sql, args });

    if (/^(?:ALTER TABLE|CREATE TABLE IF NOT EXISTS|CREATE UNIQUE INDEX IF NOT EXISTS)\b/i.test(sql)) {
      return { rows: [] };
    }
    if (/information_schema\.columns/i.test(sql)) return { rows: [] };

    // 커밋 직후 재조회 단계에서 터지는 상황(구 코드에서 토큰 미발급 주문이 남던 지점)
    if (this.failAfterCommit && /^SELECT \* FROM processes WHERE order_id = /i.test(sql)) {
      throw new Error('simulated post-commit read failure');
    }

    if (/INSERT INTO orders\b/i.test(sql)) {
      const columns = sql.match(/INSERT INTO orders \(([^)]*)\)/i)[1]
        .split(',').map(part => part.trim()).filter(Boolean);
      this.orderInsertColumns = columns;
      const row = { id: this.nextId++, status: 'in_production' };
      let argIndex = 0;
      for (const column of columns) {
        if (column === 'status') continue; // 리터럴 'in_production'
        row[column] = args[argIndex++];
      }
      this.orders.set(row.id, row);
      return { rows: [{ id: row.id }] };
    }

    if (/^INSERT INTO processes\b/i.test(sql)) return { rows: [] };
    if (/^INSERT INTO pre_production\b/i.test(sql)) return { rows: [] };
    if (/^INSERT INTO activity_feed\b/i.test(sql)) return { rows: [] };
    if (/^INSERT INTO sheet_sync_jobs\b/i.test(sql)) return { rows: [] };

    if (/^SELECT \* FROM orders WHERE id = /i.test(sql)) {
      const row = this.orders.get(Number(args[0]));
      return { rows: row ? [{ ...row }] : [] };
    }
    if (/^SELECT track_token FROM orders WHERE id = /i.test(sql)) {
      const row = this.orders.get(Number(args[0]));
      return { rows: row ? [{ track_token: row.track_token ?? null }] : [] };
    }
    if (/^SELECT \* FROM processes WHERE order_id = /i.test(sql)) return { rows: [] };
    if (/^SELECT \* FROM pre_production WHERE order_id = /i.test(sql)) return { rows: [] };
    if (/^UPDATE sheet_sync_jobs\b/i.test(sql)) return { rows: [] };
    if (/^SELECT .* FROM sheet_sync_jobs\b/i.test(sql)) return { rows: [] };
    // 알림 멱등키 선점 실패 = 발송 안 함. 이 테스트의 관심사가 아니므로 조용히 통과시킨다.
    if (/^UPDATE orders SET notify_state\b/i.test(sql)) return { rows: [] };

    throw new Error(`Unexpected fake order SQL: ${sql}`);
  }
}

const noopAppend = async () => ({ row: 1 });

test('주문을 만들면 고객 조회 토큰이 반드시 함께 발급된다', async () => {
  const db = new FakeOrderDb();
  const res = mockResponse();

  await handlePost({ body: { client_name: '토큰거래처' } }, res, db, { append: noopAppend });

  assert.equal(res.statusCode, 201);
  const created = [...db.orders.values()][0];
  assert.ok(created, '주문이 생성되어야 한다');
  assert.equal(typeof created.track_token, 'string');
  assert.ok(created.track_token.length >= 20, `토큰이 너무 짧다: ${created.track_token}`);
  assert.match(created.track_token, /^[A-Za-z0-9_-]+$/, '조회 링크에 그대로 들어가는 base64url 이어야 한다');
  assert.equal(res.body.track_token, created.track_token, '응답에도 발급된 토큰이 실려야 한다');

  // 스키마 보정(컬럼/유니크 인덱스)이 주문 INSERT 보다 먼저 끝나 있어야 한다.
  // ensureNotifySchema 는 모듈 캐시라 이 파일에서 처음 호출되는 여기서만 관찰된다.
  const schemaIndex = db.statements.findIndex(
    ({ sql }) => /^ALTER TABLE orders ADD COLUMN IF NOT EXISTS track_token TEXT$/i.test(sql),
  );
  const indexIndex = db.statements.findIndex(
    ({ sql }) => /^CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_track_token\b/i.test(sql),
  );
  const insertIndex = db.statements.findIndex(({ sql }) => /INSERT INTO orders\b/i.test(sql));
  assert.ok(schemaIndex >= 0, 'track_token 컬럼 보정이 실행되어야 한다');
  assert.ok(indexIndex >= 0, 'track_token 유니크 인덱스 보정이 실행되어야 한다');
  assert.ok(schemaIndex < insertIndex, '컬럼 보정이 주문 INSERT 보다 먼저여야 한다');
  assert.ok(indexIndex < insertIndex, '인덱스 보정이 주문 INSERT 보다 먼저여야 한다');
});

test('토큰은 사후 훅이 아니라 주문 INSERT 안에서 채워진다', async () => {
  const db = new FakeOrderDb();
  await handlePost({ body: { client_name: '원자성거래처' } }, mockResponse(), db, { append: noopAppend });

  assert.ok(db.orderInsertColumns.includes('track_token'), 'INSERT 컬럼에 track_token 이 있어야 한다');

  const insertIndex = db.statements.findIndex(({ sql }) => /INSERT INTO orders\b/i.test(sql));
  assert.ok(insertIndex >= 0);
  const tokenUpdateIndex = db.statements.findIndex(({ sql }) => /^UPDATE orders SET track_token/i.test(sql));
  assert.equal(tokenUpdateIndex, -1, '커밋 후 별도 UPDATE(실패 시 무시됨)에 의존하면 안 된다');
});

test('커밋 후 단계가 실패해도 남은 주문에는 토큰이 이미 들어 있다', async () => {
  // 구 코드에서는 이 지점이 터지면 track_token 발급 훅(415-421행)에 도달하지 못해
  // 토큰 없는 주문이 그대로 남았다.
  const db = new FakeOrderDb({ failAfterCommit: true });

  await assert.rejects(
    () => handlePost({ body: { client_name: '커밋후실패거래처' } }, mockResponse(), db, { append: noopAppend }),
    /simulated post-commit read failure/,
  );

  const created = [...db.orders.values()][0];
  assert.ok(created, '커밋된 주문은 살아 있다');
  assert.equal(typeof created.track_token, 'string');
  assert.ok(created.track_token.length >= 20, '커밋 후 경로가 죽어도 토큰 없는 주문이 남으면 안 된다');
});

test('주문마다 서로 다른 토큰이 발급된다', async () => {
  const db = new FakeOrderDb();
  await handlePost({ body: { client_name: '거래처1' } }, mockResponse(), db, { append: noopAppend });
  await handlePost({ body: { client_name: '거래처2' } }, mockResponse(), db, { append: noopAppend });

  const tokens = [...db.orders.values()].map(order => order.track_token);
  assert.equal(tokens.length, 2);
  assert.equal(new Set(tokens).size, 2, '토큰이 중복되면 다른 고객의 주문이 보인다');
});

// ---- CSV 임포트 경로 ----

function csvRequest(csvText) {
  const boundary = '----trackTokenIssuanceBoundary';
  const body = Buffer.concat([
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="orders.csv"\r\nContent-Type: text/csv\r\n\r\n`, 'utf8'),
    Buffer.from(csvText, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);
  return {
    method: 'POST',
    url: '/api/import/csv',
    query: {},
    headers: {
      'content-type': `multipart/form-data; boundary=${boundary}`,
      'content-length': String(body.length),
    },
    socket: { remoteAddress: 'track-token-csv' },
    on(event, handler) {
      if (event === 'data') handler(body);
      if (event === 'end') handler();
      return this;
    },
  };
}

class FakeCsvDb {
  constructor() {
    this.orders = [];
    this.statements = [];
    this.nextId = 700;
    this.orderColumns = null;
  }

  async execute({ sql, args = [] }) {
    const statement = compactSql(sql);
    this.statements.push({ sql: statement, args });

    if (/^(?:ALTER TABLE|CREATE TABLE IF NOT EXISTS|CREATE UNIQUE INDEX IF NOT EXISTS)\b/i.test(statement)) return { rows: [] };
    if (/information_schema\.columns/i.test(statement)) return { rows: [] };
    if (/^SELECT id, client_name, order_date, product_type, quantity FROM orders\b/i.test(statement)) return { rows: [] };

    if (/^INSERT INTO orders \(/i.test(statement)) {
      const columns = statement.match(/INSERT INTO orders \(([^)]*)\)/i)[1]
        .split(',').map(part => part.trim()).filter(Boolean);
      this.orderColumns = columns;
      const rows = [];
      for (let offset = 0; offset < args.length; offset += columns.length) {
        const row = { id: this.nextId++ };
        columns.forEach((column, index) => { row[column] = args[offset + index]; });
        this.orders.push(row);
        rows.push({ id: row.id });
      }
      return { rows };
    }

    if (/^INSERT INTO processes\b/i.test(statement)) return { rows: [] };
    if (/^INSERT INTO pre_production\b/i.test(statement)) return { rows: [] };
    if (/^INSERT INTO sheet_sync_jobs\b/i.test(statement)) return { rows: [] };

    throw new Error(`Unexpected fake csv SQL: ${statement}`);
  }
}

test('CSV 로 가져온 주문도 행마다 고객 조회 토큰을 받는다', async () => {
  const db = new FakeCsvDb();
  const res = mockResponse();
  const csv = [
    '거래처,발주일,사양,수량,가로,세로,높이',
    'CSV거래처1,2026-08-01,쇼케이스,1,1200,600,900',
    'CSV거래처2,2026-08-02,쇼케이스,2,1000,500,800',
  ].join('\n');

  await handleCsvImport(csvRequest(csv), res, { db, requireAuth: () => ({ role: 'admin', actor: '관리자' }) });

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.imported, 2);
  assert.ok(db.orderColumns.includes('track_token'), 'CSV INSERT 도 track_token 을 채워야 한다');
  assert.equal(db.orders.length, 2);

  for (const order of db.orders) {
    assert.equal(typeof order.track_token, 'string');
    assert.ok(order.track_token.length >= 20, `CSV 주문 토큰이 비었다: ${order.client_name}`);
    assert.match(order.track_token, /^[A-Za-z0-9_-]+$/);
  }
  assert.equal(new Set(db.orders.map(o => o.track_token)).size, 2, '같은 배치 안에서도 토큰은 달라야 한다');
});

test('토큰 미발급 주문이 생길 수 있는 INSERT 경로가 남아 있지 않다', async () => {
  for (const file of ['../api/orders/index.js', '../api/import/csv.js']) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    const hasOrderInsert = /INSERT INTO orders\b/i.test(source) || /INSERT INTO \$\{|INSERT INTO orders \(\$\{/.test(source);
    if (!hasOrderInsert) continue;
    assert.match(source, /track_token/, `${file} 의 주문 INSERT 는 track_token 을 채워야 한다`);
  }

  const trackToken = await readFile(new URL('../api/_lib/trackToken.js', import.meta.url), 'utf8');
  assert.match(trackToken, /export function generateTrackToken\(\)/, '토큰 생성기는 INSERT 에서 쓸 수 있게 노출되어야 한다');
});
