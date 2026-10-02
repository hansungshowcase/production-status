import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  parseMaterialsMatchingRows,
  reconcileMaterialsShipping,
} from '../api/_lib/materialsShipping.js';
import { createMaterialsDataSource } from '../api/_lib/materialsSource.js';
import { scopeMaterialOrders } from '../src/utils/materials.js';

const HEADERS = new Map([
  [0, '발주일'], [1, '납기일'], [2, '담당'], [3, '거래처'], [4, '출고완료일'],
  [32, '자재발주서수취'], [33, '자재발주완료'], [34, '자재입고완료'],
]);

function values(overrides = {}) {
  return {
    order_date: '2026-09-01',
    due_date: '2026-10-10',
    manager: '담당자',
    company: '가업체',
    phone: '010-1111-2222',
    width: 1000,
    depth: 600,
    height: 900,
    quantity: 1,
    color: '백색',
    ...overrides,
  };
}

function matchingRow(sourceRow, appOrderId, overrides = {}) {
  return { source_row: sourceRow, app_order_id: appOrderId, values: values(overrides) };
}

function publicOrder(sourceRow, overrides = {}) {
  return {
    source_row: sourceRow,
    order_date: '2026-09-01',
    due_date: '2026-10-10',
    manager: '담당자',
    company: '가업체',
    product_label: `제품 ${sourceRow}`,
    shipping: { raw: '', status: 'not_shipped' },
    materials: {
      receipt: { raw: '', status: 'unchecked' },
      order: { raw: '', status: 'unchecked' },
      arrival: { raw: '', status: 'unchecked' },
    },
    ...overrides,
  };
}

function databaseOrder(id, overrides = {}) {
  const identity = values(overrides);
  return {
    id,
    order_date: identity.order_date,
    due_date: identity.due_date,
    sales_person: identity.manager,
    client_name: identity.company,
    phone: identity.phone,
    width: identity.width,
    depth: identity.depth,
    height: identity.height,
    quantity: identity.quantity,
    color: identity.color,
    status: overrides.status ?? 'in_production',
    ship_date: overrides.ship_date ?? null,
  };
}

function dbFactory(rows, calls = []) {
  return () => ({
    execute: async ({ sql }) => {
      calls.push(sql);
      return { rows };
    },
  });
}

function makeCsv(dataRows) {
  const header = Array(35).fill('');
  for (const [index, label] of HEADERS) header[index] = label;
  return [...Array.from({ length: 4 }, (_, index) => [`메타${index + 1}`]), header, ...dataRows]
    .map(row => row.map(value => String(value ?? '')).join(','))
    .join('\r\n');
}

function csvRow({ id = '', company = '가업체', product = '제품', phone = '010-1111-2222' } = {}) {
  const row = Array(35).fill('');
  row[0] = '2026. 9. 1 추가';
  row[1] = '2026/10/10';
  row[2] = '담당자';
  row[3] = company;
  row[8] = phone;
  row[10] = product;
  row[12] = '1000';
  row[14] = '600';
  row[16] = '900';
  row[17] = '1';
  row[18] = '백색';
  row[19] = id;
  return row;
}

test('직접 ID는 전역 유일할 때만 연결하고 DB에 없는 유효 ID를 legacy로 재시도하지 않는다', async () => {
  const calls = [];
  const result = await reconcileMaterialsShipping({
    orders: [publicOrder(6), publicOrder(7)],
    matchingRows: [matchingRow(6, 10), matchingRow(7, 999)],
    getDbImpl: dbFactory([databaseOrder(10, { status: 'shipped' }), databaseOrder(11)], calls),
    now: () => Date.parse('2026-10-02T00:00:00Z'),
  });

  assert.equal(calls.length, 1);
  assert.equal(result.orders[0].shipping.status, 'complete');
  assert.equal(result.orders[0].shipping.app_link, 'direct');
  assert.equal(result.orders[1].shipping.app_match, 'unmatched');
  assert.equal(result.shipping_match.unverified_count, 1);
});

test('legacy 지문은 DB에 없는 직접 ID 행까지 포함한 전체 CSV에서 유일해야 한다', async () => {
  const result = await reconcileMaterialsShipping({
    orders: [publicOrder(6), publicOrder(7)],
    matchingRows: [matchingRow(6, 999), matchingRow(7, null)],
    getDbImpl: dbFactory([databaseOrder(20, { status: 'shipped' })]),
  });

  assert.deepEqual(result.orders.map(order => order.shipping.app_match), ['unmatched', 'ambiguous']);
  assert.deepEqual(result.orders.map(order => order.shipping.status), ['not_shipped', 'not_shipped']);
});

test('중복 직접 ID는 모두 모호함이며 그 ID는 legacy 이중 연결에도 재사용하지 않는다', async () => {
  const result = await reconcileMaterialsShipping({
    orders: [publicOrder(6), publicOrder(7), publicOrder(8)],
    matchingRows: [matchingRow(6, 10), matchingRow(7, 10), matchingRow(8, null)],
    getDbImpl: dbFactory([databaseOrder(10, { status: 'shipped' })]),
  });

  assert.deepEqual(result.orders.map(order => order.shipping.app_match), ['ambiguous', 'ambiguous', 'ambiguous']);
  assert.equal(result.orders.every(order => order.shipping.status === 'not_shipped'), true);
});

test('legacy 지문은 CSV와 DB 양쪽에서 모두 유일할 때만 연결한다', async () => {
  const unique = await reconcileMaterialsShipping({
    orders: [publicOrder(6)],
    matchingRows: [matchingRow(6, null)],
    getDbImpl: dbFactory([databaseOrder(20, { status: '출고완료' })]),
  });
  assert.equal(unique.orders[0].shipping.app_link, 'legacy');
  assert.equal(unique.orders[0].shipping.status, 'complete');

  const csvDuplicate = await reconcileMaterialsShipping({
    orders: [publicOrder(6), publicOrder(7)],
    matchingRows: [matchingRow(6, null), matchingRow(7, null)],
    getDbImpl: dbFactory([databaseOrder(20)]),
  });
  assert.deepEqual(csvDuplicate.orders.map(order => order.shipping.app_match), ['ambiguous', 'ambiguous']);

  const dbDuplicate = await reconcileMaterialsShipping({
    orders: [publicOrder(6)],
    matchingRows: [matchingRow(6, null)],
    getDbImpl: dbFactory([databaseOrder(20), databaseOrder(21)]),
  });
  assert.equal(dbDuplicate.orders[0].shipping.app_match, 'ambiguous');
});

test('legacy 날짜 셀은 date prefix만 정규화하고 fallback 내부 공백을 그대로 보존한다', async () => {
  const spacedFallback = await reconcileMaterialsShipping({
    orders: [publicOrder(6)],
    matchingRows: [matchingRow(6, null, { due_date: '검토   중' })],
    getDbImpl: dbFactory([databaseOrder(20, { due_date: '검토 중', status: 'shipped' })]),
  });
  assert.equal(spacedFallback.orders[0].shipping.app_match, 'unmatched');
  assert.equal(spacedFallback.orders[0].shipping.status, 'not_shipped');

  const identicalFallback = await reconcileMaterialsShipping({
    orders: [publicOrder(6)],
    matchingRows: [matchingRow(6, null, { due_date: '검토   중' })],
    getDbImpl: dbFactory([databaseOrder(20, { due_date: '검토   중', status: 'shipped' })]),
  });
  assert.equal(identicalFallback.orders[0].shipping.app_match, 'verified');
  assert.equal(identicalFallback.orders[0].shipping.status, 'complete');

  const normalizedPrefix = await reconcileMaterialsShipping({
    orders: [publicOrder(6)],
    matchingRows: [matchingRow(6, null, { due_date: '2026. 10. 10 검토' })],
    getDbImpl: dbFactory([databaseOrder(20, { due_date: '2026-10-10', status: 'shipped' })]),
  });
  assert.equal(normalizedPrefix.orders[0].shipping.app_match, 'verified');
  assert.equal(normalizedPrefix.orders[0].shipping.status, 'complete');
});

test('앱 출고 판정 세 형식만 검증된 제품 행을 제외하고 같은 업체 다른 제품은 유지한다', async () => {
  for (const shipped of [
    { status: 'shipped' },
    { status: '출고완료' },
    { status: 'in_production', ship_date: '2026-10-01' },
  ]) {
    const result = await reconcileMaterialsShipping({
      orders: [publicOrder(6), publicOrder(7)],
      matchingRows: [matchingRow(6, 10), matchingRow(7, 11, { color: '검정' })],
      getDbImpl: dbFactory([
        databaseOrder(10, shipped),
        databaseOrder(11, { color: '검정' }),
      ]),
    });
    const scoped = scopeMaterialOrders(result.orders, '2026-10-02T00:00:00Z');
    assert.deepEqual(scoped.orders.map(order => order.source_row), [7]);
  }
});

test('CSV cache hit도 DB를 새로 조회하며 공개 응답에 private 지문 필드를 싣지 않는다', async () => {
  let fetchCalls = 0;
  let dbCalls = 0;
  const states = [databaseOrder(10), databaseOrder(10, { status: 'shipped' })];
  const source = createMaterialsDataSource({
    fetchImpl: async () => {
      fetchCalls += 1;
      return new Response(makeCsv([csvRow({ id: 10 })]), {
        status: 200,
        headers: { 'content-type': 'text/csv' },
      });
    },
    getDbImpl: () => ({
      execute: async () => ({ rows: [states[dbCalls++]] }),
    }),
    now: () => Date.parse('2026-10-02T00:00:00Z'),
  });

  const first = await source.load();
  const second = await source.load();

  assert.equal(fetchCalls, 1);
  assert.equal(dbCalls, 2);
  assert.equal(first.orders[0].shipping.status, 'not_shipped');
  assert.equal(second.orders[0].shipping.status, 'complete');
  const publicJson = JSON.stringify(second);
  for (const privateName of ['phone', 'width', 'depth', 'height', 'quantity', 'fingerprint']) {
    assert.equal(publicJson.includes(`\"${privateName}\"`), false, privateName);
  }
});

test('매칭 파서는 날짜 prefix와 T열 양의 정수만 서버 내부 identity로 읽는다', () => {
  const parsed = parseMaterialsMatchingRows(makeCsv([
    csvRow({ id: 73 }),
    csvRow({ id: 'legacy-marker', company: ' 나   업체 ' }),
  ]));

  assert.equal(parsed[0].app_order_id, 73);
  assert.equal(parsed[1].app_order_id, null);
  assert.equal(parsed[0].values.phone, '010-1111-2222');
});

test('DB 조회 실패는 빈 CSV 성공이 아니라 안전한 503으로 전파한다', async () => {
  await assert.rejects(
    reconcileMaterialsShipping({
      orders: [publicOrder(6)],
      matchingRows: [matchingRow(6, 10)],
      getDbImpl: () => ({ execute: async () => { throw new Error('database offline'); } }),
    }),
    error => error.status === 503
      && error.publicMessage === '앱 출고 상태를 확인하지 못했습니다. 다시 조회해 주세요.',
  );
});
