import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

import { Pool } from '@neondatabase/serverless';

import { ALLOWED_SALES_PERSONS } from '../api/_lib/orderCreateInput.js';
import {
  APPROVED_ALIAS_FINGERPRINTS,
  COMPARE_AND_SET_SQL,
  LOCKED_PREFLIGHT_SQL,
  POST_COMMIT_VERIFY_SQL,
  REPAIR_ORDER_IDS,
} from './repair-legacy-sales-person-aliases.constants.js';
import {
  RepairGuardError,
  assertConnectionTarget,
  assertLocalProjectTarget,
  assertServerIdentity,
  connectionFingerprint,
  parseMode,
} from './repair-legacy-sales-person-aliases.guards.js';
import {
  buildRollbackManifest,
  writeRestrictedRollbackManifest,
} from './repair-legacy-sales-person-aliases.manifest.js';
import {
  buildRepairPlan,
  buildSanitizedSummary,
  resolveCurrentSourceMapping,
} from './repair-legacy-sales-person-aliases.planning.js';
import {
  runRepairTransaction,
} from './repair-legacy-sales-person-aliases.transaction.js';

export {
  ALLOWED_SALES_PERSONS,
  APPROVED_ALIAS_FINGERPRINTS,
  COMPARE_AND_SET_SQL,
  LOCKED_PREFLIGHT_SQL,
  POST_COMMIT_VERIFY_SQL,
  REPAIR_ORDER_IDS,
  RepairGuardError,
  assertConnectionTarget,
  assertLocalProjectTarget,
  assertServerIdentity,
  buildRepairPlan,
  buildRollbackManifest,
  buildSanitizedSummary,
  connectionFingerprint,
  parseMode,
  resolveCurrentSourceMapping,
  runRepairTransaction,
  writeRestrictedRollbackManifest,
};

async function main() {
  const mode = parseMode(process.argv.slice(2));
  let repoLink;
  try {
    repoLink = JSON.parse(await readFile('.vercel/repo.json', 'utf8'));
  } catch {
    throw new RepairGuardError('LOCAL_PROJECT_LINK_UNAVAILABLE');
  }
  assertLocalProjectTarget(repoLink);
  const expectedIdentity = assertConnectionTarget(process.env);

  const pool = new Pool({
    connectionString: process.env.POSTGRES_URL,
    max: 2,
  });
  let client;
  try {
    client = await pool.connect();
    return await runRepairTransaction({
      client,
      mode,
      expectedIdentity,
      writeRollbackManifest: manifest => writeRestrictedRollbackManifest(manifest, {
        repositoryRoot: process.cwd(),
        directory: process.env.REPAIR_ROLLBACK_DIR,
      }),
      readPostCommitRows: async () => {
        const result = await pool.query(POST_COMMIT_VERIFY_SQL, [REPAIR_ORDER_IDS]);
        return result.rows;
      },
    });
  } finally {
    client?.release();
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then(result => console.log(JSON.stringify(result)))
    .catch((error) => {
      const code = error instanceof RepairGuardError
        ? error.code
        : 'REPAIR_EXECUTION_FAILED';
      const failure = {
        ok: false,
        code,
        ...(error instanceof RepairGuardError && error.orderId !== null
          ? { id: error.orderId }
          : {}),
      };
      console.error(JSON.stringify(failure));
      process.exitCode = 1;
    });
}
