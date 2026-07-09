import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  buildOrderPayload,
  normalizeOptionalPositiveNumber,
  normalizeQuantity,
} from '../src/pages/orderEntryPayload.js';
import {
  normalizeOrderCreateInput,
  normalizeOrderMutationInput,
} from '../api/_lib/orderCreateInput.js';

test('order entry payload tolerates OCR numeric text and non-positive optional sizes', () => {
  const payload = buildOrderPayload({
    order_date: '',
    due_date: '',
    sales_person: '',
    client_name: '  한성거래처  ',
    phone: '',
    product_type: '  쇼케이스  ',
    door_type: '',
    width: '1,200mm',
    depth: '0',
    height: '-',
    quantity: '2대',
    color: '',
    sale_amount: '',
    balance: '320,000원',
    delivery_address: '경기도 김포시 대곶면 대명로 484번길 190',
    freight_payment: '소비자부담',
    lead_source: '',
    notes: '',
  }, 'https://example.com/work-order.jpg', '2026-06-17');

  assert.equal(payload.order_date, '2026-06-17');
  assert.equal(payload.client_name, '한성거래처');
  assert.equal(payload.product_type, '쇼케이스');
  assert.equal(payload.width, 1200);
  assert.equal(payload.depth, null);
  assert.equal(payload.height, null);
  assert.equal(payload.quantity, 2);
  assert.equal(payload.balance, 320000);
  assert.equal(payload.delivery_address, '경기도 김포시 대곶면 대명로 484번길 190');
  assert.equal(payload.freight_payment, '소비자부담');
  assert.equal(payload.work_order_image_url, 'https://example.com/work-order.jpg');
});

test('numeric normalizers convert invalid OCR values without blocking registration', () => {
  assert.equal(normalizeOptionalPositiveNumber('1,500 mm'), 1500);
  assert.equal(normalizeOptionalPositiveNumber('0'), null);
  assert.equal(normalizeOptionalPositiveNumber(''), null);
  assert.equal(normalizeOptionalPositiveNumber('폭 미기재'), null);
  assert.equal(normalizeQuantity('3EA'), 3);
  assert.equal(normalizeQuantity('0'), 1);
  assert.equal(normalizeQuantity(''), 1);
});

test('order create input normalizes numeric fields before server validation and insert', () => {
  const normalized = normalizeOrderCreateInput({
    client_name: '한성거래처',
    product_type: '쇼케이스',
    width: '1,200mm',
    depth: '0',
    height: '높이 미기재',
    quantity: '2대',
    sale_amount: '1,500,000원',
    delivery_address: '  경기도 김포시 양촌읍 양곡로 374-3  ',
    freight_payment: '  본사부담  ',
    balance: '-',
  });

  assert.equal(normalized.width, 1200);
  assert.equal(normalized.depth, null);
  assert.equal(normalized.height, null);
  assert.equal(normalized.quantity, 2);
  assert.equal(normalized.sale_amount, 1500000);
  assert.equal(normalized.balance, null);
  assert.equal(normalized.delivery_address, '경기도 김포시 양촌읍 양곡로 374-3');
  assert.equal(normalized.freight_payment, '본사부담');
});

test('order mutation input sanitizes OCR boilerplate before DB update', () => {
  const normalized = normalizeOrderMutationInput({
    notes: 'LED \uC870\uBA85, \uB0A9\uAE30\uB294 \uBC1C\uC8FC\uC77C\uB85C\uBD80\uD130 \uCD5C\uB300 \uC77C (\uAE34\uAE09 \uBC1C\uC8FC\uAC74\uC740 \uCD5C\uC18C 4\uC77C) \uC808\uB300\uC801\uC73C\uB85C \uC9C0\uD0AC\uAC83. \uC791\uC5C5\uC9C0\uC2DC\uC11C \uC5C6\uC774 \uC791\uC5C5\uAE08\uC9C0. \uC808\uB300\uC5C4\uAE08.',
    remarks: '\uC815\uC0C1 \uBE44\uACE0',
  });

  assert.equal(normalized.notes, 'LED \uC870\uBA85');
  assert.equal(normalized.remarks, '\uC815\uC0C1 \uBE44\uACE0');
});

test('order creation insert keeps column and value counts aligned', async () => {
  const source = await readFile(new URL('../api/orders/index.js', import.meta.url), 'utf8');
  const match = source.match(/INSERT INTO orders \(([\s\S]*?)\) VALUES \(([\s\S]*?)\) RETURNING id/);

  assert.ok(match, 'orders insert statement should be present');

  const columns = match[1].split(',').map((part) => part.trim()).filter(Boolean);
  const values = match[2].split(',').map((part) => part.trim()).filter(Boolean);
  const placeholders = values.filter((value) => value === '?');

  assert.equal(columns.length, values.length);
  assert.equal(columns.at(-1), 'status');
  assert.equal(values.at(-1), "'in_production'");
  assert.equal(placeholders.length, columns.length - 1);
});
