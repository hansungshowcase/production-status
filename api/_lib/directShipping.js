import { kstTodayStr } from './notify.js';
import { syncShippedOrderToSheet } from './shippingSheetSync.js';
import { ensureShippingSheetSyncSchema } from './shippingSheetSyncSchema.js';
import { SHIPPING_WEBHOOK_IMMEDIATE_TIMEOUT_MS } from './googleSheets.js';

async function defaultNotify(db, order) {
  const { maybeNotify } = await import('./notify.js');
  await maybeNotify(db, order, 'shipped');
}

export async function completeOrderShipping({
  db,
  orderId,
  actor,
  notify = defaultNotify,
  syncShippingSheet = syncShippedOrderToSheet,
}) {
  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
  const order = orderResult.rows[0];

  if (!order) {
    return { status: 404, body: { error: { message: '주문을 찾을 수 없습니다.', status: 404 } } };
  }

  if (order.status === 'shipped') {
    return { status: 400, body: { error: { message: '이미 출고 처리된 주문입니다.', status: 400 } } };
  }

  await ensureShippingSheetSyncSchema(db);
  const now = new Date().toISOString();
  const today = kstTodayStr();
  const { rows: updatedOrders } = await db.execute({
    sql: `WITH claimed_order AS (
            UPDATE orders
               SET status = 'shipped', ship_date = ?, updated_at = CURRENT_TIMESTAMP
             WHERE id = ? AND status != 'shipped'
             RETURNING *
          ),
          queued_sheet_sync AS (
            INSERT INTO sheet_shipping_sync_jobs (order_id, ship_date, status)
            SELECT id, ?, 'pending'
              FROM claimed_order
            ON CONFLICT (order_id) DO UPDATE
               SET ship_date = EXCLUDED.ship_date,
                   status = 'pending',
                   last_error = NULL,
                   last_attempt_at = NULL,
                   synced_at = NULL,
                   sheet_row = NULL,
                   updated_at = NOW()
             WHERE sheet_shipping_sync_jobs.status != 'synced'
                OR sheet_shipping_sync_jobs.ship_date IS DISTINCT FROM EXCLUDED.ship_date
            RETURNING order_id
          ),
          updated_shipping AS (
            UPDATE processes
               SET status = 'completed',
                   started_at = COALESCE(started_at, ?),
                   completed_at = COALESCE(completed_at, ?),
                   completed_date = COALESCE(completed_date, ?),
                   started_by = COALESCE(started_by, ?),
                   completed_by = COALESCE(completed_by, ?)
             WHERE order_id = (SELECT id FROM claimed_order)
               AND step_name = '출고'
             RETURNING id
          ),
          inserted_shipping AS (
            INSERT INTO processes (order_id, step_name, status, started_at, completed_at, completed_date, started_by, completed_by)
            SELECT id, '출고', 'completed', ?, ?, ?, ?, ?
              FROM claimed_order
             WHERE NOT EXISTS (SELECT 1 FROM updated_shipping)
             RETURNING id
          ),
          inserted_activity AS (
            INSERT INTO activity_feed (order_id, action_type, description, actor)
            SELECT id, '출고완료', CONCAT(COALESCE(client_name, ''), ' 주문이 출고 처리되었습니다.'), ?
              FROM claimed_order
             RETURNING id
          )
          SELECT * FROM claimed_order`,
    args: [
      today,
      orderId,
      today,
      now,
      now,
      today,
      actor,
      actor,
      now,
      now,
      today,
      actor,
      actor,
      actor,
    ],
  });

  if (updatedOrders.length === 0) {
    return { status: 400, body: { error: { message: '이미 출고 처리된 주문입니다.', status: 400 } } };
  }

  const updatedOrder = updatedOrders[0];
  try {
    await notify(db, updatedOrder);
  } catch (error) {
    console.error('[direct-shipping] 출고 알림 발송 실패(무시):', error?.message || error);
  }

  try {
    const syncResult = await syncShippingSheet(db, updatedOrder, { timeoutMs: SHIPPING_WEBHOOK_IMMEDIATE_TIMEOUT_MS });
    if (syncResult?.status !== 'synced' && !syncResult?.skipped) {
      console.warn(
        `[direct-shipping] shipping Sheet immediate sync failed for order ${updatedOrder.id} (${today}); job remains retryable:`,
        syncResult?.error || 'pending',
      );
    }
  } catch (error) {
    console.warn(
      `[direct-shipping] shipping Sheet immediate sync failed for order ${updatedOrder.id} (${today}); job remains retryable:`,
      error?.message || error,
    );
  }

  return { status: 200, body: updatedOrder };
}
