// 가입·문의 접수 표와 에어테이블 조회(설계 19-1·19-5). 값은 모두 가짜.
import assert from 'node:assert/strict';
import test from 'node:test';
import { insertSignup, phoneHash, _resetCafe24SchemaForTest } from '../api/_lib/cafe24.js';
import { airtableEnv, normalizeAirtablePhone, pollAirtableLeads, _resetAirtablePollForTest } from '../api/_lib/airtableLeads.js';
import { _resetLeadSchemaForTest, ensureLeadSchema, insertLead, leadCandidates, leadSourcesConnected, purgeOldLeads } from '../api/_lib/smsLeads.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db'; // 암호화 키 파생용 가짜 값
const NOW = Date.parse('2026-11-20T01:00:00Z');
const DAY = 24 * 3600000;
const AT_ENV = { AIRTABLE_TOKEN: 'tok', AIRTABLE_BASE_ID: 'appX', AIRTABLE_TABLE: 'Leads', AIRTABLE_PHONE_FIELD: '전화', AIRTABLE_NAME_FIELD: '이름' };

function fakeDb() {
  const state = { leads: [], signups: [], poll: null, nextId: 1 };
  return {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      if (/^CREATE TABLE/.test(t)) return { rows: [] };
      if (t.startsWith('INSERT INTO sms_leads')) {
        const [source, key_hash, joined_at, phone_hash, phone_last4, phone_enc, name_enc] = args;
        if (state.leads.some(r => r.source === source && r.key_hash === key_hash)) return { rows: [] };
        const row = { id: state.nextId++, source, key_hash, joined_at, phone_hash, phone_last4, phone_enc, name_enc };
        state.leads.push(row);
        return { rows: [{ id: row.id }] };
      }
      if (t.startsWith('SELECT id, phone_hash, phone_last4, phone_enc, name_enc, joined_at FROM sms_leads')) return { rows: state.leads.filter(r => r.phone_enc && r.joined_at >= args[0] && r.joined_at <= args[1]) };
      if (t.startsWith('UPDATE sms_leads SET phone_enc = NULL, name_enc = NULL')) { for (const r of state.leads) if (r.joined_at < args[0]) { r.phone_enc = null; r.name_enc = null; } return { rows: [] }; }
      if (t.startsWith('INSERT INTO sms_lead_poll')) {
        if (state.poll && state.poll >= args[1]) return { rows: [] };
        state.poll = args[0];
        return { rows: [{ source: 'airtable' }] };
      }
      if (t.startsWith('INSERT INTO cafe24_signups')) return { rows: [{ id: 1 }] };
      throw new Error(`예상 못 한 SQL ${t}`);
    },
  };
}
const fresh = () => { _resetLeadSchemaForTest(); _resetAirtablePollForTest(); _resetCafe24SchemaForTest(); return fakeDb(); };
const fakeFetch = pages => { const calls = []; const f = async url => { calls.push(url); const body = pages[calls.length - 1] || { records: [] }; return { ok: true, json: async () => body }; }; f.calls = calls; return f; };
const rec = (id, phone, name) => ({ id, createdTime: '2026-11-19T10:00:00.000Z', fields: { 전화: phone, 이름: name } });

test('접수 표: 같은 출처·키는 중복 거절, 휴대폰 형식이 아니면 거절', async () => {
  const db = fresh();
  await ensureLeadSchema(db);
  const lead = { source: 'cafe24', key: 'user01', phone: '010-5555-6666', name: '홍길동', joinedAtMs: NOW };
  assert.equal(await insertLead(db, lead), true);
  assert.equal(await insertLead(db, lead), false);
  assert.equal(await insertLead(db, { ...lead, key: 'user02', phone: '02-123-4567' }), false);
  assert.equal(db.state.leads.length, 1);
  const [one] = await leadCandidates(db, { fromIso: new Date(NOW - DAY).toISOString(), toIso: new Date(NOW + DAY).toISOString() });
  assert.equal(one.phone, '01055556666');
  assert.equal(one.name, '홍길동');
  assert.equal(one.last4, '6666');
  assert.equal(one.joinedAtMs, NOW);
});

test('접수 표: 같은 번호는 cafe24_signups 와 같은 해시, 이름은 60자로 자름', async () => {
  const db = fresh();
  await insertLead(db, { source: 'airtable', key: 'rec1', phone: '01055556666', name: '가'.repeat(100), joinedAtMs: NOW });
  assert.equal(db.state.leads[0].phone_hash, phoneHash('01055556666'));
  const [one] = await leadCandidates(db, { fromIso: new Date(NOW - DAY).toISOString(), toIso: new Date(NOW + DAY).toISOString() });
  assert.equal(one.name.length, 60);
});

test('접수 표: 45일 넘은 행은 번호·이름을 지우고 해시는 남김', async () => {
  const db = fresh();
  await insertLead(db, { source: 'cafe24', key: 'old', phone: '01011112222', name: '옛', joinedAtMs: NOW - 46 * DAY });
  await insertLead(db, { source: 'cafe24', key: 'new', phone: '01033334444', name: '새', joinedAtMs: NOW - 10 * DAY });
  await purgeOldLeads(db, NOW);
  assert.equal(db.state.leads[0].phone_enc, null);
  assert.equal(db.state.leads[0].name_enc, null);
  assert.ok(db.state.leads[0].phone_hash);
  assert.ok(db.state.leads[1].phone_enc);
});

test('카페24 가입이 새로 들어가면 접수 표에도 1건, 같은 회원은 다시 넣지 않음', async () => {
  const db = fresh();
  assert.equal(await insertSignup(db, { memberId: 'user01', phone: '01055556666', name: '김', joinedAtMs: NOW, source: 'webhook', keepPhone: false }), true);
  assert.equal(db.state.leads.length, 1);
  assert.equal(db.state.leads[0].source, 'cafe24');
});

test('에어테이블: 환경값이 없으면 닫혀 0, 연결 판정도 거짓', async () => {
  const db = fresh();
  const f = fakeFetch([]);
  assert.equal(airtableEnv({ ...AT_ENV, AIRTABLE_TOKEN: '' }), null);
  assert.equal(await pollAirtableLeads(db, { env: {}, fetchImpl: f, nowMs: NOW }), 0);
  assert.equal(f.calls.length, 0);
  assert.equal(await leadSourcesConnected(db, {}), false);
  assert.equal(await leadSourcesConnected(db, AT_ENV), true);
});

test('에어테이블: 10분 안 재조회는 건너뛰고 번호 형식은 82 → 0 으로 바꿈', async () => {
  const db = fresh();
  const f = fakeFetch([{ records: [rec('r1', '+82 10-1234-5678', '이'), rec('r2', '아님', '삼')] }]);
  assert.equal(await pollAirtableLeads(db, { env: AT_ENV, fetchImpl: f, nowMs: NOW }), 1);
  assert.equal(normalizeAirtablePhone('821012345678'), '01012345678');
  assert.equal(await pollAirtableLeads(db, { env: AT_ENV, fetchImpl: f, nowMs: NOW + 5 * 60000 }), 0);
  assert.equal(f.calls.length, 1);
  assert.match(decodeURIComponent(f.calls[0]), /IS_AFTER\(CREATED_TIME\(\), '2026-11-18T01:00:00\.000Z'\)/);
  assert.equal(await pollAirtableLeads(db, { env: AT_ENV, fetchImpl: fakeFetch([]), nowMs: NOW + 11 * 60000 }), 0);
});

test('에어테이블: 쪽 넘김은 최대 3쪽까지', async () => {
  const db = fresh();
  const pages = [1, 2, 3, 4].map(n => ({ records: [rec(`r${n}`, `0105555000${n}`, '가')], offset: `o${n}` }));
  const f = fakeFetch(pages);
  assert.equal(await pollAirtableLeads(db, { env: AT_ENV, fetchImpl: f, nowMs: NOW }), 3);
  assert.equal(f.calls.length, 3);
  assert.match(f.calls[1], /offset=o1/);
});

test('에어테이블: 조회 실패는 조용히 0 이고 로그에 번호·이름이 없음', async () => {
  const db = fresh();
  const logs = [];
  const bad = async () => ({ ok: false, status: 500, json: async () => ({}) });
  assert.equal(await pollAirtableLeads(db, { env: AT_ENV, fetchImpl: bad, nowMs: NOW, warn: (...a) => logs.push(a.join(' ')) }), 0);
  assert.equal(logs.length, 1);
  assert.doesNotMatch(logs.join(' '), /010|이름/);
});
