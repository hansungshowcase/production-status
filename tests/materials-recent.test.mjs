import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  aggregateMaterialOrders,
  filterMaterialOrders,
  getMaterialDateRange,
  normalizeShippingStatus,
  parseOrderDate,
  scopeMaterialOrders,
} from '../src/utils/materials.js';

function order({ company = '업체', date = '2026-07-01', row = 1, shipping = '', receipt = '', materialOrder = '', arrival = '' } = {}) {
  return {
    source_row: row,
    company,
    order_date: date,
    due_date: '',
    manager: '',
    product_label: `작업 ${row}`,
    shipping: { raw: shipping, status: normalizeShippingStatus(shipping) },
    materials: {
      receipt: { raw: receipt, status: receipt ? 'complete' : 'unchecked' },
      order: { raw: materialOrder, status: materialOrder === '검토' ? 'needs_review' : materialOrder ? 'complete' : 'unchecked' },
      arrival: { raw: arrival, status: arrival ? 'complete' : 'unchecked' },
    },
  };
}

test('발주일 parser는 full-year 날짜의 공백과 점/슬래시/하이픈을 허용하고 yearless는 거부한다', () => {
  assert.deepEqual(parseOrderDate(' 2025. 7. 2 '), {
    year: 2025,
    month: 7,
    day: 2,
    key: '2025-07-02',
  });
  assert.equal(parseOrderDate('2025 / 02 / 03').key, '2025-02-03');
  assert.equal(parseOrderDate('2025-02-29'), null);
  assert.equal(parseOrderDate('7. 2'), null);
  assert.equal(parseOrderDate(''), null);
});

test('KST 기준 최근 3개월 범위는 양끝을 포함하고 월말을 clamp한다', () => {
  assert.equal(getMaterialDateRange('2026-09-30T14:59:59.000Z').end, '2026-09-30');
  assert.equal(getMaterialDateRange('2026-09-30T15:00:00.000Z').end, '2026-10-01');
  assert.deepEqual(getMaterialDateRange('2026-10-01T06:20:00.000Z'), {
    start: '2026-07-01',
    end: '2026-10-01',
  });
  assert.deepEqual(getMaterialDateRange('2024-05-31T00:00:00+09:00'), {
    start: '2024-02-29',
    end: '2024-05-31',
  });
  assert.deepEqual(getMaterialDateRange('2025-05-31T00:00:00+09:00'), {
    start: '2025-02-28',
    end: '2025-05-31',
  });
  assert.deepEqual(getMaterialDateRange('2024-03-31T00:00:00+09:00'), {
    start: '2023-12-31',
    end: '2024-03-31',
  });
});

test('최근 scope는 start/end 날짜와 unshipped만 유지하고 이전/미래/미확인 날짜를 분리한다', () => {
  const orders = [
    order({ row: 1, date: '2026-06-30' }),
    order({ row: 2, date: '2026-07-01' }),
    order({ row: 3, date: '2026-10-01' }),
    order({ row: 4, date: '2026-10-02' }),
    order({ row: 5, date: '7. 2' }),
    order({ row: 6, date: '2026/02/30' }),
    order({ row: 7, date: '', shipping: '출고 완료' }),
    order({ row: 8, date: '2026-08-01', shipping: '출고 완료' }),
    order({ row: 9, date: '2026-08-02', shipping: '포장완료' }),
  ];
  const result = scopeMaterialOrders(orders, '2026-10-01T06:20:00.000Z');

  assert.deepEqual(result.orders.map(item => item.source_row), [2, 3, 9]);
  assert.equal(result.unknown_date_count, 3);
  assert.equal(result.future_date_count, 1);
});

test('출고 완료 spelling은 정확히 인정하고 계획/설비 메모는 미출고로 남긴다', () => {
  assert.equal(normalizeShippingStatus('출고 완료'), 'complete');
  assert.equal(normalizeShippingStatus('출고완료'), 'complete');
  assert.notEqual(normalizeShippingStatus('출고 예정 · 김기사'), 'complete');
  assert.notEqual(normalizeShippingStatus('포장완료'), 'complete');
  assert.notEqual(normalizeShippingStatus('설비완료'), 'complete');
});

test('상태 필터는 매칭 주문이 있는 업체를 고르고도 업체의 전체 fixed-scope 주문과 중복을 유지한다', () => {
  const orders = [
    order({ company: '가업체', date: '2026-07-01', row: 1, receipt: '완료', materialOrder: '검토', arrival: '완료' }),
    order({ company: '가업체', date: '2026-07-02', row: 2, receipt: '완료', materialOrder: '완료', arrival: '완료' }),
    order({ company: '가업체', date: '2026-07-02', row: 3, receipt: '완료', materialOrder: '완료', arrival: '완료' }),
    order({ company: '나업체', date: '2026-08-01', row: 4, receipt: '완료', materialOrder: '완료', arrival: '' }),
  ];
  const filtered = filterMaterialOrders(orders, {
    material: 'needs_review',
    fetchedAt: '2026-10-01T06:20:00.000Z',
  });
  const summary = aggregateMaterialOrders(filtered);

  assert.deepEqual(summary.companies.map(company => company.company), ['가업체']);
  assert.equal(summary.total_orders, 3);
  assert.deepEqual(summary.companies[0].orders.map(item => item.source_row), [3, 2, 1]);
  assert.equal(summary.companies[0].target_order_count, 3);
});

test('집계 정렬과 단계 카운트는 주문 단위이며 완전 완료 미출고 업체도 남긴다', () => {
  const orders = [
    order({ company: '완료업체', row: 1, receipt: '완료', materialOrder: '완료', arrival: '완료' }),
    order({ company: '검토업체', row: 2, receipt: '완료', materialOrder: '검토', arrival: '완료' }),
    order({ company: '검토업체', row: 3, receipt: '완료', materialOrder: '검토', arrival: '' }),
    order({ company: '미체크업체', row: 4, receipt: '완료', materialOrder: '', arrival: '' }),
  ];
  const summary = aggregateMaterialOrders(orders);

  assert.deepEqual(summary.companies.map(company => company.company), ['검토업체', '미체크업체', '완료업체']);
  assert.equal(summary.companies[0].review_order_count, 2);
  assert.equal(summary.companies[0].incomplete_order_count, 2);
  assert.equal(summary.companies[0].stages.order.needs_review_count, 2);
  assert.equal(summary.companies[0].stages.arrival.unchecked_count, 1);
  assert.equal(summary.companies[2].all_complete, true);
});
