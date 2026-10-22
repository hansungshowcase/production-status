import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { requireWorkerAction } from '../../_lib/auth.js';
import { STEPS } from '../../_lib/steps.js';
import { kstTodayStr } from '../../_lib/notify.js';
import { ensureShippingSheetSyncSchema } from '../../_lib/shippingSheetSyncSchema.js';
import { ensureShippingProcessUniqueIndex } from '../../_lib/ensureShippingProcess.js';
import { parsePositiveInt4Id } from '../../_lib/positiveInt4Id.js';

async function defaultNotify(db, order, milestone) {
  const { maybeNotify } = await import('../../_lib/notify.js');
  await maybeNotify(db, order, milestone);
}

async function defaultInternalCompletionNotify(db, payload) {
  const { notifyInternalProcessCompletion } = await import('../../_lib/internalProductionAlerts.js');
  return notifyInternalProcessCompletion(db, payload);
}

export async function handleCompleteProcess(req, res, dependencies = {}) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  const checkRateLimit = dependencies.rateLimitCheck || rateLimitCheck;
  if (!checkRateLimit(req, res)) return;
  const workerAction = dependencies.requireWorkerAction
    ? dependencies.requireWorkerAction(req, res)
    : requireWorkerAction(req, res);
  if (!workerAction) return;

  const id = parsePositiveInt4Id(req.query.id);
  if (id === null) {
    return res.status(400).json({ error: { message: '유효한 공정 ID가 필요합니다.', status: 400 } });
  }

  const db = dependencies.db || getDb();
  const notify = dependencies.notify || defaultNotify;
  const notifyInternalCompletion = dependencies.notifyInternalCompletion || defaultInternalCompletionNotify;
  const ensureShippingIndex = dependencies.ensureShippingProcessUniqueIndex || ensureShippingProcessUniqueIndex;
  const ensureShippingSchema = dependencies.ensureShippingSheetSyncSchema || ensureShippingSheetSyncSchema;
  const requestBody = req.body || {};
  const { completed_date, actor, start_next_step, assigned_worker } = requestBody;

  // Find process
  const { rows: processRows } = await db.execute({
    sql: 'SELECT * FROM processes WHERE id = ?',
    args: [id]
  });
  if (processRows.length === 0) {
    return res.status(404).json({ error: { message: '공정을 찾을 수 없습니다.', status: 404 } });
  }
  const process = processRows[0];

  if (process.step_name === '도면설계'
    && Object.prototype.hasOwnProperty.call(requestBody, 'start_next_step')) {
    return res.status(400).json({
      error: {
        message: '도면 완료 후에는 작업지시서 수령 대기로 이동합니다. 다음 공정을 자동 시작할 수 없습니다.',
        status: 400,
      },
    });
  }

  const currentStepIndex = STEPS.indexOf(process.step_name);
  const targetStepIndex = start_next_step ? STEPS.indexOf(start_next_step) : -1;
  if (start_next_step && (currentStepIndex === -1 || targetStepIndex <= currentStepIndex)) {
    return res.status(400).json({ error: { message: '선택한 다음 공정이 올바르지 않습니다.', status: 400 } });
  }
  const shouldEnsureShippingStep = process.step_name === '포장' || start_next_step === '출고';
  const requiredForwardSteps = start_next_step ? STEPS.slice(currentStepIndex + 1, targetStepIndex + 1) : [];
  if (requiredForwardSteps.length > 0) {
    const placeholders = requiredForwardSteps.map(() => '?').join(', ');
    const { rows } = await db.execute({
      sql: `SELECT id, step_name, status FROM processes WHERE order_id = ? AND step_name IN (${placeholders})`,
      args: [process.order_id, ...requiredForwardSteps],
    });
    const existingSteps = new Set(rows.map((row) => row.step_name));
    const missingStep = requiredForwardSteps.find((step) => !existingSteps.has(step));
    if (missingStep && !(missingStep === '출고' && shouldEnsureShippingStep)) {
      return res.status(400).json({ error: { message: `${missingStep} 공정 전환 대상을 찾지 못했습니다.`, status: 400 } });
    }
  }

  if (process.status === 'completed') {
    return res.status(400).json({ error: { message: '이미 완료된 공정입니다.', status: 400 } });
  }
  if (process.status === 'waiting') {
    return res.status(400).json({ error: { message: '진행 중인 공정만 완료할 수 있습니다.', status: 400 } });
  }

  if (process.step_name === '포장') {
    const { rows: photoRows } = await db.execute({
      sql: 'SELECT id FROM photos WHERE process_id = ? LIMIT 1',
      args: [process.id],
    });
    if (photoRows.length === 0) {
      return res.status(400).json({ error: { message: '포장 완료 후 출고로 넘기려면 사진 첨부가 필요합니다.', status: 400 } });
    }
  }

  if (shouldEnsureShippingStep) {
    await ensureShippingIndex(db);
  }
  if (process.step_name === '출고') {
    await ensureShippingSchema(db);
  }

  const now = new Date().toISOString();
  const completeWorker = actor || assigned_worker || workerAction.actor;
  const nextWorker = assigned_worker || completeWorker;
  const intermediateSteps = start_next_step ? STEPS.slice(currentStepIndex + 1, targetStepIndex) : [];
  const mutationArgs = [now, completed_date || null, completeWorker, id];
  const mutationCtes = [
    `claimed_process AS (
       UPDATE processes
          SET status = 'completed', completed_at = ?, completed_date = ?, completed_by = ?
        WHERE id = ? AND status = 'in_progress'
       RETURNING *
     )`,
  ];

  if (shouldEnsureShippingStep) {
    if (start_next_step === '출고') {
      mutationCtes.push(`ensured_shipping AS (
        INSERT INTO processes (order_id, step_name, status, started_at, started_by)
        SELECT cp.order_id, '출고', 'in_progress', ?, ?
          FROM claimed_process cp
         WHERE NOT EXISTS (
           SELECT 1 FROM processes p WHERE p.order_id = cp.order_id AND p.step_name = '출고'
         )
        ON CONFLICT DO NOTHING
        RETURNING id
      )`);
      mutationArgs.push(now, nextWorker);
    } else {
      mutationCtes.push(`ensured_shipping AS (
        INSERT INTO processes (order_id, step_name, status)
        SELECT cp.order_id, '출고', 'waiting'
          FROM claimed_process cp
         WHERE NOT EXISTS (
           SELECT 1 FROM processes p WHERE p.order_id = cp.order_id AND p.step_name = '출고'
         )
        ON CONFLICT DO NOTHING
        RETURNING id
      )`);
    }
  } else {
    mutationCtes.push('ensured_shipping AS (SELECT NULL::INTEGER AS id WHERE FALSE)');
  }

  const intermediateCondition = intermediateSteps.length > 0
    ? `p.step_name IN (${intermediateSteps.map(() => '?').join(', ')})`
    : 'FALSE';
  mutationArgs.push(...intermediateSteps);
  mutationCtes.push(
    `intermediate_candidates AS (
       SELECT p.id, p.step_name, p.status
         FROM processes p
         JOIN claimed_process cp ON cp.order_id = p.order_id
        WHERE ${intermediateCondition}
          AND p.status IN ('waiting', 'in_progress')
     )`,
    `completed_intermediates AS (
       UPDATE processes p
          SET status = 'completed',
              started_at = COALESCE(p.started_at, ?),
              started_by = COALESCE(p.started_by, ?),
              completed_at = ?,
              completed_date = ?,
              completed_by = ?
         FROM intermediate_candidates candidate
        WHERE p.id = candidate.id
       RETURNING p.id, p.step_name, candidate.status = 'waiting' AS was_waiting_before_complete
     )`,
  );
  mutationArgs.push(now, nextWorker, now, completed_date || null, completeWorker);
  mutationCtes.push(
    `started_existing_next AS (
       UPDATE processes p
          SET status = 'in_progress', started_at = ?, started_by = ?
         FROM claimed_process cp
        WHERE p.order_id = cp.order_id
          AND p.step_name = ?
          AND p.status = 'waiting'
       RETURNING p.id
     )`,
    `started_next AS (
       SELECT id FROM started_existing_next
       UNION ALL
       SELECT id FROM ensured_shipping WHERE ? = '출고'
     )`,
  );
  mutationArgs.push(now, nextWorker, start_next_step || null, start_next_step || null);

  const isShippingCompletion = process.step_name === '출고';
  if (isShippingCompletion) {
    const today = kstTodayStr();
    mutationCtes.push(
      `shipped_order AS (
         UPDATE orders o
            SET status = 'shipped', ship_date = ?, updated_at = CURRENT_TIMESTAMP
           FROM claimed_process cp
          WHERE o.id = cp.order_id
            AND cp.step_name = '출고'
            AND o.status != 'shipped'
         RETURNING o.*
       )`,
      `queued_sheet_sync AS (
         INSERT INTO sheet_shipping_sync_jobs (order_id, ship_date, status)
         SELECT id, ?, 'pending' FROM shipped_order
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
       )`,
    );
    mutationArgs.push(today, today);
  }

  mutationCtes.push(`process_activity AS (
    INSERT INTO activity_feed (order_id, action_type, description, actor)
    SELECT cp.order_id,
           '공정완료',
           o.client_name || ' - ' || cp.step_name || ' 공정이 완료되었습니다. (담당: ' || ? || ')',
           ?
      FROM claimed_process cp
      JOIN orders o ON o.id = cp.order_id
    RETURNING id
  )`);
  mutationArgs.push(completeWorker, completeWorker);
  mutationCtes.push(`start_activity AS (
    INSERT INTO activity_feed (order_id, action_type, description, actor)
    SELECT cp.order_id,
           '공정시작',
           o.client_name || ' - ' || ? || ' 공정이 시작되었습니다. (담당: ' || ? || ')',
           ?
      FROM started_next sn
      CROSS JOIN claimed_process cp
      JOIN orders o ON o.id = cp.order_id
    RETURNING id
  )`);
  mutationArgs.push(start_next_step || null, nextWorker, nextWorker);

  if (isShippingCompletion) {
    mutationCtes.push(`shipping_activity AS (
      INSERT INTO activity_feed (order_id, action_type, description, actor)
      SELECT so.id,
             '출고완료',
             so.client_name || ' 주문이 출고 처리되었습니다. (출고 공정 완료)',
             ?
        FROM shipped_order so
      RETURNING id
    )`);
    mutationArgs.push(completeWorker);
  }

  const shippedOrderSelect = isShippingCompletion
    ? '(SELECT row_to_json(so) FROM shipped_order so LIMIT 1)'
    : 'NULL::json';
  const orderRowSelect = isShippingCompletion
    ? `COALESCE(
         (SELECT row_to_json(so) FROM shipped_order so LIMIT 1),
         row_to_json(o)
       )`
    : 'row_to_json(o)';
  const mutation = {
    sql: `WITH ${mutationCtes.join(',\n')}
          SELECT cp.id AS claimed_process_id,
                 row_to_json(cp) AS process_row,
                 ${orderRowSelect} AS order_row,
                 COALESCE((
                   SELECT json_agg(json_build_object(
                     'id', ci.id,
                     'step_name', ci.step_name,
                     'was_waiting_before_complete', ci.was_waiting_before_complete
                   ) ORDER BY ci.id)
                     FROM completed_intermediates ci
                 ), '[]'::json) AS completed_intermediate_processes,
                 (SELECT id FROM started_next LIMIT 1) AS started_next_process_id,
                 ${shippedOrderSelect} AS shipped_order
            FROM claimed_process cp
            LEFT JOIN orders o ON o.id = cp.order_id`,
    args: mutationArgs,
  };
  const [mutationResult] = await db.atomicBatch([mutation]);
  const committed = mutationResult.rows[0];
  if (!committed) {
    return res.status(409).json({ error: { message: '이미 다른 작업자가 처리한 공정입니다.', status: 409 } });
  }

  const order = committed.order_row;
  const completedIntermediateRows = committed.completed_intermediate_processes || [];
  const completedIntermediateProcesses = completedIntermediateRows.map((row) => ({
    id: row.id,
    was_waiting_before_complete: row.was_waiting_before_complete,
  }));
  const completedIntermediateStepNames = completedIntermediateRows.map((row) => row.step_name);

  if (order && process.step_name === 'V-커팅작업') {
    try {
      await notifyInternalCompletion(db, {
        order,
        completedStepNames: [process.step_name],
        completedBy: completeWorker,
      });
    } catch (e) {
      console.error('[complete] V-커팅 자재 알림 발송 실패(무시):', e?.message || e);
    }
  }
  if (order && completedIntermediateStepNames.includes('V-커팅작업')) {
    try {
      await notifyInternalCompletion(db, {
        order,
        completedStepNames: ['V-커팅작업'],
        completedBy: completeWorker,
      });
    } catch (e) {
      console.error('[complete] V-커팅 자재 알림 발송 실패(무시):', e?.message || e);
    }
  }
  if (order && process.step_name === '포장') {
    try {
      await notify(db, order, 'packed');
    } catch (e) {
      console.error('[complete] packed 알림 발송 실패(무시):', e?.message || e);
    }
  }
  if (committed.shipped_order) {
    try {
      await notify(db, committed.shipped_order, 'shipped');
    } catch (e) {
      console.error('[complete] shipped 알림 발송 실패(무시):', e?.message || e);
    }
  }

  res.json({
    ...committed.process_row,
    started_next_process_id: committed.started_next_process_id,
    completed_intermediate_processes: completedIntermediateProcesses,
  });
}

export default cors(handleCompleteProcess);
