import assert from 'node:assert/strict';
import test from 'node:test';

import {
  applyRepair,
  makeStatefulClient,
  queryEvents,
} from './repair-legacy-sales-person-aliases-helper.mjs';

test('a postflight replacement mismatch rolls back before commit', async () => {
  const client = makeStatefulClient({
    postflightTransform: rows => rows.map((row, index) => (
      index === 0 ? { ...row, sales_person: 'unexpected-postflight-value' } : row
    )),
  });
  await assert.rejects(
    applyRepair(client),
    error => (
      error?.code === 'POSTFLIGHT_REPLACEMENT_MISMATCH'
      && error.orderId === 203
    ),
  );
  assert.equal(queryEvents(client, 'COMMIT').length, 0);
  assert.equal(queryEvents(client, 'ROLLBACK').length, 1);
  assert.equal(client.events.at(-1).sql, 'ROLLBACK');
});

test('postflight preimage drift rolls back before commit', async () => {
  const client = makeStatefulClient({
    postflightTransform: rows => rows.map((row, index) => (
      index === 0 ? { ...row, due_date: '2026-08-01' } : row
    )),
  });
  await assert.rejects(
    applyRepair(client),
    error => (
      error?.code === 'POSTFLIGHT_PREIMAGE_MISMATCH'
      && error.orderId === 203
    ),
  );
  assert.equal(queryEvents(client, 'COMMIT').length, 0);
  assert.equal(queryEvents(client, 'ROLLBACK').length, 1);
});

test('a lost COMMIT response is accepted only after fresh state verification', async () => {
  const client = makeStatefulClient({ commitResponseError: true });
  const result = await applyRepair(client);
  assert.equal(result.commitResponseRecovered, true);
  assert.equal(result.postCommitVerified, true);
  assert.equal(queryEvents(client, 'ROLLBACK').length, 1);
  assert.equal(
    queryEvents(client, 'SELECT id, order_date, due_date, sales_person').length >= 1,
    true,
  );
});

test('normal COMMIT with failed fresh verification is rejected', async () => {
  const client = makeStatefulClient({
    freshReadTransform: () => [],
  });
  await assert.rejects(
    applyRepair(client),
    error => error?.code === 'POST_COMMIT_VERIFICATION_FAILED',
  );
  assert.equal(queryEvents(client, 'COMMIT').length, 1);
  assert.equal(queryEvents(client, 'ROLLBACK').length, 0);
});

test('ambiguous COMMIT with failed fresh verification is unverifiable', async () => {
  const client = makeStatefulClient({
    commitResponseError: true,
    freshReadTransform: () => [],
  });
  await assert.rejects(
    applyRepair(client),
    error => error?.code === 'COMMIT_OUTCOME_UNVERIFIED',
  );
  assert.equal(queryEvents(client, 'COMMIT').length, 1);
  assert.equal(queryEvents(client, 'ROLLBACK').length, 1);
});
