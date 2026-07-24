import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import {
  chmod,
  mkdir,
  open,
  readFile,
  realpath,
} from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import { Pool } from '@neondatabase/serverless';

import { ALERT_ROUTES } from '../api/_lib/alertRoutes.js';
import {
  ALLOWED_SALES_PERSONS,
  normalizeOrderMutationInput,
} from '../api/_lib/orderCreateInput.js';
import { isCanonicalCalendarDate } from '../src/utils/dateUtils.js';

export { ALLOWED_SALES_PERSONS };

const EXPECTED_VERCEL_PROJECT = Object.freeze({
  id: 'prj_7URD4gLkA3qkeCne2xTwUDm9SMx1',
  name: 'production-status',
});
const EXPECTED_CONNECTION_FINGERPRINT =
  'd94c168442a34bb238ee7e60ca5b22cecd26254818bcd314e6983470a9d73175';
const execFileAsync = promisify(execFile);

export const REPAIR_ORDER_IDS = Object.freeze([203, 204, 205, 206, 207, 208]);
export const APPROVED_ALIAS_FINGERPRINTS = Object.freeze([
  'c257f49e680b',
  'fe0c69469f49',
]);

const POSTGRES_TEXT_FIELDS = Object.freeze([
  'order_date',
  'due_date',
  'sales_person',
  'work_order_image_url',
]);

export const LOCKED_PREFLIGHT_SQL = `
  SELECT
    id,
    order_date,
    due_date,
    sales_person,
    work_order_image_url,
    pg_typeof(id)::text AS id_type,
    pg_typeof(order_date)::text AS order_date_type,
    pg_typeof(due_date)::text AS due_date_type,
    pg_typeof(sales_person)::text AS sales_person_type,
    pg_typeof(work_order_image_url)::text AS work_order_image_url_type
  FROM orders
  WHERE id = ANY($1::integer[])
  ORDER BY id
  FOR UPDATE
`;

export const POST_COMMIT_VERIFY_SQL = `
  SELECT
    id,
    order_date,
    due_date,
    sales_person,
    work_order_image_url,
    pg_typeof(id)::text AS id_type,
    pg_typeof(order_date)::text AS order_date_type,
    pg_typeof(due_date)::text AS due_date_type,
    pg_typeof(sales_person)::text AS sales_person_type,
    pg_typeof(work_order_image_url)::text AS work_order_image_url_type
  FROM orders
  WHERE id = ANY($1::integer[])
  ORDER BY id
`;

export const COMPARE_AND_SET_SQL = `UPDATE orders
  SET sales_person = $1
  WHERE id = $2
    AND sales_person IS NOT DISTINCT FROM $3
  RETURNING id`;

const SERVER_IDENTITY_SQL = `
  SELECT
    current_database() AS database_name,
    current_user AS user_name,
    current_setting('neon.project_id', true) AS neon_project_id
`;

export class RepairGuardError extends Error {
  constructor(code, orderId = null) {
    super(orderId === null ? code : `${code}:${orderId}`);
    this.name = 'RepairGuardError';
    this.code = code;
    this.orderId = orderId;
  }
}

function guard(condition, code, orderId = null) {
  if (!condition) throw new RepairGuardError(code, orderId);
}

export function parseMode(args) {
  if (args.length === 0 || (args.length === 1 && args[0] === '--dry-run')) {
    return 'dry-run';
  }
  if (args.length === 1 && args[0] === '--apply') return 'apply';
  throw new RepairGuardError('CLI_ARGUMENTS_INVALID');
}

export function connectionFingerprint({ hostname, database, neonProjectId }) {
  return createHash('sha256')
    .update([hostname, database, neonProjectId].join('|'))
    .digest('hex');
}

export function assertLocalProjectTarget(repoLink) {
  const linkedProject = repoLink?.projects?.find(({ directory }) => directory === '.');
  guard(
    linkedProject?.id === EXPECTED_VERCEL_PROJECT.id
      && linkedProject?.name === EXPECTED_VERCEL_PROJECT.name,
    'LOCAL_PROJECT_MISMATCH',
  );
}

export function assertConnectionTarget(
  env,
  { expectedFingerprint = EXPECTED_CONNECTION_FINGERPRINT } = {},
) {
  const expectedHost = env.PGHOST || env.POSTGRES_HOST;
  const expectedDatabase = env.PGDATABASE || env.POSTGRES_DATABASE;
  const expectedUser = env.PGUSER || env.POSTGRES_USER;
  const neonProjectId = env.NEON_PROJECT_ID;
  guard(
    Boolean(env.POSTGRES_URL)
      && Boolean(expectedHost)
      && Boolean(expectedDatabase)
      && Boolean(expectedUser)
      && Boolean(neonProjectId),
    'CONNECTION_IDENTITY_MISSING',
  );

  let connectionUrl;
  try {
    connectionUrl = new URL(env.POSTGRES_URL);
  } catch {
    throw new RepairGuardError('CONNECTION_URL_INVALID');
  }

  const database = decodeURIComponent(connectionUrl.pathname.replace(/^\//, ''));
  const user = decodeURIComponent(connectionUrl.username);
  guard(
    connectionUrl.hostname === expectedHost
      && database === expectedDatabase
      && user === expectedUser,
    'CONNECTION_IDENTITY_MISMATCH',
  );
  guard(
    connectionFingerprint({
      hostname: connectionUrl.hostname,
      database,
      neonProjectId,
    }) === expectedFingerprint,
    'CONNECTION_FINGERPRINT_MISMATCH',
  );

  return Object.freeze({ database, user, neonProjectId });
}

export function assertServerIdentity(row, expectedIdentity) {
  guard(
    row?.database_name === expectedIdentity.database
      && row?.user_name === expectedIdentity.user
      && Boolean(row?.neon_project_id)
      && row.neon_project_id === expectedIdentity.neonProjectId,
    'SERVER_IDENTITY_MISMATCH',
  );
}

function fingerprintAlias(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function resolveCurrentSourceMapping(currentValue, fingerprint = fingerprintAlias(currentValue)) {
  if (fingerprint === APPROVED_ALIAS_FINGERPRINTS[0]) {
    const normalized = normalizeOrderMutationInput({
      sales_person: currentValue,
    }).sales_person;
    return normalized !== currentValue && ALLOWED_SALES_PERSONS.includes(normalized)
      ? normalized
      : null;
  }

  if (
    fingerprint === APPROVED_ALIAS_FINGERPRINTS[1]
    && Object.hasOwn(ALERT_ROUTES, currentValue)
  ) {
    const route = ALERT_ROUTES[currentValue];
    const candidates = ALLOWED_SALES_PERSONS.filter(
      canonicalValue => ALERT_ROUTES[canonicalValue] === route,
    );
    return candidates.length === 1 ? candidates[0] : null;
  }

  return null;
}

function assertLockedRowShape(row) {
  guard(Number.isInteger(row?.id), 'ROW_ID_TYPE_MISMATCH');
  guard(row.id_type === 'integer', 'POSTGRES_TYPE_MISMATCH', row.id);
  for (const field of POSTGRES_TEXT_FIELDS) {
    guard(
      row[`${field}_type`] === 'text' && typeof row[field] === 'string',
      'POSTGRES_TYPE_MISMATCH',
      row.id,
    );
  }
  guard(row.work_order_image_url.trim().length > 0, 'IMAGE_REQUIRED', row.id);
  guard(isCanonicalCalendarDate(row.order_date), 'ORDER_DATE_INVALID', row.id);
  guard(isCanonicalCalendarDate(row.due_date), 'DUE_DATE_INVALID', row.id);
  guard(row.due_date >= row.order_date, 'DUE_DATE_BEFORE_ORDER_DATE', row.id);
}

function assertExactTargetIds(rows) {
  guard(Array.isArray(rows) && rows.length === REPAIR_ORDER_IDS.length, 'TARGET_IDS_MISMATCH');
  for (const row of rows) {
    guard(Number.isInteger(row?.id), 'ROW_ID_TYPE_MISMATCH');
  }
  const ids = rows.map(({ id }) => id).sort((left, right) => left - right);
  guard(
    ids.every((id, index) => id === REPAIR_ORDER_IDS[index]),
    'TARGET_IDS_MISMATCH',
  );
}

export function buildRepairPlan(
  rows,
  { resolveSourceMapping = resolveCurrentSourceMapping } = {},
) {
  assertExactTargetIds(rows);

  return [...rows]
    .sort((left, right) => left.id - right.id)
    .map((row) => {
      assertLockedRowShape(row);
      guard(
        !ALLOWED_SALES_PERSONS.includes(row.sales_person),
        'ALREADY_CANONICAL',
        row.id,
      );

      const fingerprint = fingerprintAlias(row.sales_person);
      guard(
        APPROVED_ALIAS_FINGERPRINTS.includes(fingerprint),
        'ALIAS_FINGERPRINT_MISMATCH',
        row.id,
      );

      const replacementSalesPerson = resolveSourceMapping(row.sales_person, fingerprint);
      guard(
        ALLOWED_SALES_PERSONS.includes(replacementSalesPerson)
          && replacementSalesPerson !== row.sales_person,
        'SOURCE_MAPPING_MISMATCH',
        row.id,
      );

      return Object.freeze({
        id: row.id,
        fingerprint,
        originalSalesPerson: row.sales_person,
        replacementSalesPerson,
        preimage: Object.freeze({
          order_date: row.order_date,
          due_date: row.due_date,
          work_order_image_url: row.work_order_image_url,
        }),
      });
    });
}

export function buildSanitizedSummary(mode, plan) {
  return {
    ok: true,
    mode,
    candidateCount: plan.length,
    rows: plan.map(({ id, fingerprint }) => ({ id, fingerprint })),
    predicates: {
      exactIds: true,
      postgresTypes: true,
      imageBacked: true,
      canonicalDates: true,
      approvedFingerprints: true,
      currentSourceMapping: true,
    },
  };
}

export function buildRollbackManifest(plan) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    target: EXPECTED_VERCEL_PROJECT,
    rows: plan.map(({
      id,
      fingerprint,
      originalSalesPerson,
      replacementSalesPerson,
    }) => ({
      id,
      fingerprint,
      originalSalesPerson,
      replacementSalesPerson,
    })),
  };
}

function isOutsideRepository(repositoryRoot, candidatePath) {
  const relative = path.relative(repositoryRoot, candidatePath);
  return relative === '..'
    || relative.startsWith(`..${path.sep}`)
    || path.isAbsolute(relative);
}

function isWithinDirectory(parentDirectory, candidatePath) {
  const relative = path.relative(parentDirectory, candidatePath);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function windowsPrivateManifestRoot(env) {
  guard(Boolean(env.LOCALAPPDATA), 'ROLLBACK_PRIVATE_ROOT_UNAVAILABLE');
  return path.join(
    env.LOCALAPPDATA,
    'production-status',
    'restricted-repair-manifests',
  );
}

async function restrictWindowsAcl(targetPath, { directory, env }) {
  guard(
    Boolean(env.USERDOMAIN) && Boolean(env.USERNAME),
    'ROLLBACK_OWNER_UNAVAILABLE',
  );
  const principal = `${env.USERDOMAIN}\\${env.USERNAME}`;
  const grant = directory ? `${principal}:(OI)(CI)F` : `${principal}:F`;
  try {
    await execFileAsync(
      'icacls.exe',
      [targetPath, '/inheritance:r', '/grant:r', grant],
      { windowsHide: true },
    );
    await execFileAsync(
      'icacls.exe',
      [targetPath, '/setowner', principal],
      { windowsHide: true },
    );
    const { stdout } = await execFileAsync(
      'icacls.exe',
      [targetPath],
      { windowsHide: true },
    );
    const normalizedAcl = stdout.toLowerCase();
    guard(
      normalizedAcl.includes(principal.toLowerCase())
        && !normalizedAcl.includes('everyone')
        && !normalizedAcl.includes('authenticated users')
        && !normalizedAcl.includes('builtin\\users'),
      'ROLLBACK_PERMISSIONS_UNVERIFIED',
    );
  } catch (error) {
    if (error instanceof RepairGuardError) throw error;
    throw new RepairGuardError('ROLLBACK_PERMISSIONS_UNVERIFIED');
  }
}

export async function writeRestrictedRollbackManifest(
  manifest,
  {
    repositoryRoot,
    directory,
    env = process.env,
    platform = process.platform,
    windowsPrivateRoot = platform === 'win32' ? windowsPrivateManifestRoot(env) : null,
  },
) {
  const resolvedRepository = path.resolve(repositoryRoot);
  const resolvedDirectory = path.resolve(
    directory
      ?? (platform === 'win32'
        ? windowsPrivateRoot
        : path.join(homedir(), '.production-status-repair-manifests')),
  );
  guard(
    isOutsideRepository(resolvedRepository, resolvedDirectory),
    'ROLLBACK_PATH_NOT_RESTRICTED',
  );
  if (platform === 'win32') {
    guard(
      isWithinDirectory(path.resolve(windowsPrivateRoot), resolvedDirectory),
      'ROLLBACK_PATH_NOT_RESTRICTED',
    );
  }

  await mkdir(resolvedDirectory, { recursive: true, mode: 0o700 });
  const [realRepository, realDirectory] = await Promise.all([
    realpath(resolvedRepository),
    realpath(resolvedDirectory),
  ]);
  guard(
    isOutsideRepository(realRepository, realDirectory),
    'ROLLBACK_PATH_NOT_RESTRICTED',
  );

  if (platform === 'win32') {
    guard(
      isWithinDirectory(await realpath(windowsPrivateRoot), realDirectory),
      'ROLLBACK_PATH_NOT_RESTRICTED',
    );
    await restrictWindowsAcl(realDirectory, { directory: true, env });
  } else {
    await chmod(realDirectory, 0o700);
  }
  const timestamp = manifest.createdAt.replace(/[:.]/g, '-');
  const manifestPath = path.join(
    realDirectory,
    `legacy-sales-aliases-${timestamp}-${randomUUID()}.json`,
  );
  const handle = await open(manifestPath, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  if (platform === 'win32') {
    await restrictWindowsAcl(manifestPath, { directory: false, env });
  } else {
    await chmod(manifestPath, 0o600);
  }
  return manifestPath;
}

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
    const rollbackManifestPath = await writeRollbackManifest(buildRollbackManifest(plan));
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

    const postflightResult = await client.query(LOCKED_PREFLIGHT_SQL, [REPAIR_ORDER_IDS]);
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

    let committedRows;
    try {
      committedRows = await readPostCommitRows();
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
