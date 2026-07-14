import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
  buildOrderPayload,
  normalizeOptionalPositiveNumber,
  normalizeQuantity,
  validateOrderEntryForm,
} from '../src/pages/orderEntryPayload.js';
import {
  normalizeOrderCreateInput,
  normalizeOrderMutationInput,
} from '../api/_lib/orderCreateInput.js';
import * as orderCreateInput from '../api/_lib/orderCreateInput.js';
import * as sanitizeUtils from '../api/_lib/sanitize.js';

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

test('work orders marked with Kim Bosu manager are assigned to Lee Junhyeong sales', () => {
  const payload = buildOrderPayload({
    order_date: '2026-07-07',
    due_date: '2026-07-14',
    sales_person: '김보수 팀장',
    client_name: '텐퍼센트',
    phone: '',
    product_type: '제과',
    door_type: '',
    width: '',
    depth: '',
    height: '',
    quantity: '',
    color: '',
    sale_amount: '',
    balance: '',
    delivery_address: '',
    freight_payment: '',
    lead_source: '',
    notes: '',
  }, null, '2026-07-13');

  assert.equal(payload.sales_person, '이준형');
  assert.equal(normalizeOrderCreateInput({ sales_person: '김보수 팀장' }).sales_person, '이준형');
  assert.equal(normalizeOrderMutationInput({ sales_person: ' 김보수 ' }).sales_person, '이준형');
});

test('work-order image registrations require a real canonical due date before submit', () => {
  const validBaseForm = {
    order_date: '2026-07-14',
    due_date: '',
    sales_person: '신은철',
    client_name: '한성거래처',
    phone: '',
    product_type: '제과',
    door_type: '',
    width: '',
    depth: '',
    height: '',
    quantity: '',
    color: '',
    sale_amount: '',
    balance: '',
    delivery_address: '',
    freight_payment: '',
    lead_source: '',
    notes: '',
  };

  for (const due_date of ['', '2026-7-20', '2026-02-29', '2026-04-31', '0000-01-01']) {
    assert.deepEqual(validateOrderEntryForm({ ...validBaseForm, due_date }, true), {
      due_date: '작업지시서 등록은 납기일을 입력해주세요',
    });
  }
  assert.deepEqual(validateOrderEntryForm(validBaseForm, false), {});
  assert.deepEqual(validateOrderEntryForm({ ...validBaseForm, due_date: '2026-07-20' }, true), {});
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

test('order create input rejects missing or invalid due dates when a work-order image is present', () => {
  const invalidDueDates = [
    undefined,
    null,
    '',
    '2026-7-20',
    '2026-02-29',
    '2026-04-31',
    '2026-07-20T00:00:00.000Z',
    '0000-01-01',
  ];

  for (const due_date of invalidDueDates) {
    assert.throws(
      () => normalizeOrderCreateInput({
        work_order_image_url: 'https://example.com/work-order.jpg',
        due_date,
      }),
      /work_order_image_url.*due_date.*YYYY-MM-DD/,
    );
  }
});

test('order create input permits an omitted due date without an image and real canonical dates with one', () => {
  assert.doesNotThrow(() => normalizeOrderCreateInput({ due_date: undefined }));
  assert.doesNotThrow(() => normalizeOrderCreateInput({ due_date: null, work_order_image_url: null }));
  assert.doesNotThrow(() => normalizeOrderCreateInput({
    due_date: '2028-02-29',
    work_order_image_url: 'https://example.com/work-order.jpg',
  }));
});

test('order mutation input sanitizes OCR boilerplate before DB update', () => {
  const normalized = normalizeOrderMutationInput({
    notes: 'LED \uC870\uBA85, \uB0A9\uAE30\uB294 \uBC1C\uC8FC\uC77C\uB85C\uBD80\uD130 \uCD5C\uB300 \uC77C (\uAE34\uAE09 \uBC1C\uC8FC\uAC74\uC740 \uCD5C\uC18C 4\uC77C) \uC808\uB300\uC801\uC73C\uB85C \uC9C0\uD0AC\uAC83. \uC791\uC5C5\uC9C0\uC2DC\uC11C \uC5C6\uC774 \uC791\uC5C5\uAE08\uC9C0. \uC808\uB300\uC5C4\uAE08.',
    remarks: '\uC815\uC0C1 \uBE44\uACE0',
  });

  assert.equal(normalized.notes, 'LED \uC870\uBA85');
  assert.equal(normalized.remarks, '\uC815\uC0C1 \uBE44\uACE0');
});

test('order mutation final state preserves the image-backed canonical due-date invariant', () => {
  const imageBackedOrder = {
    due_date: '2026-07-20',
    work_order_image_url: 'https://example.com/existing-work-order.jpg',
  };

  for (const mutation of [
    { due_date: null },
    { due_date: '2026-02-29' },
    { due_date: '2026-7-20' },
  ]) {
    assert.throws(
      () => orderCreateInput.assertImageBackedOrderHasCanonicalDueDate({
        ...imageBackedOrder,
        ...mutation,
      }),
      /work_order_image_url.*due_date.*YYYY-MM-DD/,
    );
  }

  assert.throws(
    () => orderCreateInput.assertImageBackedOrderHasCanonicalDueDate({
      due_date: null,
      work_order_image_url: 'https://example.com/new-work-order.jpg',
    }),
    /work_order_image_url.*due_date.*YYYY-MM-DD/,
  );

  assert.doesNotThrow(() => orderCreateInput.assertImageBackedOrderHasCanonicalDueDate({
    due_date: null,
    work_order_image_url: null,
    client_name: 'image-less order',
  }));
  assert.doesNotThrow(() => orderCreateInput.assertImageBackedOrderHasCanonicalDueDate({
    ...imageBackedOrder,
    client_name: 'unrelated update',
  }));
  assert.doesNotThrow(() => orderCreateInput.assertImageBackedOrderHasCanonicalDueDate({
    ...imageBackedOrder,
    due_date: null,
    work_order_image_url: null,
  }));
});

test('order PATCH mutation selection ignores inherited fields and preserves own normalized fields', () => {
  const allowedFields = ['due_date', 'work_order_image_url', 'delivery_address'];
  const inherited = sanitizeUtils.sanitizeInput(JSON.parse(
    '{"__proto__":{"due_date":null,"work_order_image_url":"https://example.com/inherited.jpg"}}',
  ));
  const normalizedInherited = normalizeOrderMutationInput(inherited);

  assert.equal(Object.hasOwn(inherited, 'due_date'), false);
  assert.deepEqual(
    sanitizeUtils.pickOwnAllowedFields(normalizedInherited, allowedFields),
    {},
  );

  const normalizedOwn = normalizeOrderMutationInput({
    due_date: null,
    work_order_image_url: 'https://example.com/own.jpg',
    delivery_address: '  서울시 강남구  ',
  });
  assert.deepEqual(
    sanitizeUtils.pickOwnAllowedFields(normalizedOwn, allowedFields),
    {
      due_date: null,
      work_order_image_url: 'https://example.com/own.jpg',
      delivery_address: '서울시 강남구',
    },
  );
});

test('only own due-date or image mutations require an invariant write guard', () => {
  assert.equal(
    typeof orderCreateInput.mutationTouchesImageDueInvariant,
    'function',
    'the invariant mutation classifier should be exported',
  );
  assert.equal(orderCreateInput.mutationTouchesImageDueInvariant({ client_name: 'unchanged invariant' }), false);
  assert.equal(orderCreateInput.mutationTouchesImageDueInvariant({ due_date: null }), true);
  assert.equal(orderCreateInput.mutationTouchesImageDueInvariant({ work_order_image_url: null }), true);
  assert.equal(
    orderCreateInput.mutationTouchesImageDueInvariant(
      Object.create({ due_date: null, work_order_image_url: null }),
    ),
    false,
  );
});

test('due-date and image writes use optimistic invariant guards and clean up conflicted uploads', async () => {
  const [patchSource, imageSource] = await Promise.all([
    readFile(new URL('../api/orders/[id]/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/orders/[id]/work-order-image.js', import.meta.url), 'utf8'),
  ]);

  assert.match(patchSource, /mutationTouchesImageDueInvariant\(mutation\)/);
  assert.match(patchSource, /due_date IS NOT DISTINCT FROM \?/);
  assert.match(patchSource, /work_order_image_url IS NOT DISTINCT FROM \?/);
  assert.match(patchSource, /RETURNING \*/);
  assert.match(patchSource, /updateResult\.rows\.length === 0[\s\S]*res\.status\(409\)/);

  assert.match(imageSource, /SELECT id, client_name, due_date, work_order_image_url FROM orders/);
  assert.match(imageSource, /due_date IS NOT DISTINCT FROM \?/);
  assert.match(imageSource, /work_order_image_url IS NOT DISTINCT FROM \?/);
  assert.match(imageSource, /RETURNING \*/);
  assert.match(imageSource, /updateResult\.rows\.length === 0[\s\S]*del\(storedImage\.rollbackUrl\)[\s\S]*res\.status\(409\)/);
});

test('order update routes validate final image-backed state before upload or UPDATE', async () => {
  const [patchSource, imageSource] = await Promise.all([
    readFile(new URL('../api/orders/[id]/index.js', import.meta.url), 'utf8'),
    readFile(new URL('../api/orders/[id]/work-order-image.js', import.meta.url), 'utf8'),
  ]);

  assert.match(patchSource, /const mutation = pickOwnAllowedFields\(normalizedBody, ORDER_FIELDS\)/);
  assert.doesNotMatch(patchSource, /body\[field\]/);
  const patchValidation = patchSource.indexOf(
    'assertImageBackedOrderHasCanonicalDueDate({ ...order, ...mutation })',
  );
  assert.ok(patchValidation >= 0, 'PATCH should validate the combined current and requested state');
  assert.ok(patchValidation < patchSource.indexOf('UPDATE orders SET'));
  assert.match(patchSource, /OrderCreateInputValidationError[\s\S]*res\.status\(400\)/);

  assert.match(imageSource, /SELECT id, client_name, due_date, work_order_image_url FROM orders/);
  const imageValidation = imageSource.indexOf('assertImageBackedOrderHasCanonicalDueDate({');
  const imageUpdate = imageSource.indexOf('UPDATE orders');
  assert.ok(imageValidation >= 0, 'image attachment should validate the resulting image-backed state');
  assert.ok(imageValidation < imageSource.indexOf('storeImageFile('));
  assert.ok(imageValidation < imageUpdate);
  assert.match(imageSource, /OrderCreateInputValidationError[\s\S]*res\.status\(400\)/);
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

test('order POST returns a structured due-date 400 before database access', async () => {
  const originalPostgresUrl = process.env.POSTGRES_URL;
  delete process.env.POSTGRES_URL;

  try {
    const { default: ordersHandler } = await import('../api/orders/index.js');
    const req = {
      method: 'POST',
      url: '/api/orders',
      headers: {},
      socket: { remoteAddress: 'due-date-regression-test' },
      body: {
        client_name: '한성거래처',
        product_type: '제과',
        work_order_image_url: 'https://example.com/work-order.jpg',
        due_date: '0000-01-01',
      },
    };
    const res = mockResponse();

    await ordersHandler(req, res);

    assert.equal(res.statusCode, 400);
    assert.deepEqual(res.body, {
      error: {
        message: 'work_order_image_url이 있는 주문은 due_date를 실제 YYYY-MM-DD 날짜로 입력해야 합니다.',
        status: 400,
      },
    });
  } finally {
    if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = originalPostgresUrl;
  }
});
