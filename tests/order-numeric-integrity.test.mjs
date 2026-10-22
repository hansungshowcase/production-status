import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  buildOrderPayload,
  mergeOcrFormValue,
  validateOrderEntryForm,
} from '../src/pages/orderEntryPayload.js';
import {
  normalizeOrderCreateInput,
  normalizeOrderMutationInput,
} from '../api/_lib/orderCreateInput.js';
import { handlePost } from '../api/orders/index.js';
import { handleUpdate } from '../api/orders/[id]/index.js';
import { balanceState } from '../src/utils/money.js';

const VALID_FORM = {
  order_date: '2026-10-22',
  due_date: '',
  sales_person: '',
  client_name: '테스트 거래처',
  phone: '',
  delivery_address: '',
  freight_payment: '',
  product_type: '제과',
  door_type: '',
  width: '',
  depth: '',
  height: '',
  quantity: '1',
  color: '',
  sale_amount: '',
  balance: '',
  lead_source: '',
  notes: '',
};

function mockResponse() {
  return {
    statusCode: null,
    body: null,
    headers: {},
    headersSent: false,
    setHeader(name, value) {
      this.headers[name] = value;
    },
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
  };
}

test('numeric inputs accept complete supported OCR shapes and preserve optional missing values', () => {
  const payload = buildOrderPayload({
    ...VALID_FORM,
    width: '1,200mm',
    depth: '1,500 mm',
    height: '높이 미기재',
    sale_amount: '',
    balance: '320,000원',
  }, null, VALID_FORM.order_date);

  assert.equal(payload.width, 1200);
  assert.equal(payload.depth, 1500);
  assert.equal(payload.height, null);
  assert.equal(payload.sale_amount, null);
  assert.equal(payload.balance, 320000);
});

test('numeric inputs reject negative and embedded-number garbage in the form boundary', () => {
  const errors = validateOrderEntryForm({
    ...VALID_FORM,
    width: '-120',
    balance: 'abc12xyz',
  });

  assert.match(errors.width, /가로.*숫자/);
  assert.match(errors.balance, /잔금.*숫자/);
  assert.throws(
    () => buildOrderPayload({ ...VALID_FORM, width: '-120' }, null, VALID_FORM.order_date),
    /가로.*숫자/,
  );
});

test('balance zero survives form, CREATE, PATCH and persisted rendering while dimension zero stays empty', () => {
  const payload = buildOrderPayload({
    ...VALID_FORM,
    width: '0',
    balance: 0,
  }, null, VALID_FORM.order_date);
  const created = normalizeOrderCreateInput({ quantity: 1, width: 0, balance: 0 });
  const patched = normalizeOrderMutationInput({ balance: '0원' });

  assert.equal(payload.width, null);
  assert.equal(payload.balance, 0);
  assert.equal(created.width, null);
  assert.equal(created.balance, 0);
  assert.deepEqual(patched, { balance: 0 });
  assert.deepEqual(balanceState(0), { kind: 'none', text: '없음' });
});

test('PATCH normalization changes only numeric fields present on the request', () => {
  const patched = normalizeOrderMutationInput({ notes: '메모', balance: '1,000원' });

  assert.equal(patched.balance, 1000);
  assert.equal(Object.hasOwn(patched, 'width'), false);
  assert.equal(Object.hasOwn(patched, 'depth'), false);
  assert.equal(Object.hasOwn(patched, 'height'), false);
  assert.equal(Object.hasOwn(patched, 'sale_amount'), false);
});

test('CREATE rejects malformed numeric input with 400 before database access', async () => {
  let databaseAccessed = false;
  const db = {
    async execute() {
      databaseAccessed = true;
      throw new Error('database must not be reached');
    },
  };
  const res = mockResponse();

  await handlePost({
    body: {
      client_name: '테스트 거래처',
      product_type: '제과',
      quantity: 1,
      balance: 'abc12xyz',
    },
  }, res, db);

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error.message, /잔금.*숫자/);
  assert.equal(databaseAccessed, false);
});

test('PATCH rejects malformed numeric input with 400 before database access', async () => {
  let databaseAccessed = false;
  const db = {
    async execute() {
      databaseAccessed = true;
      throw new Error('database must not be reached');
    },
  };
  const res = mockResponse();

  await handleUpdate('1', {
    body: { width: '-120' },
  }, res, {
    db,
    requireAuth: () => ({ role: 'sales' }),
  });

  assert.equal(res.statusCode, 400);
  assert.match(res.body.error.message, /가로.*숫자/);
  assert.equal(databaseAccessed, false);
});

test('OCR merge keeps an explicit numeric zero and ignores only missing OCR values', () => {
  assert.equal(mergeOcrFormValue(250000, 0), 0);
  assert.equal(mergeOcrFormValue(250000, ''), 250000);
  assert.equal(mergeOcrFormValue(250000, null), 250000);
});

test('edit form uses the shared numeric boundary before sending PATCH values', async () => {
  const source = await readFile(
    new URL('../src/components/order/OrderEditModal.jsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /function normalizeOptionalPositiveNumber/);
  assert.match(source, /const e = validateOrderEntryForm\(form\)/);
  assert.match(source, /const numericError = \['width', 'depth', 'height', 'sale_amount', 'balance'\]/);
  assert.match(source, /setServerError\(numericError \|\| null\)/);
  assert.match(source, /width: normalizeDimensionField\(form\.width, '가로'\)/);
  assert.match(source, /balance: normalizeMoneyField\(form\.balance, '잔금', \{ allowZero: true \}\)/);
  assert.ok(
    source.indexOf('if (!validate()) return;') < source.indexOf('await updateOrder(order.id, payload)'),
    'invalid numeric input must show the local error and return before the PATCH API call',
  );
});

test('order form renders a persisted numeric balance zero instead of an empty value', async () => {
  const source = await readFile(
    new URL('../src/components/order/OrderForm.jsx', import.meta.url),
    'utf8',
  );

  assert.match(
    source,
    /value=\{form\.balance \?\? ''\} onChange=\{inp\('balance'\)\}/,
  );
});
