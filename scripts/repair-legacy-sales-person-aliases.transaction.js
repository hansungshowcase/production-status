import { ALLOWED_SALES_PERSONS } from '../api/_lib/orderCreateInput.js';
import {
  COMPARE_AND_SET_SQL,
  LOCKED_PREFLIGHT_SQL,
  REPAIR_ORDER_IDS,
  SERVER_IDENTITY_SQL,
} from './repair-legacy-sales-person-aliases.constants.js';
import {
  RepairGuardError,
  assertExactTargetIds,
  assertLockedRowShape,
  assertServerIdentity,
  guard,
} from './repair-legacy-sales-person-aliases.guards.js';
import {
  buildRollbackManifest,
} from './repair-legacy-sales-person-aliases.manifest.js';
import {
  buildRepairPlan,
  buildSanitizedSummary,
} from './repair-legacy-sales-person-aliases.planning.js';

function assertPostflightRows(rows, plan) {
  assertExactTargetIds(rows);
  const planById = new Map(plan.map(item => [item.id, item]));

  for (const row of rows) {
    assertLockedRowShape(row);
    const expected = planById.get(row.id);
    guard(
      row.sales_person === expected.replacementSalesPerson
        && ALLOWED_SALES_PERSONS.includes(row.sales_person),
      'POSTFLIGHT_REPLACEMENT_MISMATCH',
      row.id,
    );
    guard(
      row.order_date === expected.preimage.order_date
        && row.due_date === expected.preimage.due_date
        && row.work_order_image_url === expected.preimage.work_order_image_url,
      'POSTFLIGHT_PREIMAGE_MISMATCH',
      row.id,
    );
  }
}

export async function runRepairTransaction({
  client,
  mode,
  expectedIdentity,
  writeRollbackManifest,
  readPostCommitRows,
}) {
  guard(mode === 'dry-run' || mode === 'apply', 'CLI_ARGUMENTS_INVALID');
  let transactionOpen = false;

  try {
    await client.query('BEGIN');
    transactionOpen = true;

    const identityResult = await client.query(SERVER_IDENTITY_SQL);
    guard(identityResult.rows?.length === 1, 'SERVER_IDENTITY_MISMATCH');
    assertServerIdentity(identityResult.rows[0], expectedIdentity);

    const lockedResult = await client.query(LOCKED_PREFLIGHT_SQL, [REPAIR_ORDER_IDS]);
    const plan = buildRepairPlan(lockedResult.rows);

    if (mode === 'dry-run') {
      await client.query('ROLLBACK');
      transactionOpen = false;
      return buildSanitizedSummary(mode, plan);
    }

    guard(typeof writeRollbackManifest === 'function', 'ROLLBACK_MANIFEST_REQUIRED');
    guard(typeof readPostCommitRows === 'function', 'POST_COMMIT_VERIFIER_REQUIRED');
    const rollbackManifestPath = await writeRollbackManifest(
      buildRollbackManifest(plan),
    );
    guard(
      typeof rollbackManifestPath === 'string' && rollbackManifestPath.length > 0,
      'ROLLBACK_MANIFEST_REQUIRED',
    );

    for (const repair of plan) {
      const updateResult = await client.query(COMPARE_AND_SET_SQL, [
        repair.replacementSalesPerson,
        repair.id,
        repair.originalSalesPerson,
      ]);
      guard(
        updateResult.rowCount === 1
          && updateResult.rows?.length === 1
          && updateResult.rows[0].id === repair.id,
        'COMPARE_AND_SET_FAILED',
        repair.id,
      );
    }

    const postflightResult = await client.query(
      LOCKED_PREFLIGHT_SQL,
      [REPAIR_ORDER_IDS],
    );
    assertPostflightRows(postflightResult.rows, plan);
    let commitResponseRecovered = false;
    try {
      await client.query('COMMIT');
      transactionOpen = false;
    } catch {
      try {
        await client.query('ROLLBACK');
      } catch {
        // A lost COMMIT response can leave no open transaction to roll back.
      }
      transactionOpen = false;
      commitResponseRecovered = true;
    }

    try {
      const committedRows = await readPostCommitRows();
      assertPostflightRows(committedRows, plan);
    } catch {
      throw new RepairGuardError(
        commitResponseRecovered
          ? 'COMMIT_OUTCOME_UNVERIFIED'
          : 'POST_COMMIT_VERIFICATION_FAILED',
      );
    }

    return {
      ...buildSanitizedSummary(mode, plan),
      rollbackManifestPath,
      postCommitVerified: true,
      ...(commitResponseRecovered ? { commitResponseRecovered: true } : {}),
    };
  } catch (error) {
    if (transactionOpen) {
      try {
        await client.query('ROLLBACK');
      } catch {
        // Preserve the original sanitized failure code.
      }
    }
    throw error;
  }
}
