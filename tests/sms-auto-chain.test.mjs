// 연쇄 발송(auto_chain) 시험. 가짜 db·가짜 발송기만 쓴다(실제 발송·쏠라피 호출 없음). 가짜 db 는 tests/sms-auto-send.test.mjs 것에 연쇄 앞 문구 조회 두 줄만 더한 사본이다.
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
const setup = opts => { _resetAutoSchemaForTest(); _resetTextTemplateSchemaForTest(); _resetManualSendSchemaForTest(); return fakeDb(opts); };
const PLAIN = 'https://cafe.naver.com/01027857623/1757'; // (광고)·080 이 없는 Make 원문 같은 본문
const CHAIN = { after: 19, subject: '한성쇼케이스 SNS 리뷰 4만원 지급이벤트', from: '01077314237', plain: true };
const tpl = (extra = {}) => ({ id: 7, name: 'SNS 리뷰 이벤트', body: PLAIN, images: [JPG], auto_kind: 'ship_plus_days', auto_days: 1, auto_enabled: true, auto_start_date: '2026-10-01', auto_send_from: '', auto_repeat: 1, auto_interval: 30, auto_chain: CHAIN, ...extra });
const go = (db, provider, template, extra = {}) => runAutoSend(template, { db, provider, env: ENV, nowMs: NOW, ...extra });
const shipped = '2026-11-19'; // days=1 이면 어제 출고분이 오늘 대상

test('연쇄: 앞 문구(A)가 오늘 sent 로 나간 번호에게만 B 가 나간다(받지 못한 번호·A 실패 번호는 제외)', async () => {
  const db = setup({ orders: [order(1, '010-1111-2222', shipped), order(2, '010-3333-4444', shipped), order(3, '010-5555-6666', shipped)] });
  db.state.eventSends = [
    { template_id: 19, kst_date: '2026-11-20', status: 'sent', phone_hash: eventPhoneHash('01011112222') },
    { template_id: 19, kst_date: '2026-11-20', status: 'failed', phone_hash: eventPhoneHash('01033334444') },
  ];
  const provider = fakeProvider();
  const out = await go(db, provider, tpl());
  assert.equal(out.claimed, 1);
  assert.deepEqual(provider.calls.send.flatMap(c => c.messages.map(m => m.to)), ['01011112222']);
});

test('연쇄: A 가 어제 나갔거나 기록이 없으면 B 는 아무에게도 안 나간다', async () => {
  const db = setup({ orders: [order(1, '010-1111-2222', shipped)] });
  db.state.eventSends = [{ template_id: 19, kst_date: '2026-11-19', status: 'sent', phone_hash: eventPhoneHash('01011112222') }];
  const provider = fakeProvider();
  const out = await go(db, provider, tpl());
  assert.equal(out.claimed, 0); assert.equal(provider.calls.send.length, 0);
});

test('연쇄: 제목과 발신번호가 발송에 실리고, (광고)·080 이 없는 본문도 면제된다(plain)', async () => {
  const db = setup({ orders: [order(1, '010-1111-2222', shipped)] });
  db.state.eventSends = [{ template_id: 19, kst_date: '2026-11-20', status: 'sent', phone_hash: eventPhoneHash('01011112222') }];
  const provider = fakeProvider();
  const out = await go(db, provider, tpl());
  assert.equal(out.reason, ''); assert.equal(out.sent, 1);
  const call = provider.calls.send[0];
  assert.equal(call.from, '01077314237');
  assert.equal(call.messages[0].subject, CHAIN.subject);
  assert.equal(call.messages[0].text, PLAIN);
  assert.ok(call.messages[0].fileId, '사진이 함께 나간다');
});

test('연쇄: 광고 하루 1회 규칙(오늘 다른 문구를 받은 번호 제외)은 연쇄 문구에 적용하지 않는다(Make 와 같게)', async () => {
  const db = setup({ orders: [order(1, '010-1111-2222', shipped)] });
  db.state.eventSends = [{ template_id: 19, kst_date: '2026-11-20', status: 'sent', phone_hash: eventPhoneHash('01011112222') }];
  db.state.bmsToday = [eventPhoneHash('01011112222')]; // 오늘 브랜드메시지(A)를 받음
  db.state.sends.push({ id: 99, template_id: 55, phone_hash: phoneHash('01011112222'), order_id: 900, kst_date: '2026-11-20', status: 'sent', round: 1 }); // 오늘 다른 광고 문자도 받음
  const out = await go(db, fakeProvider(), tpl());
  assert.equal(out.claimed, 1);
});

test('연쇄가 없는 문구는 종전 동작 그대로다: (광고)·080 검사, 제목 없음, 오늘 브랜드메시지 받은 번호 제외', async () => {
  const noChain = tpl({ auto_chain: null, body: PLAIN });
  const blocked = await go(setup({ orders: [order(1, '010-1111-2222', shipped)] }), fakeProvider(), noChain);
  assert.equal(blocked.reason, 'no_ad_prefix');
  const db = setup({ orders: [order(1, '010-1111-2222', shipped), order(2, '010-3333-4444', shipped)] });
  db.state.bmsToday = [eventPhoneHash('01011112222')];
  const provider = fakeProvider();
  const out = await go(db, provider, { ...noChain, body: BODY });
  assert.equal(out.claimed, 1);
  assert.deepEqual(provider.calls.send.flatMap(c => c.messages.map(m => m.to)), ['01033334444']);
  assert.equal(provider.calls.send[0].from, '0212345678');
  assert.equal('subject' in provider.calls.send[0].messages[0], false);
});

test('연쇄 문구의 시험 발송은 제목·발신번호를 싣고 광고 검사 없이 나간다', async () => {
  const db = setup({});
  db.state.tpl = { ...db.state.tpl, ...tpl(), images: JSON.stringify([JPG]) };
  const provider = fakeProvider();
  const out = await autoTest({ id: 7, to: '01012345678', idempotencyKey: 'k-chain-test-0001' }, { db, provider, env: ENV, nowMs: NOW, sleep: async () => {} });
  assert.equal(out.status, 200);
  assert.equal(provider.calls.send[0].from, '01077314237');
  assert.equal(provider.calls.send[0].messages[0].subject, CHAIN.subject);
});

test('연쇄 문구는 (광고)·080 이 없어도 켜기가 된다(plain), 연쇄가 없으면 종전처럼 막힌다', async () => {
  const db = setup({});
  db.state.tpl = { ...db.state.tpl, ...tpl({ auto_enabled: false }), images: JSON.stringify([JPG]) };
  const on = await autoToggle({ id: 7, enabled: true, dry_run: true }, { db, provider: fakeProvider(), env: ENV, nowMs: NOW });
  assert.equal(on.status, 200);
  db.state.tpl = { ...db.state.tpl, auto_chain: null };
  const off = await autoToggle({ id: 7, enabled: true, dry_run: true }, { db, provider: fakeProvider(), env: ENV, nowMs: NOW });
  assert.equal(off.status, 400); assert.equal(off.body.reason, 'no_ad_prefix');
});

test('auto_chain 저장: 저장 API 로 넣고 읽으면 나오고, 칸이 없는 화면 편집 저장은 지우지 않으며, 명시적으로 비우면 지워진다', async () => {
  const db = setup({});
  const made = await saveTextTemplate(db, { name: 'SNS 연쇄', body: PLAIN, auto_chain: CHAIN }, { staff: [] });
  assert.equal(made.status, 201); assert.deepEqual(made.body.item.auto_chain, CHAIN);
  const id = made.body.item.id;
  assert.deepEqual(JSON.parse(db.state.templates.find(r => r.id === id).auto_chain), CHAIN);
  const edited = await saveTextTemplate(db, { id, name: 'SNS 연쇄', body: `${PLAIN} ` }, { staff: [] }); // 화면 편집: auto_chain 키 없음
  assert.equal(edited.status, 200);
  assert.deepEqual(JSON.parse(db.state.templates.find(r => r.id === id).auto_chain), CHAIN, '화면 편집 저장이 연쇄 설정을 지우지 않는다');
  assert.equal((await saveTextTemplate(db, { id, name: 'SNS 연쇄', body: PLAIN, auto_chain: { after: id } }, { staff: [] })).status, 400, '자기 자신은 앞 문구가 될 수 없다');
  assert.equal((await saveTextTemplate(db, { id, name: 'SNS 연쇄', body: PLAIN, auto_chain: { after: 'x' } }, { staff: [] })).status, 400);
  const cleared = await saveTextTemplate(db, { id, name: 'SNS 연쇄', body: PLAIN, auto_chain: null }, { staff: [] });
  assert.equal(cleared.status, 200); assert.equal(db.state.templates.find(r => r.id === id).auto_chain, null);
  assert.equal(parseAutoChain('{깨진'), null);
});

test('BMS 버튼 PC 링크: linkPc 가 있으면 linkMobile 과 함께 실리고, 없으면 종전처럼 싣지 않으며, 화면 편집 저장이 지우지 않는다', async () => {
  const prev = { k: process.env.SOLAPI_API_KEY, s: process.env.SOLAPI_API_SECRET };
  process.env.SOLAPI_API_KEY = 'k'; process.env.SOLAPI_API_SECRET = 's';
  try {
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push(JSON.parse(init.body)); return { ok: true, status: 200, json: async () => ({ groupInfo: { groupId: 'G1', count: { registeredFailed: 0 } }, failedMessageList: [] }) }; };
    const link = 'https://m.cafe.naver.com/01027857623/1657';
    await getSendProvider('solapi').sendBmsEach({ from: '0319862458', pfId: 'PF', messages: [
      { to: '01011112222', text: 'a', buttons: [{ name: '리뷰', link, linkPc: link }] },
      { to: '01033334444', text: 'b', buttons: [{ name: '리뷰', link }] },
    ] }, { fetchImpl });
    const [withPc, withoutPc] = seen[0].messages.map(m => m.kakaoOptions.bms.buttons[0]);
    assert.deepEqual(withPc, { name: '리뷰', linkType: 'WL', linkMobile: link, linkPc: link });
    assert.equal('linkPc' in withoutPc, false);
  } finally {
    if (prev.k === undefined) delete process.env.SOLAPI_API_KEY; else process.env.SOLAPI_API_KEY = prev.k;
    if (prev.s === undefined) delete process.env.SOLAPI_API_SECRET; else process.env.SOLAPI_API_SECRET = prev.s;
  }
  assert.deepEqual(parseBmsConfig({ buttons: [{ name: 'a', link: 'https://x.kr', linkPc: 'https://y.kr' }] }).buttons, [{ name: 'a', link: 'https://x.kr', linkPc: 'https://y.kr' }]);
  assert.equal(bmsButtonsCheck([{ name: 'a', link: 'https://x.kr', linkPc: 'http://bad' }]).reason, 'bms_button');
  assert.deepEqual(bmsButtonsCheck([{ name: 'a', link: 'https://x.kr' }]).buttons, [{ name: 'a', link: 'https://x.kr' }]);
});
