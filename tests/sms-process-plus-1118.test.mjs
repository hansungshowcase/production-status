// 2026-11-18 20:45 발송 조건 변경 시험(after 없는 chain · process_started_plus_days · auto_mark_sent · 화면 모델). 가짜 db·가짜 발송기만 쓴다(실제 발송 없음). 아래 가짜 db 는 sms-auto-chain.test.mjs 사본에 공정·기록 넣기 처리를 더한 것이다.
// (원 주석) 연쇄 발송(auto_chain) 시험. 가짜 db·가짜 발송기만 쓴다(실제 발송·쏠라피 호출 없음). 가짜 db 는 tests/sms-auto-send.test.mjs 것에 연쇄 앞 문구 조회 두 줄만 더한 사본이다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { _resetTextTemplateSchemaForTest, getTextTemplate, parseAutoChain, saveTextTemplate } from '../api/_lib/smsTextTemplates.js';
import { _resetManualSendSchemaForTest } from '../api/_lib/smsManualSend.js';
import {
  _resetAutoSchemaForTest, adCheck, autoStatus, autoToggle, autoTest, buildParts, findTargets, kstDate, optoutAdd, phoneHash, runAutoSend, runAutoSendAll,
} from '../api/_lib/smsAutoSend.js';
import { getSendProvider } from '../api/_lib/sendProvider.js';
import { parseBmsConfig } from '../api/_lib/smsBms.js';
import { bmsButtonsCheck } from '../shared/smsBmsLimits.js';
import { eventPhoneHash, runGuarded } from '../api/_lib/smsEventSend.js';
import { autoMarkSent } from '../api/_lib/smsAutoSend.js';
import { handleSmsConsole } from '../api/sms-console.js';
import { autoEffective } from '../shared/smsAutoEffective.js';
import { groupFlows, flowStepText } from '../src/components/smsconsole/smsTemplateListModel.js';
import { autoConditionLine, autoTargetText, buildSaveBody, validateTextForm, AUTO_KINDS as UI_KINDS } from '../src/components/smsconsole/smsTextTemplateFormModel.js';

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
      if (t.startsWith('SELECT DISTINCT phone_hash FROM sms_event_sends WHERE template_id')) return { rows: (state.eventSends || []).filter(r => r.template_id === args[0] && r.kst_date === args[1] && r.status === 'sent').map(r => ({ phone_hash: r.phone_hash })) }; // 연쇄: 앞 문구가 오늘 보낸 번호
      if (t.startsWith('SELECT DISTINCT phone_hash FROM sms_auto_sends WHERE template_id')) return { rows: state.sends.filter(r => r.template_id === args[0] && r.kst_date === args[1] && r.status === 'sent').map(r => ({ phone_hash: r.phone_hash })) };
      if (t.startsWith('UPDATE sms_text_templates SET auto_enabled = CASE WHEN COALESCE(auto_chain')) { const row = state.templates.find(r => r.id === args[2]); if ((row.auto_chain || '') !== args[0]) row.auto_enabled = false; row.auto_chain = args[1]; return { rows: [{ id: row.id }] }; }
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
        for (const r of state.sends.filter(x => x.template_id === args[0] && !(t.includes("<> 'make_migrated'") && x.reason === 'make_migrated'))) { by[r.status] = by[r.status] || { status: r.status, n: 0, last: '' }; by[r.status].n += 1; if (r.kst_date > by[r.status].last) by[r.status].last = r.kst_date; }
        return { rows: Object.values(by) };
      }
      if (t.startsWith("SELECT COUNT(*) AS n FROM sms_auto_sends WHERE template_id = ? AND status = 'sent'")) return { rows: [{ n: state.sends.filter(r => r.template_id === args[0] && r.status === 'sent' && r.kst_date >= args[1]).length }] };
      if (t.startsWith('INSERT INTO sms_auto_sends') && !t.includes('make_migrated')) {
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
      if (t.includes('FROM processes p JOIN orders o')) {
        (state.procCalls ||= []).push({ t, args });
        const [step, from, to] = args;
        const ISO = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(.[0-9]+)?Z$/;
        const rows = (state.processes || []).filter(p => p.step_name === step && p.started_at && ISO.test(p.started_at) && p.started_at >= from && p.started_at < to)
          .map(p => ({ p, o: state.orders.find(x => x.id === p.order_id) })).filter(x => x.o && x.o.status !== 'cancelled')
          .map(x => ({ id: x.o.id, phone: x.o.phone, client_name: x.o.client_name, started_at: x.p.started_at }));
        return { rows };
      }
      if (t.startsWith('INSERT INTO sms_event_sends') && t.includes('make_migrated')) {
        state.eventRows ||= []; const rows = [];
        for (let i = 0; i < args.length; i += 5) {
          const [template_id, dedupe_key, phone_hash, , kst_date] = args.slice(i, i + 5);
          const old = state.eventRows.find(r => r.template_id === template_id && r.dedupe_key === dedupe_key);
          if (old) { if (old.status === 'failed') { old.status = 'sent'; old.reason = 'make_migrated'; rows.push({ id: old.id, fresh: false }); } continue; }
          const row = { id: state.eventRows.length + 1, template_id, dedupe_key, phone_hash, kst_date, status: 'sent', reason: 'make_migrated' }; state.eventRows.push(row); rows.push({ id: row.id, fresh: true });
        }
        return { rows };
      }
      if (t.startsWith('INSERT INTO sms_auto_sends') && t.includes('make_migrated')) {
        const rows = [];
        for (let i = 0; i < args.length; i += 4) {
          const [template_id, phone_hash, , kst_date] = args.slice(i, i + 4);
          const old = state.sends.find(r => r.template_id === template_id && r.phone_hash === phone_hash && (r.round || 1) === 1);
          if (old) { if (old.status === 'failed') { old.status = 'sent'; old.reason = 'make_migrated'; rows.push({ id: old.id, fresh: false }); } continue; }
          const row = { id: state.nextId++, template_id, phone_hash, order_id: null, kst_date, status: 'sent', round: 1, reason: 'make_migrated' }; state.sends.push(row); rows.push({ id: row.id, fresh: true });
        }
        return { rows };
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
const setup = opts => { _resetAutoSchemaForTest(); _resetTextTemplateSchemaForTest(); _resetManualSendSchemaForTest(); return fakeDb(opts); };
const PLAIN = 'https://cafe.naver.com/01027857623/1757'; // (광고)·080 이 없는 Make 원문 같은 본문
const CHAIN = { after: 19, subject: '한성쇼케이스 SNS 리뷰 4만원 지급이벤트', from: '01077314237', plain: true };
const tpl = (extra = {}) => ({ id: 7, name: 'SNS 리뷰 이벤트', body: PLAIN, images: [JPG], auto_kind: 'ship_plus_days', auto_days: 1, auto_enabled: true, auto_start_date: '2026-10-01', auto_send_from: '', auto_repeat: 1, auto_interval: 30, auto_chain: CHAIN, ...extra });
const go = (db, provider, template, extra = {}) => runAutoSend(template, { db, provider, env: ENV, nowMs: NOW, ...extra });
const shipped = '2026-11-19'; // days=1 이면 어제 출고분이 오늘 대상

// ---------- 1. after 없는 chain ----------
const NO_AFTER = { subject: '한성쇼케이스 SNS 리뷰 4만원 지급이벤트', from: '01077314237', plain: true };

test('after 없는 chain: 연쇄 판정 없이 plain·제목·발신번호만 적용된다(앞 문구 기록이 없어도 나간다)', async () => {
  const db = setup({ orders: [order(1, '010-1111-2222', shipped)] });
  const provider = fakeProvider();
  const out = await go(db, provider, tpl({ auto_chain: NO_AFTER }));
  assert.equal(out.reason, ''); assert.equal(out.claimed, 1); assert.equal(out.sent, 1);
  const call = provider.calls.send[0];
  assert.equal(call.from, '01077314237');
  assert.equal(call.messages[0].subject, NO_AFTER.subject);
  assert.equal(call.messages[0].text, PLAIN);
});

test('after 없는 chain: 수신거부·번호당 1회는 그대로, 오늘 광고를 받은 번호도 막지 않는다(Make 와 같게)', async () => {
  const db = setup({ orders: [order(1, '010-1111-2222', shipped), order(2, '010-3333-4444', shipped)], optouts: ['01033334444'] });
  db.state.bmsToday = [eventPhoneHash('01011112222')];
  db.state.sends.push({ id: 90, template_id: 55, phone_hash: phoneHash('01011112222'), order_id: 900, kst_date: '2026-11-20', status: 'sent', round: 1 });
  const provider = fakeProvider();
  const first = await go(db, provider, tpl({ auto_chain: NO_AFTER }));
  assert.equal(first.claimed, 1, '수신거부 번호는 빠지고 나머지는 나간다');
  const again = await go(db, provider, tpl({ auto_chain: NO_AFTER }));
  assert.equal(again.claimed, 0, '번호당 1회');
});

test('after 있는 chain 은 종전과 같다(앞 문구 기록이 있어야 나간다)', async () => {
  const db = setup({ orders: [order(1, '010-1111-2222', shipped)] });
  const none = await go(db, fakeProvider(), tpl());
  assert.equal(none.claimed, 0);
  db.state.eventSends = [{ template_id: 19, kst_date: '2026-11-20', status: 'sent', phone_hash: eventPhoneHash('01011112222') }];
  assert.equal((await go(db, fakeProvider(), tpl())).claimed, 1);
});

test('chain 저장: after 없이 저장·조회되고, 빈 객체는 지우며, 잘못된 after 는 400 이다', async () => {
  const db = setup({});
  const made = await saveTextTemplate(db, { name: 'SNS 설비+2', body: PLAIN, auto_chain: NO_AFTER }, { staff: [] });
  assert.equal(made.status, 201); assert.deepEqual(made.body.item.auto_chain, NO_AFTER);
  assert.equal((await saveTextTemplate(db, { id: made.body.item.id, name: 'SNS 설비+2', body: PLAIN, auto_chain: { after: 'x' } }, { staff: [] })).status, 400);
  assert.deepEqual(parseAutoChain({ after: 19 }), { after: 19, subject: '', from: '', plain: false });
  assert.equal(parseAutoChain({}), null);
});

// ---------- 2. process_started_plus_days ----------
const KIND = 'process_started_plus_days';
const procTpl = (extra = {}) => tpl({ auto_kind: KIND, auto_days: 2, auto_step: '설비작업', auto_chain: NO_AFTER, ...extra });
const proc = (order_id, started_at, step_name = '설비작업') => ({ order_id, step_name, started_at });
const plain = (id, phone, extra = {}) => ({ id, phone, client_name: '김철수', status: 'in_progress', ...extra });

test('process_started_plus_days: 설비작업 시작일(KST)+2일=오늘(11-20) 이면 대상이고, KST 날짜 경계를 정확히 본다', async () => {
  const db = setup({ orders: [plain(1, '010-1111-0001'), plain(2, '010-1111-0002'), plain(3, '010-1111-0003'), plain(4, '010-1111-0004')] });
  db.state.processes = [
    proc(1, '2026-11-17T15:00:00.000Z'), // KST 11-18 00:00 → 대상
    proc(2, '2026-11-18T14:59:59Z'), // KST 11-18 23:59 → 대상
    proc(3, '2026-11-18T15:00:00Z'), // KST 11-19 00:00 → 내일 대상
    proc(4, '2026-11-17T14:59:59Z'), // KST 11-17 23:59 → 어제 대상(3일 창 안)
  ];
  const got = await findTargets(db, { nowMs: NOW, days: 2, startDate: '2026-10-01', kind: KIND, step: '설비작업' });
  assert.deepEqual(got.map(t => [t.orderId, t.shipDate]).sort(), [[1, '2026-11-18'], [2, '2026-11-18'], [4, '2026-11-17']]);
});

test('process_started_plus_days: 3일 재시도 창·켠 날 이전 예정일 제외', async () => {
  const db = setup({ orders: [plain(1, '010-1111-0001'), plain(2, '010-1111-0002'), plain(3, '010-1111-0003')] });
  db.state.processes = [proc(1, '2026-11-14T05:00:00Z'), proc(2, '2026-11-15T05:00:00Z'), proc(3, '2026-11-17T05:00:00Z')]; // 11-14(창 밖) · 11-15(창 첫날) · 11-17
  const open = await findTargets(db, { nowMs: NOW, days: 2, startDate: '2026-10-01', kind: KIND, step: '설비작업' });
  assert.deepEqual(open.map(t => t.orderId).sort(), [2, 3]);
  const afterOn = await findTargets(db, { nowMs: NOW, days: 2, startDate: '2026-11-18', kind: KIND, step: '설비작업' }); // 시작일 > 상한이면 대상 없음
  assert.deepEqual(afterOn, []);
  const onDay = await findTargets(db, { nowMs: NOW, days: 2, startDate: '2026-11-17', kind: KIND, step: '설비작업' });
  assert.deepEqual(onDay.map(t => t.orderId), [3]);
});

test('process_started_plus_days: started_at 이 없거나 되돌려진 건·취소·전화 없음·유선·다른 공정은 제외', async () => {
  const db = setup({ orders: [plain(1, '010-1111-0001'), plain(2, '010-1111-0002', { status: 'cancelled' }), plain(3, ''), plain(4, '010-1111-0004'), plain(5, '010-1111-0005'), plain(6, '02-123-4567')] });
  db.state.processes = [
    proc(1, null), // 되돌림(started_at 비움)
    proc(2, '2026-11-18T01:00:00Z'), proc(3, '2026-11-18T01:00:00Z'),
    proc(4, '2026-11-18T01:00:00Z', '도면설계'), // 다른 공정
    proc(5, '2026-11-18T01:00:00Z'), // 정상
    proc(6, '2026-11-18T01:00:00Z'), // 유선 번호
  ];
  const got = await findTargets(db, { nowMs: NOW, days: 2, startDate: '2026-10-01', kind: KIND, step: '설비작업' });
  assert.deepEqual(got.map(t => t.orderId), [5]);
  assert.deepEqual(await findTargets(db, { nowMs: NOW, days: 2, startDate: '2026-10-01', kind: KIND, step: '없는공정' }), []);
});

test('process_started_plus_days 발송: 번호당 1회 기록(sms_auto_sends), 제목·발신·plain 적용, 다시 돌려도 안 나간다, 같은 번호 두 주문은 1통', async () => {
  const db = setup({ orders: [plain(1, '010-1111-0001'), plain(2, '010-1111-0001'), plain(3, '010-1111-0003')] });
  db.state.processes = [proc(1, '2026-11-18T01:00:00Z'), proc(2, '2026-11-18T02:00:00Z'), proc(3, '2026-11-18T03:00:00Z')];
  const provider = fakeProvider();
  const out = await go(db, provider, procTpl());
  assert.equal(out.reason, ''); assert.equal(out.claimed, 2); assert.equal(out.sent, 2);
  assert.equal(provider.calls.send[0].from, '01077314237');
  assert.equal(provider.calls.send[0].messages[0].subject, NO_AFTER.subject);
  assert.ok(db.state.sends.every(r => r.status === 'sent' && r.round === 1));
  assert.equal((await go(db, provider, procTpl())).claimed, 0);
  const noStep = await go(setup({ orders: [] }), fakeProvider(), procTpl({ auto_step: '' }));
  assert.equal(noStep.reason, 'no_step');
});

test('process_started_plus_days 저장·켜기·상태: 공정 필수, 일수 1 이상, 알림톡 불가, 공정 없으면 막힘 표시', async () => {
  const db = setup({});
  const ok = await saveTextTemplate(db, { name: '설비+2', body: PLAIN, auto: { kind: KIND, days: 2, step: '설비작업' } }, { staff: [] });
  assert.equal(ok.status, 201); assert.equal(ok.body.item.auto_kind, KIND); assert.equal(ok.body.item.auto_step, '설비작업'); assert.equal(ok.body.item.auto_days, 2);
  assert.equal((await saveTextTemplate(db, { name: '설비+2 b', body: PLAIN, auto: { kind: KIND, days: 2 } }, { staff: [] })).status, 400, '공정 필수');
  assert.equal((await saveTextTemplate(db, { name: '설비+2 c', body: PLAIN, auto: { kind: KIND, days: 0, step: '설비작업' } }, { staff: [] })).status, 400);
  assert.equal((await saveTextTemplate(db, { name: '설비+2 d', body: PLAIN, auto: { kind: KIND, days: 2, step: '설비작업', ata_template: 'KA01TP1' } }, { staff: [] })).status, 400, '알림톡 불가');
  const d2 = setup({});
  d2.state.tpl = { ...d2.state.tpl, ...procTpl({ auto_step: '', auto_enabled: true, images: JSON.stringify([JPG]), auto_chain: JSON.stringify(NO_AFTER) }) };
  const status = await autoStatus(d2, { id: 7, nowMs: NOW, env: ENV });
  assert.equal(status.body.enable_blocked_reason, 'no_step'); assert.equal(status.body.effective, false);
  const toggled = await autoToggle({ id: 7, enabled: true, dry_run: true }, { db: d2, provider: fakeProvider(), env: ENV, nowMs: NOW });
  assert.equal(toggled.status, 400); assert.equal(toggled.body.reason, 'no_step');
  const d3 = setup({ orders: [plain(1, '010-1111-0001')] });
  d3.state.processes = [proc(1, '2026-11-18T01:00:00Z')];
  d3.state.tpl = { ...d3.state.tpl, ...procTpl({ auto_enabled: true, images: JSON.stringify([JPG]), auto_chain: JSON.stringify(NO_AFTER) }) };
  const live = await autoStatus(d3, { id: 7, nowMs: NOW, env: ENV });
  assert.equal(live.body.today_targets, 1);
});

// ---------- 3. auto_mark_sent ----------
test('auto_mark_sent(광고 문자 갈래): sms_auto_sends 회차 1 sent 로 넣고, 중복·잘못된 번호는 세어 건너뛰고, 넣은 번호는 다시 안 나간다', async () => {
  const db = setup({ orders: [order(1, '010-1111-2222', shipped), order(2, '010-3333-4444', shipped)] });
  const first = await autoMarkSent({ template_id: 7, phones: ['010-1111-2222', '01011112222', '123', '01099998888'] }, { db });
  assert.equal(first.status, 200);
  assert.deepEqual([first.body.inserted, first.body.skipped, first.body.invalid, first.body.duplicated_in_request, first.body.via], [2, 0, 1, 1, 'auto']);
  const second = await autoMarkSent({ template_id: 7, phones: ['01011112222', '01077778888'] }, { db });
  assert.deepEqual([second.body.inserted, second.body.skipped], [1, 1]);
  assert.ok(db.state.sends.every(r => r.status === 'sent' && r.round === 1 && r.kst_date === '1970-01-01'));
  const provider = fakeProvider();
  const out = await go(db, provider, tpl({ auto_chain: NO_AFTER }));
  assert.deepEqual(provider.calls.send.flatMap(c => c.messages.map(m => m.to)), ['01033334444'], '넣어 둔 번호(01011112222)는 제외');
  assert.equal(out.claimed, 1);
});

test('auto_mark_sent(BMS·알림톡 갈래): sms_event_sends 에 <해시>:ship sent 로 넣고 중복은 건너뛴다. 알 수 없는 문구·빈 번호는 거절', async () => {
  const db = setup({});
  db.state.tpl = { ...db.state.tpl, id: 20, auto_ata_template: 'BMS_FREE', auto_kind: 'ship_plus_days', auto_days: 1 };
  const out = await autoMarkSent({ template_id: 20, phones: ['01011112222', '01033334444'] }, { db });
  assert.equal(out.status, 200); assert.equal(out.body.via, 'event'); assert.equal(out.body.inserted, 2);
  assert.deepEqual(db.state.eventRows.map(r => r.dedupe_key).sort(), [`${eventPhoneHash('01011112222')}:ship`, `${eventPhoneHash('01033334444')}:ship`].sort());
  assert.ok(db.state.eventRows.every(r => r.status === 'sent' && r.template_id === 20));
  const dup = await autoMarkSent({ template_id: 20, phones: ['01011112222'] }, { db });
  assert.deepEqual([dup.body.inserted, dup.body.skipped], [0, 1]);
  assert.equal((await autoMarkSent({ template_id: 999, phones: ['01011112222'] }, { db })).status, 404);
  assert.equal((await autoMarkSent({ template_id: 20, phones: [] }, { db })).status, 400);
});

test('auto_mark_sent API: 같은 출처·쓰기 잠금 통과 뒤 처리하고, 관리자가 아닌 로그인 사용자는 403 이다', async () => {
  const db = setup({});
  const res = () => ({ statusCode: 200, body: null, headers: {}, setHeader(k, v) { this.headers[k] = v; }, status(c) { this.statusCode = c; return this; }, json(b) { this.body = b; return this; } });
  const req = (auth) => ({ method: 'POST', body: { action: 'auto_mark_sent', template_id: 7, phones: ['01011112222'] }, query: {}, url: '/api/sms-console', socket: { remoteAddress: '9.9.9.9' }, headers: { origin: 'https://production-status.vercel.app', host: 'production-status.vercel.app', 'x-forwarded-proto': 'https' }, ...(auth ? { auth } : {}) });
  const deps = { db, kakao: {}, guard: { writeStatus: async () => ({ enabled: true }) }, nowMs: NOW, rateLimitCheck: () => true, hasCredentials: () => true };
  const denied = res(); await handleSmsConsole(req({ role: 'sales' }), denied, deps);
  assert.equal(denied.statusCode, 403); assert.equal(db.state.sends.length, 0);
  const allowed = res(); await handleSmsConsole(req({ role: 'admin' }), allowed, deps);
  assert.equal(allowed.statusCode, 200); assert.equal(allowed.body.inserted, 1);
  const locked = res(); await handleSmsConsole(req(), locked, { ...deps, guard: { writeStatus: async () => ({ enabled: false }) } });
  assert.equal(locked.statusCode, 503);
});

// ---------- 4. 화면 모델(문구 목록·편집 화면·켜짐 판정) ----------
test('화면: 공정 시작 후 N일(설비작업)은 종류 이름·단계 칩·조건 줄·대상 줄이 비지 않는다', () => {
  assert.ok(UI_KINDS.includes(KIND));
  const entry = { id: 21, autoKind: KIND, autoDays: 2, autoStep: '설비작업', autoSendTime: '12:30', autoEnabled: true, name: 'SNS 리뷰 이벤트(설비+2일)' };
  assert.match(autoConditionLine(entry), /공정 시작 후\(설비작업\) 2일 뒤/);
  assert.match(autoTargetText(entry), /설비작업 공정 시작일\+2일=오늘/);
  const flows = groupFlows([entry]);
  assert.equal(flows[0].label, '공정 시작 후(설비작업)');
  assert.equal(flowStepText(entry), '2일');
  // 설비 진입 즉시형(process_started)도 같이 보인다
  const instant = { id: 20, autoKind: 'process_started', autoStep: '설비작업', autoAtaTemplate: 'BMS_FREE', autoEnabled: true, name: '블로그 리뷰 이벤트(설비 진입)' };
  assert.match(autoConditionLine(instant), /공정 시작 시\(설비작업\)/);
  assert.match(autoTargetText(instant), /설비작업 공정 시작/);
  assert.equal(groupFlows([instant])[0].label, '공정 시작 시(설비작업)');
});

test('화면: 저장 본문에 공정이 실리고 공정이 없으면 폼 검사가 막으며, 공정 없는 켜짐은 막힘으로 보인다', () => {
  const body = buildSaveBody({ name: 'x', body: 'b', auto: { kind: KIND, days: '2', step: '설비작업', sendTime: '12:30' } });
  assert.deepEqual([body.auto.kind, body.auto.days, body.auto.step, body.auto.auto_send_time], [KIND, 2, '설비작업', '12:30']);
  const base = { name: 'x', body: 'https://a.kr', autoKind: KIND, days: '2', sendFrom: '', repeat: '1', interval: '30' };
  assert.equal(validateTextForm({ ...base, step: '' }).reason, 'step');
  assert.equal(validateTextForm({ ...base, step: '설비작업' }).ok, true);
  const eff = autoEffective({ enabled: true, enable_blocked_reason: 'no_step' }, NOW);
  assert.equal(eff.blocked, true); assert.match(eff.text, /공정을 골라/);
});

// ---------- 5. 점검 지적 4건 ----------
test('chain 발신번호: 하이픈이 든 010-7731-4237 도 숫자만 남겨 저장·발송에 쓴다', async () => {
  const db = setup({});
  const made = await saveTextTemplate(db, { name: 'SNS 하이픈', body: PLAIN, auto_chain: { subject: '제목', from: '010-7731-4237', plain: true } }, { staff: [] });
  assert.equal(made.status, 201); assert.equal(made.body.item.auto_chain.from, '01077314237');
  assert.equal(parseAutoChain({ from: '010-7731-4237' }).from, '01077314237');
});

test('processStartTargets SQL: ? 자리표시자 수가 넘기는 값 수와 같고, SQL 안에 문자 ? 가 더 없다', async () => {
  const db = setup({ orders: [plain(1, '010-1111-0001')] });
  db.state.processes = [proc(1, '2026-11-18T01:00:00Z')];
  await findTargets(db, { nowMs: NOW, days: 2, startDate: '2026-10-01', kind: KIND, step: '설비작업' });
  const call = db.state.procCalls[0];
  assert.equal([...call.t].filter(ch => ch === '?').length, call.args.length);
  assert.equal(call.args.length, 3);
});

test('auto_mark_sent: 실패 행이 있는 번호는 sent 로 고치고 updated_failed 로 센다(두 갈래)', async () => {
  const db = setup({});
  db.state.sends.push({ id: 70, template_id: 7, phone_hash: phoneHash('01011112222'), order_id: 1, kst_date: '2026-11-19', status: 'failed', round: 1 });
  const auto = await autoMarkSent({ template_id: 7, phones: ['01011112222', '01033334444', '01055556666'] }, { db });
  assert.deepEqual([auto.body.inserted, auto.body.updated_failed, auto.body.skipped], [2, 1, 0]);
  assert.equal(db.state.sends.find(r => r.id === 70).status, 'sent');
  const again = await autoMarkSent({ template_id: 7, phones: ['01011112222'] }, { db });
  assert.deepEqual([again.body.inserted, again.body.updated_failed, again.body.skipped], [0, 0, 1]);
  const ev = setup({});
  ev.state.tpl = { ...ev.state.tpl, id: 20, auto_ata_template: 'BMS_FREE', auto_kind: 'ship_plus_days', auto_days: 1 };
  ev.state.eventRows = [{ id: 1, template_id: 20, dedupe_key: eventPhoneHash('01011112222') + ':ship', status: 'failed' }];
  const out = await autoMarkSent({ template_id: 20, phones: ['01011112222', '01033334444'] }, { db: ev });
  assert.deepEqual([out.body.inserted, out.body.updated_failed, out.body.skipped], [1, 1, 0]);
  assert.equal(ev.state.eventRows[0].status, 'sent');
});

test('상태 집계: make_migrated 로 넣은 기록은 sent_total·last_sent_date 에 잡히지 않는다', async () => {
  const db = setup({});
  await autoMarkSent({ template_id: 7, phones: ['01011112222'] }, { db });
  db.state.sends.push({ id: 80, template_id: 7, phone_hash: phoneHash('01099990000'), order_id: 5, kst_date: '2026-11-19', status: 'sent', round: 1 });
  const status = await autoStatus(db, { id: 7, nowMs: NOW, env: ENV });
  assert.equal(status.body.sent_total, 1); assert.equal(status.body.last_sent_date, '2026-11-19');
});
