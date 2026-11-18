// 2026-11-18 발송 경로 설계 보강: 브랜드메시지 수신거부 제외·하루 상한 사유·문구별 오류 격리·크론 마지막 실행·그룹 실패 분류.
// 가짜 db·가짜 발송기만 쓴다(실제 발송·쏠라피 호출 없음). 값은 모두 가짜.
import assert from 'node:assert/strict';
import test from 'node:test';
import { autoEffective } from '../shared/smsAutoEffective.js';
import { handleSmsAutoEvent } from '../api/cron/sms-auto-event.js';
import { _resetAutoSchemaForTest, phoneHash } from '../api/_lib/smsAutoSend.js';
import { _resetTextTemplateSchemaForTest } from '../api/_lib/smsTextTemplates.js';
import { _resetEventSchemaForTest, cronLastRun, eventBlockedReason, eventWarnReason, recordCronRun, runEventSend, runEventSendAll } from '../api/_lib/smsEventSend.js';
import { _resetManualSendSchemaForTest } from '../api/_lib/smsManualSend.js';
import { BMS_PF_ID, BMS_SENDER, bmsOptoutCheck } from '../api/_lib/smsBms.js';
import { buildItems, classifyStatus } from '../api/_lib/solapiMessageLog.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db';
const NOW = Date.parse('2026-11-20T01:00:00Z'); // KST 11-20 10:00 (금)
const HOUR = 3600000;
const MIN = 60000;
const ENV = { SMS_SENDER: '0212345678' };
const BMS_BODY = '안녕하세요 #{고객명} 대표님\n구글 리뷰를 남겨 주세요.\n무료수신거부 080-123-4567';
const reset = () => { _resetEventSchemaForTest(); _resetAutoSchemaForTest(); _resetTextTemplateSchemaForTest(); _resetManualSendSchemaForTest(); };
const mkOrder = (id, phone) => ({ id, phone, client_name: `고객${id}`, order_date: '2026-11-20', due_date: '2026-11-25', ship_scheduled_date: null, product_type: '쇼케이스', door_type: '', width: 1, depth: 1, height: 1, quantity: 1, sales_person: '' });
const bmsTpl = (extra = {}) => ({ id: 41, name: '리뷰', body: BMS_BODY, images: [], auto_kind: 'order_created', auto_enabled: true, auto_days: 0, auto_ata_template: 'BMS_FREE', auto_bms: JSON.stringify({ pfId: BMS_PF_ID, from: BMS_SENDER, buttons: [{ name: '리뷰', link: 'https://a.example' }] }), auto_enabled_at: new Date(NOW - HOUR).toISOString(), auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_offset: 0, auto_unless_step: '', auto_daily: '', auto_weekdays: false, auto_unless_mode: 'completed', auto_step: '', auto_send_time: '', auto_catchup_from: '', auto_catchup_at: '', auto_catchup_done: false, ...extra });

function fakeDb({ orders = [], optouts = [], countToday = 0 } = {}) {
  const state = { sends: [], nextId: 1, skips: [], runs: {}, orderCalls: 0 };
  return {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT conname FROM pg_constraint')) return { rows: [] };
      if (t.startsWith('SELECT phone_hash FROM sms_optouts')) return { rows: optouts.map(phone => ({ phone_hash: phoneHash(phone) })) };
      if (t.includes('FROM orders o WHERE o.created_at')) { state.orderCalls += 1; return { rows: orders }; }
      if (t.startsWith('SELECT id, track_token FROM orders')) return { rows: [] };
      if (t.startsWith('SELECT dedupe_key FROM sms_event_sends')) return { rows: [] };
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_event_sends')) return { rows: [{ n: countToday }] };
      if (t.startsWith('INSERT INTO sms_event_sends')) {
        const rows = [];
        for (let i = 0; i < args.length; i += 6) { const row = { id: state.nextId++, dedupe_key: args[i + 1], phone_hash: args[i + 3] }; state.sends.push(row); rows.push({ id: row.id, dedupe_key: row.dedupe_key }); }
        return { rows };
      }
      if (t.startsWith('UPDATE sms_event_sends SET status = ?')) return { rows: [] };
      if (t.startsWith('UPDATE sms_text_templates SET auto_ata_fail_at = NULL')) return { rows: [] };
      if (t.startsWith('UPDATE sms_text_templates SET auto_skip_reason = ?')) { state.skips.push({ why: args[0], id: args[1] }); return { rows: [{ id: args[1] }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_skip_reason = NULL')) return { rows: [] };
      if (t.startsWith('CREATE TABLE IF NOT EXISTS sms_cron_runs')) return { rows: [] };
      if (t.startsWith('INSERT INTO sms_cron_runs')) { state.runs[args[0]] = args[1]; return { rows: [] }; }
      if (t.startsWith('SELECT MAX(last_run)')) { const all = Object.values(state.runs).sort(); return { rows: [{ last_run: all.length ? all[all.length - 1] : null }] }; }
      throw new Error(`예상 못 한 SQL ${t}`);
    },
  };
}
const vendor = () => {
  const calls = { bms: [] };
  return { calls, estimateBms: ({ count }) => ({ unit: 100, total: 100 * count, fallback_unit: 45 }), async sendBmsEach(input) { calls.bms.push(input); return { accepted: input.messages.length, failed: 0, groupId: 'G1', uncertain: false, error: '' }; } };
};
const kakao = { async getBalance() { return 1000000; } };

test('브랜드메시지(광고)는 즉시형·가입/문의·날짜형 경로에서도 수신거부 번호를 뺀다', async () => {
  reset();
  const db = fakeDb({ orders: [mkOrder(1, '010-1111-2222'), mkOrder(2, '010-3333-4444')], optouts: ['010-1111-2222'] });
  const v = vendor();
  const out = await runEventSend(bmsTpl(), { db, provider: v, env: ENV, nowMs: NOW, kakao, warn: () => {} });
  assert.equal(out.sent, 1);
  assert.deepEqual(v.calls.bms[0].messages.map(m => m.to), ['01033334444']);
});

test('하루 상한에 막히면 건너뜀 사유(하루 상한 N건 도달, 남은 M건 다음 날)를 남긴다', async () => {
  reset();
  const db = fakeDb({ orders: [mkOrder(1, '010-1111-2222'), mkOrder(2, '010-3333-4444')], countToday: 1 });
  const v = vendor();
  const out = await runEventSend(bmsTpl(), { db, provider: v, env: { ...ENV, SMS_AUTO_INFO_MAX_PER_DAY: '1' }, nowMs: NOW, kakao, warn: () => {} });
  assert.equal(out.reason, 'cap'); assert.equal(v.calls.bms.length, 0);
  assert.deepEqual(db.state.skips, [{ why: '하루 상한 1건 도달, 남은 2건 다음 날', id: 41 }]);
});

test('문구 하나의 실행이 예외로 끝나도 사유(실행 오류: …·긴 숫자 가림)를 남기고 다음 문구는 계속한다', async () => {
  reset();
  const db = fakeDb();
  const rows = [41, 42].map(id => ({ id, name: `문구${id}`, body: '#{고객명}님, 주문 #{주문번호} 출고 예정일은 #{예상출고일} 입니다.', image: null, images: null, auto_kind: 'due_date', auto_enabled: true, auto_offset: 0, auto_audience: 'customer', auto_staff: '', auto_msg_type: 'info', auto_days: 0, auto_ata_template: '', auto_send_time: '' }));
  const inner = db.execute.bind(db);
  let ordersSeen = 0;
  db.execute = async q => {
    const t = q.sql.replace(/\s+/g, ' ').trim();
    if (t.startsWith("SELECT id FROM sms_text_templates WHERE auto_enabled = true AND auto_kind IN ('due_date'")) return { rows: rows.map(r => ({ id: r.id })) };
    if (t.startsWith('SELECT id, name, body, image, images, auto_kind, auto_enabled, auto_offset')) return { rows: rows.filter(r => r.id === q.args[0]) };
    if (t.startsWith("UPDATE sms_event_sends SET status = 'uncertain'")) return { rows: [] };
    if (t.includes("FROM orders o WHERE o.status = 'in_production'")) { ordersSeen += 1; if (ordersSeen === 1) throw new Error('연결 끊김 01012345678'); return { rows: [] }; }
    return inner(q);
  };
  const v = vendor();
  v.sendEach = async () => ({ accepted: 0, failed: 0, groupId: null, uncertain: false, error: '' });
  const total = await runEventSendAll({ db, provider: v, env: ENV, nowMs: NOW, warn: () => {} });
  assert.equal(total.templates, 2); assert.equal(total.skipped, 1); assert.equal(ordersSeen, 2, '둘째 문구도 실행됐다');
  assert.deepEqual(db.state.skips, [{ why: '실행 오류: 연결 끊김 ***', id: 41 }]);
});

test('크론 마지막 실행: 기록·조회, 30분을 넘으면 켜짐이 막힘(자동 발송 실행이 멈춤)으로 보이고, 기록이 없거나 최근이면 막지 않는다', async () => {
  reset();
  const db = fakeDb();
  assert.equal(await cronLastRun(db), '', '기록이 없으면 빈 값');
  await recordCronRun(db, 'sms-auto', NOW - 5 * HOUR);
  await recordCronRun(db, 'sms-auto-event', NOW - 31 * MIN);
  assert.equal(await cronLastRun(db), new Date(NOW - 31 * MIN).toISOString(), '두 크론 중 가장 최근');
  const on = { enabled: true, sent_7d: 3 };
  assert.deepEqual(autoEffective({ ...on, cron_last_run: new Date(NOW - 31 * MIN).toISOString() }, NOW), { tone: 'blocked', text: '켜짐(막힘: 자동 발송 실행이 멈춤(마지막 09:29))', blocked: true });
  assert.equal(autoEffective({ ...on, cron_last_run: new Date(NOW - 29 * MIN).toISOString() }, NOW).tone, 'on');
  assert.equal(autoEffective({ ...on, cron_last_run: '' }, NOW).tone, 'on');
  assert.equal(autoEffective({ ...on, cron_last_run: 'x' }, NOW).tone, 'on');
  assert.equal(autoEffective({ enabled: false, cron_last_run: new Date(NOW - 5 * HOUR).toISOString() }, NOW).tone, 'off', '꺼진 문구는 그대로 꺼짐');
  const broken = { async execute() { throw new Error('boom'); } };
  await recordCronRun(broken, 'x', NOW); assert.equal(await cronLastRun(broken), '', '기록·조회 실패는 조용히');
});

test('sms-auto-event 크론은 성공하면 마지막 실행 시각을 남긴다', async () => {
  process.env.CRON_SECRET = 'test-secret-value';
  const db = fakeDb();
  const sent = [];
  const res = { status(code) { this.code = code; return this; }, json(body) { sent.push([this.code || 200, body]); return this; } };
  await handleSmsAutoEvent({ method: 'GET', headers: { authorization: 'Bearer test-secret-value' } }, res, { db, nowMs: NOW, run: async () => ({ templates: 0 }), runTimed: async () => null, logger: {} });
  assert.equal(sent[0][0], 200);
  assert.deepEqual(db.state.runs, { 'sms-auto-event': new Date(NOW).toISOString() });
});

test('쏠라피 그룹이 FAILED 이고 나간 건수가 0이면 그 그룹의 메시지는 대기·발송중 코드여도 실패로 센다(성공 코드는 그대로)', () => {
  assert.equal(classifyStatus({ statusCode: '2000' }, { nowMs: NOW }).status, 'pending');
  assert.equal(classifyStatus({ statusCode: '2000' }, { nowMs: NOW, groupFailed: true }).status, 'failed');
  assert.equal(classifyStatus({}, { nowMs: NOW, groupFailed: true }).status, 'failed');
  assert.equal(classifyStatus({ statusCode: '4000' }, { nowMs: NOW, groupFailed: true }).status, 'success');
  const message = { messageId: 'M1', groupId: 'G1', to: '01011112222', from: '0212345678', type: 'SMS', statusCode: '2000', dateCreated: new Date(NOW).toISOString(), log: [] };
  assert.equal(buildItems([message], [], { nowMs: NOW })[0].status, 'pending');
  const failed = buildItems([message], [], { nowMs: NOW, failedGroupIds: new Set(['G1']) })[0];
  assert.equal(failed.status, 'failed'); assert.equal(failed.status_text, '발송실패');
});

test('브랜드메시지는 080 무료수신거부 줄이 없어도 켜기는 막히지 않고 경고(no_optout_080)만 남는다', () => {
  assert.equal(bmsOptoutCheck(BMS_BODY), '');
  assert.equal(bmsOptoutCheck('안녕하세요 #{고객명}'), 'no_optout_080');
  assert.equal(eventBlockedReason(bmsTpl({ body: '안녕하세요 #{고객명} 대표님' })), '', '막지 않는다');
  assert.equal(eventWarnReason(bmsTpl({ body: '안녕하세요 #{고객명} 대표님' })), 'no_optout_080', '경고는 남는다');
  assert.equal(eventWarnReason(bmsTpl()), '');
  assert.equal(eventBlockedReason(bmsTpl()), '');
});

test('080 줄이 없는 기존 켜진 브랜드메시지도 발송 경로는 멈추지 않는다(표시만 막힘)', async () => {
  reset();
  const db = fakeDb({ orders: [mkOrder(1, '010-3333-4444')] });
  const v = vendor();
  const out = await runEventSend(bmsTpl({ body: '안녕하세요 #{고객명} 대표님' }), { db, provider: v, env: ENV, nowMs: NOW, kakao, warn: () => {} });
  assert.equal(out.sent, 1);
});
