// 브랜드메시지(자유형, BMS_FREE) 자동 발송 수단 (2026-11-17 설계_브랜드메시지_자유형).
// 가짜 db·가짜 발송기·가짜 fetch 만 쓴다(실제 발송·쏠라피 호출 없음). 값은 모두 가짜.
import assert from 'node:assert/strict';
import test from 'node:test';
import { _resetAutoSchemaForTest, autoTest } from '../api/_lib/smsAutoSend.js';
import { _resetTextTemplateSchemaForTest, saveTextTemplate } from '../api/_lib/smsTextTemplates.js';
import { _resetEventSchemaForTest, catchupPreview, eventToggleOn, runEventSend } from '../api/_lib/smsEventSend.js';
import { _resetManualSendSchemaForTest } from '../api/_lib/smsManualSend.js';
import { getSendProvider } from '../api/_lib/sendProvider.js';
import { BMS_PF_ID, BMS_SENDER, bmsImageSig, bmsInWindow, bmsReady, parseBmsConfig } from '../api/_lib/smsBms.js';
import { autoConditionLine, bmsConfirmLine, autoConfirmLine, buildSaveBody, formInitialFromItem, validateTextForm } from '../src/components/smsconsole/smsTextTemplateFormModel.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db';
const NOW = Date.parse('2026-11-20T01:00:00Z'); // KST 11-20 10:00
const HOUR = 3600000;
const ENV = { SMS_SENDER: '0212345678' };
const BODY = '안녕하세요 #{고객명} 대표님\n구글 리뷰를 남겨 주세요.\n무료수신거부 080-123-4567'; // 브랜드메시지는 광고라 080 줄 필수(2026-11-18)
const IMG = 'FAKEJPEGBASE64==';
const BUTTONS = [{ name: '구글 리뷰 쓰기', link: 'https://search.google.com/local/writereview?placeid=TEST' }];
const cfgJson = (extra = {}) => JSON.stringify({ pfId: BMS_PF_ID, from: BMS_SENDER, buttons: BUTTONS, imageId: 'ST01FZ_TEST_IMAGE', imageSig: bmsImageSig(IMG), ...extra });

function fakeDb({ orders = [] } = {}) {
  const state = { sends: [], nextId: 1, done: [], paused: [], failMark: 0, failClear: 0 };
  return {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT conname FROM pg_constraint')) return { rows: [] };
      if (t.startsWith('SELECT phone_hash FROM sms_optouts')) return { rows: [] };
      if (t.includes("FROM orders WHERE status = 'shipped'")) return { rows: orders.filter(o => o.status === 'shipped' && o.ship_date.slice(0, 10) >= args[0] && o.ship_date.slice(0, 10) <= args[1]).sort((a, b) => a.ship_date.localeCompare(b.ship_date) || a.id - b.id).map(o => ({ id: o.id, phone: o.phone, client_name: o.client_name, ship_day: o.ship_date.slice(0, 10) })) };
      if (t.startsWith('SELECT id, track_token FROM orders')) return { rows: [] };
      if (t.startsWith('SELECT dedupe_key FROM sms_event_sends WHERE template_id = ? AND dedupe_key IN')) return { rows: state.sends.filter(r => r.template_id === args[0] && args.slice(1).includes(r.dedupe_key)).map(r => ({ dedupe_key: r.dedupe_key })) };
      if (t.startsWith('SELECT dedupe_key FROM sms_event_sends WHERE template_id = ?')) return { rows: state.sends.filter(r => r.template_id === args[0]).map(r => ({ dedupe_key: r.dedupe_key })) };
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_event_sends WHERE kst_date = ?')) return { rows: [{ n: state.sends.filter(r => r.kst_date === args[0] && (t.includes("kind = 'catchup'") ? r.kind === 'catchup' : t.includes("<> 'catchup'") ? r.kind !== 'catchup' : true)).length }] };
      if (t.startsWith("UPDATE sms_event_sends SET kind = 'catchup'")) { for (const r of state.sends.filter(x => args.includes(x.id))) r.kind = 'catchup'; return { rows: [] }; }
      if (t.startsWith('INSERT INTO sms_event_sends')) {
        const rows = [];
        for (let i = 0; i < args.length; i += 6) {
          const [template_id, dedupe_key, order_id, phone_hash, , kst_date] = args.slice(i, i + 6);
          if (state.sends.some(r => r.template_id === template_id && r.dedupe_key === dedupe_key)) continue;
          const row = { id: state.nextId++, template_id, dedupe_key, order_id, phone_hash, kst_date, status: 'claimed' };
          state.sends.push(row); rows.push({ id: row.id, dedupe_key });
        }
        return { rows };
      }
      if (t.startsWith("DELETE FROM sms_event_sends WHERE status = 'claimed'")) { state.sends = state.sends.filter(r => !args.includes(r.id)); return { rows: [] }; }
      if (t.startsWith('UPDATE sms_event_sends SET status = ?')) { const [status, , reason, , ...ids] = args; for (const r of state.sends.filter(x => ids.includes(x.id))) { r.status = status; r.reason = reason; } return { rows: [] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_catchup_done_at = NOW()')) { state.done.push(args[0]); return { rows: [{ id: args[0] }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_catchup_paused_at = NOW()')) { state.paused.push({ error: args[0], id: args[1] }); return { rows: [{ id: args[1] }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_ata_fail_at = CASE')) { state.failMark += 1; return { rows: [{ id: args[0] }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_ata_fail_at = NULL')) { state.failClear += 1; return { rows: [{ id: args[0] }] }; }
      throw new Error(`예상 못 한 SQL ${t}`);
    },
  };
}
const accepted = input => ({ accepted: input.messages.length, failed: 0, groupId: 'G1', uncertain: false, error: '' });
// 세 가지 발송 수단을 모두 가짜로 둬서, BMS 수단이 문자·알림톡 발송기를 건드리지 않는지 센다
function provider(respond = accepted) {
  const calls = { bms: [], kakao: [], each: [] };
  return {
    calls,
    estimate: () => ({ unit: 45, total: 45 }),
    estimateKakao: ({ count }) => ({ unit: 13, total: 13 * count }),
    estimateBms: ({ count }) => ({ unit: 100, total: 100 * count, fallback_unit: 45 }),
    async uploadImage() { return { fileId: 'F1' }; },
    async sendBmsEach(input) { calls.bms.push(input); return respond(input); },
    async sendKakaoEach(input) { calls.kakao.push(input); return respond(input); },
    async sendEach(input) { calls.each.push(input); return respond(input); },
  };
}
// BMS 갈래는 알림톡 승인 조회를 하지 않는다(호출되면 실패)
const noKakao = () => ({ async getBalance() { return 100000; }, async getTemplateFresh() { throw new Error('BMS 는 알림톡 템플릿을 조회하지 않는다'); } });
const reset = () => { _resetEventSchemaForTest(); _resetAutoSchemaForTest(); _resetTextTemplateSchemaForTest(); _resetManualSendSchemaForTest(); };
const base = (extra = {}) => ({ id: 31, name: '구글 리뷰', body: BODY, images: [IMG], auto_kind: 'ship_plus_days', auto_enabled: true, auto_days: 3, auto_ata_template: 'BMS_FREE', auto_bms: cfgJson(), auto_enabled_at: new Date(NOW - 3 * HOUR).toISOString(), auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_offset: 0, auto_unless_step: '', auto_daily: '', auto_weekdays: false, auto_unless_mode: 'completed', auto_step: '', auto_send_time: '', auto_catchup_from: '', auto_catchup_at: '', auto_catchup_done: false, ...extra });
const catchupTpl = (extra = {}) => base({ auto_catchup_from: '2026-10-01', auto_catchup_at: '2026-11-20T09:00', ...extra });
const order = (id, phone, shipDate, name = '', status = 'shipped') => ({ id, phone, ship_date: shipDate, client_name: name, status });
const run = (db, vendor, template, extra = {}) => { reset(); return runEventSend(template, { db, provider: vendor, env: ENV, nowMs: NOW, kakao: noKakao(), warn: () => {}, ...extra }); };
const threeOrders = [order(1, '010-1111-2222', '2026-10-05', '가'), order(2, '010-3333-4444', '2026-10-06', '나'), order(3, '010-5555-6666', '2026-10-07', '다')];

// ---------- 1. 쏠라피 요청 모양 ----------
test('sendBmsEach: BMS_FREE 건별 메시지 — pfId·imageId·버튼·고객명 본문·문자 대체 켬, send-many 1번', async () => {
  const prev = { k: process.env.SOLAPI_API_KEY, s: process.env.SOLAPI_API_SECRET };
  process.env.SOLAPI_API_KEY = 'k'; process.env.SOLAPI_API_SECRET = 's';
  try {
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ groupInfo: { groupId: 'G1', count: { registeredFailed: 1 } }, failedMessageList: [{ to: '01033334444' }] }) }; };
    const out = await getSendProvider('solapi').sendBmsEach({ from: '0319862458', pfId: BMS_PF_ID, messages: [
      { to: '01011112222', text: '가 대표님', imageId: 'IMG1', buttons: BUTTONS },
      { to: '01033334444', text: '나 대표님', buttons: [] },
    ] }, { fetchImpl });
    assert.equal(seen.length, 1);
    assert.match(seen[0].url, /messages\/v4\/send-many\/detail$/);
    const [first, second] = seen[0].body.messages;
    assert.deepEqual(first, { to: '01011112222', from: '0319862458', type: 'BMS_FREE', subject: '(광고)한성쇼케이스그룹', text: '가 대표님', kakaoOptions: { pfId: BMS_PF_ID, disableSms: false, bms: { targeting: 'I', chatBubbleType: 'IMAGE', imageId: 'IMG1', buttons: [{ name: '구글 리뷰 쓰기', linkType: 'WL', linkMobile: BUTTONS[0].link }] } } });
    assert.deepEqual(second.kakaoOptions.bms, { targeting: 'I', chatBubbleType: 'TEXT' }, '이미지·버튼 없으면 TEXT');
    assert.deepEqual(out, { accepted: 1, failed: 1, groupId: 'G1', uncertain: false, error: '', failedTo: ['01033334444'] });
    const est = getSendProvider('solapi').estimateBms({ count: 3 }, {});
    assert.deepEqual([est.unit, est.total, est.fallback_unit], [100, 300, 45]);
  } finally {
    if (prev.k === undefined) delete process.env.SOLAPI_API_KEY; else process.env.SOLAPI_API_KEY = prev.k;
    if (prev.s === undefined) delete process.env.SOLAPI_API_SECRET; else process.env.SOLAPI_API_SECRET = prev.s;
  }
});

// ---------- 2. 평소 자동 발송 ----------
test('평소 자동 발송: BMS 수단이면 sendBmsEach 로 건별 메시지(고객명 치환·imageId·버튼), 문자·알림톡 발송기와 알림톡 승인 조회는 안 쓴다', async () => {
  const db = fakeDb({ orders: [order(1, '010-1111-2222', '2026-11-17', '홍길동')] }); // 출고 3일째 = 오늘
  const vendor = provider();
  const out = await run(db, vendor, base());
  assert.equal(out.sent, 1);
  assert.equal(vendor.calls.bms.length, 1); assert.equal(vendor.calls.kakao.length, 0); assert.equal(vendor.calls.each.length, 0);
  const call = vendor.calls.bms[0];
  assert.equal(call.from, '0319862458', '발신은 BMS 기본 번호(환경값 SMS_SENDER 가 아니다)');
  assert.equal(call.pfId, BMS_PF_ID);
  assert.deepEqual(call.messages, [{ to: '01011112222', text: '안녕하세요 홍길동 대표님\n구글 리뷰를 남겨 주세요.\n무료수신거부 080-123-4567', imageId: 'ST01FZ_TEST_IMAGE', buttons: BUTTONS }]);
  assert.equal(db.state.sends[0].status, 'sent');
});

test('이미 출고된 주문 일괄 발송: 범위 끝 = 오늘 − N일, 크론 1번에 SMS_CATCHUP_PER_RUN 건, 하루 상한을 지킨다', async () => {
  const orders = [...threeOrders, order(4, '010-7777-8888', '2026-11-18', '라'), order(5, '010-9999-0000', '2026-11-20', '마')];
  const db = fakeDb({ orders });
  const vendor = provider();
  const out = await run(db, vendor, catchupTpl({ auto_days: 3 }), { catchupOnly: true });
  assert.deepEqual(vendor.calls.bms[0].messages.map(m => m.to), ['01011112222', '01033334444', '01055556666'], '출고 3일이 지난 주문(11-17 이전)만');
  assert.equal(out.sent, 3);
  reset();
  const db2 = fakeDb({ orders: threeOrders });
  const v2 = provider();
  await run(db2, v2, catchupTpl(), { catchupOnly: true, env: { ...ENV, SMS_CATCHUP_PER_RUN: '2' } });
  assert.equal(v2.calls.bms[0].messages.length, 2, '크론 1번에 2건(묶음 상한)');
  const v3 = provider();
  const db3 = fakeDb({ orders: threeOrders });
  const capped = await run(db3, v3, catchupTpl(), { catchupOnly: true, env: { ...ENV, SMS_CATCHUP_MAX_PER_DAY: '1' } });
  assert.equal(v3.calls.bms[0].messages.length, 1); assert.equal(capped.sent, 1, '하루 상한 1건');
  reset();
  const preview = await catchupPreview(fakeDb({ orders: threeOrders }), { from: '2026-10-01', days: 3, nowMs: NOW, env: ENV, provider: provider(), kakao: noKakao(), bms: true });
  assert.equal(preview.end_date, '2026-11-17'); assert.equal(preview.bms, true); assert.equal(preview.unit, 100); assert.equal(preview.fallback_unit, 45);
  assert.equal(preview.ranges[0].cost, 300);
});

test('통째 실패(접수 0건): 선점 행 삭제 · 일괄 발송 멈춤(완료 표시 없음) · 평소 발송은 1시간 건너뛰기, 일부 실패는 그 번호만 failed', async () => {
  const fail = provider(input => ({ accepted: 0, failed: input.messages.length, groupId: null, uncertain: false, error: '채널 오류' }));
  const db = fakeDb({ orders: threeOrders });
  const out = await run(db, fail, catchupTpl(), { catchupOnly: true });
  assert.equal(db.state.sends.length, 0); assert.deepEqual(db.state.paused, [{ error: '채널 오류', id: 31 }]); assert.deepEqual(db.state.done, []);
  assert.equal(out.reason, 'catchup_paused');
  const db2 = fakeDb({ orders: [order(1, '010-1111-2222', '2026-11-17', '가')] });
  const first = await run(db2, fail, base());
  assert.equal(first.reason, 'ata_failed'); assert.equal(db2.state.failMark, 1); assert.equal(db2.state.sends.length, 0);
  const skipped = await run(db2, fail, base({ auto_ata_fail_at: new Date(NOW + HOUR).toISOString() }));
  const callsBefore = fail.calls.bms.length;
  assert.equal(skipped.reason, 'ata_backoff'); assert.equal(fail.calls.bms.length, callsBefore, '건너뛰는 동안은 호출하지 않는다');
  const part = provider(input => ({ accepted: input.messages.length - 1, failed: 1, groupId: 'G9', uncertain: false, error: '', failedTo: ['01033334444'] }));
  const db3 = fakeDb({ orders: threeOrders });
  const partial = await run(db3, part, catchupTpl(), { catchupOnly: true });
  assert.deepEqual([partial.sent, partial.failed], [2, 1]);
  assert.deepEqual(db3.state.sends.map(r => r.status).sort(), ['failed', 'sent', 'sent']);
});

// ---------- 3. 발송 시간·준비 확인 ----------
test('KST 08:00~20:00 사이에만 보낸다(20:00 이후·08:00 전은 다음 크론으로, 선점도 안 한다)', async () => {
  assert.equal(bmsInWindow(Date.parse('2026-11-20T10:59:00Z')), true, '19:59');
  assert.equal(bmsInWindow(Date.parse('2026-11-20T11:00:00Z')), false, '20:00');
  assert.equal(bmsInWindow(Date.parse('2026-11-19T22:59:00Z')), false, '07:59');
  assert.equal(bmsInWindow(Date.parse('2026-11-19T23:00:00Z')), true, '08:00');
  const orders = [order(1, '010-1111-2222', '2026-11-17', '가')];
  for (const [label, at] of [['20:00', '2026-11-20T11:00:00Z'], ['20:30', '2026-11-20T11:30:00Z'], ['07:59', '2026-11-19T22:59:00Z']]) {
    const db = fakeDb({ orders });
    const vendor = provider();
    const out = await run(db, vendor, base({ auto_enabled_at: '2026-11-01T00:00:00Z' }), { nowMs: Date.parse(at) });
    assert.equal(out.reason, 'night', label); assert.equal(vendor.calls.bms.length, 0, label); assert.equal(db.state.sends.length, 0, label);
  }
  const db = fakeDb({ orders });
  const vendor = provider();
  assert.equal((await run(db, vendor, base(), { nowMs: Date.parse('2026-11-20T10:30:00Z') })).sent, 1, '19:30 은 나간다');
  // 알림톡 수단은 20:00~21:00 에도 종전대로 나간다(BMS 만 20시 제한)
  const db2 = fakeDb({ orders });
  const ata = provider();
  const ataKakao = { async getBalance() { return 100000; }, async getTemplateFresh() { return { raw: { channelId: 'PF1' }, template: { status: 'APPROVED', variables: ['#{고객명}'], content: '#{고객명}님' }, scope: { allowed: true, kind: 'channel' } }; } };
  const ataOut = await run(db2, ata, base({ auto_ata_template: 'KA01TP1', images: [], auto_bms: '' }), { nowMs: Date.parse('2026-11-20T11:30:00Z'), kakao: ataKakao });
  assert.equal(ataOut.sent, 1); assert.equal(ata.calls.kakao.length, 1); assert.equal(ata.calls.bms.length, 0);
});

test('사진이 바뀌었거나 글자 수가 넘으면 보내지 않고 선점도 안 한다(bms_not_ready)', async () => {
  const cases = [
    base({ images: ['OTHERPHOTO'] }), // 저장 때 올린 사진과 다름
    base({ auto_bms: cfgJson({ imageId: '', imageSig: '' }) }), // 사진은 있는데 imageId 없음
    base({ body: `#{고객명}${'가'.repeat(400)}` }), // 이미지와 함께면 400자
    base({ images: [IMG, 'TWO'] }), // 사진 2장
  ];
  for (const template of cases) {
    const db = fakeDb({ orders: [order(1, '010-1111-2222', '2026-11-17', '가')] });
    const vendor = provider();
    const out = await run(db, vendor, template);
    assert.equal(out.reason, 'bms_not_ready'); assert.equal(vendor.calls.bms.length, 0); assert.equal(db.state.sends.length, 0);
  }
  assert.equal(bmsReady(base({ images: [], auto_bms: cfgJson({ imageId: '', imageSig: '' }) })).ok, true, '사진 없는 글만 BMS 는 통과');
});

// ---------- 4. 켜기·시험 발송·확인 줄 ----------
test('켜기 미리보기(dry_run): 브랜드메시지 단가 100원·대체 45원이 돌아오고 알림톡 승인 조회는 하지 않는다', async () => {
  const db = fakeDb({ orders: [order(1, '010-1111-2222', '2026-11-17', '가'), order(2, '010-3333-4444', '2026-11-17', '나')] });
  const vendor = provider();
  reset();
  const out = await eventToggleOn({ dry_run: true }, base({ auto_enabled: false }), { db, provider: vendor, env: ENV, nowMs: NOW, kakao: noKakao() });
  assert.equal(out.status, 200);
  assert.deepEqual([out.body.bms, out.body.unit, out.body.fallback_unit, out.body.cost, out.body.targets], [true, 100, 45, 200, 2]);
  assert.match(bmsConfirmLine(out.body), /브랜드메시지\(자유형\) 2건, 약 2×100원\(친구가 아니면 장문문자 45원으로 대체\)/);
  const bad = await eventToggleOn({ dry_run: true }, base({ auto_enabled: false, images: ['OTHER'] }), { db, provider: vendor, env: ENV, nowMs: NOW, kakao: noKakao() });
  assert.equal(bad.status, 400); assert.equal(bad.body.reason, 'bms_not_ready');
});

function testDb(template) {
  const state = { manual: [] };
  const row = { id: 7, name: '구글 리뷰', body: BODY, image: null, images: JSON.stringify([IMG]), auto_kind: 'ship_plus_days', auto_days: 3, auto_enabled: false, auto_start_date: '', auto_msg_type: 'info', auto_audience: 'customer', auto_ata_template: 'BMS_FREE', auto_bms: cfgJson(), ...template };
  return {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t) || t.startsWith('SELECT conname FROM pg_constraint')) return { rows: [] };
      if (t.startsWith('SELECT id, name, body, image, images, auto_kind')) return { rows: args[0] === row.id ? [row] : [] };
      if (t.includes('FROM sms_manual_sends WHERE sent_at')) return { rows: [{ n: 0 }] };
      if (t.startsWith('INSERT INTO sms_manual_sends')) { state.manual.push({ idem_key: args[0], msg_type: args[1], recipient_count: args[2] }); return { rows: [{ id: state.manual.length }] }; }
      if (t.startsWith('UPDATE sms_manual_sends')) return { rows: [] };
      throw new Error(`예상 못 한 SQL ${t}`);
    },
  };
}

test('[내 번호로 브랜드메시지 시험]: 확인 줄은 100원, 발송은 sendBmsEach 1건(고객명 "고객"), 문자·알림톡 발송기는 안 쓴다', async () => {
  reset();
  const vendor = provider();
  const deps = { db: testDb(), provider: vendor, env: ENV, nowMs: NOW, kakao: noKakao() };
  const body = { id: 7, to: '010-1234-4237', idempotencyKey: 'key-bms-0001' };
  const dry = await autoTest({ ...body, dry_run: true }, deps);
  assert.deepEqual([dry.body.bms, dry.body.parts, dry.body.cost, dry.body.unit, dry.body.fallback_unit], [true, 1, 100, 100, 45]);
  assert.match(autoConfirmLine({ parts: dry.body.parts, cost: dry.body.cost, bms: dry.body.bms, unit: dry.body.unit, fallback_unit: dry.body.fallback_unit }), /브랜드메시지\(자유형\) 1건, 약 1×100원\(친구가 아니면 장문문자 45원으로 대체\)/);
  assert.equal(vendor.calls.bms.length, 0, 'dry_run 은 보내지 않는다');
  const sent = await autoTest(body, deps);
  assert.equal(sent.body.status, 'sent');
  assert.equal(vendor.calls.bms.length, 1); assert.equal(vendor.calls.kakao.length, 0); assert.equal(vendor.calls.each.length, 0);
  assert.deepEqual(vendor.calls.bms[0].messages, [{ to: '01012344237', text: '안녕하세요 고객 대표님\n구글 리뷰를 남겨 주세요.\n무료수신거부 080-123-4567', imageId: 'ST01FZ_TEST_IMAGE', buttons: BUTTONS }]);
  assert.equal(vendor.calls.bms[0].from, '0319862458');
  // 설정이 안 맞으면 보내지 않는다
  reset();
  const wrong = provider();
  const refused = await autoTest({ ...body, idempotencyKey: 'key-bms-0002' }, { ...deps, db: testDb({ images: JSON.stringify(['OTHER']) }), provider: wrong });
  assert.equal(refused.status, 400); assert.equal(refused.body.error.reason ?? refused.body.reason, 'bms_not_ready'); assert.equal(wrong.calls.bms.length, 0);
});

test('브랜드메시지 시험: 밤(KST 21:00)에는 확인·발송 모두 안내만, 낮에는 기존대로', async () => {
  _resetAutoSchemaForTest(); _resetManualSendSchemaForTest();
  const vendor = provider();
  const night = Date.parse('2026-11-20T12:00:00Z'); // KST 21:00
  const body = { id: 7, to: '010-1234-4237', idempotencyKey: 'key-bms-night1' };
  for (const extra of [{ dry_run: true }, {}]) {
    const r = await autoTest({ ...body, ...extra }, { db: testDb(), provider: vendor, env: ENV, nowMs: night, kakao: noKakao() });
    assert.equal(r.status, 400); assert.equal(r.body.error.reason ?? r.body.reason, 'bms_out_of_hours');
    assert.match(JSON.stringify(r.body), /오전 8시~오후 8시 50분에만/);
  }
  assert.equal(vendor.calls.bms.length, 0);
  const day = await autoTest({ ...body, dry_run: true }, { db: testDb(), provider: vendor, env: ENV, nowMs: NOW, kakao: noKakao() });
  assert.equal(day.body.ok, true); assert.equal(day.body.bms, true);
  const sent = await autoTest({ ...body, idempotencyKey: 'key-bms-day0001' }, { db: testDb(), provider: vendor, env: ENV, nowMs: NOW, kakao: noKakao() });
  assert.equal(sent.body.status, 'sent'); assert.equal(vendor.calls.bms.length, 1);
});

// ---------- 5. 저장: 글자 수·버튼·사진 올리기 ----------
function saveDb(saved, { existing = null } = {}) {
  return {
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      if (/^(CREATE|ALTER)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT id FROM sms_text_templates WHERE name')) return { rows: existing ? [{ id: existing.id }] : [] };
      if (t.startsWith('SELECT COUNT(*)')) return { rows: [{ n: 0 }] };
      if (t.startsWith('SELECT image, images, auto_bms FROM sms_text_templates WHERE id')) return { rows: existing ? [existing] : [] };
      if (t.startsWith('SELECT id FROM sms_text_templates WHERE id')) return { rows: existing ? [{ id: existing.id }] : [] };
      if (t.startsWith('INSERT INTO sms_text_templates')) { const cols = /\(([^)]*)\) VALUES/.exec(t)[1].split(',').map(c => c.trim()); const row = {}; cols.forEach((c, i) => { row[c] = args[i]; }); saved.push(row); return { rows: [{ id: saved.length }] }; }
      if (t.includes('auto_enabled = false WHERE id = ? AND auto_enabled = true')) return { rows: [] };
      if (t.startsWith('UPDATE sms_text_templates SET name = ?, body = ?')) { saved.push({ update: t, args }); return { rows: [{ id: existing?.id, auto_kind: 'ship_plus_days', auto_ata_template: 'BMS_FREE', auto_bms: args[args.findIndex((v, i) => typeof v === 'string' && v.startsWith('{"pfId"') && i > 1)] ?? null }] }; }
      throw new Error(`예상 못 한 SQL ${t}`);
    },
  };
}
const PHOTO = { data: 'data:image/jpeg;base64,/9j/4AAQSkZJRg==' }; // parseSendExtras 통과용 가짜 JPEG(머리 바이트만)
const autoIn = (extra = {}) => ({ kind: 'ship_plus_days', days: 2, ata_template: 'BMS_FREE', bms: { buttons: BUTTONS }, send_time: undefined, ...extra });
const uploader = (calls, fileId = 'ST01FZ_UP1') => ({ async uploadImage(input) { calls.push(input); return { fileId }; } });

test('저장: BMS 수단 + 사진 1장이면 쏠라피에 type BMS 로 1번 올려 imageId 를 auto_bms 에 저장하고 응답에는 imageId 를 싣지 않는다', async () => {
  reset();
  const saved = []; const uploads = [];
  const out = await saveTextTemplate(saveDb(saved), { name: '구글 리뷰', body: BODY, images: [PHOTO], auto: autoIn() }, { staff: [], provider: uploader(uploads) });
  assert.equal(out.status, 201);
  assert.equal(uploads.length, 1); assert.equal(uploads[0].type, 'BMS'); assert.equal(uploads[0].base64, '/9j/4AAQSkZJRg==');
  assert.equal(saved[0].auto_ata_template, 'BMS_FREE');
  const cfg = JSON.parse(saved[0].auto_bms);
  assert.deepEqual([cfg.pfId, cfg.from, cfg.imageId, cfg.imageSig, cfg.buttons], [BMS_PF_ID, BMS_SENDER, 'ST01FZ_UP1', bmsImageSig('/9j/4AAQSkZJRg=='), BUTTONS]);
  assert.deepEqual(out.body.item.auto_bms_buttons, BUTTONS); assert.equal(out.body.item.auto_bms_image, true);
  assert.equal(JSON.stringify(out.body).includes('ST01FZ_UP1'), false, 'imageId 는 응답에 없다');
});

test('저장: 같은 사진으로 다시 저장하면 올리지 않고 저장된 imageId 를 쓴다(캐시) / 사진이 바뀌면 다시 올린다', async () => {
  reset();
  const sig = bmsImageSig('/9j/4AAQSkZJRg==');
  const existing = { id: 5, image: null, images: JSON.stringify(['/9j/4AAQSkZJRg==']), auto_bms: JSON.stringify({ pfId: BMS_PF_ID, from: BMS_SENDER, buttons: BUTTONS, imageId: 'ST01FZ_OLD', imageSig: sig }) };
  const saved = []; const uploads = [];
  const same = await saveTextTemplate(saveDb(saved, { existing }), { id: 5, name: '구글 리뷰', body: BODY, images: [PHOTO], auto: autoIn() }, { staff: [], provider: uploader(uploads) });
  assert.equal(same.status, 200); assert.equal(uploads.length, 0, '같은 사진은 다시 올리지 않는다');
  assert.equal(JSON.parse(saved.at(-1).args.find(v => typeof v === 'string' && v.startsWith('{"pfId"'))).imageId, 'ST01FZ_OLD');
  // 사진 칸을 안 보낸 저장(글·버튼만 수정)도 DB 의 사진으로 판단해 올리지 않는다
  const textOnly = await saveTextTemplate(saveDb([], { existing }), { id: 5, name: '구글 리뷰', body: BODY, auto: autoIn() }, { staff: [], provider: uploader(uploads) });
  assert.equal(textOnly.status, 200); assert.equal(uploads.length, 0);
  const changed = await saveTextTemplate(saveDb([], { existing: { ...existing, images: JSON.stringify(['/9j/OLDPHOTO']), auto_bms: JSON.stringify({ pfId: BMS_PF_ID, from: BMS_SENDER, buttons: BUTTONS, imageId: 'ST01FZ_OLD', imageSig: bmsImageSig('/9j/OLDPHOTO') }) } }), { id: 5, name: '구글 리뷰', body: BODY, images: [PHOTO], auto: autoIn() }, { staff: [], provider: uploader(uploads, 'ST01FZ_NEW') });
  assert.equal(changed.status, 200); assert.equal(uploads.length, 1);
});

test('저장 거부: 이미지와 함께 400자 초과·사진 2장·버튼 이름 14자 초과·http 링크·버튼 6개·오후 8시 발송 시각 — 쏠라피에는 아무것도 올리지 않는다', async () => {
  const uploads = [];
  const opts = { staff: [], provider: uploader(uploads) };
  const go = (body, extra = {}, images = [PHOTO]) => { reset(); return saveTextTemplate(saveDb([]), { name: `n${Math.random()}`, body, images, auto: autoIn(extra) }, opts); };
  const long = await go(`#{고객명}${'가'.repeat(400)}`);
  assert.equal(long.status, 400); assert.equal(long.body.reason, 'bms_too_long'); assert.match(long.body.error.message, /이미지와 함께면 400자/);
  assert.equal((await go('#{고객명}' + '가'.repeat(359) + '\n무료수신거부 080-123-4567')).status, 201, '고객명 20자 + 080 줄 포함 400자 는 통과');
  const two = await go(BODY, {}, [PHOTO, PHOTO]);
  assert.equal(two.status, 400); assert.equal(two.body.reason, 'bms_images');
  assert.equal((await go(BODY, { bms: { buttons: [{ name: '가'.repeat(15), link: 'https://a.example' }] } })).body.reason, 'bms_button');
  assert.equal((await go(BODY, { bms: { buttons: [{ name: '리뷰', link: 'http://a.example' }] } })).body.reason, 'bms_button');
  assert.equal((await go(BODY, { bms: { buttons: Array.from({ length: 6 }, (_, i) => ({ name: `b${i}`, link: 'https://a.example' })) } })).body.reason, 'bms_button');
  assert.equal((await go(BODY, { send_time: '20:00' })).status, 400);
  assert.equal((await go(BODY, { catchup: { from: '2026-10-01', at: '2026-11-21T20:30' } })).body.reason, 'catchup_at');
  assert.equal(uploads.length, 1, '통과한 한 건(400자 경계)만 올렸다');
  // 글만 보내면 400자를 넘어도 1300자까지
  assert.equal((await go('#{고객명}' + '가'.repeat(460) + '\n무료수신거부 080-123-4567', {}, [])).status, 201);
  assert.equal((await go('가'.repeat(1301), {}, [])).status, 400);
});

test('사진 업로드가 실패하면 저장하지 않는다(502) / 알림톡·문자 저장은 auto_bms 를 비운다', async () => {
  reset();
  const saved = [];
  const failing = { async uploadImage() { throw new Error('boom'); } };
  const out = await saveTextTemplate(saveDb(saved), { name: 'a', body: BODY, images: [PHOTO], auto: autoIn() }, { staff: [], provider: failing });
  assert.equal(out.status, 502); assert.equal(saved.length, 0);
  reset();
  const ata = await saveTextTemplate(saveDb(saved), { name: 'b', body: '#{고객명}님 안내', auto: { kind: 'ship_plus_days', days: 3, ata_template: 'KA01TP1' } }, { staff: [] });
  assert.equal(ata.status, 201); assert.equal(saved[0].auto_bms, null); assert.equal(saved[0].auto_ata_template, 'KA01TP1'); assert.equal('auto_bms_buttons' in ata.body.item, false);
});

test('모든 자동 발송 조건(10종)에서 브랜드메시지 수단을 저장할 수 있다 — 받는 사람은 고객 고정', async () => {
  const kinds = {
    ship_plus_days: { days: 2 }, order_plus_days: { days: 2 }, due_date: { offset: -1 }, ship_scheduled: { offset: 0 }, ship_or_due: { offset: 0 },
    order_created: {}, process_started: { step: '포장' }, process_completed: { step: '포장' }, member_joined: {}, lead_plus_days: { days: 1 },
  };
  for (const [kind, extra] of Object.entries(kinds)) {
    reset();
    const saved = [];
    const out = await saveTextTemplate(saveDb(saved), { name: kind, body: BODY, auto: { kind, ata_template: 'BMS_FREE', bms: { buttons: BUTTONS }, ...extra } }, { staff: [], provider: uploader([]) });
    assert.equal(out.status, 201, kind);
    assert.equal(saved[0].auto_ata_template, 'BMS_FREE', kind); assert.equal(JSON.parse(saved[0].auto_bms).imageId, '', `${kind}: 사진 없음`);
    assert.equal(saved[0].auto_audience, 'customer', kind);
  }
});

// ---------- 6. 화면 모델 ----------
test('화면 모델: 이미지와 함께면 400자, 버튼 검사, 저장 본문에 bms.buttons, 조건 줄에 브랜드메시지', () => {
  const form = (extra = {}) => ({ name: '구글 리뷰', body: BODY, autoKind: 'ship_plus_days', days: '2', sendFrom: '', repeat: '1', interval: '30', audience: 'customer', staff: [], ataTemplate: 'BMS_FREE', imageCount: 1, bmsButtons: BUTTONS, ...extra });
  assert.equal(validateTextForm(form()).ok, true);
  assert.equal(validateTextForm(form({ body: `#{고객명}${'가'.repeat(400)}` })).reason, 'bms_too_long', '이미지와 함께면 400자');
  assert.equal(validateTextForm(form({ body: `#{고객명}${'가'.repeat(400)}`, imageCount: 0 })).ok, true, '글만이면 1300자까지');
  assert.equal(validateTextForm(form({ body: '가'.repeat(1001), imageCount: 0 })).reason, 'long', '장문문자 대체(2000바이트) 한도는 기존 검사 그대로');
  assert.equal(validateTextForm(form({ imageCount: 2 })).reason, 'bms_images');
  assert.equal(validateTextForm(form({ bmsButtons: [{ name: '가'.repeat(15), link: 'https://a.example' }] })).reason, 'bms_button');
  assert.equal(validateTextForm(form({ bmsButtons: [{ name: '', link: '' }] })).ok, true, '빈 버튼 줄은 건너뛴다');
  const saveBody = buildSaveBody({ name: 'a', body: BODY, auto: { kind: 'ship_plus_days', days: '2', ataTemplate: 'BMS_FREE', bmsButtons: [...BUTTONS, { name: '', link: '' }] } });
  assert.deepEqual(saveBody.auto.bms, { buttons: BUTTONS }); assert.equal(saveBody.auto.ata_template, 'BMS_FREE');
  const plain = buildSaveBody({ name: 'a', body: BODY, auto: { kind: 'ship_plus_days', days: '2', ataTemplate: 'KA01TP1' } });
  assert.equal('bms' in plain.auto, false);
  assert.match(autoConditionLine({ autoKind: 'ship_plus_days', autoDays: 2, autoAtaTemplate: 'BMS_FREE' }), /브랜드메시지/);
  assert.match(autoConditionLine({ autoKind: 'ship_plus_days', autoDays: 2, autoAtaTemplate: 'KA01TP1' }), /알림톡/);
  assert.deepEqual(formInitialFromItem({ id: 1, name: 'a', body: 'b', auto_kind: 'ship_plus_days', auto_ata_template: 'BMS_FREE', auto_bms_buttons: BUTTONS }).bmsButtons, BUTTONS);
  assert.equal(validateTextForm(form({ catchupOn: true, catchupFrom: '2026-10-01', catchupAt: '2026-11-21T20:00' })).reason, 'catchup_at', 'BMS 일괄 발송 시각은 20시 전');
  assert.equal(validateTextForm(form({ ataTemplate: 'KA01TP1', catchupOn: true, catchupFrom: '2026-10-01', catchupAt: '2026-11-21T20:00' })).ok, true, '알림톡은 종전대로 20시까지');
});

// ---------- 7. 문자·알림톡 수단은 그대로 ----------
test('알림톡 수단은 sendKakaoEach 만, 문자 수단은 sendEach 만 쓴다(브랜드메시지 변경 전과 같다)', async () => {
  const ataKakao = { async getBalance() { return 100000; }, async getTemplateFresh() { return { raw: { channelId: 'PF1' }, template: { status: 'APPROVED', variables: ['#{고객명}'], content: '#{고객명}님' }, scope: { allowed: true, kind: 'channel' } }; } };
  const ataVendor = provider();
  const ata = await run(fakeDb({ orders: [order(1, '010-1111-2222', '2026-11-17', '가')] }), ataVendor, base({ auto_ata_template: 'KA01TP1', images: [], auto_bms: '' }), { kakao: ataKakao });
  assert.equal(ata.sent, 1); assert.equal(ataVendor.calls.kakao.length, 1); assert.equal(ataVendor.calls.bms.length, 0); assert.equal(ataVendor.calls.each.length, 0);
  assert.deepEqual(ataVendor.calls.kakao[0], { from: '0212345678', pfId: 'PF1', messages: [{ to: '01011112222', templateId: 'KA01TP1', variables: { 고객명: '가' } }], disableSms: true });
  const smsVendor = provider();
  const sms = await run(fakeDb({ orders: [order(1, '010-1111-2222', '2026-11-17', '가')] }), smsVendor, base({ auto_ata_template: '', images: [], auto_bms: '', body: '#{고객명}님 안내', auto_audience: 'customer', auto_kind: 'ship_plus_days' }));
  assert.equal(smsVendor.calls.bms.length, 0); assert.equal(smsVendor.calls.kakao.length, 0);
  assert.equal(parseBmsConfig('{깨진 json').pfId, BMS_PF_ID, '깨진 설정은 기본 채널로 읽는다');
  assert.equal(sms.reason, 'no_auto', '수단이 문자인 출고 후 문구는 안내 경로를 타지 않는다(종전 그대로)');
});

test('080 무료수신거부 줄이 없는 브랜드메시지도 저장되고 켜기도 된다(경고만 남는다) (2026-11-18 사장님: 080 줄은 넣지 않는다)', async () => {
  reset();
  const uploads = [];
  const out = await saveTextTemplate(saveDb([]), { name: '구글 리뷰', body: '안녕하세요 #{고객명} 대표님\n구글 리뷰를 남겨 주세요.', images: [PHOTO], auto: autoIn() }, { staff: [], provider: uploader(uploads) });
  assert.equal(out.status, 201); assert.equal(uploads.length, 1, '저장은 통과하고 사진은 올린다');
  const db = fakeDb();
  const toggle = await eventToggleOn({ dry_run: true }, base({ auto_enabled: false, body: '안녕하세요 #{고객명} 대표님' }), { db, provider: provider(), env: ENV, nowMs: NOW, kakao: noKakao() });
  assert.equal(toggle.status, 200); assert.notEqual(toggle.body.reason, 'no_optout_080');
});
