import assert from 'node:assert/strict';
import test from 'node:test';

function mockDb() {
  const calls = [];
  return { calls, async execute(query) {
    calls.push(query);
    const sql = String(query.sql).trim();
    if (/^UPDATE orders/i.test(sql)) return { rows: [{ id: 901 }] };
    if (/^SELECT COUNT\(\*\)::int AS n/i.test(sql)) return { rows: [{ n: 0 }] };
    if (/track_token/i.test(query.sql)) return { rows: [{ id: 901, track_token: 'fixture-token' }] };
    return { rows: [] };
  } };
}

test('real customer attempt stores generated message snapshot without external provider call', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-22T03:00:00Z') });
  const saved = Object.fromEntries(['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SMS_SENDER', 'KAKAO_PF_ID'].map((key) => [key, process.env[key]]));
  delete process.env.SOLAPI_API_KEY;
  delete process.env.SOLAPI_API_SECRET;
  delete process.env.SMS_SENDER;
  delete process.env.KAKAO_PF_ID;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new Error('provider must not be called'); };
  t.after(() => {
    globalThis.fetch = originalFetch;
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  });
  const db = mockDb();
  const { maybeNotify } = await import(`../api/_lib/notify.js?snapshot=${Math.random()}`);
  const result = await maybeNotify(db, { id: 901, client_name: '스냅샷 고객', phone: '01012345678', quantity: 1, track_token: 'fixture-token', status: 'in_production' }, 'ordered');
  assert.equal(result.dryRun, true);
  const insert = db.calls.find((call) => /INSERT INTO notification_log \(/i.test(call.sql));
  assert.ok(insert);
  assert.match(insert.sql, /recipient_name, message_subject, message_text/);
  assert.equal(insert.args.at(-3), '스냅샷 고객');
  assert.equal(typeof insert.args.at(-2), 'string');
  assert.equal(typeof insert.args.at(-1), 'string');
});

test('queued path does not invent a message snapshot', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-21T22:00:00Z') });
  const db = mockDb();
  const { maybeNotify } = await import(`../api/_lib/notify.js?queued=${Math.random()}`);
  const result = await maybeNotify(db, { id: 902, client_name: '대기 고객', phone: '01012345678', quantity: 1, status: 'in_production' }, 'ordered');
  assert.equal(result.queued, true);
  const insert = db.calls.find((call) => /INSERT INTO notification_log \(/i.test(call.sql));
  assert.ok(insert);
  assert.equal(insert.args.at(-3), null);
  assert.equal(insert.args.at(-2), null);
  assert.equal(insert.args.at(-1), null);
});
