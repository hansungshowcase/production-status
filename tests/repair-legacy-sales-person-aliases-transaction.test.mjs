import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPECTED_IDENTITY,
  applyRepair,
  makeRows,
  makeStatefulClient,
  queryEvents,
  readPostCommitRows,
  repair,
  requiredFunction,
} from './repair-legacy-sales-person-aliases-helper.mjs';

test('dry-run uses a real transaction preflight and rolls back without writes', async () => {
  const client = makeStatefulClient();
  let manifestWrites = 0;
  const result = await requiredFunction('runRepairTransaction')({
    client,
    mode: 'dry-run',
    expectedIdentity: EXPECTED_IDENTITY,
    writeRollbackManifest: async () => {
      manifestWrites += 1;
      return 'unexpected';
    },
  });

  assert.equal(client.events[0].sql, 'BEGIN');
  assert.equal(client.events.at(-1).sql, 'ROLLBACK');
  assert.equal(queryEvents(client, 'UPDATE orders').length, 0);
  assert.equal(queryEvents(client, 'COMMIT').length, 0);
  assert.equal(manifestWrites, 0);
  assert.equal(result.mode, 'dry-run');
  assert.equal(result.candidateCount, 6);
});

test('apply writes rollback data before six real CAS mutations and postflight', async () => {
  const rows = makeRows();
  const plan = requiredFunction('buildRepairPlan')(rows);
  const client = makeStatefulClient({ initialRows: rows });
  let manifest;
  const result = await applyRepair(client, {
    writeRollbackManifest: async (value) => {
      manifest = value;
      client.events.push({ kind: 'manifest-write' });
      return 'restricted-manifest.json';
    },
  });

  const updates = queryEvents(client, 'UPDATE orders');
  const manifestIndex = client.events.findIndex(event => event.kind === 'manifest-write');
  const firstUpdateIndex = client.events.findIndex(event => (
    event.sql?.startsWith('UPDATE orders')
  ));
  const bindingChecks = updates.map((event, index) => ({
    replacementMatches: event.params[0] === plan[index].replacementSalesPerson,
    id: event.params[1],
    originalMatches: event.params[2] === plan[index].originalSalesPerson,
  }));

  assert.equal(manifest.rows.length, 6);
  assert.equal(manifestIndex < firstUpdateIndex, true);
  assert.deepEqual(bindingChecks, plan.map(item => ({
    replacementMatches: true,
    id: item.id,
    originalMatches: true,
  })));
  assert.equal(queryEvents(client, 'COMMIT').length, 1);
  assert.equal(queryEvents(client, 'ROLLBACK').length, 0);
  assert.equal(result.mode, 'apply');
  assert.equal(result.rollbackManifestPath, 'restricted-manifest.json');
  assert.equal(result.postCommitVerified, true);
});

test('any compare-and-set mismatch rolls back the entire apply batch', async () => {
  const client = makeStatefulClient({ compareAndSetFailureId: 205 });
  await assert.rejects(
    applyRepair(client),
    error => error?.code === 'COMPARE_AND_SET_FAILED' && error.orderId === 205,
  );
  assert.equal(queryEvents(client, 'UPDATE orders').length, 3);
  assert.equal(queryEvents(client, 'COMMIT').length, 0);
  assert.equal(queryEvents(client, 'ROLLBACK').length, 1);
  assert.equal(client.events.at(-1).sql, 'ROLLBACK');
});

test('CAS success with a wrong returned ID is rejected and rolled back', async () => {
  const client = makeStatefulClient({ wrongReturnedIdFor: 203 });
  await assert.rejects(
    applyRepair(client),
    error => error?.code === 'COMPARE_AND_SET_FAILED' && error.orderId === 203,
  );
  assert.equal(queryEvents(client, 'UPDATE orders').length, 1);
  assert.equal(queryEvents(client, 'COMMIT').length, 0);
  assert.equal(queryEvents(client, 'ROLLBACK').length, 1);
});

test('missing manifest writer, verifier, or written path fails before updates', async () => {
  const cases = [
    {
      expectedCode: 'ROLLBACK_MANIFEST_REQUIRED',
      overrides: {
        writeRollbackManifest: undefined,
        readPostCommitRows: () => [],
      },
    },
    {
      expectedCode: 'POST_COMMIT_VERIFIER_REQUIRED',
      overrides: {
        writeRollbackManifest: async () => 'restricted-manifest.json',
        readPostCommitRows: undefined,
      },
    },
    {
      expectedCode: 'ROLLBACK_MANIFEST_REQUIRED',
      overrides: {
        writeRollbackManifest: async () => '',
        readPostCommitRows: () => [],
      },
    },
  ];

  for (const { expectedCode, overrides } of cases) {
    const client = makeStatefulClient();
    await assert.rejects(
      requiredFunction('runRepairTransaction')({
        client,
        mode: 'apply',
        expectedIdentity: EXPECTED_IDENTITY,
        ...overrides,
      }),
      error => error?.code === expectedCode,
    );
    assert.equal(queryEvents(client, 'UPDATE orders').length, 0);
    assert.equal(queryEvents(client, 'ROLLBACK').length, 1);
  }
});

test('a failed locked preflight rolls back before manifest creation or mutation', async () => {
  const rows = makeRows();
  rows[0] = { ...rows[0], work_order_image_url: '' };
  const client = makeStatefulClient({ initialRows: rows });
  let manifestWrites = 0;
  await assert.rejects(
    requiredFunction('runRepairTransaction')({
      client,
      mode: 'apply',
      expectedIdentity: EXPECTED_IDENTITY,
      writeRollbackManifest: async () => {
        manifestWrites += 1;
        return 'unexpected';
      },
      readPostCommitRows: () => readPostCommitRows(client),
    }),
    error => error?.code === 'IMAGE_REQUIRED',
  );
  assert.equal(manifestWrites, 0);
  assert.equal(queryEvents(client, 'UPDATE orders').length, 0);
  assert.equal(queryEvents(client, 'ROLLBACK').length, 1);
  assert.deepEqual(repair.REPAIR_ORDER_IDS, [203, 204, 205, 206, 207, 208]);
});
