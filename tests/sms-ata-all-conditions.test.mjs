// 모든 자동 발송 조건에서 알림톡 수단 + 출고 완료 후 알림톡의 '이미 출고된 주문 1회 발송(따라잡기)'. 가짜 db·가짜 발송기만 쓴다(실제 발송 없음). 값은 모두 가짜.
import assert from 'node:assert/strict';
import test from 'node:test';
import { _resetAutoSchemaForTest, phoneHash, runAutoSend } from '../api/_lib/smsAutoSend.js';
import { ATA_CONDITIONS, _resetTextTemplateSchemaForTest, isAtaTemplate, isInfoTemplate, readCatchup, saveTextTemplate } from '../api/_lib/smsTextTemplates.js';
import { _resetEventSchemaForTest, catchupActive, catchupPreview, eventToggleOn, runEventSend, runInstantSendAll } from '../api/_lib/smsEventSend.js';
import { AUTO_KINDS, autoConditionLine, buildSaveBody, isAdKind, validateTextForm, textFormStopText } from '../src/components/smsconsole/smsTextTemplateFormModel.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db';
const NOW = Date.parse('2026-11-20T01:00:00Z'); // KST 11-20 10:00
const HOUR = 3600000;
const DAY = 86400000;
const ENV = { SMS_SENDER: '0212345678' };
const BODY = '#{고객명}님, 구글 리뷰 안내드립니다.';

function fakeDb({ orders = [], dueRows = [], createdRows = [], orderDay = [], optouts = [], templates = [] } = {}) {
  const state = { sends: [], nextId: 1, sql: [], done: [] };
  return {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      state.sql.push(t);
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT conname FROM pg_constraint')) return { rows: [] };
      if (t.startsWith('SELECT phone_hash FROM sms_optouts')) return { rows: optouts.map(hash => ({ phone_hash: hash })) };
      if (t.includes("FROM orders WHERE status = 'shipped'")) return { rows: orders.filter(o => o.status === 'shipped' && o.ship_date.slice(0, 10) >= args[0] && o.ship_date.slice(0, 10) <= args[1]).sort((a, b) => a.ship_date.localeCompare(b.ship_date) || a.id - b.id).map(o => ({ id: o.id, phone: o.phone, client_name: o.client_name, ship_day: o.ship_date.slice(0, 10) })) };
      if (t.includes('FROM orders WHERE order_date IS NOT NULL')) return { rows: orderDay.filter(o => o.order_date.slice(0, 10) >= args[0] && o.order_date.slice(0, 10) <= args[1]).map(o => ({ id: o.id, phone: o.phone, client_name: o.client_name, ship_day: o.order_date.slice(0, 10) })) };
      if (t.includes("FROM orders o WHERE o.status = 'in_production'")) return { rows: dueRows };
      if (t.includes('FROM orders o WHERE o.created_at >=')) return { rows: createdRows };
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
      if (t.startsWith('UPDATE sms_event_sends SET status = ?')) { const [status, , , , ...ids] = args; for (const r of state.sends.filter(x => ids.includes(x.id))) r.status = status; return { rows: [] }; }
      if (t.startsWith("UPDATE sms_event_sends SET status = 'uncertain'")) return { rows: [] };
      if (t.startsWith('UPDATE sms_text_templates SET auto_catchup_done_at = NOW()')) { state.done.push(args[0]); return { rows: [{ id: args[0] }] }; }
      if (t.startsWith('SELECT id FROM sms_text_templates WHERE auto_enabled = true')) return { rows: templates.map(row => ({ id: row.id })) };
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
  return { calls, async uploadImage() { return { fileId: 'F1' }; }, async sendEach(input) { calls.each.push(input); return ok(input); }, async sendKakaoEach(input) { calls.kakao.push(input); return ok(input); }, estimateKakao: ({ count }) => ({ unit: 13, total: 13 * count }) };
}
const fakeKakao = (over = {}, balance = 100000) => ({ async getBalance() { return balance; }, async getTemplateFresh() { return { raw: { channelId: 'PF1' }, template: { status: 'APPROVED', variables: ['#{고객명}'], content: '#{고객명}님' }, scope: { allowed: true, kind: 'channel' }, ...over }; } });
const reset = () => { _resetEventSchemaForTest(); _resetAutoSchemaForTest(); _resetTextTemplateSchemaForTest(); };
const base = (extra = {}) => ({ id: 31, name: '리뷰 안내', body: BODY, images: [], auto_kind: 'ship_plus_days', auto_enabled: true, auto_days: 3, auto_ata_template: 'KA01TP1', auto_enabled_at: new Date(NOW - 3 * HOUR).toISOString(), auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_offset: 0, auto_unless_step: '', auto_daily: '', auto_weekdays: false, auto_unless_mode: 'completed', auto_step: '', auto_send_time: '', auto_start_date: '', auto_send_from: '', auto_repeat: 1, auto_interval: 30, auto_catchup_from: '', auto_catchup_at: '', auto_catchup_done: false, ...extra });
const catchupTpl = (extra = {}) => base({ auto_catchup_from: '2026-10-01', auto_catchup_at: '2026-11-20T09:00', ...extra });
const order = (id, phone, shipDate, name = '', status = 'shipped') => ({ id, phone, ship_date: shipDate, client_name: name, status });
const go = (db, provider, template, extra = {}) => { reset(); return runAutoSend(template, { db, provider, env: ENV, nowMs: NOW, kakao: fakeKakao(), ...extra }); };

// ---------- A. 조건 전체 점검표: 조건마다 알림톡 저장 검증 ----------
const KIND_AUTO = {
  member_joined: {},
  lead_plus_days: { days: 2 },
  order_created: {},
  order_plus_days: { days: 3 },
  process_started: { step: '도면설계' },
  process_completed: { step: '포장' },
  ship_plus_days: { days: 3 },
  due_date: { offset: -2 },
  ship_scheduled: { offset: 0 },
  ship_or_due: { offset: 1 },
};

test('점검표: 화면의 모든 자동 발송 조건(10종)이 알림톡 가능 목록과 일치한다', () => {
  assert.deepEqual(Object.keys(KIND_AUTO).sort(), [...AUTO_KINDS].sort());
  assert.deepEqual(Object.keys(ATA_CONDITIONS).sort(), [...AUTO_KINDS].sort());
});

for (const [kind, extra] of Object.entries(KIND_AUTO)) {
  test(`저장: ${kind} + 알림톡 → 정보성·고객 고정·알림톡 칸 저장, 주문 변수·잘못된 id·직원 수신은 거절`, async () => {
    const saved = [];
    const db = saveDb(saved);
    reset();
    const ok = await saveTextTemplate(db, { name: `a-${kind}`, body: BODY, auto: { kind, ...extra, ata_template: 'KA01TP1' } }, { staff: [] });
    assert.equal(ok.status, 201, JSON.stringify(ok.body));
    assert.deepEqual([saved[0].auto_msg_type, saved[0].auto_ata_template, saved[0].auto_audience], ['info', 'KA01TP1', 'customer']);
    assert.equal(ok.body.item.auto_ata_template, 'KA01TP1');
    assert.equal(isInfoTemplate({ auto_kind: kind, auto_ata_template: 'KA01TP1' }), true);
    assert.equal(isAtaTemplate({ auto_kind: kind, auto_ata_template: 'KA01TP1' }), true);
    assert.equal(isAtaTemplate({ auto_kind: kind, auto_ata_template: '' }), false);
    const orderVar = await saveTextTemplate(db, { name: `b-${kind}`, body: '#{주문번호} 안내', auto: { kind, ...extra, ata_template: 'KA01TP1' } }, { staff: [] });
    assert.equal(orderVar.status, 400); assert.equal(orderVar.body.reason, 'info_unknown_var');
    assert.equal((await saveTextTemplate(db, { name: `c-${kind}`, body: BODY, auto: { kind, ...extra, ata_template: 'bad id!' } }, { staff: [] })).status, 400);
    if (kind !== 'member_joined' && kind !== 'lead_plus_days' && !['order_plus_days', 'ship_plus_days'].includes(kind)) {
      const staff = await saveTextTemplate(db, { name: `d-${kind}`, body: BODY, auto: { kind, ...extra, audience: 'staff', staff: ['s1'], ata_template: 'KA01TP1' } }, { staff: [{ id: 's1', name: '직원', phone: '01099998888' }] });
      assert.equal(staff.status, 400); assert.equal(staff.body.reason, 'ata_customer_only');
    }
  });
}

test('저장: 문자로 고르면 모든 조건이 지금과 같다(알림톡 칸 빈 값), 주문 변수·직원 수신도 그대로', async () => {
  const saved = [];
  const db = saveDb(saved);
  reset();
  const orderVar = await saveTextTemplate(db, { name: 'a', body: '#{주문번호} 안내', auto: { kind: 'due_date', offset: -1 } }, { staff: [] });
  assert.equal(orderVar.status, 201); assert.deepEqual([saved[0].auto_msg_type, saved[0].auto_ata_template], ['info', '']);
  const staff = await saveTextTemplate(db, { name: 'b', body: '#{주문번호} 안내', auto: { kind: 'process_completed', step: '포장', audience: 'staff', staff: ['s1'] } }, { staff: [{ id: 's1', name: '직원', phone: '01099998888' }] });
  assert.equal(staff.status, 201); assert.equal(saved[1].auto_audience, 'staff');
  const ad = await saveTextTemplate(db, { name: 'c', body: '(광고) #{고객명}님\n무료수신거부 080-500-4233', auto: { kind: 'order_plus_days', days: 3 } }, { staff: [] });
  assert.equal(ad.status, 201); assert.deepEqual([saved[2].auto_msg_type, saved[2].auto_ata_template], ['ad', '']);
});

test('저장: 이미 출고된 주문 1회 발송(catchup)은 출고 완료 후 + 알림톡에서만 저장되고 형식이 틀리면 거절, 다른 조건·문자는 칸이 빈 값', async () => {
  const saved = [];
  const db = saveDb(saved);
  reset();
  const ok = await saveTextTemplate(db, { name: 'a', body: BODY, auto: { kind: 'ship_plus_days', days: 2, ata_template: 'KA01TP1', catchup: { from: '2026-10-01', at: '2026-11-21T09:00' } } }, { staff: [] });
  assert.equal(ok.status, 201);
  assert.deepEqual([saved[0].auto_catchup_from, saved[0].auto_catchup_at], ['2026-10-01', '2026-11-21T09:00']);
  assert.deepEqual([ok.body.item.auto_catchup_from, ok.body.item.auto_catchup_at, ok.body.item.auto_catchup_done], ['2026-10-01', '2026-11-21T09:00', false]);
  for (const [i, catchup] of [{ from: '2026-13-01', at: '2026-11-21T09:00' }, { from: '2026-10-01', at: '2026-11-21T07:00' }, { from: '2026-10-01', at: '2026-11-21T21:00' }, { from: '2026-10-01', at: '2026-11-21 09:00' }, { from: '2026-10-01' }].entries()) {
    const bad = await saveTextTemplate(db, { name: `bad${i}`, body: BODY, auto: { kind: 'ship_plus_days', days: 2, ata_template: 'KA01TP1', catchup } }, { staff: [] });
    assert.equal(bad.status, 400, JSON.stringify(catchup)); assert.match(bad.body.reason, /^catchup_/);
  }
  const off = await saveTextTemplate(db, { name: 'off', body: BODY, auto: { kind: 'ship_plus_days', days: 2, ata_template: 'KA01TP1' } }, { staff: [] });
  assert.equal(off.status, 201); assert.deepEqual([saved.at(-1).auto_catchup_from, saved.at(-1).auto_catchup_at], ['', '']); assert.equal('auto_catchup_at' in off.body.item, false);
  const other = await saveTextTemplate(db, { name: 'other', body: BODY, auto: { kind: 'order_plus_days', days: 2, ata_template: 'KA01TP1', catchup: { from: '2026-10-01', at: '2026-11-21T09:00' } } }, { staff: [] });
  assert.equal(other.status, 201); assert.deepEqual([saved.at(-1).auto_catchup_from, saved.at(-1).auto_catchup_at], ['', '']);
});

// ---------- A. 조건별 발송: 대상 조회는 문자 갈래 그대로, 발송만 알림톡 ----------
test('발송: 날짜 기준(납기일) + 알림톡 → 같은 대상 조회로 알림톡(문자 대체 끔), 변수는 고객명, 중복 키 재사용', async () => {
  const row = { id: 7, phone: '010-1111-2222', client_name: '가나다', order_date: '2026-11-10', due_date: '2026-11-20', quantity: 1 };
  const db = fakeDb({ dueRows: [row] }); const provider = fakeProvider();
  const tpl = base({ auto_kind: 'due_date', auto_days: 0, auto_offset: 0 });
  const out = await go(db, provider, tpl);
  assert.equal(out.sent, 1);
  assert.equal(provider.calls.each.length, 0);
  assert.deepEqual(provider.calls.kakao[0], { from: '0212345678', pfId: 'PF1', disableSms: true, messages: [{ to: '01011112222', templateId: 'KA01TP1', variables: { 고객명: '가나다' } }] });
  assert.equal((await go(db, provider, tpl)).claimed, 0);
});

test('발송: 즉시형(주문 등록 시) + 알림톡, 주문 등록 후 + 알림톡 — 이름이 없으면 고객', async () => {
  const created = fakeDb({ createdRows: [{ id: 8, phone: '010-3333-4444', client_name: '', order_date: '2026-11-20' }] }); const p1 = fakeProvider();
  const a = await go(created, p1, base({ auto_kind: 'order_created', auto_days: 0 }));
  assert.equal(a.sent, 1); assert.deepEqual(p1.calls.kakao[0].messages[0].variables, { 고객명: '고객' });
  const orderDay = fakeDb({ orderDay: [{ id: 9, phone: '010-5555-6666', client_name: '다라마', order_date: '2026-11-17' }] }); const p2 = fakeProvider();
  const b = await go(orderDay, p2, base({ auto_kind: 'order_plus_days', auto_days: 3 }));
  assert.equal(b.sent, 1); assert.deepEqual(p2.calls.kakao[0].messages[0], { to: '01055556666', templateId: 'KA01TP1', variables: { 고객명: '다라마' } });
  assert.match(orderDay.state.sends[0].dedupe_key, /^[0-9a-f]{64}:order$/);
  assert.equal(p2.calls.each.length, 0);
});

test('발송: 알림톡이 승인 전이거나 받는 사람이 고객이 아니면 선점 0, 문자로 두면 문자 발송기(sendEach)를 쓴다', async () => {
  const row = { id: 7, phone: '010-1111-2222', client_name: '가나다', order_date: '2026-11-10', due_date: '2026-11-20', quantity: 1 };
  const db = fakeDb({ dueRows: [row] }); const provider = fakeProvider();
  const notReady = await go(db, provider, base({ auto_kind: 'due_date', auto_days: 0 }), { kakao: fakeKakao({ template: { status: 'PENDING', variables: [] } }) });
  assert.equal(notReady.reason, 'ata_not_ready'); assert.equal(db.state.sends.length, 0);
  const staff = await go(db, provider, base({ auto_kind: 'due_date', auto_days: 0, auto_audience: 'staff', auto_staff: ['s1'] }), { staff: [{ id: 's1', name: '직원', phone: '01099998888' }] });
  assert.equal(staff.reason, 'info_check'); assert.equal(provider.calls.kakao.length, 0);
  const sms = await go(db, provider, base({ auto_kind: 'due_date', auto_days: 0, auto_ata_template: '', body: '#{주문번호} 안내' }));
  assert.equal(sms.sent, 1); assert.equal(provider.calls.each.length, 1); assert.equal(provider.calls.kakao.length, 0);
});

test('켜기: 모든 조건에서 알림톡 승인·변수가 맞아야 켜지고(미승인이면 거절), 미리보기 비용은 알림톡 단가', async () => {
  const row = { id: 7, phone: '010-1111-2222', client_name: '가나다', order_date: '2026-11-10', due_date: '2026-11-20', quantity: 1 };
  const db = fakeDb({ dueRows: [row] });
  const tpl = base({ auto_kind: 'due_date', auto_days: 0, auto_enabled: false });
  const bad = await eventToggleOn({}, tpl, { db, env: ENV, nowMs: NOW, kakao: fakeKakao({ template: { status: 'INSPECTING', variables: [] } }) });
  assert.equal(bad.body.reason, 'ata_not_ready');
  reset();
  const dry = await eventToggleOn({ dry_run: true }, tpl, { db, env: ENV, nowMs: NOW, kakao: fakeKakao(), provider: fakeProvider() });
  assert.equal(dry.body.targets, 1); assert.equal(dry.body.cost, 13); assert.equal(dry.body.parts, 1);
});

// ---------- B. 이미 출고된 주문 1회 발송(따라잡기) ----------
test('따라잡기 대상 범위: 출고일 시작일~오늘, 미출고·비 010·수신거부·중복 번호 제외, 오래된 출고일부터', async () => {
  const orders = [
    order(1, '010-1111-2222', '2026-10-05', '가'), order(2, '010-3333-4444', '2026-11-18', '나'), order(3, '010-5555-6666', '2026-09-20', '다'), // 시작일 전
    order(4, '010-7777-8888', '2026-11-01', '라', 'in_production'), order(5, '02-123-4567', '2026-11-01', '마'), order(6, '010-9999-0000', '2026-11-02', '바'),
    order(7, '010-1111-2222', '2026-11-10', '가'), // 같은 번호 → 1건
    order(8, '010-2222-3333', '2026-11-19', '사'),
  ];
  const db = fakeDb({ orders, optouts: [phoneHash('01099990000')] }); const provider = fakeProvider();
  const out = await go(db, provider, catchupTpl({ auto_days: 1 })); // 범위 끝 = 오늘 − 1일(11-19)
  assert.equal(out.sent, 3);
  assert.deepEqual(provider.calls.kakao[0].messages.map(m => m.to).sort(), ['01011112222', '01022223333', '01033334444']); // 출고 1일째(11-19)인 번호 8 은 평소 대상으로 먼저 실려 순서만 달라진다
  assert.ok(provider.calls.kakao[0].messages.every(m => m.templateId === 'KA01TP1'));
  assert.equal(provider.calls.each.length, 0);
});

test('따라잡기 시각: 지정 시각 전에는 무동작, 시각이 지나면 1번 나가고(KST), 다음 날부터는 그 시각(시·분) 이후에만 이어서', () => {
  const t = catchupTpl();
  const kst = (day, h, m) => Date.parse(`${day}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:00+09:00`);
  assert.equal(catchupActive(t, kst('2026-11-20', 8, 59)), false);
  assert.equal(catchupActive(t, kst('2026-11-20', 9, 0)), true);
  assert.equal(catchupActive(t, kst('2026-11-21', 8, 30)), false); // 다음 날 이월분도 그 시각 이후
  assert.equal(catchupActive(t, kst('2026-11-21', 9, 10)), true);
  assert.equal(catchupActive({ ...t, auto_catchup_done: true }, kst('2026-11-21', 9, 10)), false);
  assert.equal(catchupActive({ ...t, auto_enabled: false }, kst('2026-11-21', 9, 10)), false);
  assert.equal(catchupActive({ ...t, auto_ata_template: '' }, kst('2026-11-21', 9, 10)), false);
  assert.equal(catchupActive({ ...t, auto_kind: 'order_plus_days' }, kst('2026-11-21', 9, 10)), false);
  assert.equal(catchupActive({ ...t, auto_catchup_at: '' }, kst('2026-11-21', 9, 10)), false);
});

test('따라잡기 시각 전에는 이미 출고된 주문이 나가지 않고, 평소 자동 발송 대상만 나간다', async () => {
  const orders = [order(1, '010-1111-2222', '2026-10-05', '가'), order(2, '010-3333-4444', '2026-11-17', '나')];
  const db = fakeDb({ orders }); const provider = fakeProvider();
  const out = await go(db, provider, catchupTpl({ auto_catchup_at: '2026-11-20T15:00' })); // 시각 전
  assert.equal(out.sent, 1); assert.deepEqual(provider.calls.kakao[0].messages.map(m => m.to), ['01033334444']);
});

test('따라잡기 중복 키 공유: 평소 대상과 같은 번호는 1번만 나가고, 나중 자동 발송 때 다시 나가지 않는다', async () => {
  const orders = [order(1, '010-1111-2222', '2026-11-17', '가')]; // 평소 대상(3일 전)이면서 따라잡기 범위
  const db = fakeDb({ orders }); const provider = fakeProvider();
  const first = await go(db, provider, catchupTpl());
  assert.equal(first.claimed, 1); assert.equal(provider.calls.kakao[0].messages.length, 1);
  assert.match(db.state.sends[0].dedupe_key, /^[0-9a-f]{64}:ship$/);
  assert.equal((await go(db, provider, base())).claimed, 0); // 따라잡기 없는 평소 실행도 겹치지 않음
  assert.equal((await go(db, provider, catchupTpl())).claimed, 0);
  assert.equal(provider.calls.kakao.length, 1);
});

test('따라잡기 미승인 대기: 템플릿이 승인 전이면 선점 0·발송 0·완료 표시 없음, 승인 뒤 다음 실행에서 나간다', async () => {
  const orders = [order(1, '010-1111-2222', '2026-10-05', '가')];
  const db = fakeDb({ orders }); const provider = fakeProvider();
  const wait = await go(db, provider, catchupTpl(), { kakao: fakeKakao({ template: { status: 'INSPECTING', variables: [] } }) });
  assert.equal(wait.reason, 'ata_not_ready'); assert.equal(db.state.sends.length, 0); assert.equal(provider.calls.kakao.length, 0); assert.deepEqual(db.state.done, []);
  const approved = await go(db, provider, catchupTpl());
  assert.equal(approved.sent, 1);
});

test('따라잡기 발송 가능 시간: 밤(08시 전·21시 이후)에는 선점도 하지 않는다', async () => {
  const db = fakeDb({ orders: [order(1, '010-1111-2222', '2026-10-05', '가')] }); const provider = fakeProvider();
  const night = await go(db, provider, catchupTpl({ auto_catchup_at: '2026-11-19T09:00' }), { nowMs: Date.parse('2026-11-20T13:00:00Z') }); // KST 22:00
  assert.equal(night.reason, 'night'); assert.equal(db.state.sends.length, 0);
});

test('따라잡기 상한 이월: 하루 상한까지만 보내고 남은 번호는 다음 날 이어서, 남은 게 없으면 완료 표시(다시 돌지 않음)', async () => {
  const orders = [1, 2, 3, 4, 5].map(i => order(i, `010-1000-000${i}`, `2026-10-0${i}`, `고객${i}`));
  const db = fakeDb({ orders }); const provider = fakeProvider();
  const env = { ...ENV, SMS_CATCHUP_MAX_PER_DAY: '2' };
  const day1 = await go(db, provider, catchupTpl(), { env });
  assert.equal(day1.claimed, 2); assert.deepEqual(db.state.done, []);
  const day2 = await go(db, provider, catchupTpl(), { env, nowMs: NOW + DAY });
  assert.equal(day2.claimed, 2); assert.deepEqual(db.state.done, []);
  const day3 = await go(db, provider, catchupTpl(), { env, nowMs: NOW + 2 * DAY });
  assert.equal(day3.claimed, 1); assert.deepEqual(db.state.done, []); // 마지막 1건을 보낸 날은 아직 남은 대상이 있었음 → 다음 실행에서 확인
  const day4 = await go(db, provider, catchupTpl(), { env, nowMs: NOW + 2 * DAY + HOUR });
  assert.equal(day4.claimed, 0); assert.deepEqual(db.state.done, [31]);
  assert.equal(provider.calls.kakao.flatMap(call => call.messages).length, 5);
  assert.equal(new Set(provider.calls.kakao.flatMap(call => call.messages.map(m => m.to))).size, 5);
});

test('5분 크론(runInstantSendAll): 1회 발송 문구는 그 몫만 보내고(평소 대상은 건드리지 않음), 즉시형이 아니라도 목록에 들어온다', async () => {
  const orders = [order(1, '010-1111-2222', '2026-11-19', '가'), order(2, '010-3333-4444', '2026-11-17', '나')];
  const db = fakeDb({ orders, templates: [{ id: 31 }] });
  const provider = fakeProvider();
  const template = catchupTpl();
  const execute = db.execute.bind(db);
  db.execute = async q => {
    const t = q.sql.replace(/\s+/g, ' ').trim();
    if (t.startsWith('SELECT id, name, body, image, images, auto_kind, auto_enabled, auto_offset')) return { rows: [{ id: 31, name: template.name, body: template.body, auto_kind: 'ship_plus_days', auto_enabled: true, auto_days: 1, auto_ata_template: 'KA01TP1', auto_enabled_at: template.auto_enabled_at, auto_catchup_from: '2026-11-18', auto_catchup_at: '2026-11-20T09:00', auto_audience: 'customer' }] };
    return execute(q);
  };
  reset();
  const total = await runInstantSendAll({ db, provider, env: ENV, nowMs: NOW, kakao: fakeKakao() });
  assert.equal(total.sent, 1); // 평소 대상(번호 2)이 아니라 따라잡기 몫(번호 1)만
  assert.deepEqual(provider.calls.kakao[0].messages.map(m => m.to), ['01011112222']);
  assert.ok(db.state.sql.some(s => s.includes("auto_kind = 'ship_plus_days' AND COALESCE(auto_ata_template, '') <> ''")));
});

// ---------- D. 미리보기 건수·예상 비용·잔액 ----------
test('미리보기: 범위별(고른 범위·30일·90일·가장 오래된 출고일) 건수·예상 비용(알림톡 단가×건수)·잔액·경고, 수신거부·이미 보낸 번호 제외', async () => {
  const orders = [
    order(1, '010-1111-2222', '2026-06-01'), order(2, '010-3333-4444', '2026-09-01'), order(3, '010-5555-6666', '2026-10-25'),
    order(4, '010-7777-8888', '2026-11-10'), order(5, '010-9999-0000', '2026-11-15'), order(6, '02-123-4567', '2026-11-15'), order(7, '010-1212-3434', '2026-11-16', '', 'in_production'),
  ];
  const db = fakeDb({ orders, optouts: [phoneHash('01099990000')] });
  reset();
  const out = await catchupPreview(db, { from: '2026-10-01', nowMs: NOW, env: ENV, provider: fakeProvider(), kakao: fakeKakao({}, 100000) });
  assert.equal(out.today, '2026-11-20'); assert.equal(out.oldest_ship_date, '2026-06-01');
  const byKey = Object.fromEntries(out.ranges.map(range => [range.key, range]));
  assert.equal(byKey.selected.count, 2); assert.equal(byKey.selected.cost, 26);
  assert.equal(byKey.d30.count, 2); assert.equal(byKey.d90.count, 3);
  assert.equal(byKey.all.count, 4); assert.equal(byKey.all.from, '2026-06-01'); assert.equal(byKey.all.cost, 52);
  assert.equal(out.unit, 13); assert.equal(out.balance, 100000); assert.equal(out.balance_short, false);
  assert.equal(out.daily_max, 1000); assert.equal(out.per_run, 100); assert.equal(out.days_needed, 1);
  assert.equal(JSON.stringify(out).includes('01111112222'), false); // 번호 자체는 돌려주지 않는다
  const lowBalance = await catchupPreview(db, { from: '2026-01-01', nowMs: NOW, env: ENV, provider: fakeProvider(), kakao: fakeKakao({}, 20) });
  assert.equal(lowBalance.balance_short, true); assert.equal(lowBalance.balance, 20);
  const noBalance = await catchupPreview(db, { from: '2026-10-01', nowMs: NOW, env: ENV, provider: fakeProvider(), kakao: { async getBalance() { throw new Error('x'); } } });
  assert.equal(noBalance.balance, null); assert.equal(noBalance.balance_short, false);
  // 이미 이 문구로 보낸 번호는 건수에서 빠진다
  const sentDb = fakeDb({ orders });
  reset();
  await catchupPreview(sentDb, { from: '2026-10-01', nowMs: NOW, env: ENV, provider: fakeProvider(), kakao: fakeKakao() });
  const hash = (await import('node:crypto')).createHash('sha256').update('hansung-sms-event-v1:01033334444').digest('hex');
  sentDb.state.sends.push({ id: 99, template_id: 31, dedupe_key: `${hash}:ship`, kst_date: '2026-11-19', status: 'sent' });
  const after = await catchupPreview(sentDb, { from: '2026-10-01', templateId: 31, nowMs: NOW, env: ENV, provider: fakeProvider(), kakao: fakeKakao() });
  assert.equal(after.ranges.find(range => range.key === 'all').count, 4);
});

test('미리보기 켜기 응답: 1회 발송이 설정된 출고 완료 후 문구의 dry_run 에 catchup 요약이 실린다', async () => {
  const db = fakeDb({ orders: [order(1, '010-1111-2222', '2026-10-05', '가'), order(2, '010-3333-4444', '2026-11-17', '나')] });
  reset();
  const dry = await eventToggleOn({ dry_run: true }, catchupTpl({ auto_enabled: false }), { db, env: ENV, nowMs: NOW, kakao: fakeKakao(), provider: fakeProvider() });
  assert.equal(dry.status, 200);
  assert.equal(dry.body.catchup.ranges[0].count, 2); assert.equal(dry.body.catchup.balance, 100000);
});

// ---------- 화면 모델 ----------
test('화면 모델: 모든 조건에서 알림톡을 고르면 ata_template 이 실리고 받는 사람은 고객이며, catchup 은 출고 완료 후에만 실린다', () => {
  const sav = auto => buildSaveBody({ name: 'a', body: 'b', auto }).auto;
  assert.equal(sav({ kind: 'member_joined', ataTemplate: 'KA01' }).ata_template, 'KA01');
  assert.equal(sav({ kind: 'order_created', ataTemplate: 'KA01', audience: 'staff', staff: ['s1'] }).audience, 'customer');
  assert.equal(sav({ kind: 'process_started', step: '도면설계', ataTemplate: 'KA01' }).ata_template, 'KA01');
  const due = sav({ kind: 'due_date', offsetDir: 'before', offsetDays: '2', ataTemplate: 'KA01', audience: 'sales' });
  assert.deepEqual([due.ata_template, due.audience], ['KA01', 'customer']);
  assert.equal('ata_template' in sav({ kind: 'due_date', offsetDir: 'before', offsetDays: '2' }), false);
  assert.equal(sav({ kind: 'order_plus_days', days: '3', ataTemplate: 'KA01' }).ata_template, 'KA01');
  assert.deepEqual(sav({ kind: 'ship_plus_days', days: '2', ataTemplate: 'KA01', catchupOn: true, catchupFrom: '2026-10-01', catchupAt: '2026-11-21T09:00' }).catchup, { from: '2026-10-01', at: '2026-11-21T09:00' });
  assert.equal('catchup' in sav({ kind: 'ship_plus_days', days: '2', ataTemplate: 'KA01', catchupOn: false, catchupFrom: '2026-10-01', catchupAt: '2026-11-21T09:00' }), false);
  assert.equal('catchup' in sav({ kind: 'order_plus_days', days: '2', ataTemplate: 'KA01', catchupOn: true, catchupFrom: '2026-10-01', catchupAt: '2026-11-21T09:00' }), false);
  assert.deepEqual(sav({ kind: 'ship_plus_days', days: '2', catchupOn: true, catchupFrom: '2026-10-01', catchupAt: '2026-11-21T09:00' }).catchup, { from: '2026-10-01', at: '2026-11-21T09:00' }); // 광고 문자(알림톡 아님)도 출고 완료 후면 실린다(2026-11-17)
  assert.equal(isAdKind('order_plus_days', 'KA01'), false);
  for (const kind of AUTO_KINDS) assert.match(autoConditionLine({ autoKind: kind, autoDays: 2, autoOffset: -1, autoStep: '포장', autoAtaTemplate: 'KA01' }), /알림톡/, kind);
  assert.doesNotMatch(autoConditionLine({ autoKind: 'due_date', autoOffset: -1 }), /알림톡/);
});

test('화면 모델 검증: 알림톡이면 고객명 밖 변수 거절·직원 수신 무시, 1회 발송은 시작일·시각(08~20시)이 있어야 한다', () => {
  const form = over => ({ name: 'a', body: '#{고객명}님', autoKind: 'ship_plus_days', days: '2', sendFrom: '', repeat: '1', interval: '30', offsetDir: 'before', offsetDays: '3', daily: false, audience: 'customer', staff: [], step: '', ataTemplate: 'KA01', ...over });
  assert.equal(validateTextForm(form()).ok, true);
  assert.equal(validateTextForm(form({ body: '#{주문번호}' })).reason, 'info_unknown_var');
  assert.equal(validateTextForm(form({ autoKind: 'due_date', audience: 'staff', staff: [] })).ok, true); // 알림톡이면 직원 수신은 무시(고객)
  assert.equal(validateTextForm(form({ autoKind: 'member_joined', body: '#{고객명}님 환영' })).ok, true);
  assert.equal(validateTextForm(form({ autoKind: 'member_joined', body: '#{고객명}님 환영', ataTemplate: '' })).reason, 'info_unknown_var');
  assert.equal(validateTextForm(form({ catchupOn: true, catchupFrom: '', catchupAt: '2026-11-21T09:00' })).reason, 'catchup_from');
  assert.equal(validateTextForm(form({ catchupOn: true, catchupFrom: '2026-10-01', catchupAt: '2026-11-21T07:00' })).reason, 'catchup_at');
  assert.equal(validateTextForm(form({ catchupOn: true, catchupFrom: '2026-10-01', catchupAt: '2026-11-21T09:00' })).ok, true);
  assert.equal(validateTextForm(form({ catchupOn: false, catchupFrom: '', catchupAt: '' })).ok, true);
  assert.match(textFormStopText('catchup_from'), /출고일/); assert.match(textFormStopText('catchup_at'), /시각/);
});

test('알림톡 상세 연결 줄: 조건 이름·1회·시각·켜짐/꺼짐·일괄 발송 예약·최근 7일 건수', async () => {
  const { ataLinkLine, myTextSection } = await import('../src/components/smsconsole/smsTextTemplateFormModel.js');
  const [entry] = myTextSection([{ id: 5, name: '리뷰', body: 'b', auto_kind: 'ship_plus_days', auto_days: 2, auto_enabled: true, auto_ata_template: 'KA01', auto_send_time: '10:00', auto_catchup_from: '2026-05-26', auto_catchup_at: '2026-11-17T09:00', auto_catchup_done: false }]).items;
  assert.equal(ataLinkLine(entry, { enabled: true, sent_7d: 4 }), '출고 완료 후 2일 뒤 · 오전 10:00 · 1회 · 켜짐 · 일괄 2026-11-17 09:00 · 출고일 2026-05-26~오늘 · 최근 7일 4건');
  const [off] = myTextSection([{ id: 6, name: 'x', body: 'b', auto_kind: 'due_date', auto_offset: -2, auto_enabled: false, auto_ata_template: 'KA01' }]).items;
  assert.match(ataLinkLine(off, null), /^납기일 2일 전 · .*1회 · 꺼짐$/);
});

// ---------- F. 하루에 다 보내기: 일괄 발송 전용 상한(기본 1000) · 크론 1회 묶음 · 안내 상한과 분리 ----------
const bulkOrders = n => Array.from({ length: n }, (_, i) => order(i + 1, `010${String(10000000 + i * 7)}`, `2026-${String(6 + (i % 5)).padStart(2, "0")}-${String(1 + (i % 28)).padStart(2, '0')}`, `고객${i}`));

test('F: 이미 출고된 429건이 기본 상한(1000)으로 하루 안에 다 나간다 — 5분 크론마다 100건씩, 5번(약 20분) 안에 끝나고 완료 표시', async () => {
  const db = fakeDb({ orders: bulkOrders(429) }); const provider = fakeProvider();
  const tpl = catchupTpl({ auto_catchup_from: '2026-05-01', auto_catchup_at: '2026-11-20T09:00' });
  const sentPerRun = [];
  for (let run = 0; run < 6; run += 1) {
    const out = await go(db, provider, tpl, { nowMs: NOW + run * 5 * 60000, env: ENV }); // 안내 상한·일괄 상한 환경값 없음 = 기본값
    sentPerRun.push(out.claimed);
  }
  assert.deepEqual(sentPerRun, [100, 100, 100, 100, 29, 0]);
  const calls = provider.calls.kakao;
  assert.ok(calls.every(call => call.messages.length <= 100)); // 한 번의 send-many 는 100건 이하
  const phones = calls.flatMap(call => call.messages.map(m => m.to));
  assert.equal(phones.length, 429); assert.equal(new Set(phones).size, 429);
  assert.ok(db.state.sends.every(r => r.kind === 'catchup' && r.kst_date === '2026-11-20'));
  assert.deepEqual(db.state.done, [31]); // 마지막(0건) 실행에서 완료 표시
  // 시작 10:00 → 5번째 묶음이 10:20 → 08~21시 안에서 20분
  assert.ok(new Date(NOW + 4 * 5 * 60000 + 9 * HOUR).getUTCHours() < 21);
});

test('F: 일괄 발송 전용 상한은 환경값(SMS_CATCHUP_MAX_PER_DAY)으로만 바뀌고 넘으면 다음 날로 이월된다', async () => {
  const db = fakeDb({ orders: bulkOrders(250) }); const provider = fakeProvider();
  const tpl = catchupTpl({ auto_catchup_from: '2026-05-01' });
  const env = { ...ENV, SMS_CATCHUP_MAX_PER_DAY: '150' };
  const day1 = [];
  for (let run = 0; run < 4; run += 1) day1.push((await go(db, provider, tpl, { nowMs: NOW + run * 5 * 60000, env })).claimed);
  assert.deepEqual(day1, [100, 50, 0, 0]); // 하루 150건
  const day2 = (await go(db, provider, tpl, { nowMs: NOW + DAY, env })).claimed;
  assert.equal(day2, 100);
});

test('F: 문구별 하루 최대(auto_catchup_daily) 50 → 하루 50건만 나가고 다음 날 이어진다, 전역 상한이 더 작으면 그쪽을 따른다', async () => {
  const db = fakeDb({ orders: bulkOrders(120) }); const provider = fakeProvider();
  const tpl = catchupTpl({ auto_catchup_from: '2026-05-01', auto_catchup_daily: 50 });
  const day1 = [];
  for (let run = 0; run < 3; run += 1) day1.push((await go(db, provider, tpl, { nowMs: NOW + run * 5 * 60000 })).claimed);
  assert.deepEqual(day1, [50, 0, 0]); // 하루 50건
  assert.equal((await go(db, provider, tpl, { nowMs: NOW + DAY })).claimed, 50);
  assert.equal((await go(db, provider, tpl, { nowMs: NOW + 2 * DAY })).claimed, 20);
  const small = fakeDb({ orders: bulkOrders(20) });
  const capped = await go(small, fakeProvider(), tpl, { env: { ...ENV, SMS_CATCHUP_MAX_PER_DAY: '5' } });
  assert.equal(capped.claimed, 5); // min(50, 전역 5)
});

test('F: 하루 최대 미리보기 일수 = 올림(건수/하루 상한), 값이 없으면 전역 상한 그대로', async () => {
  const db = fakeDb({ orders: bulkOrders(429) });
  reset();
  const own = await catchupPreview(db, { from: '2026-05-01', nowMs: NOW, env: ENV, provider: fakeProvider(), kakao: fakeKakao({}, 100000), dailyCap: 50 });
  assert.equal(own.daily_max, 50); assert.equal(own.days_needed, 9);
  const none = await catchupPreview(db, { from: '2026-05-01', nowMs: NOW, env: ENV, provider: fakeProvider(), kakao: fakeKakao({}, 100000) });
  assert.equal(none.daily_max, 1000); assert.equal(none.days_needed, 1);
});

test('F: 하루 최대 입력 검사(1~1000, 비움 허용)와 저장 본문·읽기', () => {
  assert.equal(readCatchup({ from: '2026-05-26', at: '2026-11-18T09:00', daily: 50 }).catchup_daily, 50);
  assert.equal(readCatchup({ from: '2026-05-26', at: '2026-11-18T09:00' }).catchup_daily, null);
  assert.equal(readCatchup({ from: '2026-05-26', at: '2026-11-18T09:00', daily: '' }).catchup_daily, null);
  for (const bad of [0, 1001, 2.5, 'x', -3]) assert.equal(readCatchup({ from: '2026-05-26', at: '2026-11-18T09:00', daily: bad }).reason, 'catchup_daily');
  const base = { name: 'n', body: BODY, autoKind: 'ship_plus_days', days: '2', ataTemplate: 'KA01TP1', catchupOn: true, catchupFrom: '2026-05-26', catchupAt: '2026-11-18T09:00' };
  assert.equal(validateTextForm({ ...base, catchupDaily: '50' }).ok, true);
  assert.equal(validateTextForm({ ...base, catchupDaily: '' }).ok, true);
  assert.equal(validateTextForm({ ...base, catchupDaily: '0' }).reason, 'catchup_daily');
  assert.equal(validateTextForm({ ...base, catchupDaily: '1001' }).reason, 'catchup_daily');
  const body = buildSaveBody({ id: 1, name: 'n', body: BODY, images: [], auto: { kind: 'ship_plus_days', days: '2', ataTemplate: 'KA01TP1', catchupOn: true, catchupFrom: '2026-05-26', catchupAt: '2026-11-18T09:00', catchupDaily: '50' } });
  assert.equal(body.auto.catchup.daily, 50);
  const none = buildSaveBody({ id: 1, name: 'n', body: BODY, images: [], auto: { kind: 'ship_plus_days', days: '2', ataTemplate: 'KA01TP1', catchupOn: true, catchupFrom: '2026-05-26', catchupAt: '2026-11-18T09:00', catchupDaily: '' } });
  assert.equal('daily' in none.auto.catchup, false);
});

test('F: 안내 상한은 일괄 발송분에 깎이지 않고, 일괄 발송도 안내 문자 때문에 막히지 않는다', async () => {
  // (1) 일괄 429건이 먼저 나간 뒤에도 안내 문구(납기일 알림톡)는 안내 상한(여기서는 2)까지 그대로 나간다
  const dueRows = [1, 2, 3].map(i => ({ id: 900 + i, phone: `010-7000-000${i}`, client_name: `납기${i}`, order_date: '2026-11-10', due_date: '2026-11-20', quantity: 1 }));
  const db = fakeDb({ orders: bulkOrders(429), dueRows }); const provider = fakeProvider();
  const catchup = catchupTpl({ auto_catchup_from: '2026-05-01' });
  for (let run = 0; run < 5; run += 1) await go(db, provider, catchup, { nowMs: NOW + run * 5 * 60000, env: ENV });
  assert.equal(db.state.sends.filter(r => r.kind === 'catchup').length, 429);
  const info = await go(db, provider, base({ id: 41, auto_kind: 'due_date', auto_days: 0 }), { env: { ...ENV, SMS_AUTO_INFO_MAX_PER_DAY: '2' }, nowMs: NOW + 40 * 60000 });
  assert.equal(info.claimed, 2); assert.equal(info.reason, ''); // 429건을 보냈어도 안내 2건 상한이 그대로 2건
  // (2) 반대로 안내 문자가 하루 상한(200)을 이미 다 썼어도 일괄 발송은 막히지 않는다
  const db2 = fakeDb({ orders: bulkOrders(30) }); const provider2 = fakeProvider();
  for (let i = 0; i < 200; i += 1) db2.state.sends.push({ id: 5000 + i, template_id: 77, dedupe_key: `x${i}`, kst_date: '2026-11-20', status: 'sent' });
  db2.state.nextId = 6000;
  const out = await go(db2, provider2, catchup, { env: ENV });
  assert.equal(out.claimed, 30);
});
