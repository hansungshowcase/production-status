import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  countSalesOrders,
  filterSalesOrders,
  getVisibleSalesOrders,
  isPackingCompletedForShipping,
} from '../src/pages/salesOrderFilters.js';

const salesPageSource = readFileSync(new URL('../src/pages/SalesMyPage.jsx', import.meta.url), 'utf8');

function order(id, processSummary, extra = {}) {
  return {
    id,
    status: 'in_production',
    due_date: '2026-06-30',
    process_summary: processSummary,
    ...extra,
  };
}

test('packing completed filter includes only packing-completed orders that are not shipped', () => {
  const packingCompleted = order(1, { '포장': { status: 'completed' }, '출고': { status: 'waiting' } });
  const packingInProgress = order(2, { '포장': { status: 'in_progress' }, '출고': { status: 'waiting' } });
  const shippedAfterPacking = order(3, { '포장': { status: 'completed' }, '출고': { status: 'completed' } }, { status: 'shipped', ship_date: '2026-06-20' });
  const waiting = order(4, { '포장': { status: 'waiting' } });

  assert.equal(isPackingCompletedForShipping(packingCompleted), true);
  assert.equal(isPackingCompletedForShipping(packingInProgress), false);
  assert.equal(isPackingCompletedForShipping(shippedAfterPacking), false);
  assert.equal(isPackingCompletedForShipping(waiting), false);

  assert.deepEqual(
    filterSalesOrders([packingCompleted, packingInProgress, shippedAfterPacking, waiting], 'packing_completed').map(item => item.id),
    [1],
  );
});

test('sales order counts include packing completed count separately from shipped count', () => {
  const orders = [
    order(1, { '포장': { status: 'completed' }, '출고': { status: 'waiting' } }),
    order(2, { '포장': { status: 'completed' }, '출고': { status: 'completed' } }, { status: 'shipped', ship_date: '2026-06-20' }),
    order(3, { '포장': { status: 'in_progress' } }),
  ];

  const counts = countSalesOrders(orders);

  assert.equal(counts.totalCount, 3);
  assert.equal(counts.packingCompletedCount, 1);
  assert.equal(counts.shippedCount, 1);
});

test('sales filter tabs render the packing completed count as button text', () => {
  assert.equal(salesPageSource.includes('packing_completed: packingCompletedCount'), true);
  assert.equal(salesPageSource.includes('` (${count})`'), true);
});

test('visible sales orders limit rendering without changing full-data counts', () => {
  const orders = Array.from({ length: 165 }, (_, index) => order(index + 1, {}));
  const counts = countSalesOrders(orders);
  const initial = getVisibleSalesOrders(orders, 40);
  const next = getVisibleSalesOrders(orders, initial.visibleOrders.length + 40);

  assert.equal(counts.totalCount, 165);
  assert.equal(initial.visibleOrders.length, 40);
  assert.equal(initial.hiddenOrderCount, 125);
  assert.equal(next.visibleOrders.length, 80);
  assert.equal(next.hiddenOrderCount, 85);
});
