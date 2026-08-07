import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  appendOrderToSheet,
  clearShippedOnSheet,
  deleteOrderFromSheet,
  markOrderShippedOnSheet,
} from '../api/_lib/googleSheets.js';

const sourcePath = new URL('../api/_lib/googleSheets.js', import.meta.url);

const order = {
  id: 701,
  order_date: '2026-08-03',
  due_date: '2026-08-10',
  sales_person: 'manager',
  client_name: 'client',
  phone: '010-0000-0000',
  product_type: 'door',
  width: 100,
  depth: 200,
  height: 300,
  quantity: 1,
  color: 'white',
};

async function withWebhookFetch(fetchImpl, run, {
  webhookUrl = 'https://example.test/sheet-webhook',
  shippingWebhookUrl = 'https://example.test/shipping-webhook',
  webhookSecret,
} = {}) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  const originalShippingUrl = process.env.GOOGLE_SHEETS_SHIPPING_WEBHOOK_URL;
  const originalSecret = process.env.GOOGLE_SHEETS_WEBHOOK_SECRET;
  if (webhookUrl === undefined) delete process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  else process.env.GOOGLE_SHEETS_WEBHOOK_URL = webhookUrl;
  if (shippingWebhookUrl === null) delete process.env.GOOGLE_SHEETS_SHIPPING_WEBHOOK_URL;
  else process.env.GOOGLE_SHEETS_SHIPPING_WEBHOOK_URL = shippingWebhookUrl;
  if (webhookSecret === undefined) delete process.env.GOOGLE_SHEETS_WEBHOOK_SECRET;
  else process.env.GOOGLE_SHEETS_WEBHOOK_SECRET = webhookSecret;
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.GOOGLE_SHEETS_WEBHOOK_URL;
    else process.env.GOOGLE_SHEETS_WEBHOOK_URL = originalUrl;
    if (originalShippingUrl === undefined) delete process.env.GOOGLE_SHEETS_SHIPPING_WEBHOOK_URL;
    else process.env.GOOGLE_SHEETS_SHIPPING_WEBHOOK_URL = originalShippingUrl;
    if (originalSecret === undefined) delete process.env.GOOGLE_SHEETS_WEBHOOK_SECRET;
    else process.env.GOOGLE_SHEETS_WEBHOOK_SECRET = originalSecret;
  }
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

test('append sends orderId and returns a positive row with a boolean replay flag', async () => {
  let requestBody;
  const result = await withWebhookFetch(async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return jsonResponse({ ok: true, row: 12, deduplicated: true });
  }, () => appendOrderToSheet(order));

  assert.equal(requestBody.orderId, 701);
  assert.deepEqual(result, { skipped: false, row: 12, deduplicated: true });
});

test('append rejects every HTTP-200 response that is not strict JSON success with a positive integer row', async () => {
  const invalidResponses = [
    ['explicit failure', () => jsonResponse({ ok: false, row: 3 })],
    ['missing row', () => jsonResponse({ ok: true })],
    ['null row', () => jsonResponse({ ok: true, row: null })],
    ['zero row', () => jsonResponse({ ok: true, row: 0 })],
    ['string row', () => jsonResponse({ ok: true, row: '3' })],
    ['fractional row', () => jsonResponse({ ok: true, row: 1.5 })],
    ['non-JSON body', () => new Response('not json', { status: 200 })],
  ];

  for (const [label, response] of invalidResponses) {
    await withWebhookFetch(async () => response(), async () => {
      await assert.rejects(appendOrderToSheet(order), /webhook/i, label);
    });
  }
});

test('delete sends the stable orderId alongside legacy visible values', async () => {
  let requestBody;
  const result = await withWebhookFetch(async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return jsonResponse({ ok: true, deletedRow: 9 });
  }, () => deleteOrderFromSheet(order));

  assert.equal(requestBody.action, 'deleteOrder');
  assert.equal(requestBody.orderId, 701);
  assert.equal(requestBody.values.length, 19);
  assert.deepEqual(result, { skipped: false, deletedRow: 9 });
});

test('delete rejects an HTTP-200 Apps Script failure and surfaces its error text', async () => {
  await withWebhookFetch(
    async () => jsonResponse({ ok: false, error: 'unauthorized' }),
    async () => {
      await assert.rejects(deleteOrderFromSheet(order), /unauthorized/);
    },
  );
});

test('delete rejects every HTTP-200 response that is not a strict JSON ok', async () => {
  const invalidResponses = [
    ['explicit failure without text', () => jsonResponse({ ok: false })],
    ['missing ok', () => jsonResponse({ deletedRow: 9 })],
    ['string ok', () => jsonResponse({ ok: 'true', deletedRow: 9 })],
    ['null response', () => jsonResponse(null)],
    ['array response', () => jsonResponse([{ ok: true, deletedRow: 9 }])],
    ['non-JSON body', () => new Response('not json', { status: 200 })],
    ['empty response', () => new Response('', { status: 200 })],
  ];

  for (const [label, response] of invalidResponses) {
    await withWebhookFetch(async () => response(), async () => {
      await assert.rejects(deleteOrderFromSheet(order), /delete/i, label);
    });
  }
});

test('delete treats an ok response with no matching row as success', async () => {
  const result = await withWebhookFetch(
    async () => jsonResponse({ ok: true, deletedRow: null }),
    () => deleteOrderFromSheet(order),
  );

  assert.deepEqual(result, { skipped: false, deletedRow: null });
});

test('shipping uses only its dedicated URL and sends the exact markShipped payload', async () => {
  let request;
  const result = await withWebhookFetch(async (url, init) => {
    request = { url, body: JSON.parse(init.body) };
    return jsonResponse({ ok: true, updatedRow: 23 });
  }, () => markOrderShippedOnSheet({ ...order, id: 73 }, '2026-08-04'), {
    webhookUrl: 'https://example.test/append-only',
    shippingWebhookUrl: 'https://example.test/shipping-only',
    webhookSecret: 'shipping-secret',
  });

  assert.equal(request.url, 'https://example.test/shipping-only');
  assert.deepEqual(request.body, {
    secret: 'shipping-secret',
    action: 'markShipped',
    sheetId: 0,
    orderId: 73,
    shippingValue: '출고완료 · 2026-08-04',
    values: [
      '2026-08-03', '2026-08-10', 'manager', 'client', '', '', '', '',
      '010-0000-0000', '', 'door', '', 100, '*', 200, '*', 300, 1, 'white',
    ],
  });
  assert.deepEqual(result, { updatedRow: 23 });
});

test('the shipping payload carries the same visible A~S values the append webhook sends', async () => {
  const bodies = [];
  await withWebhookFetch(async (url, init) => {
    bodies.push(JSON.parse(init.body));
    const body = JSON.parse(init.body);
    return body.action === 'markShipped'
      ? jsonResponse({ ok: true, updatedRow: 23 })
      : jsonResponse({ ok: true, row: 12, deduplicated: false });
  }, async () => {
    await appendOrderToSheet(order);
    await markOrderShippedOnSheet(order, '2026-08-04');
  });

  const [appendBody, shippingBody] = bodies;
  assert.equal(shippingBody.values.length, 19);
  assert.deepEqual(shippingBody.values, appendBody.values);
});

test('append and delete never send to the shipment-only URL', async () => {
  const urls = [];
  await withWebhookFetch(async (url, init) => {
    urls.push(url);
    const body = JSON.parse(init.body);
    return body.action === 'deleteOrder'
      ? jsonResponse({ ok: true, deletedRow: 9 })
      : jsonResponse({ ok: true, row: 12, deduplicated: false });
  }, async () => {
    await appendOrderToSheet(order);
    await deleteOrderFromSheet(order);
  }, {
    webhookUrl: 'https://example.test/append-delete',
    shippingWebhookUrl: 'https://example.test/shipping-only',
  });

  assert.deepEqual(urls, [
    'https://example.test/append-delete',
    'https://example.test/append-delete',
  ]);
});

test('shipping rejects a missing URL without attempting a fallback request', async () => {
  let fetchCalls = 0;
  await withWebhookFetch(async () => {
    fetchCalls += 1;
    throw new Error('fetch must not run');
  }, async () => {
    await assert.rejects(
      markOrderShippedOnSheet({ ...order, id: 73 }, '2026-08-04'),
      /GOOGLE_SHEETS_SHIPPING_WEBHOOK_URL/,
    );
  }, {
    webhookUrl: 'https://example.test/append-only',
    shippingWebhookUrl: null,
  });
  assert.equal(fetchCalls, 0);
});

test('shipping rejects invalid order IDs before sending a request', async () => {
  for (const orderId of [0, -1, 1.5, 'not-an-id']) {
    let fetchCalls = 0;
    await withWebhookFetch(async () => {
      fetchCalls += 1;
      return jsonResponse({ ok: true, updatedRow: 23 });
    }, async () => {
      await assert.rejects(
        markOrderShippedOnSheet({ ...order, id: orderId }, '2026-08-04'),
        /order ID/i,
      );
    });
    assert.equal(fetchCalls, 0);
  }
});

test('shipping rejects network, non-2xx, malformed, empty, non-object, and non-strict responses', async () => {
  const invalidResponses = [
    ['network failure', async () => { throw new Error('socket closed'); }],
    ['non-2xx response', async () => jsonResponse({ ok: true, updatedRow: 23 }, 503)],
    ['malformed JSON', async () => new Response('not json', { status: 200 })],
    ['empty response', async () => new Response('', { status: 200 })],
    ['null response', async () => jsonResponse(null)],
    ['boolean response', async () => jsonResponse(true)],
    ['string response', async () => jsonResponse('ok')],
    ['array response', async () => jsonResponse([{ ok: true, updatedRow: 23 }])],
    ['explicit failure', async () => jsonResponse({ ok: false, updatedRow: 23 })],
    ['missing updated row', async () => jsonResponse({ ok: true })],
    ['zero updated row', async () => jsonResponse({ ok: true, updatedRow: 0 })],
    ['string updated row', async () => jsonResponse({ ok: true, updatedRow: '23' })],
    ['fractional updated row', async () => jsonResponse({ ok: true, updatedRow: 1.5 })],
  ];

  for (const [label, fetchImpl] of invalidResponses) {
    await withWebhookFetch(fetchImpl, async () => {
      await assert.rejects(
        markOrderShippedOnSheet({ ...order, id: 73 }, '2026-08-04'),
        undefined,
        label,
      );
    });
  }
});

test('the revert clear uses only the shipping URL and sends the exact clearShipped payload', async () => {
  let request;
  const result = await withWebhookFetch(async (url, init) => {
    request = { url, body: JSON.parse(init.body) };
    return jsonResponse({ ok: true, updatedRow: 23 });
  }, () => clearShippedOnSheet({ ...order, id: 73 }, '2026-08-05'), {
    webhookUrl: 'https://example.test/append-only',
    shippingWebhookUrl: 'https://example.test/shipping-only',
    webhookSecret: 'shipping-secret',
  });

  assert.equal(request.url, 'https://example.test/shipping-only');
  assert.deepEqual(request.body, {
    secret: 'shipping-secret',
    action: 'clearShipped',
    sheetId: 0,
    orderId: 73,
    shippingValue: '출고완료 · 2026-08-05',
    matchValues: [
      '2026-08-03', '2026-08-10', 'manager', 'client', '', '', '', '',
      '010-0000-0000', '', 'door', '', 100, '*', 200, '*', 300, 1, 'white',
    ],
  });
  assert.deepEqual(result, { updatedRow: 23, unchanged: false });
});

test('the clear payload matches the row exactly like the markShipped payload does', async () => {
  const bodies = [];
  await withWebhookFetch(async (_url, init) => {
    bodies.push(JSON.parse(init.body));
    return jsonResponse({ ok: true, updatedRow: 23 });
  }, async () => {
    await markOrderShippedOnSheet(order, '2026-08-04');
    await clearShippedOnSheet(order, '2026-08-04');
  });

  const [markBody, clearBody] = bodies;
  assert.deepEqual(clearBody.matchValues, markBody.values);
  assert.equal(clearBody.shippingValue, markBody.shippingValue);
  assert.equal(clearBody.orderId, markBody.orderId);
  assert.equal(clearBody.sheetId, markBody.sheetId);
});

test('the clear reports an idempotent no-op without failing the caller', async () => {
  const result = await withWebhookFetch(
    async () => jsonResponse({ ok: true, updatedRow: 23, unchanged: true }),
    () => clearShippedOnSheet(order, '2026-08-05'),
  );

  assert.deepEqual(result, { updatedRow: 23, unchanged: true });
});

test('the clear rejects a missing URL, invalid IDs, and invalid dates before sending', async () => {
  let fetchCalls = 0;
  await withWebhookFetch(async () => {
    fetchCalls += 1;
    throw new Error('fetch must not run');
  }, async () => {
    await assert.rejects(
      clearShippedOnSheet(order, '2026-08-05'),
      /GOOGLE_SHEETS_SHIPPING_WEBHOOK_URL/,
    );
  }, { shippingWebhookUrl: null });
  assert.equal(fetchCalls, 0);

  for (const orderId of [0, -1, 1.5, 'not-an-id', null, undefined]) {
    let calls = 0;
    await withWebhookFetch(async () => {
      calls += 1;
      return jsonResponse({ ok: true, updatedRow: 23 });
    }, async () => {
      await assert.rejects(clearShippedOnSheet({ ...order, id: orderId }, '2026-08-05'), /order ID/i);
    });
    assert.equal(calls, 0);
  }

  for (const shipDate of ['', '2026-8-5', '20260805', null, undefined, new Date()]) {
    let calls = 0;
    await withWebhookFetch(async () => {
      calls += 1;
      return jsonResponse({ ok: true, updatedRow: 23 });
    }, async () => {
      await assert.rejects(clearShippedOnSheet(order, shipDate), /ship date/i);
    });
    assert.equal(calls, 0);
  }
});

test('the clear rejects network, non-2xx, malformed, and non-strict responses', async () => {
  const invalidResponses = [
    ['network failure', async () => { throw new Error('socket closed'); }],
    ['non-2xx response', async () => jsonResponse({ ok: true, updatedRow: 23 }, 503)],
    ['malformed JSON', async () => new Response('not json', { status: 200 })],
    ['empty response', async () => new Response('', { status: 200 })],
    ['null response', async () => jsonResponse(null)],
    ['array response', async () => jsonResponse([{ ok: true, updatedRow: 23 }])],
    ['explicit failure', async () => jsonResponse({ ok: false, error: 'ambiguous legacy match' })],
    ['missing updated row', async () => jsonResponse({ ok: true })],
    ['zero updated row', async () => jsonResponse({ ok: true, updatedRow: 0 })],
    ['string updated row', async () => jsonResponse({ ok: true, updatedRow: '23' })],
  ];

  for (const [label, fetchImpl] of invalidResponses) {
    await withWebhookFetch(fetchImpl, async () => {
      await assert.rejects(clearShippedOnSheet(order, '2026-08-05'), undefined, label);
    });
  }
});

test('Google Sheets webhook keeps the bounded Apps Script cold-start timeout', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /const WEBHOOK_TIMEOUT_MS = 15_000;/);
  assert.match(
    source,
    /async function appendViaWebhook[\s\S]*?setTimeout\(\(\) => controller\.abort\(\), WEBHOOK_TIMEOUT_MS\)/,
  );
  assert.match(
    source,
    /function markOrderShippedOnSheet[\s\S]*?setTimeout\(\(\) => controller\.abort\(\), SHIPPING_WEBHOOK_TIMEOUT_MS\)/,
  );
  assert.match(
    source,
    /function clearShippedOnSheet[\s\S]*?setTimeout\(\(\) => controller\.abort\(\), SHIPPING_WEBHOOK_TIMEOUT_MS\)/,
  );
});

test('the shipping webhook outwaits the Apps Script lock so contention never fails early', async () => {
  const backendSource = await readFile(sourcePath, 'utf8');
  const scriptSource = await readFile(
    new URL('../.apps-script-shipping/Code.js', import.meta.url),
    'utf8',
  );

  const backendTimeoutMs = Number(
    /const SHIPPING_WEBHOOK_TIMEOUT_MS = ([\d_]+);/.exec(backendSource)[1].replace(/_/g, ''),
  );
  const lockTimeoutMs = Number(
    /const LOCK_TIMEOUT_MS = ([\d_]+);/.exec(scriptSource)[1].replace(/_/g, ''),
  );

  assert.equal(backendTimeoutMs, 30_000);
  assert.equal(lockTimeoutMs, 25_000);
  assert.ok(
    lockTimeoutMs < backendTimeoutMs,
    'lock wait must finish before the backend aborts, otherwise contention always fails',
  );
  // Apps Script 실행 한도 6분 안에서 락 대기 + 시트 읽기/쓰기가 모두 끝나야 한다.
  assert.ok(lockTimeoutMs < 6 * 60 * 1000);
  // 공용 append/delete 타임아웃은 그대로 유지되어야 한다.
  assert.match(
    backendSource,
    /async function deleteViaWebhook[\s\S]*?setTimeout\(\(\) => controller\.abort\(\), WEBHOOK_TIMEOUT_MS\)/,
  );
});
