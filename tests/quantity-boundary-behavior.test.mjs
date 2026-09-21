import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeliveryAdherenceHandler } from '../api/delivery-adherence.js';
import { handlePost } from '../api/orders/index.js';
import { handleUpdate } from '../api/orders/[id]/index.js';
import { getDeliveryAdherence } from '../src/api/deliveryAdherence.js';
import { extractBrowserOcrQuantity } from '../src/pages/browserOcrEssentialFields.js';
import { buildOrderPayload, createInitialOrderForm } from '../src/pages/orderEntryPayload.js';

function mockResponse() {
  return {
    statusCode: 200,
    body: null,
    headers: {},
    headersSent: false,
    status(code) {
      this.statusCode = code;
      return this;
    },
    setHeader(name, value) {
      this.headers[String(name).toLowerCase()] = value;
      return this;
    },
    json(payload) {
      this.body = payload;
      this.headersSent = true;
      return this;
    },
    end() {
      this.headersSent = true;
      return this;
    },
  };
}

function zeroWriteDb() {
  const state = { calls: 0 };
  return {
    state,
    async execute() {
      state.calls += 1;
      throw new Error('database access must not happen for invalid quantity');
    },
    async transaction() {
      state.calls += 1;
      throw new Error('transaction must not start for invalid quantity');
    },
  };
}

test('create handler returns 400 and performs zero writes for every invalid quantity shape', async () => {
  const invalidValues = [undefined, null, '', 0, '0', -1, 1.5, '2대', '1대 총 6대', 2147483648, '2147483648'];
  for (const quantity of invalidValues) {
    const db = zeroWriteDb();
    const res = mockResponse();
    await handlePost({ body: { client_name: '검증거래처', quantity } }, res, db);
    assert.equal(res.statusCode, 400, `create status for ${String(quantity)}`);
    assert.equal(res.body?.error?.status, 400);
    assert.equal(db.state.calls, 0, `create DB calls for ${String(quantity)}`);
  }
});

test('PATCH handler returns 400 and performs zero reads or writes for every invalid quantity shape', async () => {
  const invalidValues = [undefined, null, '', 0, '0', -1, 1.5, '2대', '1대 총 6대', 2147483648, '2147483648'];
  for (const quantity of invalidValues) {
    const db = zeroWriteDb();
    let schemaCalls = 0;
    const res = mockResponse();
    await handleUpdate('7', {
      body: { quantity },
      headers: {},
    }, res, {
      db,
      requireAuth: () => ({ role: 'sales', actor: '검증자' }),
      ensureOrderImageColumn: async () => { schemaCalls += 1; },
    });
    assert.equal(res.statusCode, 400, `PATCH status for ${String(quantity)}`);
    assert.equal(res.body?.error?.status, 400);
    assert.equal(schemaCalls, 0, `PATCH schema calls for ${String(quantity)}`);
    assert.equal(db.state.calls, 0, `PATCH DB calls for ${String(quantity)}`);
  }
});

test('actual CORS-wrapped delivery handler emits current no-store headers and calculated data', async () => {
  const db = {
    async execute() {
      return {
        rows: [{
          id: 7,
          quantity: 2,
          due_date: '2026-09-21',
          status: 'in_production',
          ship_date: null,
          equipment_completed_at: '2026-09-21T01:00:00.000Z',
          later_step_started_at: null,
        }],
      };
    },
  };
  const handler = createDeliveryAdherenceHandler({ dbFactory: () => db });
  const res = mockResponse();

  await handler({
    method: 'GET',
    url: '/api/delivery-adherence',
    headers: { origin: 'https://production-status.vercel.app' },
  }, res);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.total_production_units, 2);
  assert.equal(res.headers['cache-control'], 'no-store, no-cache, must-revalidate');
  assert.equal(res.headers['cdn-cache-control'], 'no-store');
  assert.equal(res.headers['vercel-cdn-cache-control'], 'no-store');
  assert.equal(res.headers['access-control-allow-origin'], 'https://production-status.vercel.app');
});

test('delivery client performs an actual fetch with cache no-store', async () => {
  const originalFetch = globalThis.fetch;
  let captured = null;
  globalThis.fetch = async (url, options) => {
    captured = { url, options };
    return new Response(JSON.stringify({ total_production_units: 2 }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const result = await getDeliveryAdherence();
    assert.deepEqual(result, { total_production_units: 2 });
    assert.equal(captured.url, '/api/delivery-adherence');
    assert.equal(captured.options.method, 'GET');
    assert.equal(captured.options.cache, 'no-store');
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('browser OCR fallback helper executes individual-quantity parsing and leaves total-only text blank', () => {
  assert.equal(extractBrowserOcrQuantity('규격 1340×760×2000\n수량: 1대(급) 총 6대'), '1');
  assert.equal(extractBrowserOcrQuantity('수량: 2대(급) 총 6대'), '2');
  assert.equal(extractBrowserOcrQuantity('수량: 총 6대'), '');
  assert.equal(extractBrowserOcrQuantity('규격: 1340×760×2000'), '');
});

test('manual form factory renders quantity 1 as initial state and payload persists only that deliberate value', () => {
  const form = createInitialOrderForm('2026-09-21', '이준형');
  assert.equal(form.quantity, '1');
  assert.equal(form.order_date, '2026-09-21');
  assert.equal(form.sales_person, '이준형');

  const payload = buildOrderPayload({
    ...form,
    client_name: '수동거래처',
    product_type: '제과',
  }, null, '2026-09-21');
  assert.equal(payload.quantity, 1);
  assert.throws(
    () => buildOrderPayload({ ...form, client_name: '수동거래처', product_type: '제과', quantity: '' }, null, '2026-09-21'),
    /수량/,
  );
});
