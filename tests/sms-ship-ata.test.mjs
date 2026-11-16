// 출고 완료 후 N일(ship_plus_days) + 알림톡 수단. 가짜 db·가짜 발송기만 쓴다(실제 발송 없음). 값은 모두 가짜.
import assert from 'node:assert/strict';
import test from 'node:test';
import { _resetAutoSchemaForTest, phoneHash, runAutoSend } from '../api/_lib/smsAutoSend.js';
import { _resetTextTemplateSchemaForTest, isInfoTemplate, saveTextTemplate } from '../api/_lib/smsTextTemplates.js';
import { _resetEventSchemaForTest, eventToggleOn } from '../api/_lib/smsEventSend.js';
import { autoConditionLine, buildSaveBody, isAdKind } from '../src/components/smsconsole/smsTextTemplateFormModel.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db';
const NOW = Date.parse('2026-11-20T01:00:00Z'); // KST 11-20 10:00
const HOUR = 3600000;
const ENV = { SMS_SENDER: '0212345678' };
const BODY = '#{고객명}님, 구글 리뷰 안내드립니다.';
const AD_BODY = '(광고) #{고객명}님 안내\n무료수신거부 080-500-4233';

function fakeDb({ orders = [], optouts = [] } = {}) {
  const state = { sends: [], nextId: 1, sql: [] };
  return {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      state.sql.push(t);
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT conname FROM pg_constraint')) return { rows: [] };
      if (t.startsWith('SELECT phone_hash FROM sms_optouts')) return { rows: optouts.map(hash => ({ phone_hash: hash })) };
      if (t.includes("FROM orders WHERE status = 'shipped'")) return { rows: orders.filter(o => o.status === 'shipped' && o.ship_date.slice(0, 10) >= args[0] && o.ship_date.slice(0, 10) <= args[1]).map(o => ({ id: o.id, phone: o.phone, client_name: o.client_name, ship_day: o.ship_date.slice(0, 10) })) };
      if (t.startsWith('SELECT dedupe_key FROM sms_event_sends WHERE template_id = ? AND dedupe_key IN')) return { rows: state.sends.filter(r => r.template_id === args[0] && args.slice(1).includes(r.dedupe_key)).map(r => ({ dedupe_key: r.dedupe_key })) };
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_event_sends WHERE kst_date = ?')) return { rows: [{ n: state.sends.filter(r => r.kst_date === args[0]).length }] };
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
      if (t.startsWith('UPDATE sms_event_sends SET status = ?')) { const [status, , , , ...ids] = args; for (const r of state.sends.filter(x => ids.includes(x.id))) r.status = status; return { rows: [] }; }
      throw new Error(`예상 못 한 SQL ${t}`);
    },
  };
}
function saveDb(saved) {
  return {
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      if (/^(CREATE|ALTER)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT id FROM sms_text_templates WHERE name')) return { rows: [] };
      if (t.startsWith('SELECT COUNT(*)')) return { rows: [{ n: 0 }] };
      if (t.startsWith('INSERT INTO sms_text_templates')) { const cols = /\(([^)]*)\) VALUES/.exec(t)[1].split(',').map(c => c.trim()); const row = {}; cols.forEach((c, i) => { row[c] = args[i]; }); saved.push(row); return { rows: [{ id: saved.length }] }; }
      throw new Error(`예상 못 한 SQL ${t}`);
    },
  };
}
function fakeProvider() {
  const calls = { each: [], kakao: [] };
  const ok = input => ({ accepted: input.messages.length, failed: 0, groupId: 'G1', uncertain: false, error: '' });
  return { calls, async uploadImage() { return { fileId: 'F1' }; }, async sendEach(input) { calls.each.push(input); return ok(input); }, async sendKakaoEach(input) { calls.kakao.push(input); return ok(input); } };
}
const fakeKakao = (over = {}) => ({ async getTemplateFresh() { return { raw: { channelId: 'PF1' }, template: { status: 'APPROVED', variables: ['#{고객명}'], content: '#{고객명}님' }, scope: { allowed: true, kind: 'channel' }, ...over }; } });
const reset = () => { _resetEventSchemaForTest(); _resetAutoSchemaForTest(); _resetTextTemplateSchemaForTest(); };
const order = (id, phone, shipDate, name = '', status = 'shipped') => ({ id, phone, ship_date: shipDate, client_name: name, status });
const tpl = (extra = {}) => ({ id: 31, name: '리뷰 안내', body: BODY, images: [], auto_kind: 'ship_plus_days', auto_enabled: true, auto_days: 3, auto_ata_template: 'KA01TP1', auto_enabled_at: new Date(NOW - 3 * HOUR).toISOString(), auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_offset: 0, auto_unless_step: '', auto_daily: '', auto_weekdays: false, auto_unless_mode: 'completed', auto_step: '', auto_send_time: '', auto_start_date: '', auto_send_from: '', auto_repeat: 1, auto_interval: 30, ...extra });
const go = (db, provider, template, extra = {}) => { reset(); return runAutoSend(template, { db, provider, env: ENV, nowMs: NOW, kakao: fakeKakao(), ...extra }); };

test('저장: 출고 완료 후 + 알림톡은 정보성(info)으로 알림톡 칸이 저장되고, 고객명 밖 변수·잘못된 id·0일은 막힌다, 알림톡은 광고 낱말 검사를 하지 않는다', async () => {
  const saved = [];
  const db = saveDb(saved);
  reset();
  const a = await saveTextTemplate(db, { name: 'a', body: BODY, auto: { kind: 'ship_plus_days', days: 3, ata_template: 'KA01TP1' } }, { staff: [] });
  assert.equal(a.status, 201);
  assert.deepEqual([saved[0].auto_kind, saved[0].auto_days, saved[0].auto_msg_type, saved[0].auto_ata_template], ['ship_plus_days', 3, 'info', 'KA01TP1']);
  assert.equal(a.body.item.auto_ata_template, 'KA01TP1');
  assert.equal((await saveTextTemplate(db, { name: 'b', body: '#{주문번호} 안내', auto: { kind: 'ship_plus_days', days: 3, ata_template: 'KA01TP1' } }, { staff: [] })).status, 400);
  assert.equal((await saveTextTemplate(db, { name: 'c', body: BODY, auto: { kind: 'ship_plus_days', days: 3, ata_template: 'bad id!' } }, { staff: [] })).status, 400);
  assert.equal((await saveTextTemplate(db, { name: 'd', body: BODY, auto: { kind: 'ship_plus_days', days: 0, ata_template: 'KA01TP1' } }, { staff: [] })).status, 400);
  assert.equal((await saveTextTemplate(db, { name: 'e', body: '#{고객명}님 이벤트 안내', auto: { kind: 'ship_plus_days', days: 3, ata_template: 'KA01TP1' } }, { staff: [] })).status, 201);
});

test('저장: 문자로 고르면 지금과 같다(광고 문구·알림톡 칸 없음), 주문 등록 후는 알림톡 칸을 받지 않는다', async () => {
  const saved = [];
  const db = saveDb(saved);
  reset();
  const sms = await saveTextTemplate(db, { name: 'a', body: AD_BODY, auto: { kind: 'ship_plus_days', days: 3 } }, { staff: [] });
  assert.equal(sms.status, 201);
  assert.deepEqual([saved[0].auto_msg_type, saved[0].auto_ata_template], ['ad', '']);
  assert.equal('auto_ata_template' in sms.body.item, false);
  const ordered = await saveTextTemplate(db, { name: 'b', body: AD_BODY, auto: { kind: 'order_plus_days', days: 3, ata_template: 'KA01TP1' } }, { staff: [] });
  assert.equal(ordered.status, 201);
  assert.deepEqual([saved[1].auto_msg_type, saved[1].auto_ata_template], ['ad', '']);
});

test('대상 계산: 출고일+N 이 오늘인 출고 건만 알림톡(문자 대체 끔)으로 나가고, 지난·아직인 출고분·미출고·비 010 번호는 제외, 다시 돌려도 중복 없음', async () => {
  const db = fakeDb({ orders: [
    order(1, '010-1111-2222', '2026-11-17', '가나다'), // 정확히 3일 전 → 대상
    order(2, '010-3333-4444', '2026-11-16'), // 4일 전 → 이미 지남
    order(3, '010-5555-6666', '2026-11-18'), // 2일 전 → 아직
    order(4, '010-7777-8888', '2026-11-17', '', 'in_production'), // 미출고
    order(5, '02-123-4567', '2026-11-17'), // 010 아님
  ] });
  const provider = fakeProvider();
  const out = await go(db, provider, tpl());
  assert.equal(out.claimed, 1); assert.equal(out.sent, 1);
  assert.equal(provider.calls.each.length, 0);
  assert.deepEqual(provider.calls.kakao[0], { from: '0212345678', pfId: 'PF1', disableSms: true, messages: [{ to: '01011112222', templateId: 'KA01TP1', variables: { 고객명: '가나다' } }] });
  assert.match(db.state.sends[0].dedupe_key, /^[0-9a-f]{64}:ship$/);
  assert.equal((await go(db, provider, tpl())).claimed, 0);
  assert.equal(provider.calls.kakao.length, 1);
});

test('켠 날 이후 규칙: 출고일+N 이 켠 날(KST)보다 이르면 보내지 않고, 같은 날이면 보내며, 켠 시각이 없으면 무동작', async () => {
  const orders = [order(1, '010-1111-2222', '2026-11-17')];
  const late = await go(fakeDb({ orders }), fakeProvider(), tpl({ auto_enabled_at: '2026-11-20T16:00:00.000Z' })); // KST 11-21 에 켬 → 11-20 분은 켜기 전
  assert.equal(late.targets, 0);
  const none = await go(fakeDb({ orders }), fakeProvider(), tpl({ auto_enabled_at: '' }));
  assert.equal(none.targets, 0);
  const sameDay = await go(fakeDb({ orders }), fakeProvider(), tpl({ auto_enabled_at: '2026-11-20T00:30:00.000Z' })); // KST 11-20 09:30 에 켬
  assert.equal(sameDay.targets, 1);
});

test('수신거부 번호는 알림톡 대상에서도 빠지고, 승인 안 된 템플릿이면 선점 0', async () => {
  const orders = [order(1, '010-1111-2222', '2026-11-17'), order(2, '010-3333-4444', '2026-11-17')];
  const out = await go(fakeDb({ orders, optouts: [phoneHash('01011112222')] }), fakeProvider(), tpl());
  assert.equal(out.claimed, 1);
  const db = fakeDb({ orders }); const provider = fakeProvider();
  const notReady = await go(db, provider, tpl(), { kakao: fakeKakao({ template: { status: 'PENDING', variables: [] } }) });
  assert.equal(notReady.reason, 'ata_not_ready'); assert.equal(db.state.sends.length, 0); assert.equal(provider.calls.kakao.length, 0);
});

test('문자 갈래는 그대로: 알림톡 없는 출고 완료 후 문구는 안내 경로를 타지 않고 광고 검사로 막힌다', async () => {
  const db = fakeDb({ orders: [order(1, '010-1111-2222', '2026-11-17')] }); const provider = fakeProvider();
  const noAd = await go(db, provider, tpl({ auto_ata_template: '', auto_msg_type: 'ad', body: '#{고객명}님 안녕하세요' }));
  assert.equal(noAd.reason, 'no_ad_prefix'); assert.equal(provider.calls.kakao.length, 0); assert.equal(provider.calls.each.length, 0);
  assert.equal(isInfoTemplate(tpl({ auto_ata_template: '' })), false);
  assert.equal(isInfoTemplate(tpl()), true);
});

test('켜기: 알림톡 승인·변수가 맞아야 켜지고 켠 시각(auto_enabled_at)을 기록하며, 미리보기 대상 수가 나온다', async () => {
  const db = fakeDb({ orders: [order(1, '010-1111-2222', '2026-11-17')] });
  const bad = await eventToggleOn({}, tpl({ auto_enabled: false }), { db, env: ENV, nowMs: NOW, kakao: fakeKakao({ template: { status: 'APPROVED', variables: ['#{고객명}', '#{링크}'] } }) });
  assert.equal(bad.body.reason, 'ata_not_ready');
  const updates = [];
  const db2 = { ...db, async execute(q) { if (q.sql.startsWith('UPDATE sms_text_templates SET auto_enabled = true')) { updates.push(q); return { rows: [] }; } return db.execute(q); } };
  reset();
  const on = await eventToggleOn({}, tpl({ auto_enabled: false }), { db: db2, env: ENV, nowMs: NOW, kakao: fakeKakao() });
  assert.equal(on.status, 200); assert.equal(on.body.enabled, true);
  assert.ok(updates[0].sql.includes('auto_enabled_at = NOW()'));
  reset();
  const dry = await eventToggleOn({ dry_run: true }, tpl({ auto_enabled: false }), { db: db2, env: ENV, nowMs: NOW, kakao: fakeKakao() });
  assert.equal(dry.body.targets, 1);
});

test('화면 모델: 알림톡을 고르면 저장 본문에 ata_template 이 실리고 광고 표기 대상이 아니며, 문자로면 지금과 같다', () => {
  assert.deepEqual(buildSaveBody({ name: 'a', body: 'b', auto: { kind: 'ship_plus_days', days: '3', ataTemplate: 'KA01' } }).auto, { kind: 'ship_plus_days', days: 3, ata_template: 'KA01' });
  assert.equal('ata_template' in buildSaveBody({ name: 'a', body: 'b', auto: { kind: 'ship_plus_days', days: '3', ataTemplate: '' } }).auto, false);
  assert.equal('ata_template' in buildSaveBody({ name: 'a', body: 'b', auto: { kind: 'order_plus_days', days: '3', ataTemplate: 'KA01' } }).auto, false);
  assert.equal(isAdKind('ship_plus_days'), true);
  assert.equal(isAdKind('ship_plus_days', 'KA01'), false);
  assert.equal(isAdKind('order_plus_days', 'KA01'), true);
  assert.match(autoConditionLine({ autoKind: 'ship_plus_days', autoDays: 3, autoAtaTemplate: 'KA01' }), /알림톡/);
  assert.doesNotMatch(autoConditionLine({ autoKind: 'ship_plus_days', autoDays: 3 }), /알림톡/);
});
