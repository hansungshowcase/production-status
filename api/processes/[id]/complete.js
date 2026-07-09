import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { requireWorkerAction } from '../../_lib/auth.js';
import { STEPS } from '../../_lib/steps.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  if (!rateLimitCheck(req, res)) return;
  const workerAction = requireWorkerAction(req, res);
  if (!workerAction) return;

  const id = req.query.id;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: { message: '유효한 공정 ID가 필요합니다.', status: 400 } });
  }

  const db = getDb();
  const { completed_date, actor, start_next_step, assigned_worker } = req.body || {};

  // Find process
  const { rows: processRows } = await db.execute({
    sql: 'SELECT * FROM processes WHERE id = ?',
    args: [id]
  });
  if (processRows.length === 0) {
    return res.status(404).json({ error: { message: '공정을 찾을 수 없습니다.', status: 404 } });
  }
  const process = processRows[0];

  const currentStepIndex = STEPS.indexOf(process.step_name);
  const targetStepIndex = start_next_step ? STEPS.indexOf(start_next_step) : -1;
  if (start_next_step && (currentStepIndex === -1 || targetStepIndex <= currentStepIndex)) {
    return res.status(400).json({ error: { message: '선택한 다음 공정이 올바르지 않습니다.', status: 400 } });
  }
  const shouldEnsureShippingStep = process.step_name === '포장' || start_next_step === '출고';
  if (shouldEnsureShippingStep) {
    await db.execute({
      sql: `INSERT INTO processes (order_id, step_name, status)
            SELECT ?, '출고', 'waiting'
            WHERE NOT EXISTS (
              SELECT 1 FROM processes WHERE order_id = ? AND step_name = '출고'
            )`,
      args: [process.order_id, process.order_id],
    });
  }
  const requiredForwardSteps = start_next_step ? STEPS.slice(currentStepIndex + 1, targetStepIndex + 1) : [];
  let forwardProcessRows = [];
  if (requiredForwardSteps.length > 0) {
    const placeholders = requiredForwardSteps.map(() => '?').join(', ');
    const { rows } = await db.execute({
      sql: `SELECT id, step_name, status FROM processes WHERE order_id = ? AND step_name IN (${placeholders})`,
      args: [process.order_id, ...requiredForwardSteps],
    });
    forwardProcessRows = rows;
    const existingSteps = new Set(rows.map((row) => row.step_name));
    const missingStep = requiredForwardSteps.find((step) => !existingSteps.has(step));
    if (missingStep) {
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

  const now = new Date().toISOString();
  const completeWorker = actor || assigned_worker || workerAction.actor;

  // Atomic update: only complete if still 'in_progress' (prevents double-click race condition)
  const { rows: updateResult } = await db.execute({
    sql: `UPDATE processes SET status = 'completed', completed_at = ?, completed_date = ?, completed_by = ? WHERE id = ? AND status = 'in_progress' RETURNING id`,
    args: [now, completed_date || null, completeWorker, id]
  });
  if (updateResult.length === 0) {
    return res.status(409).json({ error: { message: '이미 다른 작업자가 처리한 공정입니다.', status: 409 } });
  }

  // Get order for activity feed
  const { rows: orderRows } = await db.execute({
    sql: 'SELECT * FROM orders WHERE id = ?',
    args: [process.order_id]
  });
  const order = orderRows[0];
  if (order) {
    try {
      await db.execute({
        sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
        args: [
          process.order_id,
          '공정완료',
          `${order.client_name} - ${process.step_name} 공정이 완료되었습니다. (담당: ${completeWorker})`,
          completeWorker
        ]
      });
    } catch (e) {
      console.error('활동 로그 기록 실패:', e);
    }
  }

  // 알림 훅: 포장 완료 → packed (실패해도 본 응답에 영향 없음)
  if (order && process.step_name === '포장') {
    try {
      const { maybeNotify } = await import('../../_lib/notify.js');
      await maybeNotify(db, order, 'packed');
    } catch (e) {
      console.error('[complete] packed 알림 발송 실패(무시):', e?.message || e);
    }
  }

  let startedNextProcessId = null;
  let completedIntermediateProcesses = [];

  if (start_next_step) {
    const nextWorker = assigned_worker || completeWorker;
    const intermediateSteps = STEPS.slice(currentStepIndex + 1, targetStepIndex);
    completedIntermediateProcesses = forwardProcessRows
      .filter((row) => intermediateSteps.includes(row.step_name) && (row.status === 'waiting' || row.status === 'in_progress'))
      .map((row) => ({
        id: row.id,
        was_waiting_before_complete: row.status === 'waiting',
      }));
    if (intermediateSteps.length > 0) {
      const placeholders = intermediateSteps.map(() => '?').join(', ');
      await db.execute({
        sql: `UPDATE processes
              SET status = 'completed',
                  started_at = COALESCE(started_at, ?),
                  started_by = COALESCE(started_by, ?),
                  completed_at = ?,
                  completed_date = ?,
                  completed_by = ?
              WHERE order_id = ?
                AND step_name IN (${placeholders})
                AND status IN ('waiting', 'in_progress')`,
        args: [now, nextWorker, now, completed_date || null, completeWorker, process.order_id, ...intermediateSteps],
      });
    }

    const { rows: startNextRows } = await db.execute({
      sql: `UPDATE processes
            SET status = 'in_progress', started_at = ?, started_by = ?
            WHERE order_id = ? AND step_name = ? AND status = 'waiting'
            RETURNING id`,
      args: [now, nextWorker, process.order_id, start_next_step],
    });
    if (startNextRows.length > 0) {
      startedNextProcessId = startNextRows[0].id;
      if (order) {
        await db.execute({
          sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
          args: [
            process.order_id,
            '공정시작',
            `${order.client_name} - ${start_next_step} 공정이 시작되었습니다. (담당: ${nextWorker})`,
            nextWorker,
          ],
        }).catch((e) => console.error('다음 공정 시작 로그 기록 실패:', e));
      }
    }
  }

  if (process.step_name === '출고' && order) {
    const today = new Date().toISOString().slice(0, 10);
    const { rows: shippedRows } = await db.execute({
      sql: `UPDATE orders SET status = 'shipped', ship_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'shipped' RETURNING id`,
      args: [today, process.order_id],
    });
    if (shippedRows.length > 0) {
      try {
        await db.execute({
          sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
          args: [
            process.order_id,
            '출고완료',
            `${order.client_name} 주문이 출고 처리되었습니다. (출고 공정 완료)`,
            completeWorker,
          ],
        });
      } catch (e) {
        console.error('출고 로그 기록 실패:', e);
      }

      // 알림 훅: 출고 공정 완료로 shipped 전환 → shipped (실패해도 본 응답에 영향 없음)
      try {
        const { maybeNotify } = await import('../../_lib/notify.js');
        await maybeNotify(db, { ...order, status: 'shipped', ship_date: today }, 'shipped');
      } catch (e) {
        console.error('[complete] shipped 알림 발송 실패(무시):', e?.message || e);
      }
    }
  }

  const { rows: updatedRows } = await db.execute({
    sql: 'SELECT * FROM processes WHERE id = ?',
    args: [id]
  });

  res.json({
    ...updatedRows[0],
    started_next_process_id: startedNextProcessId,
    completed_intermediate_processes: completedIntermediateProcesses,
  });
});
