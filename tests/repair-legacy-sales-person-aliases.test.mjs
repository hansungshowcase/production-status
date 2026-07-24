import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

const repairModuleUrl = new URL('../scripts/repair-legacy-sales-person-aliases.js', import.meta.url);
const repair = await import(repairModuleUrl).catch(() => ({}));

const NORMALIZER_ALIAS = '\uAE40\uBCF4\uC218';
const ROUTE_ALIAS = '\uC2E0\uC740\uC808';
const EXPECTED_IDENTITY = Object.freeze({
  database: 'expected_database',
  user: 'expected_user',
  neonProjectId: 'expected_neon_project',
});

function requiredFunction(name) {
  assert.equal(typeof repair[name], 'function', `${name} export must exist`);
  return repair[name];
}

function makeRow(id, overrides = {}) {
  return {
    id,
    order_date: '2026-07-01',
    due_date: '2026-07-31',
    sales_person: id % 2 === 0 ? NORMALIZER_ALIAS : ROUTE_ALIAS,
    work_order_image_url: `https://example.invalid/work-order-${id}.jpg`,
    id_type: 'integer',
    order_date_type: 'text',
    due_date_type: 'text',
    sales_person_type: 'text',
    work_order_image_url_type: 'text',
    ...overrides,
  };
}

function makeRows() {
  return [203, 204, 205, 206, 207, 208].map(id => makeRow(id));
}

function postflightRows(preflightRows, plan) {
  const replacements = new Map(plan.map(item => [item.id, item.replacementSalesPerson]));
  return preflightRows.map(row => ({
    ...row,
    sales_person: replacements.get(row.id),
  }));
}

function makeClient({
  preflightRows,
  afterRows = preflightRows,
  committedRows = afterRows,
  compareAndSetFailureId = null,
  commitResponseError = false,
}) {
  const events = [];
  let lockedSelectCount = 0;

  return {
    events,
    async query(sql, params = []) {
      const normalizedSql = String(sql).trim().replace(/\s+/g, ' ');
      events.push({ kind: 'query', sql: normalizedSql, params });

      if (normalizedSql === 'BEGIN') return { rows: [], rowCount: null };
      if (normalizedSql === 'ROLLBACK') return { rows: [], rowCount: null };
      if (normalizedSql === 'COMMIT') {
        if (commitResponseError) throw new Error('simulated lost COMMIT response');
        return { rows: [], rowCount: null };
      }
      if (normalizedSql.includes('current_database() AS database_name')) {
        return {
          rows: [{
            database_name: EXPECTED_IDENTITY.database,
            user_name: EXPECTED_IDENTITY.user,
            neon_project_id: EXPECTED_IDENTITY.neonProjectId,
          }],
          rowCount: 1,
        };
      }
      if (normalizedSql.includes('FROM orders')) {
        const rows = normalizedSql.includes('FOR UPDATE')
          ? (++lockedSelectCount === 1 ? preflightRows : afterRows)
          : committedRows;
        return { rows: structuredClone(rows), rowCount: rows.length };
      }
      if (normalizedSql.startsWith('UPDATE orders SET sales_person')) {
        const id = params[1];
        if (id === compareAndSetFailureId) return { rows: [], rowCount: 0 };
        return { rows: [{ id }], rowCount: 1 };
      }

      throw new Error('Unexpected SQL in repair test');
    },
  };
}

async function readPostCommitRows(client) {
  const result = await client.query(repair.POST_COMMIT_VERIFY_SQL, [repair.REPAIR_ORDER_IDS]);
  return result.rows;
}

function queryEvents(client, prefix) {
  return client.events.filter(event => event.kind === 'query' && event.sql.startsWith(prefix));
}

test('repair boundary contains only IDs 203 through 208 and the two approved fingerprints', () => {
  assert.deepEqual(repair.REPAIR_ORDER_IDS, [203, 204, 205, 206, 207, 208]);
  assert.equal(Object.isFrozen(repair.REPAIR_ORDER_IDS), true);
  assert.deepEqual(
    [...repair.APPROVED_ALIAS_FINGERPRINTS].sort(),
    ['c257f49e680b', 'fe0c69469f49'],
  );
});

test('CLI defaults to dry-run and requires an explicit, unambiguous apply flag', () => {
  const parseMode = requiredFunction('parseMode');

  assert.equal(parseMode([]), 'dry-run');
  assert.equal(parseMode(['--dry-run']), 'dry-run');
  assert.equal(parseMode(['--apply']), 'apply');
  assert.throws(() => parseMode(['--apply', '--dry-run']), { code: 'CLI_ARGUMENTS_INVALID' });
  assert.throws(() => parseMode(['--unknown']), { code: 'CLI_ARGUMENTS_INVALID' });
});

test('locked preflight SQL is bounded and update SQL changes only sales_person by compare-and-set', () => {
  assert.equal(typeof repair.LOCKED_PREFLIGHT_SQL, 'string');
  assert.match(repair.LOCKED_PREFLIGHT_SQL, /WHERE id = ANY\(\$1::integer\[\]\)/);
  assert.match(repair.LOCKED_PREFLIGHT_SQL, /ORDER BY id\s+FOR UPDATE/);
  assert.match(repair.LOCKED_PREFLIGHT_SQL, /pg_typeof\(sales_person\)::text AS sales_person_type/);
  assert.doesNotMatch(repair.LOCKED_PREFLIGHT_SQL, /client_name|notes|phone/i);
  assert.match(repair.POST_COMMIT_VERIFY_SQL, /WHERE id = ANY\(\$1::integer\[\]\)/);
  assert.doesNotMatch(repair.POST_COMMIT_VERIFY_SQL, /FOR UPDATE/);

  assert.equal(typeof repair.COMPARE_AND_SET_SQL, 'string');
  assert.match(repair.COMPARE_AND_SET_SQL, /^UPDATE orders\s+SET sales_person = \$1/m);
  assert.match(repair.COMPARE_AND_SET_SQL, /WHERE id = \$2\s+AND sales_person IS NOT DISTINCT FROM \$3/);
  assert.match(repair.COMPARE_AND_SET_SQL, /RETURNING id/);
  assert.doesNotMatch(repair.COMPARE_AND_SET_SQL, /(?:order_date|due_date|work_order_image_url)\s*=/);
});

test('preflight resolves both approved fingerprints through current source mappings', () => {
  const buildRepairPlan = requiredFunction('buildRepairPlan');
  const resolveCurrentSourceMapping = requiredFunction('resolveCurrentSourceMapping');
  const plan = buildRepairPlan(makeRows());

  assert.deepEqual(plan.map(item => item.id), [203, 204, 205, 206, 207, 208]);
  assert.deepEqual(
    [...new Set(plan.map(item => item.fingerprint))].sort(),
    ['c257f49e680b', 'fe0c69469f49'],
  );
  assert.equal(plan.every(item => repair.ALLOWED_SALES_PERSONS.includes(item.replacementSalesPerson)), true);
  assert.equal(plan.every(item => item.originalSalesPerson !== item.replacementSalesPerson), true);
  assert.equal(
    resolveCurrentSourceMapping(NORMALIZER_ALIAS, 'fe0c69469f49'),
    null,
  );
  assert.equal(
    resolveCurrentSourceMapping(ROUTE_ALIAS, 'c257f49e680b'),
    null,
  );
});

test('preflight rejects any ID, PostgreSQL type, image, or date predicate mismatch', () => {
  const buildRepairPlan = requiredFunction('buildRepairPlan');
  const cases = [
    ['TARGET_IDS_MISMATCH', rows => rows.map((row, index) => (
      index === 0 ? { ...row, id: 202 } : row
    ))],
    ['ROW_ID_TYPE_MISMATCH', rows => rows.map((row, index) => (
      index === 0 ? { ...row, id: String(row.id) } : row
    ))],
    ['POSTGRES_TYPE_MISMATCH', rows => rows.map((row, index) => (
      index === 0 ? { ...row, sales_person_type: 'character varying' } : row
    ))],
    ['IMAGE_REQUIRED', rows => rows.map((row, index) => (
      index === 0 ? { ...row, work_order_image_url: '   ' } : row
    ))],
    ['ORDER_DATE_INVALID', rows => rows.map((row, index) => (
      index === 0 ? { ...row, order_date: '2026-02-30' } : row
    ))],
    ['DUE_DATE_INVALID', rows => rows.map((row, index) => (
      index === 0 ? { ...row, due_date: '2026-04-31' } : row
    ))],
    ['DUE_DATE_BEFORE_ORDER_DATE', rows => rows.map((row, index) => (
      index === 0 ? { ...row, due_date: '2026-06-30' } : row
    ))],
  ];

  for (const [expectedCode, mutate] of cases) {
    assert.throws(
      () => buildRepairPlan(mutate(makeRows())),
      error => error?.code === expectedCode,
      expectedCode,
    );
  }
});

test('preflight rejects canonical, unapproved, or no-longer-mapped salesperson values', () => {
  const buildRepairPlan = requiredFunction('buildRepairPlan');

  assert.throws(
    () => buildRepairPlan(makeRows().map((row, index) => (
      index === 0 ? { ...row, sales_person: repair.ALLOWED_SALES_PERSONS[0] } : row
    ))),
    error => error?.code === 'ALREADY_CANONICAL',
  );
  assert.throws(
    () => buildRepairPlan(makeRows().map((row, index) => (
      index === 0 ? { ...row, sales_person: '\uD64D\uAE38\uB3D9' } : row
    ))),
    error => error?.code === 'ALIAS_FINGERPRINT_MISMATCH',
  );
  assert.throws(
    () => buildRepairPlan(makeRows(), { resolveSourceMapping: () => null }),
    error => error?.code === 'SOURCE_MAPPING_MISMATCH',
  );
});

test('sanitized result contains IDs, fingerprints, predicate results, and counts only', () => {
  const buildRepairPlan = requiredFunction('buildRepairPlan');
  const buildSanitizedSummary = requiredFunction('buildSanitizedSummary');
  const plan = buildRepairPlan(makeRows());
  const summaryJson = JSON.stringify(buildSanitizedSummary('dry-run', plan));

  assert.match(summaryJson, /"candidateCount":6/);
  assert.match(summaryJson, /"id":203/);
  assert.match(summaryJson, /"fingerprint":"c257f49e680b"/);
  assert.match(summaryJson, /"predicates"/);
  for (const item of plan) {
    assert.equal(summaryJson.includes(item.originalSalesPerson), false);
    assert.equal(summaryJson.includes(item.replacementSalesPerson), false);
  }
  assert.doesNotMatch(summaryJson, /client|customer|phone|secret|password/i);
});

test('dry-run performs a real transaction preflight and always rolls back without writes', async () => {
  const buildRepairPlan = requiredFunction('buildRepairPlan');
  const runRepairTransaction = requiredFunction('runRepairTransaction');
  const rows = makeRows();
  const plan = buildRepairPlan(rows);
  const client = makeClient({ preflightRows: rows, afterRows: postflightRows(rows, plan) });
  let manifestWrites = 0;

  const result = await runRepairTransaction({
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

test('apply records rollback preimages before six guarded updates and commits after postflight', async () => {
  const buildRepairPlan = requiredFunction('buildRepairPlan');
  const runRepairTransaction = requiredFunction('runRepairTransaction');
  const rows = makeRows();
  const plan = buildRepairPlan(rows);
  const client = makeClient({ preflightRows: rows, afterRows: postflightRows(rows, plan) });
  let manifest;
  let writerEventIndex = -1;

  const result = await runRepairTransaction({
    client,
    mode: 'apply',
    expectedIdentity: EXPECTED_IDENTITY,
    writeRollbackManifest: async (value) => {
      manifest = value;
      client.events.push({ kind: 'manifest-write' });
      writerEventIndex = client.events.length - 1;
      return 'restricted-manifest.json';
    },
    readPostCommitRows: () => readPostCommitRows(client),
  });

  const updates = queryEvents(client, 'UPDATE orders');
  const firstUpdateIndex = client.events.findIndex(event => event.sql?.startsWith('UPDATE orders'));
  assert.equal(manifest.rows.length, 6);
  assert.equal(manifest.rows.every(row => typeof row.originalSalesPerson === 'string'), true);
  assert.equal(manifest.rows.every(row => typeof row.replacementSalesPerson === 'string'), true);
  assert.equal(writerEventIndex < firstUpdateIndex, true);
  assert.equal(updates.length, 6);
  assert.equal(queryEvents(client, 'COMMIT').length, 1);
  assert.equal(queryEvents(client, 'ROLLBACK').length, 0);
  assert.equal(
    client.events.findIndex(event => event.sql?.startsWith('COMMIT'))
      < client.events.findIndex(event => (
        event.sql?.includes('FROM orders') && !event.sql.includes('FOR UPDATE')
      )),
    true,
  );
  assert.equal(result.mode, 'apply');
  assert.equal(result.rollbackManifestPath, 'restricted-manifest.json');
  assert.equal(result.postCommitVerified, true);
});

test('any compare-and-set mismatch rolls back the entire apply batch', async () => {
  const buildRepairPlan = requiredFunction('buildRepairPlan');
  const runRepairTransaction = requiredFunction('runRepairTransaction');
  const rows = makeRows();
  const plan = buildRepairPlan(rows);
  const client = makeClient({
    preflightRows: rows,
    afterRows: postflightRows(rows, plan),
    compareAndSetFailureId: 205,
  });

  await assert.rejects(
    runRepairTransaction({
      client,
      mode: 'apply',
      expectedIdentity: EXPECTED_IDENTITY,
      writeRollbackManifest: async () => 'restricted-manifest.json',
      readPostCommitRows: () => readPostCommitRows(client),
    }),
    error => error?.code === 'COMPARE_AND_SET_FAILED',
  );

  assert.equal(queryEvents(client, 'UPDATE orders').length, 3);
  assert.equal(queryEvents(client, 'COMMIT').length, 0);
  assert.equal(queryEvents(client, 'ROLLBACK').length, 1);
  assert.equal(client.events.at(-1).sql, 'ROLLBACK');
});

test('a postflight replacement mismatch rolls back before commit', async () => {
  const buildRepairPlan = requiredFunction('buildRepairPlan');
  const runRepairTransaction = requiredFunction('runRepairTransaction');
  const rows = makeRows();
  const plan = buildRepairPlan(rows);
  const afterRows = postflightRows(rows, plan);
  afterRows[0] = { ...afterRows[0], sales_person: rows[0].sales_person };
  const client = makeClient({ preflightRows: rows, afterRows });

  await assert.rejects(
    runRepairTransaction({
      client,
      mode: 'apply',
      expectedIdentity: EXPECTED_IDENTITY,
      writeRollbackManifest: async () => 'restricted-manifest.json',
      readPostCommitRows: () => readPostCommitRows(client),
    }),
    error => error?.code === 'POSTFLIGHT_REPLACEMENT_MISMATCH',
  );

  assert.equal(queryEvents(client, 'COMMIT').length, 0);
  assert.equal(queryEvents(client, 'ROLLBACK').length, 1);
  assert.equal(client.events.at(-1).sql, 'ROLLBACK');
});

test('a lost COMMIT response is accepted only after fresh committed-state verification', async () => {
  const buildRepairPlan = requiredFunction('buildRepairPlan');
  const runRepairTransaction = requiredFunction('runRepairTransaction');
  const rows = makeRows();
  const plan = buildRepairPlan(rows);
  const committedRows = postflightRows(rows, plan);
  const client = makeClient({
    preflightRows: rows,
    afterRows: committedRows,
    committedRows,
    commitResponseError: true,
  });

  const result = await runRepairTransaction({
    client,
    mode: 'apply',
    expectedIdentity: EXPECTED_IDENTITY,
    writeRollbackManifest: async () => 'restricted-manifest.json',
    readPostCommitRows: () => readPostCommitRows(client),
  });

  assert.equal(result.commitResponseRecovered, true);
  assert.equal(result.postCommitVerified, true);
  assert.equal(queryEvents(client, 'ROLLBACK').length, 1);
});

test('a failed locked preflight rolls back before manifest creation or mutation', async () => {
  const runRepairTransaction = requiredFunction('runRepairTransaction');
  const rows = makeRows();
  rows[0] = { ...rows[0], work_order_image_url: '' };
  const client = makeClient({ preflightRows: rows });
  let manifestWrites = 0;

  await assert.rejects(
    runRepairTransaction({
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
});

test('target identity requires the exact Vercel project and matching connection/server identities', () => {
  const assertLocalProjectTarget = requiredFunction('assertLocalProjectTarget');
  const assertConnectionTarget = requiredFunction('assertConnectionTarget');
  const assertServerIdentity = requiredFunction('assertServerIdentity');
  const connectionFingerprint = requiredFunction('connectionFingerprint');

  assertLocalProjectTarget({
    projects: [{
      directory: '.',
      id: 'prj_7URD4gLkA3qkeCne2xTwUDm9SMx1',
      name: 'production-status',
    }],
  });

  const connectionString = 'postgresql://expected_user:redacted@expected.example.invalid/expected_database';
  const env = {
    POSTGRES_URL: connectionString,
    PGHOST: 'expected.example.invalid',
    PGDATABASE: EXPECTED_IDENTITY.database,
    PGUSER: EXPECTED_IDENTITY.user,
    NEON_PROJECT_ID: EXPECTED_IDENTITY.neonProjectId,
  };
  const expectedFingerprint = connectionFingerprint({
    hostname: env.PGHOST,
    database: env.PGDATABASE,
    neonProjectId: env.NEON_PROJECT_ID,
  });
  const identity = assertConnectionTarget(env, { expectedFingerprint });
  assert.deepEqual(identity, EXPECTED_IDENTITY);
  assertServerIdentity({
    database_name: EXPECTED_IDENTITY.database,
    user_name: EXPECTED_IDENTITY.user,
    neon_project_id: EXPECTED_IDENTITY.neonProjectId,
  }, identity);

  assert.throws(
    () => assertServerIdentity({
      database_name: 'other_database',
      user_name: EXPECTED_IDENTITY.user,
      neon_project_id: EXPECTED_IDENTITY.neonProjectId,
    }, identity),
    error => error?.code === 'SERVER_IDENTITY_MISMATCH',
  );
});

test('rollback manifest is written outside the repository with restrictive permissions', async (t) => {
  const buildRepairPlan = requiredFunction('buildRepairPlan');
  const buildRollbackManifest = requiredFunction('buildRollbackManifest');
  const writeRestrictedRollbackManifest = requiredFunction('writeRestrictedRollbackManifest');
  const temporaryRoot = await mkdtemp(path.join(tmpdir(), 'production-status-alias-repair-'));
  const rollbackDirectory = path.join(temporaryRoot, 'restricted');
  const resolvedTemporaryRoot = path.resolve(temporaryRoot);
  const resolvedSystemTemp = path.resolve(tmpdir());
  assert.equal(
    resolvedTemporaryRoot === resolvedSystemTemp
      || resolvedTemporaryRoot.startsWith(`${resolvedSystemTemp}${path.sep}`),
    true,
  );
  t.after(async () => rm(temporaryRoot, { recursive: true, force: true }));

  const manifest = buildRollbackManifest(buildRepairPlan(makeRows()));
  const manifestPath = await writeRestrictedRollbackManifest(manifest, {
    repositoryRoot: process.cwd(),
    directory: rollbackDirectory,
    windowsPrivateRoot: temporaryRoot,
  });
  const saved = JSON.parse(await readFile(manifestPath, 'utf8'));
  const metadata = await stat(manifestPath);

  assert.equal(path.dirname(manifestPath), rollbackDirectory);
  assert.deepEqual(saved.rows.map(row => row.id), [203, 204, 205, 206, 207, 208]);
  assert.equal(saved.rows.every(row => typeof row.originalSalesPerson === 'string'), true);
  if (process.platform !== 'win32') {
    assert.equal(metadata.mode & 0o077, 0);
  }

  await assert.rejects(
    writeRestrictedRollbackManifest(manifest, {
      repositoryRoot: process.cwd(),
      directory: path.join(process.cwd(), '.repair-manifests'),
      windowsPrivateRoot: temporaryRoot,
    }),
    error => error?.code === 'ROLLBACK_PATH_NOT_RESTRICTED',
  );
  if (process.platform === 'win32') {
    await assert.rejects(
      writeRestrictedRollbackManifest(manifest, {
        repositoryRoot: process.cwd(),
        directory: path.join(tmpdir(), 'outside-private-repair-root'),
        windowsPrivateRoot: temporaryRoot,
      }),
      error => error?.code === 'ROLLBACK_PATH_NOT_RESTRICTED',
    );
  }
});
