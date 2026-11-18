// 알림톡·브랜드메시지 일괄 발송 잔액 부족 영구 누락 방지 (2026-11-18): (a) 선점 전 잔액 확인, (b) 접수 뒤 전부 실패한 쏠라피 그룹 재확인.
// 가짜 db·가짜 발송기·가짜 fetch 만 쓴다(실제 발송·쏠라피 호출 없음). 값은 모두 가짜.
import assert from 'node:assert/strict';
import test from 'node:test';
import { _resetAutoSchemaForTest } from '../api/_lib/smsAutoSend.js';
import { _resetTextTemplateSchemaForTest } from '../api/_lib/smsTextTemplates.js';
import { _resetEventSchemaForTest, runEventSend, runInstantSendAll } from '../api/_lib/smsEventSend.js';
import { _resetManualSendSchemaForTest } from '../api/_lib/smsManualSend.js';
import { getSendProvider } from '../api/_lib/sendProvider.js';
import { BMS_PF_ID, BMS_SENDER, bmsImageSig } from '../api/_lib/smsBms.js';

process.env.POSTGRES_URL = 'postgres://user:fake-test-password@host.example/db';
const NOW = Date.parse('2026-11-20T01:00:00Z'); // KST 11-20 10:00
const HOUR = 3600000;
const ENV = { SMS_SENDER: '0212345678' };
const BODY = '안녕하세요 #{고객명} 대표님\n구글 리뷰를 남겨 주세요.';
const IMG = 'FAKEJPEGBASE64==';
const BUTTONS = [{ name: '구글 리뷰 쓰기', link: 'https://search.google.com/local/writereview?placeid=TEST' }];
const cfgJson = (extra = {}) => JSON.stringify({ pfId: BMS_PF_ID, from: BMS_SENDER, buttons: BUTTONS, imageId: 'ST01FZ_TEST_IMAGE', imageSig: bmsImageSig(IMG), ...extra });

function fakeDb({ orders = [] } = {}) {
  const state = { sends: [], nextId: 1, done: [], paused: [], failMark: 0, failClear: 0, sql: [] };
  return {
    state,
    async execute({ sql, args }) {
      const t = sql.replace(/\s+/g, ' ').trim();
      state.sql.push(t);
      if (/^(CREATE TABLE|CREATE UNIQUE INDEX|ALTER TABLE)/.test(t)) return { rows: [] };
      if (t.startsWith('SELECT conname FROM pg_constraint')) return { rows: [] };
      if (t.startsWith('SELECT phone_hash FROM sms_optouts')) return { rows: [] };
      if (t.includes("FROM orders WHERE status = 'shipped'")) return { rows: orders.filter(o => o.status === 'shipped' && o.ship_date.slice(0, 10) >= args[0] && o.ship_date.slice(0, 10) <= args[1]).sort((a, b) => a.ship_date.localeCompare(b.ship_date) || a.id - b.id).map(o => ({ id: o.id, phone: o.phone, client_name: o.client_name, ship_day: o.ship_date.slice(0, 10) })) };
      if (t.startsWith('SELECT id, track_token FROM orders')) return { rows: [] };
      if (t.startsWith('SELECT dedupe_key FROM sms_event_sends WHERE template_id = ? AND dedupe_key IN')) return { rows: state.sends.filter(r => r.template_id === args[0] && args.slice(1).includes(r.dedupe_key)).map(r => ({ dedupe_key: r.dedupe_key })) };
      if (t.startsWith('SELECT dedupe_key FROM sms_event_sends WHERE template_id = ?')) return { rows: state.sends.filter(r => r.template_id === args[0]).map(r => ({ dedupe_key: r.dedupe_key })) };
      if (t.startsWith('SELECT COUNT(*) AS n FROM sms_event_sends WHERE kst_date = ?')) return { rows: [{ n: state.sends.filter(r => r.kst_date === args[0] && (t.includes("kind = 'catchup'") ? r.kind === 'catchup' : t.includes("<> 'catchup'") ? r.kind !== 'catchup' : true)).length }] };
      if (t.startsWith("UPDATE sms_event_sends SET kind = 'catchup'")) { for (const r of state.sends.filter(x => args.includes(x.id))) r.kind = 'catchup'; return { rows: [] }; }
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
      if (t.startsWith('UPDATE sms_event_sends SET status = ?')) { const [status, , reason, groupIds, ...ids] = args; for (const r of state.sends.filter(x => ids.includes(x.id))) { r.status = status; r.reason = reason; r.group_ids = groupIds; } return { rows: [] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_catchup_done_at = NOW()')) { state.done.push(args[0]); return { rows: [{ id: args[0] }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_catchup_paused_at = NOW()')) { state.paused.push({ error: args[0], id: args[1] }); return { rows: [{ id: args[1] }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_ata_fail_at = CASE')) { state.failMark += 1; return { rows: [{ id: args[0] }] }; }
      if (t.startsWith('UPDATE sms_text_templates SET auto_ata_fail_at = NULL')) { state.failClear += 1; return { rows: [{ id: args[0] }] }; }
      if (t.startsWith("SELECT id, group_ids FROM sms_event_sends WHERE template_id = ? AND status = 'sent'")) return { rows: state.sends.filter(r => r.template_id === args[0] && r.status === 'sent' && r.kind === 'catchup' && r.kst_date >= args[1] && !r.checked_at).map(r => ({ id: r.id, group_ids: r.group_ids })) };
      if (t.startsWith('UPDATE sms_event_sends SET checked_at = NOW()')) { for (const r of state.sends.filter(x => args.includes(x.id))) r.checked_at = 'now'; return { rows: [] }; }
      if (t.startsWith("DELETE FROM sms_event_sends WHERE status = 'sent'")) { state.sends = state.sends.filter(r => !(r.status === 'sent' && args.includes(r.id))); return { rows: [] }; }
      throw new Error(`예상 못 한 SQL ${t}`);
    },
  };
}

const accepted = input => ({ accepted: input.messages.length, failed: 0, groupId: 'G1', uncertain: false, error: '' });
// groups: { G1: 결과 | 'throw' } — 조회 호출 횟수를 센다
function provider({ groups = {}, respond = accepted } = {}) {
  const calls = { bms: [], kakao: [], each: [], group: [] };
  return {
    calls,
    estimate: () => ({ unit: 45, total: 45 }),
    estimateKakao: ({ count }) => ({ unit: 13, total: 13 * count }),
    estimateBms: ({ count }) => ({ unit: 100, total: 100 * count, fallback_unit: 45 }),
    async uploadImage() { return { fileId: 'F1' }; },
    async sendBmsEach(input) { calls.bms.push(input); return respond(input); },
    async sendKakaoEach(input) { calls.kakao.push(input); return respond(input); },
    async sendEach(input) { calls.each.push(input); return respond(input); },
    async groupResult(id) { calls.group.push(id); const g = groups[id]; if (g === 'throw') throw new Error('boom'); return g ?? null; },
  };
}
const kakao = (balance = 100000) => ({ calls: 0, async getBalance() { this.calls += 1; if (balance === 'throw') throw new Error('boom'); return balance; }, async getTemplateFresh() { return { raw: { channelId: 'PF1' }, template: { status: 'APPROVED', variables: ['#{고객명}'], content: '#{고객명}님' }, scope: { allowed: true, kind: 'channel' } }; } });
const reset = () => { _resetEventSchemaForTest(); _resetAutoSchemaForTest(); _resetTextTemplateSchemaForTest(); _resetManualSendSchemaForTest(); };
const base = (extra = {}) => ({ id: 31, name: '구글 리뷰', body: BODY, images: [IMG], auto_kind: 'ship_plus_days', auto_enabled: true, auto_days: 3, auto_ata_template: 'BMS_FREE', auto_bms: cfgJson(), auto_enabled_at: new Date(NOW - 3 * HOUR).toISOString(), auto_audience: 'customer', auto_staff: [], auto_msg_type: 'info', auto_offset: 0, auto_unless_step: '', auto_daily: '', auto_weekdays: false, auto_unless_mode: 'completed', auto_step: '', auto_send_time: '', auto_catchup_from: '', auto_catchup_at: '', auto_catchup_done: false, ...extra });
const catchupTpl = (extra = {}) => base({ auto_catchup_from: '2026-10-01', auto_catchup_at: '2026-11-20T09:00', ...extra });
const order = (id, phone, shipDate, name = '', status = 'shipped') => ({ id, phone, ship_date: shipDate, client_name: name, status });
const run = (db, vendor, template, extra = {}) => { reset(); return runEventSend(template, { db, provider: vendor, env: ENV, nowMs: NOW, kakao: kakao(), warn: () => {}, ...extra }); };
const threeOrders = [order(1, '010-1111-2222', '2026-10-05', '가'), order(2, '010-3333-4444', '2026-10-06', '나'), order(3, '010-5555-6666', '2026-10-07', '다')];
const ataTpl = (extra = {}) => catchupTpl({ auto_ata_template: 'KA01TP1', auto_bms: '', images: [], ...extra });

// ---------- (a) 선점 전 잔액 확인 ----------
test('(a) 잔액 부족 BMS 일괄 발송: 선점 0건·발송 0건·일괄 발송 멈춤+사유', async () => {
  const db = fakeDb({ orders: threeOrders });
  const vendor = provider();
  const out = await run(db, vendor, catchupTpl(), { catchupOnly: true, kakao: kakao(250) });
  assert.equal(out.reason, 'balance_short'); assert.equal(out.sent, 0);
  assert.equal(db.state.sends.length, 0, '선점하지 않는다');
  assert.equal(vendor.calls.bms.length, 0);
  assert.deepEqual(db.state.paused, [{ error: '잔액 부족: 필요 300원, 잔액 250원', id: 31 }]);
  assert.ok(!db.state.sql.some(s => s.startsWith('INSERT INTO sms_event_sends')));
});

test('(a) 잔액 조회 실패(null·예외)·충분하면 종전대로 보낸다', async () => {
  for (const balance of [null, 'throw', 300, 100000]) {
    const db = fakeDb({ orders: threeOrders });
    const vendor = provider();
    const out = await run(db, vendor, catchupTpl(), { catchupOnly: true, kakao: kakao(balance) });
    assert.equal(out.sent, 3, `잔액 ${balance}`); assert.equal(vendor.calls.bms.length, 1); assert.deepEqual(db.state.paused, []);
  }
});

test('(a) 문자 문구는 잔액을 조회하지 않는다', async () => {
  const db = fakeDb({ orders: [order(1, '010-1111-2222', '2026-11-17', '가')] });
  const vendor = provider();
  const k = kakao(1);
  const out = await run(db, vendor, base({ auto_ata_template: '', auto_bms: '', images: [], auto_catchup_from: '', auto_catchup_at: '' }), { kakao: k });
  assert.equal(k.calls, 0); assert.equal(vendor.calls.bms.length + vendor.calls.kakao.length, 0);
  assert.notEqual(out.reason, 'balance_short');
});

test('(a) 평소 알림톡(일괄 아님)은 잔액이 모자라면 선점 없이 끝나고 멈춤 표시는 하지 않는다', async () => {
  const db = fakeDb({ orders: [order(1, '010-1111-2222', '2026-11-17', '가')] });
  const vendor = provider();
  const out = await run(db, vendor, ataTpl({ auto_catchup_from: '', auto_catchup_at: '' }), { kakao: kakao(5) });
  assert.equal(out.reason, 'balance_short'); assert.equal(db.state.sends.length, 0); assert.deepEqual(db.state.paused, []); assert.equal(vendor.calls.kakao.length, 0);
});

// ---------- (b) 그룹 결과 재확인 ----------
const COMPLETE_ZERO = { status: 'COMPLETE', success: 0, replacement: 0, failed: 3, total: 3, log: '잔액이 부족합니다 '.repeat(20) };
test('(b) 그룹이 완료됐는데 성공 0건: 행을 지우고 일괄 발송을 멈추며, 이후(다시 저장) 같은 번호가 다시 대상이 된다', async () => {
  const db = fakeDb({ orders: threeOrders });
  assert.equal((await run(db, provider(), catchupTpl(), { catchupOnly: true })).sent, 3);
  assert.equal(db.state.sends.length, 3);
  const vendor = provider({ groups: { G1: COMPLETE_ZERO } });
  const out = await run(db, vendor, catchupTpl(), { catchupOnly: true });
  assert.deepEqual(vendor.calls.group, ['G1'], '그룹은 1번만 조회');
  assert.equal(db.state.sends.length, 0); assert.equal(out.reason, 'catchup_paused'); assert.equal(vendor.calls.bms.length, 0, '같은 실행에서 다시 보내지 않는다');
  assert.equal(db.state.paused.length, 1); assert.equal(db.state.paused[0].id, 31);
  assert.ok(db.state.paused[0].error.startsWith('쏠라피 발송 실패: ')); assert.ok(db.state.paused[0].error.length <= '쏠라피 발송 실패: '.length + 150);
  const again = provider();
  assert.equal((await run(db, again, catchupTpl(), { catchupOnly: true })).sent, 3, '멈춤이 풀리면 지워진 행의 번호가 다시 대상');
});

test('(b) 그룹이 일부 성공: 행은 그대로, checked_at 만 기록하고 다음엔 다시 조회하지 않는다', async () => {
  const db = fakeDb({ orders: threeOrders });
  await run(db, provider(), catchupTpl(), { catchupOnly: true });
  const vendor = provider({ groups: { G1: { status: 'COMPLETE', success: 2, replacement: 0, failed: 1, total: 3, log: '' } } });
  const out = await run(db, vendor, catchupTpl(), { catchupOnly: true });
  assert.equal(db.state.sends.length, 3); assert.ok(db.state.sends.every(r => r.checked_at && r.status === 'sent')); assert.deepEqual(db.state.paused, []); assert.notEqual(out.reason, 'catchup_paused');
  await run(db, vendor, catchupTpl(), { catchupOnly: true });
  assert.equal(vendor.calls.group.length, 1, '재조회 없음');
});

test('(b) 그룹이 아직 처리 중이거나 조회가 예외·null: 아무것도 바꾸지 않는다', async () => {
  for (const g of [{ status: 'SENDING', success: 0, replacement: 0, failed: 0, total: 3, log: '' }, 'throw', null]) {
    const db = fakeDb({ orders: threeOrders });
    await run(db, provider(), catchupTpl(), { catchupOnly: true });
    const vendor = provider({ groups: { G1: g } });
    await run(db, vendor, catchupTpl(), { catchupOnly: true });
    assert.equal(db.state.sends.length, 3); assert.ok(db.state.sends.every(r => !r.checked_at && r.status === 'sent')); assert.deepEqual(db.state.paused, []);
  }
});

test('(b) 멈춘 문구도 미확인 그룹이 있으면 재확인이 돈다 / 일괄 크론 목록 SQL 도 그런 문구를 가져온다', async () => {
  const db = fakeDb({ orders: threeOrders });
  await run(db, provider(), catchupTpl(), { catchupOnly: true });
  const vendor = provider({ groups: { G1: COMPLETE_ZERO } });
  await run(db, vendor, catchupTpl({ auto_catchup_paused: true, auto_catchup_error: '이전 사유' }), { catchupOnly: true });
  assert.deepEqual(vendor.calls.group, ['G1']); assert.equal(db.state.sends.length, 0);
  const seen = [];
  const listDb = { async execute({ sql, args }) { seen.push({ t: sql.replace(/\s+/g, ' '), args }); return { rows: [] }; } };
  await runInstantSendAll({ db: listDb, nowMs: NOW });
  assert.ok(seen[0].t.includes("kind = 'catchup' AND kst_date >= ? AND checked_at IS NULL")); assert.deepEqual(seen[0].args, ['2026-11-19']);
});

test('groupResult: 그룹 응답을 정리하고 4xx·5xx·예외는 null', async () => {
  const prev = { k: process.env.SOLAPI_API_KEY, s: process.env.SOLAPI_API_SECRET };
  process.env.SOLAPI_API_KEY = 'k'; process.env.SOLAPI_API_SECRET = 's';
  try {
    const solapi = getSendProvider('solapi');
    const urls = [];
    const ok = async url => { urls.push(String(url)); return { ok: true, status: 200, json: async () => ({ status: 'COMPLETE', count: { total: 50, sentSuccess: 0, sentReplacement: 0, sentFailed: 50 }, log: [{ message: 'a' }, { message: '잔액 부족' }] }) }; };
    assert.deepEqual(await solapi.groupResult('G123', { fetchImpl: ok }), { status: 'COMPLETE', success: 0, replacement: 0, failed: 50, total: 50, log: '잔액 부족' });
    assert.ok(urls[0].endsWith('/messages/v4/groups/G123'));
    const res = status => async () => ({ ok: false, status, json: async () => ({ errorMessage: 'x' }) });
    assert.equal(await solapi.groupResult('G1', { fetchImpl: res(404) }), null);
    assert.equal(await solapi.groupResult('G1', { fetchImpl: res(500) }), null);
    assert.equal(await solapi.groupResult('G1', { fetchImpl: async () => { throw new Error('net'); } }), null);
  } finally {
    for (const [name, v] of [['SOLAPI_API_KEY', prev.k], ['SOLAPI_API_SECRET', prev.s]]) { if (v === undefined) delete process.env[name]; else process.env[name] = v; }
  }
});

// ---------- (b) 추가: 쏠라피 응답 형태·숫자 이상 방어 (2026-11-18 Fable 점검) ----------
const setupSent = async () => { const db = fakeDb({ orders: threeOrders }); await run(db, provider(), catchupTpl(), { catchupOnly: true }); return db; };

test('(b) FAILED 상태·실패 50·성공 0: 행 삭제·일괄 발송 멈춤', async () => {
  const db = await setupSent();
  const vendor = provider({ groups: { G1: { status: 'FAILED', success: 0, replacement: 0, failed: 50, total: 50, log: '잔액 부족' } } });
  const out = await run(db, vendor, catchupTpl(), { catchupOnly: true });
  assert.equal(db.state.sends.length, 0); assert.equal(out.reason, 'catchup_paused'); assert.equal(db.state.paused.length, 1);
});

test('(b) COMPLETE 인데 숫자가 전부 0: 아무것도 바꾸지 않고 checked_at 도 없다', async () => {
  const db = await setupSent();
  const vendor = provider({ groups: { G1: { status: 'COMPLETE', success: 0, replacement: 0, failed: 0, total: 0, log: '' } } });
  await run(db, vendor, catchupTpl(), { catchupOnly: true });
  assert.equal(db.state.sends.length, 3); assert.ok(db.state.sends.every(r => !r.checked_at && r.status === 'sent')); assert.deepEqual(db.state.paused, []);
});

test('(b) 숫자 필드가 없음(null): 아무것도 바꾸지 않는다', async () => {
  const db = await setupSent();
  const vendor = provider({ groups: { G1: { status: 'COMPLETE', success: null, replacement: null, failed: null, total: null, log: '' } } });
  await run(db, vendor, catchupTpl(), { catchupOnly: true });
  assert.equal(db.state.sends.length, 3); assert.ok(db.state.sends.every(r => !r.checked_at)); assert.deepEqual(db.state.paused, []);
});

test('(b) 완료 표시된 문구도 전부 실패가 확인되면 멈춤 UPDATE 가 auto_catchup_done_at = NULL 을 포함한다', async () => {
  const db = await setupSent();
  const vendor = provider({ groups: { G1: COMPLETE_ZERO } });
  await run(db, vendor, catchupTpl({ auto_catchup_done: true, auto_catchup_done_at: '2026-11-20T00:00:00Z' }), { catchupOnly: true });
  assert.ok(db.state.sql.some(s => s.startsWith('UPDATE sms_text_templates SET auto_catchup_paused_at = NOW()') && s.includes('auto_catchup_done_at = NULL')));
  assert.equal(db.state.paused.length, 1);
});

test('groupResult: 감싼 응답(groupInfo)도 읽고, 숫자 필드가 없으면 0 이 아니라 null', async () => {
  const prev = { k: process.env.SOLAPI_API_KEY, s: process.env.SOLAPI_API_SECRET };
  process.env.SOLAPI_API_KEY = 'k'; process.env.SOLAPI_API_SECRET = 's';
  try {
    const solapi = getSendProvider('solapi');
    const wrapped = async () => ({ ok: true, status: 200, json: async () => ({ groupInfo: { status: 'FAILED', count: { total: 5, sentSuccess: 0, sentReplacement: 0, sentFailed: 5 }, log: [{ message: '잔액 부족' }] } }) });
    assert.deepEqual(await solapi.groupResult('G9', { fetchImpl: wrapped }), { status: 'FAILED', success: 0, replacement: 0, failed: 5, total: 5, log: '잔액 부족' });
    const noCount = async () => ({ ok: true, status: 200, json: async () => ({ status: 'COMPLETE' }) });
    assert.deepEqual(await solapi.groupResult('G9', { fetchImpl: noCount }), { status: 'COMPLETE', success: null, replacement: null, failed: null, total: null, log: '' });
  } finally {
    for (const [name, v] of [['SOLAPI_API_KEY', prev.k], ['SOLAPI_API_SECRET', prev.s]]) { if (v === undefined) delete process.env[name]; else process.env[name] = v; }
  }
});
