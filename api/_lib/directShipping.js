import { kstTodayStr } from './notify.js';
import { ensureShippingSheetSyncSchema } from './shippingSheetSyncSchema.js';

async function defaultNotify(db, order) {
  const { maybeNotify } = await import('./notify.js');
  await maybeNotify(db, order, 'shipped');
}

export async function completeOrderShipping({
  db,
  orderId,
  actor,
  notify = defaultNotify,
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

  // 시트 기입을 이 요청 안에서 기다리지 않는다. 구글 왕복이 3~4초라 출고 버튼이 그만큼 느려지고,
  // 여러 건을 연달아 출고하면 Apps Script 락 경합으로 대기가 더 길어진다.
  // 잡은 위 CTE 에서 이미 큐에 들어갔으므로 sheet-sync 크론이 처리한다.

  return { status: 200, body: updatedOrder };
}
