import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateDeliveryAdherence } from '../api/_lib/deliveryAdherence.js';
import { parseIntegerCell } from '../api/import/csv.js';
import {
  normalizeOrderCreateInput,
  normalizeOrderMutationInput,
} from '../api/_lib/orderCreateInput.js';
import { extractQuantityFromOcrValue } from '../api/ocr/work-order.js';
import {
  createInitialOrderForm,
  normalizeQuantity,
  validateOrderEntryForm,
} from '../src/pages/orderEntryPayload.js';
import {
  MAX_QUANTITY,
  parsePositiveIntegerQuantity,
} from '../src/utils/quantity.js';

const VALID_MANUAL_FORM = {
  client_name: '한성 거래처',
  product_type: '냉장고',
  quantity: '1',
};

test('create and PATCH quantity boundaries reject missing, decorated, fractional, and non-positive values', () => {
  const invalidValues = [undefined, null, '', 0, '0', -1, '-1', 1.5, '1.5', '2대', '1대(급) 총6대', '1,340', 2147483648, '2147483648'];

  for (const quantity of invalidValues) {
    assert.throws(
      () => normalizeOrderCreateInput({ quantity }),
      /수량.*1 이상의 정수/,
      `create must reject ${String(quantity)}`,
    );
    assert.throws(
      () => normalizeOrderMutationInput({ quantity }),
      /수량.*1 이상의 정수/,
      `PATCH must reject ${String(quantity)}`,
    );
  }

  assert.equal(normalizeOrderCreateInput({ quantity: '2' }).quantity, 2);
  assert.equal(normalizeOrderMutationInput({ quantity: 3 }).quantity, 3);
  assert.equal(normalizeOrderCreateInput({ quantity: '2147483647' }).quantity, 2147483647);
  assert.equal(normalizeOrderMutationInput({ quantity: 2147483647 }).quantity, 2147483647);
  assert.deepEqual(normalizeOrderMutationInput({ notes: 'memo' }), { notes: 'memo' });
});

test('the one shared quantity parser accepts the PostgreSQL INTEGER max and rejects max plus one', () => {
  assert.equal(MAX_QUANTITY, 2147483647);
  assert.equal(parsePositiveIntegerQuantity(MAX_QUANTITY), MAX_QUANTITY);
  assert.equal(parsePositiveIntegerQuantity(String(MAX_QUANTITY)), MAX_QUANTITY);
  assert.equal(parsePositiveIntegerQuantity(MAX_QUANTITY + 1), null);
  assert.equal(parsePositiveIntegerQuantity(String(MAX_QUANTITY + 1)), null);
});

test('manual entry starts visibly at 1 but never silently persists an empty or decorated quantity', () => {
  assert.equal(createInitialOrderForm('2026-09-21').quantity, '1');
  assert.throws(() => normalizeQuantity(''), /수량.*1 이상의 정수/);
  assert.throws(() => normalizeQuantity('2대'), /수량.*1 이상의 정수/);
  assert.deepEqual(validateOrderEntryForm({ ...VALID_MANUAL_FORM, quantity: '' }, false), {
    quantity: '수량은 1 이상의 정수로 입력해주세요(최대 2147483647)',
  });
  assert.deepEqual(validateOrderEntryForm({ ...VALID_MANUAL_FORM, quantity: '1.5' }, false), {
    quantity: '수량은 1 이상의 정수로 입력해주세요(최대 2147483647)',
  });
});

test('OCR quantity extraction keeps the individual line quantity and leaves total-only or specification text blank', () => {
  assert.equal(extractQuantityFromOcrValue(2), 2);
  assert.equal(extractQuantityFromOcrValue('2'), 2);
  assert.equal(extractQuantityFromOcrValue('1대(급) 총6대'), 1);
  assert.equal(extractQuantityFromOcrValue('2대(급) 총6대'), 2);
  assert.equal(extractQuantityFromOcrValue('수량: 1대/총6대'), 1);
  assert.equal(extractQuantityFromOcrValue('총6대'), null);
  assert.equal(extractQuantityFromOcrValue('1340*760*2000'), null);
  assert.equal(extractQuantityFromOcrValue(''), null);
});

test('CSV quantity parsing requires a deliberate positive integer', () => {
  for (const value of [undefined, null, '', 0, '0', -1, '-1', 1.5, '1.5', '2대', '1,340', 2147483648, '2147483648']) {
    assert.equal(
      parseIntegerCell(value, { requiredPositive: true }).ok,
      false,
      `CSV quantity must reject ${String(value)}`,
    );
  }
  assert.deepEqual(parseIntegerCell('2', { requiredPositive: true }), { ok: true, value: 2 });
  assert.deepEqual(parseIntegerCell('2147483647', { requiredPositive: true }), { ok: true, value: 2147483647 });
});

test('OCR quantity extraction obeys the same PostgreSQL INTEGER maximum', () => {
  assert.equal(extractQuantityFromOcrValue('2147483647'), 2147483647);
  assert.equal(extractQuantityFromOcrValue('2147483648'), null);
  assert.equal(extractQuantityFromOcrValue('2147483648대'), null);
});

test('delivery totals exclude and expose invalid quantity rows instead of coercing each to one', () => {
  const result = calculateDeliveryAdherence([
    { id: 1, quantity: null, due_date: '2026-09-21' },
    { id: 2, quantity: 0, due_date: '2026-09-21' },
    { id: 3, quantity: 1.5, due_date: '2026-09-21' },
    { id: 4, quantity: '2대', due_date: '2026-09-21' },
    { id: 5, quantity: 2, due_date: '2026-09-21' },
  ], '2026-09-21');

  assert.equal(result.total_production_units, 2);
  assert.equal(result.measurable_units, 2);
  assert.equal(result.on_time_units, 2);
  assert.equal(result.invalid_quantity_orders, 4);
  assert.deepEqual(result.invalid_quantity_order_ids, [1, 2, 3, 4]);
});
