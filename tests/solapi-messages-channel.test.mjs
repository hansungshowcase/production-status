import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';

import { handleSolapiMessages } from '../api/solapi-messages.js';
import { clearSolapiMessageCache } from '../api/_lib/solapiMessageLog.js';
import { clearSolapiGroupCache } from '../api/_lib/solapiGroupLog.js';

const NOW = Date.parse('2026-11-11T06:10:00.000Z');
const PHONE = ['010', '1234', '5678'].join('');
const SENDER = ['031', '9862458'].join('');

let seq = 0;
function msg(over = {}) {
  seq += 1;
  return {
    messageId: `M${seq}`, groupId: `G${seq}0000000000`, to: PHONE, from: SENDER, type: 'LMS',
    statusCode: '4000', dateCreated: '2026-11-11T02:00:00.000Z', dateReported: '2026-11-11T02:00:30.000Z',
    dateReceived: '2026-11-11T02:00:30.000Z', subject: '제목', text: '본문',
    ...over,
  };
}
function res() {
  return {
    statusCode: 200, body: null, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(name, value) { this.headers[name] = value; },
  };
}
const fakeDb = () => ({ async execute() { return { rows: [] }; } });
function fakeFetch(messages) {
  return async url => {
    if (String(url).includes('/messages/v4/groups')) return { ok: true, status: 200, json: async () => ({ groupList: Object.fromEntries(messages.map(m => [m.groupId, {
      groupId: m.groupId, status: 'COMPLETE', dateCreated: m.dateCreated, count: { total: 1, sentTotal: 1, sentSuccess: 1 },
    }])) }) };
    return { ok: true, status: 200, json: async () => ({ messageList: Object.fromEntries(messages.map(m => [m.messageId, m])) }) };
  };
}
async function call(query, messages = []) {
  const response = res();
  await handleSolapiMessages({ method: 'GET', query }, response, {
    db: fakeDb(), fetchImpl: fakeFetch(messages), rateLimitCheck: () => true, nowMs: NOW,
  });
  return response;
}
const sample = () => [
  msg({ type: 'SMS', dateCreated: '2026-11-11T02:00:00.000Z' }), // KST 11시
  msg({ type: 'LMS', dateCreated: '2026-11-11T02:30:00.000Z' }),
  msg({ type: 'ATA', dateCreated: '2026-11-10T15:10:00.000Z' }), // KST 00시
  msg({ type: 'ATA', statusCode: '3000', dateCreated: '2026-11-11T14:59:00.000Z' }), // KST 23시
];

beforeEach(() => {
  clearSolapiMessageCache();
  clearSolapiGroupCache();
  process.env.SOLAPI_API_KEY = 'test-key';
  process.env.SOLAPI_API_SECRET = 'test-secret';
});
afterEach(() => {
  delete process.env.SOLAPI_API_KEY;
  delete process.env.SOLAPI_API_SECRET;
});

test('channel 틀린 값은 400', async () => {
  const r = await call({ channel: 'voice' });
  assert.equal(r.statusCode, 400);
  assert.equal(r.body.error, '올바른 종류가 아닙니다.');
});

test('matrix 합계는 counts.all 과 같고 hourly 는 24칸 한국시간', async () => {
  const r = await call({ date: '2026-11-11' }, sample());
  assert.equal(r.statusCode, 200);
  assert.equal(r.body.channel, 'all');
  let sum = 0;
  for (const line of Object.values(r.body.matrix)) for (const cell of Object.values(line)) sum += cell.total;
  assert.equal(sum, r.body.counts.all.total);
  assert.equal(sum, 4);
  assert.equal(r.body.matrix.customer.sms.total, 2);
  assert.equal(r.body.matrix.customer.kakao.total, 2);
  assert.equal(r.body.hourly.length, 24);
  assert.deepEqual(r.body.hourly.map(h => h.hour), Array.from({ length: 24 }, (_, i) => i));
  assert.equal(r.body.hourly[11].total, 2);
  assert.equal(r.body.hourly[0].total, 1);
  assert.equal(r.body.hourly[23].total, 1);
  assert.equal(r.body.hourly.reduce((a, h) => a + h.total, 0), 4);
  assert.equal(r.body.hourly.reduce((a, h) => a + h.failed, 0), r.body.counts.all.failed);
});

test('channel=kakao 는 문자 건 없음, 요청 건수 줄어듦, matrix·hourly 는 전체 기준', async () => {
  const full = await call({ date: '2026-11-11', view: 'messages' }, sample());
  clearSolapiMessageCache(); clearSolapiGroupCache();
  const k = await call({ date: '2026-11-11', view: 'messages', channel: 'kakao' }, sample());
  assert.equal(k.body.channel, 'kakao');
  assert.equal(k.body.items.length, 2);
  assert.ok(k.body.items.every(item => ['ATA', 'CTA', 'CTI'].includes(item.type)));
  assert.equal(k.body.counts.all.total, 2);
  assert.ok(k.body.group_counts.all < full.body.group_counts.all);
  assert.deepEqual(k.body.matrix, full.body.matrix);
  assert.deepEqual(k.body.hourly, full.body.hourly);
  clearSolapiMessageCache(); clearSolapiGroupCache();
  const s = await call({ date: '2026-11-11', view: 'messages', channel: 'sms' }, sample());
  assert.equal(s.body.items.length, 2);
  assert.ok(s.body.items.every(item => ['SMS', 'LMS', 'MMS'].includes(item.type)));
});

test('channel=all 응답의 기존 칸은 channel 없이 부른 것과 같다', async () => {
  const fixed = sample();
  const a = await call({ date: '2026-11-11' }, fixed);
  clearSolapiMessageCache(); clearSolapiGroupCache();
  const b = await call({ date: '2026-11-11', channel: 'all' }, fixed);
  for (const key of ['counts', 'group_counts', 'types', 'senders', 'pagination', 'groups']) {
    assert.deepEqual(b.body[key], a.body[key]);
  }
});

test('키 없음 분기도 0으로 채운 matrix·hourly', async () => {
  delete process.env.SOLAPI_API_KEY;
  delete process.env.SOLAPI_API_SECRET;
  const r = await call({});
  assert.equal(r.body.configured, false);
  assert.equal(r.body.channel, 'all');
  assert.equal(r.body.hourly.length, 24);
  assert.equal(r.body.matrix.staff.kakao.failed, 0);
  assert.equal(r.body.matrix.other.other.total, 0);
});
