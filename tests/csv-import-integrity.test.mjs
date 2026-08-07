import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { handleCsvImport } from '../api/import/csv.js';
import { summarizeCsvImportResult } from '../src/utils/importResult.js';

const csvSource = readFileSync(new URL('../api/import/csv.js', import.meta.url), 'utf8');
const importSectionSource = readFileSync(
  new URL('../src/components/admin/ImportSection.jsx', import.meta.url),
  'utf8',
);

const ORDER_COLUMNS = [
  'order_date', 'due_date', 'sales_person', 'client_name', 'ship_date',
  'product_type', 'door_type', 'design', 'width', 'depth', 'height',
  'quantity', 'color', 'notes', 'status', 'track_token',
];

function makeDb({ existingOrders = [], failDuplicateLookup = false } = {}) {
  const state = {
    statements: [],
    orders: [],
    processes: [],
    preProduction: [],
    sheetSyncJobs: [],
  };
  let nextId = 500;

  return {
    state,
    async execute({ sql, args = [] }) {
      const statement = String(sql).replace(/\s+/g, ' ').trim();
      state.statements.push({ sql: statement, args });

      if (/^CREATE TABLE IF NOT EXISTS sheet_sync_jobs\b/i.test(statement)) return { rows: [] };
      // 고객 조회 링크(track_token) 컬럼/인덱스 보정 — 발송이 아니라 스키마 준비다.
      if (/^ALTER TABLE orders ADD COLUMN IF NOT EXISTS (?:track_token|notify_state)\b/i.test(statement)) return { rows: [] };
      if (/^CREATE UNIQUE INDEX IF NOT EXISTS idx_orders_track_token\b/i.test(statement)) return { rows: [] };
      if (/^CREATE TABLE IF NOT EXISTS notification_log\b/i.test(statement)) return { rows: [] };
      if (/^ALTER TABLE sheet_sync_jobs\b/i.test(statement)) return { rows: [] };
      if (/information_schema\.columns/i.test(statement)) return { rows: [] };

      if (/^SELECT id, client_name, order_date, product_type, quantity FROM orders\b/i.test(statement)) {
        if (failDuplicateLookup) throw new Error('connection terminated unexpectedly');
        return { rows: existingOrders.filter((row) => args.includes(row.client_name)) };
      }

      if (/^INSERT INTO orders \(/i.test(statement)) {
        const rows = [];
        for (let offset = 0; offset < args.length; offset += ORDER_COLUMNS.length) {
          const values = {};
          ORDER_COLUMNS.forEach((column, index) => {
            values[column] = args[offset + index];
          });
          // Postgres 흉내: INTEGER 컬럼에 NaN 이 들어오면 그 청크 전체가 거절된다.
          for (const column of ['width', 'depth', 'height', 'quantity']) {
            if (typeof values[column] === 'number' && Number.isNaN(values[column])) {
              throw new Error('invalid input syntax for type integer: "NaN"');
            }
          }
          const id = nextId++;
          state.orders.push({ id, ...values });
          rows.push({ id });
        }
        return { rows };
      }

      if (/^INSERT INTO processes \(/i.test(statement)) {
        for (let offset = 0; offset < args.length; offset += 2) {
          state.processes.push({ order_id: args[offset], step_name: args[offset + 1] });
        }
        return { rows: [] };
      }

      if (/^INSERT INTO pre_production \(/i.test(statement)) {
        for (const orderId of args) state.preProduction.push({ order_id: orderId });
        return { rows: [] };
      }

      if (/^INSERT INTO sheet_sync_jobs \(/i.test(statement)) {
        for (const orderId of args) state.sheetSyncJobs.push({ order_id: orderId, status: 'pending' });
        return { rows: [] };
      }

      if (/^DELETE FROM orders WHERE id IN\b/i.test(statement)) {
        state.orders = state.orders.filter((order) => !args.includes(order.id));
        return { rows: [] };
      }

      // 알림(maybeNotify)이나 그 밖의 예상 못한 쓰기는 여기서 드러난다.
      throw new Error(`Unhandled SQL in csv import fake DB: ${statement}`);
    },
  };
}

function csvRequest(csvText, query = {}) {
  const boundary = '----csvImportIntegrityBoundary';
  const body = Buffer.concat([
    Buffer.from(
      `--${boundary}\r\n`
      + 'Content-Disposition: form-data; name="file"; filename="orders.csv"\r\n'
      + 'Content-Type: text/csv\r\n\r\n',
      'utf8',
    ),
    Buffer.from(csvText, 'utf8'),
    Buffer.from(`\r\n--${boundary}--\r\n`, 'utf8'),
  ]);

  return {
    method: 'POST',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    query,
    body,
  };
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

function dependencies(db, overrides = {}) {
  return {
    db,
    requireAuth: () => ({ role: 'admin', actor: '관리자' }),
    ...overrides,
  };
}

const HEADER_ROW = '거래처,발주일,사양,수량,가로,세로,높이';

// 첫 테스트는 ensureSheetSyncSchema 를 주입하지 않는다 —
// 실제 배선(모듈 단위 캐시)이 스키마 보정을 정말 실행하는지 확인해야 하기 때문.
test('CSV 로 만든 주문도 sheet_sync_jobs 잡을 받고, 스키마 보정이 잡 INSERT 보다 먼저 실행된다', async () => {
  const db = makeDb();
  const res = mockResponse();
  const csv = [
    HEADER_ROW,
    '시트연동거래처,2026-08-01,쇼케이스,2,1200,600,900',
    '시트연동거래처2,2026-08-02,쇼케이스,1,1000,500,800',
  ].join('\n');

  await handleCsvImport(csvRequest(csv), res, dependencies(db));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.imported, 2);
  assert.equal(res.body.errors, 0);

  const insertedIds = db.state.orders.map((order) => order.id);
  assert.equal(insertedIds.length, 2);
  assert.deepEqual(
    db.state.sheetSyncJobs,
    insertedIds.map((id) => ({ order_id: id, status: 'pending' })),
    'CSV 주문이 구글시트에 들어가려면 정상 등록 경로처럼 sheet_sync_jobs 잡이 있어야 한다',
  );

  const schemaIndex = db.state.statements.findIndex(({ sql }) => /^CREATE TABLE IF NOT EXISTS sheet_sync_jobs\b/i.test(sql));
  const jobIndex = db.state.statements.findIndex(({ sql }) => /^INSERT INTO sheet_sync_jobs \(/i.test(sql));
  assert.ok(schemaIndex >= 0, 'ensureSheetSyncSchema 가 실제로 호출되어야 한다');
  assert.ok(jobIndex > schemaIndex, '스키마 보정이 잡 INSERT 보다 먼저 끝나야 한다');
});

test('숫자로 읽을 수 없는 행만 오류로 빠지고 같은 청크의 나머지 행은 등록된다', async () => {
  const db = makeDb();
  const res = mockResponse();
  const csv = [
    HEADER_ROW,
    '정상거래처,2026-08-01,쇼케이스,2,1200,600,900',
    '가로불량거래처,2026-08-01,쇼케이스,1,1200mm,600,900',
    '수량불량거래처,2026-08-01,쇼케이스,두개,1200,600,900',
    '정상거래처2,2026-08-01,쇼케이스,3,1500,700,1000',
  ].join('\n');

  await handleCsvImport(csvRequest(csv), res, dependencies(db, { ensureSheetSyncSchema: async () => {} }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.imported, 2, '나머지 행은 정상 등록되어야 한다');
  assert.deepEqual(
    db.state.orders.map((order) => order.client_name),
    ['정상거래처', '정상거래처2'],
  );

  assert.equal(res.body.errors, 2);
  const details = res.body.errorDetails.join('\n');
  assert.match(details, /행 3/);
  assert.match(details, /가로/);
  assert.match(details, /1200mm/);
  assert.match(details, /행 4/);
  assert.match(details, /수량/);

  const orderInsertArgs = db.state.statements
    .filter(({ sql }) => /^INSERT INTO orders \(/i.test(sql))
    .flatMap(({ args }) => args);
  assert.ok(orderInsertArgs.length > 0);
  for (const value of orderInsertArgs) {
    assert.ok(
      !(typeof value === 'number' && Number.isNaN(value)),
      'NaN 이 SQL 인자로 넘어가면 안 된다',
    );
  }
});

test('중복 조회가 실패하면 중복 판정 없이 진행하지 않고 요청을 실패시킨다', async () => {
  const db = makeDb({ failDuplicateLookup: true });
  const res = mockResponse();
  const csv = [
    HEADER_ROW,
    '중복위험거래처,2026-08-01,쇼케이스,1,1200,600,900',
  ].join('\n');

  await handleCsvImport(csvRequest(csv), res, dependencies(db, { ensureSheetSyncSchema: async () => {} }));

  assert.equal(res.statusCode, 500);
  assert.equal(res.body?.error?.status, 500);
  assert.match(res.body.error.message, /중복/);
  assert.deepEqual(db.state.orders, [], '중복 판정 없이 INSERT 하면 안 된다');
  assert.deepEqual(db.state.sheetSyncJobs, []);
});

test('CSV 대량 임포트는 고객 알림을 보내지 않는다', async () => {
  const db = makeDb();
  const res = mockResponse();
  const csv = [
    HEADER_ROW,
    '과거주문거래처,2025-01-05,쇼케이스,1,1200,600,900',
  ].join('\n');

  await handleCsvImport(csvRequest(csv), res, dependencies(db, { ensureSheetSyncSchema: async () => {} }));

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.imported, 1);

  // 알림 "발송"은 notification_log INSERT / notify_state UPDATE / sms 로 드러난다.
  // 가짜 DB 는 모르는 SQL 에서 던지므로 여기까지 왔다는 것 자체가 발송이 없었다는 뜻이지만,
  // 명시적으로도 확인한다. (track_token 스키마 보정·발급은 발송이 아니므로 허용)
  const executed = db.state.statements.map(({ sql }) => sql).join('\n');
  assert.doesNotMatch(executed, /INSERT INTO notification_log/i);
  assert.doesNotMatch(executed, /UPDATE orders SET notify_state/i);
  assert.doesNotMatch(executed, /sms/i);

  assert.doesNotMatch(csvSource, /maybeNotify\s*\(/, 'CSV 임포트는 maybeNotify 를 부르면 안 된다');
  assert.doesNotMatch(csvSource, /from\s+'[^']*notify\.js'/, 'CSV 임포트는 notify 모듈을 import 하면 안 된다');
  assert.match(csvSource, /고객 알림/, '알림을 부르지 않는 이유가 주석으로 남아 있어야 한다');
});

test('가져오기 결과 요약은 실패를 성공으로 표시하지 않는다', () => {
  const allFailed = summarizeCsvImportResult({
    imported: 0,
    errors: 3,
    errorDetails: ['행 2: 실패', '행 3: 실패', '행 4: 실패'],
  });
  assert.equal(allFailed.type, 'error');
  assert.doesNotMatch(allFailed.message, /등록 완료/);
  assert.match(allFailed.message, /3건 실패/);
  assert.equal(allFailed.details.length, 3);

  const partial = summarizeCsvImportResult({
    imported: 5,
    errors: 2,
    errorDetails: ['행 2: 실패', '행 7: 실패'],
  });
  assert.equal(partial.type, 'warning');
  assert.notEqual(partial.type, 'success');
  assert.match(partial.message, /5건 등록/);
  assert.match(partial.message, /2건 실패/);
  assert.deepEqual(partial.details, ['행 2: 실패', '행 7: 실패']);

  const clean = summarizeCsvImportResult({ imported: 4, skipped: 1, errors: 0, errorDetails: [] });
  assert.equal(clean.type, 'success');
  assert.match(clean.message, /4건 등록 완료/);
  assert.match(clean.message, /중복 1건/);
  assert.deepEqual(clean.details, []);
});

test('가져오기 화면이 실패 건수와 실패 사유를 화면에 띄운다', () => {
  assert.match(importSectionSource, /summarizeCsvImportResult/);
  assert.doesNotMatch(
    importSectionSource,
    /setResult\(\{\s*type:\s*'success'/,
    '업로드 응답을 읽지 않고 성공 배너를 띄우면 안 된다',
  );
  assert.match(importSectionSource, /result\.details/, '실패 사유 목록을 렌더링해야 한다');
  assert.match(importSectionSource, /import-result-details/);
});
