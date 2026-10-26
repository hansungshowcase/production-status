import assert from 'node:assert/strict';
import test from 'node:test';
import { handleCustomerNotifications } from '../api/customer-notifications.js';
const response = () => ({ statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });
const sns = { to: '01012345678', from: '01077314237', type: 'MMS', imageId: 'ST01FZ260403024713590g9o1ZF4G1JG', subject: '한성쇼케이스 SNS 리뷰 4만원 지급이벤트', text: 'https://cafe.naver.com/01027857623/1757', groupId: 'sns-group', messageId: 'sns-message', statusCode: '4000', dateCreated: '2026-10-26T05:00:00Z' };
const rows = Array.from({ length: 12 }, (_, i) => ({ id: 12-i, order_id: 1, milestone: 'ordered', to_phone: '010****5678', status: 'success', created_at: `2026-10-26T00:${String(12-i).padStart(2,'0')}:00Z` }));
function database(calls) { return { async execute(query) {
  calls.push(query);
  if (query.sql.startsWith('SELECT COUNT')) return { rows: [{ total: 12, success: 12, delivery_unknown: 12 }] };
  if (query.sql.startsWith('SELECT REGEXP')) return { rows: [{ recipient: '01012345678', customer_name: '검증 고객' }] };
  const [limit, offset] = query.args.slice(-2); return { rows: rows.slice(offset, offset+limit) };
} }; }

test('provider reviews merge with persisted history using truthful counts, stable paging and exact phone names', async () => {
  const calls = [], res = response();
  await handleCustomerNotifications({ method: 'GET', query: { date: '2026-10-26', page: '2' } }, res, { db: database(calls), rateLimitCheck: () => true, fetchReviewMessages: async () => ({ complete: true, messages: [sns] }) });
  assert.equal(res.body.counts.total, 13);
  assert.equal(res.body.counts.delivery.received, 1);
  assert.equal(res.body.pagination.total_pages, 2);
  assert.equal(res.body.items.length, 3);
  assert.deepEqual(res.body.items.map(item => item.id), [3,2,1]);
  assert.deepEqual(calls.at(-1).args.slice(-2), [20,0]);
  const first = response();
  await handleCustomerNotifications({ method: 'GET', query: { date: '2026-10-26' } }, first, { db: database([]), rateLimitCheck: () => true, fetchReviewMessages: async () => ({ complete: true, messages: [sns] }) });
  assert.equal(first.body.items[0].customer_name, '검증 고객');
  assert.doesNotMatch(JSON.stringify(first.body), /01012345678|sns-message|sns-group/);
});

test('provider errors preserve local records and explicitly report incomplete integration', async () => {
  const res = response();
  await handleCustomerNotifications({ method: 'GET', query: { date: '2026-10-26' } }, res, { db: database([]), rateLimitCheck: () => true, fetchReviewMessages: async () => { throw new Error('private provider detail'); } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.counts.total, 12);
  assert.equal(res.body.items.length, 10);
  assert.equal(res.body.review_sync.state, 'error');
  assert.doesNotMatch(JSON.stringify(res.body), /private provider detail/);
});
