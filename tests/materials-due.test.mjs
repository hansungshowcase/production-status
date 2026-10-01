import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregateMaterialOrders,
  classifyDueDate,
  filterMaterialOrders,
  getCalendarDayDifference,
  normalizeShippingStatus,
  parseMaterialsCsv,
  summarizeDueOrders,
} from '../src/utils/materials.js';

function order({
  company = '업체',
  row = 1,
  orderDate = '2026-10-01',
  dueDate = '2026-10-01',
  shipping = '',
  receipt = '완료',
  materialOrder = '완료',
  arrival = '완료',
} = {}) {
  const stage = value => ({ raw: value, status: value === '검토' ? 'needs_review' : value ? 'complete' : 'unchecked' });
  return {
    source_row: row,
    company,
    order_date: orderDate,
    due_date: dueDate,
    manager: '담당자',
    product_label: `작업 ${row}`,
    shipping: { raw: shipping, status: normalizeShippingStatus(shipping) },
    materials: { receipt: stage(receipt), order: stage(materialOrder), arrival: stage(arrival) },
  };
}

function makeMaterialsCsv(dueDate) {
  const header = Array(35).fill('');
  [['발주일', 0], ['납기일', 1], ['담당', 2], ['거래처', 3], ['출고완료일', 4],
    ['자재발주서수취', 32], ['자재발주완료', 33], ['자재입고완료', 34]]
    .forEach(([value, index]) => { header[index] = value; });
  const row = Array(35).fill('');
  row[0] = '2026-10-01';
  row[1] = dueDate;
  row[2] = '담당자';
  row[3] = '업체';
  row[32] = '완료';
  row[33] = '완료';
  row[34] = '완료';
  return [...Array.from({ length: 4 }, (_, index) => [`메타${index + 1}`]), header, row]
    .map(cells => cells.join(','))
    .join('\r\n');
}

test('납기 기준일은 KST 날짜 경계와 UTC calendar ordinal을 따른다', () => {
  assert.equal(classifyDueDate(order({ dueDate: '2026-10-01' }), '2026-09-30T15:00:00.000Z').status, 'today');
  assert.equal(classifyDueDate(order({ orderDate: '2026-09-01', dueDate: '2026-09-30' }), '2026-10-01T00:00:00.000Z').days, 1);
  assert.equal(classifyDueDate(order({ dueDate: '2024-02-29', orderDate: '2024-02-01' }), '2024-03-01').days, 1);
  assert.equal(getCalendarDayDifference('2024-03-01', '2024-02-29'), 1);
  assert.equal(getCalendarDayDifference('2026-11-02', '2026-11-01'), 1);
});

test('납기 미기재·형식 오류·발주일 이전은 서로 구별되는 확인필요 사유다', () => {
  const anchor = '2026-10-01';
  assert.equal(classifyDueDate(order({ dueDate: '' }), anchor).reason, '미기재');
  assert.equal(classifyDueDate(order({ dueDate: '10. 2' }), anchor).reason, '날짜형식');
  assert.equal(classifyDueDate(order({ dueDate: '2026-02-30' }), anchor).reason, '날짜형식');
  const beforeOrder = classifyDueDate(order({ orderDate: '2026-10-10', dueDate: '2026-10-09' }), anchor);
  assert.equal(beforeOrder.status, 'needs_review');
  assert.equal(beforeOrder.reason, '발주일이전');
  assert.equal(beforeOrder.date_key, '2026-10-09');
});

test('납기 요약은 주문별 상호배타 카운트와 raw 납기일을 유지한다', () => {
  const orders = [
    order({ row: 1, orderDate: '2026-09-01', dueDate: '2026-09-28' }),
    order({ row: 2, dueDate: '2026-10-01' }),
    order({ row: 3, dueDate: '2026-10-03' }),
    order({ row: 4, dueDate: '' }),
    order({ row: 5, dueDate: '2026-09-30', orderDate: '2026-10-02' }),
  ];
  const summary = summarizeDueOrders(orders, '2026-10-01');

  assert.deepEqual(summary.counts, {
    overdue_count: 1,
    today_count: 1,
    future_count: 1,
    due_review_count: 2,
  });
  assert.equal(summary.earliest_due_date, '2026-09-28');
  assert.equal(summary.details[4].raw, '2026-09-30');
});

test('정상 미래 납기는 자재 확인필요 여부와 별개로 가장 이른 날짜가 먼저다', () => {
  const summary = aggregateMaterialOrders([
    order({ company: '정상 늦음·자재검토', row: 1, dueDate: '2026-10-30', materialOrder: '검토' }),
    order({ company: '실제 납기검토', row: 2, dueDate: '10. 2' }),
    order({ company: '정상 빠름·미체크', row: 3, dueDate: '2026-10-02', arrival: '' }),
  ], '2026-10-01');

  assert.deepEqual(summary.companies.map(company => company.company), [
    '실제 납기검토',
    '정상 빠름·미체크',
    '정상 늦음·자재검토',
  ]);
  assert.equal(summary.companies[1].due_risk, 'other');
  assert.equal(summary.companies[2].due_risk, 'other');
});

test('CSV 납기 원문은 기존처럼 바깥 공백을 정리하고 분류기는 바깥 공백에 불변이다', () => {
  const parsed = parseMaterialsCsv(makeMaterialsCsv(' 2026 / 10 / 02 ')).orders[0];
  assert.equal(parsed.due_date, '2026 / 10 / 02');
  assert.equal(classifyDueDate(parsed, '2026-10-01').status, 'future');
  assert.equal(classifyDueDate({ ...order({ dueDate: ' 2026-10-02 ' }), order_date: ' 2026-10-01 ' }, '2026-10-01').status, 'future');
});

test('업체 정렬은 납기 위험을 먼저 보여주고 선택 업체의 전체 주문 분모와 중복을 보존한다', () => {
  const orders = [
    order({ company: '미체크', row: 1, dueDate: '2026-10-04', arrival: '' }),
    order({ company: '오늘', row: 2, dueDate: '2026-10-01' }),
    order({ company: '경과', row: 3, orderDate: '2026-09-01', dueDate: '2026-09-30' }),
    order({ company: '검토', row: 4, dueDate: '10. 2', materialOrder: '검토' }),
    order({ company: '검토', row: 5, dueDate: '2026-10-03' }),
  ];
  const summary = aggregateMaterialOrders(orders, '2026-10-01');
  assert.deepEqual(summary.companies.map(company => company.company), ['경과', '오늘', '검토', '미체크']);

  const filtered = filterMaterialOrders(orders, {
    companyQuery: '검토',
    material: 'needs_review',
    fetchedAt: '2026-10-01T00:00:00.000Z',
  });
  assert.equal(filtered.length, 2);
  const filteredSummary = aggregateMaterialOrders(filtered, '2026-10-01');
  assert.equal(filteredSummary.companies[0].target_order_count, 2);
  assert.equal(filteredSummary.companies[0].orders[0].due_date, '2026-10-03');
});
