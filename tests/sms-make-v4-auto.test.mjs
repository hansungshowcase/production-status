// 2026-11-19 설계 v4 S2(자동 갈래 0일)·S4(auto_mark_sent 종류별 기록 키) 시험. 가짜 db·가짜 발송기만 쓴다(실제 발송·운영 호출 없음). 값은 모두 가짜.
import assert from 'node:assert/strict';
import test from 'node:test';
import { _resetAutoSchemaForTest, autoMarkSent, autoStatus, autoToggle, findTargets, phoneHash, runAutoSend } from '../api/_lib/smsAutoSend.js';
import { _resetTextTemplateSchemaForTest } from '../api/_lib/smsTextTemplates.js';
import { _resetEventSchemaForTest, eventPhoneHash, eventToggleOn } from '../api/_lib/smsEventSend.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db';
const NOW = Date.parse('2026-11-20T01:00:00Z'); // KST 2026-11-20 10:00
const ENV = { SMS_SENDER: '0212345678' };
const reset = () => { _resetEventSchemaForTest(); _resetAutoSchemaForTest(); _resetTextTemplateSchemaForTest(); };
const PLAIN = '한성쇼케이스 주의사항 안내\n#{고객명}님 안내드립니다.';
const INFO = '#{고객명}님 주문번호 #{주문번호} 접수되었습니다.';
const P1 = '01011112222';
const P2 = '01033334444';
const P3 = '01055556666';
const KST_TODAY = '2026-11-20';

// templates: id → 행(auto_* 칸). orders: { id, phone('010-…' 허용), order_date, status, client_name }. processes: { order_id, step_name, started_at }.
function fakeDb({ templates = {}, orders = [], processes = [], eventRows = [], autoRows = [] } = {}) {
  const state = { templates, orders, processes, eventRows: eventRows.map((r, i) => ({ id: 100 + i, status: 'sent', ...r })), autoRows: [...autoRows], sql: [], nextId: 1 };
  const digits = v => String(v ?? '').replace(/\D/g, '');
  const db = {
    state,
    async execute({ sql, args = [] }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      state.sql.push(t);
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT conname FROM pg_constraint')) return { rows: [] };
      if (t.startsWith('SELECT id, name, body, image, images, auto_kind, auto_days, auto_enabled, auto_start_date')) { const row = state.templates[args[0]]; return { rows: row ? [{ id: args[0], name: 'x', ...row }] : [] }; }
      if (t.includes('FROM orders o JOIN processes p') || (t.includes('FROM orders o WHERE regexp_replace'))) {
        const withProc = t.includes('JOIN processes p');
        const step = withProc ? args[0] : null;
        const phones = withProc ? args.slice(1) : args;
        const rows = state.orders.filter(o => phones.includes(digits(o.phone)) && (!withProc || state.processes.some(p => p.order_id === o.id && p.step_name === step && p.started_at))).map(o => ({ id: o.id, phone: o.phone }));
        return { rows };
      }
      if (t.includes('FROM orders') && t.includes('LEFT(order_date')) return { rows: state.orders.filter(o => o.order_date && o.status !== 'cancelled' && o.order_date.slice(0, 10) >= args[0] && o.order_date.slice(0, 10) <= args[1]).map(o => ({ id: o.id, phone: o.phone, client_name: o.client_name, ship_day: o.order_date.slice(0, 10) })) };
      if (t.includes('FROM orders o WHERE o.created_at >=')) return { rows: state.orders.filter(o => o.created_at && o.created_at >= args[0] && o.created_at <= args[1] && o.status !== 'cancelled').map(o => ({ ...o })) };
      if (t.includes('FROM processes p JOIN orders o')) return { rows: state.processes.filter(p => p.step_name === args[0] && p.started_at && p.started_at >= args[1] && p.started_at <= args[2]).map(p => state.orders.find(o => o.id === p.order_id)).filter(Boolean).map(o => ({ ...o })) };
      if (t.startsWith('SELECT phone_hash FROM sms_optouts')) return { rows: [] };
      if (t.startsWith('SELECT status, COUNT(*) AS n')) return { rows: [] };
      if (t.startsWith('SELECT MAX(last_run)')) return { rows: [{ last_run: null }] };
      if (t.startsWith('SELECT phone_hash, order_id, round, status FROM sms_auto_sends') || t.startsWith('SELECT phone_hash, order_id')) return { rows: state.autoRows.filter(r => r.template_id === args[0]) };
      if (t.startsWith('SELECT DISTINCT phone_hash FROM sms_auto_sends WHERE kst_date')) return { rows: [] };
      if (t.startsWith('SELECT DISTINCT e.phone_hash FROM sms_event_sends')) return { rows: [] };
      if (t.startsWith("SELECT dedupe_key FROM sms_event_sends WHERE template_id = ? AND dedupe_key IN")) return { rows: state.eventRows.filter(r => r.template_id === args[0] && args.slice(1).includes(r.dedupe_key)).map(r => ({ dedupe_key: r.dedupe_key })) };
      if (t.startsWith('SELECT dedupe_key FROM sms_event_sends WHERE template_id = ?')) return { rows: state.eventRows.filter(r => r.template_id === args[0]).map(r => ({ dedupe_key: r.dedupe_key })) };
      if (t.startsWith("SELECT id, dedupe_key FROM sms_event_sends WHERE template_id = ? AND status = 'failed'")) return { rows: [] };
      if (t.startsWith('SELECT id, track_token FROM orders')) return { rows: [] };
      if (t.startsWith('INSERT INTO sms_event_sends') && t.includes('make_migrated')) {
        const rows = [];
        for (let i = 0; i < args.length; i += 5) {
          const [template_id, dedupe_key, phone_hash, , kst_date] = args.slice(i, i + 5);
          const old = state.eventRows.find(r => r.template_id === template_id && r.dedupe_key === dedupe_key);
          if (old) { if (old.status === 'failed') { old.status = 'sent'; old.reason = 'make_migrated'; rows.push({ id: old.id, fresh: false }); } continue; }
          const row = { id: state.nextId++, template_id, dedupe_key, phone_hash, kst_date, status: 'sent', reason: 'make_migrated' };
          state.eventRows.push(row); rows.push({ id: row.id, fresh: true });
        }
        return { rows };
      }
      if (t.startsWith('INSERT INTO sms_auto_sends') && t.includes('make_migrated')) {
        const rows = [];
        for (let i = 0; i < args.length; i += 4) {
          const [template_id, phone_hash, , kst_date] = args.slice(i, i + 4);
          const old = state.autoRows.find(r => r.template_id === template_id && r.phone_hash === phone_hash && (r.round || 1) === 1);
          if (old) continue;
          const row = { id: state.nextId++, template_id, phone_hash, order_id: null, kst_date, status: 'sent', round: 1, reason: 'make_migrated' };
          state.autoRows.push(row); rows.push({ id: row.id, fresh: true });
        }
        return { rows };
      }
      throw new Error(`예상 못 한 SQL ${t}`);
    },
  };
  return db;
}
const fakeKakao = () => ({ async getBalance() { return 100000; }, async getTemplateFresh() { return { raw: { channelId: 'PF1' }, template: { status: 'APPROVED', variables: ['#{고객명}'], content: '#{고객명}님' }, scope: { allowed: true, kind: 'channel' } }; } });
const fakeProvider = () => ({ calls: [], async sendEach() { throw new Error('실제 발송 금지'); }, async sendKakaoEach() { throw new Error('실제 발송 금지'); }, estimate: ({ count }) => ({ unit: 10, total: 10 * count }), estimateKakao: ({ count }) => ({ unit: 13, total: 13 * count }) });
const tplRow = (extra = {}) => ({ body: PLAIN, image: null, images: '[]', auto_kind: 'order_plus_days', auto_days: 0, auto_enabled: false, auto_start_date: '', auto_audience: 'customer', auto_msg_type: 'ad', auto_ata_template: '', auto_chain: JSON.stringify({ plain: true, subject: '안내', from: '0319862458' }), ...extra });
const ord = (id, phone, extra = {}) => ({ id, phone, client_name: '김철수', status: 'in_production', order_date: `${KST_TODAY}T00:00:00`, created_at: '2026-11-20T00:30:00.000Z', ...extra });

// ---------- S2. 자동 갈래 0일 ----------
test('S2 findTargets: 주문 후 0일은 주문일(KST)=오늘 주문만 오늘 대상(어제·내일 주문은 창 기준만, 출고 후 0일은 대상 없음)', async () => {
  const db = fakeDb({ orders: [ord(1, P1), ord(2, P2, { order_date: '2026-11-19T00:00:00' }), ord(3, P3, { order_date: '2026-11-21T00:00:00' })] });
  const today = await findTargets(db, { nowMs: NOW, days: 0, startDate: KST_TODAY, kind: 'order_plus_days' });
  assert.deepEqual(today.map(t => t.orderId), [1], '켠 날(오늘)부터: 오늘 주문 1건만, 어제·내일 주문은 제외');
  const win = await findTargets(db, { nowMs: NOW, days: 0, startDate: '', kind: 'order_plus_days' });
  assert.deepEqual(win.map(t => t.orderId), [1, 2], '재시도 창(3일 전~오늘) 규칙은 그대로');
});

test('S2 runAutoSend: 주문 후 0일은 no_auto 로 막히지 않고, 출고 후·공정 후 0일은 종전대로 no_auto', async () => {
  reset();
  const db = fakeDb({ templates: { 7: tplRow() } });
  const base = { id: 7, name: 'x', body: PLAIN, images: [], auto_enabled: true, auto_days: 0, auto_start_date: KST_TODAY, auto_repeat: 1, auto_interval: 30, auto_chain: { plain: true, subject: '안내', from: '', after: undefined } };
  const order0 = await runAutoSend({ ...base, auto_kind: 'order_plus_days' }, { db, env: { ...ENV, SMS_SENDER: '' }, nowMs: NOW, provider: null });
  assert.notEqual(order0.reason, 'no_auto');
  const ship0 = await runAutoSend({ ...base, auto_kind: 'ship_plus_days' }, { db, env: ENV, nowMs: NOW, provider: fakeProvider() });
  assert.equal(ship0.reason, 'no_auto');
  const proc0 = await runAutoSend({ ...base, auto_kind: 'process_started_plus_days', auto_step: '도면설계' }, { db, env: ENV, nowMs: NOW, provider: fakeProvider() });
  assert.equal(proc0.reason, 'no_auto');
});

test('S2 autoToggle dry_run·켜기: 주문 후 0일 plain 문구는 켤 수 있고(시작일=오늘) 오늘 대상 수를 센다, 출고 후 0일은 거절', async () => {
  reset();
  const orders = [ord(1, P1), ord(2, P2, { order_date: '2026-11-19T00:00:00' })];
  const db = fakeDb({ templates: { 7: tplRow(), 8: tplRow({ auto_kind: 'ship_plus_days' }) }, orders });
  const provider = fakeProvider();
  const dry = await autoToggle({ id: 7, enabled: true, dry_run: true }, { db, provider, env: ENV, nowMs: NOW });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.targets, 1, '오늘 주문 1건(어제 주문은 켠 날 이전이라 제외)');
  const bad = await autoToggle({ id: 8, enabled: true, dry_run: true }, { db, provider, env: ENV, nowMs: NOW });
  assert.equal(bad.status, 400); assert.equal(bad.body.reason, 'no_auto');
  const st = await autoStatus(db, { id: 7, nowMs: NOW, env: ENV });
  assert.equal(st.status, 200); assert.equal(st.body.days, 0); assert.equal(st.body.enable_blocked_reason, '');
  const stShip = await autoStatus(db, { id: 8, nowMs: NOW, env: ENV });
  assert.equal(stShip.body.today_targets, 0);
});

// ---------- S4. auto_mark_sent 종류별 기록 키 ----------
const keysOf = (db, id) => db.state.eventRows.filter(r => r.template_id === id).map(r => r.dedupe_key).sort();
const ata = (extra = {}) => tplRow({ body: '#{고객명}님 안내', auto_msg_type: 'info', auto_ata_template: 'KA01TP1', auto_chain: null, ...extra });

test('S4 출고 후 N일 알림톡: 키 <해시>:ship (종전 그대로)', async () => {
  reset();
  const db = fakeDb({ templates: { 20: ata({ auto_kind: 'ship_plus_days', auto_days: 1 }) } });
  const out = await autoMarkSent({ template_id: 20, phones: [P1, P2] }, { db });
  assert.equal(out.status, 200); assert.equal(out.body.via, 'event'); assert.equal(out.body.inserted, 2);
  assert.deepEqual(keysOf(db, 20), [`${eventPhoneHash(P1)}:ship`, `${eventPhoneHash(P2)}:ship`].sort());
});

test('S4 주문 후 N일 알림톡: 키 <해시>:order 이고, 실제 발송 후보에서 빠진다(같은 키 규칙)', async () => {
  reset();
  const orders = [ord(1, '010-1111-2222', { order_date: '2026-11-19T00:00:00' }), ord(2, P2, { order_date: '2026-11-19T00:00:00' })];
  const tpl = ata({ auto_kind: 'order_plus_days', auto_days: 1 });
  const db = fakeDb({ templates: { 21: tpl }, orders });
  const enabledAt = new Date(NOW - 3600000).toISOString();
  const target = { id: 21, name: 'x', body: '#{고객명}님 안내', images: [], auto_kind: 'order_plus_days', auto_days: 1, auto_enabled: true, auto_enabled_at: enabledAt, auto_ata_template: 'KA01TP1', auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_offset: 0, auto_unless_step: '', auto_daily: '', auto_weekdays: false, auto_unless_mode: 'completed', auto_step: '', auto_send_time: '', auto_catchup_from: '', auto_catchup_at: '', auto_catchup_done: false };
  const before = await eventToggleOn({ dry_run: true }, target, { db, env: ENV, nowMs: NOW, kakao: fakeKakao(), provider: fakeProvider() });
  assert.equal(before.body.targets, 2, '표시 전에는 2명 모두 대상');
  const out = await autoMarkSent({ template_id: 21, phones: ['01011112222'] }, { db });
  assert.equal(out.status, 200); assert.equal(out.body.inserted, 1);
  assert.deepEqual(keysOf(db, 21), [`${eventPhoneHash(P1)}:order`]);
  const after = await eventToggleOn({ dry_run: true }, target, { db, env: ENV, nowMs: NOW, kakao: fakeKakao(), provider: fakeProvider() });
  assert.equal(after.body.targets, 1, '표시한 번호는 발송 대상에서 빠진다');
});

test('S4 주문 후 0일 알림톡: 당일 주문도 표시하면 대상에서 빠진다', async () => {
  reset();
  const db = fakeDb({ templates: { 22: ata({ auto_kind: 'order_plus_days', auto_days: 0 }) }, orders: [ord(1, P1), ord(2, P2)] });
  const target = { id: 22, name: 'x', body: '#{고객명}님 안내', images: [], auto_kind: 'order_plus_days', auto_days: 0, auto_enabled: true, auto_enabled_at: new Date(NOW - 3600000).toISOString(), auto_ata_template: 'KA01TP1', auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_offset: 0, auto_unless_step: '', auto_daily: '', auto_weekdays: false, auto_unless_mode: 'completed', auto_step: '', auto_send_time: '', auto_catchup_from: '', auto_catchup_at: '', auto_catchup_done: false };
  const before = await eventToggleOn({ dry_run: true }, target, { db, env: ENV, nowMs: NOW, kakao: fakeKakao(), provider: fakeProvider() });
  assert.equal(before.body.targets, 2);
  await autoMarkSent({ template_id: 22, phones: [P2] }, { db });
  assert.deepEqual(keysOf(db, 22), [`${eventPhoneHash(P2)}:order`]);
  const after = await eventToggleOn({ dry_run: true }, target, { db, env: ENV, nowMs: NOW, kakao: fakeKakao(), provider: fakeProvider() });
  assert.equal(after.body.targets, 1);
});

test('S4 주문 등록 시(order_created): 그 번호의 기존 주문마다 <해시>:<주문번호>:order_created, 주문 없는 번호는 no_order, 표시한 주문은 대상에서 빠진다', async () => {
  reset();
  const orders = [ord(5, '010-1111-2222'), ord(6, P1), ord(7, P2)];
  const db = fakeDb({ templates: { 23: tplRow({ body: INFO, auto_kind: 'order_created', auto_msg_type: 'info', auto_chain: null }) }, orders });
  const target = { id: 23, name: 'x', body: INFO, images: [], auto_kind: 'order_created', auto_days: 0, auto_enabled: false, auto_enabled_at: '', auto_ata_template: '', auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_offset: 0, auto_unless_step: '', auto_daily: '', auto_weekdays: false, auto_unless_mode: 'completed', auto_step: '', auto_send_time: '', auto_catchup_from: '', auto_catchup_at: '', auto_catchup_done: false };
  const before = await eventToggleOn({ dry_run: true }, target, { db, env: ENV, nowMs: NOW, provider: fakeProvider() });
  assert.equal(before.body.targets, 3);
  const out = await autoMarkSent({ template_id: 23, phones: [P1, P3] }, { db });
  assert.equal(out.status, 200); assert.equal(out.body.via, 'event');
  assert.deepEqual([out.body.inserted, out.body.no_order, out.body.keys], [2, 1, 2]);
  assert.deepEqual(keysOf(db, 23), [`${eventPhoneHash(P1)}:5:order_created`, `${eventPhoneHash(P1)}:6:order_created`].sort());
  const after = await eventToggleOn({ dry_run: true }, target, { db, env: ENV, nowMs: NOW, provider: fakeProvider() });
  assert.equal(after.body.targets, 1, '표시한 주문 2건이 빠지고 7번 주문만 남는다');
  const again = await autoMarkSent({ template_id: 23, phones: [P1] }, { db });
  assert.deepEqual([again.body.inserted, again.body.skipped], [0, 2]);
});

test('S4 공정 시작 시(process_started): 그 공정이 시작된 주문만 <해시>:<주문번호>:process_started, 표시한 주문은 대상에서 빠진다', async () => {
  reset();
  const orders = [ord(5, P1), ord(6, P1), ord(7, P2)];
  const processes = [{ order_id: 5, step_name: '도면설계', started_at: '2026-11-20T00:10:00.000Z' }, { order_id: 6, step_name: '도면설계', started_at: null }, { order_id: 7, step_name: '포장', started_at: '2026-11-20T00:10:00.000Z' }];
  const db = fakeDb({ templates: { 24: tplRow({ body: INFO, auto_kind: 'process_started', auto_step: '도면설계', auto_msg_type: 'info', auto_chain: null }) }, orders, processes });
  const target = { id: 24, name: 'x', body: INFO, images: [], auto_kind: 'process_started', auto_days: 0, auto_enabled: false, auto_enabled_at: '', auto_ata_template: '', auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_offset: 0, auto_unless_step: '', auto_daily: '', auto_weekdays: false, auto_unless_mode: 'completed', auto_step: '도면설계', auto_send_time: '', auto_catchup_from: '', auto_catchup_at: '', auto_catchup_done: false };
  const before = await eventToggleOn({ dry_run: true }, target, { db, env: ENV, nowMs: NOW, provider: fakeProvider() });
  assert.equal(before.body.targets, 1, '도면설계가 시작된 주문 5 만 대상');
  const out = await autoMarkSent({ template_id: 24, phones: [P1, P2] }, { db });
  assert.equal(out.status, 200);
  assert.deepEqual(keysOf(db, 24), [`${eventPhoneHash(P1)}:5:process_started`]);
  assert.equal(out.body.no_order, 1, '번호2 는 이 공정이 시작된 주문이 없다');
  const after = await eventToggleOn({ dry_run: true }, target, { db, env: ENV, nowMs: NOW, provider: fakeProvider() });
  assert.equal(after.body.targets, 0);
  const noStep = fakeDb({ templates: { 25: tplRow({ body: INFO, auto_kind: 'process_started', auto_step: '', auto_msg_type: 'info', auto_chain: null }) } });
  assert.equal((await autoMarkSent({ template_id: 25, phones: [P1] }, { db: noStep })).status, 400);
});

test('S4 문자 갈래(주문·공정 후 N일 문자·MMS·plain)는 종전대로 sms_auto_sends 회차 1, 이벤트 표는 건드리지 않는다', async () => {
  reset();
  const db = fakeDb({ templates: { 7: tplRow({ auto_days: 0 }), 9: tplRow({ auto_kind: 'process_started_plus_days', auto_step: '도면설계', auto_days: 1 }) } });
  const a = await autoMarkSent({ template_id: 7, phones: [P1, P2] }, { db });
  assert.deepEqual([a.status, a.body.via, a.body.inserted], [200, 'auto', 2]);
  const b = await autoMarkSent({ template_id: 9, phones: [P1] }, { db });
  assert.deepEqual([b.status, b.body.via, b.body.inserted], [200, 'auto', 1]);
  assert.ok(db.state.autoRows.every(r => r.round === 1 && r.status === 'sent' && r.kst_date === '1970-01-01'));
  assert.deepEqual(db.state.autoRows.filter(r => r.template_id === 7).map(r => r.phone_hash).sort(), [phoneHash(P1), phoneHash(P2)].sort());
  assert.equal(db.state.eventRows.length, 0);
});

test('S4 unsupported_kind: 가입·문의 후 N일(lead_plus_days)·납기일(due_date)·그 밖 안내 조건은 거절하고 아무것도 기록하지 않는다', async () => {
  reset();
  const db = fakeDb({ templates: {
    30: tplRow({ body: INFO, auto_kind: 'lead_plus_days', auto_days: 5, auto_msg_type: 'info', auto_ata_template: 'BMS_FREE', auto_chain: null }),
    31: tplRow({ body: INFO, auto_kind: 'due_date', auto_msg_type: 'info', auto_chain: null }),
    32: tplRow({ body: INFO, auto_kind: 'order_created', auto_audience: 'staff', auto_msg_type: 'info', auto_chain: null }),
  } });
  for (const id of [30, 31, 32]) {
    const out = await autoMarkSent({ template_id: id, phones: [P1] }, { db });
    assert.equal(out.status, 400, `문구 ${id}`);
    assert.equal(out.body.ok, false); assert.equal(out.body.error, 'unsupported_kind');
  }
  assert.equal(db.state.eventRows.length, 0); assert.equal(db.state.autoRows.length, 0);
});

test('S4 실패 행은 sent 로 고치고, 번호 형식 오류·중복은 세어 건너뛴다(주문 단위 키 갈래)', async () => {
  reset();
  const hash = eventPhoneHash(P1);
  const db = fakeDb({ templates: { 23: tplRow({ body: INFO, auto_kind: 'order_created', auto_msg_type: 'info', auto_chain: null }) }, orders: [ord(5, P1)], eventRows: [{ template_id: 23, dedupe_key: `${hash}:5:order_created`, status: 'failed' }] });
  const out = await autoMarkSent({ template_id: 23, phones: ['010-1111-2222', P1, '123'] }, { db });
  assert.deepEqual([out.body.inserted, out.body.updated_failed, out.body.invalid, out.body.duplicated_in_request], [0, 1, 1, 1]);
  assert.equal(db.state.eventRows[0].status, 'sent');
});
