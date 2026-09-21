import { createHash, randomUUID } from 'node:crypto';
import {
  link,
  open,
  readFile,
  rename,
  unlink,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { neon } from '@neondatabase/serverless';

const EXPECTED_CORRECTION_ROWS = 31;
const POSTGRES_INTEGER_MAX = 2147483647;
const ACTOR = 'system:quantity-integrity-20260921';
const ACTION_BY_OPERATION = {
  apply: '수량정정',
  rollback: '수량정정롤백',
};
const RECEIPT_STATES_ALLOWED_FOR_ROLLBACK = new Set([
  'PREPARED',
  'COMMITTED_VERIFIED',
  'COMMITTED_VERIFICATION_FAILED',
]);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function isDatabaseQuantity(value) {
  return Number.isInteger(value) && value >= 1 && value <= POSTGRES_INTEGER_MAX;
}

function isTimestamp(value) {
  return typeof value === 'string' && value.trim() === value && Number.isFinite(Date.parse(value));
}

function canonicalVersionTimestamp(value, fieldName = 'version') {
  assert(typeof value === 'string', `${fieldName} must be an ISO timestamp string`);
  const parsed = new Date(value);
  assert(Number.isFinite(parsed.getTime()), `${fieldName} must be a valid ISO timestamp`);
  const canonical = parsed.toISOString();
  assert(value === canonical, `${fieldName} must be canonical UTC ISO format (${canonical})`);
  return canonical;
}

function activityDescription(operation, version, row) {
  const label = operation === 'apply' ? '정정' : '롤백';
  return `수량 무결성 ${label} [${version}] ${row.expectedQuantity} -> ${row.targetQuantity}; source_md5=${row.sourceUrlMd5}`;
}

function expectedActivity(operation, version) {
  return {
    actionType: ACTION_BY_OPERATION[operation],
    actor: ACTOR,
    createdAt: version,
  };
}

async function writeDurableTemporaryFile(targetPath, value) {
  const temporaryPath = `${targetPath}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporaryPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
    await handle.sync();
    await handle.close();
    handle = null;
    return temporaryPath;
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function syncParentDirectory(targetPath) {
  let handle;
  try {
    handle = await open(dirname(targetPath), 'r');
    await handle.sync();
  } catch (error) {
    if (!['EINVAL', 'EISDIR', 'ENOTSUP', 'EPERM'].includes(error?.code)) throw error;
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
}

async function cleanupTemporaryFile(path) {
  await unlink(path).catch((error) => {
    if (error?.code !== 'ENOENT') throw error;
  });
}

export const durableReceiptStore = {
  async create(path, value) {
    const targetPath = resolve(path);
    const temporaryPath = await writeDurableTemporaryFile(targetPath, value);
    try {
      await link(temporaryPath, targetPath);
      await syncParentDirectory(targetPath);
    } finally {
      await cleanupTemporaryFile(temporaryPath);
    }
  },

  async replace(path, value) {
    const targetPath = resolve(path);
    const temporaryPath = await writeDurableTemporaryFile(targetPath, value);
    try {
      await rename(temporaryPath, targetPath);
      await syncParentDirectory(targetPath);
    } catch (error) {
      await cleanupTemporaryFile(temporaryPath);
      throw error;
    }
  },
};

export function validateCorrectionManifest(manifest) {
  assert(manifest && typeof manifest === 'object', 'correction manifest is required');
  assert(Array.isArray(manifest.corrections), 'manifest.corrections must be an array');
  assert(
    manifest.corrections.length === EXPECTED_CORRECTION_ROWS,
    `correction manifest must contain exactly ${EXPECTED_CORRECTION_ROWS} rows`,
  );
  assert(
    manifest.correctionRows === EXPECTED_CORRECTION_ROWS,
    `manifest.correctionRows must equal ${EXPECTED_CORRECTION_ROWS}`,
  );

  const ids = new Set();
  let correctionDelta = 0;
  for (const row of manifest.corrections) {
    assert(Number.isInteger(row.id) && row.id > 0, 'each correction id must be a positive integer');
    assert(!ids.has(row.id), `duplicate correction id ${row.id}`);
    ids.add(row.id);
    assert(isDatabaseQuantity(row.oldQuantity), `oldQuantity is invalid for id ${row.id}`);
    assert(isDatabaseQuantity(row.verifiedQuantity), `verifiedQuantity is invalid for id ${row.id}`);
    assert(row.oldQuantity !== row.verifiedQuantity, `quantity is unchanged for id ${row.id}`);
    assert(
      row.delta === row.verifiedQuantity - row.oldQuantity,
      `delta is invalid for id ${row.id}`,
    );
    assert(/^[0-9a-f]{32}$/.test(row.sourceUrlMd5), `sourceUrlMd5 is invalid for id ${row.id}`);
    assert(isTimestamp(row.snapshotUpdatedAt), `snapshotUpdatedAt is required for id ${row.id}`);
    correctionDelta += row.delta;
  }

  assert(manifest.correctionDelta === correctionDelta, 'manifest correctionDelta is inconsistent');
  assert(
    manifest.projectedTotalAfterConfirmedCorrections === manifest.storedTotal + correctionDelta,
    'projectedTotalAfterConfirmedCorrections is inconsistent',
  );
  assert(
    manifest.sourceVerifiedUnitsAfterCorrections
      === manifest.projectedTotalAfterConfirmedCorrections - manifest.noSourceStoredUnits,
    'sourceVerifiedUnitsAfterCorrections is inconsistent with noSourceStoredUnits',
  );
  return manifest;
}

export function createPreparedApplyReceipt({ manifest, manifestSha256, applyVersion }) {
  validateCorrectionManifest(manifest);
  assert(/^[0-9a-f]{64}$/.test(manifestSha256), 'manifestSha256 must be a lowercase SHA-256');
  const version = canonicalVersionTimestamp(applyVersion, 'applyVersion');
  const activity = expectedActivity('apply', version);
  return {
    schemaVersion: 2,
    operation: 'apply',
    state: 'PREPARED',
    manifestSha256,
    correctionRows: EXPECTED_CORRECTION_ROWS,
    applyVersion: version,
    expectedActivity: activity,
    rows: manifest.corrections.map((row) => {
      const operationRow = {
        expectedQuantity: row.oldQuantity,
        targetQuantity: row.verifiedQuantity,
        sourceUrlMd5: row.sourceUrlMd5,
      };
      return {
        id: row.id,
        oldQuantity: row.oldQuantity,
        newQuantity: row.verifiedQuantity,
        sourceUrlMd5: row.sourceUrlMd5,
        snapshotUpdatedAt: row.snapshotUpdatedAt,
        postApplyUpdatedAt: version,
        expectedActivityDescription: activityDescription('apply', version, operationRow),
      };
    }),
  };
}

export function validateApplyReceipt(receipt, manifest) {
  assert(receipt && typeof receipt === 'object', 'apply receipt is required for rollback');
  assert(receipt.schemaVersion === 2, 'apply receipt schemaVersion must be 2');
  assert(receipt.operation === 'apply', 'rollback requires an apply receipt');
  assert(
    RECEIPT_STATES_ALLOWED_FOR_ROLLBACK.has(receipt.state),
    `receipt state ${receipt.state} is not rollback-capable`,
  );
  assert(receipt.correctionRows === EXPECTED_CORRECTION_ROWS, 'apply receipt must contain 31 rows');
  const applyVersion = canonicalVersionTimestamp(receipt.applyVersion, 'receipt.applyVersion');
  assert(receipt.expectedActivity?.actionType === ACTION_BY_OPERATION.apply, 'receipt apply action is invalid');
  assert(receipt.expectedActivity?.actor === ACTOR, 'receipt apply actor is invalid');
  assert(receipt.expectedActivity?.createdAt === applyVersion, 'receipt apply activity version is invalid');
  assert(Array.isArray(receipt.rows) && receipt.rows.length === EXPECTED_CORRECTION_ROWS, 'apply receipt rows must contain 31 rows');

  const correctionById = new Map(manifest.corrections.map((row) => [row.id, row]));
  const seen = new Set();
  for (const row of receipt.rows) {
    const correction = correctionById.get(row.id);
    assert(correction, `receipt contains unknown id ${row.id}`);
    assert(!seen.has(row.id), `receipt contains duplicate id ${row.id}`);
    seen.add(row.id);
    assert(row.oldQuantity === correction.oldQuantity, `receipt oldQuantity mismatch for id ${row.id}`);
    assert(row.newQuantity === correction.verifiedQuantity, `receipt newQuantity mismatch for id ${row.id}`);
    assert(row.sourceUrlMd5 === correction.sourceUrlMd5, `receipt source hash mismatch for id ${row.id}`);
    assert(row.snapshotUpdatedAt === correction.snapshotUpdatedAt, `receipt snapshot version mismatch for id ${row.id}`);
    assert(isTimestamp(row.postApplyUpdatedAt), `receipt postApplyUpdatedAt is invalid for id ${row.id}`);
    assert(
      Date.parse(row.postApplyUpdatedAt) === Date.parse(receipt.applyVersion),
      `receipt apply version mismatch for id ${row.id}`,
    );
    assert(
      row.expectedActivityDescription === activityDescription('apply', applyVersion, {
        expectedQuantity: correction.oldQuantity,
        targetQuantity: correction.verifiedQuantity,
        sourceUrlMd5: correction.sourceUrlMd5,
      }),
      `receipt activity identity mismatch for id ${row.id}`,
    );
  }
  return receipt;
}

function operationRows(operation, manifest, receipt) {
  if (operation === 'dry-run' || operation === 'apply') {
    return manifest.corrections.map((row) => ({
      id: row.id,
      expectedQuantity: row.oldQuantity,
      targetQuantity: row.verifiedQuantity,
      sourceUrlMd5: row.sourceUrlMd5,
      expectedUpdatedAt: row.snapshotUpdatedAt,
    }));
  }

  validateApplyReceipt(receipt, manifest);
  const receiptById = new Map(receipt.rows.map((row) => [row.id, row]));
  return manifest.corrections.map((row) => ({
    id: row.id,
    expectedQuantity: row.verifiedQuantity,
    targetQuantity: row.oldQuantity,
    sourceUrlMd5: row.sourceUrlMd5,
    expectedUpdatedAt: receiptById.get(row.id).postApplyUpdatedAt,
  }));
}

function manifestCte(rows) {
  const params = [];
  const values = rows.map((row) => {
    const offset = params.length;
    params.push(
      row.id,
      row.expectedQuantity,
      row.targetQuantity,
      row.sourceUrlMd5,
      row.expectedUpdatedAt,
    );
    return `($${offset + 1}::integer, $${offset + 2}::integer, $${offset + 3}::integer, $${offset + 4}::text, $${offset + 5}::text::timestamptz)`;
  });
  return {
    sql: `manifest(id, expected_quantity, target_quantity, source_url_md5, expected_updated_at) AS (VALUES\n  ${values.join(',\n  ')}\n)`,
    params,
  };
}

function statement(kind, sql, params, writes = false) {
  return {
    kind,
    writes,
    text: `/* quantity-integrity:${kind} */\n${sql}`,
    params,
  };
}

function buildSnapshotStatement(rows, forUpdate) {
  const params = rows.map((row) => row.id);
  const values = params.map((_, index) => `($${index + 1}::integer)`).join(', ');
  const kind = forUpdate ? 'lock' : 'snapshot';
  const suffix = forUpdate ? '\nFOR UPDATE OF o' : '';
  return statement(kind, `
    WITH target_ids(id) AS (VALUES ${values})
    SELECT o.id
    FROM orders AS o
    JOIN target_ids AS target ON target.id = o.id
    ORDER BY o.id${suffix}
  `, params);
}

function buildPreconditionStatement(rows) {
  const cte = manifestCte(rows);
  const expectedIndex = cte.params.length + 1;
  return statement('precondition', `
    WITH ${cte.sql},
    matched AS (
      SELECT COUNT(*)::integer AS matched_count
      FROM orders AS o
      JOIN manifest AS m ON m.id = o.id
      WHERE o.quantity = m.expected_quantity
        AND md5(COALESCE(o.work_order_image_url, '')) = m.source_url_md5
        AND o.updated_at = m.expected_updated_at
    )
    SELECT
      matched_count,
      $${expectedIndex}::integer AS expected_count,
      1 / CASE WHEN matched_count = $${expectedIndex}::integer THEN 1 ELSE 0 END AS cas_guard
    FROM matched
  `, [...cte.params, rows.length]);
}

function buildPreviewStatement(rows) {
  const cte = manifestCte(rows);
  return statement('preview', `
    WITH ${cte.sql}
    SELECT
      o.id,
      o.quantity AS expected_quantity,
      m.target_quantity,
      m.source_url_md5,
      m.expected_updated_at::text AS snapshot_updated_at
    FROM orders AS o
    JOIN manifest AS m ON m.id = o.id
    WHERE o.quantity = m.expected_quantity
      AND md5(COALESCE(o.work_order_image_url, '')) = m.source_url_md5
      AND o.updated_at = m.expected_updated_at
    ORDER BY o.id
  `, cte.params);
}

function buildUpdateStatement(rows, version) {
  const cte = manifestCte(rows);
  const versionIndex = cte.params.length + 1;
  return statement('update', `
    WITH ${cte.sql}
    UPDATE orders AS o
    SET quantity = m.target_quantity,
        updated_at = $${versionIndex}::text::timestamptz
    FROM manifest AS m
    WHERE o.id = m.id
      AND o.quantity = m.expected_quantity
      AND md5(COALESCE(o.work_order_image_url, '')) = m.source_url_md5
      AND o.updated_at = m.expected_updated_at
    RETURNING o.id, o.quantity, $${versionIndex}::text AS updated_at_version
  `, [...cte.params, version], true);
}

function descriptionSql(operation, versionPlaceholder) {
  const label = operation === 'apply' ? '정정' : '롤백';
  return `format('수량 무결성 ${label} [%s] %s -> %s; source_md5=%s', ${versionPlaceholder}::text, m.expected_quantity, m.target_quantity, m.source_url_md5)`;
}

function buildActivityStatement(rows, operation, version) {
  const cte = manifestCte(rows);
  const versionIndex = cte.params.length + 1;
  const actionIndex = versionIndex + 1;
  const actorIndex = actionIndex + 1;
  const versionPlaceholder = `$${versionIndex}`;
  return statement('activity', `
    WITH ${cte.sql}
    INSERT INTO activity_feed (order_id, action_type, description, actor, created_at)
    SELECT
      o.id,
      $${actionIndex}::text,
      ${descriptionSql(operation, versionPlaceholder)},
      $${actorIndex}::text,
      ${versionPlaceholder}::text::timestamptz
    FROM manifest AS m
    JOIN orders AS o ON o.id = m.id
    WHERE o.quantity = m.target_quantity
      AND md5(COALESCE(o.work_order_image_url, '')) = m.source_url_md5
      AND o.updated_at = ${versionPlaceholder}::text::timestamptz
    ORDER BY o.id
    RETURNING order_id, action_type, created_at
  `, [...cte.params, version, ACTION_BY_OPERATION[operation], ACTOR], true);
}

function buildPostconditionStatement(rows, operation, version) {
  const cte = manifestCte(rows);
  const versionIndex = cte.params.length + 1;
  const expectedIndex = versionIndex + 1;
  const actionIndex = expectedIndex + 1;
  const actorIndex = actionIndex + 1;
  const versionPlaceholder = `$${versionIndex}`;
  return statement('postcondition', `
    WITH ${cte.sql},
    order_check AS (
      SELECT COUNT(*)::integer AS order_count
      FROM orders AS o
      JOIN manifest AS m ON m.id = o.id
      WHERE o.quantity = m.target_quantity
        AND md5(COALESCE(o.work_order_image_url, '')) = m.source_url_md5
        AND o.updated_at = ${versionPlaceholder}::text::timestamptz
    ),
    activity_check AS (
      SELECT COUNT(*)::integer AS activity_count
      FROM activity_feed AS af
      JOIN manifest AS m ON m.id = af.order_id
      WHERE af.action_type = $${actionIndex}::text
        AND af.actor = $${actorIndex}::text
        AND af.created_at = ${versionPlaceholder}::text::timestamptz
        AND af.description = ${descriptionSql(operation, versionPlaceholder)}
    )
    SELECT
      order_count,
      activity_count,
      1 / CASE
        WHEN order_count = $${expectedIndex}::integer
         AND activity_count = $${expectedIndex}::integer
        THEN 1 ELSE 0
      END AS cas_guard
    FROM order_check, activity_check
  `, [
    ...cte.params,
    version,
    rows.length,
    ACTION_BY_OPERATION[operation],
    ACTOR,
  ]);
}

function buildFreshVerificationStatement(rows, operation, version) {
  const cte = manifestCte(rows);
  const versionIndex = cte.params.length + 1;
  const actionIndex = versionIndex + 1;
  const actorIndex = actionIndex + 1;
  const versionPlaceholder = `$${versionIndex}`;
  return statement('fresh-verification', `
    WITH ${cte.sql},
    order_check AS (
      SELECT COUNT(*)::integer AS order_count
      FROM orders AS o
      JOIN manifest AS m ON m.id = o.id
      WHERE o.quantity = m.target_quantity
        AND md5(COALESCE(o.work_order_image_url, '')) = m.source_url_md5
        AND o.updated_at = ${versionPlaceholder}::text::timestamptz
    ),
    activity_check AS (
      SELECT COUNT(*)::integer AS activity_count
      FROM activity_feed AS af
      JOIN manifest AS m ON m.id = af.order_id
      WHERE af.action_type = $${actionIndex}::text
        AND af.actor = $${actorIndex}::text
        AND af.created_at = ${versionPlaceholder}::text::timestamptz
        AND af.description = ${descriptionSql(operation, versionPlaceholder)}
    )
    SELECT order_count, activity_count
    FROM order_check, activity_check
  `, [
    ...cte.params,
    version,
    ACTION_BY_OPERATION[operation],
    ACTOR,
  ]);
}

export function buildCorrectionPlan({ operation, manifest, receipt, version }) {
  validateCorrectionManifest(manifest);
  assert(['dry-run', 'apply', 'rollback'].includes(operation), `unsupported operation ${operation}`);
  const rows = operationRows(operation, manifest, receipt);

  if (operation === 'dry-run') {
    return {
      operation,
      rows,
      options: { isolationLevel: 'Serializable', readOnly: true, deferrable: true },
      statements: [
        buildSnapshotStatement(rows, false),
        buildPreconditionStatement(rows),
        buildPreviewStatement(rows),
      ],
    };
  }

  const canonicalVersion = canonicalVersionTimestamp(version);
  if (operation === 'rollback') {
    const applyVersion = canonicalVersionTimestamp(receipt.applyVersion, 'receipt.applyVersion');
    assert(canonicalVersion !== applyVersion, 'rollback version must differ from apply version');
  }
  return {
    operation,
    rows,
    version: canonicalVersion,
    options: { isolationLevel: 'Serializable', readOnly: false, deferrable: false },
    statements: [
      buildSnapshotStatement(rows, true),
      buildPreconditionStatement(rows),
      buildUpdateStatement(rows, canonicalVersion),
      buildActivityStatement(rows, operation, canonicalVersion),
      buildPostconditionStatement(rows, operation, canonicalVersion),
    ],
  };
}

export async function runCorrectionOperation({ sql, operation, manifest, receipt, version }) {
  assert(sql && typeof sql.transaction === 'function', 'Neon sql.transaction client is required');
  const plan = buildCorrectionPlan({ operation, manifest, receipt, version });
  const results = await sql.transaction(
    (transactionSql) => plan.statements.map(({ text, params }) => transactionSql.query(text, params)),
    plan.options,
  );

  if (operation === 'dry-run') {
    const previewRows = results[2] || [];
    assert(previewRows.length === EXPECTED_CORRECTION_ROWS, 'dry-run did not verify exactly 31 rows');
    return {
      operation,
      verifiedRows: previewRows.length,
      writesPerformed: 0,
      projectedTotalAfterConfirmedCorrections: manifest.projectedTotalAfterConfirmedCorrections,
      sourceVerifiedUnitsAfterCorrections: manifest.sourceVerifiedUnitsAfterCorrections,
      noSourceStoredUnits: manifest.noSourceStoredUnits,
    };
  }

  const updatedRows = results[2] || [];
  const activityRows = results[3] || [];
  assert(updatedRows.length === EXPECTED_CORRECTION_ROWS, `${operation} did not update exactly 31 rows`);
  assert(activityRows.length === EXPECTED_CORRECTION_ROWS, `${operation} did not add exactly 31 activity rows`);
  const manifestById = new Map(manifest.corrections.map((row) => [row.id, row]));
  const rows = updatedRows.map((updated) => {
    const id = Number(updated.id);
    const correction = manifestById.get(id);
    assert(correction, `${operation} returned unknown id ${id}`);
    return {
      id,
      oldQuantity: correction.oldQuantity,
      newQuantity: correction.verifiedQuantity,
      sourceUrlMd5: correction.sourceUrlMd5,
      snapshotUpdatedAt: correction.snapshotUpdatedAt,
      postApplyUpdatedAt: operation === 'apply'
        ? String(updated.updated_at_version)
        : undefined,
      postRollbackUpdatedAt: operation === 'rollback'
        ? String(updated.updated_at_version)
        : undefined,
      expectedActivityDescription: operation === 'apply'
        ? activityDescription('apply', plan.version, {
          expectedQuantity: correction.oldQuantity,
          targetQuantity: correction.verifiedQuantity,
          sourceUrlMd5: correction.sourceUrlMd5,
        })
        : undefined,
    };
  }).sort((left, right) => left.id - right.id);

  return { operation, version: plan.version, updatedRows: rows.length, activityRows: activityRows.length, rows };
}

export async function verifyCommittedCorrection({
  sql,
  operation,
  manifest,
  receipt,
  version,
  verifiedAt = () => new Date().toISOString(),
}) {
  assert(sql && typeof sql.query === 'function', 'fresh Neon sql.query client is required');
  assert(['apply', 'rollback'].includes(operation), `unsupported verification operation ${operation}`);
  validateCorrectionManifest(manifest);
  const canonicalVersion = canonicalVersionTimestamp(version);
  const rows = operationRows(operation, manifest, receipt);
  const verificationStatement = buildFreshVerificationStatement(rows, operation, canonicalVersion);
  const queryResult = await sql.query(verificationStatement.text, verificationStatement.params);
  const record = Array.isArray(queryResult) ? queryResult[0] : queryResult?.rows?.[0];
  const orderRows = Number(record?.order_count);
  const activityRows = Number(record?.activity_count);
  return {
    operation,
    version: canonicalVersion,
    verifiedAt: canonicalVersionTimestamp(verifiedAt(), 'verifiedAt'),
    expectedRows: EXPECTED_CORRECTION_ROWS,
    orderRows,
    activityRows,
    verified: orderRows === EXPECTED_CORRECTION_ROWS && activityRows === EXPECTED_CORRECTION_ROWS,
  };
}

function failedFreshVerification(operation, version, error, verifiedAt) {
  return {
    operation,
    version,
    verifiedAt: canonicalVersionTimestamp(verifiedAt(), 'verifiedAt'),
    expectedRows: EXPECTED_CORRECTION_ROWS,
    orderRows: null,
    activityRows: null,
    verified: false,
    error: String(error?.message || error),
  };
}

function validateReceiptStore(receiptStore) {
  assert(receiptStore && typeof receiptStore.create === 'function', 'receiptStore.create is required');
  assert(receiptStore && typeof receiptStore.replace === 'function', 'receiptStore.replace is required');
}

async function freshVerification({
  sql,
  freshSqlFactory,
  operation,
  manifest,
  receipt,
  version,
  verifiedAt,
}) {
  assert(typeof freshSqlFactory === 'function', 'freshSqlFactory is required');
  const freshSql = await freshSqlFactory();
  assert(freshSql !== sql, 'post-commit verification requires a fresh independent database client');
  return verifyCommittedCorrection({
    sql: freshSql,
    operation,
    manifest,
    receipt,
    version,
    verifiedAt,
  });
}

async function replaceReceiptAfterDatabaseChange({ receiptStore, receiptPath, receipt, failureMessage }) {
  try {
    await receiptStore.replace(receiptPath, receipt);
  } catch (error) {
    throw new Error(`${failureMessage}: ${error?.message || error}. Do not retry the database operation; the durable receipt remains rollback-capable.`, {
      cause: error,
    });
  }
}

export async function applyCorrectionsWithReceipt({
  sql,
  freshSqlFactory,
  manifest,
  manifestSha256,
  version,
  receiptPath,
  receiptStore = durableReceiptStore,
  verifiedAt = () => new Date().toISOString(),
}) {
  validateReceiptStore(receiptStore);
  assert(receiptPath, 'receiptPath is required');
  const preparedReceipt = createPreparedApplyReceipt({
    manifest,
    manifestSha256,
    applyVersion: version,
  });
  try {
    await receiptStore.create(receiptPath, preparedReceipt);
  } catch (error) {
    throw new Error(`receipt prewrite failed; database transaction was not started: ${error?.message || error}`, {
      cause: error,
    });
  }

  const result = await runCorrectionOperation({
    sql,
    operation: 'apply',
    manifest,
    version: preparedReceipt.applyVersion,
  });

  let verification;
  try {
    verification = await freshVerification({
      sql,
      freshSqlFactory,
      operation: 'apply',
      manifest,
      receipt: preparedReceipt,
      version: preparedReceipt.applyVersion,
      verifiedAt,
    });
  } catch (error) {
    verification = failedFreshVerification('apply', preparedReceipt.applyVersion, error, verifiedAt);
  }

  const promotedReceipt = {
    ...preparedReceipt,
    state: verification.verified ? 'COMMITTED_VERIFIED' : 'COMMITTED_VERIFICATION_FAILED',
    applyVerification: verification,
  };
  await replaceReceiptAfterDatabaseChange({
    receiptStore,
    receiptPath,
    receipt: promotedReceipt,
    failureMessage: 'DB applied; receipt promotion failed',
  });
  if (!verification.verified) {
    throw new Error(
      `post-commit verification failure: expected 31 orders and 31 activities, got ${verification.orderRows ?? 'query error'} and ${verification.activityRows ?? 'query error'}; no automatic rollback was attempted`,
    );
  }
  return { ...result, receipt: promotedReceipt, verification };
}

export async function rollbackCorrectionsWithReceipt({
  sql,
  freshSqlFactory,
  manifest,
  receipt,
  version,
  receiptPath,
  receiptStore = durableReceiptStore,
  verifiedAt = () => new Date().toISOString(),
}) {
  validateReceiptStore(receiptStore);
  assert(receiptPath, 'receiptPath is required');
  validateApplyReceipt(receipt, manifest);
  const result = await runCorrectionOperation({
    sql,
    operation: 'rollback',
    manifest,
    receipt,
    version,
  });

  let verification;
  try {
    verification = await freshVerification({
      sql,
      freshSqlFactory,
      operation: 'rollback',
      manifest,
      receipt,
      version: result.version,
      verifiedAt,
    });
  } catch (error) {
    verification = failedFreshVerification('rollback', result.version, error, verifiedAt);
  }

  const promotedReceipt = {
    ...receipt,
    state: verification.verified ? 'ROLLED_BACK_VERIFIED' : 'ROLLBACK_VERIFICATION_FAILED',
    rollback: {
      version: result.version,
      expectedActivity: expectedActivity('rollback', result.version),
      verification,
    },
  };
  await replaceReceiptAfterDatabaseChange({
    receiptStore,
    receiptPath,
    receipt: promotedReceipt,
    failureMessage: 'DB rolled back; receipt promotion failed',
  });
  if (!verification.verified) {
    throw new Error(
      `post-rollback verification failure: expected 31 orders and 31 activities, got ${verification.orderRows ?? 'query error'} and ${verification.activityRows ?? 'query error'}; no automatic database action was attempted`,
    );
  }
  return { ...result, receipt: promotedReceipt, verification };
}

export async function runReadOnlyTransactionSmoke(sql) {
  assert(sql && typeof sql.transaction === 'function', 'Neon sql.transaction client is required');
  const [settings, counts] = await sql.transaction(
    (transactionSql) => [
      transactionSql.query(`
        SELECT
          current_setting('transaction_read_only') AS transaction_read_only,
          current_setting('transaction_isolation') AS transaction_isolation
      `),
      transactionSql.query('SELECT COUNT(*)::integer AS order_count FROM orders'),
    ],
    { isolationLevel: 'Serializable', readOnly: true, deferrable: true },
  );
  const readOnly = settings?.[0]?.transaction_read_only === 'on';
  assert(readOnly, 'Neon transaction smoke did not run read-only');
  return {
    driver: '@neondatabase/serverless',
    transactionApi: 'sql.transaction(callback, options)',
    transactionReadOnly: readOnly,
    transactionIsolation: settings[0].transaction_isolation,
    orderRows: Number(counts?.[0]?.order_count),
  };
}

function loadEnvValue(text, key) {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator < 1 || line.slice(0, separator).trim() !== key) continue;
    let value = line.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value;
  }
  return '';
}

function parseArguments(argv) {
  const [command, ...rest] = argv;
  const options = {};
  for (let index = 0; index < rest.length; index += 1) {
    const key = rest[index];
    assert(key.startsWith('--'), `unexpected argument ${key}`);
    const value = rest[index + 1];
    assert(value && !value.startsWith('--'), `missing value for ${key}`);
    options[key.slice(2)] = value;
    index += 1;
  }
  return { command, options };
}

async function loadJson(path) {
  const bytes = await readFile(path);
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function usage() {
  return [
    'Usage:',
    '  node scripts/quantity-corrections.js smoke --env <env-file>',
    '  node scripts/quantity-corrections.js dry-run --env <env-file> --manifest <manifest.json>',
    '  node scripts/quantity-corrections.js apply --env <env-file> --manifest <manifest.json> --apply-version <ISO> --receipt <receipt.json> --confirm apply-31-quantity-corrections',
    '  node scripts/quantity-corrections.js rollback --env <env-file> --manifest <manifest.json> --receipt <receipt.json> --rollback-version <ISO> --confirm rollback-31-quantity-corrections',
  ].join('\n');
}

async function main(argv) {
  const { command, options } = parseArguments(argv);
  assert(['smoke', 'dry-run', 'apply', 'rollback'].includes(command), usage());
  assert(options.env, '--env is required');
  const envText = await readFile(resolve(options.env), 'utf8');
  const databaseUrl = loadEnvValue(envText, 'POSTGRES_URL');
  assert(databaseUrl, 'POSTGRES_URL is unavailable in the supplied env file');
  const sql = neon(databaseUrl);

  if (command === 'smoke') {
    process.stdout.write(`${JSON.stringify(await runReadOnlyTransactionSmoke(sql), null, 2)}\n`);
    return;
  }

  assert(options.manifest, '--manifest is required');
  const manifestDocument = await loadJson(resolve(options.manifest));
  const manifest = validateCorrectionManifest(manifestDocument.value);
  if (command === 'dry-run') {
    process.stdout.write(`${JSON.stringify(await runCorrectionOperation({ sql, operation: command, manifest }), null, 2)}\n`);
    return;
  }

  if (command === 'apply') {
    assert(options.confirm === 'apply-31-quantity-corrections', 'apply confirmation token is missing');
    assert(options['apply-version'], '--apply-version is required');
    assert(options.receipt, '--receipt is required');
    const receiptPath = resolve(options.receipt);
    const result = await applyCorrectionsWithReceipt({
      sql,
      freshSqlFactory: () => neon(databaseUrl),
      manifest,
      manifestSha256: sha256(manifestDocument.bytes),
      version: options['apply-version'],
      receiptPath,
    });
    process.stdout.write(`${JSON.stringify({
      operation: result.operation,
      version: result.version,
      updatedRows: result.updatedRows,
      activityRows: result.activityRows,
      receiptState: result.receipt.state,
      verification: result.verification,
      receipt: receiptPath,
    }, null, 2)}\n`);
    return;
  }

  assert(options.confirm === 'rollback-31-quantity-corrections', 'rollback confirmation token is missing');
  assert(options['rollback-version'], '--rollback-version is required');
  assert(options.receipt, '--receipt is required');
  const receiptDocument = await loadJson(resolve(options.receipt));
  assert(
    receiptDocument.value.manifestSha256 === sha256(manifestDocument.bytes),
    'receipt does not belong to this exact manifest',
  );
  const result = await rollbackCorrectionsWithReceipt({
    sql,
    freshSqlFactory: () => neon(databaseUrl),
    manifest,
    receipt: receiptDocument.value,
    version: options['rollback-version'],
    receiptPath: resolve(options.receipt),
  });
  process.stdout.write(`${JSON.stringify({
    operation: result.operation,
    version: result.version,
    updatedRows: result.updatedRows,
    activityRows: result.activityRows,
    receiptState: result.receipt.state,
    verification: result.verification,
  }, null, 2)}\n`);
}

const isCli = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isCli) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
