import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregateMaterialOrders,
  filterMaterialOrders,
  isValidSheetDate,
  normalizeMaterialStatus,
  parseMaterialCheckDate,
  summarizeArrivalCheckNeeds,
  summarizeMaterialCheckDates,
} from '../src/utils/materials.js';

function makeOrder({ company = '업체', row = 1, receipt = '', order = '', arrival = '', dueDate = '2026-10-08' } = {}) {
  const stage = (raw, key) => ({ raw, status: normalizeMaterialStatus(raw, key) });
  return {
    source_row: row,
    company,
    order_date: '2026-09-01',
    due_date: dueDate,
    manager: '담당자',
    product_label: `작업 ${row}`,
    shipping: { raw: '', status: 'not_shipped', app_match: 'verified' },
    materials: {
      receipt: stage(receipt, 'receipt'),
      order: stage(order, 'order'),
      arrival: stage(arrival, 'arrival'),
    },
  };
}

test('체크일은 full-year와 yearless를 구분하고 달력 유효성 및 동일 날짜 표기를 검증한다', () => {
  assert.equal(parseMaterialCheckDate('2026-09-16').label, '체크 2026. 9. 16.');
  assert.equal(parseMaterialCheckDate('2026/9/16').identity, 'year:2026-09-16');
  assert.equal(parseMaterialCheckDate('9/16').label, '체크 9/16');
  assert.equal(parseMaterialCheckDate('2/29').identity, 'yearless:02-29');
  assert.equal(isValidSheetDate('2024-02-29'), true);
  assert.equal(isValidSheetDate('2025-02-29'), false);
  assert.equal(isValidSheetDate('2/30'), false);
  assert.equal(parseMaterialCheckDate('not a date'), null);
});

test('업체 체크일은 source row 순서로 정규화 중복을 제거하고 누락 완료와 연도 구분을 보존한다', () => {
  const orders = [
    makeOrder({ row: 10, receipt: '2026-09-16' }),
    makeOrder({ row: 9, receipt: '2026/9/16' }),
    makeOrder({ row: 8, receipt: '9/16' }),
    makeOrder({ row: 7, receipt: '2024-02-29' }),
    makeOrder({ row: 6, receipt: '완료' }),
    makeOrder({ row: 5, receipt: '2025-02-29' }),
  ];
  const summary = summarizeMaterialCheckDates(orders, 'receipt');

  assert.deepEqual(summary.dates.map(date => date.identity), ['year:2026-09-16', 'yearless:09-16']);
  assert.equal(summary.additional_date_count, 1);
  assert.equal(summary.missing_date_count, 1);
  assert.equal(orders[5].materials.receipt.status, 'needs_review');
});

test('입고 체크 알림은 유효한 날짜의 미체크 입고 중 지난 날짜와 오늘만 센다', () => {
  const needs = summarizeArrivalCheckNeeds([
    makeOrder({ row: 1, dueDate: '2026-10-07' }),
    makeOrder({ row: 2, dueDate: '2026-10-08' }),
    makeOrder({ row: 3, dueDate: '2026-10-09' }),
    makeOrder({ row: 4, dueDate: '2026-10-07', arrival: '완료' }),
    makeOrder({ row: 5, dueDate: '10/8' }),
    makeOrder({ row: 6, dueDate: '2026-02-30' }),
  ], '2026-10-01');

  assert.deepEqual(needs, { overdue_count: 1, today_count: 1 });
});

test('overview 분모는 매칭된 업체의 전체 주문을 유지하고 빈 집합도 세 단계 0건으로 집계한다', () => {
  const filtered = filterMaterialOrders([
    makeOrder({ company: '포함업체', row: 1, receipt: '완료', order: '' }),
    makeOrder({ company: '포함업체', row: 2, receipt: '', order: '완료' }),
    makeOrder({ company: '다른업체', row: 3, receipt: '완료', order: '완료' }),
  ], { material: 'receipt_incomplete' });
  const summary = aggregateMaterialOrders(filtered, '2026-10-01');

  assert.equal(summary.total_orders, 2);
  assert.deepEqual(summary.stages.receipt, {
    complete_count: 1,
    unchecked_count: 1,
    needs_review_count: 0,
    target_order_count: 2,
  });
  assert.deepEqual(summary.stages.order, {
    complete_count: 1,
    unchecked_count: 1,
    needs_review_count: 0,
    target_order_count: 2,
  });
  assert.equal(Object.values(summary.stages).every(stage => (
    stage.complete_count + stage.unchecked_count + stage.needs_review_count === stage.target_order_count
  )), true);

  const empty = aggregateMaterialOrders([], '2026-10-01');
  for (const stage of Object.values(empty.stages)) {
    assert.deepEqual(stage, { complete_count: 0, unchecked_count: 0, needs_review_count: 0, target_order_count: 0 });
  }
});

test('overview 집계는 40개사 창과 독립적으로 고정 범위 전체 41개사를 센다', () => {
  const summary = aggregateMaterialOrders(Array.from({ length: 41 }, (_, index) => makeOrder({
    company: `업체${index + 1}`,
    row: index + 1,
    receipt: index % 2 === 0 ? '완료' : '',
  })), '2026-10-01');

  assert.equal(summary.stages.receipt.target_order_count, 41);
  assert.equal(summary.stages.receipt.complete_count, 21);
  assert.equal(summary.stages.receipt.unchecked_count, 20);
});
