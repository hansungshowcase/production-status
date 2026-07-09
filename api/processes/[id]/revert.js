import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { STEPS } from '../../_lib/steps.js';
import { requireWorkerAction } from '../../_lib/auth.js';

const PROCESS_UNDO_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

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
  const { actor } = req.body || {};

  // Find process
  const { rows: processRows } = await db.execute({
    sql: 'SELECT * FROM processes WHERE id = ?',
    args: [id]
  });
  if (processRows.length === 0) {
    return res.status(404).json({ error: { message: '공정을 찾을 수 없습니다.', status: 404 } });
  }
  const process = processRows[0];

  if (process.status === 'waiting') {
    return res.status(400).json({ error: { message: '대기 상태의 공정은 되돌릴 수 없습니다.', status: 400 } });
  }

  // Check no later steps are started
  const { rows: allProcesses } = await db.execute({
    sql: 'SELECT * FROM processes WHERE order_id = ?',
    args: [process.order_id]
  });
  const currentIndex = STEPS.indexOf(process.step_name);
  if (currentIndex === -1) {
    return res.status(400).json({ error: { message: '유효하지 않은 공정입니다.', status: 400 } });
  }
  const startedLater = STEPS
    .slice(currentIndex + 1)
    .flatMap((step) => allProcesses.filter((p) => p.step_name === step))
    .filter((p) => p.status !== 'waiting');
  if (startedLater.length > 0) {
    return res.status(400).json({
      error: { message: '이후 공정이 이미 진행/완료되어 되돌릴 수 없습니다.', status: 400 },
    });
  }

  // Atomic revert: only update if status still matches (prevents race condition)
  if (process.status === 'completed') {
    const completedAt = process.completed_at ? new Date(process.completed_at).getTime() : NaN;
    if (!Number.isFinite(completedAt) || Date.now() - completedAt > PROCESS_UNDO_WINDOW_MS) {
      return res.status(400).json({
        error: { message: '공정 완료 후 3일이 지나 되돌릴 수 없습니다.', status: 400 },
      });
    }

    const { rows: updateResult } = await db.execute({
      sql: "UPDATE processes SET status = 'in_progress', completed_at = NULL, completed_by = NULL, completed_date = NULL WHERE id = ? AND status = 'completed' RETURNING id",
      args: [id]
    });
    if (updateResult.length === 0) {
      return res.status(409).json({ error: { message: '이미 다른 작업자가 처리한 공정입니다.', status: 409 } });
    }
    if (process.step_name === '출고') {
      const completedDate = process.completed_at ? String(process.completed_at).slice(0, 10) : null;
      const { rows: markerRows } = await db.execute({
        sql: `SELECT id FROM activity_feed
              WHERE order_id = ?
                AND action_type = '출고완료'
                AND actor = ?
                AND description LIKE '%출고 공정 완료%'
              ORDER BY created_at DESC
              LIMIT 1`,
        args: [process.order_id, process.completed_by || actor || workerAction.actor],
      });
      if (markerRows.length > 0) {
        await db.execute({
          sql: `UPDATE orders
                SET status = 'in_production', ship_date = NULL, updated_at = CURRENT_TIMESTAMP
                WHERE id = ? AND status = 'shipped' AND (? IS NULL OR ship_date = ?)`,
          args: [process.order_id, completedDate, completedDate],
        });
      }
    }
  } else if (process.status === 'in_progress') {
    const { rows: updateResult } = await db.execute({
      sql: "UPDATE processes SET status = 'waiting', started_at = NULL, started_by = NULL, completed_at = NULL WHERE id = ? AND status = 'in_progress' RETURNING id",
      args: [id]
    });
    if (updateResult.length === 0) {
      return res.status(409).json({ error: { message: '이미 다른 작업자가 처리한 공정입니다.', status: 409 } });
    }
  }

  // Get order for activity feed (with null check)
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
          '공정되돌리기',
          `${order.client_name} - ${process.step_name} 공정이 되돌려졌습니다.`,
          actor || workerAction.actor
        ]
      });
    } catch (e) {
      console.error('활동 로그 기록 실패:', e);
    }
  }

  const { rows: updatedRows } = await db.execute({
    sql: 'SELECT * FROM processes WHERE id = ?',
    args: [id]
  });

  res.json(updatedRows[0]);
});
