import { randomUUID } from 'node:crypto';
import { del } from '@vercel/blob';
import { deleteOrderFromSheet, probeSheetWebhook } from './googleSheets.js';

const BLOB_HOST = 'ggbhax5zgrdqymby.public.blob.vercel-storage.com';
const LEASE_SECONDS = 60;
const MAX_ATTEMPTS = 5;
const ERROR_LIMIT = 2000;
const BACKOFF_SECONDS = [300, 1800, 7200, 86400];
const JOB_DB_MARGIN_MS = 1000;

export function blobCleanupTargetKey(url) {
  return `blob:${String(url)}`;
}

export function sheetCleanupTargetKey(orderId) {
  return `sheet:order:${Number(orderId)}`;
}

function errorText(error) {
  return String(error?.message || error || 'external cleanup failed').slice(0, ERROR_LIMIT);
}

function isAllowedBlobUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && url.hostname === BLOB_HOST;
  } catch {
    return false;
  }
}

async function withTimeout(work, timeoutMs) {
  let timer;
  try {
    return await Promise.race([
      work(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('external cleanup timed out')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

async function claimJob(db, targetKey) {
  const leaseToken = randomUUID();
  const { rows } = await db.execute({
    sql: `UPDATE external_cleanup_jobs
             SET status = 'sending',
                 attempts = attempts + 1,
                 lease_token = ?,
                 leased_until = NOW() + (? * INTERVAL '1 second'),
                 last_error = NULL
           WHERE target_key = ?
             AND attempts < ?
             AND next_attempt_at <= NOW()
             AND (
               status IN ('pending', 'failed')
               OR (status = 'sending' AND leased_until <= NOW())
             )
           RETURNING *`,
    args: [leaseToken, LEASE_SECONDS, targetKey, MAX_ATTEMPTS],
  });
  return rows[0] || null;
}

async function finishJob(db, job, status, fields = {}) {
  const completed = status === 'completed';
  const { rows } = await db.execute({
    sql: `UPDATE external_cleanup_jobs
             SET status = ?,
                 last_error = ?,
                 completed_at = CASE WHEN ? = 1 THEN NOW() ELSE completed_at END,
                 lease_token = NULL,
                 leased_until = NULL
           WHERE id = ? AND status = 'sending' AND lease_token = ?
           RETURNING id`,
    args: [status, fields.error || null, completed ? 1 : 0, job.id, job.lease_token],
  });
  return rows.length > 0;
}

async function failJob(db, job, error) {
  const delay = BACKOFF_SECONDS[Math.min(job.attempts - 1, BACKOFF_SECONDS.length - 1)];
  const { rows } = await db.execute({
    sql: `UPDATE external_cleanup_jobs
             SET status = 'failed',
                 last_error = ?,
                 next_attempt_at = NOW() + (? * INTERVAL '1 second'),
                 lease_token = NULL,
                 leased_until = NULL
           WHERE id = ? AND status = 'sending' AND lease_token = ?
           RETURNING id`,
    args: [errorText(error), delay, job.id, job.lease_token],
  });
  return rows.length > 0;
}

async function blobIsReferenced(db, url) {
  const { rows } = await db.execute({
    sql: `SELECT EXISTS (
            SELECT 1 FROM photos WHERE file_path = ?
            UNION ALL
            SELECT 1 FROM orders WHERE work_order_image_url = ?
          ) AS referenced`,
    args: [url, url],
  });
  return rows[0]?.referenced === true;
}

export async function processExternalCleanupJob(db, targetKey, dependencies = {}) {
  const job = await claimJob(db, targetKey);
  if (!job) return { claimed: false };
  const deleteBlob = dependencies.deleteBlob || del;
  const probeSheet = dependencies.probeSheet || probeSheetWebhook;
  const deleteSheet = dependencies.deleteSheetOrder || deleteOrderFromSheet;
  const timeoutMs = Math.max(1000, Number(dependencies.timeoutMs) || 5000);

  try {
    if (job.kind === 'blob_delete') {
      const url = job.payload?.url;
      if (!isAllowedBlobUrl(url)) {
        await finishJob(db, job, 'held_host', { error: 'blob host is not allowed' });
        return { claimed: true, status: 'held_host' };
      }
      if (await blobIsReferenced(db, url)) {
        await finishJob(db, job, 'held_shared', { error: 'blob is still referenced' });
        return { claimed: true, status: 'held_shared' };
      }
      try {
        await withTimeout(() => deleteBlob(url), timeoutMs);
      } catch (error) {
        if (Number(error?.status || error?.statusCode) !== 404) throw error;
      }
    } else if (job.kind === 'sheet_delete') {
      const orderId = Number(job.payload?.orderId);
      if (!Number.isInteger(orderId) || orderId <= 0) {
        await finishJob(db, job, 'held_manual', { error: 'invalid sheet order id' });
        return { claimed: true, status: 'held_manual' };
      }
      const capability = await withTimeout(() => probeSheet(), timeoutMs);
      if (capability?.strictOrderId !== true || capability?.idColumn !== 44 || capability?.idSchema !== 'ar-v1') {
        await finishJob(db, job, 'held_manual', { error: 'strict order id delete is unavailable' });
        return { claimed: true, status: 'held_manual' };
      }
      try {
        await withTimeout(() => deleteSheet({ id: orderId }, { strictOrderId: true, timeoutMs }), timeoutMs);
      } catch (error) {
        if (error?.code !== 'SHEET_ID_UNRESOLVED') throw error;
        await finishJob(db, job, 'held_manual', { error: 'sheet order id requires reconciliation' });
        return { claimed: true, status: 'held_manual' };
      }
    } else {
      await finishJob(db, job, 'held_manual', { error: 'unsupported cleanup kind' });
      return { claimed: true, status: 'held_manual' };
    }

    const currentLease = await finishJob(db, job, 'completed');
    return { claimed: true, status: currentLease ? 'completed' : 'stale' };
  } catch (error) {
    const currentLease = await failJob(db, job, error);
    return { claimed: true, status: currentLease ? 'failed' : 'stale', error: errorText(error) };
  }
}

export async function runExternalCleanup(db, dependencies = {}) {
  const deadlineAt = Date.now() + Math.max(0, Number(dependencies.deadlineMs) || 25000);
  const jobTimeoutMs = Math.max(1000, Number(dependencies.timeoutMs) || 5000);
  const { rows } = await db.execute({
    sql: `SELECT target_key, kind
            FROM external_cleanup_jobs
           WHERE attempts < ?
             AND next_attempt_at <= NOW()
             AND (
               status IN ('pending', 'failed')
               OR (status = 'sending' AND leased_until <= NOW())
             )
           ORDER BY next_attempt_at, created_at, id
           LIMIT 50`,
    args: [MAX_ATTEMPTS],
  });
  const summary = { attempted: 0, completed: 0, failed: 0, held: 0 };
  let sheetCount = 0;
  let blobCount = 0;

  for (const row of rows) {
    const externalTimeoutCount = row.kind === 'sheet_delete' ? 2 : 1;
    const requiredBudgetMs = (jobTimeoutMs * externalTimeoutCount) + JOB_DB_MARGIN_MS;
    if (Date.now() + requiredBudgetMs > deadlineAt) continue;
    if (row.kind === 'sheet_delete' && sheetCount >= 1) continue;
    if (row.kind === 'blob_delete' && blobCount >= 4) continue;
    if (row.kind === 'sheet_delete') sheetCount += 1;
    if (row.kind === 'blob_delete') blobCount += 1;
    const result = await processExternalCleanupJob(db, row.target_key, dependencies);
    if (!result.claimed) continue;
    summary.attempted += 1;
    if (result.status === 'completed') summary.completed += 1;
    else if (String(result.status).startsWith('held_')) summary.held += 1;
    else if (result.status === 'failed') summary.failed += 1;
  }
  return summary;
}
