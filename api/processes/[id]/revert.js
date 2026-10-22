import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { STEPS } from '../../_lib/steps.js';
import { requireWorkerAction } from '../../_lib/auth.js';
import { clearShippedOnSheet } from '../../_lib/googleSheets.js';
import { PROCESS_UNDO_MANAGER, isProcessUndoManager } from '../../../shared/processUndoPermission.js';

const PROCESS_UNDO_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;

// processes.completed_at 은 UTC(new Date().toISOString())로, orders.ship_date 는 KST(kstTodayStr())로
// 저장된다. 그대로 잘라 비교하면 KST 00:00~09:00 출고 건이 하루 어긋나 UPDATE 가 0행을 갱신하고,
// 공정만 되돌아간 채 주문은 shipped 로 남는다.
// notify.js kstTodayStr() / shippingSheetSync.js normalizedShipDate() 과 동일한 +9h offset 방식.
function kstDateStr(value) {
  if (value === null || value === undefined || value === '') return null;
  const time = value instanceof Date ? value.getTime() : Date.parse(String(value));
  if (!Number.isFinite(time)) return null;
  return new Date(time + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export async function handleRevertProcess(req, res, dependencies = {}) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  const checkRateLimit = dependencies.rateLimitCheck || rateLimitCheck;
  if (!checkRateLimit(req, res)) return;
  const workerAction = dependencies.requireWorkerAction
    ? dependencies.requireWorkerAction(req, res)
    : requireWorkerAction(req, res);
  if (!workerAction) return;
  if (!isProcessUndoManager(workerAction.actor)) {
    return res.status(403).json({
      error: { message: '김보수 팀장만 공정을 되돌릴 수 있습니다.', status: 403 },
    });
  }
  const auditActor = PROCESS_UNDO_MANAGER;

  const id = req.query.id;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: { message: '유효한 공정 ID가 필요합니다.', status: 400 } });
  }

  const db = dependencies.db || getDb();
  const clearShippedSheet = dependencies.clearShippedSheet || clearShippedOnSheet;

  // Find process
  const { rows: processRows } = await db.execute({
    sql: 'SELECT * FROM processes WHERE id = ?',
    args: [id]
  });
  if (processRows.length === 0) {
    return res.status(404).json({ error: { message: '공정을 찾을 수 없습니다.', status: 404 } });
  }
  const process = processRows[0];

  if (process.step_name === '도면설계') {
    const now = new Date(Date.now()).toISOString();
    const laterSteps = STEPS.slice(STEPS.indexOf('도면설계') + 1);
    let resultSets;
    try {
      resultSets = await db.atomicBatch([
        {
          sql: `SELECT o.*
                  FROM orders o
                 WHERE o.id = (SELECT p.order_id FROM processes p WHERE p.id = ?)
                 FOR UPDATE`,
          args: [id],
        },
        {
          sql: `SELECT *
                  FROM processes
                 WHERE order_id = (SELECT order_id FROM processes WHERE id = ?)
                 ORDER BY id`,
          args: [id],
        },
        {
          sql: `WITH input AS (
                  SELECT ?::BIGINT AS process_id,
                         ?::TIMESTAMPTZ AS requested_at
                ),
                eligible AS (
                  SELECT p.id, p.order_id, p.status
                    FROM processes p
                    JOIN input i ON i.process_id = p.id
                   WHERE p.step_name = '도면설계'
                     AND p.status IN ('completed', 'in_progress')
                     AND (
                       p.status != 'completed'
                       OR CASE
                         WHEN p.completed_at IS NOT NULL AND p.completed_at ~ '^[0-9]{4}-'
                         THEN p.completed_at::TIMESTAMPTZ >= i.requested_at - INTERVAL '3 days'
                         ELSE FALSE
                       END
                     )
                     AND NOT EXISTS (
                       SELECT 1 FROM processes later
                        WHERE later.order_id = p.order_id
                          AND later.step_name IN (${laterSteps.map(() => '?').join(', ')})
                          AND later.status != 'waiting'
                     )
                ),
                mutated_process AS (
                  UPDATE processes p
                     SET status = CASE WHEN e.status = 'completed' THEN 'in_progress' ELSE 'waiting' END,
                         started_at = CASE WHEN e.status = 'in_progress' THEN NULL ELSE p.started_at END,
                         started_by = CASE WHEN e.status = 'in_progress' THEN NULL ELSE p.started_by END,
                         completed_at = NULL,
                         completed_by = NULL,
                         completed_date = NULL
                    FROM eligible e
                   WHERE p.id = e.id AND p.status = e.status
                   RETURNING p.*
                ),
                invalidated_order AS (
                  UPDATE orders o
                     SET work_instruction_revision = work_instruction_revision + 1,
                         work_instruction_received_revision = NULL,
                         work_instruction_received_at = NULL,
                         work_instruction_received_by = NULL,
                         updated_at = CURRENT_TIMESTAMP
                    FROM mutated_process p
                   WHERE o.id = p.order_id
                   RETURNING o.id, o.work_instruction_revision
                ),
                revert_activity AS (
                  INSERT INTO activity_feed (order_id, action_type, description, actor)
                  SELECT p.order_id,
                         '공정되돌리기',
                         o.client_name || ' - 도면설계 공정이 되돌려졌습니다.',
                         ?
                    FROM mutated_process p
                    JOIN orders o ON o.id = p.order_id
                  RETURNING id
                )
                SELECT p.*, o.work_instruction_revision
                  FROM mutated_process p
                  JOIN invalidated_order o ON o.id = p.order_id`,
          args: [id, now, ...laterSteps, auditActor],
        },
      ]);
    } catch (error) {
      const status = error.status || 500;
      return res.status(status).json({
        error: { message: error.publicMessage || '도면 공정 되돌리기에 실패했습니다.', status },
      });
    }

    const lockedOrder = resultSets[0]?.rows?.[0];
    const lockedProcesses = resultSets[1]?.rows || [];
    const revertedProcess = resultSets[2]?.rows?.[0];
    if (!lockedOrder) {
      return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
    }
    const lockedProcess = lockedProcesses.find((row) => String(row.id) === String(id));
    if (!lockedProcess) {
      return res.status(404).json({ error: { message: '공정을 찾을 수 없습니다.', status: 404 } });
    }
    if (lockedProcess.status === 'waiting') {
      return res.status(400).json({ error: { message: '대기 상태의 공정은 되돌릴 수 없습니다.', status: 400 } });
    }
    const laterStarted = lockedProcesses.some((row) => (
      laterSteps.includes(row.step_name) && row.status !== 'waiting'
    ));
    if (laterStarted) {
      return res.status(400).json({
        error: { message: '이후 공정이 이미 진행/완료되어 되돌릴 수 없습니다.', status: 400 },
      });
    }
    if (lockedProcess.status === 'completed') {
      const completedAt = lockedProcess.completed_at ? new Date(lockedProcess.completed_at).getTime() : NaN;
      if (!Number.isFinite(completedAt) || Date.now() - completedAt > PROCESS_UNDO_WINDOW_MS) {
        return res.status(400).json({
          error: { message: '공정 완료 후 3일이 지나 되돌릴 수 없습니다.', status: 400 },
        });
      }
    }
    if (!revertedProcess) {
      return res.status(409).json({ error: { message: '이미 다른 작업자가 처리한 공정입니다.', status: 409 } });
    }

    return res.json(revertedProcess);
  }

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

  let completedDate = null;
  if (process.status === 'completed') {
    const completedAt = process.completed_at ? new Date(process.completed_at).getTime() : NaN;
    if (!Number.isFinite(completedAt) || Date.now() - completedAt > PROCESS_UNDO_WINDOW_MS) {
      return res.status(400).json({
        error: { message: '공정 완료 후 3일이 지나 되돌릴 수 없습니다.', status: 400 },
      });
    }
    completedDate = kstDateStr(process.completed_at);
  }

  const completedClaim = process.status === 'completed';
  const mutation = {
    sql: `WITH claimed_process AS (
            UPDATE processes p
               SET status = ${completedClaim ? "'in_progress'" : "'waiting'"},
                   started_at = ${completedClaim ? 'p.started_at' : 'NULL'},
                   started_by = ${completedClaim ? 'p.started_by' : 'NULL'},
                   completed_at = NULL,
                   completed_by = NULL,
                   completed_date = NULL
             WHERE p.id = ? AND p.status = ${completedClaim ? "'completed'" : "'in_progress'"}
            RETURNING p.*
          ),
          reverted_order AS (
            UPDATE orders o
               SET status = 'in_production', ship_date = NULL, updated_at = CURRENT_TIMESTAMP
              FROM claimed_process p
             WHERE o.id = p.order_id
               AND ?::BOOLEAN
               AND o.status = 'shipped'
               AND (?::TEXT IS NULL OR o.ship_date = ?::TEXT)
            RETURNING o.*, ?::TEXT AS reverted_ship_date
          ),
          deleted_shipping_job AS (
            DELETE FROM sheet_shipping_sync_jobs job
             USING reverted_order o
             WHERE job.order_id = o.id
            RETURNING job.order_id
          ),
          revert_activity AS (
            INSERT INTO activity_feed (order_id, action_type, description, actor)
            SELECT p.order_id,
                   '공정되돌리기',
                   o.client_name || ' - ' || p.step_name || ' 공정이 되돌려졌습니다.',
                   ?
              FROM claimed_process p
              JOIN orders o ON o.id = p.order_id
            RETURNING id
          )
          SELECT row_to_json(p) AS process_row,
                 COALESCE(
                   (SELECT row_to_json(o) FROM reverted_order o LIMIT 1),
                   row_to_json(current_order)
                 ) AS order_row,
                 (SELECT reverted_ship_date FROM reverted_order LIMIT 1) AS reverted_ship_date
            FROM claimed_process p
            LEFT JOIN orders current_order ON current_order.id = p.order_id`,
    args: [
      id,
      completedClaim && process.step_name === '출고',
      completedDate,
      completedDate,
      completedDate,
      auditActor,
    ],
  };
  const [mutationResult] = await db.atomicBatch([mutation]);
  const committed = mutationResult.rows[0];
  if (!committed) {
    return res.status(409).json({ error: { message: '이미 다른 작업자가 처리한 공정입니다.', status: 409 } });
  }

  if (committed.reverted_ship_date && committed.order_row) {
    try {
      await clearShippedSheet(committed.order_row, committed.reverted_ship_date);
    } catch (e) {
      console.warn('[revert] 시트 출고완료 표시 제거 실패(무시):', e?.message || e);
    }
  }

  res.json(committed.process_row);
}

export default cors(handleRevertProcess);
