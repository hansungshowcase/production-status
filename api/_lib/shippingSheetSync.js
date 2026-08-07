import { markOrderShippedOnSheet } from './googleSheets.js';
import { ensureShippingSheetSyncSchema } from './shippingSheetSyncSchema.js';

const STALE_SENDING_INTERVAL = "INTERVAL '5 minutes'";
const WEBHOOK_ATTEMPT_BUDGET_MS = 15_000;
const JOB_STATE_WRITE_MARGIN_MS = 1_000;
const MINIMUM_JOB_BUDGET_MS = WEBHOOK_ATTEMPT_BUDGET_MS + JOB_STATE_WRITE_MARGIN_MS;

function errorMessage(error) {
  return String(error?.message || error || 'Unknown Google Sheets shipping synchronization error')
    .slice(0, 2000);
}

function normalizedOrderId(orderId) {
  const value = Number(orderId);
  return Number.isInteger(value) && value > 0 ? value : null;
}

// Postgres DATE 컬럼(sheet_shipping_sync_jobs.ship_date)은 Neon 드라이버가 JS Date 로 돌려준다.
// 시간대 없는 날짜를 UTC 자정으로 해석하므로 KST(UTC+9) 벽시계로 읽어야 원래 날짜가 나온다.
// (notify.js kstTodayStr() 과 동일한 +9h offset 방식 — '2026-08-03T15:00:00.000Z' → '2026-08-04')
function normalizedShipDate(shipDate) {
  if (typeof shipDate === 'string') {
    return /^\d{4}-\d{2}-\d{2}$/.test(shipDate) ? shipDate : null;
  }
  if (shipDate instanceof Date) {
    const time = shipDate.getTime();
    if (!Number.isFinite(time)) return null;
    return new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  }
  return null;
}

async function claimJob(db, orderId) {
  const { rows } = await db.execute({
    sql: `UPDATE sheet_shipping_sync_jobs
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
           RETURNING order_id, ship_date, status, attempts, last_attempt_at`,
    args: [orderId],
  });
  return rows[0] || null;
}

async function markSynced(db, orderId, claimedAttempt, updatedRow) {
  const { rows } = await db.execute({
    sql: `UPDATE sheet_shipping_sync_jobs
             SET status = 'synced',
                 last_error = NULL,
                 synced_at = NOW(),
                 sheet_row = ?,
                 updated_at = NOW()
           WHERE order_id = ?
             AND status = 'sending'
             AND attempts = ?
           RETURNING order_id`,
    args: [updatedRow, orderId, claimedAttempt],
  });
  if (rows.length === 0) {
    throw new Error('Shipping Sheet synchronization claim was lost before completion');
  }
}

async function markRetryable(db, orderId, claimedAttempt, status, error) {
  await db.execute({
    sql: `UPDATE sheet_shipping_sync_jobs
             SET status = ?,
                 last_error = ?,
                 updated_at = NOW()
           WHERE order_id = ?
             AND status = 'sending'
             AND attempts = ?
           RETURNING order_id`,
    args: [status, error, orderId, claimedAttempt],
  });
}

export async function enqueueShippingSheetSync(db, orderId, shipDate) {
  const validOrderId = normalizedOrderId(orderId);
  if (!validOrderId) {
    throw new Error('Invalid order ID for Google Sheets shipping synchronization');
  }
  const validShipDate = normalizedShipDate(shipDate);
  if (!validShipDate) {
    throw new Error('Invalid ship date for Google Sheets shipping synchronization');
  }

  await ensureShippingSheetSyncSchema(db);
  const { rows } = await db.execute({
    sql: `INSERT INTO sheet_shipping_sync_jobs (order_id, ship_date, status)
          VALUES (?, ?, 'pending')
          ON CONFLICT (order_id) DO UPDATE
             SET ship_date = sheet_shipping_sync_jobs.ship_date
          RETURNING order_id, ship_date, status, attempts, last_error, last_attempt_at,
                    synced_at, sheet_row, created_at, updated_at`,
    args: [validOrderId, validShipDate],
  });
  return rows[0] || null;
}

export async function syncShippedOrderToSheet(
  db,
  order,
  {
    markShipped = markOrderShippedOnSheet,
    failureStatus = 'pending',
    shipDate = order?.shipping_sheet_sync_ship_date ?? order?.ship_date,
  } = {},
) {
  const orderId = normalizedOrderId(order?.id);
  if (!orderId) {
    return { status: 'pending', error: 'Invalid order ID for Google Sheets shipping synchronization' };
  }
  const validShipDate = normalizedShipDate(shipDate);
  if (!validShipDate) {
    return { status: 'pending', error: 'Invalid ship date for Google Sheets shipping synchronization' };
  }

  try {
    await ensureShippingSheetSyncSchema(db);
  } catch (error) {
    return { status: 'pending', error: errorMessage(error) };
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
  const deliveryShipDate = normalizedShipDate(claimed.ship_date) || validShipDate;

  try {
    const result = await markShipped(order, deliveryShipDate);
    if (!Number.isInteger(result?.updatedRow) || result.updatedRow <= 0) {
      throw new Error('Google Sheets shipping update did not return a positive integer updatedRow');
    }
    await markSynced(db, orderId, claimed.attempts, result.updatedRow);
    return { status: 'synced', updatedRow: result.updatedRow };
  } catch (error) {
    const message = errorMessage(error);
    try {
      await markRetryable(
        db,
        orderId,
        claimed.attempts,
        failureStatus === 'failed' ? 'failed' : 'pending',
        message,
      );
    } catch (updateError) {
      console.warn('[shipping sheet sync] failed to persist retry state:', errorMessage(updateError));
    }
    return { status: 'pending', error: message };
  }
}

export async function retryPendingShippingSheetSync(
  db,
  { limit = 10, deadlineMs = 20_000, markShipped = markOrderShippedOnSheet } = {},
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

  await ensureShippingSheetSyncSchema(db);
  if (Date.now() >= deadlineAt) return summary;

  const { rows: orders } = await db.execute({
    sql: `SELECT o.*, j.ship_date AS shipping_sheet_sync_ship_date
            FROM sheet_shipping_sync_jobs j
            JOIN orders o ON o.id = j.order_id
           WHERE j.status IN ('pending', 'failed')
              OR (
                j.status = 'sending'
                AND (j.last_attempt_at IS NULL OR j.last_attempt_at <= NOW() - ${STALE_SENDING_INTERVAL})
              )
           ORDER BY j.created_at, j.order_id
           LIMIT ?`,
    args: [boundedLimit],
  });

  for (const order of orders) {
    if (deadlineAt - Date.now() < MINIMUM_JOB_BUDGET_MS) break;
    const result = await syncShippedOrderToSheet(db, order, {
      markShipped,
      failureStatus: 'failed',
      shipDate: order.shipping_sheet_sync_ship_date,
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
