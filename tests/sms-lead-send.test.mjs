// 가입·문의 후 N일(lead_plus_days) 자동 발송(설계 19-2·19-3). 가짜 db·가짜 provider·가짜 fetch 만 쓴다. 값은 모두 가짜.
import assert from 'node:assert/strict';
import test from 'node:test';
import { _resetCafe24SchemaForTest } from '../api/_lib/cafe24.js';
import { _resetLeadSchemaForTest, insertLead } from '../api/_lib/smsLeads.js';
import { _resetTextTemplateSchemaForTest, infoCheck, saveTextTemplate } from '../api/_lib/smsTextTemplates.js';
import { _resetEventSchemaForTest, eventToggleOn, runEventSend } from '../api/_lib/smsEventSend.js';
import { getSendProvider } from '../api/_lib/sendProvider.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db'; // 암호화 키 파생용 가짜 값
const NOW = Date.parse('2026-11-20T01:00:00Z'); // KST 11-20 10:00
const EARLY = Date.parse('2026-11-20T00:00:00Z'); // KST 09:00
const HOUR = 3600000;
const ENV = { SMS_SENDER: '0212345678' };
const AT_ENV = { AIRTABLE_TOKEN: 'tok', AIRTABLE_BASE_ID: 'appX', AIRTABLE_TABLE: 'Leads', AIRTABLE_PHONE_FIELD: '전화' };
const BODY = '#{고객명}님, 한성쇼케이스입니다.';

function fakeDb({ otherSends = 0 } = {}) {
  const state = { leads: [], sends: [], nextId: 1, nextLead: 1, sql: [] };
  for (let i = 0; i < otherSends; i += 1) state.sends.push({ id: state.nextId++, template_id: 99, dedupe_key: `x${i}`, kst_date: '2026-11-20', status: 'sent' });
  return {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      state.sql.push(t);
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT id FROM sms_text_templates WHERE auto_enabled = true AND id <> ?')) return { rows: (state.templates || []).filter(r => r.auto_enabled && r.id !== args[0] && (r.auto_kind === 'member_joined' || (r.auto_kind === 'lead_plus_days' && r.auto_days === 0))).slice(0, 1).map(r => ({ id: r.id })) };
      if (t.startsWith('INSERT INTO sms_leads')) {
        const [source, key_hash, joined_at, phone_hash, phone_last4, phone_enc, name_enc] = args;
        if (state.leads.some(r => r.source === source && r.key_hash === key_hash)) return { rows: [] };
        const row = { id: state.nextLead++, source, key_hash, joined_at, phone_hash, phone_last4, phone_enc, name_enc };
        state.leads.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (t.startsWith('SELECT id, phone_hash, phone_last4, phone_enc, name_enc, joined_at FROM sms_leads')) return { rows: state.leads.filter(r => r.phone_enc && r.joined_at >= args[0] && r.joined_at <= args[1]) };
      if (t.startsWith('SELECT dedupe_key FROM sms_event_sends WHERE template_id = ? AND dedupe_key IN')) return { rows: state.sends.filter(r => r.template_id === args[0] && args.slice(1).includes(r.dedupe_key)).map(r => ({ dedupe_key: r.dedupe_key })) };
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_event_sends WHERE kst_date = ?')) {
        const lead = t.includes('template_id IN (SELECT');
        return { rows: [{ n: state.sends.filter(r => r.kst_date === args[0] && (r.template_id >= 7 && r.template_id < 20) === lead).length }] };
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
      throw new Error(`예상 못 한 SQL ${t}`);
    },
  };
}
function fakeProvider() {
  const calls = { each: [], kakao: [] };
  const ok = input => ({ accepted: input.messages.length, failed: 0, groupId: 'G1', uncertain: false, error: '' });
  return { calls, async uploadImage() { return { fileId: 'F1' }; }, async sendEach(input) { calls.each.push(input); return ok(input); }, async sendKakaoEach(input) { calls.kakao.push(input); return ok(input); } };
}
const fakeKakao = (over = {}) => ({ async getTemplateFresh() { return { raw: { channelId: 'PF1' }, template: { status: 'APPROVED', variables: ['#{고객명}'], content: '#{고객명}님' }, scope: { allowed: true, kind: 'channel' }, ...over }; } });
const reset = () => { _resetEventSchemaForTest(); _resetLeadSchemaForTest(); _resetCafe24SchemaForTest(); _resetTextTemplateSchemaForTest(); };
const lead = (db, key, phone, joinedAtMs, name = '', source = 'cafe24') => insertLead(db, { source, key, phone, name, joinedAtMs });
const tpl = (extra = {}) => ({ id: 7, name: '가입 당일', body: BODY, images: [], auto_kind: 'lead_plus_days', auto_enabled: true, auto_days: 0, auto_ata_template: '', auto_enabled_at: new Date(NOW - 3 * HOUR).toISOString(), auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_offset: 0, auto_unless_step: '', auto_step: '', ...extra });
const go = (db, provider, template, extra = {}) => { reset(); return runEventSend(template, { db, provider, env: ENV, nowMs: NOW, warn() {}, ...extra }); };

test('N=0: 켠 시각 이후 접수만 문자로 나가고 이름이 들어가며, 키 모양은 해시:lead:접수일:d0, 다시 돌려도 0', async () => {
  reset();
  const db = fakeDb(); const provider = fakeProvider();
  await lead(db, 'a', '010-1111-2222', NOW - HOUR, '가나다');
  await lead(db, 'b', '010-3333-4444', NOW - 5 * HOUR); // 켜기 전 접수
  const out = await go(db, provider, tpl());
  assert.equal(out.claimed, 1);
  assert.equal(provider.calls.each.length, 1);
  assert.deepEqual(provider.calls.each[0].messages.map(m => [m.to, m.text]), [['01011112222', '가나다님, 한성쇼케이스입니다.']]);
  assert.match(db.state.sends[0].dedupe_key, /^[0-9a-f]{64}:lead:2026-11-20:d0$/);
  assert.equal((await go(db, provider, tpl())).claimed, 0);
  assert.equal(provider.calls.each.length, 1);
});

test('N=2: 접수일+2 가 오늘인 접수만(이름 없으면 고객), 같은 날 같은 번호 두 출처는 1통', async () => {
  reset();
  const db = fakeDb(); const provider = fakeProvider();
  const joined = Date.parse('2026-11-18T03:00:00Z');
  await lead(db, 'a', '010-1111-2222', joined, '', 'cafe24');
  await lead(db, 'b', '010-1111-2222', joined + 4 * 60000, '', 'airtable'); // 같은 번호·같은 날
  await lead(db, 'c', '010-5555-6666', Date.parse('2026-11-17T03:00:00Z')); // 3일 전 — 오늘이 아님
  const out = await go(db, provider, tpl({ auto_days: 2 }));
  assert.equal(out.claimed, 1);
  assert.deepEqual(provider.calls.each[0].messages.map(m => [m.to, m.text]), [['01011112222', '고객님, 한성쇼케이스입니다.']]);
  assert.ok(db.state.sends[0].dedupe_key.endsWith(':lead:2026-11-18:d2'));
});

test('N>=1 은 KST 09:30 전에는 무동작, N=0 은 기존 창(08시~)에서 나간다', async () => {
  reset();
  const db = fakeDb(); const provider = fakeProvider();
  await lead(db, 'a', '010-1111-2222', Date.parse('2026-11-18T03:00:00Z'));
  await lead(db, 'b', '010-3333-4444', EARLY - 1000);
  const early = await go(db, provider, tpl({ auto_days: 2 }), { nowMs: EARLY });
  assert.equal(early.reason, 'early'); assert.equal(early.claimed, 0); assert.equal(provider.calls.each.length, 0);
  const zero = await go(db, provider, tpl({ auto_enabled_at: new Date(EARLY - HOUR).toISOString() }), { nowMs: EARLY });
  assert.equal(zero.claimed, 1);
});

test('상한은 가입·문의 문구끼리만 센다: 기존 안내 5건이 있어도 lead 상한 2 에 2통이 나가고 3번째는 상한', async () => {
  reset();
  const db = fakeDb({ otherSends: 5 }); const provider = fakeProvider();
  for (const [i, phone] of ['01011110001', '01011110002', '01011110003'].entries()) await lead(db, `k${i}`, phone, NOW - HOUR);
  const out = await go(db, provider, tpl(), { env: { ...ENV, SMS_AUTO_LEAD_MAX_PER_DAY: '2', SMS_AUTO_INFO_MAX_PER_DAY: '5' } });
  assert.equal(out.claimed, 2);
  assert.equal(provider.calls.each[0].messages.length, 2);
});

test('알림톡이 붙으면 sendKakaoEach(문자 대체 끔, 채널·템플릿·고객명), 문자 대체는 환경값 1 일 때만 켠다, 승인 안 됐으면 선점 0', async () => {
  reset();
  const db = fakeDb(); const provider = fakeProvider();
  await lead(db, 'a', '010-1111-2222', NOW - HOUR, '가나다');
  const out = await go(db, provider, tpl({ auto_ata_template: 'KA01TP1' }), { kakao: fakeKakao() });
  assert.equal(out.claimed, 1);
  assert.equal(provider.calls.each.length, 0);
  assert.deepEqual(provider.calls.kakao[0], { from: '0212345678', pfId: 'PF1', disableSms: true, messages: [{ to: '01011112222', templateId: 'KA01TP1', variables: { 고객명: '가나다' } }] });
  const db2 = fakeDb(); const provider2 = fakeProvider();
  await lead(db2, 'a', '010-1111-2222', NOW - HOUR);
  await go(db2, provider2, tpl({ auto_ata_template: 'KA01TP1' }), { kakao: fakeKakao(), env: { ...ENV, SMS_AUTO_ATA_FALLBACK: '1' } });
  assert.equal(provider2.calls.kakao[0].disableSms, false);
  const db3 = fakeDb(); const provider3 = fakeProvider();
  await lead(db3, 'a', '010-1111-2222', NOW - HOUR);
  const notReady = await go(db3, provider3, tpl({ auto_ata_template: 'KA01TP1' }), { kakao: fakeKakao({ template: { status: 'PENDING', variables: [] } }) });
  assert.equal(notReady.reason, 'ata_not_ready'); assert.equal(db3.state.sends.length, 0); assert.equal(provider3.calls.kakao.length, 0);
});

test('켜기 차단: 연결 길이 없으면 lead_source_not_connected, 알림톡 변수가 고객명 밖이면 ata_not_ready, 모두 맞으면 켜진다', async () => {
  reset();
  const db = fakeDb();
  const noSource = await eventToggleOn({}, tpl({ auto_enabled: false }), { db, env: ENV, nowMs: NOW });
  assert.equal(noSource.body.reason, 'lead_source_not_connected');
  const badVars = await eventToggleOn({}, tpl({ auto_enabled: false, auto_ata_template: 'KA01TP1' }), { db, env: { ...ENV, ...AT_ENV }, nowMs: NOW, kakao: fakeKakao({ template: { status: 'APPROVED', variables: ['#{고객명}', '#{링크}'] } }) });
  assert.equal(badVars.body.reason, 'ata_not_ready');
  const updates = [];
  const db2 = { ...db, async execute(q) { if (q.sql.startsWith('UPDATE sms_text_templates SET auto_enabled = true')) { updates.push(q); return { rows: [] }; } return db.execute(q); } };
  const on = await eventToggleOn({}, tpl({ auto_enabled: false, auto_ata_template: 'KA01TP1' }), { db: db2, env: { ...ENV, ...AT_ENV }, nowMs: NOW, kakao: fakeKakao() });
  assert.equal(on.status, 200); assert.equal(on.body.enabled, true);
  assert.ok(updates[0].sql.includes('auto_enabled_at = NOW()'));
});

test('켜기 겹침: 가입 당일 문구(member_joined·lead 0일)는 동시에 둘 이상 못 켜고, 겹침이 없으면 켜진다', async () => {
  const E = { ...ENV, ...AT_ENV };
  const run = async (template, others) => { reset(); const db = fakeDb(); db.state.templates = others; return eventToggleOn({}, template, { db, env: E, nowMs: NOW }); };
  const joined = { id: 20, auto_kind: 'member_joined', auto_days: 0, auto_enabled: true };
  const zero = { id: 21, auto_kind: 'lead_plus_days', auto_days: 0, auto_enabled: true };
  const one = await run(tpl({ auto_enabled: false }), [joined]); // ① lead 0일 켜기 + 켜진 member_joined
  assert.equal(one.status, 400); assert.equal(one.body.reason, 'lead_overlap');
  reset(); const dbM = fakeDb(); dbM.state.templates = [zero]; // ② member_joined 켜기 + 켜진 lead 0일 (카페24 연결 검사는 통과하도록 흉내)
  const dbM2 = { ...dbM, async execute(q) { return q.sql.includes('FROM cafe24_tokens') ? { rows: [{ id: 1 }] } : dbM.execute(q); } };
  const cafe = { CAFE24_CLIENT_ID: 'c', CAFE24_CLIENT_SECRET: 's', CAFE24_MALL_ID: 'm' };
  const two = await eventToggleOn({}, tpl({ id: 8, body: '한성쇼케이스입니다.', auto_kind: 'member_joined', auto_enabled: false }), { db: dbM2, env: { ...E, ...cafe }, nowMs: NOW });
  assert.equal(two.status, 400); assert.equal(two.body.reason, 'lead_overlap');
  const three = await run(tpl({ auto_enabled: false }), [zero]); // ③ lead 0일끼리
  assert.equal(three.status, 400); assert.equal(three.body.reason, 'lead_overlap');
  reset(); const dbF = fakeDb(); dbF.state.templates = [{ id: 22, auto_kind: 'lead_plus_days', auto_days: 2, auto_enabled: true }]; // N>=1 은 막지 않음 → 기존대로 켜짐
  const dbF2 = { ...dbF, async execute(q) { return q.sql.startsWith('UPDATE sms_text_templates SET auto_enabled = true') ? { rows: [] } : dbF.execute(q); } };
  const free = await eventToggleOn({}, tpl({ auto_enabled: false }), { db: dbF2, env: E, nowMs: NOW });
  assert.equal(free.status, 200); assert.equal(free.body.enabled, true);
});

test('저장: lead 는 일수 0 허용·고객명만·알림톡 칸 저장, 광고 낱말은 문자일 때만 거절, 다른 종류는 알림톡 칸이 빈 값', () => {
  assert.equal(infoCheck(BODY, 'customer', 'lead_plus_days'), '');
  assert.equal(infoCheck('#{주문번호}', 'customer', 'lead_plus_days'), 'info_unknown_var');
  assert.equal(infoCheck('#{고객명}님 할인 안내', 'customer', 'lead_plus_days'), 'info_has_ad_words');
  assert.equal(infoCheck('#{고객명}님 할인 안내', 'customer', 'lead_plus_days', true), '');
  const saved = [];
  const db = { async execute({ sql, args }) {
    const t = sql.replace(/\s+/g, ' ').trim();
    if (/^(CREATE|ALTER)/.test(t)) return { rows: [] };
    if (t.startsWith('SELECT id FROM sms_text_templates WHERE name')) return { rows: [] };
    if (t.startsWith('SELECT COUNT(*)')) return { rows: [{ n: 0 }] };
    if (t.startsWith('INSERT INTO sms_text_templates')) { const cols = /\(([^)]*)\) VALUES/.exec(t)[1].split(',').map(c => c.trim()); const row = {}; cols.forEach((c, i) => { row[c] = args[i]; }); saved.push(row); return { rows: [{ id: saved.length }] }; }
    throw new Error(`예상 못 한 SQL ${t}`);
  } };
  return (async () => {
    reset();
    const a = await saveTextTemplate(db, { name: 'a', body: BODY, auto: { kind: 'lead_plus_days', days: 0, ata_template: 'KA01TP1' } }, { staff: [] });
    assert.equal(a.status, 201);
    assert.deepEqual([saved[0].auto_days, saved[0].auto_ata_template, saved[0].auto_audience], [0, 'KA01TP1', 'customer']);
    assert.equal(a.body.item.auto_ata_template, 'KA01TP1');
    assert.equal((await saveTextTemplate(db, { name: 'b', body: BODY, auto: { kind: 'lead_plus_days', days: 366 } }, { staff: [] })).status, 400);
    assert.equal((await saveTextTemplate(db, { name: 'c', body: '할인 안내', auto: { kind: 'lead_plus_days', days: 3 } }, { staff: [] })).status, 400);
    const other = await saveTextTemplate(db, { name: 'd', body: '#{주문번호} 안내', auto: { kind: 'order_created', ata_template: 'KA01TP1' } }, { staff: [] });
    assert.equal(other.status, 201); assert.equal(saved[1] ? saved[1].auto_ata_template : saved.at(-1).auto_ata_template, '');
  })();
});

test('sendKakaoEach: send-many 1번, 받는 사람마다 변수, 문자 대체 기본 끔', async () => {
  const prev = { k: process.env.SOLAPI_API_KEY, s: process.env.SOLAPI_API_SECRET };
  process.env.SOLAPI_API_KEY = 'k'; process.env.SOLAPI_API_SECRET = 's';
  try {
    const seen = [];
    const fetchImpl = async (url, init) => { seen.push({ url: String(url), body: JSON.parse(init.body) }); return { ok: true, status: 200, json: async () => ({ groupInfo: { groupId: 'G1', count: { registeredFailed: 0 } } }) }; };
    const out = await getSendProvider('solapi').sendKakaoEach({ from: '0212345678', pfId: 'PF1', messages: [{ to: '01011112222', templateId: 'T1', variables: { 고객명: 'A' } }, { to: '01033334444', templateId: 'T1', variables: { 고객명: 'B' } }] }, { fetchImpl });
    assert.equal(seen.length, 1);
    assert.deepEqual(seen[0].body.messages.map(m => [m.type, m.kakaoOptions.pfId, m.kakaoOptions.templateId, m.kakaoOptions.variables['#{고객명}'], m.kakaoOptions.disableSms]), [['ATA', 'PF1', 'T1', 'A', true], ['ATA', 'PF1', 'T1', 'B', true]]);
    assert.deepEqual(out, { accepted: 2, failed: 0, groupId: 'G1', uncertain: false, error: '' });
  } finally {
    if (prev.k === undefined) delete process.env.SOLAPI_API_KEY; else process.env.SOLAPI_API_KEY = prev.k;
    if (prev.s === undefined) delete process.env.SOLAPI_API_SECRET; else process.env.SOLAPI_API_SECRET = prev.s;
  }
});
