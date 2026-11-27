import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { handleSmsConsole } from '../api/sms-console.js';
import { _resetTextTemplateSchemaForTest, getTextTemplate, saveTextTemplate } from '../api/_lib/smsTextTemplates.js';
import { _resetManualSendSchemaForTest } from '../api/_lib/smsManualSend.js';
import {
  _resetAutoSchemaForTest, adCheck, autoStatus, autoToggle, autoTest, buildAdminCopySms, buildParts, findTargets, kstDate, optoutAdd, phoneHash, runAutoSend, runAutoSendAll,
} from '../api/_lib/smsAutoSend.js';
import { byteLength, classifyText, getSendProvider, SMS_MAX_BYTES } from '../api/_lib/sendProvider.js';
import { eventPhoneHash, runGuarded } from '../api/_lib/smsEventSend.js';

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
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT conname FROM pg_constraint')) return { rows: [] };
      if (t.startsWith('SELECT id, name, body, image, images, auto_kind, auto_days, auto_enabled, auto_start_date')) return { rows: args[0] === state.tpl.id ? [state.tpl] : [] };
      if (t.startsWith('SELECT id, name, body, image, images, auto_kind, auto_days, auto_enabled')) return { rows: state.templates.filter(r => r.id === args[0]) };
      if (t.startsWith("SELECT id FROM sms_text_templates WHERE auto_enabled = true")) return { rows: state.tpl.auto_enabled ? [{ id: state.tpl.id }] : [] };
      if (t.includes('FROM orders') && t.includes('LEFT(order_date')) return { rows: state.orders.filter(o => o.order_date && o.order_date.slice(0, 10) >= args[0] && o.order_date.slice(0, 10) <= args[1]).map(o => ({ id: o.id, phone: o.phone, client_name: o.client_name, ship_day: o.order_date.slice(0, 10) })) };
      if (t.includes('FROM orders')) return { rows: state.orders.filter(o => o.status === 'shipped' && o.ship_date.slice(0, 10) >= args[0] && o.ship_date.slice(0, 10) <= args[1]).map(o => ({ id: o.id, phone: o.phone, client_name: o.client_name, ship_day: o.ship_date.slice(0, 10) })) };
      if (t.startsWith('SELECT phone_hash FROM sms_optouts')) return { rows: state.optouts.map(phone_hash => ({ phone_hash })) };
      if (t.startsWith('SELECT phone_hash, order_id')) return { rows: state.sends.filter(r => r.template_id === args[0] && (!t.includes("status <> 'failed'") || r.status !== 'failed')) };
      if (t.startsWith('SELECT DISTINCT phone_hash FROM sms_auto_sends WHERE kst_date')) return { rows: state.sends.filter(r => r.kst_date === args[0] && (!t.includes("status <> 'failed'") || r.status !== 'failed')).map(r => ({ phone_hash: r.phone_hash })) };
      if (t.startsWith('SELECT DISTINCT e.phone_hash FROM sms_event_sends')) return { rows: (state.bmsToday || []).map(phone_hash => ({ phone_hash })) }; // 오늘 나간 브랜드메시지 번호(event 해시)
      if (t.startsWith("DELETE FROM sms_auto_sends WHERE template_id = ? AND status = 'failed'")) { const n = (args.length - 1) / 2; const hs = args.slice(1, 1 + n); const os = args.slice(1 + n); state.sends = state.sends.filter(r => !(r.template_id === args[0] && r.status === 'failed' && (hs.includes(r.phone_hash) || os.includes(r.order_id)))); return { rows: [] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_skip_reason = ?')) { (state.skips ||= []).push(args[0]); return { rows: [{ id: args[1] }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_skip_reason = NULL')) { state.skipCleared = (state.skipCleared || 0) + 1; return { rows: [{ id: args[0] }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_ata_fail_at = CASE')) { state.failMark = (state.failMark || 0) + 1; return { rows: [{ id: args[0] }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_ata_fail_at = NULL')) { state.failClear = (state.failClear || 0) + 1; return { rows: [{ id: args[0] }] }; }
      if (t.startsWith('SELECT MAX(last_run)')) return { rows: [{ last_run: state.cronLast || null }] };
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_auto_sends WHERE kst_date') && t.includes("kind = 'catchup'") && !t.includes('<>')) return { rows: [{ n: state.sends.filter(r => r.kst_date === args[0] && r.kind === 'catchup' && (!t.includes('template_id') || r.template_id === args[1])).length }] };
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_auto_sends WHERE kst_date') && t.includes("<> 'catchup'")) return { rows: [{ n: state.sends.filter(r => r.kst_date === args[0] && r.kind !== 'catchup').length }] };
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
        const kinds = [...t.matchAll(/'claimed', \?, (?:'(catchup)'|NULL)\)/g)].map(m => m[1] || null);
        for (let i = 0; i < args.length; i += 7) {
          const [template_id, phone_hash, , order_id, , kst_date, round] = args.slice(i, i + 7);
          if (state.sends.some(r => r.template_id === template_id && (r.round || 1) === round && (r.phone_hash === phone_hash || r.order_id === order_id))) continue;
          const row = { id: state.nextId++, template_id, phone_hash, order_id, kst_date, status: 'claimed', round, kind: kinds[i / 7] || null };
          state.sends.push(row); rows.push({ id: row.id, phone_hash, round });
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
      if (t.startsWith('UPDATE sms_text_templates SET auto_catchup_done_at = NOW()')) { state.tpl.auto_catchup_done = true; return { rows: [{ id: args[0] }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_catchup_paused_at = NOW()')) { state.tpl.auto_catchup_paused = true; state.tpl.auto_catchup_error = args[0]; return { rows: [{ id: args[1] }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_copy_date = ? WHERE id = ?')) { if ((state.copyDate || '') === args[0]) return { rows: [] }; state.copyDate = args[0]; return { rows: [{ id: args[1] }] }; }
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
        const autoChanged = t.includes('auto_repeat IS DISTINCT FROM') && ((row.auto_send_from ?? null) !== args[6] || (row.auto_repeat ?? 1) !== args[7] || (row.auto_interval ?? 30) !== args[8]);
        if (row.auto_enabled && (row.body !== args[3] || imagesChanged || autoChanged)) { row.auto_enabled = false; return { rows: [{ id: row.id, auto_kind: row.auto_kind }] }; }
        return { rows: [] };
      }
      if (t.startsWith('UPDATE sms_text_templates SET')) {
        const sets = t.slice('UPDATE sms_text_templates SET '.length, t.indexOf(', updated_at')).split(', ');
        const row = state.templates.find(r => r.id === args[args.length - 1]);
        let k = 0;
        for (const part of sets) { const [col, val] = part.split(' = '); if (val === '?') row[col] = args[k++]; else if (val === 'NULL') row[col] = null; else if (val === 'false') row[col] = false; }
        return { rows: [{ id: row.id, auto_kind: row.auto_kind, auto_days: row.auto_days, auto_enabled: row.auto_enabled, auto_send_from: row.auto_send_from, auto_repeat: row.auto_repeat, auto_interval: row.auto_interval }] };
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
const run = (db, provider, extra = {}) => runAutoSend({ id: 7, name: db.state.tpl.name, body: db.state.tpl.body, images: db.state.tpl.images ? JSON.parse(db.state.tpl.images) : [], auto_kind: db.state.tpl.auto_kind, auto_days: db.state.tpl.auto_days, auto_enabled: db.state.tpl.auto_enabled, auto_start_date: db.state.tpl.auto_start_date, auto_send_from: db.state.tpl.auto_send_from, auto_repeat: db.state.tpl.auto_repeat, auto_interval: db.state.tpl.auto_interval }, { db, provider, env: ENV, nowMs: NOW, ...extra });

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

test('사진 2장 → 사진 올리기 2번·발송 호출 3번(받는 사람 수와 무관), 사진만 순서대로 먼저 가고 본문은 맨 끝에 글만 한 통(2026-11-16 사장님)', async () => {
  const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-31', '김철수'), order(2, '010-5555-6666', '2026-10-30', '이영희'), order(3, '010-7777-8888', '2026-10-29')] });
  const provider = fakeProvider();
  const out = await run(db, provider);
  assert.equal(out.sent, 3);
  assert.equal(provider.calls.upload.length, 2);
  assert.equal(provider.calls.send.length, 3);
  const [first, second, third] = provider.calls.send;
  assert.equal(first.messages.length, 3);
  assert.deepEqual(first.messages.map(m => m.fileId), ['F1', 'F1', 'F1']);
  assert.ok([...first.messages, ...second.messages].every(m => m.text === '(광고) 한성쇼케이스\n무료수신거부 080-123-4567') && second.messages.every(m => m.fileId === 'F2'));
  assert.ok(third.messages.every(m => !m.fileId && m.text.startsWith('(광고)') && m.text.includes('080-123-4567')));
  assert.ok(third.messages.some(m => m.text.includes('김철수 대표님')) && third.messages.some(m => m.text.includes('이영희 대표님')));
  assert.deepEqual(JSON.parse(db.state.sends[0].part_status), ['sent', 'sent', 'sent']);
  assert.equal(buildParts({ name: 'n', body: BODY }, 0).length, 1);
});

test('여러 통은 통 사이에 기다린다: 사진 2장이면 통 3개(사진·사진·본문)라 sleep 2번, 통 1개면 0번, 값 0이면 기다림 없음', async () => {
  const trace = [];
  const tracedProvider = () => { const p = fakeProvider(); const send = p.sendEach; p.sendEach = async input => { trace.push(`send${p.calls.send.length}`); return send(input); }; return p; };
  const sleep = async ms => { trace.push(`sleep${ms}`); };
  const out = await run(setup({ orders: [order(1, '010-3333-4444', '2026-10-31')] }), tracedProvider(), { sleep });
  assert.equal(out.sent, 1);
  assert.deepEqual(trace, ['send0', 'sleep15000', 'send1', 'sleep15000', 'send2']);
  trace.length = 0;
  const viaTest = await autoTest({ id: 7, to: '010-1234-4237', idempotencyKey: 'key-gap-0001' }, { db: setup(), provider: tracedProvider(), env: { ...ENV, SMS_PART_GAP_MS: '3000' }, nowMs: NOW, sleep });
  assert.deepEqual(viaTest.body.part_status, ['sent', 'sent', 'sent']);
  assert.deepEqual(trace, ['send0', 'sleep3000', 'send1', 'sleep3000', 'send2']);
  trace.length = 0;
  await run(setup({ orders: [order(1, '010-3333-4444', '2026-10-31')], template: { images: JSON.stringify([JPG]) } }), tracedProvider(), { sleep });
  assert.deepEqual(trace, ['send0']);
  trace.length = 0;
  await run(setup({ orders: [order(1, '010-3333-4444', '2026-10-31')] }), tracedProvider(), { sleep, env: { ...ENV, SMS_PART_GAP_MS: '0' } });
  assert.deepEqual(trace, ['send0', 'send1', 'send2']);
  trace.length = 0;
  await run(setup({ orders: [order(1, '010-3333-4444', '2026-10-31')] }), tracedProvider(), { sleep, env: { ...ENV, SMS_PART_GAP_MS: 'abc' } });
  assert.deepEqual(trace, ['send0', 'sleep15000', 'send1', 'sleep15000', 'send2']);
});

test('여러 통 문구는 남은 시간이 모자라면 선점·업로드·발송 0으로 통째로 건너뛰고, 충분하면 나간다', async () => {
  const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-31')] });
  const provider = fakeProvider();
  const out = await run(db, provider, { tick: () => 1000, deadline: 50000 }); // 통 3개: 남은 49초 < 30+15+5 = 50초
  assert.equal(out.reason, 'time');
  assert.equal(out.claimed, 0);
  assert.equal(provider.calls.upload.length + provider.calls.send.length, 0);
  assert.ok(!db.state.sql.some(s => s.startsWith('INSERT INTO sms_auto_sends')));
  const ok = await run(setup({ orders: [order(1, '010-3333-4444', '2026-10-31')] }), fakeProvider(), { tick: () => 1000, deadline: 51000, sleep: async () => {} });
  assert.equal(ok.sent, 1);
});

test('1통째가 실패하면 2통째는 0, 불확실·일부 실패·시간 초과는 uncertain 이고 다시 보내지 않는다', async () => {
  const orders = [order(1, '010-3333-4444', '2026-10-31'), order(2, '010-5555-6666', '2026-10-31')];
  let db = setup({ orders });
  let provider = fakeProvider({ sendResults: [{ accepted: 0, failed: 2, groupId: null, uncertain: false, error: '거절' }] });
  let out = await run(db, provider);
  assert.equal(provider.calls.send.length, 1);
  assert.equal(out.failed, 2);
  assert.equal(db.state.sends.length, 0, '접수 0건 통째 실패: 선점 행을 지워 다음 실행이 다시 보낸다');
  assert.deepEqual(db.state.skips, ['발송 실패: 거절'], '실패 사유는 건너뜀 사유에 남는다');
  assert.equal(db.state.failMark, 1, '연속 실패면 1시간 쉬도록 표시');

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
  out = await run(db, provider, { tick: () => (t += t < 15000 ? 5000 : 100000) }); // 시작·시간 검사·1통째까지는 5초씩, 그 뒤 마감 70초 초과(통 3개에 맞춤)
  assert.equal(provider.calls.send.length, 1);
  assert.equal(out.uncertain, 2);
  assert.deepEqual(JSON.parse(db.state.sends[0].part_status), ['sent', 'skipped', 'skipped']);
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
  assert.deepEqual({ ok: dry.body.ok, targets: dry.body.targets, parts: dry.body.parts, cost: dry.body.cost }, { ok: true, targets: 1, parts: 3, cost: 265 });
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

test('내 번호로 시험: 번호 1개만, 같은 키 재요청은 다시 안 보내고, 밤에도 된다', async () => {
  const db = setup();
  const provider = fakeProvider();
  const deps = { db, provider, env: ENV, nowMs: NOW };
  const dry = await autoTest({ id: 7, to: '010-1234-4237', dry_run: true }, deps);
  assert.deepEqual({ parts: dry.body.parts, cost: dry.body.cost }, { parts: 3, cost: 265 });
  assert.equal((await autoTest({ id: 7, to: '12', idempotencyKey: 'key-0001-aaaa' }, deps)).status, 400);
  const sent = await autoTest({ id: 7, to: '010-1234-4237', idempotencyKey: 'key-0001-aaaa' }, deps);
  assert.deepEqual(sent.body.part_status, ['sent', 'sent', 'sent']);
  assert.ok(provider.calls.send.every(c => c.messages.length === 1));
  assert.ok(!provider.calls.send[0].messages[0].text.includes('고객 대표님') && provider.calls.send[2].messages[0].text.includes('고객 대표님'));
  const again = await autoTest({ id: 7, to: '010-1234-4237', idempotencyKey: 'key-0001-aaaa' }, deps);
  assert.equal(again.body.duplicate, true);
  assert.equal(provider.calls.send.length, 3);
  // 시험 발송은 넣은 번호 1개로만 가므로 밤에도 된다(고객 자동 발송의 야간 금지는 따로 시험한다)
  assert.deepEqual((await autoTest({ id: 7, to: '010-1234-4237', idempotencyKey: 'key-0002-bbbb' }, { ...deps, nowMs: NIGHT })).body.part_status, ['sent', 'sent', 'sent']);
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

// ---- 발송 조건 넓히기(2026-11-13): 회차·주문 등록 후·시작일 ----
const NOW2 = Date.parse('2026-12-20T01:00:00Z'); // KST 12-20: 출고 10-31 + 20일 + 30일 간격 = 2회차 예정일
const REPEAT2 = { auto_repeat: 2, auto_interval: 30, images: JSON.stringify([JPG]) };

test('회차: 2회차는 간격 뒤에만 나가고 1회차와 겹치지 않으며, 같은 날 다시 돌려도 0', async () => {
  const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-31')], template: REPEAT2 });
  const provider = fakeProvider();
  assert.equal((await run(db, provider)).claimed, 1);
  assert.equal(db.state.sends[0].round, 1);
  db.state.sends[0].status = 'sent';
  assert.equal((await run(db, provider, { nowMs: Date.parse('2026-11-30T01:00:00Z') })).claimed, 0); // 간격이 안 지났다
  const second = await run(db, provider, { nowMs: NOW2 });
  assert.equal(second.claimed, 1);
  assert.deepEqual(db.state.sends.map(r => r.round), [1, 2]);
  assert.equal((await run(db, provider, { nowMs: NOW2 })).claimed, 0);
});

test('회차: 앞 회차가 sent 가 아니면 다음 회차는 안 나간다', async () => {
  const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-31')], template: REPEAT2 });
  db.state.sends.push({ id: 50, template_id: 7, phone_hash: phoneHash('01033334444'), order_id: 1, kst_date: '2026-11-20', status: 'uncertain', round: 1 });
  const provider = fakeProvider();
  const out = await run(db, provider, { nowMs: NOW2 });
  assert.equal(out.claimed, 0);
  assert.equal(provider.calls.send.length, 0);
});

test('이틀 연속 방지: 일괄 발송으로 어제 3회차를 받은 번호는 새 주문 1회차가 오늘 예정이어도 대상 0', async () => {
  const hash = phoneHash('01033334444');
  const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-31')] }); // 새 주문 1회차 예정일 = 오늘
  db.state.sends.push({ id: 60, template_id: 7, phone_hash: hash, order_id: 2, kst_date: '2026-11-19', status: 'sent', round: 3 });
  const provider = fakeProvider();
  assert.equal((await run(db, provider)).claimed, 0);
  assert.equal(provider.calls.send.length, 0);
  Object.assign(db.state.sends[0], { kst_date: '2026-10-01', round: 3, status: 'sent' }); // 간격 절반보다 오래된 기록 → 1회차 조건만으로 막히는지
  assert.equal((await run(db, provider)).claimed, 0);
});

test('이틀 연속 방지: 최근 기록이 간격 절반 안이면 다음 회차도 빠지고 정확히 절반째엔 나간다, 주문 후 문구는 제외', async () => {
  const hash = phoneHash('01033334444');
  const mk = date => { const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-31')], template: REPEAT2 }); db.state.sends.push({ id: 61, template_id: 7, phone_hash: hash, order_id: 1, kst_date: date, status: 'sent', round: 1 }); return db; };
  assert.equal((await run(mk('2026-12-06'), fakeProvider(), { nowMs: NOW2 })).claimed, 0); // 14일 전 < 15
  assert.equal((await run(mk('2026-12-05'), fakeProvider(), { nowMs: NOW2 })).claimed, 1); // 정확히 15일 전은 통과
  const plus = setup({ template: { auto_kind: 'order_plus_days' }, orders: [{ id: 1, phone: '010-3333-4444', client_name: 'A', status: 'working', ship_date: null, order_date: '2026-10-31' }] });
  plus.state.sends.push({ id: 62, template_id: 7, phone_hash: hash, order_id: 2, kst_date: '2026-11-19', status: 'sent', round: 3 });
  assert.equal((await run(plus, fakeProvider())).claimed, 1);
});

test('주문 등록 후: order_date 기준, 출고 상태와 무관', async () => {
  const db = setup({ template: { auto_kind: 'order_plus_days' }, orders: [
    { id: 1, phone: '010-3333-4444', client_name: 'A', status: 'working', ship_date: null, order_date: '2026-10-31' },
    { id: 2, phone: '010-5555-6666', client_name: 'B', status: 'shipped', ship_date: '2026-10-31', order_date: '2026-09-01' },
  ] });
  const provider = fakeProvider();
  const out = await run(db, provider);
  assert.equal(out.claimed, 1);
  assert.equal(provider.calls.send[0].messages[0].to, '01033334444');
});

test('시작일 전에는 무동작(선점·업로드·발송 0, 현황 대상 0), 그 날이 되면 나간다', async () => {
  const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-31')], template: { auto_send_from: '2026-11-21' } });
  const provider = fakeProvider();
  const before = await run(db, provider);
  assert.equal(before.claimed, 0);
  assert.equal(db.state.sends.length + provider.calls.upload.length + provider.calls.send.length, 0);
  assert.equal((await autoStatus(db, { id: 7, nowMs: NOW, env: ENV })).body.today_targets, 0);
  assert.equal((await run(db, provider, { nowMs: Date.parse('2026-11-21T01:00:00Z') })).claimed, 1);
});

test('같은 번호는 하루 1통: 오늘 다른 문구로 이미 나간 번호는 뺀다', async () => {
  const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-31'), order(2, '010-5555-6666', '2026-10-31')] });
  db.state.sends.push({ id: 60, template_id: 9, phone_hash: phoneHash('01033334444'), order_id: 99, kst_date: '2026-11-20', status: 'sent', round: 1 });
  const provider = fakeProvider();
  const out = await run(db, provider);
  assert.equal(out.claimed, 1);
  assert.equal(provider.calls.send[0].messages[0].to, '01055556666');
});

test('문구 저장: 새 칸 검증(400)·저장·응답, 켜진 문구의 시작일·횟수·간격을 바꾸면 꺼진다', async () => {
  const db = setup();
  const auto = { kind: 'order_plus_days', days: 10, send_from: '2026-12-01', repeat: 3, interval: 14 };
  const created = await saveTextTemplate(db, { name: '주문 후', body: BODY, auto });
  assert.equal(created.status, 201);
  assert.deepEqual([created.body.item.auto_send_from, created.body.item.auto_repeat, created.body.item.auto_interval], ['2026-12-01', 3, 14]);
  const id = created.body.item.id;
  const one = (await getTextTemplate(db, { id })).body.item;
  assert.deepEqual([one.auto_kind, one.auto_send_from, one.auto_repeat, one.auto_interval], ['order_plus_days', '2026-12-01', 3, 14]);
  for (const bad of [{ ...auto, kind: 'x' }, { ...auto, send_from: '2026-13-40' }, { ...auto, repeat: 11 }, { ...auto, interval: 0 }]) {
    assert.equal((await saveTextTemplate(db, { name: '틀림', body: BODY, auto: bad })).status, 400);
  }
  db.state.templates.find(r => r.id === id).auto_enabled = true;
  assert.equal((await saveTextTemplate(db, { id, name: '주문 후', body: BODY, auto })).body.item.auto_enabled, true);
  for (const change of [{ send_from: '2026-12-02' }, { repeat: 2 }, { interval: 15 }]) {
    db.state.templates.find(r => r.id === id).auto_enabled = true;
    const saved = await saveTextTemplate(db, { id, name: '주문 후', body: BODY, auto: { ...auto, ...change } });
    assert.equal(saved.body.item.auto_enabled, false);
    assert.equal(saved.body.item.auto_disabled, true);
  }
});

test('문구 저장: 출고·주문 후 광고형은 고객명 밖의 변수를 거절하고 고객명만이면 통과', async () => {
  const db = setup();
  const auto = { kind: 'order_plus_days', days: 10 };
  const bad = await saveTextTemplate(db, { name: '변수', body: `${BODY}\n#{주문번호}`, auto });
  assert.deepEqual([bad.status, bad.body.reason], [400, 'info_unknown_var']);
  assert.equal((await saveTextTemplate(db, { name: '고객명만', body: BODY, auto })).status, 201);
});

// 관리자 발송 완료 확인 단문(18원): 사진·제목 없이 90바이트 이하 SMS 1통으로 오늘 발송 대상자를 요약한다.
const COPY = '01077314237';
const runCopy = (db, provider, copyTo, extraTpl = {}) => runAutoSend({ id: 7, name: db.state.tpl.name, body: BODY, images: [JPG, JPG], auto_kind: 'ship_plus_days', auto_days: 20, auto_enabled: true, auto_start_date: '2026-10-01', auto_repeat: 1, auto_interval: 30, auto_copy_to: copyTo, auto_chain: { subject: '소개 혜택 안내 제목' }, ...extraTpl }, { db, provider, env: ENV, nowMs: NOW });

test('관리자 확인 문자 요약(buildAdminCopySms): 1명·다수·외 N명·초과 길이 모두 90바이트 이하 SMS 단문 보장', () => {
  const one = buildAdminCopySms('소개 혜택 안내', ['류플로라']);
  assert.equal(one, '[소개 혜택 안내] 금일 류플로라님에게 발송 완료되었습니다.');
  assert.equal(classifyText(one).type, 'SMS');
  assert.ok(byteLength(one) <= SMS_MAX_BYTES);

  const two = buildAdminCopySms('소개 혜택 안내', ['류플로라', '예성떡집']);
  assert.equal(two, '[소개 혜택 안내] 금일 류플로라, 예성떡집님에게 발송 완료되었습니다.');
  assert.equal(classifyText(two).type, 'SMS');
  assert.ok(byteLength(two) <= SMS_MAX_BYTES);

  const many = buildAdminCopySms('소개 혜택 안내', ['류플로라', '예성떡집', '김철수', '이영희', '박민수', '최지우']);
  assert.match(many, /\[소개 혜택 안내\] 금일 류플로라.*외 \d+명에게 발송 완료되었습니다\.$/);
  assert.equal(classifyText(many).type, 'SMS');
  assert.ok(byteLength(many) <= SMS_MAX_BYTES);

  const longAll = buildAdminCopySms('가'.repeat(40), Array.from({ length: 12 }, (_, i) => `${'홍'.repeat(18)}${i}`));
  assert.match(longAll, /발송 완료되었습니다\.$/);
  assert.equal(classifyText(longAll).type, 'SMS');
  assert.ok(byteLength(longAll) <= SMS_MAX_BYTES);

  const empty = buildAdminCopySms('안내', []);
  assert.equal(empty, '[안내] 금일 발송 완료되었습니다.');
  assert.equal(classifyText(empty).type, 'SMS');
  assert.ok(byteLength(empty) <= SMS_MAX_BYTES);

  const allUnnamed3 = buildAdminCopySms('소개 혜택 안내(카페24 가입+7일)', ['고객', '고객', '고객']);
  assert.equal(allUnnamed3, '[소개 혜택 안내(카페24 가입+7일)] 금일 3명에게 발송 완료되었습니다.');
  assert.equal(allUnnamed3.includes('고객'), false);
  assert.equal(classifyText(allUnnamed3).type, 'SMS');
  assert.ok(byteLength(allUnnamed3) <= SMS_MAX_BYTES);

  const allUnnamed1 = buildAdminCopySms('소개 혜택 안내(카페24 가입+7일)', ['']);
  assert.equal(allUnnamed1, '[소개 혜택 안내(카페24 가입+7일)] 금일 1명에게 발송 완료되었습니다.');
  assert.equal(allUnnamed1.includes('고객'), false);
  assert.equal(classifyText(allUnnamed1).type, 'SMS');
  assert.ok(byteLength(allUnnamed1) <= SMS_MAX_BYTES);

  const longTplUnnamed = buildAdminCopySms('가'.repeat(40), ['고객', ' ', '#{고객}']);
  assert.match(longTplUnnamed, /금일 3명에게 발송 완료되었습니다\.$/);
  assert.equal(longTplUnnamed.includes('고객'), false);
  assert.equal(classifyText(longTplUnnamed).type, 'SMS');
  assert.ok(byteLength(longTplUnnamed) <= SMS_MAX_BYTES);

  const mixed1 = buildAdminCopySms('소개 혜택 안내(카페24 가입+7일)', ['류플로라', '고객', '']);
  assert.equal(mixed1, '[소개 혜택 안내(카페24 가입+7일)] 금일 류플로라 외 2명에게 발송 완료되었습니다.');
  assert.equal(mixed1.includes('고객'), false);
  assert.equal(classifyText(mixed1).type, 'SMS');
  assert.ok(byteLength(mixed1) <= SMS_MAX_BYTES);

  const mixed2 = buildAdminCopySms('소개 혜택 안내', ['고객', '류플로라', '예성떡집']);
  assert.equal(mixed2, '[소개 혜택 안내] 금일 류플로라, 예성떡집 외 1명에게 발송 완료되었습니다.');
  assert.equal(mixed2.includes('고객'), false);
  assert.equal(classifyText(mixed2).type, 'SMS');
  assert.ok(byteLength(mixed2) <= SMS_MAX_BYTES);

  const mixedLongName = buildAdminCopySms('가'.repeat(30), ['홍'.repeat(25), '고객']);
  assert.match(mixedLongName, /외 1명에게 발송 완료되었습니다\.$/);
  assert.equal(mixedLongName.includes('고객'), false);
  assert.equal(classifyText(mixedLongName).type, 'SMS');
  assert.ok(byteLength(mixedLongName) <= SMS_MAX_BYTES);
});

test('사본: 고객 발송(이미지 2장 포함)이 나간 날 사본 번호로 사진·제목 없는 단문 SMS 1통만 발송, 같은 날 두 번째 실행은 0', async () => {
  const none = setup({ orders: [order(1, '010-3333-4444', '2026-10-31', '류플로라')] });
  const noneProvider = fakeProvider();
  const base = await runCopy(none, noneProvider, '');
  assert.equal(base.copy, undefined);
  const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-31', '류플로라')] });
  const provider = fakeProvider();
  const out = await runCopy(db, provider, COPY);
  assert.equal(out.sent, 1);
  assert.equal(out.copy, 'sent');
  assert.equal(provider.calls.send.length, noneProvider.calls.send.length + 1); // 고객 3통(사진 2·본문) + 관리자 확인 단문 1통
  const adminCall = provider.calls.send[3];
  assert.equal(adminCall.messages.length, 1);
  const adminMsg = adminCall.messages[0];
  assert.equal(adminMsg.to, COPY);
  assert.equal(adminMsg.fileId, undefined);
  assert.equal(adminMsg.subject, undefined);
  assert.equal(classifyText(adminMsg.text, adminMsg.subject).type, 'SMS');
  assert.ok(byteLength(adminMsg.text) <= SMS_MAX_BYTES);
  assert.equal(adminMsg.text, '[소개 혜택 안내] 금일 류플로라님에게 발송 완료되었습니다.');
  assert.equal(db.state.sends.length, 1); // 관리자 확인 문자는 sms_auto_sends 에 넣지 않는다
  db.state.orders.push(order(2, '010-5555-6666', '2026-10-30', '예성떡집'));
  const again = await runCopy(db, provider, COPY);
  assert.equal(again.sent, 1);
  assert.equal(again.copy, undefined);
  assert.equal(provider.calls.send.length, noneProvider.calls.send.length + 1 + 3);
});
test('사본 발송이 예외를 던져도 고객 발송 결과·기록은 사본이 없을 때와 같다', async () => {
  const plain = setup({ orders: [order(1, '010-3333-4444', '2026-10-31')] });
  const plainOut = await runCopy(plain, fakeProvider(), '');
  const db = setup({ orders: [order(1, '010-3333-4444', '2026-10-31')] });
  const provider = fakeProvider();
  const original = provider.sendEach;
  provider.sendEach = async (input) => { if (input.messages[0].to === COPY) throw new Error('boom'); return original(input); };
  const out = await runCopy(db, provider, COPY);
  assert.deepEqual([out.sent, out.failed, out.uncertain, out.claimed], [plainOut.sent, plainOut.failed, plainOut.uncertain, plainOut.claimed]);
  assert.equal(out.copy, 'failed');
  assert.deepEqual(db.state.sends.map(r => [r.status, r.part_status]), plain.state.sends.map(r => [r.status, r.part_status]));
});
test('문구 저장: 사본 번호는 숫자만 저장, 형식이 틀리면 거절, 사본만 바꿔도 켜짐은 그대로', async () => {
  const db = setup();
  const auto = { kind: 'ship_plus_days', days: 20 };
  const created = await saveTextTemplate(db, { name: '사본', body: BODY, auto: { ...auto, copy_to: '010-7731-4237' } });
  assert.equal(created.status, 201);
  assert.equal(created.body.item.auto_copy_to, COPY);
  assert.equal(db.state.templates[0].auto_copy_to, COPY);
  const bad = await saveTextTemplate(db, { name: '사본2', body: BODY, auto: { ...auto, copy_to: '02-123-4567' } });
  assert.deepEqual([bad.status, bad.body.error.message], [400, '사본 받을 번호가 휴대폰 번호 형식이 아닙니다.']);
  db.state.templates[0].auto_enabled = true;
  const changed = await saveTextTemplate(db, { id: created.body.item.id, name: '사본', body: BODY, auto: { ...auto, copy_to: '010-1111-2222' } });
  assert.equal(changed.body.item.auto_enabled, true);
  assert.equal(changed.body.item.auto_copy_to, '01011112222');
});

// ---- 광고 문자 일괄 발송(이미 출고된 주문에 한 번 보내기, 2026-11-17) ----
const CU = { auto_repeat: 10, auto_interval: 50, auto_catchup_from: '2026-06-01', auto_catchup_at: '2026-11-20T09:00' };
const runCu = (db, provider, extra = {}) => {
  const t = db.state.tpl;
  return runAutoSend({ id: t.id, name: t.name, body: t.body, images: [], auto_kind: t.auto_kind, auto_days: t.auto_days, auto_enabled: true, auto_start_date: t.auto_start_date, auto_send_from: '', auto_repeat: t.auto_repeat || 1, auto_interval: t.auto_interval || 30, auto_ata_template: '', auto_catchup_from: t.auto_catchup_from || '', auto_catchup_at: t.auto_catchup_at || '', auto_catchup_daily: t.auto_catchup_daily || 0, auto_catchup_done: Boolean(t.auto_catchup_done), auto_catchup_paused: Boolean(t.auto_catchup_paused) }, { db, provider, env: ENV, nowMs: NOW, ...extra });
};

test('광고 일괄 발송: 출고 100일 지난 번호가 한 번 선점·발송되고 kind=catchup·회차는 식 값이며 다음 실행엔 다시 안 나간다', async () => {
  const db = setup({ template: CU, orders: [order(1, '010-3333-4444', '2026-08-12'), order(2, '010-5555-6666', '2026-10-31')] });
  const provider = fakeProvider();
  const out = await runCu(db, provider);
  assert.equal(out.claimed, 2);
  assert.equal(out.catchup, 1);
  const cu = db.state.sends.find(r => r.phone_hash === phoneHash('010-3333-4444'));
  assert.deepEqual([cu.kind, cu.round, cu.status], ['catchup', 3, 'sent']); // age 100, days 20, interval 50 → floor((100-20+25)/50)+1 = 3
  assert.equal(db.state.sends.find(r => r.phone_hash === phoneHash('010-5555-6666')).kind, null);
  const sendsBefore = provider.calls.send.length;
  const next = await runCu(db, provider, { nowMs: NOW + 86400000 });
  assert.equal(next.catchup, undefined);
  assert.equal(provider.calls.send.length, sendsBefore);
  assert.equal(db.state.tpl.auto_catchup_done, true);
});

test('광고 일괄 발송: 대상이 0건이면 완료 표시가 나가고, 일괄 설정이 비면 일괄 조회·완료 표시 SQL 이 없다', async () => {
  const empty = setup({ template: CU, orders: [order(2, '010-5555-6666', '2026-10-31')] });
  const emptyOut = await runCu(empty, fakeProvider());
  assert.equal(emptyOut.ran, true);
  assert.equal(empty.state.tpl.auto_catchup_done, true);
  const plain = setup({ orders: [order(2, '010-5555-6666', '2026-10-31')] });
  const plainOut = await runCu(plain, fakeProvider());
  assert.equal(plainOut.claimed, 1);
  assert.equal(plainOut.catchup, undefined);
  assert.ok(plain.state.sql.every(sql => !sql.includes('ship_date DESC') && !sql.includes('auto_catchup_done_at') && !sql.includes(', kind)')));
});

test('광고 일괄 발송: 평소 상한 30 이 찬 날에도 일괄은 30건까지 나가고, 일괄이 섞인 발송이 실패하면 멈춤 표시가 찍힌다', async () => {
  const old = Array.from({ length: 31 }, (_, i) => order(100 + i, `0101000${String(i).padStart(4, '0')}`, '2026-08-12'));
  const full = setup({ template: CU, orders: [order(2, '010-5555-6666', '2026-10-31'), ...old] });
  for (let i = 0; i < 30; i += 1) full.state.sends.push({ id: 900 + i, template_id: 9, phone_hash: `p${i}`, order_id: 900 + i, kst_date: '2026-11-20', status: 'sent', kind: null });
  const out = await runCu(full, fakeProvider());
  assert.equal(out.claimed, 30);
  assert.equal(out.catchup, 30);
  assert.equal(full.state.sends.filter(r => r.template_id === 7 && r.kind === 'catchup').length, 30);
  assert.equal(full.state.sends.some(r => r.phone_hash === phoneHash('010-5555-6666')), false); // 평소 항목은 상한 때문에 못 나갔다
  const bad = setup({ template: CU, orders: [order(2, '010-5555-6666', '2026-10-31'), order(3, '010-3333-4444', '2026-08-12')] });
  const failed = await runCu(bad, fakeProvider({ sendResults: [{ accepted: 0, failed: 2, groupId: 'G', uncertain: false, error: '거절됨' }] }));
  assert.equal(failed.failed, 2);
  assert.equal(failed.catchup, 0);
  assert.equal(bad.state.tpl.auto_catchup_paused, true);
  assert.match(bad.state.tpl.auto_catchup_error, /거절/);
  const capped = setup({ template: { ...CU, auto_catchup_daily: 5 }, orders: old });
  assert.equal((await runCu(capped, fakeProvider())).catchup, 5); // 문구별 하루 최대 건수도 따른다
});

test('문구 저장: 광고 ship_plus_days 의 일괄 발송 값이 저장·조회되고, 일괄 값만 바꾼 저장은 켜짐을 끄지 않으며, 주문 후에서는 비워 저장된다', async () => {
  const db = setup();
  const auto = { kind: 'ship_plus_days', days: 20, catchup: { from: '2026-06-01', at: '2026-11-21T09:00' } };
  const created = await saveTextTemplate(db, { name: '일괄', body: BODY, auto });
  assert.equal(created.status, 201);
  assert.deepEqual([created.body.item.auto_catchup_from, created.body.item.auto_catchup_at], ['2026-06-01', '2026-11-21T09:00']);
  assert.equal(db.state.templates[0].auto_catchup_at, '2026-11-21T09:00');
  const got = await getTextTemplate(db, { id: created.body.item.id });
  assert.deepEqual([got.body.item.auto_catchup_from, got.body.item.auto_catchup_at, got.body.item.auto_catchup_done], ['2026-06-01', '2026-11-21T09:00', false]);
  db.state.templates[0].auto_enabled = true;
  const moved = await saveTextTemplate(db, { id: created.body.item.id, name: '일괄', body: BODY, auto: { ...auto, catchup: { from: '2026-07-01', at: '2026-11-22T10:00' } } });
  assert.equal(moved.body.item.auto_enabled, true);
  assert.equal(moved.body.item.auto_disabled, undefined);
  const guard = db.state.sql.filter(sql => sql.startsWith('UPDATE sms_text_templates SET name = ?, body = ?, auto_enabled = false')).at(-1);
  assert.ok(guard && !guard.includes('auto_catchup_from'));
  const orderBased = await saveTextTemplate(db, { name: '주문후', body: BODY, auto: { kind: 'order_plus_days', days: 3, catchup: { from: '2026-06-01', at: '2026-11-21T09:00' } } });
  assert.equal(orderBased.status, 201);
  assert.equal(orderBased.body.item.auto_catchup_at, undefined);
  assert.equal(db.state.templates.at(-1).auto_catchup_at, '');
});

// ---- 2026-11-18 사장님 결정: 광고 문자 통째 실패는 다시 대상·잔액 사전 확인·하루 상한 사유·광고 하루 1통·문구별 오류 격리 ----
const twoOrders = () => [order(1, '010-3333-4444', '2026-10-31'), order(2, '010-5555-6666', '2026-10-31')];

test('통째 실패(failed)로 남은 기존 행은 선점으로 치지 않아 다음 실행이 다시 보내고, 실패 행은 지워진다', async () => {
  const db = setup({ orders: twoOrders() });
  db.state.sends.push({ id: 90, template_id: 7, phone_hash: phoneHash('010-3333-4444'), order_id: 1, kst_date: '2026-11-19', status: 'failed', round: 1, part_status: JSON.stringify(['failed', 'skipped', 'skipped']) });
  db.state.nextId = 91;
  const provider = fakeProvider();
  const out = await run(db, provider);
  assert.equal(out.sent, 2, '실패했던 1번 번호도 다시 대상');
  assert.equal(db.state.sends.filter(r => r.status === 'failed').length, 0);
  assert.equal(db.state.sends.filter(r => r.status === 'sent').length, 2);
});

test('잔액이 모자라면 선점·업로드·발송 없이 끝나고 사유를 남긴다 / 조회 실패·충분하면 종전대로 보낸다', async () => {
  let db = setup({ orders: twoOrders() });
  let provider = fakeProvider();
  let out = await run(db, provider, { kakao: { async getBalance() { return 100; } } });
  assert.equal(out.reason, 'balance_short');
  assert.equal(db.state.sends.length, 0); assert.equal(provider.calls.send.length, 0); assert.equal(provider.calls.upload.length, 0);
  assert.match(db.state.skips[0], /^잔액 부족: 필요 \d+원, 잔액 100원$/);
  for (const balance of ['throw', null, 100000]) {
    db = setup({ orders: twoOrders() });
    provider = fakeProvider();
    out = await run(db, provider, { kakao: { async getBalance() { if (balance === 'throw') throw new Error('boom'); return balance; } } });
    assert.equal(out.sent, 2, `잔액 ${balance}`);
  }
});

test('하루 상한에 막히면 사유(하루 상한 N건 도달, 남은 M건 다음 날)를 남긴다', async () => {
  const db = setup({ orders: twoOrders() });
  db.state.sends.push({ id: 50, template_id: 7, phone_hash: phoneHash('010-9999-0000'), order_id: 99, kst_date: '2026-11-20', status: 'sent', round: 1 });
  const out = await run(db, fakeProvider(), { env: { ...ENV, SMS_AUTO_MAX_PER_DAY: '1' } });
  assert.equal(out.reason, 'cap');
  assert.deepEqual(db.state.skips, ['하루 상한 1건 도달, 남은 2건 다음 날']);
});

test('오늘 브랜드메시지(광고)가 나간 번호에는 광고 문자를 보내지 않는다(광고 하루 1통)', async () => {
  const db = setup({ orders: twoOrders() });
  db.state.bmsToday = [eventPhoneHash('010-3333-4444')];
  const provider = fakeProvider();
  const out = await run(db, provider);
  assert.equal(out.sent, 1);
  assert.deepEqual(provider.calls.send[0].messages.map(m => m.to), ['01055556666']);
});

test('문구 하나가 예외로 끝나도 사유(실행 오류: 앞 80자·긴 숫자 가림)를 남기고 null 을 돌려준다', async () => {
  const db = setup({ orders: [] });
  const long = `보내기 실패 번호 01012345678 ${'가'.repeat(120)}`;
  const result = await runGuarded(db, { id: 7 }, async () => { throw new Error(long); }, () => {});
  assert.equal(result, null);
  assert.ok(db.state.skips[0].startsWith('실행 오류: 보내기 실패 번호 ***'));
  assert.ok(db.state.skips[0].length <= '실행 오류: '.length + 80);
});
