import { appendOrderToSheet } from './googleSheets.js';

const STALE_SENDING_INTERVAL = "INTERVAL '5 minutes'";
const WEBHOOK_ATTEMPT_BUDGET_MS = 15_000;
const JOB_STATE_WRITE_MARGIN_MS = 1_000;
const MINIMUM_JOB_BUDGET_MS = WEBHOOK_ATTEMPT_BUDGET_MS + JOB_STATE_WRITE_MARGIN_MS;

// 출고 큐와 같은 이유. created_at 순으로만 뽑으면 영영 성공하지 못하는 오래된 잡이
// 매 실행마다 먼저 예산을 다 써버려 뒤의 정상 주문이 시트에 올라가지 못한다.
// 시도가 적은 것부터 처리하고, 한도를 넘긴 잡은 자동 재시도에서 빼되 지우지는 않는다.
const MAX_AUTO_ATTEMPTS = 10;

function errorMessage(error) {
  return String(error?.message || error || 'Unknown Google Sheets synchronization error').slice(0, 2000);
}

async function claimJob(db, orderId) {
  const { rows } = await db.execute({
    sql: `UPDATE sheet_sync_jobs
             SET status = 'sending',
                 attempts = attempts + 1,
                 last_error = NULL,
                 last_attempt_at = NOW(),
                 updated_at = NOW()
           WHERE order_id = ?
             AND (
               status IN ('pending', 'failed')
               OR (
                 status = 'sending'
                 AND (last_attempt_at IS NULL OR last_attempt_at <= NOW() - ${STALE_SENDING_INTERVAL})
               )
             )
           RETURNING order_id, status, attempts, last_attempt_at`,
    args: [orderId],
  });
  return rows[0] || null;
}

async function markSynced(db, orderId, row) {
  const { rows } = await db.execute({
    sql: `UPDATE sheet_sync_jobs
             SET status = 'synced',
                 last_error = NULL,
                 synced_at = NOW(),
                 sheet_row = ?,
                 updated_at = NOW()
           WHERE order_id = ?
             AND status = 'sending'
           RETURNING order_id`,
    args: [row, orderId],
  });
  if (rows.length === 0) {
    throw new Error('Sheet synchronization claim was lost before completion');
  }
}

async function markRetryable(db, orderId, status, error) {
  await db.execute({
    sql: `UPDATE sheet_sync_jobs
             SET status = ?,
                 last_error = ?,
                 updated_at = NOW()
           WHERE order_id = ?
             AND status = 'sending'
           RETURNING order_id`,
    args: [status, error, orderId],
  });
}

export async function syncOrderToSheet(
  db,
  order,
  { append = appendOrderToSheet, failureStatus = 'pending' } = {},
) {
  const orderId = Number(order?.id);
  if (!Number.isInteger(orderId) || orderId <= 0) {
    return { status: 'pending', error: 'Invalid order ID for Google Sheets synchronization' };
  }

  let claimed;
  try {
    claimed = await claimJob(db, orderId);
  } catch (error) {
    return { status: 'pending', error: errorMessage(error) };
  }
  if (!claimed) {
    return { status: 'pending', skipped: true };
  }

  try {
    const result = await append(order);
    if (!Number.isInteger(result?.row) || result.row <= 0) {
      throw new Error('Google Sheets append did not return a positive integer row');
    }
    await markSynced(db, orderId, result.row);
    return {
      status: 'synced',
      row: result.row,
      deduplicated: result.deduplicated === true,
    };
  } catch (error) {
    const message = errorMessage(error);
    try {
      await markRetryable(db, orderId, failureStatus === 'failed' ? 'failed' : 'pending', message);
    } catch (updateError) {
      console.warn('[sheet sync] failed to persist retry state:', errorMessage(updateError));
    }
    return { status: 'pending', error: message };
  }
}

export async function retryPendingSheetSync(
  db,
  { limit = 10, deadlineMs = 20_000, append = appendOrderToSheet } = {},
) {
  const boundedLimit = Math.max(1, Math.min(50, Number.parseInt(limit, 10) || 10));
  const boundedDeadlineMs = Math.max(0, Number(deadlineMs) || 0);
  const deadlineAt = Date.now() + boundedDeadlineMs;
  const summary = {
    attempted: 0,
    synced: 0,
    failed: 0,
    skipped: 0,
    errors: [],
  };

  if (Date.now() >= deadlineAt) return summary;

  const { rows: orders } = await db.execute({
    sql: `SELECT o.*
            FROM sheet_sync_jobs j
            JOIN orders o ON o.id = j.order_id
           WHERE j.attempts < ${MAX_AUTO_ATTEMPTS}
             AND (
               j.status IN ('pending', 'failed')
               OR (
                 j.status = 'sending'
                 AND (j.last_attempt_at IS NULL OR j.last_attempt_at <= NOW() - ${STALE_SENDING_INTERVAL})
               )
             )
           ORDER BY j.attempts, j.created_at, j.order_id
           LIMIT ?`,
    args: [boundedLimit],
  });

  for (const order of orders) {
    if (deadlineAt - Date.now() < MINIMUM_JOB_BUDGET_MS) break;
    const result = await syncOrderToSheet(db, order, {
      append,
      failureStatus: 'failed',
    });
    if (result.skipped) {
      summary.skipped += 1;
      continue;
    }

    summary.attempted += 1;
    if (result.status === 'synced') {
      summary.synced += 1;
    } else {
      summary.failed += 1;
      summary.errors.push(`order ${order.id}: ${result.error || 'sync failed'}`);
    }
  }

  return summary;
}
