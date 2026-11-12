import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSmsConsole } from '../api/sms-console.js';
import { _resetManualSendSchemaForTest, sendOptions } from '../api/_lib/smsManualSend.js';
import { classifyText, getSendProvider } from '../api/_lib/sendProvider.js';
import { buildRecipients, lockedLine, parsePhoneInput, textInfo } from '../src/components/smsconsole/sendPanelModel.js';
import { CONSOLE_MENUS, parseConsoleQuery } from '../shared/smsConsole.js';

const NOW = Date.parse('2026-11-12T03:00:00Z');
const PHONE_A = '01012345678';
const PHONE_B = '010-2222-3333';
const response = () => ({ statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const request = (body, ip = '9.9.9.9') => ({
  method: 'POST', body, query: {}, url: '/api/sms-console', socket: { remoteAddress: ip },
  headers: { origin: 'https://production-status.vercel.app', host: 'production-status.vercel.app', 'x-forwarded-proto': 'https' },
});
const ENV = { SMS_SENDER: '0211112222', SOLAPI_API_KEY: 'k', SOLAPI_API_SECRET: 's' };
const STAFF = [{ id: 'contact-material', name: '홍길동 부장', phone: '01099998888' }];

function fakeDb() {
  const rows = new Map();
  const log = [];
  return {
    rows, log,
    async execute({ sql, args }) {
      log.push({ sql, args });
      const text = sql.trim();
      if (text.startsWith('CREATE TABLE')) return { rows: [] };
      if (text.includes('SUM(recipient_count)')) return { rows: [{ n: [...rows.values()].reduce((a, r) => a + r.recipient_count, 0) }] };
      if (text.startsWith('INSERT')) {
        if (rows.has(args[0])) return { rows: [] };
        rows.set(args[0], { idem_key: args[0], msg_type: args[1], recipient_count: args[2], text_length: args[3], tails: args[4], hash: args[5], status: 'sending', success_count: 0, fail_count: 0 });
        return { rows: [{ id: rows.size }] };
      }
      if (text.startsWith('UPDATE')) {
        const row = rows.get(args[5]);
        Object.assign(row, { status: args[0], success_count: args[1], fail_count: args[2], group_id: args[3], error: args[4] });
        return { rows: [] };
      }
      if (text.startsWith('SELECT status')) return { rows: [rows.get(args[0])].filter(Boolean) };
      throw new Error(`예상 못 한 SQL ${sql}`);
    },
  };
}
function fakeProvider(over = {}) {
  const calls = [];
  return {
    calls,
    estimate: (...a) => getSendProvider('solapi').estimate(...a),
    async send(input) { calls.push(input); return { accepted: input.recipients.length, failed: 0, groupId: 'G1', uncertain: false, error: '', ...over }; },
  };
}
const setup = (over = {}) => {
  _resetManualSendSchemaForTest();
  const db = fakeDb();
  const sendProvider = fakeProvider();
  return { db, sendProvider, deps: { db, sendProvider, env: { ...ENV }, staff: STAFF, rateLimitCheck: () => true, nowMs: NOW, ...over } };
};
const payload = (over = {}) => ({ action: 'send', recipients: [PHONE_A], text: '안녕하세요 시험입니다', idempotencyKey: 'key-0000001', ...over });
const run = async (body, deps) => { const res = response(); await handleSmsConsole(request(body), res, deps); return res; };

test('1. 쓰기 스위치 꺼짐 또는 SMS_SEND=off → 업체 호출 0 (스위치 환경값 없이 켜짐이 기본)', async () => {
  const off = setup({ guard: { writeStatus: async () => ({ enabled: false, reason: 'disabled' }) } });
  assert.equal((await run(payload(), off.deps)).statusCode, 403);
  assert.equal((await run(payload({ dry_run: true }), off.deps)).statusCode, 403);
  assert.equal(off.sendProvider.calls.length, 0);
  const sendOff = setup({ env: { ...ENV, SMS_SEND: 'off' } });
  assert.equal((await run(payload(), sendOff.deps)).statusCode, 403);
  assert.equal(sendOff.sendProvider.calls.length, 0);
  const on = setup();
  assert.equal((await run(payload(), on.deps)).statusCode, 200);
  assert.equal(on.sendProvider.calls.length, 1);
});

test('2. 1회 인원·하루 상한 초과 → 거절', async () => {
  let ctx = setup({ env: { ...ENV, SMS_SEND_MAX_RECIPIENTS: '2' } });
  let res = await run(payload({ recipients: [PHONE_A, PHONE_B, '01077776666'] }), ctx.deps);
  assert.equal(res.statusCode, 400);
  assert.equal(ctx.sendProvider.calls.length, 0);
  ctx = setup({ env: { ...ENV, SMS_SEND_DAILY_LIMIT: '2' } });
  res = await run(payload({ recipients: [PHONE_A, PHONE_B] }), ctx.deps);
  assert.equal(res.statusCode, 200);
  res = await run(payload({ idempotencyKey: 'key-0000002', recipients: ['01055554444'] }), ctx.deps);
  assert.equal(res.statusCode, 429);
  assert.equal(ctx.sendProvider.calls.length, 1);
});

test('3. 같은 멱등 키 두 번 → 업체 호출 1', async () => {
  const { sendProvider, deps } = setup();
  const first = await run(payload(), deps);
  const second = await run(payload(), deps);
  assert.equal(first.statusCode, 200);
  assert.equal(second.body.duplicate, true);
  assert.equal(sendProvider.calls.length, 1);
  assert.equal(sendProvider.calls[0].from, '0211112222');
  const spoof = setup();
  await run(payload({ idempotencyKey: 'key-0000009', from: '01000000000' }), spoof.deps);
  assert.equal(spoof.sendProvider.calls[0].from, '0211112222');
});

test('3-2. INSERT 뒤 합계가 상한을 넘으면 → 업체 호출 0, 429, 그 행 rejected', async () => {
  const { db, sendProvider, deps } = setup({ env: { ...ENV, SMS_SEND_DAILY_LIMIT: '2' } });
  const base = db.execute.bind(db);
  let sums = 0;
  db.execute = async (q) => {
    if (q.sql.includes('SUM(recipient_count)')) { sums += 1; return { rows: [{ n: sums === 1 ? 0 : 3 }] }; }
    if (q.sql.trim().startsWith('UPDATE') && q.sql.includes("'rejected'")) { Object.assign(db.rows.get(q.args[0]), { status: 'rejected', recipient_count: 0 }); return { rows: [] }; }
    return base(q);
  };
  const res = await run(payload({ recipients: [PHONE_A, PHONE_B] }), deps);
  assert.equal(res.statusCode, 429);
  assert.equal(sendProvider.calls.length, 0);
  const row = db.rows.get('key-0000001');
  assert.deepEqual([row.status, row.recipient_count], ['rejected', 0]);
});

test('4. 응답·기록에 번호 전체·이름 없음 (직원 id 로 보내도 마찬가지)', async () => {
  const { db, deps } = setup();
  const res = await run(payload({ recipients: [PHONE_A, PHONE_B, 'contact-material'], text: '비밀 본문 내용 123' }), deps);
  assert.equal(res.statusCode, 200);
  const dump = JSON.stringify([res.body, db.log.map(item => item.args), [...db.rows.values()]]);
  for (const secret of ['01012345678', '0101234567', '010-2222-3333', '01022223333', '01099998888', '홍길동', '비밀 본문']) assert.ok(!dump.includes(secret), `노출: ${secret}`);
  const row = [...db.rows.values()][0];
  assert.equal(row.tails, '5678,3333,8888');
  assert.equal(row.hash.length, 64);
  assert.deepEqual(Object.keys(res.body).sort(), ['cost', 'count', 'fail', 'sent', 'status', 'success', 'type']);
  const options = sendOptions({ ...ENV }, STAFF, true);
  assert.equal(JSON.stringify(options).includes('01099998888'), false);
  assert.equal(options.staff[0].tail, '8888');
});

test('5. (광고) 로 시작하면 거절', async () => {
  const { sendProvider, deps } = setup();
  assert.equal((await run(payload({ text: '(광고) 할인 안내' }), deps)).statusCode, 400);
  assert.equal((await run(payload({ text: '안내', subject: '(광고) 제목' }), deps)).statusCode, 400);
  assert.equal(sendProvider.calls.length, 0);
});

test('dry_run: 인원·종류·예상 비용만, 업체 호출 0·기록 0', async () => {
  const { db, sendProvider, deps } = setup();
  const short = await run(payload({ dry_run: true, recipients: [PHONE_A, PHONE_B] }), deps);
  assert.deepEqual([short.body.count, short.body.type, short.body.cost], [2, 'SMS', 36]);
  const long = await run(payload({ dry_run: true, text: '가'.repeat(60) }), deps);
  assert.deepEqual([long.body.type, long.body.cost], ['LMS', 45]);
  assert.equal(sendProvider.calls.length, 0);
  assert.equal(db.rows.size, 0);
});

test('입력 검증: 번호 형식·빈 내용·키 없음', async () => {
  const { sendProvider, deps } = setup();
  assert.equal((await run(payload({ recipients: ['12345'] }), deps)).statusCode, 400);
  assert.equal((await run(payload({ text: '  ' }), deps)).statusCode, 400);
  assert.equal((await run(payload({ idempotencyKey: '' }), deps)).statusCode, 400);
  assert.equal((await run(payload({ recipients: [] }), deps)).statusCode, 400);
  assert.equal(sendProvider.calls.length, 0);
});

test('업체가 일부 실패·확인 불가를 돌려줘도 숫자만 기록한다', async () => {
  const partial = setup();
  partial.sendProvider = fakeProvider({ accepted: 1, failed: 1 });
  const r1 = await run(payload({ recipients: [PHONE_A, PHONE_B] }), { ...partial.deps, sendProvider: partial.sendProvider });
  assert.deepEqual([r1.body.status, r1.body.success, r1.body.fail], ['partial', 1, 1]);
  const unsure = setup();
  const prov = fakeProvider({ accepted: 0, failed: 0, uncertain: true, error: '쏠라피 응답을 확인하지 못했습니다' });
  const r2 = await run(payload(), { ...unsure.deps, sendProvider: prov });
  assert.equal(r2.body.uncertain, true);
  const r3 = await run(payload(), { ...unsure.deps, sendProvider: prov });
  assert.equal(r3.body.duplicate, true);
  assert.equal(prov.calls.length, 1);
});

test('쏠라피 업체 구현: 여러 건 1회 호출, 응답 해석', async () => {
  const provider = getSendProvider('solapi');
  const seen = [];
  const prev = { ...process.env };
  process.env.SOLAPI_API_KEY = 'k'; process.env.SOLAPI_API_SECRET = 's';
  try {
    const fetchImpl = async (url, init) => { seen.push([String(url), JSON.parse(init.body)]); return { ok: true, status: 200, json: async () => ({ groupInfo: { groupId: 'G9' }, failedMessageList: [{ to: PHONE_B }] }) }; };
    const out = await provider.send({ type: 'LMS', from: '0211112222', recipients: [PHONE_A, '01022223333'], text: '긴 내용', subject: '제목' }, { fetchImpl });
    assert.equal(seen.length, 1);
    assert.equal(seen[0][0], 'https://api.solapi.com/messages/v4/send-many/detail');
    assert.equal(seen[0][1].messages.length, 2);
    assert.deepEqual([out.accepted, out.failed, out.groupId, out.uncertain], [1, 1, 'G9', false]);
    const down = await provider.send({ type: 'SMS', from: '1', recipients: [PHONE_A], text: 'a' }, { fetchImpl: async () => ({ ok: false, status: 500, json: async () => null }) });
    assert.equal(down.uncertain, true);
    const rejected = await provider.send({ type: 'SMS', from: '1', recipients: [PHONE_A], text: 'a' }, { fetchImpl: async () => ({ ok: false, status: 400, json: async () => ({ errorMessage: '발신번호 오류' }) }) });
    assert.deepEqual([rejected.uncertain, rejected.failed], [false, 1]);
  } finally {
    process.env.SOLAPI_API_KEY = prev.SOLAPI_API_KEY; process.env.SOLAPI_API_SECRET = prev.SOLAPI_API_SECRET;
    if (prev.SOLAPI_API_KEY === undefined) delete process.env.SOLAPI_API_KEY;
    if (prev.SOLAPI_API_SECRET === undefined) delete process.env.SOLAPI_API_SECRET;
  }
});

test('GET resource=send: 설정·직원(끝 4자리)만, 업체 호출 없음', async () => {
  const res = response();
  await handleSmsConsole({ method: 'GET', query: { resource: 'send' }, url: '/api/sms-console', socket: { remoteAddress: '1.1.1.1' }, headers: {} }, res, { env: { ...ENV }, staff: STAFF, rateLimitCheck: () => true, hasCredentials: () => true, guard: { writeStatus: async () => ({ enabled: true }) } });
  assert.equal(res.statusCode, 200);
  assert.deepEqual([res.body.enabled, res.body.max], [true, 50]);
  assert.deepEqual(res.body.staff, [{ id: 'contact-material', name: '홍길동 부장', tail: '8888' }]);
});

test('화면 모델·메뉴', () => {
  assert.deepEqual(CONSOLE_MENUS.map(m => m.id).slice(0, 2), ['dashboard', 'send']);
  assert.equal(parseConsoleQuery({ menu: 'send' }).menu, 'send');
  assert.deepEqual(parsePhoneInput('010-1234-5678\n01012345678, 123').map(i => i.ok), [true, false]);
  assert.deepEqual(buildRecipients('01012345678', ['contact-material']), { recipients: ['01012345678', 'contact-material'], invalid: 0 });
  assert.deepEqual([textInfo('가'.repeat(45)).type, textInfo('가'.repeat(46)).type, textInfo('').type], ['SMS', 'LMS', '']);
  assert.equal(classifyText('a'.repeat(2001)).type, null);
  assert.equal(lockedLine({ enabled: false }), '발송이 꺼져 있습니다.');
  assert.equal(lockedLine({ enabled: true }), '');
});
