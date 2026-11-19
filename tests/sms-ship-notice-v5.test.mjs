// 2026-11-19 설계 v5 S6~S9 시험: 출고알림톡(Make 5921172)을 콘솔이 같은 대상·시각으로 보내게 하는 once 모드·영업담당 필터·쉬는 요일·auto_mark_sent(order_ids).
// 가짜 db·가짜 발송기만 쓴다(실제 발송·운영 호출 없음). 값은 모두 가짜.
import assert from 'node:assert/strict';
import test from 'node:test';
import { _resetAutoSchemaForTest, autoMarkSent } from '../api/_lib/smsAutoSend.js';
import { _resetTextTemplateSchemaForTest, parseAutoChain } from '../api/_lib/smsTextTemplates.js';
import { _resetEventSchemaForTest, runEventSend } from '../api/_lib/smsEventSend.js';
import { runTimedSendAll } from '../api/_lib/smsAutoSend.js';
import { autoTargetText, dirDaily, offsetParts } from '../src/components/smsconsole/smsTextTemplateFormModel.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db';
const ENV = { SMS_SENDER: '0212345678' };
const BODY = '#{고객명}님, 출고 일정 안내입니다.';
const kst = (date, hhmm = '10:05') => Date.parse(`${date}T${hhmm}:00+09:00`);
const THU = kst('2026-11-19'); // 목
const SUN = kst('2026-11-22'); // 일
const MON = kst('2026-11-23'); // 월

// orders: { id, phone, due_date, sales_person, status, client_name }. 후보 조회는 SQL 과 같은 조건(상태·기준일 범위·영업담당)을 args 로 다시 적용한다.
function fakeDb({ orders = [], templates = {} } = {}) {
  const state = { sends: [], nextId: 1, sql: [] };
  return {
    state,
    async execute({ sql, args = [] }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      state.sql.push(t);
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT conname FROM pg_constraint')) return { rows: [] };
      if (t.startsWith('SELECT phone_hash FROM sms_optouts')) return { rows: [] };
      if (t.startsWith('SELECT id, name, body, image, images, auto_kind, auto_enabled, auto_offset')) { const row = templates[args[0]]; return { rows: row ? [{ id: args[0], name: '출고일정 안내', ...row }] : [] }; }
      if (t.startsWith('SELECT id, name, body, image, images, auto_kind, auto_days, auto_enabled, auto_start_date')) { const row = templates[args[0]]; return { rows: row ? [{ id: args[0], name: '출고일정 안내', ...row }] : [] }; }
      if (t.startsWith('SELECT id, auto_kind, auto_send_time FROM sms_text_templates')) return { rows: Object.entries(templates).filter(([, r]) => r.auto_enabled && r.auto_send_time).map(([id, r]) => ({ id: Number(id), auto_kind: r.auto_kind, auto_send_time: r.auto_send_time })) };
      if (t.includes("FROM orders o WHERE o.status = 'in_production'")) {
        assert.ok(!t.includes('base_date') || t.includes('LEFT(o.due_date, 10) AS base_date'));
        const hasRange = t.includes('>= ? AND LEFT(o.due_date, 10) <= ?');
        const hasEq = !hasRange && t.includes('LEFT(o.due_date, 10) = ?');
        const [a, b, c] = args;
        const sales = t.includes('o.sales_person = ?') ? args[args.length - 1] : null;
        void c;
        const rows = orders.filter(o => o.status === 'in_production' && o.due_date
          && (hasRange ? (o.due_date.slice(0, 10) >= a && o.due_date.slice(0, 10) <= b) : (hasEq ? o.due_date.slice(0, 10) === a : true))
          && (sales === null || o.sales_person === sales));
        return { rows: rows.map(o => ({ ...o, base_date: o.due_date.slice(0, 10) })) };
      }
      if (t.includes('FROM orders o WHERE o.id IN')) {
        const ids = args.map(Number);
        return { rows: orders.filter(o => ids.includes(o.id) && o.due_date).map(o => ({ ...o, base_date: o.due_date.slice(0, 10) })) };
      }
      if (t.startsWith('SELECT id, track_token FROM orders')) return { rows: [] };
      if (t.startsWith('SELECT dedupe_key FROM sms_event_sends WHERE template_id = ? AND dedupe_key IN')) return { rows: state.sends.filter(r => r.template_id === args[0] && args.slice(1).includes(r.dedupe_key)).map(r => ({ dedupe_key: r.dedupe_key })) };
      if (t.startsWith('SELECT dedupe_key FROM sms_event_sends WHERE template_id = ?')) return { rows: state.sends.filter(r => r.template_id === args[0]).map(r => ({ dedupe_key: r.dedupe_key })) };
      if (t.startsWith('SELECT id, dedupe_key FROM sms_event_sends WHERE template_id = ? AND status')) return { rows: [] };
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_event_sends WHERE kst_date = ?')) return { rows: [{ n: 0 }] };
      if (t.startsWith('INSERT INTO sms_event_sends') && t.includes('make_migrated')) {
        const rows = [];
        for (let i = 0; i < args.length; i += 5) {
          const [template_id, dedupe_key, phone_hash, , kst_date] = args.slice(i, i + 5);
          if (state.sends.some(r => r.template_id === template_id && r.dedupe_key === dedupe_key)) continue;
          const row = { id: state.nextId++, template_id, dedupe_key, phone_hash, kst_date, status: 'sent', reason: 'make_migrated' };
          state.sends.push(row); rows.push({ id: row.id, fresh: true });
        }
        return { rows };
      }
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
const fakeKakao = () => ({ async getBalance() { return 100000; }, async getTemplateFresh() { return { raw: { channelId: 'PF1' }, template: { status: 'APPROVED', variables: ['#{업체명}'], content: '#{업체명}' }, scope: { allowed: true, kind: 'channel' } }; } });
const reset = () => { _resetEventSchemaForTest(); _resetAutoSchemaForTest(); _resetTextTemplateSchemaForTest(); };
const CHAIN = { sales: '이준형', days_off: ['sun'] };
const tpl = (extra = {}) => ({ id: 90, name: '출고일정 안내(납기 5일 전 10:00)', body: BODY, images: [], auto_kind: 'due_date', auto_enabled: true, auto_offset: -5, auto_daily: 'once', auto_weekdays: false, auto_send_time: '10:00', auto_ata_template: 'KA01TP260812073741858iPCG0dqPx6Z', auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_unless_step: '', auto_step: '', auto_days: 0, auto_chain: CHAIN, ...extra });
const go = (db, provider, template, nowMs) => { reset(); return runEventSend(template, { db, provider, env: ENV, nowMs, warn() {}, kakao: fakeKakao() }); };
const ord = (id, due, extra = {}) => ({ id, phone: `010-1000-${String(1000 + id)}`, client_name: `업체${id}`, status: 'in_production', sales_person: '이준형', due_date: due, quantity: 1, ...extra });
const names = provider => provider.calls.kakao.flatMap(c => c.messages.map(m => m.variables.업체명)).sort();

test('S6 once: 오늘 ≤ 납기 ≤ 오늘+5 인 제작 중 주문이 대상이고 납기 지난 주문·6일 뒤 주문은 제외', async () => {
  const db = fakeDb({ orders: [ord(1, '2026-11-24'), ord(2, '2026-11-19'), ord(3, '2026-11-18'), ord(4, '2026-11-25'), ord(5, '2026-11-21', { status: 'completed' })] });
  const provider = fakeProvider();
  const out = await go(db, provider, tpl(), THU);
  assert.equal(out.sent, 2);
  assert.deepEqual(names(provider), ['업체1', '업체2']);
  assert.equal(provider.calls.kakao[0].messages[0].variables.고객명, provider.calls.kakao[0].messages[0].variables.업체명); // 업체명 = client_name
});

test('S6 once: 월요일에는 금요일 납기(D-4)도 같이 나가고, 같은 주문은 다음 날 다시 나가지 않으며 새로 범위에 든 주문만 나간다', async () => {
  const orders = [ord(10, '2026-11-27'), ord(11, '2026-11-28'), ord(12, '2026-11-22'), ord(13, '2026-11-29')];
  const db = fakeDb({ orders });
  const provider = fakeProvider();
  const mon = await go(db, provider, tpl(), MON);
  assert.equal(mon.sent, 2); // 금(D-4)·토(D-5). 일요일 납기(D-1 이미 지난 일요일)는 납기가 오늘 이전이라 제외, 29일은 D-6
  assert.deepEqual(names(provider), ['업체10', '업체11']);
  assert.equal((await go(db, provider, tpl(), MON)).claimed, 0); // 같은 날 다시
  const tue = await go(db, provider, tpl(), kst('2026-11-24')); // 화: 29일(D-5)만 새로 들어옴
  assert.equal(tue.sent, 1);
  assert.deepEqual(names(provider), ['업체10', '업체11', '업체13']);
  assert.ok(db.state.sends.every(r => /^[0-9a-f]{64}:\d+:2026-11-\d{2}$/.test(r.dedupe_key))); // 키 끝 = 주문의 납기일(오늘이 아니다)
});

test('S6 기존 daily until·빈 값은 그대로: until 은 키 끝이 오늘이라 다음 날 다시 나가고, 빈 값은 기준일 하루만 본다', async () => {
  const orders = [ord(20, '2026-11-24')];
  const dbU = fakeDb({ orders });
  const pU = fakeProvider();
  await go(dbU, pU, tpl({ auto_daily: 'until', auto_chain: null }), THU);
  await go(dbU, pU, tpl({ auto_daily: 'until', auto_chain: null }), kst('2026-11-20'));
  assert.equal(pU.calls.kakao.length, 2);
  assert.ok(dbU.state.sends.map(r => r.dedupe_key.split(':').pop()).includes('2026-11-19'));
  const dbN = fakeDb({ orders });
  const pN = fakeProvider();
  assert.equal((await go(dbN, pN, tpl({ auto_daily: '', auto_chain: null }), THU)).sent, 1); // 기준일(11-24) = 오늘+5
  assert.equal((await go(dbN, pN, tpl({ auto_daily: '', auto_chain: null }), kst('2026-11-20'))).targets, 0);
  assert.ok(dbN.state.sends[0].dedupe_key.endsWith(':2026-11-24'));
});

test('S7 sales 필터: 다른 담당 주문은 제외되고, sales 가 없는 문구는 담당과 무관하게 모두 대상', async () => {
  const orders = [ord(30, '2026-11-24'), ord(31, '2026-11-24', { sales_person: '다른사람' }), ord(32, '2026-11-24', { sales_person: '' })];
  const provider = fakeProvider();
  const out = await go(fakeDb({ orders }), provider, tpl({ auto_chain: { sales: '이준형' } }), THU);
  assert.equal(out.sent, 1);
  assert.deepEqual(names(provider), ['업체30']);
  const all = fakeProvider();
  assert.equal((await go(fakeDb({ orders }), all, tpl({ auto_chain: null }), THU)).sent, 3);
});

test('S8 days_off sun: 일요일은 대상 0(발송 없음), 토요일은 돌고, 다음 월요일에 놓친 건이 나간다', async () => {
  const orders = [ord(40, '2026-11-27'), ord(41, '2026-11-26')];
  const db = fakeDb({ orders });
  const provider = fakeProvider();
  const sun = await go(db, provider, tpl(), SUN);
  assert.equal(sun.targets, 0); assert.equal(provider.calls.kakao.length, 0);
  const sat = await go(db, provider, tpl(), kst('2026-11-21'));
  assert.equal(sat.sent, 1); // 토요일에는 돈다: 11-26(D-5)만, 11-27 은 D-6 이라 제외
  assert.ok(true);
});

test('S8 days_off 가 없는 문구는 일요일에도 돈다(기존 동작)', async () => {
  const provider = fakeProvider();
  const out = await go(fakeDb({ orders: [ord(50, '2026-11-27')] }), provider, tpl({ auto_chain: { sales: '이준형' } }), SUN);
  assert.equal(out.sent, 1);
});

test('S9 auto_mark_sent order_ids: 표시 키가 발송 후보 키와 같아서 표시한 주문은 대상에서 빠지고 나머지만 나간다', async () => {
  const orders = [ord(60, '2026-11-24'), ord(61, '2026-11-21'), ord(62, '2026-11-23')];
  // 후보 키(기준): 표시 없이 한 번 보낸 db 의 키
  const ref = fakeDb({ orders });
  await go(ref, fakeProvider(), tpl(), THU);
  const candidateKeys = ref.state.sends.map(r => r.dedupe_key).sort();
  assert.equal(candidateKeys.length, 3);
  const templates = { 90: { ...tpl(), auto_chain: JSON.stringify(CHAIN), images: '[]', image: null, auto_start_date: '' } };
  const db = fakeDb({ orders, templates });
  reset();
  const out = await autoMarkSent({ template_id: 90, order_ids: [60, 62, 9999] }, { db });
  assert.equal(out.status, 200);
  assert.equal(out.body.via, 'event'); assert.equal(out.body.by_order_ids, true);
  assert.equal(out.body.inserted, 2); assert.equal(out.body.no_order, 1);
  const marked = db.state.sends.map(r => r.dedupe_key).sort();
  assert.deepEqual(marked, candidateKeys.filter(key => /:(60|62):/.test(key)));
  assert.ok(db.state.sends.every(r => r.reason === 'make_migrated' && r.kst_date === '1970-01-01'));
  const provider = fakeProvider();
  const run = await go(db, provider, tpl(), THU);
  assert.equal(run.sent, 1);
  assert.deepEqual(names(provider), ['업체61']); // 표시한 주문은 빠진다
  const again = await autoMarkSent({ template_id: 90, order_ids: [60, 62] }, { db }); // 다시 표시해도 중복 없음
  assert.equal(again.body.inserted, 0); assert.equal(again.body.skipped, 2);
});

test('S9 order_ids 는 once 문구에서만: 다른 daily 값 문구는 unsupported_kind, 잘못된 번호는 400, phones 입력은 종전 그대로', async () => {
  const templates = { 91: { ...tpl({ auto_daily: 'until' }), auto_chain: null, images: '[]', image: null, auto_start_date: '' }, 90: { ...tpl(), auto_chain: null, images: '[]', image: null, auto_start_date: '' } };
  const db = fakeDb({ orders: [ord(70, '2026-11-24')], templates });
  reset();
  assert.equal((await autoMarkSent({ template_id: 91, order_ids: [70] }, { db })).body.error, 'unsupported_kind');
  assert.equal((await autoMarkSent({ template_id: 90, order_ids: ['x'] }, { db })).status, 400);
  assert.equal((await autoMarkSent({ template_id: 90, order_ids: [] }, { db })).status, 400);
  assert.equal((await autoMarkSent({ template_id: 90 }, { db })).status, 400); // phones 도 order_ids 도 없음
  assert.equal((await autoMarkSent({ template_id: 91, phones: ['01011112222'] }, { db })).body.error, 'unsupported_kind'); // 종전: 납기 문구 번호 표시는 거절
});

test('10:00 경로: 시각 10:00 알림톡 once 문구는 5분 크론(runTimedSendAll)이 10:00 전에는 안 보내고 10:00 이후 첫 실행에 보낸다', async () => {
  const row = { ...tpl(), auto_chain: JSON.stringify(CHAIN), auto_enabled_at: new Date(THU - 3 * 86400000).toISOString(), images: '[]', image: null };
  const db = fakeDb({ orders: [ord(80, '2026-11-24')], templates: { 90: row } });
  const provider = fakeProvider();
  const run = nowMs => { reset(); return runTimedSendAll({ db, provider, env: ENV, nowMs, warn() {}, kakao: fakeKakao() }); };
  assert.equal((await run(kst('2026-11-19', '09:55'))).claimed, 0);
  assert.equal(provider.calls.kakao.length, 0);
  assert.equal((await run(kst('2026-11-19', '10:00'))).sent, 1);
  assert.equal((await run(kst('2026-11-19', '10:05'))).claimed, 0); // 같은 날 다시 돌아도 중복 없음
  assert.equal(provider.calls.kakao.length, 1);
});

test('parseAutoChain: sales·days_off 를 읽고, 예전 모양({ subject, from, plain })은 키가 늘지 않고 그대로', () => {
  assert.deepEqual(parseAutoChain({ sales: ' 이준형 ', days_off: ['sun', 'sun', 'xxx'] }), { subject: '', from: '', plain: false, sales: '이준형', days_off: ['sun'] });
  assert.deepEqual(parseAutoChain('{"plain":true,"subject":"안내","from":"0319862458"}'), { subject: '안내', from: '0319862458', plain: true });
  assert.deepEqual(parseAutoChain({ after: 5, subject: '', from: '', plain: false }), { after: 5, subject: '', from: '', plain: false });
  assert.equal(parseAutoChain({ days_off: ['xxx'] }), null);
  assert.equal(parseAutoChain({ days_off: 'sun' }), null);
});

test('화면 문구: once·sales·days_off 가 대상 줄에 나오고, 폼은 저장된 once 를 편집해도 잃지 않는다', () => {
  const text = autoTargetText({ autoKind: 'due_date', autoOffset: -5, autoDaily: 'once', autoSales: '이준형', autoDaysOff: ['sun'], autoSendTime: '10:00' });
  assert.equal(text, '주문 상태 제작 중 · 이준형 담당 · 납기일 5일 전 10:00(일요일 쉼, 놓친 건 납기일 전까지 1회) · 번호·주문당 1번');
  // 종전 문구(until/ongoing/빈 값)의 표시 줄은 그대로
  assert.equal(autoTargetText({ autoKind: 'due_date', autoOffset: -3, autoDaily: 'until' }), '주문 상태 제작 중 · 납기일 3일 전부터 당일까지 매일=오늘 · 번호·주문당 하루 1번');
  assert.equal(autoTargetText({ autoKind: 'due_date', autoOffset: -3, autoDaily: '' }), '주문 상태 제작 중 · 납기일 3일 전=오늘 · 번호·주문당 1번');
  assert.equal(offsetParts(-5, 'once').daily, 'once');
  assert.equal(dirDaily('before', 'once'), 'once');
  assert.equal(dirDaily('before', true), 'until'); assert.equal(dirDaily('after', true), 'ongoing'); assert.equal(dirDaily('before', false), '');
});
