// 카페24 회원가입 고객에게 광고 문자(「소개 혜택 안내」) 허용(설계 v16, 2026-11-26 사장님: "회원가입이면 다 수신동의야").
// 가짜 db·가짜 provider·가짜 fetch 만 쓴다. 실제 발송·운영 DB·환경변수는 쓰지 않는다. 값은 모두 가짜.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleCafe24Webhook } from '../api/cafe24/webhook.js';
import { _resetCafe24SchemaForTest } from '../api/_lib/cafe24.js';
import { _resetLeadSchemaForTest, insertLead } from '../api/_lib/smsLeads.js';
import * as T from '../api/_lib/smsTextTemplates.js';
import { _resetEventSchemaForTest, eventPhoneHash, eventToggleOn, loadEventTemplate, runEventSend } from '../api/_lib/smsEventSend.js';
import { _resetAutoSchemaForTest, phoneHash } from '../api/_lib/smsAutoSend.js';
import * as M from '../src/components/smsconsole/smsTextTemplateFormModel.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db'; // 암호화 키 파생용 가짜 값
const NOW = Date.parse('2026-11-20T01:00:00Z'); // KST 11-20 10:00
const HOUR = 3600000;
const TODAY = '2026-11-20';
const ENV = { SMS_SENDER: '0212345678' };
const AT_ENV = { AIRTABLE_TOKEN: 'tok', AIRTABLE_BASE_ID: 'appX', AIRTABLE_TABLE: 'Leads', AIRTABLE_PHONE_FIELD: '전화' };
const WEB_ENV = { CAFE24_CLIENT_ID: 'cid', CAFE24_CLIENT_SECRET: 'csecret', CAFE24_MALL_ID: 'mymall', CAFE24_WEBHOOK_KEY: 'hookkey' };
const BODY = '#{고객명}님, 한성쇼케이스입니다.';
const OPTOUT = '무료수신거부 080-500-4233';
const AD_BODY = `(광고) #{고객명}님, 한성쇼케이스 소개 혜택 안내드립니다.\n소개해 주시면 할인 쿠폰을 드립니다.\n${OPTOUT}`;
const MEMBER_BODY = '한성쇼케이스 가입을 환영합니다. 문의는 언제든 남겨 주세요.';

function fakeDb({ optouts = [], autoSends = [], bms = [], templates = [] } = {}) {
  const state = { templateRows: [], leads: [], signups: [], sends: [], templates, optouts, autoSends, bms, nextId: 1, nextLead: 1, sql: [] };
  return {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      state.sql.push(t);
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT conname FROM pg_constraint')) return { rows: [] };
      if (t.startsWith('SELECT phone_hash FROM sms_optouts')) return { rows: state.optouts.map(phone_hash => ({ phone_hash })) };
      if (t.startsWith("SELECT DISTINCT phone_hash FROM sms_auto_sends WHERE kst_date = ? AND status <> 'failed' AND phone_hash IN")) return { rows: state.autoSends.filter(r => r.kst_date === args[0] && args.slice(1).includes(r.phone_hash)).map(r => ({ phone_hash: r.phone_hash })) };
      if (t.startsWith("SELECT DISTINCT e.phone_hash FROM sms_event_sends e JOIN sms_text_templates t")) return { rows: state.bms.filter(r => r.kst_date === args[0] && args.slice(2).includes(r.phone_hash)).map(r => ({ phone_hash: r.phone_hash })) };
      if (t.startsWith('SELECT id, name, body, image, images, auto_kind')) return { rows: state.templateRows.filter(r => r.id === args[0]) };
      if (t.startsWith('SELECT id FROM sms_text_templates WHERE auto_enabled = true AND id <> ?')) return { rows: [] };
      if (t.startsWith("SELECT id FROM sms_text_templates WHERE auto_enabled = true AND auto_kind = 'member_joined'")) return { rows: state.templates.filter(r => r.auto_enabled && r.auto_kind === 'member_joined').map(r => ({ id: r.id })) };
      if (t.startsWith('INSERT INTO sms_leads')) {
        const [source, key_hash, joined_at, phone_hash, phone_last4, phone_enc, name_enc] = args;
        if (state.leads.some(r => r.source === source && r.key_hash === key_hash)) return { rows: [] };
        const row = { id: state.nextLead++, source, key_hash, joined_at, phone_hash, phone_last4, phone_enc, name_enc };
        state.leads.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (t.startsWith('SELECT id, phone_hash, phone_last4, phone_enc, name_enc, joined_at FROM sms_leads')) return { rows: state.leads.filter(r => r.phone_enc && r.joined_at >= args[0] && r.joined_at <= args[1] && (!t.includes('AND source = ?') || r.source === args[2])) };
      if (t.startsWith('INSERT INTO cafe24_signups')) {
        const [member_hash, joined_at, phone_hash, phone_last4, phone_enc, source] = args;
        if (state.signups.some(r => r.member_hash === member_hash)) return { rows: [] };
        const row = { id: state.nextId++, member_hash, joined_at, phone_hash, phone_last4, phone_enc, source };
        state.signups.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (t.startsWith('SELECT id, phone_hash, phone_last4, phone_enc FROM cafe24_signups')) return { rows: state.signups.filter(r => r.phone_enc && r.joined_at >= args[0] && r.joined_at <= args[1]) };
      if (t.startsWith('UPDATE cafe24_signups SET phone_enc = NULL WHERE id IN')) { for (const r of state.signups) if (args.includes(r.id)) r.phone_enc = null; return { rows: [] }; }
      if (t.startsWith('UPDATE cafe24_signups SET phone_enc = NULL WHERE phone_enc IS NOT NULL')) { for (const r of state.signups) if (r.phone_enc && r.joined_at < args[0]) r.phone_enc = null; return { rows: [] }; }
      if (t.startsWith('SELECT dedupe_key FROM sms_event_sends')) return { rows: state.sends.filter(r => r.template_id === args[0] && args.slice(1).includes(r.dedupe_key)).map(r => ({ dedupe_key: r.dedupe_key })) };
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
function fakeProvider() {
  const calls = { each: [] };
  const ok = input => ({ accepted: input.messages.length, failed: 0, groupId: 'G1', uncertain: false, error: '' });
  return { calls, async uploadImage(file) { return { fileId: `F-${String(file.base64).slice(0, 3)}` }; }, async sendEach(input) { calls.each.push(input); return ok(input); } };
}
// 저장 시험용 가짜 db: 템플릿 INSERT 만 기록한다.
function saveDb() {
  const saved = [];
  return { saved, async execute({ sql, args }) {
    const t = sql.replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER)/.test(t)) return { rows: [] };
    if (t.startsWith('SELECT id FROM sms_text_templates WHERE name')) return { rows: [] };
    if (t.startsWith('SELECT COUNT(*)')) return { rows: [{ n: 0 }] };
    if (t.startsWith('UPDATE sms_text_templates SET auto_enabled = CASE')) return { rows: [{ id: 1 }] }; // 연쇄 설정 저장
    if (t.startsWith('INSERT INTO sms_text_templates')) { const cols = /\(([^)]*)\) VALUES/.exec(t)[1].split(',').map(c => c.trim()); const row = {}; cols.forEach((c, i) => { row[c] = args[i]; }); saved.push(row); return { rows: [{ id: saved.length }] }; }
    throw new Error(`예상 못 한 SQL ${t}`);
  } };
}
const reset = () => { _resetEventSchemaForTest(); _resetLeadSchemaForTest(); _resetCafe24SchemaForTest(); T._resetTextTemplateSchemaForTest(); _resetAutoSchemaForTest(); };
const lead = (db, key, phone, joinedAtMs, name = '', source = 'cafe24') => insertLead(db, { source, key, phone, name, joinedAtMs });
const tpl = (extra = {}) => ({ id: 7, name: '가입 당일', body: BODY, images: [], auto_kind: 'lead_plus_days', auto_enabled: true, auto_days: 0, auto_ata_template: '', auto_enabled_at: new Date(NOW - 3 * HOUR).toISOString(), auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_offset: 0, auto_unless_step: '', auto_step: '', ...extra });
const adTpl = (extra = {}) => tpl({ id: 31, name: '소개 혜택 안내(카페24 가입+7일)', body: AD_BODY, auto_msg_type: 'ad', auto_lead_source: 'cafe24', ...extra });
const go = (db, provider, template, extra = {}) => { reset(); return runEventSend(template, { db, provider, env: ENV, nowMs: NOW, staff: [], warn() {}, sleep: async () => {}, ...extra }); };
const saveLead = (db, over = {}) => T.saveTextTemplate(db, { name: `n${Math.random()}`, body: AD_BODY, auto: { kind: 'lead_plus_days', days: 7, lead_source: 'cafe24' }, ...over }, { staff: [] });

// ---- 수정 전 info 문자 기준값(이 시험을 수정 전 코드에서 돌려 뽑은 값, 설계 8번) ----
const SNAP_BEFORE = {
 "lead:cafe24:0": {
  "claimed": 1,
  "reason": "",
  "messages": [
   [
    [
     "01011112222",
     "가나다님, 한성쇼케이스입니다.",
     null
    ]
   ]
  ]
 },
 "lead:cafe24:2": {
  "claimed": 1,
  "reason": "",
  "messages": [
   [
    [
     "01011112222",
     "가나다님, 한성쇼케이스입니다.",
     "F-aaa"
    ]
   ],
   [
    [
     "01011112222",
     "한성쇼케이스 가입 당일 2/2",
     "F-bbb"
    ]
   ]
  ]
 },
 "lead:airtable:0": {
  "claimed": 1,
  "reason": "",
  "messages": [
   [
    [
     "01033334444",
     "라마바님, 한성쇼케이스입니다.",
     null
    ]
   ]
  ]
 },
 "lead:airtable:2": {
  "claimed": 1,
  "reason": "",
  "messages": [
   [
    [
     "01033334444",
     "라마바님, 한성쇼케이스입니다.",
     "F-aaa"
    ]
   ],
   [
    [
     "01033334444",
     "한성쇼케이스 가입 당일 2/2",
     "F-bbb"
    ]
   ]
  ]
 },
 "lead:all:0": {
  "claimed": 2,
  "reason": "",
  "messages": [
   [
    [
     "01011112222",
     "가나다님, 한성쇼케이스입니다.",
     null
    ],
    [
     "01033334444",
     "라마바님, 한성쇼케이스입니다.",
     null
    ]
   ]
  ]
 },
 "lead:all:2": {
  "claimed": 2,
  "reason": "",
  "messages": [
   [
    [
     "01011112222",
     "가나다님, 한성쇼케이스입니다.",
     "F-aaa"
    ],
    [
     "01033334444",
     "라마바님, 한성쇼케이스입니다.",
     "F-aaa"
    ]
   ],
   [
    [
     "01011112222",
     "한성쇼케이스 가입 당일 2/2",
     "F-bbb"
    ],
    [
     "01033334444",
     "한성쇼케이스 가입 당일 2/2",
     "F-bbb"
    ]
   ]
  ]
 },
 "member_joined": {
  "claimed": 1,
  "reason": "",
  "messages": [
   [
    [
     "01055556666",
     "한성쇼케이스 가입을 환영합니다. 문의는 언제든 남겨 주세요.",
     null
    ]
   ]
  ]
 }
};
async function buildSnapshot() {
  const out = {};
  for (const src of ['cafe24', 'airtable', '']) {
    for (const images of [[], ['aaa', 'bbb']]) {
      reset();
      const db = fakeDb(); const provider = fakeProvider();
      await lead(db, 'a', '010-1111-2222', NOW - HOUR, '가나다', 'cafe24');
      await lead(db, 'b', '010-3333-4444', NOW - HOUR, '라마바', 'airtable');
      const r = await go(db, provider, tpl({ auto_lead_source: src, images }));
      out[`lead:${src || 'all'}:${images.length}`] = { claimed: r.claimed, reason: r.reason, messages: provider.calls.each.map(c => c.messages.map(m => [m.to, m.text, m.fileId || null])) };
    }
  }
  reset();
  const mdb = fakeDb({ templates: [{ id: 9, auto_enabled: true, auto_kind: 'member_joined' }] });
  const res = { code: 0, status(c) { this.code = c; return this; }, json() { return this; }, send() { return this; }, setHeader() {}, end() { return this; } };
  await handleCafe24Webhook({ method: 'POST', headers: { 'x-api-key': 'hookkey' }, body: { event_no: 90032, resource: { mall_id: 'mymall', member_id: 'user01', cellphone: '010-5555-6666', created_date: '2026-11-20T09:30:00+09:00' } } }, res, { db: mdb, env: WEB_ENV, nowMs: NOW, warn() {} });
  const mp = fakeProvider();
  const mr = await go(mdb, mp, { id: 9, name: '가입 안내', body: MEMBER_BODY, images: [], auto_kind: 'member_joined', auto_enabled: true, auto_step: '', auto_enabled_at: '2026-11-20T00:00:00.000Z', auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_offset: 0, auto_unless_step: '' });
  out.member_joined = { claimed: mr.claimed, reason: mr.reason, messages: mp.calls.each.map(c => c.messages.map(m => [m.to, m.text, m.fileId || null])) };
  return out;
}

test('1. cafe24 + 광고 형식 본문 + plain 아님 → 저장 201, msg_type ad', async () => {
  reset();
  const db = saveDb();
  const ok = await saveLead(db);
  assert.equal(ok.status, 201);
  assert.equal(db.saved[0].auto_msg_type, 'ad');
  assert.equal(ok.body.item.auto_msg_type, 'ad');
  assert.equal(db.saved[0].auto_lead_source, 'cafe24');
  assert.equal(db.saved[0].auto_days, 7);
  // 광고 형식이어도 #{고객명} 밖의 변수는 종전대로 거절
  const bad = await saveLead(db, { body: AD_BODY.replace('#{고객명}', '#{주문번호}') });
  assert.equal(bad.status, 400); assert.equal(bad.body.reason, 'info_unknown_var');
});

test('2. 대상이 airtable 이거나 없음(모두) → 400 info_has_ad_words, 알림톡은 그대로 광고 낱말 검사 없음', async () => {
  reset();
  const db = saveDb();
  for (const lead_source of ['airtable', '', undefined]) {
    const out = await saveLead(db, { auto: { kind: 'lead_plus_days', days: 7, ...(lead_source === undefined ? {} : { lead_source }) } });
    assert.equal(out.status, 400, String(lead_source)); assert.equal(out.body.reason, 'info_has_ad_words');
  }
  assert.equal(db.saved.length, 0);
  const ata = await saveLead(db, { auto: { kind: 'lead_plus_days', days: 7, lead_source: 'airtable', ata_template: 'KA01TP1' } });
  assert.equal(ata.status, 201); assert.equal(db.saved[0].auto_msg_type, 'info');
});

test('3. (광고)·080 표기가 빠진 광고 낱말 본문은 cafe24 여도 400', async () => {
  reset();
  const db = saveDb();
  const noPrefix = await saveLead(db, { body: AD_BODY.replace('(광고) ', '') });
  assert.equal(noPrefix.status, 400); assert.equal(noPrefix.body.reason, 'info_has_ad_words');
  const noOptout = await saveLead(db, { body: AD_BODY.replace(OPTOUT, '') });
  assert.equal(noOptout.status, 400); assert.equal(noOptout.body.reason, 'info_has_ad_words');
  const bare = await saveLead(db, { body: '#{고객명}님 소개 혜택 안내' });
  assert.equal(bare.status, 400);
  assert.equal(db.saved.length, 0);
  // 광고 낱말이 없는 info 문구는 cafe24 여도 종전처럼 info 로 저장
  const info = await saveLead(db, { body: BODY });
  assert.equal(info.status, 201); assert.equal(db.saved[0].auto_msg_type, 'info');
});

test('4. plain=true 이면 광고로 보지 않아 400', async () => {
  reset();
  const db = saveDb();
  const plain = await saveLead(db, { auto_chain: { plain: true } });
  assert.equal(plain.status, 400); assert.equal(plain.body.reason, 'info_has_ad_words');
  const plainStr = await saveLead(db, { auto_chain: JSON.stringify({ plain: true }) });
  assert.equal(plainStr.status, 400);
  assert.equal(db.saved.length, 0);
  const notPlain = await saveLead(db, { auto_chain: { subject: '소개' } });
  assert.equal(notPlain.status, 201); assert.equal(db.saved[0].auto_msg_type, 'ad');
});

test('5. 광고 lead 템플릿 켜기와 실행이 info_check 에 막히지 않는다(카페24 가 아니거나 형식이 틀리면 막힌다)', async () => {
  reset();
  assert.equal(T.isLeadAd(adTpl()), true);
  assert.equal(T.isLeadAd(adTpl({ auto_ata_template: 'KA01TP1' })), false);
  assert.equal(T.isLeadAd(adTpl({ auto_msg_type: 'info' })), false);
  assert.equal(T.isLeadAd(adTpl({ auto_kind: 'order_plus_days' })), false);
  // 켜기
  const db = fakeDb();
  const updates = [];
  const db2 = { ...db, async execute(q) { if (q.sql.startsWith('UPDATE sms_text_templates SET auto_enabled = true')) { updates.push(q); return { rows: [] }; } return db.execute(q); } };
  const on = await eventToggleOn({}, adTpl({ auto_enabled: false }), { db: db2, env: { ...ENV, ...AT_ENV }, nowMs: NOW });
  assert.equal(on.status, 200); assert.equal(on.body.enabled, true); assert.equal(updates.length, 1);
  const noPrefix = await eventToggleOn({}, adTpl({ auto_enabled: false, body: AD_BODY.replace('(광고) ', '') }), { db: db2, env: { ...ENV, ...AT_ENV }, nowMs: NOW });
  assert.equal(noPrefix.status, 400); assert.equal(noPrefix.body.reason, 'no_ad_prefix');
  const noOptout = await eventToggleOn({}, adTpl({ auto_enabled: false, body: AD_BODY.replace(OPTOUT, '') }), { db: db2, env: { ...ENV, ...AT_ENV }, nowMs: NOW });
  assert.equal(noOptout.status, 400); assert.equal(noOptout.body.reason, 'no_optout_080');
  // 광고 표기가 없는 info 템플릿은 종전대로 광고 낱말에 막힌다
  const info = await eventToggleOn({}, tpl({ auto_enabled: false, body: '#{고객명}님 소개 혜택 안내' }), { db: db2, env: { ...ENV, ...AT_ENV }, nowMs: NOW });
  assert.equal(info.status, 400); assert.equal(info.body.reason, 'info_has_ad_words');
  // 실행
  const db3 = fakeDb(); const provider = fakeProvider();
  await lead(db3, 'a', '010-1111-2222', NOW - HOUR, '가나다');
  const out = await go(db3, provider, adTpl({ auto_days: 0 }));
  assert.equal(out.claimed, 1); assert.notEqual(out.reason, 'info_check');
  assert.deepEqual(provider.calls.each[0].messages.map(m => [m.to, m.text]), [['01011112222', AD_BODY.replace('#{고객명}', '가나다')]]);
  // 실행 단계 방어: 카페24 대상이 아니거나 (광고)·080 이 빠졌으면 보내지 않고 멈춘다
  for (const over of [{ auto_lead_source: '' }, { auto_lead_source: 'airtable' }, { body: AD_BODY.replace('(광고) ', '') }, { body: AD_BODY.replace(OPTOUT, '') }]) {
    const d = fakeDb(); const p = fakeProvider();
    await lead(d, 'a', '010-1111-2222', NOW - HOUR, '가나다');
    const r = await go(d, p, adTpl(over));
    assert.equal(r.reason, 'info_check'); assert.equal(r.claimed, 0); assert.equal(p.calls.each.length, 0); assert.equal(d.state.sends.length, 0);
  }
});

test('6. 수신거부·오늘 광고 문자·오늘 브랜드메시지가 나간 번호는 광고 lead 대상에서 빠진다', async () => {
  reset();
  const A = '010-1111-0001'; const B = '010-1111-0002'; const C = '010-1111-0003'; const D = '010-1111-0004'; const E = '010-1111-0005';
  const num = p => p.replace(/\D/g, '');
  const db = fakeDb({
    optouts: [phoneHash(num(A))],
    autoSends: [{ phone_hash: phoneHash(num(B)), kst_date: TODAY }, { phone_hash: phoneHash(num(E)), kst_date: '2026-11-19' }], // E 는 어제 → 막지 않는다
    bms: [{ phone_hash: eventPhoneHash(num(C)), kst_date: TODAY }], // 브랜드메시지 행은 이벤트 소금(eventPhoneHash)으로 저장된다
  });
  const provider = fakeProvider();
  for (const [i, phone] of [A, B, C, D, E].entries()) await lead(db, `k${i}`, phone, NOW - HOUR);
  const out = await go(db, provider, adTpl());
  assert.deepEqual(provider.calls.each[0].messages.map(m => m.to).sort(), [num(D), num(E)]);
  assert.equal(out.claimed, 2);
  // 같은 조건의 info lead 는 수신거부·하루 1통을 적용하지 않는다(종전 동작)
  const db2 = fakeDb({ optouts: [phoneHash(num(A))], autoSends: [{ phone_hash: phoneHash(num(B)), kst_date: TODAY }] });
  const p2 = fakeProvider();
  for (const [i, phone] of [A, B].entries()) await lead(db2, `k${i}`, phone, NOW - HOUR);
  await go(db2, p2, tpl({ auto_lead_source: 'cafe24' }));
  assert.deepEqual(p2.calls.each[0].messages.map(m => m.to).sort(), [num(A), num(B)]);
  assert.equal(db2.state.sql.some(q => q.includes('sms_optouts') || q.includes('sms_auto_sends WHERE kst_date')), false);
});

test('7. 사진이 여러 장이면 모든 통에 (광고)·080 표기가 붙는다', async () => {
  reset();
  const db = fakeDb(); const provider = fakeProvider();
  await lead(db, 'a', '010-1111-2222', NOW - HOUR, '가나다');
  const out = await go(db, provider, adTpl({ images: ['aaa', 'bbb'] }));
  assert.equal(out.claimed, 1);
  const texts = provider.calls.each.map(c => c.messages[0].text);
  assert.equal(texts.length, 3); // 사진 통 2 + 본문 통 1
  for (const text of texts) { assert.ok(text.startsWith('(광고)'), text); assert.ok(text.includes('080-500-4233'), text); }
  assert.equal(texts[2], AD_BODY.replace('#{고객명}', '가나다'));
  // 사진 1장이면 1통(본문에 표기가 이미 있다), 없으면 본문만
  const d1 = fakeDb(); const p1 = fakeProvider();
  await lead(d1, 'a', '010-1111-2222', NOW - HOUR, '가나다');
  await go(d1, p1, adTpl({ images: ['aaa'] }));
  assert.equal(p1.calls.each.length, 1); assert.ok(p1.calls.each[0].messages[0].text.startsWith('(광고)')); assert.equal(p1.calls.each[0].messages[0].fileId, 'F-aaa');
});

test('8. info 템플릿은 그대로다: lead 세 대상과 member_joined 의 가짜 발송 messages 가 수정 전 값과 같다', async () => {
  const now = await buildSnapshot();
  assert.ok(SNAP_BEFORE, '기준값이 비어 있다');
  assert.deepEqual(now, SNAP_BEFORE);
  assert.equal(now['lead:cafe24:0'].claimed, 1); assert.equal(now['lead:all:0'].claimed, 2); assert.equal(now.member_joined.claimed, 1);
});

test('9. isAdKind(lead_plus_days, "", cafe24) 는 참, 대상이 비었거나 airtable 이면 거짓, 기존 종류는 그대로', () => {
  assert.equal(M.isAdKind('lead_plus_days', '', 'cafe24'), true);
  assert.equal(M.isAdKind('lead_plus_days', '', ''), false);
  assert.equal(M.isAdKind('lead_plus_days', '', 'airtable'), false);
  assert.equal(M.isAdKind('lead_plus_days', '', undefined), false);
  assert.equal(M.isAdKind('lead_plus_days', 'KA01TP1', 'cafe24'), false);
  assert.equal(M.isAdKind('ship_plus_days', ''), true);
  assert.equal(M.isAdKind('ship_plus_days', 'KA01TP1'), false);
  assert.equal(M.isAdKind('member_joined', '', 'cafe24'), false);
});

test('10. DB 행이 msg_type ad 인 lead 문구는 loadEventTemplate 로 ad 로 읽혀 그대로 실행된다(info·다른 종류는 info)', async () => {
  const row = { id: 31, name: '소개 혜택 안내', body: AD_BODY, image: null, images: null, auto_kind: 'lead_plus_days', auto_enabled: true, auto_days: 0, auto_audience: 'customer', auto_msg_type: 'ad', auto_ata_template: '', auto_lead_source: 'cafe24', auto_enabled_at: new Date(NOW - 3 * HOUR).toISOString() };
  const db = fakeDb();
  db.state.templateRows = [row, { ...row, id: 32, auto_msg_type: 'info' }, { ...row, id: 33, auto_kind: 'due_date' }, { ...row, id: 34, auto_msg_type: null }];
  reset();
  const loaded = await loadEventTemplate(db, 31);
  assert.equal(loaded.auto_msg_type, 'ad'); assert.equal(T.isLeadAd(loaded), true);
  assert.equal((await loadEventTemplate(db, 32)).auto_msg_type, 'info');
  assert.equal((await loadEventTemplate(db, 33)).auto_msg_type, 'info');
  assert.equal((await loadEventTemplate(db, 34)).auto_msg_type, 'info');
  const provider = fakeProvider();
  await lead(db, 'a', '010-1111-2222', NOW - HOUR, '가나다');
  const out = await go(db, provider, loaded);
  assert.equal(out.claimed, 1);
  assert.equal(provider.calls.each[0].messages[0].text, AD_BODY.replace('#{고객명}', '가나다'));
});
