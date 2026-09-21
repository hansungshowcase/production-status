import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  applyCorrectionsWithReceipt,
  buildCorrectionPlan,
  createPreparedApplyReceipt,
  durableReceiptStore,
  rollbackCorrectionsWithReceipt,
  runCorrectionOperation,
  validateCorrectionManifest,
} from '../scripts/quantity-corrections.js';

const SNAPSHOT_VERSION = '2026-09-21T01:02:03.456Z';
const APPLY_VERSION = '2026-09-21T02:00:00.000Z';
const ROLLBACK_VERSION = '2026-09-21T03:00:00.000Z';

function fixtureManifest() {
  const corrections = Array.from({ length: 31 }, (_, index) => ({
    id: index + 1,
    oldQuantity: index === 0 ? 1340 : 2,
    verifiedQuantity: 1,
    delta: index === 0 ? -1339 : -1,
    sourceUrlMd5: String(index + 1).padStart(32, '0'),
    snapshotUpdatedAt: SNAPSHOT_VERSION,
  }));
  const correctionDelta = corrections.reduce((sum, row) => sum + row.delta, 0);
  const projectedTotalAfterConfirmedCorrections = 1943 + correctionDelta;
  return {
    correctionRows: corrections.length,
    storedTotal: 1943,
    correctionDelta,
    projectedTotalAfterConfirmedCorrections,
    sourceVerifiedUnitsAfterCorrections: projectedTotalAfterConfirmedCorrections - 5,
    noSourceStoredUnits: 5,
    corrections,
  };
}

function fixtureReceipt(manifest) {
  return createPreparedApplyReceipt({
    manifest,
    manifestSha256: 'a'.repeat(64),
    applyVersion: APPLY_VERSION,
  });
}

function expectedActivityDescription(actionType, version, row) {
  const label = actionType === '수량정정' ? '정정' : '롤백';
  return `수량 무결성 ${label} [${version}] ${row.expectedQuantity} -> ${row.targetQuantity}; source_md5=${row.sourceUrlMd5}`;
}

class MemoryReceiptStore {
  constructor({ failCreate = false, failReplace = false } = {}) {
    this.failCreate = failCreate;
    this.failReplace = failReplace;
    this.created = 0;
    this.replaced = 0;
    this.value = null;
  }

  async create(_path, value) {
    this.created += 1;
    if (this.failCreate) throw new Error('injected receipt prewrite failure');
    this.value = structuredClone(value);
  }

  async replace(_path, value) {
    this.replaced += 1;
    if (this.failReplace) throw new Error('injected receipt promotion failure');
    this.value = structuredClone(value);
  }
}

function freshVerificationClient({ orderCount = 31, activityCount = 31 } = {}) {
  return {
    calls: [],
    async query(text, params) {
      this.calls.push({ text, params });
      return [{ order_count: orderCount, activity_count: activityCount }];
    },
  };
}

test('durable receipt store atomically creates without overwrite and then replaces', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'quantity-receipt-'));
  const receiptPath = join(directory, 'receipt.json');
  try {
    await durableReceiptStore.create(receiptPath, { state: 'PREPARED', value: 1 });
    assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), { state: 'PREPARED', value: 1 });
    await assert.rejects(
      durableReceiptStore.create(receiptPath, { state: 'PREPARED', value: 2 }),
      /EEXIST|already exists/i,
    );
    assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), { state: 'PREPARED', value: 1 });

    await durableReceiptStore.replace(receiptPath, { state: 'COMMITTED_VERIFIED', value: 2 });
    assert.deepEqual(JSON.parse(await readFile(receiptPath, 'utf8')), {
      state: 'COMMITTED_VERIFIED',
      value: 2,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

function manifestRows(params, trailingCount) {
  const data = params.slice(0, params.length - trailingCount);
  assert.equal(data.length % 5, 0);
  const rows = [];
  for (let index = 0; index < data.length; index += 5) {
    rows.push({
      id: Number(data[index]),
      expectedQuantity: Number(data[index + 1]),
      targetQuantity: Number(data[index + 2]),
      sourceUrlMd5: data[index + 3],
      expectedUpdatedAt: data[index + 4],
    });
  }
  return rows;
}

class FakeNeonSql {
  constructor(manifest) {
    this.rows = new Map(manifest.corrections.map((row) => [row.id, {
      id: row.id,
      quantity: row.oldQuantity,
      sourceUrlMd5: row.sourceUrlMd5,
      updatedAt: row.snapshotUpdatedAt,
    }]));
    this.activities = [];
    this.transactions = [];
    this.failAt = null;
    this.tamperActivityDescriptionOrderId = null;
    this.lastPostcondition = null;
  }

  async transaction(buildQueries, options) {
    assert.equal(typeof buildQueries, 'function', 'real Neon transaction callback API is used');
    const queries = buildQueries({ query: (text, params) => ({ text, params }) });
    this.transactions.push({ options, kinds: queries.map(({ text }) => this.#kind(text)) });

    const draftRows = new Map([...this.rows].map(([id, row]) => [id, { ...row }]));
    const draftActivities = this.activities.map((activity) => ({ ...activity }));
    const results = [];

    for (const query of queries) {
      const kind = this.#kind(query.text);
      if (kind === this.failAt) throw new Error(`injected ${kind} failure`);
      results.push(this.#execute(kind, query.params, draftRows, draftActivities));
    }

    if (!options.readOnly) {
      this.rows = draftRows;
      this.activities = draftActivities;
    }
    return results;
  }

  #kind(text) {
    const match = text.match(/^\/\* quantity-integrity:([a-z-]+) \*\//);
    assert.ok(match, 'every query carries an executor operation marker');
    return match[1];
  }

  #execute(kind, params, rows, activities) {
    if (kind === 'lock' || kind === 'snapshot') {
      return params.filter((id) => rows.has(Number(id))).map((id) => ({ id: Number(id) }));
    }

    const trailingCount = {
      precondition: 1,
      preview: 0,
      update: 1,
      activity: 3,
      postcondition: 4,
    }[kind];
    const manifest = manifestRows(params, trailingCount);
    const matchesExpected = (row, item) => row
      && row.quantity === item.expectedQuantity
      && row.sourceUrlMd5 === item.sourceUrlMd5
      && row.updatedAt === item.expectedUpdatedAt;

    if (kind === 'precondition') {
      const expectedCount = Number(params.at(-1));
      const matchedCount = manifest.filter((item) => matchesExpected(rows.get(item.id), item)).length;
      if (matchedCount !== expectedCount) throw new Error('CAS precondition failed');
      return [{ matched_count: matchedCount, expected_count: expectedCount, cas_guard: 1 }];
    }

    if (kind === 'preview') {
      return manifest
        .filter((item) => matchesExpected(rows.get(item.id), item))
        .map((item) => ({ id: item.id, expected_quantity: item.expectedQuantity, target_quantity: item.targetQuantity }));
    }

    if (kind === 'update') {
      const version = params.at(-1);
      return manifest.flatMap((item) => {
        const row = rows.get(item.id);
        if (!matchesExpected(row, item)) return [];
        row.quantity = item.targetQuantity;
        row.updatedAt = version;
        return [{ id: item.id, quantity: row.quantity, updated_at_version: version }];
      });
    }

    if (kind === 'activity') {
      const [version, actionType, actor] = params.slice(-3);
      return manifest.flatMap((item) => {
        const row = rows.get(item.id);
        if (!row || row.quantity !== item.targetQuantity || row.updatedAt !== version) return [];
        const description = expectedActivityDescription(actionType, version, item);
        const activity = {
          order_id: item.id,
          action_type: actionType,
          actor,
          created_at: version,
          description: item.id === this.tamperActivityDescriptionOrderId
            ? `${description} [tampered]`
            : description,
        };
        activities.push(activity);
        return [activity];
      });
    }

    if (kind === 'postcondition') {
      const [version, expectedCount, actionType, actor] = params.slice(-4);
      const orderCount = manifest.filter((item) => {
        const row = rows.get(item.id);
        return row
          && row.quantity === item.targetQuantity
          && row.sourceUrlMd5 === item.sourceUrlMd5
          && row.updatedAt === version;
      }).length;
      const activityCount = activities.filter((activity) => (
        manifest.some((item) => (
          item.id === activity.order_id
          && activity.description === expectedActivityDescription(actionType, version, item)
        ))
        && activity.action_type === actionType
        && activity.actor === actor
        && activity.created_at === version
      )).length;
      this.lastPostcondition = { orderCount, activityCount };
      if (orderCount !== Number(expectedCount) || activityCount !== Number(expectedCount)) {
        throw new Error('CAS postcondition failed');
      }
      return [{ order_count: orderCount, activity_count: activityCount, cas_guard: 1 }];
    }

    throw new Error(`unexpected query kind ${kind}`);
  }
}

test('versioned manifest and plans require exactly 31 source-bound rows', () => {
  const manifest = fixtureManifest();
  assert.doesNotThrow(() => validateCorrectionManifest(manifest));
  assert.throws(
    () => validateCorrectionManifest({ ...manifest, corrections: manifest.corrections.slice(1) }),
    /31/,
  );
  assert.throws(
    () => validateCorrectionManifest({
      ...manifest,
      corrections: manifest.corrections.map((row, index) => (
        index === 0 ? { ...row, snapshotUpdatedAt: undefined } : row
      )),
    }),
    /snapshotUpdatedAt/,
  );

  const dryRunPlan = buildCorrectionPlan({ operation: 'dry-run', manifest });
  assert.equal(dryRunPlan.options.readOnly, true);
  assert.equal(dryRunPlan.statements.some((statement) => statement.writes), false);
  assert.deepEqual(dryRunPlan.statements.map(({ kind }) => kind), ['snapshot', 'precondition', 'preview']);

  const applyPlan = buildCorrectionPlan({ operation: 'apply', manifest, version: APPLY_VERSION });
  assert.equal(applyPlan.options.readOnly, false);
  assert.deepEqual(applyPlan.statements.map(({ kind }) => kind), [
    'lock', 'precondition', 'update', 'activity', 'postcondition',
  ]);
});

test('generated apply and rollback SQL type every timestamp version through canonical text first', () => {
  const manifest = fixtureManifest();
  const receipt = fixtureReceipt(manifest);
  const plans = [
    buildCorrectionPlan({ operation: 'apply', manifest, version: APPLY_VERSION }),
    buildCorrectionPlan({ operation: 'rollback', manifest, receipt, version: ROLLBACK_VERSION }),
  ];

  for (const plan of plans) {
    for (const statement of plan.statements.slice(1)) {
      assert.doesNotMatch(
        statement.text,
        /\$\d+::timestamptz/,
        `${plan.operation}/${statement.kind} must not let PostgreSQL type a version as timestamptz first`,
      );
    }
    const update = plan.statements.find(({ kind }) => kind === 'update');
    assert.match(update.text, /updated_at = \$\d+::text::timestamptz/);
    assert.match(update.text, /RETURNING o\.id, o\.quantity, \$\d+::text AS updated_at_version/);
    const activity = plan.statements.find(({ kind }) => kind === 'activity');
    assert.match(activity.text, /\$\d+::text::timestamptz/);
    const postcondition = plan.statements.find(({ kind }) => kind === 'postcondition');
    assert.match(postcondition.text, /\$\d+::text::timestamptz/);
  }
});

test('dry-run executes the same versioned CAS through Neon transaction without writes', async () => {
  const manifest = fixtureManifest();
  const sql = new FakeNeonSql(manifest);
  const before = structuredClone([...sql.rows]);

  const result = await runCorrectionOperation({ sql, operation: 'dry-run', manifest });

  assert.equal(result.verifiedRows, 31);
  assert.deepEqual([...sql.rows], before);
  assert.deepEqual(sql.activities, []);
  assert.deepEqual(sql.transactions[0].options, {
    isolationLevel: 'Serializable',
    readOnly: true,
    deferrable: true,
  });
});

test('apply aborts with zero writes when any quantity, source hash, or snapshot version mismatches', async (t) => {
  for (const mismatch of ['quantity', 'sourceUrlMd5', 'updatedAt']) {
    await t.test(mismatch, async () => {
      const manifest = fixtureManifest();
      const sql = new FakeNeonSql(manifest);
      sql.rows.get(7)[mismatch] = mismatch === 'quantity' ? 999 : `wrong-${mismatch}`;
      const before = structuredClone([...sql.rows]);

      await assert.rejects(
        runCorrectionOperation({ sql, operation: 'apply', manifest, version: APPLY_VERSION }),
        /CAS precondition failed/,
      );
      assert.deepEqual([...sql.rows], before);
      assert.deepEqual(sql.activities, []);
    });
  }
});

test('apply transaction rolls back quantity updates if atomic activity insertion fails', async () => {
  const manifest = fixtureManifest();
  const sql = new FakeNeonSql(manifest);
  sql.failAt = 'activity';
  const before = structuredClone([...sql.rows]);

  await assert.rejects(
    runCorrectionOperation({ sql, operation: 'apply', manifest, version: APPLY_VERSION }),
    /injected activity failure/,
  );

  assert.deepEqual([...sql.rows], before);
  assert.deepEqual(sql.activities, []);
});

test('apply captures deterministic post-apply versions and rollback never restores stale updated_at', async () => {
  const manifest = fixtureManifest();
  const sql = new FakeNeonSql(manifest);

  const applied = await runCorrectionOperation({
    sql,
    operation: 'apply',
    manifest,
    version: APPLY_VERSION,
  });
  assert.equal(applied.rows.length, 31);
  assert.ok(applied.rows.every((row) => row.postApplyUpdatedAt === APPLY_VERSION));
  assert.ok([...sql.rows.values()].every((row) => row.updatedAt === APPLY_VERSION));
  assert.equal(sql.activities.length, 31);
  const preparedReceipt = fixtureReceipt(manifest);
  for (const activity of sql.activities) {
    assert.equal(activity.created_at, APPLY_VERSION);
    assert.equal(
      activity.description,
      preparedReceipt.rows.find((row) => row.id === activity.order_id).expectedActivityDescription,
    );
  }

  const receipt = { ...preparedReceipt, rows: applied.rows };
  const rolledBack = await runCorrectionOperation({
    sql,
    operation: 'rollback',
    manifest,
    receipt,
    version: ROLLBACK_VERSION,
  });
  assert.equal(rolledBack.rows.length, 31);
  for (const correction of manifest.corrections) {
    const row = sql.rows.get(correction.id);
    assert.equal(row.quantity, correction.oldQuantity);
    assert.equal(row.updatedAt, ROLLBACK_VERSION);
    assert.notEqual(row.updatedAt, correction.snapshotUpdatedAt);
  }
  assert.equal(sql.activities.length, 62);
  for (const activity of sql.activities.slice(31)) {
    const correction = manifest.corrections.find((row) => row.id === activity.order_id);
    assert.equal(activity.created_at, ROLLBACK_VERSION);
    assert.equal(
      activity.description,
      expectedActivityDescription('수량정정롤백', ROLLBACK_VERSION, {
        expectedQuantity: correction.verifiedQuantity,
        targetQuantity: correction.oldQuantity,
        sourceUrlMd5: correction.sourceUrlMd5,
      }),
    );
  }
});

test('one tampered activity description produces 31 order matches, 30 activity matches, and atomic rollback', async () => {
  const manifest = fixtureManifest();
  const sql = new FakeNeonSql(manifest);
  sql.tamperActivityDescriptionOrderId = 7;
  const beforeRows = structuredClone([...sql.rows]);

  await assert.rejects(
    runCorrectionOperation({ sql, operation: 'apply', manifest, version: APPLY_VERSION }),
    /CAS postcondition failed/,
  );

  assert.deepEqual(sql.lastPostcondition, { orderCount: 31, activityCount: 30 });
  assert.deepEqual([...sql.rows], beforeRows);
  assert.deepEqual(sql.activities, []);
});

test('rollback CAS mismatch and post-update failure both leave all applied rows untouched', async (t) => {
  for (const setup of ['version-mismatch', 'activity-failure']) {
    await t.test(setup, async () => {
      const manifest = fixtureManifest();
      const sql = new FakeNeonSql(manifest);
      const applied = await runCorrectionOperation({
        sql,
        operation: 'apply',
        manifest,
        version: APPLY_VERSION,
      });
      const receipt = { ...fixtureReceipt(manifest), rows: applied.rows };
      if (setup === 'version-mismatch') sql.rows.get(5).updatedAt = '2026-09-21T02:30:00.000Z';
      if (setup === 'activity-failure') sql.failAt = 'activity';
      const beforeRows = structuredClone([...sql.rows]);
      const beforeActivities = structuredClone(sql.activities);

      await assert.rejects(
        runCorrectionOperation({
          sql,
          operation: 'rollback',
          manifest,
          receipt,
          version: ROLLBACK_VERSION,
        }),
        setup === 'version-mismatch' ? /CAS precondition failed/ : /injected activity failure/,
      );
      assert.deepEqual([...sql.rows], beforeRows);
      assert.deepEqual(sql.activities, beforeActivities);
    });
  }
});

test('apply receipt prewrite failure happens before the database transaction and leaves zero writes', async () => {
  const manifest = fixtureManifest();
  const sql = new FakeNeonSql(manifest);
  const receiptStore = new MemoryReceiptStore({ failCreate: true });
  let freshFactoryCalls = 0;

  await assert.rejects(
    applyCorrectionsWithReceipt({
      sql,
      freshSqlFactory: () => {
        freshFactoryCalls += 1;
        return freshVerificationClient();
      },
      manifest,
      manifestSha256: 'a'.repeat(64),
      version: APPLY_VERSION,
      receiptPath: 'private-receipt.json',
      receiptStore,
    }),
    /receipt prewrite failed.*database transaction was not started/i,
  );

  assert.equal(receiptStore.created, 1);
  assert.equal(sql.transactions.length, 0);
  assert.equal(freshFactoryCalls, 0);
  assert.deepEqual(sql.activities, []);
});

test('post-commit receipt promotion failure preserves a rollback-capable PREPARED receipt', async () => {
  const manifest = fixtureManifest();
  const sql = new FakeNeonSql(manifest);
  const freshSql = freshVerificationClient();
  const receiptStore = new MemoryReceiptStore({ failReplace: true });

  await assert.rejects(
    applyCorrectionsWithReceipt({
      sql,
      freshSqlFactory: () => freshSql,
      manifest,
      manifestSha256: 'a'.repeat(64),
      version: APPLY_VERSION,
      receiptPath: 'private-receipt.json',
      receiptStore,
    }),
    /DB applied; receipt promotion failed/,
  );

  assert.equal(sql.transactions.length, 1);
  assert.ok([...sql.rows.values()].every((row) => row.updatedAt === APPLY_VERSION));
  assert.equal(sql.activities.length, 31);
  assert.equal(freshSql.calls.length, 1);
  assert.equal(receiptStore.value.state, 'PREPARED');
  assert.equal(receiptStore.value.applyVersion, APPLY_VERSION);
  assert.equal(receiptStore.value.rows.length, 31);
  assert.ok(receiptStore.value.rows.every((row) => (
    Number.isInteger(row.oldQuantity)
    && Number.isInteger(row.newQuantity)
    && /^[0-9a-f]{32}$/.test(row.sourceUrlMd5)
    && row.snapshotUpdatedAt === SNAPSHOT_VERSION
    && row.postApplyUpdatedAt === APPLY_VERSION
    && row.expectedActivityDescription.includes(row.sourceUrlMd5)
  )));
});

test('apply performs fresh independent verification and records success or a loud mismatch without auto-rollback', async (t) => {
  await t.test('verified', async () => {
    const manifest = fixtureManifest();
    const sql = new FakeNeonSql(manifest);
    const freshSql = freshVerificationClient();
    const receiptStore = new MemoryReceiptStore();

    const result = await applyCorrectionsWithReceipt({
      sql,
      freshSqlFactory: () => freshSql,
      manifest,
      manifestSha256: 'a'.repeat(64),
      version: APPLY_VERSION,
      receiptPath: 'private-receipt.json',
      receiptStore,
      verifiedAt: () => '2026-09-21T02:01:00.000Z',
    });

    assert.equal(result.verification.verified, true);
    assert.equal(result.verification.orderRows, 31);
    assert.equal(result.verification.activityRows, 31);
    assert.equal(freshSql.calls.length, 1);
    assert.match(freshSql.calls[0].text, /quantity-integrity:fresh-verification/);
    assert.match(freshSql.calls[0].text, /md5\(COALESCE\(o\.work_order_image_url/);
    assert.doesNotMatch(freshSql.calls[0].text, /\$\d+::timestamptz/);
    assert.match(freshSql.calls[0].text, /\$\d+::text::timestamptz/);
    assert.equal(freshSql.calls[0].params.at(-3), APPLY_VERSION);
    assert.equal(receiptStore.value.state, 'COMMITTED_VERIFIED');
    assert.deepEqual(receiptStore.value.applyVerification, result.verification);
  });

  await t.test('mismatch', async () => {
    const manifest = fixtureManifest();
    const sql = new FakeNeonSql(manifest);
    const receiptStore = new MemoryReceiptStore();

    await assert.rejects(
      applyCorrectionsWithReceipt({
        sql,
        freshSqlFactory: () => freshVerificationClient({ orderCount: 30 }),
        manifest,
        manifestSha256: 'a'.repeat(64),
        version: APPLY_VERSION,
        receiptPath: 'private-receipt.json',
        receiptStore,
      }),
      /post-commit verification failure.*no automatic rollback/i,
    );

    assert.equal(receiptStore.value.state, 'COMMITTED_VERIFICATION_FAILED');
    assert.equal(receiptStore.value.applyVerification.verified, false);
    assert.ok([...sql.rows.values()].every((row) => row.updatedAt === APPLY_VERSION));
    assert.equal(sql.activities.length, 31);
  });
});

test('rollback performs fresh independent verification and records good and mismatch outcomes', async (t) => {
  for (const scenario of [
    { name: 'verified', orderCount: 31, expectedState: 'ROLLED_BACK_VERIFIED' },
    { name: 'mismatch', orderCount: 30, expectedState: 'ROLLBACK_VERIFICATION_FAILED' },
  ]) {
    await t.test(scenario.name, async () => {
      const manifest = fixtureManifest();
      const sql = new FakeNeonSql(manifest);
      const receipt = fixtureReceipt(manifest);
      await runCorrectionOperation({
        sql,
        operation: 'apply',
        manifest,
        version: APPLY_VERSION,
      });
      const receiptStore = new MemoryReceiptStore();
      receiptStore.value = structuredClone(receipt);
      const freshSql = freshVerificationClient({ orderCount: scenario.orderCount });

      const operation = rollbackCorrectionsWithReceipt({
        sql,
        freshSqlFactory: () => freshSql,
        manifest,
        receipt,
        version: ROLLBACK_VERSION,
        receiptPath: 'private-receipt.json',
        receiptStore,
      });
      if (scenario.orderCount === 31) {
        const result = await operation;
        assert.equal(result.verification.verified, true);
      } else {
        await assert.rejects(operation, /post-rollback verification failure/i);
      }

      assert.equal(freshSql.calls.length, 1);
      assert.equal(receiptStore.value.state, scenario.expectedState);
      assert.ok([...sql.rows.values()].every((row) => row.updatedAt === ROLLBACK_VERSION));
      assert.equal(sql.activities.length, 62);
    });
  }
});
