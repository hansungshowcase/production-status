import assert from 'node:assert/strict';
import test from 'node:test';

import { classifyProviderOutcome, reconcileCustomerAttemptReceipt } from '../api/_lib/notify.js';

test('classifyProviderOutcome keeps uncertain provider outcomes out of the retry lane', () => {
  assert.equal(classifyProviderOutcome({ ok: true, dryRun: true }), 'dry_run');
  assert.equal(classifyProviderOutcome({ ok: true, msgId: 'accepted-1' }), 'accepted');
  assert.equal(classifyProviderOutcome({ ok: false, explicitFailure: true }), 'explicit_failure');
  assert.equal(classifyProviderOutcome({ ok: false, uncertain: true }), 'uncertain');
  assert.equal(classifyProviderOutcome({ ok: true, msgId: null }), 'uncertain');
});

test('customer receipt reconciliation uses attempt-token CAS and records the provider receipt', async () => {
  const calls = [];
  const db = {
    async execute({ sql, args }) {
      const compact = sql.replace(/\s+/g, ' ').trim();
      calls.push({ sql: compact, args });
      if (compact.startsWith('UPDATE orders')) return { rows: [{ id: 91 }] };
      if (compact.startsWith('SELECT COUNT')) return { rows: [{ n: 1 }] };
      if (compact.startsWith('INSERT INTO notification_log')) return { rows: [] };
      throw new Error(`Unexpected SQL: ${compact}`);
    },
  };

  const reconciled = await reconcileCustomerAttemptReceipt(
    db,
    { id: 91, phone: '010-0000-0091' },
    'ordered',
    { status: 'uncertain', attempt_token: 'token-91', channel: 'lms' },
    { messageId: 'provider-91' },
    Date.parse('2026-10-22T01:00:00.000Z'),
  );

  assert.equal(reconciled, true);
  assert.match(calls[0].sql, /attempt_token', ''\) = \?/);
  assert.equal(calls[0].args.at(-1), 'token-91');
  const insert = calls.find(call => call.sql.startsWith('INSERT INTO notification_log'));
  assert.equal(insert.args[5], 'provider-91');
});
