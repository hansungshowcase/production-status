import assert from 'node:assert/strict';
import test from 'node:test';

import {
  EXPECTED_IDENTITY,
  makeRows,
  repair,
  requiredFunction,
} from './repair-legacy-sales-person-aliases-helper.mjs';

test('repair boundary contains only IDs 203 through 208 and one approved fingerprint', () => {
  assert.deepEqual(repair.REPAIR_ORDER_IDS, [203, 204, 205, 206, 207, 208]);
  assert.equal(Object.isFrozen(repair.REPAIR_ORDER_IDS), true);
  assert.deepEqual(
    [...repair.APPROVED_ALIAS_FINGERPRINTS].sort(),
    ['c257f49e680b'],
  );
});

test('CLI defaults to dry-run and requires one unambiguous apply flag', () => {
  const parseMode = requiredFunction('parseMode');
  assert.equal(parseMode([]), 'dry-run');
  assert.equal(parseMode(['--dry-run']), 'dry-run');
  assert.equal(parseMode(['--apply']), 'apply');
  assert.throws(() => parseMode(['--apply', '--dry-run']), {
    code: 'CLI_ARGUMENTS_INVALID',
  });
  assert.throws(() => parseMode(['--unknown']), {
    code: 'CLI_ARGUMENTS_INVALID',
  });
});

test('preflight is bounded and compare-and-set changes only sales_person', () => {
  assert.match(repair.LOCKED_PREFLIGHT_SQL, /WHERE id = ANY\(\$1::integer\[\]\)/);
  assert.match(repair.LOCKED_PREFLIGHT_SQL, /ORDER BY id\s+FOR UPDATE/);
  assert.match(
    repair.LOCKED_PREFLIGHT_SQL,
    /pg_typeof\(sales_person\)::text AS sales_person_type/,
  );
  assert.doesNotMatch(repair.LOCKED_PREFLIGHT_SQL, /client_name|notes|phone/i);
  assert.match(repair.POST_COMMIT_VERIFY_SQL, /WHERE id = ANY\(\$1::integer\[\]\)/);
  assert.doesNotMatch(repair.POST_COMMIT_VERIFY_SQL, /FOR UPDATE/);
  assert.match(repair.COMPARE_AND_SET_SQL, /^UPDATE orders\s+SET sales_person = \$1/m);
  assert.match(
    repair.COMPARE_AND_SET_SQL,
    /WHERE id = \$2\s+AND sales_person IS NOT DISTINCT FROM \$3/,
  );
  assert.match(repair.COMPARE_AND_SET_SQL, /RETURNING id/);
  assert.doesNotMatch(
    repair.COMPARE_AND_SET_SQL,
    /(?:order_date|due_date|work_order_image_url)\s*=/,
  );
});

test('preflight resolves the approved fingerprint through the current mapping', () => {
  const plan = requiredFunction('buildRepairPlan')(makeRows());
  assert.deepEqual(plan.map(item => item.id), [203, 204, 205, 206, 207, 208]);
  assert.deepEqual(
    [...new Set(plan.map(item => item.fingerprint))].sort(),
    ['c257f49e680b'],
  );
  assert.equal(
    plan.every(item => repair.ALLOWED_SALES_PERSONS.includes(
      item.replacementSalesPerson,
    )),
    true,
  );
  assert.equal(
    plan.every(item => item.originalSalesPerson !== item.replacementSalesPerson),
    true,
  );
});

test('preflight accepts only the approved replacement and rejects alternate mappings', () => {
  const buildRepairPlan = requiredFunction('buildRepairPlan');
  const plan = buildRepairPlan(makeRows());
  assert.equal(
    plan.length === 6
      && plan.every(item => item.replacementSalesPerson === repair.ALLOWED_SALES_PERSONS[1]),
    true,
  );

  assert.throws(
    () => buildRepairPlan(makeRows(), {
      resolveSourceMapping: () => repair.ALLOWED_SALES_PERSONS[0],
    }),
    error => error?.code === 'SOURCE_MAPPING_MISMATCH',
  );
  assert.throws(
    () => buildRepairPlan(makeRows().map((row, index) => (
      index === 0
        ? { ...row, sales_person: '\uC2E0\uC740\uC808' }
        : row
    ))),
    error => error?.code === 'ALIAS_FINGERPRINT_MISMATCH',
  );
});

test('preflight rejects any ID, type, image, or date predicate mismatch', () => {
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

test('preflight rejects canonical, unapproved, or no-longer-mapped values', () => {
  const buildRepairPlan = requiredFunction('buildRepairPlan');
  assert.throws(
    () => buildRepairPlan(makeRows().map((row, index) => (
      index === 0 ? { ...row, sales_person: repair.ALLOWED_SALES_PERSONS[0] } : row
    ))),
    error => error?.code === 'ALREADY_CANONICAL',
  );
  assert.throws(
    () => buildRepairPlan(makeRows().map((row, index) => (
      index === 0 ? { ...row, sales_person: 'not-approved' } : row
    ))),
    error => error?.code === 'ALIAS_FINGERPRINT_MISMATCH',
  );
  assert.throws(
    () => buildRepairPlan(makeRows(), { resolveSourceMapping: () => null }),
    error => error?.code === 'SOURCE_MAPPING_MISMATCH',
  );
});

test('sanitized result contains IDs, fingerprints, predicates, and counts only', () => {
  const plan = requiredFunction('buildRepairPlan')(makeRows());
  const summaryJson = JSON.stringify(
    requiredFunction('buildSanitizedSummary')('dry-run', plan),
  );
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

test('target identity requires exact local, connection, and server identities', () => {
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
  const env = {
    POSTGRES_URL: 'postgresql://expected_user:redacted@expected.example.invalid/expected_database',
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
