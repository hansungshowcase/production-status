import test from 'node:test';
import assert from 'node:assert/strict';
import { buildReviewDeliveryHistory, fetchReviewMessages, matchReviewMessage } from '../api/_lib/customerReviewDelivery.js';

const blog = (overrides = {}) => ({
  to: '01012345678', from: '0319862458', groupId: 'group-one', messageId: 'original-one',
  type: 'BMS_FREE', text: '블로그 리뷰 이벤트 현금 7만원', statusCode: '3120', replacement: false,
  dateCreated: '2026-10-26T02:59:00Z', customFields: {},
  kakaoOptions: { pfId: 'KA01PF241111145751437aCGtcFdsD2M', imageId: 'ST01FZ2505130310261327Bv7ZA8LMi2', disableSms: false,
    buttons: [{ linkMo: 'https://m.cafe.naver.com/01027857623/1657' }] }, ...overrides,
});
const fallback = (overrides = {}) => blog({ messageId: 'replacement-one', type: 'LMS', replacement: true, statusCode: '4000',
  text: '블로그 리뷰 현금 7만원 https://m.cafe.naver.com/01027857623/1657', kakaoOptions: {},
  dateCreated: '2026-10-26T02:59:10Z', dateReceived: '2026-10-26T02:59:12Z', ...overrides });

test('only verified channel/image/link fingerprints match and every SmartStore hook is excluded', () => {
  assert.equal(matchReviewMessage(blog()).id, 'blog');
  assert.equal(matchReviewMessage(blog({ customFields: { hookId: 'CM01HK-example' } })), null);
  assert.equal(matchReviewMessage(blog({ customFields: { productOrderId: '123' } })), null);
  assert.equal(matchReviewMessage(blog({ kakaoOptions: {} })), null);
  assert.equal(matchReviewMessage(blog({ text: '쇼케이스 무료 지원 이벤트' })), null);
  assert.equal(matchReviewMessage({ from: '01077314237', type: 'MMS', imageId: 'ST01FZ260403024713590g9o1ZF4G1JG',
    subject: '한성쇼케이스 SNS 리뷰 4만원 지급이벤트', text: 'https://cafe.naver.com/01027857623/1757' }).id, 'sns');
});

test('replacement receipt wins only for its recipient and original failure remains visible', () => {
  const items = buildReviewDeliveryHistory([blog(), fallback(), blog({ messageId: 'other', to: '01098765432', statusCode: '3040' })], { checkedAt: '2026-10-26T04:00:00Z' });
  assert.equal(items.length, 2);
  const received = items.find(item => item.phone === '010****5678');
  assert.equal(received.delivery.state, 'received');
  assert.equal(received.status, 'success');
  assert.equal(received.attempt_count, 2);
  assert.equal(received.channel, 'BMS_FREE → LMS');
  assert.deepEqual(received.attempts.map(item => item.code), ['3120', '4000']);
  assert.equal(items.find(item => item.phone === '010****5432').delivery.state, 'failed');
});

test('malformed recipients remain separate visible failures and ambiguous originals stay uncertain', () => {
  const malformed = buildReviewDeliveryHistory([blog({ to: 'invalid', statusCode: '1011' }), blog({ to: null, statusCode: '1011', messageId: 'bad-two' })]);
  assert.equal(malformed.length, 2);
  assert.ok(malformed.every(item => item.phone === '번호 형식 오류' && item.delivery.state === 'failed'));
  assert.match(malformed[0].delivery.label, /형식 오류/);
  const [ambiguous] = buildReviewDeliveryHistory([blog({ statusCode: '4000', dateReceived: '2026-10-26T03:00:00Z' }), blog({ messageId: 'duplicate', statusCode: '4000' })]);
  assert.equal(ambiguous.delivery.state, 'uncertain');
  assert.equal(ambiguous.delivery.received_at, null);
  const [pending] = buildReviewDeliveryHistory([blog()], { checkedAt: '2026-10-26T03:00:00Z' });
  assert.equal(pending.delivery.state, 'pending');
});

test('public snapshots contain no provider IDs, full phones, track tokens or signed image URLs', () => {
  const [item] = buildReviewDeliveryHistory([fallback({ text: '블로그 리뷰 7만원 https://m.cafe.naver.com/01027857623/1657 010-9876-5432 https://example.test/track/private-token https://coolsms-storage.s3.amazonaws.com/private?X-Amz-Signature=secret' })]);
  assert.doesNotMatch(JSON.stringify(item), /original-one|replacement-one|group-one|01012345678|010-9876-5432|private-token|X-Amz|amazonaws/);
  assert.match(item.text, /링크 비공개/);
});

test('KST provider lookup uses nextKey, limits work and validates input', async () => {
  const originalKey = process.env.SOLAPI_API_KEY, originalSecret = process.env.SOLAPI_API_SECRET;
  process.env.SOLAPI_API_KEY = 'unit-key'; process.env.SOLAPI_API_SECRET = 'unit-secret';
  try {
    const calls = [];
    const result = await fetchReviewMessages('2026-10-26', { cache: false, fetchImpl: async (url, init) => {
      calls.push({ url: String(url), auth: init.headers.Authorization });
      return { ok: true, status: 200, async json() { return { messageList: { one: blog() }, startKey: 'current', nextKey: 'next' }; } };
    } });
    assert.equal(calls.length, 3);
    assert.equal(result.complete, false);
    assert.match(calls[0].url, /startDate=2026-10-25T15%3A00%3A00\.000Z/);
    assert.match(calls[1].url, /startKey=next/);
    assert.doesNotMatch(calls[1].url, /startKey=current/);
    assert.match(calls[0].auth, /^HMAC-SHA256 apiKey=unit-key,/);
    assert.equal(buildReviewDeliveryHistory(result.messages).length, 1);
    await assert.rejects(fetchReviewMessages('2026-02-30', { cache: false }), /Invalid/);
  } finally {
    if (originalKey === undefined) delete process.env.SOLAPI_API_KEY; else process.env.SOLAPI_API_KEY = originalKey;
    if (originalSecret === undefined) delete process.env.SOLAPI_API_SECRET; else process.env.SOLAPI_API_SECRET = originalSecret;
  }
});
