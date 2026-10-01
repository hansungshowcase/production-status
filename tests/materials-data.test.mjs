import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregateMaterialOrders,
  filterMaterialOrders,
  normalizeMaterialStatus,
  normalizeShippingStatus,
  parseMaterialsCsv,
} from '../src/utils/materials.js';
import {
  createMaterialsDataSource,
  MATERIALS_MAX_BYTES,
} from '../api/_lib/materialsSource.js';

const REQUIRED_HEADERS = new Map([
  [0, '발주일'],
  [1, '납기일'],
  [2, '담 당'],
  [3, '거 래 처'],
  [4, '출고완료일'],
  [32, '자재 발주서수취'],
  [33, '자재 발주완료'],
  [34, '자재 입고완료'],
]);

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

function makeCsv(dataRows, headerOverrides = new Map()) {
  const header = Array(35).fill('');
  for (const [index, value] of REQUIRED_HEADERS) header[index] = value;
  for (const [index, value] of headerOverrides) header[index] = value;

  const metadata = Array.from({ length: 4 }, (_, index) => [`메타${index + 1}`]);
  return [...metadata, header, ...dataRows]
    .map(row => row.map(csvCell).join(','))
    .join('\r\n');
}

function row(values = {}) {
  const cells = Array(35).fill('');
  for (const [index, value] of Object.entries(values)) cells[Number(index)] = value;
  return cells;
}

function csvResponse(csv, options = {}) {
  return new Response(csv, {
    status: options.status ?? 200,
    headers: { 'content-type': options.contentType ?? 'text/csv; charset=utf-8' },
  });
}

test('CSV 파서는 BOM과 쉼표, 이스케이프 따옴표, 셀 내부 줄바꿈을 보존한다', () => {
  const csv = `\uFEFF${makeCsv([
    row({
      0: '10/1',
      3: '한성, "서울"\n지점',
      10: '맞춤, 쇼케이스',
      32: 'O',
    }),
  ])}`;

  const result = parseMaterialsCsv(csv);

  assert.equal(result.orders.length, 1);
  assert.equal(result.orders[0].source_row, 6);
  assert.equal(result.orders[0].company, '한성, "서울"\n지점');
  assert.equal(result.orders[0].product_label, '맞춤, 쇼케이스');
  assert.equal(result.orders[0].materials.receipt.raw, 'O');
});

test('CSV 파서는 닫히지 않은 인용 셀을 명시적 오류로 거부한다', () => {
  const csv = `${makeCsv([])}\r\n"닫히지 않음`;

  assert.throws(() => parseMaterialsCsv(csv), /CSV 형식/);
});

test('5행 필수 헤더는 공백만 정규화하고 위치 불일치를 거부한다', () => {
  const csv = makeCsv([row({ 3: '거래처' })], new Map([[33, '자재 주문완료']]));

  assert.throws(() => parseMaterialsCsv(csv), /AH.*자재발주완료/);
});

test('중복 발주 행을 모두 유지하고 완전 빈 행만 제외하며 거래처 누락을 표시한다', () => {
  const duplicate = row({ 0: '10/1', 3: '가업체', 10: '쇼케이스' });
  const result = parseMaterialsCsv(makeCsv([
    duplicate,
    duplicate,
    Array(35).fill(''),
    row({ 1: '10/9', 32: '수취완료' }),
  ]));

  assert.deepEqual(result.orders.map(item => item.source_row), [6, 7, 9]);
  assert.equal(result.orders[2].company, '거래처 미기재');
});

test('자재 세 단계는 서로 독립적으로 빈값, 완료, 확인필요를 분류한다', () => {
  const [order] = parseMaterialsCsv(makeCsv([
    row({ 3: '가업체', 32: '', 33: '미완료', 34: '입고완료' }),
  ])).orders;

  assert.equal(order.materials.receipt.status, 'unchecked');
  assert.equal(order.materials.order.status, 'needs_review');
  assert.equal(order.materials.arrival.status, 'complete');
  assert.equal(order.materials.receipt.raw, '');
  assert.equal(order.materials.order.raw, '미완료');
});

test('완료 토큰과 유효 날짜만 완료이고 임의 메모와 잘못된 날짜는 확인필요다', () => {
  const completeCases = [
    ['receipt', '수취완료'],
    ['order', '발주완료'],
    ['arrival', '자재전체입고완료'],
    ['arrival', '완료'],
    ['order', 'O'],
    ['order', '○'],
    ['order', 'check'],
    ['order', 'TRUE'],
    ['arrival', '2/29'],
    ['arrival', '9.12'],
    ['arrival', '2024-02-29'],
  ];
  for (const [stage, value] of completeCases) {
    assert.equal(normalizeMaterialStatus(value, stage), 'complete', `${stage}: ${value}`);
  }

  const reviewCases = ['미완료', '재고제품', '덧방', '테스트', '2/30', '13.1', '2025-02-29'];
  for (const value of reviewCases) {
    assert.equal(normalizeMaterialStatus(value, 'arrival'), 'needs_review', value);
  }
  assert.equal(normalizeMaterialStatus('   ', 'arrival'), 'unchecked');
});

test('출고 완료는 명시 문자열과 유효한 날짜만 인정하고 포장 및 설비 메모를 완료로 보지 않는다', () => {
  for (const value of ['출고완료', '출고완료 · 2026-10-01', '10/1', '10.1', '2024-02-29']) {
    assert.equal(normalizeShippingStatus(value), 'complete', value);
  }
  for (const value of ['미출고완료', '포장완료', '설비완료', '-', '2025-02-29', '출고완료 · 2025-02-29']) {
    assert.notEqual(normalizeShippingStatus(value), 'complete', value);
  }
});

test('필터된 전체 주문을 기준으로 업체별 분모와 단계별 완료 수를 집계한다', () => {
  const orders = parseMaterialsCsv(makeCsv([
    row({ 3: '나업체', 4: '', 32: '완료', 33: '미완료', 34: '' }),
    row({ 3: '가업체', 4: '출고완료', 32: '완료', 33: '완료', 34: '완료' }),
    row({ 3: '가업체', 4: '', 32: '완료', 33: '발주완료', 34: '테스트' }),
    row({ 3: '다업체', 4: '', 32: '', 33: '', 34: '' }),
  ])).orders;

  const visible = filterMaterialOrders(orders, {
    companyQuery: '업체',
    shipping: 'exclude_shipped',
    material: 'incomplete',
  });
  const summary = aggregateMaterialOrders(visible);

  assert.equal(summary.total_orders, 3);
  assert.deepEqual(summary.companies.map(company => company.company), ['가업체', '나업체', '다업체']);
  assert.equal(summary.companies[0].target_order_count, 1);
  assert.equal(summary.companies[0].stages.receipt.complete_count, 1);
  assert.equal(summary.companies[0].stages.order.complete_count, 1);
  assert.equal(summary.companies[0].stages.arrival.complete_count, 0);
  assert.deepEqual(summary.companies[0].orders.map(item => item.source_row), [8]);
});

test('상류 HTTP 실패, HTML 로그인 응답, 손상 CSV를 빈 성공으로 바꾸지 않는다', async () => {
  const cases = [
    {
      name: 'HTTP',
      fetchImpl: async () => csvResponse('실패', { status: 503 }),
      pattern: /Google 시트 응답 오류/,
    },
    {
      name: 'HTML',
      fetchImpl: async () => csvResponse('<!doctype html><title>로그인</title>', { contentType: 'text/html' }),
      pattern: /CSV가 아닌 응답/,
    },
    {
      name: 'CSV',
      fetchImpl: async () => csvResponse(`${makeCsv([])}\r\n"손상`),
      pattern: /CSV 형식/,
    },
  ];

  for (const fixture of cases) {
    const source = createMaterialsDataSource({ fetchImpl: fixture.fetchImpl });
    await assert.rejects(source.load(), fixture.pattern, fixture.name);
  }
});

test('10초 제한을 적용할 수 있고 다운로드 최대 크기를 넘으면 중단한다', async () => {
  const timeoutFetch = (_url, { signal }) => new Promise((resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true });
  });
  const timeoutSource = createMaterialsDataSource({ fetchImpl: timeoutFetch, timeoutMs: 5 });

  await assert.rejects(timeoutSource.load(), /시간이 초과/);

  const oversizedSource = createMaterialsDataSource({
    fetchImpl: async () => csvResponse('123456789'),
    maxBytes: 8,
  });
  await assert.rejects(oversizedSource.load(), /크기 제한/);
  assert.equal(MATERIALS_MAX_BYTES, 3 * 1024 * 1024);
});

test('60초 이내 캐시를 재사용하고 수동 갱신은 우회하며 실제 조회 완료 시각을 기록한다', async () => {
  let calls = 0;
  let now = Date.parse('2026-10-01T00:00:00.000Z');
  const source = createMaterialsDataSource({
    now: () => now,
    fetchImpl: async () => {
      calls += 1;
      return csvResponse(makeCsv([row({ 3: `업체${calls}` })]));
    },
  });

  const first = await source.load();
  now += 30_000;
  const cached = await source.load();
  now += 1_000;
  const refreshed = await source.load({ refresh: true });
  now += 60_001;
  const expired = await source.load();

  assert.equal(calls, 3);
  assert.equal(cached.orders[0].company, first.orders[0].company);
  assert.equal(first.fetched_at, '2026-10-01T00:00:00.000Z');
  assert.equal(refreshed.orders[0].company, '업체2');
  assert.equal(expired.orders[0].company, '업체3');
});

test('진행 중인 시트 조회는 일반 요청과 수동 갱신 요청에 함께 사용된다', async () => {
  let calls = 0;
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const source = createMaterialsDataSource({
    fetchImpl: async () => {
      calls += 1;
      await gate;
      return csvResponse(makeCsv([row({ 3: '가업체' })]));
    },
  });

  const first = source.load();
  const refresh = source.load({ refresh: true });
  release();
  const [firstResult, refreshResult] = await Promise.all([first, refresh]);

  assert.equal(calls, 1);
  assert.equal(firstResult.fetched_at, refreshResult.fetched_at);
});
