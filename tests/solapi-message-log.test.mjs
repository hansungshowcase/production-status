import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';

import { handleSolapiMessages } from '../api/solapi-messages.js';
import { clearSolapiMessageCache } from '../api/_lib/solapiMessageLog.js';
import { INTERNAL_ALERT_CONTACTS } from '../api/_lib/internalProductionAlerts.js';

const NOW = Date.parse('2026-11-11T06:10:00.000Z');
const CUSTOMER_PHONE = ['010', '1234', '5678'].join('');
const OTHER_PHONE = ['010', '9999', '0001'].join('');
const SENDER = ['031', '9862458'].join('');
const BLOG_LINK = 'https://m.cafe.naver.com/01027857623/1657';
const MUTATION = /\b(?:ALTER|CREATE|DELETE|DROP|GRANT|INSERT|RENAME|REVOKE|TRUNCATE|UPDATE)\b/i;

let seq = 0;
function msg(over = {}) {
  seq += 1;
  return {
    messageId: `M${seq}`, groupId: `G${seq}`, to: CUSTOMER_PHONE, from: SENDER, type: 'LMS',
    statusCode: '4000', dateCreated: '2026-11-11T02:00:00.000Z', dateReported: '2026-11-11T02:00:30.000Z',
    dateReceived: '2026-11-11T02:00:30.000Z', subject: '제목', text: '본문', customFields: { secret: 'x' },
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
function fakeDb(rows = []) {
  const statements = [];
  return {
    statements,
    async execute(query) {
      const sql = String(query.sql).replace(/\s+/g, ' ').trim();
      statements.push(sql);
      assert.match(sql, /^SELECT\b/i);
      assert.doesNotMatch(sql, MUTATION);
      return { rows };
    },
  };
}
function fakeFetch(messages, { ok = true, status = 200, pages } = {}) {
  const calls = [];
  const impl = async url => {
    calls.push(String(url));
    if (!ok) return { ok, status, json: async () => ({}) };
    const body = pages ? pages[calls.length - 1] : { messageList: Object.fromEntries(messages.map(m => [m.messageId, m])) };
    return { ok: true, status: 200, json: async () => body };
  };
  impl.calls = calls;
  return impl;
}
async function call(query, { messages = [], rows = [], fetchOpts, db } = {}) {
  const response = res();
  const fetchImpl = fakeFetch(messages, fetchOpts);
  const database = db || fakeDb(rows);
  await handleSolapiMessages({ method: 'GET', query }, response, { db: database, fetchImpl, rateLimitCheck: () => true, nowMs: NOW });
  return { response, fetchImpl, db: database };
}

beforeEach(() => {
  clearSolapiMessageCache();
  process.env.SOLAPI_API_KEY = 'test-key';
  process.env.SOLAPI_API_SECRET = 'test-secret';
});
afterEach(() => {
  delete process.env.SOLAPI_API_KEY;
  delete process.env.SOLAPI_API_SECRET;
});

test('구분 규칙: DB 직원·DB 고객·직원 번호·리뷰·외부·분체 영업/기타', async () => {
  const laser = INTERNAL_ALERT_CONTACTS.laser;
  const staffDb = msg({ to: INTERNAL_ALERT_CONTACTS.welding.phone });
  const customerDb = msg({ to: CUSTOMER_PHONE });
  const staffNoDb = msg({ to: laser.phone });
  const review = msg({
    to: CUSTOMER_PHONE, type: 'BMS_FREE', statusCode: '3120', text: '블로그 리뷰 7만원',
    kakaoOptions: { disableSms: false },
  });
  const reviewLms = msg({ to: CUSTOMER_PHONE, groupId: review.groupId, type: 'LMS', replacement: true,
    text: `블로그 리뷰 7만원 ${BLOG_LINK}`, dateCreated: '2026-11-11T02:00:05.000Z' });
  const external = msg({ to: OTHER_PHONE, text: '외부'.repeat(40) });
  const chonbeSales = msg({ to: laser.phone });
  const chonbeOther = msg({ to: OTHER_PHONE });
  const rows = [
    { milestone: 'internal_welding_due', recipient_name: '최우석 이사', provider_msgid: staffDb.messageId, to_phone: '' },
    { milestone: 'ordered', recipient_name: '홍길동', provider_msgid: customerDb.messageId, to_phone: '' },
    { milestone: 'chonbe_alert', recipient_name: null, provider_msgid: chonbeOther.messageId, to_phone: '' },
  ];
  const { response } = await call({ date: '2026-11-11' }, {
    messages: [staffDb, customerDb, staffNoDb, review, reviewLms, external, chonbeSales, chonbeOther], rows,
  });
  const byId = Object.fromEntries(response.body.items.map(item => [item.message_id, item]));
  assert.equal(byId[staffDb.messageId].audience, 'staff');
  assert.equal(byId[staffDb.messageId].category, '생산 알림');
  assert.equal(byId[staffDb.messageId].recipient_name, '최우석 이사');
  assert.equal(byId[customerDb.messageId].audience, 'customer');
  assert.equal(byId[customerDb.messageId].category, '주문 접수');
  assert.equal(byId[staffNoDb.messageId].audience, 'staff');
  assert.equal(byId[staffNoDb.messageId].category, '직원 문자(기록 없음)');
  assert.equal(byId[staffNoDb.messageId].recipient_name, laser.name);
  assert.equal(byId[reviewLms.messageId].audience, 'customer');
  assert.equal(byId[reviewLms.messageId].category, '리뷰 이벤트(블로그)');
  assert.equal(byId[external.messageId].category, '기타 고객 문자(외부 발송)');
  assert.equal(byId[chonbeOther.messageId].audience, 'other');
  assert.equal(byId[chonbeOther.messageId].category, '분체 알림(기타 수신)');
  assert.equal(response.body.items.length, 7);
});

test('우리 기록에 없는 고객 문자는 본문으로 종류, 연동 표시로 발송처를 붙인다', async () => {
  const order = msg({ to: OTHER_PHONE, type: 'ATA', text: '안녕하세요 대표님 한성입니다 주문이 정상 접수되었습니다 예상 출고일 안내', customFields: { hookId: 'H1' } });
  const ship = msg({ to: OTHER_PHONE, type: 'ATA', text: '안녕하세요 대표님 구매하신 제품의 출고일 안내드립니다', customFields: { storeId: 'S1', productOrderId: 'P1' } });
  const free = msg({ to: OTHER_PHONE, type: 'BMS_FREE', subject: '(광고)한성쇼케이스그룹', text: '[한성쇼케이스 무료 지원 이벤트] 안녕하세요', customFields: {} });
  const ad = msg({ to: OTHER_PHONE, text: '(광고) 신제품 소개', customFields: {} });
  const { response } = await call({ date: '2026-11-11' }, { messages: [order, ship, free, ad] });
  const byId = Object.fromEntries(response.body.items.map(item => [item.message_id, item]));
  assert.equal(byId[order.messageId].category, '주문 안내(쏠라피 자동발송)');
  assert.equal(byId[ship.messageId].category, '출고 안내(스마트스토어 연동)');
  assert.equal(byId[free.messageId].category, '무료 지원 이벤트(외부 발송)');
  assert.equal(byId[ad.messageId].category, '광고 문자(외부 발송)');
  assert.ok(!JSON.stringify(response.body).includes('customFields'));
});

test('분체 알림은 영업 번호면 직원', async () => {
  const sales = msg({ to: ['010', '7346', '7407'].join('') });
  const { response } = await call({}, {
    messages: [sales], rows: [{ milestone: 'chonbe_alert', recipient_name: null, provider_msgid: sales.messageId, to_phone: '' }],
  });
  assert.equal(response.body.items[0].audience, 'staff');
  assert.equal(response.body.items[0].category, '분체 알림(영업)');
});

test('provider_msgid=groupId 대조는 가린 번호로 2차 대조', async () => {
  const a = msg({ groupId: 'GSAME', to: CUSTOMER_PHONE });
  const b = msg({ groupId: 'GSAME', to: INTERNAL_ALERT_CONTACTS.design.phone });
  const rows = [
    { milestone: 'packed', recipient_name: '고객A', provider_msgid: 'GSAME', to_phone: `${CUSTOMER_PHONE.slice(0, 3)}****${CUSTOMER_PHONE.slice(-4)}` },
    { milestone: 'internal_overdue_unshipped', recipient_name: '김보수 팀장', provider_msgid: 'GSAME',
      to_phone: INTERNAL_ALERT_CONTACTS.design.phone.replace(/\D/g, '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2') },
  ];
  const { response } = await call({}, { messages: [a, b], rows });
  const byId = Object.fromEntries(response.body.items.map(item => [item.message_id, item]));
  assert.equal(byId[a.messageId].category, '포장 완료');
  assert.equal(byId[a.messageId].audience, 'customer');
  assert.equal(byId[b.messageId].category, '지연 알림');
  assert.equal(byId[b.messageId].audience, 'staff');
});

test('응답에 원번호와 customFields 가 없고 번호는 가려진다', async () => {
  const m = msg({ text: `문의 ${CUSTOMER_PHONE.slice(0, 3)}-${CUSTOMER_PHONE.slice(3, 7)}-${CUSTOMER_PHONE.slice(7)} 입니다` });
  const { response } = await call({}, { messages: [m] });
  const json = JSON.stringify(response.body);
  assert.ok(!json.includes(CUSTOMER_PHONE));
  assert.ok(!json.includes(SENDER));
  assert.ok(!json.includes('customFields'));
  assert.ok(!json.includes('secret'));
  assert.equal(response.body.items[0].to, '010****5678');
  assert.equal(response.body.items[0].from, '031****2458');
});

test('상태 6분류', async () => {
  const codes = ['1011', '2000', '2100', '3000', '3040', '4000'];
  const messages = codes.map(code => msg({ statusCode: code, to: OTHER_PHONE }));
  const { response } = await call({}, { messages });
  const byCode = Object.fromEntries(response.body.items.map(item => [item.status_code, item]));
  assert.equal(byCode['1011'].status, 'failed');
  assert.match(byCode['1011'].status_label, /접수 실패/);
  assert.equal(byCode['2000'].status, 'pending');
  assert.equal(byCode['2000'].status_label, '발송대기');
  assert.equal(byCode['2100'].status, 'failed');
  assert.match(byCode['2100'].status_label, /검토 실패/);
  assert.equal(byCode['3000'].status, 'pending');
  assert.equal(byCode['3000'].status_label, '발송중');
  assert.equal(byCode['3040'].status, 'failed');
  assert.match(byCode['3040'].status_label, /발송 실패/);
  assert.equal(byCode['4000'].status, 'success');
  assert.deepEqual(response.body.counts.all, { total: 6, success: 1, pending: 2, failed: 3 });
});

test('대체 발송은 한 건으로 묶이고 최종 상태는 대체 문자 기준', async () => {
  const ata = msg({ type: 'ATA', statusCode: '3120', groupId: 'GREP', to: OTHER_PHONE, kakaoOptions: { disableSms: false } });
  const lms = msg({ type: 'LMS', statusCode: '4000', groupId: 'GREP', to: OTHER_PHONE, replacement: true, dateCreated: '2026-11-11T02:00:05.000Z' });
  const { response } = await call({}, { messages: [ata, lms] });
  assert.equal(response.body.items.length, 1);
  const item = response.body.items[0];
  assert.equal(item.type_label, 'ATA → LMS');
  assert.equal(item.replaced_from, 'ATA');
  assert.equal(item.status, 'success');
  assert.equal(response.body.counts.all.total, 1);
});

test('대체 발송 10분 유예: 최근 3xxx 는 pending, 오래되면 failed', async () => {
  const recent = msg({ type: 'ATA', statusCode: '3120', to: OTHER_PHONE, kakaoOptions: { disableSms: false },
    dateReported: new Date(NOW - 120000).toISOString() });
  const old = msg({ type: 'ATA', statusCode: '3120', to: OTHER_PHONE, kakaoOptions: { disableSms: false },
    dateReported: new Date(NOW - 1200000).toISOString() });
  const { response } = await call({}, { messages: [recent, old] });
  const byId = Object.fromEntries(response.body.items.map(item => [item.message_id, item]));
  assert.equal(byId[recent.messageId].status, 'pending');
  assert.equal(byId[old.messageId].status, 'failed');
});

test('외부 발송 본문은 앞 40자만', async () => {
  const m = msg({ to: OTHER_PHONE, text: 'ㄱ'.repeat(100), subject: 'S'.repeat(80) });
  const { response } = await call({}, { messages: [m] });
  assert.equal(response.body.items[0].text, `${'ㄱ'.repeat(40)}…`);
  assert.equal(response.body.items[0].subject, `${'S'.repeat(40)}…`);
});

test('페이지 20건, counts 는 status·type 필터 전 값, 보기=groups 면 items=[]', async () => {
  const messages = Array.from({ length: 25 }, (_, i) => msg({
    to: OTHER_PHONE, groupId: `GP${i % 5}`, statusCode: i < 5 ? '3040' : '4000', type: i % 2 ? 'SMS' : 'LMS',
  }));
  const first = await call({ page: '1' }, { messages });
  assert.equal(first.response.body.items.length, 20);
  assert.equal(first.response.body.pagination.total_pages, 2);
  assert.equal(first.response.body.groups.length, 0);
  clearSolapiMessageCache();
  const second = await call({ page: '2' }, { messages });
  assert.equal(second.response.body.items.length, 5);
  clearSolapiMessageCache();
  const failed = await call({ status: 'failed', type: 'SMS' }, { messages });
  assert.equal(failed.response.body.counts.all.total, 25);
  assert.equal(failed.response.body.counts.all.failed, 5);
  assert.ok(failed.response.body.items.length < 5);
  assert.ok(failed.response.body.items.every(item => item.status === 'failed' && item.type === 'SMS'));
  clearSolapiMessageCache();
  const groups = await call({ view: 'groups' }, { messages });
  assert.deepEqual(groups.response.body.items, []);
  assert.equal(groups.response.body.groups.length, 5);
  assert.equal(groups.response.body.groups[0].total, 5);
  assert.ok(groups.response.body.groups[0].recipients_preview.length >= 1);
});

test('잘못된 파라미터 400', async () => {
  for (const query of [{ date: '2026-13-40' }, { audience: 'x' }, { status: 'x' }, { view: 'x' }]) {
    const { response } = await call(query);
    assert.equal(response.statusCode, 400, JSON.stringify(query));
    assert.equal(typeof response.body.error, 'string');
  }
});

test('키 없으면 configured:false 빈 목록, 쏠라피 호출 없음', async () => {
  delete process.env.SOLAPI_API_KEY;
  const { response, fetchImpl, db } = await call({});
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.configured, false);
  assert.deepEqual(response.body.items, []);
  assert.equal(fetchImpl.calls.length, 0);
  assert.equal(db.statements.length, 0);
});

test('쏠라피 실패는 502', async () => {
  const { response } = await call({}, { fetchOpts: { ok: false, status: 500 } });
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.error, '쏠라피 발송내역을 불러오지 못했습니다');
});

test('같은 날짜 두 번째 호출은 쏠라피 fetch 0회, DB 는 SELECT 1번씩', async () => {
  const messages = [msg({ to: OTHER_PHONE })];
  const fetchImpl = fakeFetch(messages);
  const db = fakeDb();
  for (let i = 0; i < 2; i += 1) {
    await handleSolapiMessages({ method: 'GET', query: { date: '2026-11-11' } }, res(), { db, fetchImpl, rateLimitCheck: () => true, nowMs: NOW });
  }
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(db.statements.length, 2);
  assert.match(fetchImpl.calls[0], /limit=500/);
});

test('nextKey 가 3쪽을 넘으면 partial:true', async () => {
  const page = n => ({ messageList: { [`P${n}`]: msg({ messageId: `P${n}`, to: OTHER_PHONE }) }, nextKey: `k${n}` });
  const { response, fetchImpl } = await call({}, { fetchOpts: { pages: [page(1), page(2), page(3)] } });
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(response.body.partial, true);
});

test('GET 이외는 405, 호출 제한 20회/분', async () => {
  const post = res();
  await handleSolapiMessages({ method: 'POST', query: {} }, post, { db: fakeDb(), rateLimitCheck: () => true });
  assert.equal(post.statusCode, 405);
  const seen = [];
  await handleSolapiMessages({ method: 'GET', query: {} }, res(), { db: fakeDb(), rateLimitCheck: (_req, _res, options) => { seen.push(options); return false; } });
  assert.deepEqual(seen, [{ windowMs: 60000, max: 20 }]);
});
