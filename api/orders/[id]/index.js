import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { pickOwnAllowedFields, sanitizeInput } from '../../_lib/sanitize.js';
import { requireAuth } from '../../_lib/auth.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { ensureOrderImageColumn } from '../../_lib/ensureSchema.js';
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
import { changedFieldKeys, describeFieldChanges } from '../../../src/utils/fieldLabels.js';
import { parsePositiveInt4Id } from '../../_lib/positiveInt4Id.js';
import { readPrivateConfig } from '../../_lib/privateConfig.js';
import { isNoPhoneRecoveryTransition } from '../../_lib/notify.js';
import { ensureExternalCleanupSchema } from '../../_lib/externalCleanupSchema.js';
import {
  blobCleanupTargetKey,
  processExternalCleanupJob,
  sheetCleanupTargetKey,
} from '../../_lib/externalCleanup.js';

async function notifyOrder(db, order, milestone, extra) {
  const { maybeNotify } = await import('../../_lib/notify.js');
  return maybeNotify(db, order, milestone, extra);
}

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

export async function handleGet(id, req, res, dependencies = {}) {
  const orderId = parsePositiveInt4Id(id);
  if (orderId === null) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }
  const db = dependencies.db || getDb();

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
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

export async function handleUpdate(id, req, res, dependencies = {}) {
  const checkAuth = dependencies.requireAuth || requireAuth;
  const auth = await checkAuth(req, res, { roles: ['sales'] });
  if (!auth) return;
  const orderId = parsePositiveInt4Id(id);
  if (orderId === null) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }
  let mutation;
  try {
    const normalizedBody = normalizeOrderMutationInput(sanitizeInput(req.body));
    mutation = pickOwnAllowedFields(normalizedBody, ORDER_FIELDS);
  } catch (err) {
    if (err instanceof OrderCreateInputValidationError) {
      return res.status(400).json({ error: { message: err.message, status: 400 } });
    }
    throw err;
  }

  const db = dependencies.db || getDb();
  const ensureImageColumn = dependencies.ensureOrderImageColumn || ensureOrderImageColumn;
  await ensureImageColumn(db);

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
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
    ? ` AND locked.client_name IS NOT DISTINCT FROM ?
        AND locked.order_date IS NOT DISTINCT FROM ?
        AND locked.due_date IS NOT DISTINCT FROM ?
        AND locked.sales_person IS NOT DISTINCT FROM ?
        AND locked.product_type IS NOT DISTINCT FROM ?
        AND locked.quantity IS NOT DISTINCT FROM ?
        AND locked.work_order_image_url IS NOT DISTINCT FROM ?`
    : '';
  const changedFields = changedFieldKeys(order, { ...order, ...mutation }, Object.keys(mutation));
  const activityDescription = describeFieldChanges(
    `${order.client_name} 주문이 수정되었습니다.`,
    changedFields,
  );
  const nextScheduledDate = mutation.ship_scheduled_date || null;
  const shouldQueueRescheduled = (
    mutation.ship_scheduled_date !== undefined
    && nextScheduledDate
    && String(nextScheduledDate) !== String(order.ship_scheduled_date || '')
    && order.status !== 'shipped'
  );
  const rescheduledKey = shouldQueueRescheduled ? `rescheduled:${nextScheduledDate}` : '';
  const queuedIntent = JSON.stringify({ status: 'queued', at: new Date().toISOString() });
  const eventAt = new Date().toISOString();
  let activationAt = eventAt;
  let shouldTryNoPhoneRecovery = false;
  if (Object.hasOwn(mutation, 'phone')) {
    try {
      activationAt = await (dependencies.readPrivateConfig || readPrivateConfig)('repairs.activation_at');
      shouldTryNoPhoneRecovery = isNoPhoneRecoveryTransition({
        phoneFieldChanged: true,
        beforePhone: order.phone,
        afterPhone: mutation.phone,
        orderStatus: order.status,
        orderedState: order.notify_state?.ordered,
        eventAt,
        activationAt,
      });
      if (!shouldTryNoPhoneRecovery) activationAt = eventAt;
    } catch {
      shouldTryNoPhoneRecovery = false;
      activationAt = eventAt;
    }
  }
  const noPhoneIntent = JSON.stringify({ status: 'queued', reason: 'phone_added', at: eventAt });
  const mutationArgs = guardInvariantState
    ? [
      ...values,
      noPhoneIntent,
      shouldQueueRescheduled ? 1 : 0,
      rescheduledKey,
      rescheduledKey,
      queuedIntent,
      order.client_name ?? null,
      order.order_date ?? null,
      order.due_date ?? null,
      order.sales_person ?? null,
      order.product_type ?? null,
      order.quantity ?? null,
      order.work_order_image_url ?? null,
    ]
    : [
      ...values,
      noPhoneIntent,
      shouldQueueRescheduled ? 1 : 0,
      rescheduledKey,
      rescheduledKey,
      queuedIntent,
    ];
  const [mutationResult] = await db.atomicBatch([{
    sql: `WITH locked_order AS (
            SELECT o.*,
                   (
                     ?::integer = 1
                     AND LENGTH(regexp_replace(COALESCE(o.phone, ''), '[^0-9]', '', 'g')) < 9
                     AND LENGTH(regexp_replace(COALESCE(?::text, ''), '[^0-9]', '', 'g')) >= 9
                     AND o.status = 'in_production'
                     AND o.notify_state -> 'ordered' ->> 'status' = 'skipped'
                     AND o.notify_state -> 'ordered' ->> 'reason' = 'no_phone'
                     AND ?::timestamptz >= ?::timestamptz
                     AND NOT EXISTS (
                       SELECT 1 FROM notification_log receipt
                        WHERE receipt.order_id = o.id
                          AND receipt.milestone = 'ordered'
                          AND (
                            receipt.status IN ('success', 'dry_run')
                            OR COALESCE(receipt.provider_msgid, '') <> ''
                          )
                     )
                   ) AS no_phone_recovery
              FROM orders o
             WHERE o.id = ?
             FOR UPDATE
          ),
          updated_order AS (
            UPDATE orders o
               SET ${updates.join(', ')},
                   notify_state = COALESCE(locked.notify_state, '{}'::jsonb)
                     || CASE
                          WHEN locked.no_phone_recovery
                            THEN jsonb_build_object('ordered', ?::jsonb)
                          ELSE '{}'::jsonb
                        END
                     || CASE
                          WHEN ?::integer = 1
                           AND NOT jsonb_exists(COALESCE(locked.notify_state, '{}'::jsonb), ?)
                            THEN jsonb_build_object(?::text, ?::jsonb)
                          ELSE '{}'::jsonb
                        END
              FROM locked_order locked
             WHERE o.id = locked.id${invariantWhere}
            RETURNING o.*
          ),
          order_activity AS (
            INSERT INTO activity_feed (order_id, action_type, description, actor)
            SELECT u.id, '주문수정', ?, ?
              FROM updated_order u
            RETURNING id
          )
          SELECT to_jsonb(u) AS order_row,
                 locked.no_phone_recovery AS no_phone_requeued
            FROM updated_order u
            JOIN locked_order locked ON locked.id = u.id
           WHERE EXISTS (SELECT 1 FROM order_activity)`,
    args: [
      shouldTryNoPhoneRecovery ? 1 : 0,
      mutation.phone ?? '',
      eventAt,
      activationAt,
      orderId,
      ...mutationArgs,
      activityDescription,
      auth.actor,
    ],
  }]);
  if (!mutationResult.rows || mutationResult.rows.length === 0) {
    return res.status(409).json({
      error: { message: '주문 정보가 변경되어 수정하지 못했습니다. 다시 시도해주세요.', status: 409 },
    });
  }
  const updated = mutationResult.rows[0].order_row;
  const noPhoneRequeued = mutationResult.rows[0].no_phone_requeued === true;

  // 알림 훅: 출고예정일(ship_scheduled_date)이 실제 변경 + 미출고면 → rescheduled
  // 멱등키가 'rescheduled:날짜'라 같은 날짜 재저장은 중복 발송되지 않음 (실패해도 본 응답에 영향 없음)
  try {
    const notify = dependencies.notify || notifyOrder;
    if (noPhoneRequeued) {
      await notify(db, updated, 'ordered');
    }
    const prevSched = order.ship_scheduled_date || null;
    const newSched = updated?.ship_scheduled_date || null;
    if (
      mutation.ship_scheduled_date !== undefined &&
      newSched &&
      String(newSched) !== String(prevSched || '') &&
      updated.status !== 'shipped'
    ) {
      await notify(db, updated, 'rescheduled', { date: newSched });
    }
  } catch (e) {
    console.error('[orders PATCH] 알림 발송 실패(무시):', e?.message || e);
  }

  return res.json(updated);
}

export async function handleDelete(id, req, res, dependencies = {}) {
  const checkAuth = dependencies.requireAuth || requireAuth;
  const auth = await checkAuth(req, res, { roles: ['sales'] });
  if (!auth) return;
  const orderId = parsePositiveInt4Id(id);
  if (orderId === null) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }
  const db = dependencies.db || getDb();
  const processCleanup = dependencies.processExternalCleanupJob || processExternalCleanupJob;
  await (dependencies.ensureExternalCleanupSchema || ensureExternalCleanupSchema)(db);
  const body = req.body || {};

  if (!body.actor) {
    return res.status(400).json({ error: { message: '삭제 요청에는 actor(담당자)가 필요합니다.', status: 400 } });
  }

  if (auth._bypass && body.delete_context !== 'sales-management') {
    return res.status(403).json({ error: { message: '영업관리 화면에서만 삭제할 수 있습니다.', status: 403 } });
  }

  const actor = auth.actor;
  const [orderResult, photosResult, deleteResult] = await db.atomicBatch([
    {
      sql: 'SELECT * FROM orders WHERE id = ? FOR UPDATE',
      args: [orderId],
    },
    {
      sql: 'SELECT file_path FROM photos WHERE order_id = ?',
      args: [orderId],
    },
    {
      sql: `WITH cleanup_candidates AS (
              SELECT 'sheet_delete'::text AS kind,
                     'sheet:order:' || o.id AS target_key,
                     o.id AS source_order_id,
                     NULL::integer AS source_photo_id,
                     jsonb_build_object('orderId', o.id) AS payload
                FROM orders o
               WHERE o.id = ?
              UNION ALL
              SELECT 'blob_delete',
                     'blob:' || p.file_path,
                     p.order_id,
                     MIN(p.id),
                     jsonb_build_object('url', p.file_path)
                FROM photos p
               WHERE p.order_id = ? AND p.file_path IS NOT NULL AND p.file_path <> ''
               GROUP BY p.order_id, p.file_path
            ),
            cleanup_jobs AS (
              INSERT INTO external_cleanup_jobs (
                kind, target_key, source_order_id, source_photo_id, payload
              )
              SELECT kind, target_key, source_order_id, source_photo_id, payload
                FROM cleanup_candidates
              ON CONFLICT (target_key) DO UPDATE SET
                status = CASE
                  WHEN external_cleanup_jobs.status = 'held_shared' THEN 'pending'
                  ELSE external_cleanup_jobs.status
                END,
                next_attempt_at = CASE
                  WHEN external_cleanup_jobs.status = 'held_shared' THEN NOW()
                  ELSE external_cleanup_jobs.next_attempt_at
                END,
                last_error = CASE
                  WHEN external_cleanup_jobs.status = 'held_shared' THEN NULL
                  ELSE external_cleanup_jobs.last_error
                END,
                attempts = CASE
                  WHEN external_cleanup_jobs.status = 'held_shared' THEN 0
                  ELSE external_cleanup_jobs.attempts
                END
              RETURNING target_key
            ),
            delete_audit AS (
              INSERT INTO activity_feed (order_id, action_type, description, actor)
              SELECT NULL,
                     '주문삭제',
                     o.client_name || ' 주문(ID: ' || o.id || ')이 삭제되었습니다.',
                     ?
                FROM orders o
               WHERE o.id = ?
              RETURNING id
            ),
            deleted_order AS (
              DELETE FROM orders
               WHERE id = ?
                 AND EXISTS (SELECT 1 FROM delete_audit)
                 AND (SELECT COUNT(*) FROM cleanup_jobs) = (SELECT COUNT(*) FROM cleanup_candidates)
              RETURNING id
            )
            SELECT id FROM deleted_order`,
      args: [orderId, orderId, actor, orderId, orderId],
    },
  ]);
  const order = orderResult.rows[0];

  if (!order) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }

  if (!deleteResult.rows[0]) {
    throw new Error('주문 삭제가 원자 배치 안에서 완료되지 않았습니다.');
  }

  const cleanupTargets = [
    sheetCleanupTargetKey(orderId),
    ...new Set(photosResult.rows.filter(row => row.file_path).map(row => blobCleanupTargetKey(row.file_path))),
  ];
  for (const targetKey of cleanupTargets) {
    try {
      await processCleanup(db, targetKey, dependencies);
    } catch (cleanupError) {
      console.warn('[orders DELETE] external cleanup deferred:', cleanupError?.message || cleanupError);
    }
  }

  return res.json({ success: true, message: '주문이 삭제되었습니다.' });
}
