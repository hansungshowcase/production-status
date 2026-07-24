import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { pickOwnAllowedFields, sanitizeInput } from '../../_lib/sanitize.js';
import { requireAuth, resolveActor } from '../../_lib/auth.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { del } from '@vercel/blob';
import { ensureOrderImageColumn } from '../../_lib/ensureSchema.js';
import { deleteOrderFromSheet } from '../../_lib/googleSheets.js';
import { STEPS } from '../../_lib/steps.js';
import {
  assertImageBackedOrderHasCanonicalOrderDate,
  assertImageBackedOrderHasCanonicalDueDate,
  assertImageBackedOrderHasClientName,
  assertImageBackedOrderHasPositiveQuantity,
  assertImageBackedOrderHasProductType,
  assertImageBackedOrderHasSalesPerson,
  mutationChangesImageOrderInvariant,
  mutationTouchesImageDueInvariant,
  normalizeOrderMutationInput,
  OrderCreateInputValidationError,
} from '../../_lib/orderCreateInput.js';

// status/ship_date는 비즈니스 로직(ship.js, processes/start/complete) 통해서만 변경
// 직접 PATCH 차단 (공정 미완료에도 'shipped' 변경되는 우회 방지)
const ORDER_FIELDS = [
  'order_date', 'due_date', 'sales_person', 'client_name',
  'sale_amount', 'lead_source', 'balance',
  'phone', 'delivery_address', 'freight_payment', 'product_type', 'door_type', 'design',
  'width', 'depth', 'height', 'quantity', 'color',
  'notes', 'remarks', 'etc_notes', 'ship_scheduled_date',
  'sms_sent', 'safe_delivery', 'work_order_image_url',
];

function stepOrderCase(alias) {
  const clauses = STEPS.map((step, index) => `WHEN '${String(step).replace(/'/g, "''")}' THEN ${index}`).join(' ');
  return `CASE ${alias}.step_name ${clauses} ELSE 999 END`;
}

export default cors(async function handler(req, res) {
  const { id } = req.query;

  if (req.method === 'GET') {
    return handleGet(id, req, res);
  } else if (req.method === 'PUT') {
    if (!rateLimitCheck(req, res)) return;
    return handleUpdate(id, req, res);
  } else if (req.method === 'PATCH') {
    if (!rateLimitCheck(req, res)) return;
    return handleUpdate(id, req, res);
  } else if (req.method === 'DELETE') {
    if (!rateLimitCheck(req, res)) return;
    return handleDelete(id, req, res);
  } else {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
});

async function handleGet(id, req, res) {
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }
  const db = getDb();
  await ensureOrderImageColumn(db);

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
  const order = orderResult.rows[0];

  if (!order) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }

  const [processesResult, preProdResult, issuesResult, photosResult] = await Promise.all([
    db.execute({ sql: `SELECT * FROM processes p WHERE order_id = ? ORDER BY ${stepOrderCase('p')}, id`, args: [order.id] }),
    db.execute({ sql: 'SELECT * FROM pre_production WHERE order_id = ?', args: [order.id] }),
    db.execute({ sql: 'SELECT * FROM issues WHERE order_id = ? ORDER BY reported_at DESC', args: [order.id] }),
    db.execute({ sql: 'SELECT * FROM photos WHERE order_id = ? ORDER BY uploaded_at DESC', args: [order.id] }),
  ]);

  return res.json({
    ...order,
    processes: processesResult.rows,
    pre_production: preProdResult.rows[0] || null,
    issues: issuesResult.rows,
    photos: photosResult.rows,
  });
}

async function handleUpdate(id, req, res) {
  const auth = requireAuth(req, res, { roles: ['sales'] });
  if (!auth) return;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }
  const db = getDb();
  await ensureOrderImageColumn(db);
  const normalizedBody = normalizeOrderMutationInput(sanitizeInput(req.body));
  const mutation = pickOwnAllowedFields(normalizedBody, ORDER_FIELDS);

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
  const order = orderResult.rows[0];

  if (!order) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }

  const updates = [];
  const values = [];

  for (const [field, value] of Object.entries(mutation)) {
    updates.push(`${field} = ?`);
    values.push(value);
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: { message: '수정할 필드가 없습니다.', status: 400 } });
  }

  const guardInvariantState = mutationTouchesImageDueInvariant(mutation);
  const validateInvariantState = mutationChangesImageOrderInvariant(order, mutation);
  if (validateInvariantState) {
    try {
      assertImageBackedOrderHasClientName({ ...order, ...mutation });
      assertImageBackedOrderHasCanonicalOrderDate({ ...order, ...mutation });
      assertImageBackedOrderHasCanonicalDueDate({ ...order, ...mutation });
      assertImageBackedOrderHasSalesPerson({ ...order, ...mutation });
      assertImageBackedOrderHasProductType({ ...order, ...mutation });
      assertImageBackedOrderHasPositiveQuantity({ ...order, ...mutation });
    } catch (err) {
      if (err instanceof OrderCreateInputValidationError) {
        return res.status(400).json({ error: { message: err.message, status: 400 } });
      }
      throw err;
    }
  }

  updates.push("updated_at = CURRENT_TIMESTAMP");

  const invariantWhere = guardInvariantState
    ? ` AND client_name IS NOT DISTINCT FROM ?
        AND order_date IS NOT DISTINCT FROM ?
        AND due_date IS NOT DISTINCT FROM ?
        AND sales_person IS NOT DISTINCT FROM ?
        AND product_type IS NOT DISTINCT FROM ?
        AND quantity IS NOT DISTINCT FROM ?
        AND work_order_image_url IS NOT DISTINCT FROM ?`
    : '';
  const updateResult = await db.execute({
    sql: `UPDATE orders SET ${updates.join(', ')} WHERE id = ?${invariantWhere} RETURNING *`,
    args: guardInvariantState
      ? [
        ...values,
        id,
        order.client_name ?? null,
        order.order_date ?? null,
        order.due_date ?? null,
        order.sales_person ?? null,
        order.product_type ?? null,
        order.quantity ?? null,
        order.work_order_image_url ?? null,
      ]
      : [...values, id],
  });
  if (!updateResult.rows || updateResult.rows.length === 0) {
    return res.status(409).json({
      error: { message: '주문 정보가 변경되어 수정하지 못했습니다. 다시 시도해주세요.', status: 409 },
    });
  }
  const updated = updateResult.rows[0];

  // Log activity
  const changedFields = Object.keys(mutation);
  await db.execute({
    sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
    args: [
      order.id,
      '주문수정',
      `${order.client_name} 주문이 수정되었습니다. (${changedFields.join(', ')})`,
      resolveActor(req),
    ],
  });

  // 알림 훅: 출고예정일(ship_scheduled_date)이 실제 변경 + 미출고면 → rescheduled
  // 멱등키가 'rescheduled:날짜'라 같은 날짜 재저장은 중복 발송되지 않음 (실패해도 본 응답에 영향 없음)
  try {
    const prevSched = order.ship_scheduled_date || null;
    const newSched = updated?.ship_scheduled_date || null;
    if (
      mutation.ship_scheduled_date !== undefined &&
      newSched &&
      String(newSched) !== String(prevSched || '') &&
      updated.status !== 'shipped'
    ) {
      const { maybeNotify } = await import('../../_lib/notify.js');
      await maybeNotify(db, updated, 'rescheduled', { date: newSched });
    }
  } catch (e) {
    console.error('[orders PATCH] rescheduled 알림 발송 실패(무시):', e?.message || e);
  }

  return res.json(updated);
}

async function handleDelete(id, req, res) {
  const auth = requireAuth(req, res, { roles: ['sales'] });
  if (!auth) return;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }
  const db = getDb();
  const body = req.body || {};

  if (!body.actor) {
    return res.status(400).json({ error: { message: '삭제 요청에는 actor(담당자)가 필요합니다.', status: 400 } });
  }

  if (auth._bypass && body.delete_context !== 'sales-management') {
    return res.status(403).json({ error: { message: '영업관리 화면에서만 삭제할 수 있습니다.', status: 403 } });
  }

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
  const order = orderResult.rows[0];

  if (!order) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }

  // Log with order_id before deleting, then nullify to survive cascade
  await db.execute({
    sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
    args: [
      order.id,
      '주문삭제',
      `${order.client_name} 주문(ID: ${order.id})이 삭제되었습니다.`,
      resolveActor(req),
    ],
  });

  // Detach delete log from order so CASCADE doesn't remove it
  await db.execute({
    sql: `UPDATE activity_feed SET order_id = NULL WHERE order_id = ? AND action_type = '주문삭제'`,
    args: [order.id],
  });

  // Blob orphan 정리: order 삭제 전 photos 의 file_path 들을 모아서 del. CASCADE는 DB row만 정리.
  try {
    const photosResult = await db.execute({
      sql: 'SELECT file_path FROM photos WHERE order_id = ?',
      args: [order.id],
    });
    for (const row of photosResult.rows) {
      if (!row.file_path) continue;
      try {
        await del(row.file_path);
      } catch (err) {
        console.warn('[orders DELETE] blob 삭제 실패, 계속 진행:', err?.message || err);
      }
    }
  } catch (err) {
    console.warn('[orders DELETE] photos file_path 조회 실패, 계속 진행:', err?.message || err);
  }

  await db.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [id] });

  try {
    await deleteOrderFromSheet(order);
  } catch (sheetErr) {
    console.warn('Google Sheets order delete skipped:', sheetErr?.message || sheetErr);
  }

  return res.json({ success: true, message: '주문이 삭제되었습니다.' });
}
