import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { appendOrderToSheet, deleteOrderFromSheet } from '../api/_lib/googleSheets.js';

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

async function withWebhookFetch(fetchImpl, run) {
  const originalFetch = globalThis.fetch;
  const originalUrl = process.env.GOOGLE_SHEETS_WEBHOOK_URL;
  process.env.GOOGLE_SHEETS_WEBHOOK_URL = 'https://example.test/sheet-webhook';
  globalThis.fetch = fetchImpl;
  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    if (originalUrl === undefined) delete process.env.GOOGLE_SHEETS_WEBHOOK_URL;
    else process.env.GOOGLE_SHEETS_WEBHOOK_URL = originalUrl;
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

test('Google Sheets webhook keeps the bounded Apps Script cold-start timeout', async () => {
  const source = await readFile(sourcePath, 'utf8');

  assert.match(source, /const WEBHOOK_TIMEOUT_MS = 15_000;/);
  assert.match(
    source,
    /async function appendViaWebhook[\s\S]*?setTimeout\(\(\) => controller\.abort\(\), WEBHOOK_TIMEOUT_MS\)/,
  );
});
