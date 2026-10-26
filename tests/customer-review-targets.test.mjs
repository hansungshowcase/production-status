import assert from 'node:assert/strict';
import test from 'node:test';
import { handleCustomerReviews, serializeReviewTarget } from '../api/customer-reviews.js';
const response = () => ({ statusCode: 200, body: null, setHeader() {}, status(code) { this.statusCode = code; return this; }, json(body) { this.body = body; return this; } });

test('packed alone never grants review campaign consent or paid send permission', async () => {
  const target = serializeReviewTarget({ id: 1, client_name: '고객', phone: '01012345678', packed_at: '2026-10-26T00:00:00Z', lead_source: '' }, 'blog');
  assert.equal(target.eligibility, 'blocked');
  assert.deepEqual(target.reasons.map(x => x.code), ['source_unknown', 'consent_unverified']);
  assert.equal(target.maskedRecipient, '010****5678');
  const calls = [], res = response();
  await handleCustomerReviews({ method: 'GET', query: { campaign: 'sns' } }, res, { rateLimitCheck: () => true, db: { async execute(query) { calls.push(query); return { rows: calls.length === 1 ? [{ total: 1 }] : [{ id: 1, phone: '01012345678' }] }; } } });
  assert.equal(res.body.connection.canSend, false);
  assert.equal(res.body.counts.ready, 0);
  assert.equal(res.body.items[0].campaignId, 'sns');
  assert.doesNotMatch(JSON.stringify(res.body), /01012345678|sourceGroupId|sourceAppId/);
  for (const { sql } of calls) { assert.match(sql, /step_name = '포장' AND status = 'completed'/); assert.match(sql, /smartstore/); assert.doesNotMatch(sql, /INSERT|UPDATE|ALTER/); }
  const post = response();
  await handleCustomerReviews({ method: 'POST' }, post);
  assert.equal(post.statusCode, 405);
});
