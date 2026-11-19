// 2026-11-19 Make 발송 이전 v4 (S1 업체명 변수 · S2 주문 0일 · S3 plain 면제 · S5 lead 재시도 창) 시험. 가짜 db·가짜 발송기만 쓴다(실제 발송 없음).
import assert from 'node:assert/strict';
import test from 'node:test';
import { _resetCafe24SchemaForTest } from '../api/_lib/cafe24.js';
import { _resetLeadSchemaForTest, insertLead } from '../api/_lib/smsLeads.js';
import { _resetAutoSchemaForTest } from '../api/_lib/smsAutoSend.js';
import { _resetTextTemplateSchemaForTest } from '../api/_lib/smsTextTemplates.js';
import { _resetEventSchemaForTest, ataReady, runEventSend } from '../api/_lib/smsEventSend.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db';
const NOW = Date.parse('2026-11-20T09:00:00Z'); // KST 11-20 18:00
const HOUR = 3600000;
const ENV = { SMS_SENDER: '0212345678' };
const BODY = '#{고객명}님, 한성쇼케이스입니다.';

function fakeDb({ orderDay = [], shipped = [], dueRows = [] } = {}) {
  const state = { leads: [], sends: [], nextId: 1, nextLead: 1 };
  return {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT conname FROM pg_constraint')) return { rows: [] };
      if (t.startsWith('SELECT phone_hash FROM sms_optouts')) return { rows: [] };
      if (t.includes('FROM orders WHERE order_date IS NOT NULL')) return { rows: orderDay.filter(o => o.order_date.slice(0, 10) >= args[0] && o.order_date.slice(0, 10) <= args[1]).map(o => ({ id: o.id, phone: o.phone, client_name: o.client_name, ship_day: o.order_date.slice(0, 10) })) };
      if (t.includes("FROM orders WHERE status = 'shipped'")) return { rows: shipped.filter(o => o.ship_date.slice(0, 10) >= args[0] && o.ship_date.slice(0, 10) <= args[1]).map(o => ({ id: o.id, phone: o.phone, client_name: o.client_name, ship_day: o.ship_date.slice(0, 10) })) };
      if (t.includes("FROM orders o WHERE o.status = 'in_production'")) return { rows: dueRows };
      if (t.startsWith('SELECT id, track_token FROM orders')) return { rows: [] };
      if (t.startsWith('INSERT INTO sms_leads')) {
        const [source, key_hash, joined_at, phone_hash, phone_last4, phone_enc, name_enc] = args;
        if (state.leads.some(r => r.source === source && r.key_hash === key_hash)) return { rows: [] };
        const row = { id: state.nextLead++, source, key_hash, joined_at, phone_hash, phone_last4, phone_enc, name_enc };
        state.leads.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (t.startsWith('SELECT id, phone_hash, phone_last4, phone_enc, name_enc, joined_at FROM sms_leads')) return { rows: state.leads.filter(r => r.phone_enc && r.joined_at >= args[0] && r.joined_at <= args[1]) };
      if (t.startsWith('SELECT dedupe_key FROM sms_event_sends WHERE template_id = ? AND dedupe_key IN')) return { rows: state.sends.filter(r => r.template_id === args[0] && args.slice(1).includes(r.dedupe_key)).map(r => ({ dedupe_key: r.dedupe_key })) };
      if (t.startsWith('SELECT dedupe_key FROM sms_event_sends WHERE template_id = ?')) return { rows: state.sends.filter(r => r.template_id === args[0]).map(r => ({ dedupe_key: r.dedupe_key })) };
      if (t.startsWith('SELECT id, dedupe_key FROM sms_event_sends WHERE template_id = ? AND status')) return { rows: [] };
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_event_sends WHERE kst_date = ?')) return { rows: [{ n: 0 }] };
      if (t.startsWith('INSERT INTO sms_event_sends')) {
        const rows = [];
        for (let i = 0; i < args.length; i += 6) {
          const [template_id, dedupe_key, , phone_hash, , kst_date] = args.slice(i, i + 6);
          if (state.sends.some(r => r.template_id === template_id && r.dedupe_key === dedupe_key)) continue;
          const row = { id: state.nextId++, template_id, dedupe_key, phone_hash, kst_date, status: 'claimed' };
          state.sends.push(row); rows.push({ id: row.id, dedupe_key });
        }
        return { rows };
      }
      if (t.startsWith("DELETE FROM sms_event_sends WHERE status = 'claimed'")) { state.sends = state.sends.filter(r => !args.includes(r.id)); return { rows: [] }; }
      if (t.startsWith('UPDATE sms_event_sends SET status = ?')) { const [status, , , , ...ids] = args; for (const r of state.sends.filter(x => ids.includes(x.id))) r.status = status; return { rows: [] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_skip_reason')) return { rows: [{ id: 1 }] };
      throw new Error(`예상 못 한 SQL ${t}`);
    },
  };
}
function fakeProvider() {
  const calls = { each: [], kakao: [] };
  const ok = input => ({ accepted: input.messages.length, failed: 0, groupId: 'G1', uncertain: false, error: '' });
  return { calls, async uploadImage() { return { fileId: 'F1' }; }, async sendEach(input) { calls.each.push(input); return ok(input); }, async sendKakaoEach(input) { calls.kakao.push(input); return ok(input); }, estimateKakao: ({ count }) => ({ unit: 13, total: 13 * count }) };
}
const fakeKakao = (variables = ['#{고객명}']) => ({ async getBalance() { return 100000; }, async getTemplateFresh() { return { raw: { channelId: 'PF1' }, template: { status: 'APPROVED', variables, content: variables.join(' ') }, scope: { allowed: true, kind: 'channel' } }; } });
const reset = () => { _resetEventSchemaForTest(); _resetLeadSchemaForTest(); _resetCafe24SchemaForTest(); _resetAutoSchemaForTest(); _resetTextTemplateSchemaForTest(); };
const tpl = (extra = {}) => ({ id: 31, name: '시험', body: BODY, images: [], auto_kind: 'order_plus_days', auto_enabled: true, auto_days: 0, auto_ata_template: 'KA01TP1', auto_enabled_at: new Date(NOW - 5 * 24 * HOUR).toISOString(), auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_offset: 0, auto_unless_step: '', auto_step: '', ...extra });
const go = (db, provider, template, extra = {}) => { reset(); return runEventSend(template, { db, provider, env: ENV, nowMs: NOW, warn() {}, kakao: fakeKakao(), ...extra }); };
const day = n => Date.parse('2026-11-20T03:00:00Z') - n * 24 * HOUR; // KST 오늘 낮 12시 − n일
const lead = (db, key, phone, ms, name = '') => insertLead(db, { source: 'cafe24', key, phone, name, joinedAtMs: ms });

test('S1: 알림톡 변수 #{업체명} 이 승인 변수로 허용되고, 값은 #{고객명}과 같다(주문·접수 모두)', async () => {
  assert.equal((await ataReady('KA01', { kakao: fakeKakao(['#{고객명}', '#{업체명}']) })).ok, true);
  assert.equal((await ataReady('KA01', { kakao: fakeKakao(['#{고객명}', '#{모르는}']) })).ok, false);
  const orders = fakeDb({ orderDay: [{ id: 1, phone: '010-1111-2222', client_name: '가나다', order_date: '2026-11-20' }] }); const p1 = fakeProvider();
  const a = await go(orders, p1, tpl(), { kakao: fakeKakao(['#{고객명}', '#{업체명}']) });
  assert.equal(a.sent, 1);
  assert.deepEqual(p1.calls.kakao[0].messages[0].variables, { 고객명: '가나다', 업체명: '가나다' });
  const leads = fakeDb(); const p2 = fakeProvider();
  await lead(leads, 'a', '010-3333-4444', day(1), '라마바');
  const b = await go(leads, p2, tpl({ auto_kind: 'lead_plus_days', auto_days: 1, auto_enabled_at: new Date(NOW - 10 * 24 * HOUR).toISOString() }), { kakao: fakeKakao(['#{고객명}', '#{업체명}']) });
  assert.equal(b.sent, 1);
  assert.deepEqual(p2.calls.kakao[0].messages[0].variables, { 고객명: '라마바', 업체명: '라마바' });
});

test('S2: 주문 후 0일 = 오늘 주문이 대상(번호당 평생 1번), 이전 주문과 켜기 전 예정일은 제외', async () => {
  const db = fakeDb({ orderDay: [
    { id: 1, phone: '010-1111-2222', client_name: '오늘', order_date: '2026-11-20' },
    { id: 2, phone: '010-3333-4444', client_name: '켜기전', order_date: '2026-11-19' },
    { id: 3, phone: '010-5555-6666', client_name: '더전', order_date: '2026-11-16' },
  ] }); const provider = fakeProvider();
  const template = tpl({ auto_enabled_at: new Date(NOW - 3 * HOUR).toISOString() }); // 켠 날 = 오늘
  const out = await go(db, provider, template);
  assert.equal(out.sent, 1);
  assert.deepEqual(provider.calls.kakao[0].messages.map(m => m.variables.고객명), ['오늘']);
  assert.match(db.state.sends[0].dedupe_key, /^[0-9a-f]{64}:order$/);
  assert.equal((await go(db, provider, template)).claimed, 0);
});

test('S2: 출고 후 0일은 여전히 대상 없음(기존 days>=1 규칙 유지)', async () => {
  const db = fakeDb({ shipped: [{ id: 4, phone: '010-1111-2222', client_name: '가', ship_date: '2026-11-20', status: 'shipped' }] }); const provider = fakeProvider();
  const out = await go(db, provider, tpl({ auto_kind: 'ship_plus_days', auto_days: 0 }));
  assert.equal(out.targets, 0);
  assert.equal(provider.calls.kakao.length, 0);
});

test('기존 ship_plus_days 3일(출고일+3 = 오늘)은 그대로 나간다', async () => {
  const db = fakeDb({ shipped: [{ id: 5, phone: '010-1111-2222', client_name: '가나다', ship_date: '2026-11-17', status: 'shipped' }] }); const provider = fakeProvider();
  const out = await go(db, provider, tpl({ auto_kind: 'ship_plus_days', auto_days: 3 }));
  assert.equal(out.sent, 1);
  assert.match(db.state.sends[0].dedupe_key, /^[0-9a-f]{64}:ship$/);
});

test('기존 due_date(납기일) 문자 발송은 그대로 나간다', async () => {
  const row = { id: 7, phone: '010-1111-2222', client_name: '가나다', order_date: '2026-11-10', due_date: '2026-11-20', quantity: 1 };
  const db = fakeDb({ dueRows: [row] }); const provider = fakeProvider();
  const out = await go(db, provider, tpl({ auto_kind: 'due_date', auto_days: 0, auto_ata_template: '', body: '#{주문번호} 안내' }));
  assert.equal(out.sent, 1); assert.equal(provider.calls.each.length, 1);
});

test('S3: auto_chain.plain 이면 주문 변수 없는 문자 안내도 나가고, plain 이 아니면 info_check 로 막힌다(다른 검사는 유지)', async () => {
  const row = { id: 7, phone: '010-1111-2222', client_name: '가나다', order_date: '2026-11-20' };
  const mk = extra => tpl({ auto_ata_template: '', auto_kind: 'due_date', body: '한성쇼케이스 주의사항 안내', ...extra });
  const dueRows = [{ ...row, due_date: '2026-11-20', quantity: 1 }];
  const blockedDb = fakeDb({ dueRows }); const p0 = fakeProvider();
  assert.equal((await go(blockedDb, p0, mk())).reason, 'info_check'); assert.equal(p0.calls.each.length, 0);
  const db = fakeDb({ dueRows }); const provider = fakeProvider();
  const out = await go(db, provider, mk({ auto_chain: { subject: '', from: '', plain: true } }));
  assert.equal(out.sent, 1); assert.equal(provider.calls.each.length, 1);
  const unknown = fakeDb({ dueRows }); const p2 = fakeProvider();
  assert.equal((await go(unknown, p2, mk({ body: '#{모르는변수} 안내', auto_chain: { plain: true } }))).reason, 'info_check');
});

test('S5: lead N=5 는 접수 5~10일 전이 대상, 11일 전·4일 전은 제외, 이미 보낸 접수는 제외', async () => {
  const db = fakeDb(); const provider = fakeProvider();
  const template = tpl({ auto_kind: 'lead_plus_days', auto_days: 5, auto_enabled_at: new Date(NOW - 30 * 24 * HOUR).toISOString() });
  await lead(db, 'n', '010-1000-0001', day(5), '엔'); // N일 전
  await lead(db, 'm', '010-1000-0002', day(8), '중간'); // N+3일 전
  await lead(db, 'e', '010-1000-0003', day(10), '끝'); // N+5일 전
  await lead(db, 'x', '010-1000-0004', day(11), '밖'); // N+6일 전: 제외
  await lead(db, 'y', '010-1000-0005', day(4), '아직'); // N−1일 전: 아직 아님
  const out = await go(db, provider, template);
  assert.equal(out.claimed, 3);
  assert.deepEqual(provider.calls.kakao[0].messages.map(m => m.variables.고객명).sort(), ['끝', '엔', '중간']);
  assert.equal((await go(db, provider, template)).claimed, 0); // 이미 보낸 접수는 다시 안 나간다
  await lead(db, 'z', '010-1000-0006', day(6), '추가'); // 새로 보이게 된 접수 1건만 나간다
  assert.equal((await go(db, provider, template)).claimed, 1);
});

test('S5: 켠 날 이전에 이미 지난 접수(접수일+N 이 켠 날보다 앞)는 보내지 않는다', async () => {
  const db = fakeDb(); const provider = fakeProvider();
  const template = tpl({ auto_kind: 'lead_plus_days', auto_days: 5, auto_enabled_at: new Date(NOW - 3 * HOUR).toISOString() }); // 켠 날 = 오늘
  await lead(db, 'old', '010-1000-0001', day(8)); // 접수일+5 = 3일 전 < 켠 날
  await lead(db, 'ok', '010-1000-0002', day(5)); // 접수일+5 = 오늘
  const out = await go(db, provider, template);
  assert.equal(out.claimed, 1);
});

test('기존 lead N=0 은 [켠 시각, 지금] 창 그대로', async () => {
  const db = fakeDb(); const provider = fakeProvider();
  await lead(db, 'a', '010-1111-2222', NOW - HOUR, '가나다');
  await lead(db, 'b', '010-3333-4444', NOW - 5 * HOUR);
  const out = await go(db, provider, tpl({ auto_kind: 'lead_plus_days', auto_days: 0, auto_enabled_at: new Date(NOW - 3 * HOUR).toISOString() }));
  assert.equal(out.claimed, 1);
});
