import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  mutationTouchesImageDueInvariant,
  normalizeOrderCreateInput,
} from '../api/_lib/orderCreateInput.js';
import * as orderCreateInput from '../api/_lib/orderCreateInput.js';

const validImageBackedOrder = {
  client_name: '한성 거래처',
  order_date: '2026-07-24',
  due_date: '2026-07-31',
  sales_person: '이준형',
  product_type: '쇼케이스',
  quantity: 1,
  work_order_image_url: 'https://example.com/work-order.jpg',
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

test('create validation requires every image-backed order essential while preserving image-free normalization', () => {
  const invalidCases = [
    ['client_name', '   ', /client_name/],
    ['order_date', '2026-02-29', /order_date.*YYYY-MM-DD/],
    ['due_date', '2026-04-31', /due_date.*YYYY-MM-DD/],
    ['sales_person', '홍길동', /담당자/],
    ['product_type', '\t', /product_type/],
    ['quantity', 0, /quantity.*positive/],
  ];

  for (const [field, value, expectedMessage] of invalidCases) {
    assert.throws(
      () => normalizeOrderCreateInput({
        ...validImageBackedOrder,
        [field]: value,
      }),
      expectedMessage,
      `${field} should be rejected for image-backed creation`,
    );
  }

  assert.doesNotThrow(() => normalizeOrderCreateInput(validImageBackedOrder));
  assert.deepEqual(
    normalizeOrderCreateInput({
      client_name: '   ',
      order_date: '',
      due_date: '',
      sales_person: '',
      product_type: '\t',
      quantity: '',
      work_order_image_url: null,
    }),
    {
      client_name: '   ',
      order_date: '',
      due_date: '',
      sales_person: null,
      product_type: '\t',
      quantity: 1,
      work_order_image_url: null,
      width: null,
      depth: null,
      height: null,
      sale_amount: null,
      balance: null,
      delivery_address: undefined,
      freight_payment: undefined,
    },
  );
});

test('orders POST returns a field-specific 400 for every invalid image-backed essential before database access', async () => {
  const originalPostgresUrl = process.env.POSTGRES_URL;
  delete process.env.POSTGRES_URL;

  try {
    const { default: ordersHandler } = await import('../api/orders/index.js');
    const invalidCases = [
      ['client_name', ' ', /client_name/],
      ['order_date', '2026-02-29', /order_date/],
      ['due_date', '2026-04-31', /due_date/],
      ['sales_person', '홍길동', /담당자/],
      ['product_type', ' ', /product_type/],
      ['quantity', 0, /quantity/],
    ];

    for (const [index, [field, value, expectedMessage]] of invalidCases.entries()) {
      const req = {
        method: 'POST',
        url: '/api/orders',
        headers: {},
        socket: { remoteAddress: `image-order-backend-${index}` },
        body: {
          ...validImageBackedOrder,
          [field]: value,
        },
      };
      const res = mockResponse();

      await ordersHandler(req, res);

      assert.equal(res.statusCode, 400, `${field} should fail before database access`);
      assert.match(res.body?.error?.message || '', expectedMessage);
    }
  } finally {
    if (originalPostgresUrl === undefined) delete process.env.POSTGRES_URL;
    else process.env.POSTGRES_URL = originalPostgresUrl;
  }
});

test('PATCH validates and optimistically guards the complete resulting image-backed state', async () => {
  const source = await readFile(new URL('../api/orders/[id]/index.js', import.meta.url), 'utf8');
  const updateIndex = source.indexOf('UPDATE orders SET');

  assert.equal(
    typeof orderCreateInput.mutationChangesImageOrderInvariant,
    'function',
    'PATCH needs an actual-change classifier for legacy image-backed rows',
  );
  assert.equal(
    orderCreateInput.mutationChangesImageOrderInvariant(
      validImageBackedOrder,
      {
        ...validImageBackedOrder,
        notes: 'unrelated change',
      },
    ),
    false,
    'unchanged invariant values should not validate legacy rows',
  );
  assert.equal(
    orderCreateInput.mutationChangesImageOrderInvariant(
      validImageBackedOrder,
      { quantity: 2 },
    ),
    true,
  );
  assert.equal(
    orderCreateInput.mutationChangesImageOrderInvariant(
      { ...validImageBackedOrder, quantity: 1 },
      { quantity: '1' },
    ),
    false,
    'equivalent integer input should not count as a persisted change',
  );

  assert.match(
    source,
    /const guardInvariantState = mutationTouchesImageDueInvariant\(mutation\);[\s\S]*const validateInvariantState = mutationChangesImageOrderInvariant\(order, mutation\);[\s\S]*if \(validateInvariantState\) \{[\s\S]*assertImageBackedOrderHasClientName/,
    'unrelated legacy PATCHes should bypass image-backed validation',
  );

  for (const assertion of [
    'assertImageBackedOrderHasClientName({ ...order, ...mutation })',
    'assertImageBackedOrderHasCanonicalOrderDate({ ...order, ...mutation })',
    'assertImageBackedOrderHasCanonicalDueDate({ ...order, ...mutation })',
    'assertImageBackedOrderHasSalesPerson({ ...order, ...mutation })',
    'assertImageBackedOrderHasProductType({ ...order, ...mutation })',
    'assertImageBackedOrderHasPositiveQuantity({ ...order, ...mutation })',
  ]) {
    const assertionIndex = source.indexOf(assertion);
    assert.ok(assertionIndex >= 0, `PATCH should call ${assertion}`);
    assert.ok(assertionIndex < updateIndex, `${assertion} should run before UPDATE`);
  }

  for (const field of [
    'client_name',
    'order_date',
    'due_date',
    'sales_person',
    'product_type',
    'quantity',
    'work_order_image_url',
  ]) {
    assert.equal(
      mutationTouchesImageDueInvariant({ [field]: null }),
      true,
      `${field} mutations should use the image-backed invariant guard`,
    );
    assert.match(source, new RegExp(`${field} IS NOT DISTINCT FROM \\\\?`));
  }
});

test('image attachment validates and guards every persisted essential before storing the blob', async () => {
  const source = await readFile(
    new URL('../api/orders/[id]/work-order-image.js', import.meta.url),
    'utf8',
  );
  const storeIndex = source.indexOf('storedImage = await storeImageFile(');
  const updateIndex = source.indexOf('UPDATE orders');

  assert.match(
    source,
    /SELECT id, client_name, order_date, due_date, sales_person, product_type, quantity, work_order_image_url FROM orders/,
  );

  for (const assertion of [
    'assertImageBackedOrderHasClientName({',
    'assertImageBackedOrderHasCanonicalOrderDate({',
    'assertImageBackedOrderHasCanonicalDueDate({',
    'assertImageBackedOrderHasSalesPerson({',
    'assertImageBackedOrderHasProductType({',
    'assertImageBackedOrderHasPositiveQuantity({',
  ]) {
    const assertionIndex = source.indexOf(assertion);
    assert.ok(assertionIndex >= 0, `image attachment should call ${assertion}`);
    assert.ok(assertionIndex < storeIndex, `${assertion} should run before blob storage`);
    assert.ok(assertionIndex < updateIndex, `${assertion} should run before UPDATE`);
  }

  for (const field of [
    'client_name',
    'order_date',
    'due_date',
    'sales_person',
    'product_type',
    'quantity',
    'work_order_image_url',
  ]) {
    assert.match(source, new RegExp(`${field} IS NOT DISTINCT FROM \\\\?`));
  }
});

test('migration trigger enforces every essential on future image-backed writes without rewriting legacy rows', async () => {
  const source = await readFile(new URL('../scripts/migrate.js', import.meta.url), 'utf8');

  assert.match(source, /NULLIF\(BTRIM\(NEW\.client_name\), ''\) IS NULL/);
  assert.match(source, /NEW\.order_date !~ '\^\\\\d\{4\}-\\\\d\{2\}-\\\\d\{2\}\$'/);
  assert.match(
    source,
    /to_char\(to_date\(NEW\.order_date, 'YYYY-MM-DD'\), 'YYYY-MM-DD'\) <> NEW\.order_date/,
  );
  assert.match(source, /NEW\.sales_person NOT IN \('신은철', '이준형'\)/);
  assert.match(source, /NULLIF\(BTRIM\(NEW\.product_type\), ''\) IS NULL/);
  assert.match(source, /NEW\.quantity <= 0/);
  assert.match(
    source,
    /BEFORE INSERT OR UPDATE OF client_name, order_date, due_date, sales_person, product_type, quantity, work_order_image_url/,
  );
  assert.match(source, /IF TG_OP = 'UPDATE'/);
  for (const field of [
    'client_name',
    'order_date',
    'due_date',
    'sales_person',
    'product_type',
    'quantity',
    'work_order_image_url',
  ]) {
    assert.match(source, new RegExp(`OLD\\.${field} IS NOT DISTINCT FROM NEW\\.${field}`));
  }
  assert.match(
    source,
    /OLD\.work_order_image_url IS NOT DISTINCT FROM NEW\.work_order_image_url[\s\S]*RETURN NEW;[\s\S]*END IF;[\s\S]*IF NULLIF\(BTRIM\(NEW\.work_order_image_url\), ''\) IS NOT NULL/,
    'unchanged invariant values should return before validating legacy rows',
  );
  assert.doesNotMatch(source, /\bUPDATE\s+orders\s+SET\b/i);
});
