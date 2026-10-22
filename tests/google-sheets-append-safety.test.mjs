import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  appendOrderToSheet,
  clearShippedOnSheet,
  deleteOrderFromSheet,
  markOrderShippedOnSheet,
} from '../api/_lib/googleSheets.js';

const riskyOrder = {
  id: 806,
  order_date: '=1+1',
  due_date: ' +SUM(A1:A2)',
  sales_person: '\t-10+20',
  client_name: '\r@SUM(A1:A2)',
  phone: '\n=2+2',
  product_type: 'ordinary text',
  width: -120,
  depth: 0,
  height: 12.5,
  quantity: -5,
  color: "'=literal",
};

const originalValues = [
  '=1+1', ' +SUM(A1:A2)', '\t-10+20', '\r@SUM(A1:A2)', '', '', '', '',
  '\n=2+2', '', 'ordinary text', '', -120, '*', 0, '*', 12.5, -5, "'=literal",
];

const neutralizedValues = [
  "'=1+1", "' +SUM(A1:A2)", "'\t-10+20", "'\r@SUM(A1:A2)", '', '', '', '',
  "'\n=2+2", '', 'ordinary text', '', -120, '*', 0, '*', 12.5, -5, "'=literal",
];

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

async function withEnvironment(changes, fetchImpl, run) {
  const originalFetch = globalThis.fetch;
  const originals = new Map(Object.keys(changes).map((key) => [key, process.env[key]]));

  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  globalThis.fetch = fetchImpl;

  try {
    return await run();
  } finally {
    globalThis.fetch = originalFetch;
    for (const [key, value] of originals) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function importWithWebhookFallbackDisabled() {
  const source = await readFile(new URL('../api/_lib/googleSheets.js', import.meta.url), 'utf8');
  const isolatedSource = source.replace(
    /const DEFAULT_WEBHOOK_URL = '[^']+';/,
    "const DEFAULT_WEBHOOK_URL = '';",
  );
  assert.notEqual(isolatedSource, source, 'test seam must disable only the default webhook URL');
  const dataUrl = `data:text/javascript;base64,${Buffer.from(isolatedSource).toString('base64')}`;
  return import(`${dataUrl}#append-safety-${Date.now()}-${Math.random()}`);
}

test('Apps Script append neutralizes formula-shaped strings without changing numeric cells or the row shape', async () => {
  let requestBody;
  const result = await withEnvironment({
    GOOGLE_SHEETS_WEBHOOK_URL: 'https://example.test/append',
  }, async (_url, init) => {
    requestBody = JSON.parse(init.body);
    return jsonResponse({ ok: true, row: 31, deduplicated: true });
  }, () => appendOrderToSheet(riskyOrder));

  assert.deepEqual(requestBody.values, neutralizedValues);
  assert.equal(requestBody.values.length, 19);
  assert.equal(requestBody.orderId, 806);
  assert.deepEqual(result, { skipped: false, row: 31, deduplicated: true });
});

test('Sheets API append neutralizes the same cells before USER_ENTERED submission', async () => {
  const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 1024,
    privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    publicKeyEncoding: { type: 'spki', format: 'pem' },
  });
  const isolatedModule = await importWithWebhookFallbackDisabled();
  const requests = [];

  const result = await withEnvironment({
    GOOGLE_SHEETS_WEBHOOK_URL: '',
    GOOGLE_SHEET_ID: 'synthetic-sheet',
    GOOGLE_SHEET_RANGE: 'A:S',
    GOOGLE_SERVICE_ACCOUNT_EMAIL: 'synthetic@example.test',
    GOOGLE_PRIVATE_KEY: privateKey,
    GOOGLE_SERVICE_ACCOUNT_JSON: undefined,
  }, async (url, init) => {
    requests.push({ url: String(url), init });
    if (String(url).includes('oauth2.googleapis.com/token')) {
      return jsonResponse({ access_token: 'synthetic-access-token', expires_in: 3600 });
    }
    return jsonResponse({ updates: { updatedRows: 1 } });
  }, () => isolatedModule.appendOrderToSheet(riskyOrder));

  assert.equal(requests.length, 2);
  assert.match(requests[1].url, /sheets\.googleapis\.com/);
  assert.match(requests[1].url, /valueInputOption=USER_ENTERED/);
  const requestBody = JSON.parse(requests[1].init.body);
  assert.deepEqual(requestBody.values, [neutralizedValues]);
  assert.equal(requestBody.values[0].length, 19);
  assert.deepEqual(result, { skipped: false });
});

test('delete and shipping payload values stay byte-for-byte compatible with legacy matching', async () => {
  const bodies = [];

  await withEnvironment({
    GOOGLE_SHEETS_WEBHOOK_URL: 'https://example.test/append-delete',
    GOOGLE_SHEETS_SHIPPING_WEBHOOK_URL: 'https://example.test/shipping',
  }, async (_url, init) => {
    const body = JSON.parse(init.body);
    bodies.push(body);
    if (body.action === 'deleteOrder') return jsonResponse({ ok: true, deletedRow: 31 });
    return jsonResponse({ ok: true, updatedRow: 31 });
  }, async () => {
    await deleteOrderFromSheet(riskyOrder);
    await markOrderShippedOnSheet(riskyOrder, '2026-10-22');
    await clearShippedOnSheet(riskyOrder, '2026-10-22');
  });

  const [deleteBody, markBody, clearBody] = bodies;
  assert.deepEqual(deleteBody.values, originalValues);
  assert.deepEqual(markBody.values, originalValues);
  assert.deepEqual(clearBody.matchValues, originalValues);
  assert.equal(clearBody.shippingValue, markBody.shippingValue);
  assert.equal(deleteBody.orderId, 806);
  assert.equal(markBody.orderId, 806);
  assert.equal(clearBody.orderId, 806);
});
