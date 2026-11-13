// 자사몰(카페24) 회원가입 연결(설계 18절): 받는 주소·가입 기록·가입 문자 발송. 값은 모두 가짜.
import assert from 'node:assert/strict';
import test from 'node:test';
import { handleCafe24Webhook } from '../api/cafe24/webhook.js';
import { handleCafe24Callback } from '../api/cafe24/callback.js';
import { _resetCafe24SchemaForTest, cafe24Connected, checkState, getAccessToken, makeState, pollSignups, purgeStalePhones, sealValue } from '../api/_lib/cafe24.js';
import { _resetTextTemplateSchemaForTest, saveTextTemplate } from '../api/_lib/smsTextTemplates.js';
import { _resetEventSchemaForTest, eventToggleOn, runEventSend } from '../api/_lib/smsEventSend.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db'; // 암호화 키 파생용 가짜 값
const NOW = Date.parse('2026-11-20T01:00:00Z'); // KST 10:00
const NIGHT = Date.parse('2026-11-19T15:30:00Z');
const ENABLED_AT = '2026-11-20T00:00:00.000Z';
const PHONE = '01055556666';
const ENV = { CAFE24_CLIENT_ID: 'cid', CAFE24_CLIENT_SECRET: 'csecret', CAFE24_MALL_ID: 'mymall', CAFE24_WEBHOOK_KEY: 'hookkey' };
const SEND_ENV = { SMS_SENDER: '0212345678' };
const BODY = '한성쇼케이스 가입을 환영합니다. 문의는 언제든 남겨 주세요.';

function fakeDb({ templates = [], tokens = null } = {}) {
  const state = { signups: [], sends: [], templates, tokens, nextId: 1, sql: [] };
  return {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      state.sql.push(t);
      if (/^(CREATE TABLE|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.startsWith("SELECT id FROM sms_text_templates WHERE auto_enabled = true AND auto_kind = 'member_joined'")) return { rows: state.templates.filter(r => r.auto_enabled && r.auto_kind === 'member_joined').map(r => ({ id: r.id })) };
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
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_event_sends WHERE kst_date')) return { rows: [{ n: state.sends.filter(r => r.kst_date === args[0]).length }] };
      if (t.startsWith('INSERT INTO sms_event_sends')) {
        const rows = [];
        for (let i = 0; i < args.length; i += 6) {
          const [template_id, dedupe_key, order_id, phone_hash, , kst_date] = args.slice(i, i + 6);
          if (state.sends.some(r => r.template_id === template_id && r.dedupe_key === dedupe_key)) continue;
          const row = { id: state.nextId++, template_id, dedupe_key, order_id, phone_hash, kst_date, status: 'claimed' };
          state.sends.push(row);
          rows.push({ id: row.id, dedupe_key });
        }
        return { rows };
      }
      if (t.startsWith('UPDATE sms_event_sends SET status = ?')) { const [status, , , , ...ids] = args; for (const r of state.sends.filter(x => ids.includes(x.id))) r.status = status; return { rows: [] }; }
      if (t.startsWith('SELECT id FROM sms_text_templates WHERE name')) return { rows: state.templates.filter(r => r.name === args[0]) };
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_text_templates')) return { rows: [{ n: state.templates.length }] };
      if (t.startsWith('INSERT INTO sms_text_templates')) { state.templates.push({ id: state.templates.length + 1 }); return { rows: [{ id: state.templates.length }] }; }
      if (t.startsWith('SELECT id FROM cafe24_tokens')) return { rows: state.tokens ? [{ id: 1 }] : [] };
      if (t.startsWith('UPDATE cafe24_tokens SET last_poll_at')) {
        if (!state.tokens || (state.tokens.last_poll_at && state.tokens.last_poll_at >= args[1])) return { rows: [] };
        state.tokens.last_poll_at = args[0];
        return { rows: [{ id: 1 }] };
      }
      if (t.startsWith('SELECT access_enc, refresh_enc, access_expires_at')) return { rows: state.tokens ? [state.tokens] : [] };
      if (t.startsWith('UPDATE cafe24_tokens SET refreshing_until')) { state.tokens.refreshing_until = args[0]; return { rows: [{ id: 1 }] }; }
      if (t.startsWith('UPDATE cafe24_tokens SET refresh_expires_at = NULL')) { state.tokens.refresh_expires_at = null; state.tokens.refreshing_until = null; return { rows: [] }; }
      if (t.startsWith('INSERT INTO cafe24_tokens')) { state.tokens = { ...(state.tokens || {}), access_enc: args[0], refresh_enc: args[1], access_expires_at: args[2], refresh_expires_at: args[3] }; return { rows: [] }; }
      throw new Error(`예상 못 한 SQL ${t}`);
    },
  };
}
const mkRes = () => ({ code: 0, body: null, headers: {}, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, send(b) { this.body = b; return this; }, setHeader(k, v) { this.headers[k] = v; }, end() { return this; } });
const JOIN_BODY = { event_no: 90032, resource: { mall_id: 'mymall', member_id: 'user01', cellphone: '010-5555-6666', created_date: '2026-11-20T09:30:00+09:00' } };
async function hook(db, over = {}) {
  _resetCafe24SchemaForTest();
  _resetTextTemplateSchemaForTest();
  const res = mkRes();
  const logs = [];
  await handleCafe24Webhook({ method: 'POST', headers: { 'x-api-key': 'hookkey' }, body: JOIN_BODY, ...over }, res, { db, env: ENV, nowMs: NOW, warn: (...a) => logs.push(a.join(' ')) });
  return { res, logs };
}
const fakeProvider = () => {
  const calls = [];
  return { calls, async uploadImage() { return { fileId: 'F' }; }, async sendEach(input) { calls.push(input); return { accepted: input.messages.length, failed: 0, groupId: 'G1', uncertain: false, error: '' }; } };
};
const memberTpl = (extra = {}) => ({ id: 9, name: '가입 안내', body: BODY, images: [], auto_kind: 'member_joined', auto_enabled: true, auto_step: '', auto_enabled_at: ENABLED_AT, auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_offset: 0, auto_unless_step: '', ...extra });
const go = (db, provider, template, extra = {}) => { _resetEventSchemaForTest(); _resetCafe24SchemaForTest(); return runEventSend(template, { db, provider, env: SEND_ENV, nowMs: NOW, staff: [], warn() {}, ...extra }); };

test('가입 ① 웹훅: 환경 변수 없음 503 · 키 틀림 401 · 같은 가입 두 번이어도 1행 · 모르는 모양은 조용히 200', async () => {
  const db = fakeDb({ templates: [memberTpl()] });
  const none = mkRes();
  await handleCafe24Webhook({ method: 'POST', headers: {}, body: {} }, none, { db, env: {} });
  assert.equal(none.code, 503);
  assert.equal((await hook(db, { headers: { 'x-api-key': 'wrong' } })).res.code, 401);
  assert.equal(db.state.signups.length, 0);
  assert.equal((await hook(db)).res.code, 200);
  assert.equal((await hook(db)).res.code, 200);
  assert.equal(db.state.signups.length, 1);
  assert.equal(db.state.signups[0].source, 'webhook');
  assert.ok(db.state.signups[0].phone_enc); // 켜진 가입 문구가 있어 번호를 보관
  const odd = await hook(db, { body: { something: 1 } });
  assert.equal(odd.res.code, 200);
  assert.equal(db.state.signups.length, 1);
  assert.equal(odd.logs.length, 1);
  assert.equal((await hook(db, { body: { event_no: 90032, resource: { mall_id: 'other', member_id: 'u2', cellphone: PHONE } } })).res.code, 200);
  assert.equal(db.state.signups.length, 1); // 다른 쇼핑몰은 무시
  const callback = mkRes();
  await handleCafe24Callback({ method: 'GET', query: {} }, callback, { env: {} });
  assert.equal(callback.code, 503);
});

test('가입 ② 켠 시각 이후 가입만 나가고 두 번 돌려도 1번, 야간에는 무동작, 켜진 문구가 없으면 번호를 저장하지 않는다', async () => {
  const off = fakeDb({ templates: [memberTpl({ auto_enabled: false })] });
  await hook(off);
  assert.equal(off.state.signups.length, 1);
  assert.equal(off.state.signups[0].phone_enc, null); // 켜진 문구 없음 → 해시·끝 4자리만
  const db = fakeDb({ templates: [memberTpl()] });
  await hook(db); // 가입 시각 KST 09:30 = 켠 시각(09:00) 뒤
  await hook(db, { body: { event_no: 90032, resource: { mall_id: 'mymall', member_id: 'old01', cellphone: '01077778888', created_date: '2026-11-19T20:00:00+09:00' } } }); // 켜기 전
  const provider = fakeProvider();
  const night = await go(db, provider, memberTpl(), { nowMs: NIGHT });
  assert.equal(night.reason, 'night');
  assert.equal(provider.calls.length, 0);
  const out = await go(db, provider, memberTpl());
  assert.equal(out.claimed, 1);
  assert.deepEqual(provider.calls[0].messages.map(m => m.to), [PHONE]);
  assert.equal(provider.calls[0].messages[0].text, BODY);
  assert.equal(db.state.sends[0].order_id, null);
  assert.ok(db.state.sends[0].dedupe_key.endsWith(':member:member_joined'));
  assert.equal((await go(db, provider, memberTpl())).claimed, 0);
  assert.equal(provider.calls.length, 1);
});

test('가입 ③ 선점 뒤 번호(phone_enc)는 NULL, 24시간 지난 행도 NULL, 응답·로그·기록 어디에도 번호가 없다', async () => {
  const db = fakeDb({ templates: [memberTpl()] });
  const { res, logs } = await hook(db);
  assert.ok(db.state.signups[0].phone_enc);
  const stale = fakeDb();
  stale.state.signups.push({ id: 50, member_hash: 'x', joined_at: '2026-11-18T00:00:00.000Z', phone_hash: 'h', phone_last4: '0000', phone_enc: 'zz', source: 'poll' });
  await purgeStalePhones(stale, NOW);
  assert.equal(stale.state.signups[0].phone_enc, null);
  const warns = [];
  await go(db, fakeProvider(), memberTpl(), { warn: (...a) => warns.push(a.join(' ')) });
  assert.equal(db.state.signups[0].phone_enc, null);
  assert.equal(db.state.sends.length, 1);
  const dump = JSON.stringify([res.body, logs, warns, db.state.sends, db.state.signups]);
  assert.equal(dump.includes(PHONE), false);
  assert.equal(dump.includes('5555'), false);
  assert.equal(dump.includes('6666'), true); // 끝 4자리만 남는다
});

test('가입 ④ member_joined 저장: 광고 낱말·변수는 거절, 켜기는 카페24 미연결이면 거절, 연결되면 켠 시각이 적힌다', async () => {
  const db = fakeDb();
  _resetTextTemplateSchemaForTest();
  const save = (name, body) => saveTextTemplate(db, { name, body, auto: { kind: 'member_joined' } }, { staff: [] });
  const ad = await save('가입 A', '가입 감사 쿠폰을 드립니다');
  assert.deepEqual([ad.status, ad.body.reason], [400, 'info_has_ad_words']);
  const orderVar = await save('가입 B', '#{주문번호} 가입');
  assert.deepEqual([orderVar.status, orderVar.body.reason], [400, 'info_unknown_var']);
  const nameVar = await save('가입 C', '#{고객명}님 가입을 환영합니다');
  assert.deepEqual([nameVar.status, nameVar.body.reason], [400, 'info_unknown_var']);
  const good = await save('가입 D', BODY);
  assert.equal(good.status, 201);
  assert.deepEqual([good.body.item.auto_kind, good.body.item.auto_audience, good.body.item.auto_msg_type], ['member_joined', 'customer', 'info']);
  const template = memberTpl({ auto_enabled: false });
  const closed = await eventToggleOn({}, template, { db, env: SEND_ENV, nowMs: NOW });
  assert.deepEqual([closed.status, closed.body.reason], [400, 'cafe24_not_connected']);
  assert.equal((await eventToggleOn({ dry_run: true }, template, { db, env: ENV, nowMs: NOW })).body.reason, 'cafe24_not_connected'); // 환경은 있으나 토큰 행 없음
  const open = fakeDb({ tokens: { access_enc: 'a', refresh_enc: 'r' } });
  assert.equal(await cafe24Connected(open, ENV), true);
  const seen = [];
  const connectedDb = { async execute(q) { seen.push(q.sql); return /^\s*SELECT id FROM cafe24_tokens/.test(q.sql) ? { rows: [{ id: 1 }] } : { rows: [] }; } };
  _resetCafe24SchemaForTest();
  const opened = await eventToggleOn({}, template, { db: connectedDb, env: ENV, nowMs: NOW });
  assert.equal(opened.status, 200);
  assert.ok(seen.some(sql => sql.includes('auto_enabled_at = NOW()')));
  assert.equal((await eventToggleOn({ dry_run: true }, template, { db: open, env: ENV, nowMs: NOW })).body.overlap, false);
});

test('가입 ⑤ 보충 조회: 만료된 액세스 토큰은 선점 갱신 뒤 쓰고, 60분 안에는 다시 조회하지 않으며, state 서명은 위조·만료를 거절한다', async () => {
  const db = fakeDb({ templates: [memberTpl()] });
  db.state.tokens = { access_enc: sealValue('cafe24.access', 'old-access'), refresh_enc: sealValue('cafe24.refresh', 'old-refresh'), access_expires_at: '2026-11-20T00:00:00.000Z', last_poll_at: null };
  const urls = [];
  const fetchImpl = async (url, init) => {
    urls.push(String(url));
    if (String(url).includes('/oauth/token')) {
      assert.ok(String(init.body).includes('refresh_token=old-refresh'));
      return { ok: true, json: async () => ({ access_token: 'new-access', refresh_token: 'new-refresh' }) };
    }
    assert.equal(init.headers.Authorization, 'Bearer new-access');
    return { ok: true, json: async () => ({ customersprivacy: [{ member_id: 'p1', cellphone: '01099990000', created_date: '2026-11-20T09:40:00+09:00' }, { member_id: 'p2' }] }) };
  };
  _resetCafe24SchemaForTest();
  assert.equal(await pollSignups(db, { env: ENV, fetchImpl, nowMs: NOW, warn() {} }), 1);
  assert.equal(db.state.signups[0].source, 'poll');
  assert.equal(urls.length, 2);
  assert.equal(await pollSignups(db, { env: ENV, fetchImpl, nowMs: NOW + 60000, warn() {} }), 0); // 60분 안
  assert.equal(urls.length, 2);
  const config = { clientSecret: 'csecret' };
  const state = makeState(config, NOW);
  assert.equal(checkState(config, state, NOW + 1000), true);
  assert.equal(checkState(config, `${state}x`, NOW), false);
  assert.equal(checkState(config, state, NOW + 11 * 60000), false);
  const redirect = mkRes();
  await handleCafe24Callback({ method: 'GET', query: {} }, redirect, { env: ENV, nowMs: NOW, db: fakeDb() });
  assert.equal(redirect.code, 302);
  assert.ok(redirect.headers.Location.startsWith('https://mymall.cafe24api.com/api/v2/oauth/authorize?'));
  const bad = mkRes();
  await handleCafe24Callback({ method: 'GET', query: { code: 'c', state: 'nope' } }, bad, { env: ENV, nowMs: NOW });
  assert.equal(bad.code, 400);
});

test('가입 ⑥ 선점 뒤 다시 읽은 행이 이미 갱신됐으면 갱신 요청 0번', async () => {
  const stale = { access_enc: sealValue('cafe24.access', 'old-access'), refresh_enc: sealValue('cafe24.refresh', 'old-refresh'), access_expires_at: '2026-11-20T00:00:00.000Z', refresh_expires_at: '2026-12-01T00:00:00.000Z' };
  const renewed = { ...stale, access_enc: sealValue('cafe24.access', 'renewed-access'), refresh_enc: sealValue('cafe24.refresh', 'renewed-refresh'), access_expires_at: '2026-11-20T02:30:00.000Z' };
  const db = fakeDb({ tokens: stale });
  const base = db.execute.bind(db);
  let reads = 0;
  db.execute = async q => { if (/^\s*SELECT access_enc/.test(q.sql) && ++reads === 2) db.state.tokens = renewed; return base(q); }; // 첫 읽기 뒤 다른 실행이 갱신을 끝낸 상황
  let calls = 0;
  _resetCafe24SchemaForTest();
  const token = await getAccessToken(db, { env: ENV, fetchImpl: async () => { calls += 1; throw new Error('호출되면 안 됨'); }, nowMs: NOW });
  assert.equal(calls, 0);
  assert.equal(token, 'renewed-access');
});

test('가입 ⑦ 콜백: 쿠키 난수가 없거나 state 와 다르면 토큰 교환 0번 · 400, 같으면 교환', async () => {
  const state = makeState({ clientSecret: 'csecret' }, NOW);
  const nonce = state.split('.')[1];
  let calls = 0;
  const fetchImpl = async () => { calls += 1; return { ok: true, json: async () => ({ access_token: 'a', refresh_token: 'r' }) }; };
  const run = async cookie => { const res = mkRes(); await handleCafe24Callback({ method: 'GET', query: { code: 'c', state }, headers: cookie === null ? {} : { cookie } }, res, { env: ENV, nowMs: NOW, db: fakeDb(), fetchImpl, warn() {} }); return res; };
  assert.equal((await run(null)).code, 400);
  assert.equal((await run('cafe24_oauth=0000000000000000')).code, 400);
  assert.equal(calls, 0);
  assert.equal((await run(`cafe24_oauth=${nonce}`)).code, 200);
  assert.equal(calls, 1);
});

test('가입 ⑧ 갱신이 401 로 실패하면 refresh_expires_at 이 NULL 이 되고 콜백은 이미 연결됨이 아니라 authorize 로 보낸다', async () => {
  const db = fakeDb({ tokens: { access_enc: sealValue('cafe24.access', 'a'), refresh_enc: sealValue('cafe24.refresh', 'r'), access_expires_at: '2026-11-20T00:00:00.000Z', refresh_expires_at: '2026-12-01T00:00:00.000Z' } });
  _resetCafe24SchemaForTest();
  const before = mkRes();
  await handleCafe24Callback({ method: 'GET', query: {} }, before, { env: ENV, nowMs: NOW, db });
  assert.equal(before.code, 200); // 갱신 실패 전에는 이미 연결됨
  await assert.rejects(getAccessToken(db, { env: ENV, nowMs: NOW, fetchImpl: async () => ({ ok: false, status: 401 }) }));
  assert.equal(db.state.tokens.refresh_expires_at, null);
  const after = mkRes();
  await handleCafe24Callback({ method: 'GET', query: {} }, after, { env: ENV, nowMs: NOW, db });
  assert.equal(after.code, 302);
  assert.ok(after.headers.Location.includes('/oauth/authorize?'));
});
