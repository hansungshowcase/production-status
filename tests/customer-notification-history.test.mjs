import assert from 'node:assert/strict';
import test from 'node:test';
import { handleCustomerNotifications } from '../api/customer-notifications.js';
import {
  classifyCustomerDelivery, redactCustomerSnapshot, serializeCustomerNotification,
} from '../api/_lib/customerNotificationHistory.js';

const response = () => ({ statusCode: 200, headers: {}, body: null,
  setHeader(name, value) { this.headers[name] = value; },
  status(code) { this.statusCode = code; return this; }, json(value) { this.body = value; return this; } });

test('customer delivery classification keeps receipt truth and non-sending states distinct', () => {
  assert.equal(classifyCustomerDelivery({ status: 'failed', delivery_status_code: '4000' }).state, 'received');
  assert.equal(classifyCustomerDelivery({ status: 'failed', delivery_status_code: '2000' }).state, 'pending');
  assert.equal(classifyCustomerDelivery({ status: 'success', delivery_status_code: '2061' }).state, 'failed');
  assert.equal(classifyCustomerDelivery({ status: 'queued', delivery_status_code: null }).state, 'not_sent');
  assert.equal(classifyCustomerDelivery({ status: 'sending', delivery_status_code: null }).state, 'pending');
  assert.equal(classifyCustomerDelivery({ status: 'uncertain', delivery_status_code: null }).state, 'uncertain');
  assert.equal(classifyCustomerDelivery({ status: 'success', delivery_status_code: null }).state, 'unknown');
});

test('customer snapshot redaction masks mobile numbers and tracking URLs', () => {
  const safe = redactCustomerSnapshot('010-1234-5678 / https://example.test/track/secret-token / 080-1234-5678');
  assert.equal(safe, '010****5678 / [링크 비공개] / 080-1234-5678');
  const item = serializeCustomerNotification({ id: 1, order_id: 7, milestone: 'packed', to_phone: '010-1234-5678', status: 'success', message_subject: null, message_text: null });
  assert.equal(item.customer_name, '고객명 미보관');
  assert.equal(item.subject, '포장 완료');
  assert.equal(item.text, null);
  assert.equal(item.phone, '010****5678');
});

test('customer history is GET-only, read-only, and uses identical date/filter predicates for count and list', async () => {
  const calls = [];
  const db = { async execute(query) { calls.push(query); return calls.length === 1
    ? { rows: [{ total: 11, success: 1, failed: 1, queued: 1, sending: 1, uncertain: 1, skipped: 1, dry_run: 1, delivery_received: 1, delivery_failed: 1, delivery_pending: 1, delivery_unknown: 1, delivery_not_sent: 1, delivery_uncertain: 1 }] }
    : { rows: [{ id: 9, order_id: 4, milestone: 'review:blog', channel: 'sms', to_phone: '01011112222', status: 'success', recipient_name: '홍길동', message_subject: '후기', message_text: '본문', created_at: '2026-10-26T00:00:00Z', delivery_status_code: '4000' }] }; } };
  const res = response();
  await handleCustomerNotifications({ method: 'GET', query: { date: '2026-10-26', kind: 'review_blog', page: '9' }, headers: {}, url: '/api/customer-notifications' }, res, { db, rateLimitCheck: () => true });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.pagination.page, 2);
  assert.equal(res.body.items[0].kind, 'review_blog');
  assert.equal(res.body.items[0].channel, 'sms');
  assert.deepEqual(calls[0].args, ['2026-10-26', 'review:blog']);
  assert.deepEqual(calls[1].args.slice(0, -2), ['2026-10-26', 'review:blog']);
  assert.equal(calls[0].sql.includes("AT TIME ZONE 'Asia/Seoul'"), true);
  assert.equal(calls[0].sql.includes('INSERT'), false);
  const method = response();
  await handleCustomerNotifications({ method: 'POST', query: {}, headers: {}, url: '/api/customer-notifications' }, method, { rateLimitCheck: () => true });
  assert.equal(method.statusCode, 405);
});

test('blank date reads all customer history while malformed date is rejected', async () => {
  const calls = [];
  const db = { async execute(query) { calls.push(query); return calls.length === 1
    ? { rows: [{ total: 0 }] } : { rows: [] }; } };
  const all = response();
  await handleCustomerNotifications({ method: 'GET', query: { date: '' }, headers: {}, url: '/api/customer-notifications' }, all, { db, rateLimitCheck: () => true });
  assert.equal(all.statusCode, 200);
  assert.doesNotMatch(calls[0].sql, /AT TIME ZONE 'Asia\/Seoul'/);
  assert.equal(calls[0].args.length, 0);
  assert.equal(calls[0].sql.match(/n\.milestone/g)?.length, calls[0].sql.match(/n\.milestone/g)?.length);

  const invalid = response();
  await handleCustomerNotifications({ method: 'GET', query: { date: '2026-02-30' }, headers: {}, url: '/api/customer-notifications' }, invalid, { rateLimitCheck: () => true });
  assert.equal(invalid.statusCode, 400);
});
