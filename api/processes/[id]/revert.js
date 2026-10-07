import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { STEPS } from '../../_lib/steps.js';
import { requireWorkerAction } from '../../_lib/auth.js';
import { clearShippedOnSheet } from '../../_lib/googleSheets.js';

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

  const id = req.query.id;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: { message: '유효한 공정 ID가 필요합니다.', status: 400 } });
  }

  const db = dependencies.db || getDb();
  const clearShippedSheet = dependencies.clearShippedSheet || clearShippedOnSheet;
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
                )
                SELECT p.*, o.work_instruction_revision
                  FROM mutated_process p
                  JOIN invalidated_order o ON o.id = p.order_id`,
          args: [id, now, ...laterSteps],
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

    try {
      await db.execute({
        sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
        args: [
          lockedProcess.order_id,
          '공정되돌리기',
          `${lockedOrder.client_name} - 도면설계 공정이 되돌려졌습니다.`,
          actor || workerAction.actor,
        ],
      });
    } catch (e) {
      console.error('활동 로그 기록 실패:', e);
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

  // 실제로 shipped -> in_production 으로 되돌린 주문의 직전 출고일(KST). 되돌리지 못했으면 null.
  let revertedShipDate = null;

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
      // 활동로그 문구에 기대지 않는다. directShipping(영업 ship / 작업자 worker-ship)은
      // '출고 공정 완료' 마커를 남기지 않아 그 경로로 출고한 건이 영영 되돌아가지 않았다.
      // 출고 공정을 되돌리는데 주문이 shipped 라면 되돌리는 것이 맞다 — 주문 상태를 직접 조건으로 쓴다.
      const completedDate = kstDateStr(process.completed_at);
      const { rows: revertedOrders } = await db.execute({
        sql: `UPDATE orders
              SET status = 'in_production', ship_date = NULL, updated_at = CURRENT_TIMESTAMP
              WHERE id = ? AND status = 'shipped' AND (? IS NULL OR ship_date = ?)
              RETURNING id`,
        args: [process.order_id, completedDate, completedDate],
      });
      if (revertedOrders.length > 0) {
        // WHERE 절이 ship_date = completedDate 를 보장하므로 시트에 적힌 값도 이 날짜다.
        revertedShipDate = completedDate;
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

  // 주문 상태를 실제로 되돌린 경우에만 출고 흔적을 정리한다. 정리는 전부 fail-open —
  // 실패해도 되돌리기 자체는 성공으로 응답해야 한다.
  if (revertedShipDate) {
    // 대기 중인 잡을 지우지 않으면 크론이 나중에 미출고 주문에 '출고완료'를 기입한다.
    try {
      await db.execute({
        sql: 'DELETE FROM sheet_shipping_sync_jobs WHERE order_id = ?',
        args: [process.order_id],
      });
    } catch (e) {
      console.warn('[revert] 출고 시트 동기화 잡 삭제 실패(무시):', e?.message || e);
    }

    if (order) {
      try {
        await clearShippedSheet(order, revertedShipDate);
      } catch (e) {
        console.warn('[revert] 시트 출고완료 표시 제거 실패(무시):', e?.message || e);
      }
    }
  }

  const { rows: updatedRows } = await db.execute({
    sql: 'SELECT * FROM processes WHERE id = ?',
    args: [id]
  });

  res.json(updatedRows[0]);
}

export default cors(handleRevertProcess);
