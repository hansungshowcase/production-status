import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { handleSmsConsole } from '../api/sms-console.js';
import { _resetTextTemplateSchemaForTest, saveTextTemplate } from '../api/_lib/smsTextTemplates.js';
import { _resetEventSchemaForTest, fillVars, orderVars, runEventSend, runInstantSendAll } from '../api/_lib/smsEventSend.js';

const NOW = Date.parse('2026-11-20T01:00:00Z'); // KST 2026-11-20 10:00
const NIGHT = Date.parse('2026-11-19T15:30:00Z'); // KST 11-20 00:30
const ENV = { SMS_SENDER: '0212345678' };
const STAFF = [{ id: 's1', name: '직원A', phone: '01011112222' }, { id: 's2', name: '직원B', phone: '01033334444' }];
const CUSTOMER_BODY = '#{고객명}님, 주문 #{주문번호}(#{규격}, #{수량}) 출고 예정일은 #{예상출고일} 입니다. #{조회링크}';

const mkOrder = (id, extra = {}) => ({
  id, phone: `0100000000${id}`, client_name: `고객${id}`, status: 'in_production', order_date: '2026-11-01', due_date: '2026-11-23', ship_scheduled_date: null,
  product_type: '쇼케이스', door_type: '슬라이딩', width: 1200, depth: 600, height: 1800, quantity: 1, ...extra,
});

function fakeDb({ orders = [], processes = [], templates = [] } = {}) {
  const state = { orders, processes, sends: [], nextId: 1, sql: [], templates };
  return {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      state.sql.push(t);
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.includes('FROM orders o WHERE')) {
        assert.ok(t.includes("o.status = 'in_production'"));
        const column = /LEFT\(o\.(\w+), 10\)/.exec(t)[1];
        let rows = state.orders.filter(o => o.status === 'in_production' && o[column] && o[column].slice(0, 10) === args[0]);
        if (t.includes('p.step_name = ?')) rows = rows.filter(o => state.processes.some(p => p.order_id === o.id && p.step_name === args[1] && p.status !== 'completed'));
        return { rows };
      }
      if (t.startsWith('SELECT id, track_token FROM orders')) return { rows: args.map(id => ({ id, track_token: id === 1 ? 'TOK1' : null })) };
      if (t.startsWith('SELECT dedupe_key FROM sms_event_sends')) return { rows: state.sends.filter(r => r.template_id === args[0]).map(r => ({ dedupe_key: r.dedupe_key })) };
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_event_sends WHERE kst_date')) return { rows: [{ n: state.sends.filter(r => r.kst_date === args[0]).length }] };
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
      if (t.startsWith('UPDATE sms_event_sends SET status = ?')) {
        const [status, , , , ...ids] = args;
        for (const r of state.sends.filter(x => ids.includes(x.id))) r.status = status;
        return { rows: [] };
      }
      if (t.startsWith('SELECT id FROM sms_text_templates WHERE name')) return { rows: state.templates.filter(r => r.name === args[0]) };
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_text_templates')) return { rows: [{ n: state.templates.length }] };
      if (t.startsWith('SELECT id FROM sms_text_templates WHERE id')) return { rows: state.templates.filter(r => r.id === args[0]) };
      if (t.startsWith('INSERT INTO sms_text_templates')) {
        const cols = /\(([^)]*)\) VALUES/.exec(t)[1].split(',').map(c => c.trim());
        const row = { id: state.templates.length + 1, auto_enabled: false };
        cols.forEach((c, i) => { row[c] = args[i]; });
        state.templates.push(row); return { rows: [{ id: row.id }] };
      }
      if (t.startsWith('UPDATE sms_text_templates SET name = ?, body = ?, auto_enabled = false WHERE id = ?')) {
        const row = state.templates.find(r => r.id === args[2]);
        const changed = row.body !== args[3] || (row.auto_offset ?? 0) !== args[9] || (row.auto_unless_step ?? null) !== args[10] || (row.auto_audience ?? 'customer') !== args[11] || (row.auto_staff ?? null) !== args[12];
        if (row.auto_enabled && changed) { row.auto_enabled = false; return { rows: [{ id: row.id, auto_kind: row.auto_kind }] }; }
        return { rows: [] };
      }
      if (t.startsWith('UPDATE sms_text_templates SET')) {
        const sets = t.slice('UPDATE sms_text_templates SET '.length, t.indexOf(', updated_at')).split(', ');
        const row = state.templates.find(r => r.id === args[args.length - 1]);
        let k = 0;
        for (const part of sets) { const [col, val] = part.split(' = '); if (val === '?') row[col] = args[k++]; else if (val === 'false') row[col] = false; }
        return { rows: [{ id: row.id, auto_kind: row.auto_kind }] };
      }
      throw new Error(`예상 못 한 SQL ${t}`);
    },
  };
}
function fakeProvider() {
  const calls = { upload: [], send: [] };
  return {
    calls,
    async uploadImage(input) { calls.upload.push(input); return { fileId: 'F1' }; },
    async sendEach(input) { calls.send.push(input); return { accepted: input.messages.length, failed: 0, groupId: `G${calls.send.length}`, uncertain: false, error: '' }; },
  };
}
const tpl = (extra = {}) => ({ id: 5, name: '납기 안내', body: CUSTOMER_BODY, images: [], auto_kind: 'due_date', auto_enabled: true, auto_offset: -3, auto_unless_step: '', auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', ...extra });
const go = (db, provider, template, extra = {}) => { _resetEventSchemaForTest(); return runEventSend(template, { db, provider, env: ENV, nowMs: NOW, staff: STAFF, warn() {}, ...extra }); };

test('납기 3일 전 + 미완료 공정: 용접작업이 아직 안 끝난 진행 중 주문에만, cancelled·shipped 는 제외, 다시 돌려도 0', async () => {
  const db = fakeDb({
    orders: [mkOrder(1), mkOrder(2), mkOrder(3, { status: 'cancelled' }), mkOrder(4, { status: 'shipped' }), mkOrder(5, { due_date: '2026-11-24' })],
    processes: [{ order_id: 1, step_name: '용접작업', status: 'waiting' }, { order_id: 2, step_name: '용접작업', status: 'completed' }, { order_id: 3, step_name: '용접작업', status: 'waiting' }, { order_id: 4, step_name: '용접작업', status: 'waiting' }, { order_id: 5, step_name: '용접작업', status: 'waiting' }],
  });
  const provider = fakeProvider();
  const out = await go(db, provider, tpl({ auto_unless_step: '용접작업' }));
  assert.equal(out.claimed, 1);
  assert.deepEqual(provider.calls.send[0].messages.map(m => m.to), ['01000000001']);
  assert.equal((await go(db, provider, tpl({ auto_unless_step: '용접작업' }))).claimed, 0);
  assert.equal(provider.calls.send.length, 1);
});

test('직원 2명에게 같은 주문 알림이 각각 1번, 다시 돌려도(다음 날 포함) 중복 없음', async () => {
  const db = fakeDb({ orders: [mkOrder(1)] });
  const provider = fakeProvider();
  const staffTpl = tpl({ auto_audience: 'staff', auto_staff: ['s1', 's2'], body: '#{제품} #{주문번호} 납기 #{예상출고일}' });
  const first = await go(db, provider, staffTpl);
  assert.equal(first.claimed, 2);
  assert.deepEqual(provider.calls.send[0].messages.map(m => m.to).sort(), ['01011112222', '01033334444']);
  assert.ok(provider.calls.send[0].messages[0].text.startsWith('쇼케이스 HS-2026-0001'));
  assert.equal((await go(db, provider, staffTpl)).claimed, 0);
  assert.equal((await go(db, provider, staffTpl, { nowMs: NOW + 86400000 })).claimed, 0);
  assert.equal(db.state.sends.length, 2);
  assert.equal(provider.calls.send.length, 1);
});

test('고객 안내는 수신거부·오늘 이미 나간 광고·광고 형식 검사를 적용하지 않는다', async () => {
  const db = fakeDb({ orders: [mkOrder(1)] });
  db.state.sends.push({ id: 99, template_id: 9, dedupe_key: 'x', kst_date: '2026-11-20', status: 'sent' }); // 같은 날 다른 문구가 이미 나갔어도
  const provider = fakeProvider();
  const out = await go(db, provider, tpl());
  assert.equal(out.claimed, 1);
  assert.equal(db.state.sql.some(s => /sms_optouts|sms_auto_sends/.test(s)), false);
  assert.equal(provider.calls.send[0].messages[0].text.includes('(광고)'), false);
});

test('저장 검사: 고객 안내에 광고 낱말·주문 변수 없음은 400(reason), 직원 대상은 검사 없음, 직원 0명은 400', async () => {
  const db = fakeDb();
  _resetTextTemplateSchemaForTest();
  const auto = { kind: 'due_date', offset: -3, audience: 'customer' };
  const adWord = await saveTextTemplate(db, { name: 'a', body: '#{주문번호} 할인 안내', auto }, { staff: STAFF });
  assert.deepEqual([adWord.status, adWord.body.reason], [400, 'info_has_ad_words']);
  const noVar = await saveTextTemplate(db, { name: 'b', body: '납기가 다가옵니다', auto }, { staff: STAFF });
  assert.deepEqual([noVar.status, noVar.body.reason], [400, 'info_needs_order_var']);
  assert.equal((await saveTextTemplate(db, { name: 'c', body: '납기가 다가옵니다', auto: { ...auto, audience: 'staff', staff: [] } }, { staff: STAFF })).status, 400);
  assert.equal((await saveTextTemplate(db, { name: 'd', body: '납기 임박', auto: { ...auto, audience: 'staff', staff: ['s1', 's2'], unless_step: '용접작업' } }, { staff: STAFF })).status, 201);
  assert.equal((await saveTextTemplate(db, { name: 'e', body: '#{주문번호}', auto: { ...auto, unless_step: '없는공정' } }, { staff: STAFF })).status, 400);
  const saved = await saveTextTemplate(db, { name: 'f', body: '#{주문번호} 납기', auto }, { staff: STAFF });
  assert.equal(saved.status, 201);
  assert.deepEqual([saved.body.item.auto_msg_type, saved.body.item.auto_offset, saved.body.item.auto_audience, saved.body.item.auto_days], ['info', -3, 'customer', 0]);
  // 광고 종류는 항상 광고·고객으로 저장(다른 값이 와도 무시)
  const ad = await saveTextTemplate(db, { name: 'g', body: '(광고) x 무료수신거부 080-123-4567', auto: { kind: 'ship_plus_days', days: 20, audience: 'staff', staff: ['s1'], msg_type: 'info', offset: 5 } }, { staff: STAFF });
  assert.deepEqual([ad.body.item.auto_msg_type, ad.body.item.auto_audience, ad.body.item.auto_offset], ['ad', 'customer', 0]);
});

test('변수 치환: 주문 변수 채움, 값의 #{ } 제거, 고객용은 제품 변수 없음', () => {
  const order = mkOrder(1, { client_name: '김#{철}수', quantity: 3 });
  const vars = orderVars(order, 'customer', 'https://x/track/T');
  assert.equal(vars.고객명, '김철수');
  assert.equal(fillVars(CUSTOMER_BODY, vars), '김철수님, 주문 HS-2026-0001(슬라이딩 1200×600×1800mm, 3대) 출고 예정일은 2026-11-26 입니다. https://x/track/T');
  assert.equal(fillVars('#{제품}', vars), '#{제품}');
  assert.equal(fillVars('#{제품}', orderVars(order, 'staff')), '쇼케이스');
});

test('켜진 안내 문구의 새 칸(offset·공정·받는 사람·직원)이 바뀌면 꺼진다', async () => {
  const db = fakeDb();
  _resetTextTemplateSchemaForTest();
  const auto = { kind: 'due_date', offset: -3, audience: 'staff', staff: ['s1'], unless_step: '' };
  const id = (await saveTextTemplate(db, { name: '직원 납기', body: '납기 임박', auto }, { staff: STAFF })).body.item.id;
  for (const change of [{ offset: -2 }, { unless_step: '포장' }, { audience: 'customer' }, { staff: ['s1', 's2'] }]) {
    db.state.templates.find(r => r.id === id).auto_enabled = true;
    const body = change.audience === 'customer' ? '#{주문번호} 납기' : '납기 임박';
    const saved = await saveTextTemplate(db, { id, name: '직원 납기', body, auto: { ...auto, ...change } }, { staff: STAFF });
    assert.equal(saved.body.item.auto_enabled, false, JSON.stringify(change));
    assert.equal(saved.body.item.auto_disabled, true);
    await saveTextTemplate(db, { id, name: '직원 납기', body: '납기 임박', auto }, { staff: STAFF });
  }
});

test('야간·꺼짐이면 아무 동작도 안 한다(조회·선점·업로드·발송 0)', async () => {
  const db = fakeDb({ orders: [mkOrder(1)] });
  const provider = fakeProvider();
  const night = await go(db, provider, tpl({ images: ['AAAA'] }), { nowMs: NIGHT });
  assert.equal(night.reason, 'night');
  const off = await go(db, provider, tpl({ auto_enabled: false }));
  assert.equal(off.reason, 'off');
  assert.equal(db.state.sql.length, 0);
  assert.equal(provider.calls.upload.length + provider.calls.send.length + db.state.sends.length, 0);
});

test('order_plus_days 대상에서 cancelled 제외 · api auto_meta · 생산 표 쓰기 없음 · vercel.json 크론 불변', async () => {
  const auto = fs.readFileSync(new URL('../api/_lib/smsAutoSend.js', import.meta.url), 'utf8');
  assert.ok(auto.includes("COALESCE(status, '') <> 'cancelled'"));
  const code = ['api/_lib/smsEventSend.js', 'api/cron/sms-auto.js'].map(f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');
  assert.equal(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE)\s+(orders|processes|notification_log)\b/i.test(code), false);
  const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(vercel.crons.length, 10); // 2단계-나: 즉시형 크론 1줄 추가
  assert.deepEqual(vercel.crons[8], { path: '/api/cron/sms-auto', schedule: '0 1 * * *' });
  const res = { code: 0, body: null, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() {}, end() {} };
  await handleSmsConsole({ method: 'GET', query: { resource: 'auto_meta' }, headers: {} }, res, { staff: STAFF, db: fakeDb() });
  assert.equal(res.code, 200);
  assert.equal(res.body.steps.length, 10);
  assert.deepEqual(res.body.staff, [{ id: 's1', name: '직원A' }, { id: 's2', name: '직원B' }]);
});

test('쓸 수 없는 변수: 고객 본문의 #{제품}·모르는 변수는 거절, 직원 본문의 #{제품}은 통과', async () => {
  const { infoCheck } = await import('../api/_lib/smsTextTemplates.js');
  assert.equal(infoCheck('#{주문번호} #{제품}', 'customer'), 'info_unknown_var');
  assert.equal(infoCheck('#{주문번호} #{없는변수}', 'customer'), 'info_unknown_var');
  assert.equal(infoCheck('#{주문번호} 안내', 'customer'), '');
  assert.equal(infoCheck('#{제품} #{주문번호}', 'staff'), '');
  assert.equal(infoCheck('#{없는변수}', 'staff'), 'info_unknown_var');
});

// ---- 2단계-나: 즉시형(주문 등록 시·공정 시작/완료 시) ----
const ENABLED_AT = '2026-11-20T00:00:00.000Z'; // KST 09:00 에 켬
const INSTANT_BODY = '#{주문번호} 포장 완료 안내 #{조회링크}';
function instantDb({ orders = [], processes = [], templates = [] } = {}) {
  const db = fakeDb({ orders, processes, templates });
  const base = db.execute.bind(db);
  db.execute = async ({ sql, args }) => {
    const t = sql.replace(/\s+/g, ' ').trim();
    if (t.includes('FROM orders o WHERE o.created_at >= ?')) {
      db.state.sql.push(t);
      return { rows: db.state.orders.filter(o => o.created_at && o.created_at >= args[0] && o.created_at <= args[1] && o.status !== 'cancelled') };
    }
    if (t.includes('FROM processes p JOIN orders o')) {
      db.state.sql.push(t);
      const column = /p\.(started_at|completed_at) IS NOT NULL/.exec(t)[1];
      const ids = new Set(db.state.processes.filter(p => p.step_name === args[0] && p[column] && p[column] >= args[1] && p[column] <= args[2]).map(p => p.order_id));
      return { rows: db.state.orders.filter(o => ids.has(o.id) && o.status !== 'cancelled') };
    }
    if (t.startsWith('SELECT dedupe_key FROM sms_event_sends WHERE template_id = ? AND dedupe_key IN')) {
      db.state.sql.push(t);
      return { rows: db.state.sends.filter(r => r.template_id === args[0] && args.slice(1).includes(r.dedupe_key)).map(r => ({ dedupe_key: r.dedupe_key })) };
    }
    if (t.startsWith('SELECT id FROM sms_text_templates WHERE auto_enabled = true')) {
      db.state.sql.push(t);
      return { rows: db.state.templates.filter(r => r.auto_enabled && ['order_created', 'process_started', 'process_completed'].includes(r.auto_kind)).map(r => ({ id: r.id })) };
    }
    if (t.startsWith('SELECT id, name, body, image, images, auto_kind, auto_enabled, auto_offset')) { db.state.sql.push(t); return { rows: db.state.templates.filter(r => r.id === args[0]) }; }
    if (t.startsWith("UPDATE sms_event_sends SET status = 'uncertain'")) { db.state.sql.push(t); return { rows: [] }; }
    if (t.startsWith('UPDATE sms_text_templates SET name = ?, body = ?, auto_enabled = false WHERE id = ?')) {
      db.state.sql.push(t);
      const row = db.state.templates.find(r => r.id === args[2]);
      assert.ok(t.includes('auto_step IS DISTINCT FROM ?'));
      if (row.auto_enabled && (row.body !== args[3] || (row.auto_step ?? null) !== args[13])) { row.auto_enabled = false; return { rows: [{ id: row.id, auto_kind: row.auto_kind }] }; }
      return { rows: [] };
    }
    return base({ sql, args });
  };
  return db;
}
const itpl = (extra = {}) => ({ id: 7, name: '포장 완료', body: INSTANT_BODY, images: [], auto_kind: 'process_completed', auto_enabled: true, auto_step: '포장', auto_enabled_at: ENABLED_AT, auto_offset: 0, auto_unless_step: '', auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', ...extra });

test('즉시형 ① 공정 완료 사건: 켠 시각 이후 것만 나가고, 두 번 돌려도 1번', async () => {
  const db = instantDb({
    orders: [mkOrder(1), mkOrder(2), mkOrder(3)],
    processes: [
      { order_id: 1, step_name: '포장', status: 'completed', completed_at: '2026-11-20T00:30:00.000Z' }, // 켠 뒤
      { order_id: 2, step_name: '포장', status: 'completed', completed_at: '2026-11-19T23:00:00.000Z' }, // 켜기 전
      { order_id: 3, step_name: '조립작업', status: 'completed', completed_at: '2026-11-20T00:30:00.000Z' }, // 다른 공정
    ],
  });
  const provider = fakeProvider();
  const out = await go(db, provider, itpl());
  assert.equal(out.claimed, 1);
  assert.deepEqual(provider.calls.send[0].messages.map(m => m.to), ['01000000001']);
  assert.ok(provider.calls.send[0].messages[0].text.startsWith('HS-2026-0001'));
  assert.equal((await go(db, provider, itpl())).claimed, 0);
  assert.equal(provider.calls.send.length, 1);
  assert.match(db.state.sends[0].dedupe_key, /:1:process_completed$/);
});

test('즉시형 ② 야간에는 무동작, 아침 첫 실행에서 야간에 생긴 사건이 나간다', async () => {
  const db = instantDb({
    orders: [mkOrder(1)],
    processes: [{ order_id: 1, step_name: '포장', status: 'completed', completed_at: '2026-11-19T15:10:00.000Z' }], // KST 00:10
    templates: [itpl({ auto_enabled_at: '2026-11-19T00:00:00.000Z' })],
  });
  const provider = fakeProvider();
  const night = await go(db, provider, itpl({ auto_enabled_at: '2026-11-19T00:00:00.000Z' }), { nowMs: NIGHT });
  assert.equal(night.reason, 'night');
  assert.equal(provider.calls.send.length + db.state.sends.length, 0);
  const quiet = await runInstantSendAll({ db, provider, env: ENV, nowMs: NIGHT, staff: STAFF }); // 야간 크론: 켜진 문구 SELECT 만
  assert.equal(quiet.templates, 0);
  _resetEventSchemaForTest();
  const total = await runInstantSendAll({ db, provider, env: ENV, nowMs: Date.parse('2026-11-19T23:10:00Z'), staff: STAFF, warn() {} }); // KST 08:10
  assert.equal(total.claimed, 1);
  assert.equal(provider.calls.send.length, 1);
});

test('즉시형 ③ 켜진 즉시형 문구가 없으면 SELECT 1번으로 끝난다', async () => {
  const db = instantDb({ orders: [mkOrder(1)], templates: [itpl({ auto_enabled: false }), itpl({ id: 8, auto_kind: 'due_date' })] });
  const provider = fakeProvider();
  const total = await runInstantSendAll({ db, provider, env: ENV, nowMs: NOW });
  assert.equal(total.templates, 0);
  assert.equal(db.state.sql.length, 1);
  assert.ok(db.state.sql[0].startsWith('SELECT id FROM sms_text_templates WHERE auto_enabled = true'));
  assert.equal(provider.calls.send.length, 0);
});

test('즉시형 ④ cancelled 주문·되돌려진(시각 없음) 공정은 제외, 주문 등록 시는 created_at 창 안만', async () => {
  const db = instantDb({
    orders: [mkOrder(1), mkOrder(2, { status: 'cancelled' }), mkOrder(3)],
    processes: [
      { order_id: 1, step_name: '포장', status: 'in_progress', completed_at: null },
      { order_id: 2, step_name: '포장', status: 'completed', completed_at: '2026-11-20T00:30:00.000Z' },
      { order_id: 3, step_name: '포장', status: 'completed', completed_at: '2026-11-20T00:40:00.000Z' },
    ],
  });
  const provider = fakeProvider();
  assert.equal((await go(db, provider, itpl())).claimed, 1);
  assert.deepEqual(provider.calls.send[0].messages.map(m => m.to), ['01000000003']);
  const created = instantDb({ orders: [mkOrder(1, { created_at: '2026-11-20T00:30:00.000Z' }), mkOrder(2, { created_at: '2026-11-20T00:31:00.000Z', status: 'cancelled' }), mkOrder(3, { created_at: '2026-11-19T23:00:00.000Z' }), mkOrder(4, { created_at: null })] });
  const p2 = fakeProvider();
  assert.equal((await go(created, p2, itpl({ auto_kind: 'order_created', auto_step: '' }))).claimed, 1);
  assert.deepEqual(p2.calls.send[0].messages.map(m => m.to), ['01000000001']);
});

test('즉시형 ⑤ 저장하면 항상 안내(info)로 저장, 공정 없는 process_* 는 400, 직원 대상 가능', async () => {
  const db = instantDb();
  _resetTextTemplateSchemaForTest();
  const ok = await saveTextTemplate(db, { name: '포장 안내', body: INSTANT_BODY, auto: { kind: 'process_completed', step: '포장', msg_type: 'ad', days: 5, offset: 3 } }, { staff: STAFF });
  assert.equal(ok.status, 201);
  assert.deepEqual([ok.body.item.auto_msg_type, ok.body.item.auto_step, ok.body.item.auto_offset, ok.body.item.auto_days], ['info', '포장', 0, 0]);
  assert.equal((await saveTextTemplate(db, { name: '무공정', body: INSTANT_BODY, auto: { kind: 'process_started' } }, { staff: STAFF })).status, 400);
  assert.equal((await saveTextTemplate(db, { name: '엉뚱공정', body: INSTANT_BODY, auto: { kind: 'process_started', step: '없는공정' } }, { staff: STAFF })).status, 400);
  const created = await saveTextTemplate(db, { name: '주문 안내', body: '#{주문번호} 접수', auto: { kind: 'order_created', step: '포장', audience: 'staff', staff: ['s1'] } }, { staff: STAFF });
  assert.deepEqual([created.status, created.body.item.auto_msg_type, created.body.item.auto_step], [201, 'info', undefined]);
  assert.equal((await saveTextTemplate(db, { name: '광고낱말', body: '#{주문번호} 할인', auto: { kind: 'order_created' } }, { staff: STAFF })).body.reason, 'info_has_ad_words');
});

test('즉시형 ⑥ 켜진 문구의 공정을 바꾸면 꺼지고, 켜기는 켠 시각을 NOW() 로 적고 overlap 은 기존 알림과 같은 조건만 true', async () => {
  const db = instantDb();
  _resetTextTemplateSchemaForTest();
  const auto = { kind: 'process_completed', step: '포장' };
  const id = (await saveTextTemplate(db, { name: '포장 안내', body: INSTANT_BODY, auto }, { staff: STAFF })).body.item.id;
  db.state.templates.find(r => r.id === id).auto_enabled = true;
  const saved = await saveTextTemplate(db, { id, name: '포장 안내', body: INSTANT_BODY, auto: { ...auto, step: '조립작업' } }, { staff: STAFF });
  assert.deepEqual([saved.body.item.auto_enabled, saved.body.item.auto_disabled, saved.body.item.auto_step], [false, true, '조립작업']);
  const { eventToggleOn } = await import('../api/_lib/smsEventSend.js');
  const dry = (extra, tail = {}) => eventToggleOn({ dry_run: true }, itpl({ auto_enabled: false, ...extra }), { db, provider: { ...fakeProvider(), estimate: () => ({ total: 0 }) }, env: ENV, nowMs: NOW, staff: STAFF, ...tail });
  assert.deepEqual([(await dry({})).body.targets, (await dry({})).body.overlap], [0, true]);
  assert.equal((await dry({ auto_audience: 'staff', auto_staff: ['s1'] })).body.overlap, false);
  assert.equal((await dry({ auto_audience: 'staff', auto_staff: ['s1'], auto_step: 'V-커팅작업' })).body.overlap, true);
  assert.equal((await dry({ auto_step: '조립작업' })).body.overlap, false);
  const seen = [];
  const res = await eventToggleOn({}, itpl({ auto_enabled: false }), { db: { async execute(q) { seen.push(q.sql); return { rows: [] }; } }, env: ENV, nowMs: NOW });
  assert.equal(res.status, 200);
  assert.ok(seen[0].includes('auto_enabled_at = NOW()'));
});

// ---- 2단계-다: 켜기 전 미리 보기 건수 + 공정 시각 형식(Z 까지) ----
test('즉시형 다① 켜기 전 dry_run·현황 targets 는 최근 24시간 후보 수(읽기만, 기록 INSERT 없음)', async () => {
  const { eventToggleOn, eventStatus } = await import('../api/_lib/smsEventSend.js');
  const db = instantDb({
    orders: [mkOrder(1), mkOrder(2), mkOrder(3)],
    processes: [
      { order_id: 1, step_name: '포장', status: 'completed', completed_at: '2026-11-19T05:00:00.000Z' }, // 24시간 안
      { order_id: 2, step_name: '포장', status: 'completed', completed_at: '2026-11-19T00:30:00.000Z' }, // 24시간 밖
      { order_id: 3, step_name: '포장', status: 'completed', completed_at: '2026-11-20T00:30:00.000Z' }, // 24시간 안
    ],
  });
  const tpl = itpl({ auto_enabled: false, auto_enabled_at: null });
  const inner = db.execute;
  db.execute = async q => (/GROUP BY status|AND status = 'sent'|COUNT\(\*\) AS n FROM sms_event_sends/.test(q.sql) ? { rows: [] } : inner(q)); // 현황의 합계 조회만 빈 값
  const dry = await eventToggleOn({ dry_run: true }, tpl, { db, provider: { ...fakeProvider(), estimate: () => ({ total: 0 }) }, env: ENV, nowMs: NOW, staff: STAFF });
  assert.equal(dry.body.targets, 2);
  _resetEventSchemaForTest();
  assert.equal((await eventStatus(db, tpl, { nowMs: NOW, env: ENV, staff: STAFF })).body.today_targets, 2);
  assert.equal(db.state.sends.length, 0);
});

test('즉시형 다② Z 로 끝나지 않는 공정 시각은 대상에서 빠진다(SQL 형식 검사)', async () => {
  const db = instantDb({
    orders: [mkOrder(1), mkOrder(2)],
    processes: [
      { order_id: 1, step_name: '포장', status: 'completed', completed_at: '2026-11-20T00:30:00.000Z' },
      { order_id: 2, step_name: '포장', status: 'completed', completed_at: '2026-11-20T00:40:00' }, // Z 없음
    ],
  });
  const inner = db.execute;
  db.execute = async q => { // 가짜 DB 가 SQL 의 정규식을 그대로 적용하게 한다
    const out = await inner(q);
    const m = /p\.completed_at ~ '([^']+)'/.exec(q.sql);
    if (!m) return out;
    const re = new RegExp(m[1].replace(/\[0-9\]/g, '\\d'));
    const ok = new Set(db.state.processes.filter(p => re.test(p.completed_at || '')).map(p => p.order_id));
    return { rows: (out.rows || []).filter(r => ok.has(r.id)) };
  };
  const provider = fakeProvider();
  assert.equal((await go(db, provider, itpl())).claimed, 1);
  assert.deepEqual(provider.calls.send[0].messages.map(m => m.to), ['01000000001']);
  assert.ok(db.state.sql.some(s => s.includes("Z$'")));
});
