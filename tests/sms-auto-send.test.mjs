import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { handleSmsConsole } from '../api/sms-console.js';
import { _resetTextTemplateSchemaForTest, getTextTemplate, saveTextTemplate } from '../api/_lib/smsTextTemplates.js';
import { _resetManualSendSchemaForTest } from '../api/_lib/smsManualSend.js';
import {
  _resetAutoSchemaForTest, adCheck, autoStatus, autoToggle, autoTest, buildParts, findTargets, kstDate, optoutAdd, phoneHash, runAutoSend, runAutoSendAll,
} from '../api/_lib/smsAutoSend.js';
import { getSendProvider } from '../api/_lib/sendProvider.js';

const JPG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 1, 2, 3]).toString('base64');
const BODY = '(광고) 한성쇼케이스\n#{고객명} 대표님, 쇼케이스는 잘 쓰고 계신가요?\n무료수신거부 080-123-4567';
// KST 2026-11-20 10:00
const NOW = Date.parse('2026-11-20T01:00:00Z');
const NIGHT = Date.parse('2026-11-19T15:30:00Z'); // KST 11-20 00:30
const ENV = { SMS_SENDER: '0212345678' };

// 2026-11-20 기준 days=20 → 출고일 2026-10-31 이 오늘 대상(창은 10-28 ~ 10-31)
function fakeDb({ template = {}, orders = [], optouts = [], beforeInsert } = {}) {
  const state = {
    tpl: { id: 7, name: '소개 혜택 안내', body: BODY, image: null, images: JSON.stringify([JPG, JPG]), auto_kind: 'ship_plus_days', auto_days: 20, auto_enabled: true, auto_start_date: '2026-10-01', ...template },
    templates: [], orders, optouts: optouts.map(phoneHash), sends: [], nextId: 1, sql: [], manual: [], tplNext: 1,
  };
  const db = {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      state.sql.push(t);
      if (/^(CREATE TABLE|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT id, name, body, image, images, auto_kind, auto_days, auto_enabled, auto_start_date FROM sms_text_templates')) return { rows: args[0] === state.tpl.id ? [state.tpl] : [] };
      if (t.startsWith('SELECT id, name, body, image, images, auto_kind, auto_days, auto_enabled FROM sms_text_templates')) return { rows: state.templates.filter(r => r.id === args[0]) };
      if (t.startsWith("SELECT id FROM sms_text_templates WHERE auto_enabled = true")) return { rows: state.tpl.auto_enabled ? [{ id: state.tpl.id }] : [] };
      if (t.includes('FROM orders')) return { rows: state.orders.filter(o => o.status === 'shipped' && o.ship_date.slice(0, 10) >= args[0] && o.ship_date.slice(0, 10) <= args[1]).map(o => ({ id: o.id, phone: o.phone, client_name: o.client_name, ship_day: o.ship_date.slice(0, 10) })) };
      if (t.startsWith('SELECT phone_hash FROM sms_optouts')) return { rows: state.optouts.map(phone_hash => ({ phone_hash })) };
      if (t.startsWith('SELECT phone_hash, order_id FROM sms_auto_sends')) return { rows: state.sends.filter(r => r.template_id === args[0]) };
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_auto_sends WHERE kst_date')) return { rows: [{ n: state.sends.filter(r => r.kst_date === args[0]).length }] };
      if (t.startsWith('SELECT status, COUNT(*) AS n')) {
        const by = {};
        for (const r of state.sends.filter(x => x.template_id === args[0])) { by[r.status] = by[r.status] || { status: r.status, n: 0, last: '' }; by[r.status].n += 1; if (r.kst_date > by[r.status].last) by[r.status].last = r.kst_date; }
        return { rows: Object.values(by) };
      }
      if (t.startsWith("SELECT COUNT(*) AS n FROM sms_auto_sends WHERE template_id = ? AND status = 'sent'")) return { rows: [{ n: state.sends.filter(r => r.template_id === args[0] && r.status === 'sent' && r.kst_date >= args[1]).length }] };
      if (t.startsWith('INSERT INTO sms_auto_sends')) {
        beforeInsert?.(state);
        const rows = [];
        for (let i = 0; i < args.length; i += 6) {
          const [template_id, phone_hash, , order_id, , kst_date] = args.slice(i, i + 6);
          if (state.sends.some(r => r.template_id === template_id && (r.phone_hash === phone_hash || r.order_id === order_id))) continue;
          const row = { id: state.nextId++, template_id, phone_hash, order_id, kst_date, status: 'claimed' };
          state.sends.push(row); rows.push({ id: row.id, phone_hash });
        }
        return { rows };
      }
      if (t.startsWith("DELETE FROM sms_auto_sends WHERE status = 'claimed'")) { state.sends = state.sends.filter(r => !args.includes(r.id)); return { rows: [] }; }
      if (t.startsWith('UPDATE sms_auto_sends SET status = ?, part_status')) {
        const [status, part_status, reason, group_ids, ...ids] = args;
        for (const r of state.sends.filter(x => ids.includes(x.id))) Object.assign(r, { status, part_status, reason, group_ids });
        return { rows: [] };
      }
      if (t.startsWith("UPDATE sms_auto_sends SET status = 'uncertain'")) { for (const r of state.sends.filter(x => x.status === 'claimed' && x.kst_date < args[0])) r.status = 'uncertain'; return { rows: [] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_enabled = true, auto_start_date')) { state.tpl.auto_enabled = true; state.tpl.auto_start_date = args[0]; return { rows: [{ id: 7 }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_enabled = false WHERE id')) { state.tpl.auto_enabled = false; return { rows: [{ id: 7 }] }; }
      if (t.startsWith('INSERT INTO sms_optouts')) { if (state.optouts.includes(args[0])) return { rows: [] }; state.optouts.push(args[0]); (state.optoutRows ||= []).push({ id: state.optouts.length, phone_last4: args[1], created_at: '2026-11-20T01:00:00Z' }); return { rows: [{ id: state.optouts.length }] }; }
      if (t.startsWith('SELECT id, phone_last4, created_at FROM sms_optouts')) return { rows: state.optoutRows || [] };
      if (t.includes('FROM sms_manual_sends WHERE sent_at')) return { rows: [{ n: state.manual.reduce((a, r) => a + r.recipient_count, 0) }] };
      if (t.startsWith('INSERT INTO sms_manual_sends')) { if (state.manual.some(r => r.idem_key === args[0])) return { rows: [] }; state.manual.push({ idem_key: args[0], recipient_count: args[2] }); return { rows: [{ id: state.manual.length }] }; }
      if (t.startsWith('SELECT status, recipient_count FROM sms_manual_sends')) return { rows: state.manual.filter(r => r.idem_key === args[0]).map(r => ({ status: 'sent', recipient_count: r.recipient_count })) };
      if (t.startsWith('UPDATE sms_manual_sends')) return { rows: [] };
      // sms_text_templates 저장(문구 저장 함수 시험용)
      if (t.startsWith('SELECT id FROM sms_text_templates WHERE name')) return { rows: state.templates.filter(r => r.name === args[0]) };
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_text_templates')) return { rows: [{ n: state.templates.length }] };
      if (t.startsWith('INSERT INTO sms_text_templates')) {
        const cols = /\(([^)]*)\) VALUES/.exec(t)[1].split(',').map(c => c.trim());
        const row = { id: state.tplNext++, auto_enabled: false };
        cols.forEach((c, i) => { row[c] = args[i]; });
        state.templates.push(row); return { rows: [{ id: row.id }] };
      }
      if (t.startsWith('SELECT id FROM sms_text_templates WHERE id')) return { rows: state.templates.filter(r => r.id === args[0]) };
      if (t.startsWith('UPDATE sms_text_templates SET name = ?, body = ?, auto_enabled = false WHERE id = ?')) {
        const row = state.templates.find(r => r.id === args[2]);
        const imagesChanged = t.includes("COALESCE(images, '')") && String(row.images || '') !== args[args.length - 1];
        if (row.auto_enabled && (row.body !== args[3] || imagesChanged)) { row.auto_enabled = false; return { rows: [{ id: row.id, auto_kind: row.auto_kind }] }; }
        return { rows: [] };
      }
      if (t.startsWith('UPDATE sms_text_templates SET')) {
        const sets = t.slice('UPDATE sms_text_templates SET '.length, t.indexOf(', updated_at')).split(', ');
        const row = state.templates.find(r => r.id === args[args.length - 1]);
        let k = 0;
        for (const part of sets) { const [col, val] = part.split(' = '); if (val === '?') row[col] = args[k++]; else if (val === 'NULL') row[col] = null; else if (val === 'false') row[col] = false; }
        return { rows: [{ id: row.id, auto_kind: row.auto_kind, auto_days: row.auto_days, auto_enabled: row.auto_enabled }] };
      }
      throw new Error(`예상 못 한 SQL ${t}`);
    },
  };
  return db;
}

function fakeProvider({ sendResults = [] } = {}) {
  const calls = { upload: [], send: [] };
  return {
    calls,
    estimate: ({ type, count }) => ({ unit: type === 'MMS' ? 110 : 45, total: (type === 'MMS' ? 110 : 45) * count }),
    async uploadImage(input) { calls.upload.push(input); return { fileId: `F${calls.upload.length}` }; },
    async sendEach(input) {
      calls.send.push(input);
      const r = sendResults[calls.send.length - 1];
      return r || { accepted: input.messages.length, failed: 0, groupId: `G${calls.send.length}`, uncertain: false, error: '' };
    },
  };
}

const order = (id, phone, ship, name = '김철수') => ({ id, phone, client_name: name, status: 'shipped', ship_date: ship });
const setup = (opts) => { _resetAutoSchemaForTest(); _resetTextTemplateSchemaForTest(); _resetManualSendSchemaForTest(); return fakeDb(opts); };
const run = (db, provider, extra = {}) => runAutoSend({ id: 7, name: db.state.tpl.name, body: db.state.tpl.body, images: db.state.tpl.images ? JSON.parse(db.state.tpl.images) : [], auto_kind: db.state.tpl.auto_kind, auto_days: db.state.tpl.auto_days, auto_enabled: db.state.tpl.auto_enabled, auto_start_date: db.state.tpl.auto_start_date }, { db, provider, env: ENV, nowMs: NOW, ...extra });

test('대상 조회: 출고 후 N일 창(KST 경계)·시작일·010 번호·같은 번호 1명', async () => {
  assert.equal(kstDate(NIGHT), '2026-11-20');
  assert.equal(kstDate(Date.parse('2026-11-19T14:59:00Z')), '2026-11-19');
  const db = setup({ orders: [
    order(1, '010-1111-2222', '2026-10-27'), order(2, '010-3333-4444', '2026-10-28'), order(3, '010-5555-6666', '2026-10-31'),
    order(4, '010-7777-8888', '2026-11-01'), order(5, '01255556666', '2026-10-30'), order(6, '010-3333-4444', '2026-10-30'),
  ] });
  const all = await findTargets(db, { nowMs: NOW, days: 20, startDate: '2026-10-01' });
  assert.deepEqual(all.map(t => t.orderId), [2, 3]);
  const late = await findTargets(db, { nowMs: NOW, days: 20, startDate: '2026-10-31' });
  assert.deepEqual(late.map(t => t.orderId), [3]);
});

test('같은 번호·같은 주문은 한 번만, 다시 돌려도 재발송 0', async () => {
  const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-29'), order(2, '010-3333-4444', '2026-10-31'), order(3, '010-5555-6666', '2026-10-31')] });
  const provider = fakeProvider();
  const first = await run(db, provider);
  assert.equal(first.claimed, 2);
  assert.equal(provider.calls.send[0].messages.length, 2);
  const sendsBefore = provider.calls.send.length;
  const second = await run(db, provider);
  assert.equal(second.claimed, 0);
  assert.equal(provider.calls.send.length, sendsBefore);
});

test('수신거부 번호는 건너뛴다', async () => {
  const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-31'), order(2, '010-5555-6666', '2026-10-31')], optouts: ['01033334444'] });
  const provider = fakeProvider();
  const out = await run(db, provider);
  assert.equal(out.claimed, 1);
  assert.equal(provider.calls.send[0].messages[0].to, '01055556666');
});

test('하루 상한: 남은 만큼만 선점하고, 겹쳐 돈 크론이 상한을 넘기면 넘은 행은 지우고 안 보낸다', async () => {
  const orders = [1, 2, 3, 4].map(i => order(i, `010-0000-000${i}`, '2026-10-31'));
  let db = setup({ orders });
  let provider = fakeProvider();
  const out = await run(db, provider, { env: { ...ENV, SMS_AUTO_MAX_PER_DAY: '3' } });
  assert.equal(out.claimed, 3);
  assert.equal(db.state.sends.length, 3);
  // 겹쳐 돈 경우: 선점 직전에 다른 실행이 2행을 넣어 합계가 상한을 넘는다
  db = setup({ orders: orders.slice(0, 3), beforeInsert: st => { for (const n of [90, 91]) st.sends.push({ id: 1000 + n, template_id: 9, phone_hash: `x${n}`, order_id: n, kst_date: '2026-11-20', status: 'sent' }); } });
  provider = fakeProvider();
  const raced = await run(db, provider, { env: { ...ENV, SMS_AUTO_MAX_PER_DAY: '3' } });
  assert.equal(raced.claimed, 1);
  assert.equal(provider.calls.send[0].messages.length, 1);
  assert.equal(db.state.sends.filter(r => r.template_id === 7).length, 1);
});

test('야간·꺼짐·광고 형식 불일치면 선점도 발송도 업로드도 0', async () => {
  const orders = [order(1, '010-3333-4444', '2026-10-31')];
  const cases = [
    [{}, { nowMs: NIGHT }],
    [{ template: { auto_enabled: false } }, {}],
    [{}, { env: { ...ENV, SMS_AUTO: 'off' } }],
    [{ template: { body: '안녕하세요\n무료수신거부 080-123-4567' } }, {}],
    [{ template: { body: '(광고) 안녕하세요\n문의 주세요' } }, {}],
  ];
  for (const [opts, extra] of cases) {
    const db = setup({ orders, ...opts });
    const provider = fakeProvider();
    const out = await run(db, provider, extra);
    assert.equal(out.claimed, 0);
    assert.equal(db.state.sends.length, 0);
    assert.equal(provider.calls.send.length + provider.calls.upload.length, 0);
    assert.ok(!db.state.sql.some(s => s.startsWith('INSERT INTO sms_auto_sends')));
  }
  assert.equal(adCheck(BODY), '');
  assert.equal(adCheck('안녕\n무료수신거부 080-123-4567'), 'no_ad_prefix');
  assert.equal(adCheck('(광고) 안녕\n무료수신거부 번호 안내'), 'no_optout_080');
});

test('사진 2장 → 사진 올리기 2번·발송 호출 2번(받는 사람 수와 무관), 2통째는 짧은 글+사진', async () => {
  const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-31', '김철수'), order(2, '010-5555-6666', '2026-10-30', '이영희'), order(3, '010-7777-8888', '2026-10-29')] });
  const provider = fakeProvider();
  const out = await run(db, provider);
  assert.equal(out.sent, 3);
  assert.equal(provider.calls.upload.length, 2);
  assert.equal(provider.calls.send.length, 2);
  const [first, second] = provider.calls.send;
  assert.equal(first.messages.length, 3);
  assert.ok(first.messages.some(m => m.text.includes('김철수 대표님')) && first.messages.some(m => m.text.includes('이영희 대표님')));
  assert.deepEqual(first.messages.map(m => m.fileId), ['F1', 'F1', 'F1']);
  assert.ok(second.messages.every(m => m.fileId === 'F2' && m.text.startsWith('(광고) 한성쇼케이스') && m.text.includes('2/2') && m.text.includes('080-123-4567')));
  assert.deepEqual(JSON.parse(db.state.sends[0].part_status), ['sent', 'sent']);
  assert.equal(buildParts({ name: 'n', body: BODY }, 0).length, 1);
});

test('1통째가 실패하면 2통째는 0, 불확실·일부 실패·시간 초과는 uncertain 이고 다시 보내지 않는다', async () => {
  const orders = [order(1, '010-3333-4444', '2026-10-31'), order(2, '010-5555-6666', '2026-10-31')];
  let db = setup({ orders });
  let provider = fakeProvider({ sendResults: [{ accepted: 0, failed: 2, groupId: null, uncertain: false, error: '거절' }] });
  let out = await run(db, provider);
  assert.equal(provider.calls.send.length, 1);
  assert.equal(out.failed, 2);
  assert.deepEqual(JSON.parse(db.state.sends[0].part_status), ['failed', 'skipped']);

  db = setup({ orders });
  provider = fakeProvider({ sendResults: [{ accepted: 0, failed: 0, groupId: null, uncertain: true, error: '확인 못 함' }] });
  out = await run(db, provider);
  assert.equal(out.uncertain, 2);
  assert.equal(provider.calls.send.length, 1);
  await run(db, provider);
  assert.equal(provider.calls.send.length, 1); // 재발송 0

  db = setup({ orders });
  provider = fakeProvider({ sendResults: [{ accepted: 1, failed: 1, groupId: 'G', uncertain: false, error: '' }] });
  out = await run(db, provider);
  assert.equal(out.uncertain, 2);
  assert.equal(provider.calls.send.length, 1);

  db = setup({ orders });
  provider = fakeProvider();
  let t = 0;
  out = await run(db, provider, { tick: () => (t += 15000) }); // 1통째 뒤 20초 초과
  assert.equal(provider.calls.send.length, 1);
  assert.equal(out.uncertain, 2);
  assert.deepEqual(JSON.parse(db.state.sends[0].part_status), ['sent', 'skipped']);
});

test('하루 지난 claimed 는 uncertain 으로 바꾸고 다시 보내지 않는다(크론 전체)', async () => {
  const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-31')] });
  db.state.sends.push({ id: 50, template_id: 7, phone_hash: phoneHash('01033334444'), order_id: 1, kst_date: '2026-11-19', status: 'claimed' });
  const provider = fakeProvider();
  const total = await runAutoSendAll({ db, provider, env: ENV, nowMs: NOW });
  assert.equal(db.state.sends[0].status, 'uncertain');
  assert.equal(total.claimed, 0);
  assert.equal(provider.calls.send.length, 0);
});

test('켜기: (광고)·080 검사로 거절, dry_run 은 대상·통 수·비용, 켤 때 시작일 = 오늘 − 일수, 현황은 건수만', async () => {
  const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-31')], template: { auto_enabled: false, auto_start_date: '', body: '안녕하세요' } });
  let out = await autoToggle({ id: 7, enabled: true }, { db, provider: fakeProvider(), env: ENV, nowMs: NOW });
  assert.equal(out.status, 400);
  assert.equal(out.body.reason, 'no_ad_prefix');
  db.state.tpl.body = BODY;
  const dry = await autoToggle({ id: 7, enabled: true, dry_run: true }, { db, provider: fakeProvider(), env: ENV, nowMs: NOW });
  assert.deepEqual({ ok: dry.body.ok, targets: dry.body.targets, parts: dry.body.parts, cost: dry.body.cost }, { ok: true, targets: 1, parts: 2, cost: 220 });
  assert.equal(db.state.tpl.auto_enabled, false);
  const on = await autoToggle({ id: 7, enabled: true }, { db, provider: fakeProvider(), env: ENV, nowMs: NOW });
  assert.deepEqual(on.body, { ok: true, enabled: true, start_date: '2026-10-31' });
  const status = await autoStatus(db, { id: 7, nowMs: NOW, env: ENV });
  assert.deepEqual({ enabled: status.body.enabled, today: status.body.today_targets, blocked: status.body.enable_blocked_reason }, { enabled: true, today: 1, blocked: '' });
  assert.equal(JSON.stringify(status.body).includes('김철수'), false);
  const added = await optoutAdd({ phone: '010-3333-4444' }, { db });
  assert.equal(added.status, 201);
  assert.equal((await autoStatus(db, { id: 7, nowMs: NOW, env: ENV })).body.today_targets, 0);
});

test('문구 저장: 사진 여러 장·자동 발송 칸, 켜진 문구의 본문·사진을 고치면 꺼진다, 기존 사진 1장 문구 호환', async () => {
  const db = setup();
  const created = await saveTextTemplate(db, { name: '소개', body: BODY, images: [{ data: JPG }, { data: JPG }], auto: { kind: 'ship_plus_days', days: 20 } });
  assert.equal(created.status, 201);
  assert.deepEqual({ n: created.body.item.image_count, kind: created.body.item.auto_kind, days: created.body.item.auto_days, on: created.body.item.auto_enabled }, { n: 2, kind: 'ship_plus_days', days: 20, on: false });
  const id = created.body.item.id;
  const one = (await getTextTemplate(db, { id })).body.item;
  assert.deepEqual(one.images, [JPG, JPG]);
  assert.equal((await saveTextTemplate(db, { name: 'X', body: 'x', images: [{ data: JPG }, { data: JPG }, { data: JPG }, { data: JPG }] })).status, 400);
  assert.equal((await saveTextTemplate(db, { name: 'Y', body: 'y', auto: { kind: 'ship_plus_days', days: 400 } })).status, 400);
  db.state.templates.find(r => r.id === id).auto_enabled = true;
  const same = await saveTextTemplate(db, { id, name: '소개', body: BODY, images: [{ data: JPG }, { data: JPG }], auto: { kind: 'ship_plus_days', days: 20 } });
  assert.equal(same.body.item.auto_enabled, true);
  const edited = await saveTextTemplate(db, { id, name: '소개', body: `${BODY}\n추가`, images: [{ data: JPG }, { data: JPG }], auto: { kind: 'ship_plus_days', days: 20 } });
  assert.equal(edited.body.item.auto_enabled, false);
  assert.equal(edited.body.item.auto_disabled, true);
  db.state.templates.find(r => r.id === id).auto_enabled = true;
  const fewer = await saveTextTemplate(db, { id, name: '소개', body: `${BODY}\n추가`, images: [{ data: JPG }], auto: { kind: 'ship_plus_days', days: 20 } });
  assert.equal(fewer.body.item.auto_enabled, false);
  // 기존 사진 1장 요청은 그대로
  const legacy = await saveTextTemplate(db, { name: '옛 문구', body: '안내', image: { data: JPG } });
  assert.equal(legacy.status, 201);
  assert.deepEqual((await getTextTemplate(db, { id: legacy.body.item.id })).body.item.images, [JPG]);
});

test('내 번호로 시험: 번호 1개만, 같은 키 재요청은 다시 안 보내고, 밤에는 거절', async () => {
  const db = setup();
  const provider = fakeProvider();
  const deps = { db, provider, env: ENV, nowMs: NOW };
  const dry = await autoTest({ id: 7, to: '010-1234-4237', dry_run: true }, deps);
  assert.deepEqual({ parts: dry.body.parts, cost: dry.body.cost }, { parts: 2, cost: 220 });
  assert.equal((await autoTest({ id: 7, to: '12', idempotencyKey: 'key-0001-aaaa' }, deps)).status, 400);
  const sent = await autoTest({ id: 7, to: '010-1234-4237', idempotencyKey: 'key-0001-aaaa' }, deps);
  assert.deepEqual(sent.body.part_status, ['sent', 'sent']);
  assert.ok(provider.calls.send.every(c => c.messages.length === 1));
  assert.ok(provider.calls.send[0].messages[0].text.includes('고객 대표님'));
  const again = await autoTest({ id: 7, to: '010-1234-4237', idempotencyKey: 'key-0001-aaaa' }, deps);
  assert.equal(again.body.duplicate, true);
  assert.equal(provider.calls.send.length, 2);
  assert.equal((await autoTest({ id: 7, to: '010-1234-4237', idempotencyKey: 'key-0002-bbbb' }, { ...deps, nowMs: NIGHT })).status, 400);
  assert.ok(!db.state.sql.some(s => s.startsWith('INSERT INTO sms_auto_sends')));
});

test('api 연결: 쓰기 꺼짐이면 auto_toggle 거절, 수신거부·현황 조회가 열린다', async () => {
  const db = setup({ orders: [] });
  const res = () => ({ statusCode: 200, body: null, setHeader() {}, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  const SAME = { origin: 'https://production-status.vercel.app', host: 'production-status.vercel.app', 'x-forwarded-proto': 'https' };
  const base = { url: '/api/sms-console', socket: { remoteAddress: '9.9.9.9' }, headers: SAME };
  const deps = (enabled) => ({ db, env: ENV, nowMs: NOW, rateLimitCheck: () => true, guard: { writeStatus: async () => ({ enabled }) }, sendProvider: fakeProvider() });
  let r = res(); await handleSmsConsole({ ...base, method: 'POST', query: {}, body: { action: 'auto_toggle', id: 7, enabled: true } }, r, deps(false));
  assert.equal(r.statusCode, 503);
  r = res(); await handleSmsConsole({ ...base, method: 'POST', query: {}, body: { action: 'optout_add', phone: '010-9999-0000' } }, r, deps(true));
  assert.equal(r.statusCode, 201);
  r = res(); await handleSmsConsole({ ...base, method: 'GET', query: { resource: 'optouts' } }, r, deps(true));
  assert.equal(r.body.items[0].last4, '0000');
  r = res(); await handleSmsConsole({ ...base, method: 'GET', query: { resource: 'auto_status', id: '7' } }, r, deps(true));
  assert.equal(r.statusCode, 200);
});

test('sendEach: send-many 1번, 받는 사람마다 본문·사진(MMS)이 다르다', async () => {
  const prev = { k: process.env.SOLAPI_API_KEY, s: process.env.SOLAPI_API_SECRET };
  process.env.SOLAPI_API_KEY = 'k'; process.env.SOLAPI_API_SECRET = 's';
  try {
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ groupInfo: { groupId: 'G1', count: { registeredFailed: 0 } } }) }; };
    const out = await getSendProvider('solapi').sendEach({ from: '0212345678', messages: [{ to: '01011112222', text: 'A', fileId: 'F1' }, { to: '01033334444', text: 'B', fileId: 'F1' }] }, { fetchImpl });
    assert.equal(seen.length, 1);
    assert.ok(seen[0].url.includes('send-many'));
    assert.deepEqual(seen[0].body.messages.map(m => [m.text, m.type, m.imageId]), [['A', 'MMS', 'F1'], ['B', 'MMS', 'F1']]);
    assert.deepEqual(out, { accepted: 2, failed: 0, groupId: 'G1', uncertain: false, error: '' });
  } finally {
    if (prev.k === undefined) delete process.env.SOLAPI_API_KEY; else process.env.SOLAPI_API_KEY = prev.k;
    if (prev.s === undefined) delete process.env.SOLAPI_API_SECRET; else process.env.SOLAPI_API_SECRET = prev.s;
  }
});

test('생산 표에는 쓰지 않는다 · vercel.json 기존 크론 8줄 불변 · 새 크론 1줄', async () => {
  const code = ['api/_lib/smsAutoSend.js', 'api/cron/sms-auto.js'].map(f => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')).join('\n');
  assert.equal(/(INSERT\s+INTO|UPDATE|DELETE\s+FROM|ALTER\s+TABLE)\s+(orders|processes|notification_log)\b/i.test(code), false);
  const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-31')] });
  await run(db, fakeProvider());
  assert.equal(db.state.sql.some(s => /^(INSERT|UPDATE|DELETE|ALTER)/.test(s) && /\b(orders|processes|notification_log)\b/.test(s)), false);
  const vercel = JSON.parse(fs.readFileSync(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.deepEqual(vercel.crons.slice(0, 8), [
    { path: '/api/cron/sweep', schedule: '30 23 * * *' }, { path: '/api/cron/risk-daily', schedule: '40 23 * * 0-4' },
    { path: '/api/cron/internal-production-daily', schedule: '40 23 * * 0-4' }, { path: '/api/cron/overdue-reminders-daily', schedule: '40 23 * * *' },
    { path: '/api/cron/ship-day-reminders-daily', schedule: '42 23 * * *' }, { path: '/api/cron/sms-delivery-monitor', schedule: '*/5 * * * *' },
    { path: '/api/cron/sheet-sync', schedule: '* * * * *' }, { path: '/api/cron/external-cleanup', schedule: '*/5 * * * *' },
  ]);
  assert.deepEqual(vercel.crons[8], { path: '/api/cron/sms-auto', schedule: '0 1 * * *' });
});
