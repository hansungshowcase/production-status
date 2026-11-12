import assert from 'node:assert/strict';
import test from 'node:test';
import { handleSmsConsole } from '../api/sms-console.js';
import { _resetManualSendSchemaForTest, parseKstSchedule } from '../api/_lib/smsManualSend.js';
import { getSendProvider, MMS_MAX_BYTES } from '../api/_lib/sendProvider.js';
import { fitDimensions, scheduleInfo, shortKst } from '../src/components/smsconsole/sendPanelModel.js';

const NOW = Date.parse('2026-11-12T03:00:00Z'); // KST 12:00
const ENV = { SMS_SENDER: '0211112222', SOLAPI_API_KEY: 'k', SOLAPI_API_SECRET: 's' };
const response = () => ({ statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
const request = (body, method = 'POST', query = {}) => ({
  method, body, query, url: '/api/sms-console', socket: { remoteAddress: '9.9.9.9' },
  headers: { origin: 'https://production-status.vercel.app', host: 'production-status.vercel.app', 'x-forwarded-proto': 'https' },
});

// 5단계 기록 표 흉내: 예약 칸·그룹 id·취소 상태까지 다룬다.
function fakeDb() {
  const rows = new Map();
  let seq = 0;
  const log = [];
  return {
    rows, log,
    async execute({ sql, args }) {
      log.push({ sql, args });
      const text = sql.trim();
      if (text.startsWith('CREATE TABLE') || text.startsWith('ALTER TABLE')) return { rows: [] };
      if (text.includes('SUM(recipient_count)')) return { rows: [{ n: [...rows.values()].reduce((a, r) => a + r.recipient_count, 0) }] };
      if (text.startsWith('INSERT')) {
        if (rows.has(args[0])) return { rows: [] };
        seq += 1;
        rows.set(args[0], { id: seq, idem_key: args[0], msg_type: args[1], recipient_count: args[2], tails: args[4], status: 'sending', success_count: 0, fail_count: 0, group_id: null, scheduled_at: null });
        return { rows: [{ id: seq }] };
      }
      if (text.startsWith('DELETE')) { rows.delete(args[0]); return { rows: [] }; }
      if (text.startsWith('UPDATE sms_manual_sends SET scheduled_at')) { Object.assign(rows.get(args[1]), { scheduled_at: args[0] }); return { rows: [] }; }
      if (text.startsWith("UPDATE sms_manual_sends SET status = 'cancelled'")) { [...rows.values()].find(r => r.id === args[0]).status = 'cancelled'; return { rows: [] }; }
      if (text.startsWith('UPDATE')) { Object.assign(rows.get(args[5]), { status: args[0], success_count: args[1], fail_count: args[2], group_id: args[3], error: args[4] }); return { rows: [] }; }
      if (text.startsWith('SELECT status, msg_type')) return { rows: [rows.get(args[0])].filter(Boolean) };
      if (text.startsWith('SELECT id, status, scheduled_at')) return { rows: [...rows.values()].filter(r => r.id === args[0]) };
      if (text.startsWith('SELECT id, scheduled_at')) {
        return { rows: [...rows.values()].filter(r => r.scheduled_at && Date.parse(r.scheduled_at) > Date.parse(args[0]) && ['sent', 'partial'].includes(r.status) && r.group_id) };
      }
      throw new Error(`예상 못 한 SQL ${sql}`);
    },
  };
}
function fakeProvider() {
  const p = {
    sends: [], uploads: [], cancels: [],
    estimate: (...a) => getSendProvider('solapi').estimate(...a),
    async send(input) { p.sends.push(input); return { accepted: input.recipients.length, failed: 0, groupId: 'GROUP-1', uncertain: false, error: '' }; },
    async uploadImage(input) { p.uploads.push(input); return { fileId: 'FILE-1' }; },
    async cancelSchedule(input) { p.cancels.push(input); return { ok: true, error: '' }; },
  };
  return p;
}
const setup = () => {
  _resetManualSendSchemaForTest();
  const db = fakeDb();
  const sendProvider = fakeProvider();
  return { db, sendProvider, deps: { db, sendProvider, env: { ...ENV }, staff: [], rateLimitCheck: () => true, nowMs: NOW } };
};
const payload = (over = {}) => ({ action: 'send', recipients: ['01012345678'], text: '안녕하세요 시험입니다', idempotencyKey: 'key-0000001', ...over });
const run = async (body, deps, method = 'POST', query = {}) => { const res = response(); await handleSmsConsole(request(body, method, query), res, deps); return res; };
const jpeg = bytes => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(Math.max(0, bytes - 4), 1)]).toString('base64');

test('5-1. 예약 시각 과거·너무 가까움·너무 멂·형식 오류 → 거절, 업체 호출 0', async () => {
  const { sendProvider, deps } = setup();
  for (const at of ['2026-11-12T11:00', '2026-11-12T12:03', '2026-12-30T12:00', '2026-02-31T12:00', '내일']) {
    const res = await run(payload({ scheduled_at: at }), deps);
    assert.equal(res.statusCode, 400, at);
  }
  assert.equal(sendProvider.sends.length, 0);
  assert.equal(parseKstSchedule('2026-11-13T09:30').iso, '2026-11-13T00:30:00.000Z');
});

test('5-1. 정상 예약 → 업체 요청에 예약 칸, 기록에 시각·그룹 id, 응답에 예약 시각', async () => {
  const { db, sendProvider, deps } = setup();
  const res = await run(payload({ scheduled_at: '2026-11-13T09:30' }), deps);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.scheduled_at, '2026-11-13T09:30');
  assert.equal(sendProvider.sends.length, 1);
  assert.equal(sendProvider.sends[0].scheduledAt, '2026-11-13T00:30:00.000Z');
  const row = db.rows.get('key-0000001');
  assert.equal(row.scheduled_at, '2026-11-13T00:30:00.000Z');
  assert.equal(row.group_id, 'GROUP-1');
  // 미리보기는 기록·업체 호출 없이 예약 시각만 돌려준다
  const dry = await run(payload({ scheduled_at: '2026-11-13T09:30', dry_run: true, idempotencyKey: undefined }), deps);
  assert.equal(dry.body.scheduled_at, '2026-11-13T09:30');
  assert.equal(sendProvider.sends.length, 1);
});

test('5-1. 예약 없는 발송은 예전과 같다(예약 칸·ALTER 없음, 응답 키 같음)', async () => {
  const { db, sendProvider, deps } = setup();
  const res = await run(payload(), deps);
  assert.equal('scheduledAt' in sendProvider.sends[0], false);
  assert.equal('fileId' in sendProvider.sends[0], false);
  assert.deepEqual(Object.keys(res.body).sort(), ['cost', 'count', 'fail', 'sent', 'status', 'success', 'type']);
  assert.ok(!db.log.some(item => item.sql.includes('ALTER TABLE')));
});

test('5-2. GET 예약 목록(끝 4자리만) → 취소 → 업체 취소 1·기록 cancelled, 다시 취소·나간 것 취소 → 거절', async () => {
  const { db, sendProvider, deps } = setup();
  await run(payload({ scheduled_at: '2026-11-13T09:30' }), deps);
  const list = await run(null, { ...deps, guard: { writeStatus: async () => ({ enabled: true }) } }, 'GET', { resource: 'send' });
  assert.equal(list.body.scheduled.length, 1);
  assert.equal(list.body.scheduled[0].tails[0], '5678');
  assert.equal(JSON.stringify(list.body).includes('01012345678'), false);
  const id = list.body.scheduled[0].id;
  const ok = await run({ action: 'send_cancel', id }, deps);
  assert.equal(ok.statusCode, 200);
  assert.deepEqual(sendProvider.cancels, [{ groupId: 'GROUP-1' }]);
  assert.equal(db.rows.get('key-0000001').status, 'cancelled');
  assert.equal((await run({ action: 'send_cancel', id }, deps)).statusCode, 409);
  assert.equal(sendProvider.cancels.length, 1);
  // 이미 나간 문자(예약 시각이 지남)
  const late = setup();
  await run(payload({ scheduled_at: '2026-11-13T09:30' }), late.deps);
  const later = await run({ action: 'send_cancel', id: 1 }, { ...late.deps, nowMs: Date.parse('2026-11-13T01:00:00Z') });
  assert.equal(later.statusCode, 409);
  assert.equal(late.sendProvider.cancels.length, 0);
  // 예약이 아닌 일반 발송 기록
  const plain = setup();
  await run(payload(), plain.deps);
  assert.equal((await run({ action: 'send_cancel', id: 1 }, plain.deps)).statusCode, 409);
  assert.equal((await run({ action: 'send_cancel', id: 'x' }, plain.deps)).statusCode, 400);
});

test('5-3. 사진: 형식·용량 초과 → 거절, 올리기 0', async () => {
  const { sendProvider, deps } = setup();
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]).toString('base64');
  assert.equal((await run(payload({ image: { data: png } }), deps)).statusCode, 400);
  assert.equal((await run(payload({ image: { data: jpeg(MMS_MAX_BYTES + 10) } }), deps)).statusCode, 400);
  assert.equal((await run(payload({ image: { data: '' } }), deps)).statusCode, 400);
  assert.equal(sendProvider.uploads.length, 0);
  assert.equal(sendProvider.sends.length, 0);
});

test('5-3. 사진 정상 → 올리기 1 + 발송 요청에 사진 id·MMS, dry_run 은 올리기 0', async () => {
  const { sendProvider, deps } = setup();
  const dry = await run(payload({ image: { data: jpeg(5000) }, dry_run: true }), deps);
  assert.equal(dry.body.type, 'MMS');
  assert.equal(dry.body.cost, 110);
  assert.equal(sendProvider.uploads.length, 0);
  const res = await run(payload({ image: { data: `data:image/jpeg;base64,${jpeg(5000)}` } }), deps);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.type, 'MMS');
  assert.equal(sendProvider.uploads.length, 1);
  assert.equal(sendProvider.sends[0].fileId, 'FILE-1');
  assert.equal(sendProvider.sends[0].type, 'MMS');
  // 같은 키로 다시 → 올리기·발송 모두 0
  const again = await run(payload({ image: { data: jpeg(5000) } }), deps);
  assert.equal(again.body.duplicate, true);
  assert.equal(sendProvider.uploads.length, 1);
  assert.equal(sendProvider.sends.length, 1);
});

test('5-3. 올리기 실패 → 발송 0, 같은 키로 다시 보낼 수 있다, 기록에 사진·번호 전체 없음', async () => {
  const { db, sendProvider, deps } = setup();
  sendProvider.uploadImage = async () => { throw new Error('boom'); };
  const bad = await run(payload({ image: { data: jpeg(5000) } }), deps);
  assert.equal(bad.statusCode, 502);
  assert.equal(sendProvider.sends.length, 0);
  assert.equal(db.rows.size, 0);
  sendProvider.uploadImage = async () => ({ fileId: 'FILE-2' });
  assert.equal((await run(payload({ image: { data: jpeg(5000) } }), deps)).statusCode, 200);
  const dump = JSON.stringify(db.log.map(item => item.args));
  assert.ok(!dump.includes(jpeg(5000).slice(0, 40)));
  assert.ok(!dump.includes('01012345678'));
});

test('쏠라피 업체 층: 예약 칸·사진 id 를 본문에 싣고 취소는 DELETE groups/{id}/schedule', async () => {
  const solapi = getSendProvider('solapi');
  const prev = { k: process.env.SOLAPI_API_KEY, s: process.env.SOLAPI_API_SECRET };
  process.env.SOLAPI_API_KEY = 'k'; process.env.SOLAPI_API_SECRET = 's';
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), method: init.method, body: init.body ? JSON.parse(init.body) : null });
    const ok = body => ({ ok: true, status: 200, json: async () => body });
    if (String(url).includes('storage/v1/files')) return ok({ fileId: 'F9', type: 'MMS' });
    if (String(url).includes('/schedule')) return ok({});
    return ok({ groupInfo: { groupId: 'G9', count: { registeredFailed: 0 } } });
  };
  try {
    const up = await solapi.uploadImage({ base64: 'AAAA', name: 'photo.jpg' }, { fetchImpl });
    assert.equal(up.fileId, 'F9');
    assert.deepEqual(seen[0].body, { file: 'AAAA', type: 'MMS', name: 'photo.jpg' });
    const sent = await solapi.send({ type: 'MMS', from: '0211112222', recipients: ['01012345678'], text: 'hi', fileId: 'F9', scheduledAt: '2026-11-13T00:30:00.000Z' }, { fetchImpl });
    assert.equal(sent.groupId, 'G9');
    assert.equal(seen[1].body.scheduledDate, '2026-11-13T00:30:00.000Z');
    assert.equal(seen[1].body.messages[0].imageId, 'F9');
    assert.equal(seen[1].body.messages[0].type, 'MMS');
    const cancelled = await solapi.cancelSchedule({ groupId: 'G9GROUP1' }, { fetchImpl });
    assert.equal(cancelled.ok, true);
    assert.equal(seen[2].method, 'DELETE');
    assert.ok(seen[2].url.endsWith('/messages/v4/groups/G9GROUP1/schedule'));
    assert.equal((await solapi.cancelSchedule({ groupId: '../x' }, { fetchImpl })).ok, false);
  } finally {
    if (prev.k === undefined) delete process.env.SOLAPI_API_KEY; else process.env.SOLAPI_API_KEY = prev.k;
    if (prev.s === undefined) delete process.env.SOLAPI_API_SECRET; else process.env.SOLAPI_API_SECRET = prev.s;
  }
});

test('화면 계산: 예약 시각 검사·짧은 시각·사진 크기 줄이기(비율 유지)', () => {
  const now = Date.parse('2026-11-12T03:00:00Z');
  assert.equal(scheduleInfo('2026-11-12T12:03', now).ok, false);
  assert.equal(scheduleInfo('2026-11-12T12:06', now).ok, true);
  assert.equal(scheduleInfo('', now).error, '');
  assert.equal(shortKst('2026-11-13T00:30:00.000Z'), '11/13 09:30');
  assert.deepEqual(fitDimensions(3000, 1500), { width: 1500, height: 750 });
  assert.deepEqual(fitDimensions(800, 600), { width: 800, height: 600 });
});

test('쏠라피 업체 층: 예약·사진 없는 문자의 요청 본문 전체 고정(scheduledDate·imageId 키 없음)', async () => {
  const solapi = getSendProvider('solapi');
  const prev = { k: process.env.SOLAPI_API_KEY, s: process.env.SOLAPI_API_SECRET };
  process.env.SOLAPI_API_KEY = 'k'; process.env.SOLAPI_API_SECRET = 's';
  const seen = [];
  const fetchImpl = async (url, init) => {
    seen.push({ url: String(url), body: init.body ? JSON.parse(init.body) : null });
    return { ok: true, status: 200, json: async () => ({ groupInfo: { groupId: 'G1', count: { registeredFailed: 0 } } }) };
  };
  try {
    await solapi.send({ type: 'SMS', from: '0211112222', recipients: ['01012345678'], text: 'hi' }, { fetchImpl });
    const body = seen[seen.length - 1].body;
    assert.deepEqual(body, { messages: [{ to: '01012345678', from: '0211112222', text: 'hi', type: 'SMS' }], allowDuplicates: false, showMessageList: false });
    assert.equal('scheduledDate' in body, false);
    assert.equal('imageId' in body.messages[0], false);
  } finally {
    if (prev.k === undefined) delete process.env.SOLAPI_API_KEY; else process.env.SOLAPI_API_KEY = prev.k;
    if (prev.s === undefined) delete process.env.SOLAPI_API_SECRET; else process.env.SOLAPI_API_SECRET = prev.s;
  }
});
