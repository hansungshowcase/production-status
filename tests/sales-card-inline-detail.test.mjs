import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../src/components/sales/SalesOrderCard.jsx', import.meta.url), 'utf8');

test('sales order card does not send users to a separate detail page from expanded details', () => {
  assert.equal(source.includes('sales-order-card__detail-link'), false);
  assert.equal(source.includes('navigate(`/orders/${order.id}`)'), false);
  assert.equal(source.includes('상세 페이지 열기'), false);
});

test('sales order card expanded details render core detail-page information inline', () => {
  assert.equal(source.includes('order.delivery_address'), true);
  assert.equal(source.includes('order.address'), true);
  assert.equal(source.includes('displayOrder.balance'), true);
  assert.equal(source.includes('남은 잔금'), true);
  assert.equal(source.includes('order.work_order_image_url'), true);
  assert.equal(source.includes('order.photos'), true);
  assert.equal(source.includes('order.issues'), true);
});

test('sales order card expanded details show packing photo preview and direct download', () => {
  assert.equal(source.includes('sales-order-card__packing-photo-preview'), true);
  assert.equal(source.includes('sales-order-card__packing-photo-download'), true);
  assert.equal(source.includes('download="packing-photo"'), true);
});
