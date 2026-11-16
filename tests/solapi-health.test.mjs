import test from 'node:test';
import assert from 'node:assert/strict';

import { checkSolapiHealth, runSolapiHealthCycle } from '../api/_lib/solapiHealth.js';
import { call } from '../api/_lib/kakaoTemplates.js';
import { solapiSend, sendAdminLms } from '../api/_lib/notify.js';

process.env.SOLAPI_API_KEY = 'testkey';
process.env.SOLAPI_API_SECRET = 'testsecret';

const json = (status, body) => ({ ok: status < 400, status, json: async () => body });
const noSleep = async () => {};
const FULL_ENV = { SOLAPI_API_KEY: 'k', SOLAPI_API_SECRET: 's', SMS_SENDER: '0212345678', KAKAO_PF_ID: 'PF1' };

test('환경값이 빠지면 not_configured 이고 detail 에는 이름만 있다', async () => {
  let called = 0;
  const result = await checkSolapiHealth({ env: { SOLAPI_API_KEY: 'secret-value-123', SMS_SENDER: '' }, fetchImpl: async () => { called += 1; } });
  assert.equal(result.state, 'not_configured');
  assert.match(result.detail, /SOLAPI_API_SECRET/);
  assert.match(result.detail, /SMS_SENDER/);
  assert.ok(!result.detail.includes('secret-value-123'));
  assert.equal(called, 0);
});

test('401 은 auth_failed, 시간 초과는 unreachable, 정상 응답은 ok', async () => {
  const auth = await checkSolapiHealth({ env: FULL_ENV, sleep: noSleep, fetchImpl: async () => json(401, { errorMessage: 'bad' }) });
  assert.equal(auth.state, 'auth_failed');
  const timeout = await checkSolapiHealth({ env: FULL_ENV, sleep: noSleep, fetchImpl: async () => { throw new Error('timeout'); } });
  assert.equal(timeout.state, 'unreachable');
  const ok = await checkSolapiHealth({ env: FULL_ENV, sleep: noSleep, fetchImpl: async () => json(200, { channelList: [{ channelId: 'PF1' }] }) });
  assert.equal(ok.state, 'ok');
});

function fakeDb() {
  let row = null;
  return {
    async execute({ sql, args }) {
      if (sql.startsWith('CREATE TABLE')) return { rows: [] };
      if (sql.startsWith('SELECT')) return { rows: row ? [row] : [] };
      row = { last_state: args[1], last_detail: args[2], last_ok_at: args[3], fail_count: args[4], alerted_at: args[5], last_run_at: args[6] };
      return { rows: [] };
    },
  };
}

test('연속 2번 실패에서만 알림 1번, 복구 때 1번', async () => {
  const db = fakeDb();
  const sent = [];
  let state = 'unreachable';
  const options = (nowMs) => ({
    nowMs,
    check: async () => ({ state, detail: '', checkedAt: '' }),
    telegram: async (message) => { sent.push(message); return { ok: true }; },
    sendAdmin: async () => ({ ok: true }),
  });
  const t0 = Date.parse('2026-11-16T00:00:00Z');
  await runSolapiHealthCycle(db, options(t0));
  assert.equal(sent.length, 0);
  await runSolapiHealthCycle(db, options(t0 + 300000));
  assert.equal(sent.length, 1);
  await runSolapiHealthCycle(db, options(t0 + 600000));
  assert.equal(sent.length, 1);
  state = 'ok';
  await runSolapiHealthCycle(db, options(t0 + 900000));
  assert.equal(sent.length, 2);
  await runSolapiHealthCycle(db, options(t0 + 1200000));
  assert.equal(sent.length, 2);
});

test('429 는 다시 시도해 성공하고, POST 5xx 는 다시 보내지 않는다', async () => {
  let calls = 0;
  const flaky = async () => { calls += 1; return calls < 3 ? json(429, {}) : json(200, { ok: 1 }); };
  assert.deepEqual(await call('kakao/v2/templates', { method: 'POST', body: { a: 1 } }, { fetchImpl: flaky, sleep: noSleep }), { ok: 1 });
  assert.equal(calls, 3);

  calls = 0;
  await assert.rejects(call('kakao/v2/templates', { method: 'POST', body: {} }, { fetchImpl: async () => { calls += 1; return json(500, {}); }, sleep: noSleep }));
  assert.equal(calls, 1);

  calls = 0;
  const sendOk = await solapiSend({ to: '01000000000' }, 'lms', { fetchImpl: async () => { calls += 1; return calls < 2 ? json(429, {}) : json(200, { messageId: 'M1' }); }, sleep: noSleep });
  assert.equal(sendOk.ok, true);
  assert.equal(calls, 2);

  calls = 0;
  const send5xx = await solapiSend({ to: '01000000000' }, 'lms', { fetchImpl: async () => { calls += 1; return json(503, {}); }, sleep: noSleep });
  assert.equal(send5xx.ok, false);
  assert.equal(calls, 1);
});

test('production 에서 키가 없으면 성공이 아니고, 그 밖에서는 dry_run 그대로', async () => {
  const saved = { key: process.env.SOLAPI_API_KEY, secret: process.env.SOLAPI_API_SECRET, env: process.env.VERCEL_ENV };
  delete process.env.SOLAPI_API_KEY;
  delete process.env.SOLAPI_API_SECRET;
  const db = { async execute() { return { rows: [] }; } };
  try {
    process.env.VERCEL_ENV = 'production';
    const prod = await sendAdminLms(db, { to: '010-1234-5678', subject: 's', text: 't' });
    assert.equal(prod.ok, false);
    assert.equal(prod.error, 'solapi_not_configured');
    assert.ok(!prod.dryRun);
    delete process.env.VERCEL_ENV;
    const local = await sendAdminLms(db, { to: '010-1234-5678', subject: 's', text: 't' });
    assert.equal(local.ok, true);
    assert.equal(local.dryRun, true);
  } finally {
    if (saved.key !== undefined) process.env.SOLAPI_API_KEY = saved.key;
    if (saved.secret !== undefined) process.env.SOLAPI_API_SECRET = saved.secret;
    if (saved.env === undefined) delete process.env.VERCEL_ENV; else process.env.VERCEL_ENV = saved.env;
  }
});
