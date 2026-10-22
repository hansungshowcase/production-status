import assert from 'node:assert/strict';
import test from 'node:test';

async function runNotification(t, receipt) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-22T03:00:00Z') });
  const saved = Object.fromEntries(['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SMS_SENDER', 'KAKAO_PF_ID'].map(key => [key, process.env[key]]));
  Object.assign(process.env, { SOLAPI_API_KEY: 'test', SOLAPI_API_SECRET: 'test', SMS_SENDER: '0212345678' });
  delete process.env.KAKAO_PF_ID;
  t.after(() => { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
  let sends = 0;
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => { sends += 1; return { ok: true, status: 200, json: async () => ({ messageId: 'test-message' }) }; };
  t.after(() => { globalThis.fetch = originalFetch; });
  let claim;
  const db = { async execute(query) {
    if (query.sql.trim().startsWith('UPDATE orders') && query.sql.includes('RETURNING id')) {
      claim = query;
      const receiptBranch = receipt === 'success_log' ? query.sql.includes("receipt.status = 'success'") : query.sql.includes("COALESCE(receipt.provider_msgid, '') <> ''");
      const protectsReceipt = /NOT EXISTS[\s\S]*notification_log/.test(query.sql) && query.sql.includes('receipt.order_id = orders.id AND receipt.milestone = ?') && query.args.at(-1) === 'ordered' && receiptBranch;
      return { rows: receipt && protectsReceipt ? [] : [{ id: 901 }] };
    }
    return { rows: [] };
  } };
  const { maybeNotify } = await import(`../api/_lib/notify.js?receipt=${Math.random()}`);
  const result = await maybeNotify(db, { id: 901, client_name: 'fixture', phone: '01012345678', quantity: 1, track_token: 'fixture', status: 'in_production' }, 'ordered');
  return { sends, result, claim };
}

for (const receipt of ['success_log', 'provider_id']) {
  test(`${receipt} prevents resending after notify state persistence failed`, async t => {
    const { sends, result, claim } = await runNotification(t, receipt);
    assert.equal(sends, 0, 'a recorded provider receipt must prevent a second send');
    assert.deepEqual(result, { skipped: true, reason: 'already_sent_or_claimed' });
    assert.ok(claim.args.includes('ordered'));
  });
}

test('an eligible notification without a provider receipt still sends exactly once', async t => {
  const { sends, result } = await runNotification(t, null);
  assert.equal(sends, 1);
  assert.equal(result.ok, true);
});
