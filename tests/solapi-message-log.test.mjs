import assert from 'node:assert/strict';
import test, { beforeEach, afterEach } from 'node:test';

import { handleSolapiMessages } from '../api/solapi-messages.js';
import { clearSolapiMessageCache } from '../api/_lib/solapiMessageLog.js';
import { clearSolapiGroupCache } from '../api/_lib/solapiGroupLog.js';
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
function fakeFetch(messages, { ok = true, status = 200, pages, groups = [], groupsOk = true } = {}) {
  const calls = [];
  const listCalls = [];
  const groupCalls = [];
  const impl = async url => {
    const text = String(url);
    calls.push(text);
    if (text.includes('/messages/v4/groups')) {
      groupCalls.push(text);
      if (!groupsOk) return { ok: false, status: 500, json: async () => ({}) };
      return { ok: true, status: 200, json: async () => ({ groupList: Object.fromEntries(groups.map(g => [g.groupId, g])) }) };
    }
    listCalls.push(text);
    if (!ok) return { ok, status: status, json: async () => ({}) };
    const body = pages ? pages[listCalls.length - 1] : { messageList: Object.fromEntries(messages.map(m => [m.messageId, m])) };
    return { ok: true, status: 200, json: async () => body };
  };
  impl.calls = listCalls;
  impl.allCalls = calls;
  impl.groupCalls = groupCalls;
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
  clearSolapiGroupCache();
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
  const { response } = await call({ date: '2026-11-11', view: 'messages' }, {
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
  const { response } = await call({ date: '2026-11-11', view: 'messages' }, { messages: [order, ship, free, ad] });
  const byId = Object.fromEntries(response.body.items.map(item => [item.message_id, item]));
  assert.equal(byId[order.messageId].category, '주문 안내(쏠라피 자동발송)');
  assert.equal(byId[ship.messageId].category, '출고 안내(스마트스토어 연동)');
  assert.equal(byId[free.messageId].category, '무료 지원 이벤트(외부 발송)');
  assert.equal(byId[ad.messageId].category, '광고 문자(외부 발송)');
  assert.ok(!JSON.stringify(response.body).includes('customFields'));
});

test('분체 알림은 영업 번호면 직원', async () => {
  const sales = msg({ to: ['010', '7346', '7407'].join('') });
  const { response } = await call({ view: 'messages' }, {
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
  const { response } = await call({ view: 'messages' }, { messages: [a, b], rows });
  const byId = Object.fromEntries(response.body.items.map(item => [item.message_id, item]));
  assert.equal(byId[a.messageId].category, '포장 완료');
  assert.equal(byId[a.messageId].audience, 'customer');
  assert.equal(byId[b.messageId].category, '지연 알림');
  assert.equal(byId[b.messageId].audience, 'staff');
});

test('응답에 원번호와 customFields 가 없고 번호는 가려진다', async () => {
  const m = msg({ text: `문의 ${CUSTOMER_PHONE.slice(0, 3)}-${CUSTOMER_PHONE.slice(3, 7)}-${CUSTOMER_PHONE.slice(7)} 입니다` });
  const { response } = await call({ view: 'messages' }, { messages: [m] });
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
  const { response } = await call({ view: 'messages' }, { messages });
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
  const { response } = await call({ view: 'messages' }, { messages: [ata, lms] });
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
  const { response } = await call({ view: 'messages' }, { messages: [recent, old] });
  const byId = Object.fromEntries(response.body.items.map(item => [item.message_id, item]));
  assert.equal(byId[recent.messageId].status, 'pending');
  assert.equal(byId[old.messageId].status, 'failed');
});

test('외부 발송 본문은 앞 40자만', async () => {
  const m = msg({ to: OTHER_PHONE, text: 'ㄱ'.repeat(100), subject: 'S'.repeat(80) });
  const { response } = await call({ view: 'messages' }, { messages: [m] });
  assert.equal(response.body.items[0].text, `${'ㄱ'.repeat(40)}…`);
  assert.equal(response.body.items[0].subject, `${'S'.repeat(40)}…`);
});

test('쪽 크기(기본 50·20/50/100), counts 는 status·type 필터 전 값, 보기=groups 면 items=[]', async () => {
  const messages = Array.from({ length: 55 }, (_, i) => msg({
    to: OTHER_PHONE, groupId: `GP${String(i % 5).padStart(10, '0')}`, statusCode: i < 5 ? '3040' : '4000', type: i % 2 ? 'SMS' : 'LMS',
  }));
  const first = await call({ view: 'messages', page: '1' }, { messages });
  assert.equal(first.response.body.items.length, 50);
  assert.equal(first.response.body.pagination.page_size, 50);
  assert.equal(first.response.body.pagination.total_pages, 2);
  assert.equal(first.response.body.groups.length, 0);
  clearSolapiMessageCache();
  const second = await call({ view: 'messages', page: '2' }, { messages });
  assert.equal(second.response.body.items.length, 5);
  clearSolapiMessageCache();
  const small = await call({ view: 'messages', page_size: '20' }, { messages });
  assert.equal(small.response.body.items.length, 20);
  assert.equal(small.response.body.pagination.total_pages, 3);
  clearSolapiMessageCache();
  const failed = await call({ view: 'messages', status: 'failed', type: 'SMS' }, { messages });
  assert.equal(failed.response.body.counts.all.total, 55);
  assert.equal(failed.response.body.counts.all.failed, 5);
  assert.ok(failed.response.body.items.length < 5);
  assert.ok(failed.response.body.items.every(item => item.status === 'failed' && item.type === 'SMS'));
  clearSolapiMessageCache();
  clearSolapiGroupCache();
  const slim = Array.from({ length: 5 }, (_, i) => ({ groupId: `GP${String(i).padStart(10, '0')}`, status: 'COMPLETE', dateCreated: '2026-11-11T02:00:00.000Z', count: { total: 11, sentTotal: 11 }, app: {} }));
  const groups = await call({}, { messages, fetchOpts: { groups: slim } });
  assert.deepEqual(groups.response.body.items, []);
  assert.equal(groups.response.body.groups.length, 5);
  assert.equal(groups.response.body.groups[0].total, 11);
  assert.ok(groups.response.body.groups[0].recipients_preview.length >= 1);
  assert.equal(groups.response.body.group_counts.all, 5);
});

test('잘못된 파라미터 400', async () => {
  const badQueries = [{ date: '2026-13-40' }, { audience: 'x' }, { status: 'x' }, { view: 'x' }, { page_size: '30' }, { group_status: 'x' },
    { to4: '12' }, { from: 'abc' }, { group_id: 'short' }, { template_id: 'a b' }, { message_id: 'x y' }, { min_total: '-1' }, { min_sent: '100001' }];
  for (const query of badQueries) {
    const { response } = await call(query);
    assert.equal(response.statusCode, 400, JSON.stringify(query));
    assert.equal(typeof response.body.error, 'string');
  }
});

test('화면이 보낼 수 있는 값은 400 이 아니다(긴 타입명·건수 상한 100000)', async () => {
  const okQueries = [{ view: 'messages', type: 'BMS_CAROUSEL_FEED' }, { min_total: '100000' }, { min_sent: '0' }];
  for (const query of okQueries) {
    clearSolapiMessageCache(); clearSolapiGroupCache();
    const { response } = await call(query);
    assert.notEqual(response.statusCode, 400, JSON.stringify(query));
  }
  const { response } = await call({ type: 'A'.repeat(31) });
  assert.equal(response.statusCode, 400);
});

test('키 없으면 configured:false 빈 목록, 쏠라피 호출 없음', async () => {
  delete process.env.SOLAPI_API_KEY;
  const { response, fetchImpl, db } = await call({});
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.configured, false);
  assert.deepEqual(response.body.items, []);
  assert.deepEqual(response.body.group_counts, { all: 0, customer: 0, staff: 0, other: 0 });
  assert.equal(fetchImpl.allCalls.length, 0);
  assert.equal(db.statements.length, 0);
});

test('쏠라피 실패는 502', async () => {
  const { response } = await call({ view: 'messages' }, { fetchOpts: { ok: false, status: 500 } });
  assert.equal(response.statusCode, 502);
  assert.equal(response.body.error, '쏠라피 발송내역을 불러오지 못했습니다');
});

test('같은 날짜 두 번째 호출은 쏠라피 fetch 0회, DB 는 SELECT 1번씩', async () => {
  const messages = [msg({ to: OTHER_PHONE })];
  const fetchImpl = fakeFetch(messages, { groups: [] });
  const db = fakeDb();
  for (let i = 0; i < 2; i += 1) {
    await handleSolapiMessages({ method: 'GET', query: { date: '2026-11-11' } }, res(), { db, fetchImpl, rateLimitCheck: () => true, nowMs: NOW });
  }
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.groupCalls.length, 1);
  assert.equal(db.statements.length, 2);
  assert.match(fetchImpl.calls[0], /limit=500/);
});

test('nextKey 가 3쪽을 넘으면 partial:true', async () => {
  const page = n => ({ messageList: { [`P${n}`]: msg({ messageId: `P${n}`, to: OTHER_PHONE }) }, nextKey: `k${n}` });
  const { response, fetchImpl } = await call({ view: 'messages' }, { fetchOpts: { pages: [page(1), page(2), page(3)] } });
  assert.equal(fetchImpl.calls.length, 3);
  assert.equal(response.body.partial, true);
});

test('GET 이외는 405, 호출 제한 20회/분', async () => {
  const post = res();
  await handleSolapiMessages({ method: 'POST', query: {} }, post, { db: fakeDb(), rateLimitCheck: () => true });
  assert.equal(post.statusCode, 405);
  const seen = [];
  await handleSolapiMessages({ method: 'GET', query: {} }, res(), { db: fakeDb(), rateLimitCheck: (_req, _res, options) => { seen.push(options); return false; } });
  assert.deepEqual(seen, [{ windowMs: 60000, max: 40 }]);
});

const SLIM = (groupId, over = {}) => ({
  groupId, status: 'COMPLETE', dateCreated: '2026-11-11T02:00:00.000Z', dateUpdated: '2026-11-11T02:01:00.000Z',
  count: { total: 2, sentTotal: 2, sentSuccess: 2, sentFailed: 0, sentPending: 0 }, app: {}, log: [{ createAt: '2026-11-11T02:01:00.000Z', message: '발송 완료' }],
  ...over,
});

test('그룹 보기: 출처·구분 필터·그룹 필터·group_counts(혼합은 양쪽에 셈)', async () => {
  const laser = INTERNAL_ALERT_CONTACTS.laser;
  const a = msg({ groupId: 'GAUTO000001', to: OTHER_PHONE });
  const b = msg({ groupId: 'GMIX0000001', to: OTHER_PHONE });
  const c = msg({ groupId: 'GMIX0000001', to: laser.phone });
  const groups = [
    SLIM('GAUTO000001', { app: { appId: 'JfpLPhLYJqGV' } }),
    SLIM('GMIX0000001', { count: { total: 5, sentTotal: 5, sentSuccess: 4, sentFailed: 1, sentPending: 0 } }),
  ];
  const { response } = await call({ date: '2026-11-11' }, { messages: [a, b, c], fetchOpts: { groups } });
  const body = response.body;
  assert.equal(body.groups_partial, false);
  assert.deepEqual(body.group_counts, { all: 2, customer: 2, staff: 1, other: 0 });
  const byId = Object.fromEntries(body.groups.map(g => [g.group_id, g]));
  assert.equal(byId.GAUTO000001.source, 'AUTO');
  assert.equal(byId.GMIX0000001.source, 'API');
  assert.equal(byId.GMIX0000001.audience, 'mixed');
  assert.equal(byId.GMIX0000001.status_label, '처리완료');
  assert.equal(byId.GMIX0000001.failed, 1);
  clearSolapiMessageCache(); clearSolapiGroupCache();
  const staff = await call({ audience: 'staff' }, { messages: [a, b, c], fetchOpts: { groups } });
  assert.deepEqual(staff.response.body.groups.map(g => g.group_id), ['GMIX0000001']);
  clearSolapiMessageCache(); clearSolapiGroupCache();
  const min = await call({ min_total: '3', group_status: 'COMPLETE' }, { messages: [a, b, c], fetchOpts: { groups } });
  assert.deepEqual(min.response.body.groups.map(g => g.group_id), ['GMIX0000001']);
  clearSolapiMessageCache(); clearSolapiGroupCache();
  const one = await call({ group_id: 'GAUTO000001' }, { messages: [a, b, c], fetchOpts: { groups } });
  assert.deepEqual(one.response.body.groups.map(g => g.group_id), ['GAUTO000001']);
});

test('우리 기록에 없는 고객 문자 종류는 그룹 출처 이름으로, 건별 필드 추가·group_map·senders', async () => {
  const m = msg({
    groupId: 'GAUTO000002', to: OTHER_PHONE, type: 'ATA', text: '안녕하세요 주문이 정상 접수되었습니다', statusCode: '4000',
    networkName: 'KT', country: '82', autoTypeDetect: true, dateUpdated: '2026-11-11T02:00:40.000Z', dateProcessed: '2026-11-11T02:00:10.000Z',
    kakaoOptions: { templateId: 'KA01TP-abc', disableSms: false },
    log: [{ createAt: '2026-11-11T02:00:11.000Z', message: `접수 ${CUSTOMER_PHONE}` }],
    customFields: { hookId: 'H1' },
  });
  const groups = [SLIM('GAUTO000002', { app: { appId: 'JfpLPhLYJqGV' } })];
  const { response } = await call({ view: 'messages', template_id: 'KA01TP-abc' }, { messages: [m], fetchOpts: { groups } });
  const item = response.body.items[0];
  assert.equal(item.category, '주문 안내(쏠라피 자동화)');
  assert.equal(item.source, 'AUTO');
  assert.equal(item.status_text, '발송완료');
  assert.equal(item.reason, null);
  assert.equal(item.network_name, 'KT');
  assert.equal(item.country, '82');
  assert.equal(item.auto_type_detect, true);
  assert.equal(item.disable_sms, false);
  assert.equal(item.replacement, false);
  assert.equal(item.template_id, 'KA01TP-abc');
  assert.equal(item.type_name, '알림톡');
  assert.equal(item.bytes, 2 * '안녕하세요 주문이 정상 접수되었습니다'.replace(/ /g, '').length + 3);
  assert.equal(item.processed_at, '2026-11-11T02:00:10.000Z');
  assert.equal(item.updated_at, '2026-11-11T02:00:40.000Z');
  assert.equal(item.log.length, 1);
  assert.ok(!JSON.stringify(response.body).includes(CUSTOMER_PHONE));
  assert.deepEqual(response.body.senders, [{ from: '031****2458', count: 1 }]);
  assert.equal(response.body.group_map.GAUTO000002.source, 'AUTO');
  clearSolapiMessageCache(); clearSolapiGroupCache();
  const none = await call({ view: 'messages', template_id: 'other' }, { messages: [m], fetchOpts: { groups } });
  assert.equal(none.response.body.items.length, 0);
  clearSolapiMessageCache(); clearSolapiGroupCache();
  const sender = await call({ view: 'messages', from: '031****2458', to4: '0001' }, { messages: [m, msg({ to: CUSTOMER_PHONE })], fetchOpts: { groups } });
  assert.equal(sender.response.body.items.length, 1);
});

test('그룹 조회 실패해도 메시지만으로 계속(groups_partial:true, 대체 그룹)', async () => {
  const messages = [msg({ groupId: 'GFALLBACK01', to: OTHER_PHONE }), msg({ groupId: 'GFALLBACK01', to: OTHER_PHONE })];
  const { response } = await call({}, { messages, fetchOpts: { groupsOk: false } });
  assert.equal(response.statusCode, 200);
  assert.equal(response.body.groups_partial, true);
  assert.equal(response.body.groups.length, 1);
  assert.equal(response.body.groups[0].total, 2);
  assert.equal(response.body.group_counts.all, 1);
  clearSolapiMessageCache(); clearSolapiGroupCache();
  const items = await call({ view: 'messages' }, { messages, fetchOpts: { groupsOk: false } });
  assert.equal(items.response.body.items.length, 2);
  assert.equal(items.response.body.items[0].source, null);
});
