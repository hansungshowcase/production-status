import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
  countSalesOrders,
  filterSalesOrders,
  getVisibleSalesOrders,
  isOverdue,
  isPackingCompletedForShipping,
  isShipped,
} from '../src/pages/salesOrderFilters.js';

const salesPageSource = readFileSync(new URL('../src/pages/SalesMyPage.jsx', import.meta.url), 'utf8');
const salesOrderCardSource = readFileSync(new URL('../src/components/sales/SalesOrderCard.jsx', import.meta.url), 'utf8');

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

test('a shipped order can never remain in overdue or in-production filters', () => {
  const shippedByStatus = order(1, {}, { status: 'shipped', ship_date: '2026-06-20' });
  const shippedByDate = order(2, {}, { status: 'in_production', ship_date: '2026-06-21' });
  const overdue = order(3, {});
  const orders = [shippedByStatus, shippedByDate, overdue];

  assert.equal(isShipped(shippedByStatus), true);
  assert.equal(isShipped(shippedByDate), true);
  assert.equal(isOverdue(shippedByStatus), false);
  assert.equal(isOverdue(shippedByDate), false);
  assert.deepEqual(filterSalesOrders(orders, 'shipped').map(item => item.id), [1, 2]);
  assert.deepEqual(filterSalesOrders(orders, 'in_production').map(item => item.id), [3]);
  assert.deepEqual(filterSalesOrders(orders, 'overdue').map(item => item.id), [3]);
});

test('sales shipping switches to the shipped tab and rejects stale order fetches', () => {
  assert.match(salesPageSource, /const ordersFetchIdRef = useRef\(0\)/);
  assert.match(salesPageSource, /if \(fetchId !== ordersFetchIdRef\.current\) return/);
  assert.match(salesPageSource, /\{ \.\.\.o, \.\.\.updated, status: 'shipped' \}/);
  assert.match(salesPageSource, /handleFilterChange\('shipped'\)/);
});

test('sales order cards prefer the live shipped state over stale expanded details', () => {
  assert.match(salesOrderCardSource, /detailOrder \? \{ \.\.\.detailOrder, \.\.\.order \} : order/);
  assert.match(salesOrderCardSource, /formatDueStatus\(displayDueDate, isShipped \? 'shipped' : displayOrder\.status\)/);
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
