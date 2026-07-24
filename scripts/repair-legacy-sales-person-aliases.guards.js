import { createHash } from 'node:crypto';

import { isCanonicalCalendarDate } from '../src/utils/dateUtils.js';
import {
  EXPECTED_CONNECTION_FINGERPRINT,
  EXPECTED_VERCEL_PROJECT,
  POSTGRES_TEXT_FIELDS,
  REPAIR_ORDER_IDS,
} from './repair-legacy-sales-person-aliases.constants.js';

export class RepairGuardError extends Error {
  constructor(code, orderId = null) {
    super(orderId === null ? code : `${code}:${orderId}`);
    this.name = 'RepairGuardError';
    this.code = code;
    this.orderId = orderId;
  }
}

export function guard(condition, code, orderId = null) {
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

export function fingerprintAlias(value) {
  return createHash('sha256').update(value).digest('hex').slice(0, 12);
}

export function assertLockedRowShape(row) {
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

export function assertExactTargetIds(rows) {
  guard(
    Array.isArray(rows) && rows.length === REPAIR_ORDER_IDS.length,
    'TARGET_IDS_MISMATCH',
  );
  for (const row of rows) {
    guard(Number.isInteger(row?.id), 'ROW_ID_TYPE_MISMATCH');
  }
  const ids = rows.map(({ id }) => id).sort((left, right) => left - right);
  guard(
    ids.every((id, index) => id === REPAIR_ORDER_IDS[index]),
    'TARGET_IDS_MISMATCH',
  );
}
