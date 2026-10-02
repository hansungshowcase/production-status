import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregateMaterialOrders,
  classifyMaterialDeadline,
  filterMaterialOrders,
  getCalendarDayDifference,
  parseMaterialsCsv,
  subtractCalendarDays,
} from '../src/utils/materials.js';

function order({ company = '업체', row = 1, orderDate = '2026-09-01', dueDate = '2026-10-08', receipt = '완료', materialOrder = '완료', arrival = '', appMatch = 'verified' } = {}) {
  const stage = value => ({ raw: value, status: value === '검토' ? 'needs_review' : value ? 'complete' : 'unchecked' });
  return {
    source_row: row,
    company,
    order_date: orderDate,
    due_date: dueDate,
    manager: '담당자',
    product_label: `작업 ${row}`,
    shipping: { raw: '', status: 'not_shipped', app_match: appMatch },
    materials: { receipt: stage(receipt), order: stage(materialOrder), arrival: stage(arrival) },
  };
}

function makeMaterialsCsv(dueDate) {
  const header = Array(35).fill('');
  [['발주일', 0], ['납기일', 1], ['담당', 2], ['거래처', 3], ['출고완료일', 4], ['자재발주서수취', 32], ['자재발주완료', 33], ['자재입고완료', 34]]
    .forEach(([value, index]) => { header[index] = value; });
  const data = Array(35).fill('');
  data[0] = '2026-10-01';
  data[1] = dueDate;
  data[2] = '담당자';
  data[3] = '업체';
  return [...Array.from({ length: 4 }, (_, index) => [`메타${index + 1}`]), header, data]
    .map(cells => cells.join(','))
    .join('\r\n');
}

test('입고마감은 KST 조회일을 기준으로 납기에서 7 calendar days를 빼며 월말과 윤년을 넘는다', () => {
  assert.equal(subtractCalendarDays('2024-03-05', 7), '2024-02-27');
  assert.equal(subtractCalendarDays('2026-01-03', 7), '2025-12-27');
  assert.equal(getCalendarDayDifference('2024-03-01', '2024-02-29'), 1);
  assert.equal(classifyMaterialDeadline(order({ dueDate: '2026-10-08' }), '2026-09-30T15:00:00.000Z').status, 'today');
});

test('입고마감은 경과·오늘·예정을 구분하고 입고 확인 주문에는 긴급 상태를 부여하지 않는다', () => {
  assert.deepEqual([
    classifyMaterialDeadline(order({ dueDate: '2026-10-07' }), '2026-10-01').status,
    classifyMaterialDeadline(order({ dueDate: '2026-10-08' }), '2026-10-01').status,
    classifyMaterialDeadline(order({ dueDate: '2026-10-09' }), '2026-10-01').status,
  ], ['overdue', 'today', 'future']);
  const confirmed = classifyMaterialDeadline(order({ dueDate: '2026-10-07', arrival: '완료' }), '2026-10-01');
  assert.equal(confirmed.status, 'arrival_complete');
  assert.equal(confirmed.deadline_state, 'overdue');
});

test('납기 미기재·yearless·invalid·발주일 이전은 확인필요이며 마감이 발주일보다 이르면 유효하게 유지한다', () => {
  assert.equal(classifyMaterialDeadline(order({ dueDate: '' }), '2026-10-01').reason, '미기재');
  assert.equal(classifyMaterialDeadline(order({ dueDate: '10. 8' }), '2026-10-01').reason, '날짜형식');
  assert.equal(classifyMaterialDeadline(order({ dueDate: '2026-02-30' }), '2026-10-01').reason, '날짜형식');
  assert.equal(classifyMaterialDeadline(order({ orderDate: '2026-10-10', dueDate: '2026-10-09' }), '2026-10-01').reason, '발주일이전');
  const startedLate = classifyMaterialDeadline(order({ orderDate: '2026-10-05', dueDate: '2026-10-10' }), '2026-10-06');
  assert.equal(startedLate.deadline_date_key, '2026-10-03');
  assert.equal(startedLate.started_after_deadline, true);
  assert.equal(startedLate.status, 'overdue');
});

test('업체 대표 주문은 선택 rank 안에서 납기와 입고마감이 같은 주문 쌍이며 invalid 주문은 다른 날짜를 훔치지 않는다', () => {
  const summary = aggregateMaterialOrders([
    order({ company: '경과업체', row: 11, dueDate: '2026-10-07' }),
    order({ company: '경과업체', row: 12, dueDate: '2026-10-06' }),
    order({ company: '검토업체', row: 21, dueDate: '' }),
    order({ company: '검토업체', row: 22, dueDate: '2026-10-20', materialOrder: '검토', arrival: '완료' }),
  ], '2026-10-01');
  const overdue = summary.companies.find(company => company.company === '경과업체');
  assert.equal(overdue.representative_order.source_row, 12);
  assert.equal(overdue.representative_order.deadline.due_date_key, '2026-10-06');
  assert.equal(overdue.representative_order.deadline.deadline_date_key, '2026-09-29');
  const review = summary.companies.find(company => company.company === '검토업체');
  assert.equal(review.representative_order.source_row, 22);
  assert.equal(review.representative_order.deadline.due_date_key, '2026-10-20');
  assert.equal(review.representative_order.deadline.deadline_date_key, '2026-10-13');
});

test('업체 정렬은 다섯 rank와 각 rank의 계약 tie-break를 따른다', () => {
  const summary = aggregateMaterialOrders([
    order({ company: '경과', row: 1, dueDate: '2026-10-07' }),
    order({ company: '오늘', row: 2, dueDate: '2026-10-08' }),
    order({ company: '검토적음', row: 3, dueDate: '', arrival: '완료' }),
    order({ company: '검토많음', row: 4, dueDate: '', arrival: '완료' }),
    order({ company: '검토많음', row: 5, dueDate: '2026-10-20', materialOrder: '검토' }),
    order({ company: '미래', row: 6, dueDate: '2026-10-09' }),
    order({ company: '입고확인', row: 7, dueDate: '2026-09-30', arrival: '완료' }),
  ], '2026-10-01');
  assert.deepEqual(summary.companies.map(company => company.company), ['경과', '오늘', '검토많음', '검토적음', '미래', '입고확인']);
  assert.deepEqual(summary.companies.map(company => company.priority_rank), [1, 2, 3, 3, 4, 5]);
  assert.equal(summary.companies.at(-1).representative_order.due.status, 'overdue');
});

test('여섯 필터는 선택 업체의 전체 fixed-scope 주문과 단계 분모 C+U+R=N을 보존한다', () => {
  const orders = [
    order({ company: '가업체', row: 1, dueDate: '2026-10-20', materialOrder: '검토' }),
    order({ company: '가업체', row: 2, dueDate: '2026-10-21', arrival: '완료' }),
    order({ company: '가업체', row: 3, dueDate: '2026-10-22', receipt: '', arrival: '완료' }),
    order({ company: '나업체', row: 4, dueDate: '2026-10-23', arrival: '' }),
  ];
  for (const material of ['all', 'incomplete', 'needs_review', 'receipt_incomplete', 'order_incomplete', 'arrival_incomplete']) {
    const filtered = filterMaterialOrders(orders, { companyQuery: '가업체', material, fetchedAt: '2026-10-01T00:00:00.000Z' });
    if (filtered.length === 0) continue;
    const company = aggregateMaterialOrders(filtered, '2026-10-01').companies[0];
    assert.equal(company.target_order_count, 3, material);
    for (const count of Object.values(company.stages)) {
      assert.equal(count.complete_count + count.unchecked_count + count.needs_review_count, count.target_order_count);
    }
  }
});

test('CSV 납기 원문은 바깥 공백을 정리하고 deadline 분류는 같은 날짜를 사용한다', () => {
  const parsed = parseMaterialsCsv(makeMaterialsCsv(' 2026 / 10 / 09 ')).orders[0];
  assert.equal(parsed.due_date, '2026 / 10 / 09');
  assert.equal(classifyMaterialDeadline(parsed, '2026-10-01').status, 'future');
  assert.equal(classifyMaterialDeadline(parsed, '2026-10-01').deadline_date_key, '2026-10-02');
});
