// 알림톡 자동·일괄 발송 점검 수정 4건: 묶음 통째 실패 시 영구 누락 방지, 일부 실패 번호만 failed, 채널 없음 안내 분리,
// 일괄 발송 범위 끝(오늘 − N일), 같은 알림톡으로 문구 중복 생성 방지. 가짜 db·가짜 발송기만 쓴다(실제 발송 없음). 값은 모두 가짜.
import assert from 'node:assert/strict';
import test from 'node:test';
import { _resetAutoSchemaForTest } from '../api/_lib/smsAutoSend.js';
import { _resetTextTemplateSchemaForTest } from '../api/_lib/smsTextTemplates.js';
import { _resetEventSchemaForTest, ataReady, catchupEnd, catchupPreview, eventToggleOn, runEventSend } from '../api/_lib/smsEventSend.js';
import { ataLinkLine, autoStatusLine, catchupPausedText, linkedTextEntries } from '../src/components/smsconsole/smsTextTemplateFormModel.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db';
const NOW = Date.parse('2026-11-20T01:00:00Z'); // KST 11-20 10:00
const HOUR = 3600000;
const ENV = { SMS_SENDER: '0212345678' };
const BODY = '#{고객명}님, 구글 리뷰 안내드립니다.';

function fakeDb({ orders = [] } = {}) {
  const state = { sends: [], nextId: 1, sql: [], done: [], paused: [], failMark: 0, failClear: 0 };
  return {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      state.sql.push(t);
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
function provider(respond) {
  const calls = { kakao: [] };
  return { calls, async sendKakaoEach(input) { calls.kakao.push(input); return respond(input); }, estimateKakao: ({ count }) => ({ unit: 13, total: 13 * count }) };
}
const accepted = input => ({ accepted: input.messages.length, failed: 0, groupId: 'G1', uncertain: false, error: '' });
const fakeKakao = (over = {}) => ({ async getBalance() { return 100000; }, async getTemplateFresh() { return { raw: { channelId: 'PF1' }, template: { status: 'APPROVED', variables: ['#{고객명}'], content: '#{고객명}님' }, scope: { allowed: true, kind: 'channel' }, ...over }; } });
const reset = () => { _resetEventSchemaForTest(); _resetAutoSchemaForTest(); _resetTextTemplateSchemaForTest(); };
const base = (extra = {}) => ({ id: 31, name: '리뷰 안내', body: BODY, images: [], auto_kind: 'ship_plus_days', auto_enabled: true, auto_days: 3, auto_ata_template: 'KA01TP1', auto_enabled_at: new Date(NOW - 3 * HOUR).toISOString(), auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_offset: 0, auto_unless_step: '', auto_daily: '', auto_weekdays: false, auto_unless_mode: 'completed', auto_step: '', auto_send_time: '', auto_catchup_from: '', auto_catchup_at: '', auto_catchup_done: false, ...extra });
const catchupTpl = (extra = {}) => base({ auto_catchup_from: '2026-10-01', auto_catchup_at: '2026-11-20T09:00', ...extra });
const order = (id, phone, shipDate, name = '') => ({ id, phone, ship_date: shipDate, client_name: name, status: 'shipped' });
const run = (db, vendor, template, extra = {}) => { reset(); return runEventSend(template, { db, provider: vendor, env: ENV, nowMs: NOW, kakao: fakeKakao(), warn: () => {}, ...extra }); };
const threeOrders = [order(1, '010-1111-2222', '2026-10-05', '가'), order(2, '010-3333-4444', '2026-10-06', '나'), order(3, '010-5555-6666', '2026-10-07', '다')];

// ---------- 1. 묶음 통째 실패 ----------
test('일괄 발송 묶음이 통째 실패(접수 0건): 선점 행을 지우고 일괄 발송을 멈추며 완료 표시는 하지 않는다', async () => {
  const db = fakeDb({ orders: threeOrders });
  const vendor = provider(input => ({ accepted: 0, failed: input.messages.length, groupId: null, uncertain: false, error: '템플릿 오류' }));
  const out = await run(db, vendor, catchupTpl(), { catchupOnly: true });
  assert.equal(vendor.calls.kakao.length, 1);
  assert.equal(db.state.sends.length, 0, '선점 행이 지워져야 다음에 다시 보낼 수 있다');
  assert.deepEqual(db.state.paused, [{ error: '템플릿 오류', id: 31 }]);
  assert.deepEqual(db.state.done, [], '완료 표시 금지');
  assert.equal(out.reason, 'catchup_paused'); assert.equal(out.failed, 3);
  assert.equal(db.state.failMark, 0, '평소 발송용 실패 표시는 일괄 발송에 쓰지 않는다');
});

test('멈춘 일괄 발송은 다음 크론에 다시 보내지 않고, 화면에서 다시 저장해야(paused 해제) 이어진다', async () => {
  const db = fakeDb({ orders: threeOrders });
  const vendor = provider(accepted);
  const out = await run(db, vendor, catchupTpl({ auto_catchup_paused: true, auto_catchup_error: '템플릿 오류' }), { catchupOnly: true });
  assert.equal(vendor.calls.kakao.length, 0); assert.equal(out.sent, 0); assert.deepEqual(db.state.done, []);
  const db2 = fakeDb({ orders: threeOrders });
  const vendor2 = provider(accepted);
  assert.equal((await run(db2, vendor2, catchupTpl(), { catchupOnly: true })).sent, 3, '다시 저장해 paused 가 풀리면 지워진 행의 번호가 다시 대상이 된다');
});

test('알림톡 발송 호출이 예외로 끝나도 통째 실패로 보고 행을 지운다', async () => {
  const db = fakeDb({ orders: threeOrders });
  const vendor = provider(() => { throw new Error('boom'); });
  const out = await run(db, vendor, catchupTpl(), { catchupOnly: true });
  assert.equal(db.state.sends.length, 0); assert.equal(db.state.paused.length, 1); assert.equal(out.reason, 'catchup_paused');
});

test('평소 발송 묶음이 통째 실패: 행을 지워 다시 시도하고, 연속 실패면 1시간 건너뛴다(성공하면 표시를 지운다)', async () => {
  const orders = [order(1, '010-1111-2222', '2026-11-17', '가')]; // 출고 3일째 = 오늘
  const db = fakeDb({ orders });
  const fail = provider(input => ({ accepted: 0, failed: input.messages.length, groupId: null, uncertain: false, error: '거절' }));
  const first = await run(db, fail, base());
  assert.equal(first.reason, 'ata_failed'); assert.equal(db.state.sends.length, 0); assert.equal(db.state.failMark, 1); assert.deepEqual(db.state.paused, []);
  const skipped = await run(db, fail, base({ auto_ata_fail_at: new Date(NOW + HOUR).toISOString() }));
  assert.equal(skipped.reason, 'ata_backoff'); assert.equal(fail.calls.kakao.length, 1, '건너뛰는 동안은 호출하지 않는다');
  const ok = provider(accepted);
  const after = await run(db, ok, base({ auto_ata_fail_at: new Date(NOW - 60000).toISOString() }));
  assert.equal(after.sent, 1); assert.equal(db.state.failClear, 1);
});

test('시간 초과(uncertain)는 지금처럼 행을 남겨 다시 보내지 않는다', async () => {
  const db = fakeDb({ orders: threeOrders });
  const vendor = provider(() => ({ accepted: 0, failed: 0, groupId: null, uncertain: true, error: '시간 초과' }));
  const out = await run(db, vendor, catchupTpl(), { catchupOnly: true });
  assert.equal(out.uncertain, 3); assert.equal(db.state.sends.length, 3); assert.deepEqual(db.state.paused, []);
});

test('일부 실패: 실패 번호 목록이 있으면 그 번호 행만 failed, 나머지는 sent / 목록이 없으면 지금처럼 전부 uncertain', async () => {
  const db = fakeDb({ orders: threeOrders });
  const vendor = provider(input => ({ accepted: input.messages.length - 1, failed: 1, groupId: 'G9', uncertain: false, error: '', failedTo: ['01033334444'] }));
  const out = await run(db, vendor, catchupTpl(), { catchupOnly: true });
  assert.deepEqual([out.sent, out.failed, out.uncertain], [2, 1, 0]);
  assert.deepEqual(db.state.sends.map(r => r.status).sort(), ['failed', 'sent', 'sent']);
  assert.equal(db.state.sends.find(r => r.status === 'failed').reason, '일부 번호 실패');
  const db2 = fakeDb({ orders: threeOrders });
  const noList = provider(input => ({ accepted: input.messages.length - 1, failed: 1, groupId: 'G9', uncertain: false, error: '' }));
  const out2 = await run(db2, noList, catchupTpl(), { catchupOnly: true });
  assert.equal(out2.uncertain, 3); assert.ok(db2.state.sends.every(r => r.status === 'uncertain'));
});

// ---------- 2. 채널 없음 안내 ----------
test('채널을 못 얻으면 안내문이 따로 나온다(승인·변수 문제 안내는 그대로)', async () => {
  const noChannel = fakeKakao({ raw: {} });
  assert.deepEqual(await ataReady('KA01TP1', { kakao: noChannel, env: {} }), { ok: false, pfId: '', reason: 'ata_no_channel' });
  assert.equal((await ataReady('KA01TP1', { kakao: fakeKakao({ template: { status: 'PENDING', variables: [] } }), env: {} })).reason, 'ata_not_ready');
  const db = fakeDb();
  reset();
  const toggled = await eventToggleOn({}, base(), { db, env: ENV, nowMs: NOW, kakao: noChannel });
  assert.equal(toggled.status, 400); assert.equal(toggled.body.reason, 'ata_no_channel');
  assert.equal(toggled.body.error.message, '카카오 채널을 찾지 못했습니다(템플릿 채널·KAKAO_PF_ID 확인).');
  reset();
  const pending = await eventToggleOn({}, base(), { db, env: ENV, nowMs: NOW, kakao: fakeKakao({ template: { status: 'PENDING', variables: [] } }) });
  assert.equal(pending.body.reason, 'ata_not_ready');
  reset();
  const ran = await run(fakeDb({ orders: threeOrders }), provider(accepted), catchupTpl(), { catchupOnly: true, kakao: noChannel });
  assert.equal(ran.reason, 'ata_no_channel');
});

// ---------- 3. 일괄 발송 범위 끝 ----------
test('일괄 발송 대상의 출고일 끝은 오늘 − N일이다(미리보기도 같은 기준)', async () => {
  assert.equal(catchupEnd('2026-11-20', 3), '2026-11-17');
  assert.equal(catchupEnd('2026-11-20', 0), '2026-11-20');
  const orders = [order(1, '010-1111-2222', '2026-11-17'), order(2, '010-3333-4444', '2026-11-18'), order(3, '010-5555-6666', '2026-11-20')];
  const db = fakeDb({ orders });
  const vendor = provider(accepted);
  const out = await run(db, vendor, catchupTpl({ auto_catchup_from: '2026-11-01', auto_days: 3 }), { catchupOnly: true });
  assert.deepEqual(vendor.calls.kakao[0].messages.map(m => m.to), ['01011112222'], '출고 3일이 지난 주문만');
  assert.equal(out.sent, 1);
  reset();
  const preview = await catchupPreview(fakeDb({ orders }), { from: '2026-11-01', days: 3, nowMs: NOW, env: ENV, provider: provider(accepted), kakao: fakeKakao() });
  assert.equal(preview.end_date, '2026-11-17'); assert.equal(preview.ranges[0].count, 1);
});

// ---------- 4. 같은 알림톡으로 문구 중복 생성 ----------
test('같은 알림톡을 쓰는 문구가 있으면 찾아서 연다(여러 개면 첫 번째), 없으면 빈 목록', () => {
  const items = [{ id: 5, name: '가', body: 'x', auto_ata_template: 'KA02' }, { id: 7, name: '나', body: 'x', auto_ata_template: 'KA01', auto_kind: 'ship_plus_days' }, { id: 9, name: '다', body: 'x', auto_ata_template: 'KA01' }];
  assert.deepEqual(linkedTextEntries(items, 'KA01').map(e => e.id), [7, 9]);
  assert.deepEqual(linkedTextEntries(items, 'KA99'), []);
  assert.deepEqual(linkedTextEntries(null, 'KA01'), []);
  assert.deepEqual(linkedTextEntries(items, ''), []);
});

// ---------- 화면 문구 ----------
test('일괄 발송이 멈추면 화면에 사유와 재개 방법이 나온다', () => {
  const text = '일괄 발송이 멈췄습니다: 템플릿 오류. 확인 후 다시 저장하면 이어서 보냅니다.';
  assert.equal(catchupPausedText({ catchup_paused: true, catchup_error: '템플릿 오류' }), text);
  assert.equal(catchupPausedText({ catchup_paused: false }), '');
  assert.ok(autoStatusLine({ enabled: true, catchup_paused: true, catchup_error: '템플릿 오류' }).endsWith(text));
  assert.ok(ataLinkLine({ autoKind: 'ship_plus_days', autoDays: 3, autoEnabled: true }, { enabled: true, catchup_paused: true, catchup_error: '템플릿 오류' }).endsWith(text));
});
