import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { requireAuth, resolveActor } from '../../_lib/auth.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { STEPS } from '../../_lib/steps.js';
import { canShipFromSales } from '../../_lib/shippingPermission.js';

function isCanonicalStepCompleted(rows, stepName) {
  const matches = rows.filter((process) => process.step_name === stepName);
  return matches.length > 0 && matches.every((process) => process.status === 'completed');
}

export default cors(async function handler(req, res) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  if (!rateLimitCheck(req, res)) return;

  const auth = requireAuth(req, res, { roles: ['sales'] });
  if (!auth) return;

  const { id } = req.query;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }
  const db = getDb();

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
  const order = orderResult.rows[0];

  if (!order) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }

  if (order.status === 'shipped') {
    return res.status(400).json({ error: { message: '이미 출고 처리된 주문입니다.', status: 400 } });
  }

  const actor = resolveActor(req);
  if (!canShipFromSales(actor)) {
    return res.status(403).json({ error: { message: '이준형만 발주현황에서 출고 처리할 수 있습니다.', status: 403 } });
  }

  const { rows: processRows } = await db.execute({
    sql: 'SELECT id, step_name, status FROM processes WHERE order_id = ?',
    args: [id],
  });
  const shippingStep = '출고';
  const requiredSteps = STEPS.slice(0, STEPS.indexOf(shippingStep));
  const incompleteStep = requiredSteps.find((step) => !isCanonicalStepCompleted(processRows, step));
  if (incompleteStep && !canShipFromSales(actor)) {
    return res.status(400).json({
      error: {
        message: `${incompleteStep} 공정이 완료되어야 출고 처리할 수 있습니다.`,
        status: 400,
      },
    });
  }

  const today = new Date().toISOString().slice(0, 10);
  const shippingRows = processRows.filter((process) => process.step_name === shippingStep);
  if (shippingRows.length === 0) {
    await db.execute({
      sql: `INSERT INTO processes (order_id, step_name, status, started_at, completed_at, completed_date, started_by, completed_by)
            VALUES (?, ?, 'completed', ?, ?, ?, ?, ?)`,
      args: [id, shippingStep, new Date().toISOString(), new Date().toISOString(), today, actor, actor],
    });
  } else {
    const placeholders = shippingRows.map(() => '?').join(',');
    await db.execute({
      sql: `UPDATE processes
            SET status = 'completed',
                completed_at = COALESCE(completed_at, ?),
                completed_date = COALESCE(completed_date, ?),
                completed_by = COALESCE(completed_by, ?)
            WHERE id IN (${placeholders}) AND status != 'completed'`,
      args: [new Date().toISOString(), today, actor, ...shippingRows.map((process) => process.id)],
    });
  }

  await db.execute({
    sql: `UPDATE orders SET status = 'shipped', ship_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    args: [today, id],
  });

  const body = req.body || {};
  await db.execute({
    sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
    args: [
      order.id,
      '출고완료',
      `${order.client_name} 주문이 출고 처리되었습니다.`,
      actor,
    ],
  });

  const updatedResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
  const updatedOrder = updatedResult.rows[0];

  // 알림 훅: 출고 처리 → shipped (실패해도 본 응답에 영향 없음)
  try {
    const { maybeNotify } = await import('../../_lib/notify.js');
    await maybeNotify(db, updatedOrder || { ...order, status: 'shipped', ship_date: today }, 'shipped');
  } catch (e) {
    console.error('[ship] shipped 알림 발송 실패(무시):', e?.message || e);
  }

  return res.json(updatedOrder);
});
