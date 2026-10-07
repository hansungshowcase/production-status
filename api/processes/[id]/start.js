import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { STEPS } from '../../_lib/steps.js';
import { requireWorkerAction } from '../../_lib/auth.js';
import { hasValidWorkInstructionReceipt } from '../../../shared/workInstructionReceipt.js';

// 핸들러 안에서 지역변수 process(공정 row)가 Node 전역 process를 가리므로 환경변수는 모듈 레벨에서 읽는다
const NOTIFY_STARTED_ENABLED = process.env.NOTIFY_STARTED === '1';

async function defaultInternalStartNotify(db, payload) {
  const { notifyInternalProcessStart } = await import('../../_lib/internalProductionAlerts.js');
  return notifyInternalProcessStart(db, payload);
}

export async function handleStartProcess(req, res, dependencies = {}) {
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
  const notifyInternalStart = dependencies.notifyInternalStart || defaultInternalStartNotify;
  const { work_date, actor, assigned_worker, assigned_team } = req.body || {};

  // Validate required fields
  if (assigned_worker !== undefined && typeof assigned_worker !== 'string') {
    return res.status(400).json({ error: { message: '담당 작업자는 글자로 입력해야 합니다.', status: 400 } });
  }
  if (assigned_team !== undefined && typeof assigned_team !== 'string') {
    return res.status(400).json({ error: { message: '담당 팀은 글자로 입력해야 합니다.', status: 400 } });
  }

  // Find process
  const { rows: processRows } = await db.execute({
    sql: 'SELECT * FROM processes WHERE id = ?',
    args: [id]
  });
  if (processRows.length === 0) {
    return res.status(404).json({ error: { message: '공정을 찾을 수 없습니다.', status: 404 } });
  }
  const process = processRows[0];

  const now = new Date().toISOString();
  const requestedWorker = actor || assigned_worker || workerAction.actor;
  const workerName = process.step_name === '도면설계' ? '김보수 팀장' : requestedWorker;

  if (process.step_name === '레이저작업') {
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
          sql: `SELECT id, order_id, step_name, status
                  FROM processes
                 WHERE order_id = (SELECT order_id FROM processes WHERE id = ?)
                 ORDER BY id`,
          args: [id],
        },
        {
          sql: `WITH input AS (
                  SELECT ?::BIGINT AS process_id,
                         ?::TEXT AS started_at,
                         ?::TEXT AS worker_name
                ),
                eligible AS (
                  SELECT p.id, p.order_id
                    FROM processes p
                    JOIN orders o ON o.id = p.order_id
                    JOIN input i ON i.process_id = p.id
                   WHERE p.step_name = '레이저작업'
                     AND p.status = 'waiting'
                     AND o.status = 'in_production'
                     AND o.work_instruction_received_revision = o.work_instruction_revision
                     AND o.work_instruction_received_at IS NOT NULL
                     AND NULLIF(BTRIM(o.work_instruction_received_by), '') IS NOT NULL
                     AND EXISTS (
                       SELECT 1 FROM processes p_draw
                        WHERE p_draw.order_id = o.id AND p_draw.step_name = '도면설계'
                     )
                     AND NOT EXISTS (
                       SELECT 1 FROM processes p_draw
                        WHERE p_draw.order_id = o.id
                          AND p_draw.step_name = '도면설계'
                          AND p_draw.status != 'completed'
                     )
                     AND (
                       SELECT COUNT(*) FROM processes p_laser
                        WHERE p_laser.order_id = o.id AND p_laser.step_name = '레이저작업'
                     ) = 1
                ),
                updated AS (
                  UPDATE processes p
                     SET status = 'in_progress',
                         started_at = i.started_at,
                         started_by = i.worker_name
                    FROM eligible e, input i
                   WHERE p.id = e.id
                   RETURNING p.*
                ),
                logged AS (
                  INSERT INTO activity_feed (order_id, action_type, description, actor)
                  SELECT u.order_id,
                         '공정시작',
                         o.client_name || ' - 레이저작업 공정이 시작되었습니다. (담당: ' || u.started_by || ')',
                         u.started_by
                    FROM updated u
                    JOIN orders o ON o.id = u.order_id
                  RETURNING id
                )
                SELECT u.*, EXISTS (SELECT 1 FROM logged) AS activity_logged
                  FROM updated u`,
          args: [id, work_date || now, workerName],
        },
      ]);
    } catch (error) {
      const status = error.status || 500;
      return res.status(status).json({
        error: { message: error.publicMessage || '레이저 공정 시작에 실패했습니다.', status },
      });
    }

    const order = resultSets[0]?.rows?.[0];
    const lockedProcesses = resultSets[1]?.rows || [];
    const updatedProcess = resultSets[2]?.rows?.[0];
    if (!order) {
      return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
    }
    const lockedLaserRows = lockedProcesses.filter((row) => row.step_name === '레이저작업');
    const lockedProcess = lockedProcesses.find((row) => String(row.id) === String(id));
    if (!lockedProcess || lockedProcess.status !== 'waiting') {
      return res.status(409).json({ error: { message: '이미 다른 작업자가 시작한 공정입니다.', status: 409 } });
    }
    if (!hasValidWorkInstructionReceipt(order)) {
      return res.status(409).json({
        error: { message: '작업지시서 수령 확인 후 레이저 공정을 시작할 수 있습니다.', status: 409 },
      });
    }
    const drawingRows = lockedProcesses.filter((row) => row.step_name === '도면설계');
    if (drawingRows.length === 0 || drawingRows.some((row) => row.status !== 'completed')) {
      return res.status(400).json({
        error: { message: '이전 공정이 모두 완료되어야 시작할 수 있습니다.', status: 400 },
      });
    }
    if (lockedLaserRows.length !== 1) {
      return res.status(409).json({
        error: { message: '레이저 공정이 중복되어 시작할 수 없습니다.', status: 409 },
      });
    }
    if (!updatedProcess) {
      return res.status(409).json({ error: { message: '이미 다른 작업자가 시작한 공정입니다.', status: 409 } });
    }

    try {
      await notifyInternalStart(db, {
        order,
        process: updatedProcess,
        workerName,
      });
    } catch (e) {
      console.error('[start] 레이저 내부 알림 발송 실패(무시):', e?.message || e);
    }
    return res.json(updatedProcess);
  }

  if (process.status !== 'waiting') {
    return res.status(400).json({ error: { message: '대기 상태의 공정만 시작할 수 있습니다.', status: 400 } });
  }

  // Validate that all previous steps are completed
  const { rows: allProcesses } = await db.execute({
    sql: 'SELECT * FROM processes WHERE order_id = ?',
    args: [process.order_id]
  });

  const currentIndex = STEPS.indexOf(process.step_name);
  if (currentIndex === -1) {
    return res.status(400).json({ error: { message: '유효하지 않은 공정입니다.', status: 400 } });
  }
  const incompletePrereqs = STEPS
    .slice(0, currentIndex)
    .filter((step) => {
      const matches = allProcesses.filter((p) => p.step_name === step);
      return matches.length === 0 || matches.some((p) => p.status !== 'completed');
    });
  if (incompletePrereqs.length > 0) {
    return res.status(400).json({
      error: {
        message: '이전 공정이 모두 완료되어야 시작할 수 있습니다.',
        status: 400,
      },
    });
  }

  // Atomic update: only update if still 'waiting' (prevents double-click race condition)
  const { rows: updateResult } = await db.execute({
    sql: `UPDATE processes SET status = 'in_progress', started_at = ?, started_by = ? WHERE id = ? AND status = 'waiting' RETURNING id`,
    args: [work_date || now, workerName, id]
  });
  if (updateResult.length === 0) {
    return res.status(409).json({ error: { message: '이미 다른 작업자가 시작한 공정입니다.', status: 409 } });
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
          '공정시작',
          `${order.client_name} - ${process.step_name} 공정이 시작되었습니다. (담당: ${workerName})`,
          workerName
        ]
      });
    } catch (e) {
      console.error('활동 로그 기록 실패:', e);
    }
  }

  if (order) {
    try {
      await notifyInternalStart(db, {
        order,
        process: {
          ...process,
          status: 'in_progress',
          started_at: work_date || now,
          started_by: workerName,
        },
        workerName,
      });
    } catch (e) {
      console.error('[start] 조립팀 내부 알림 발송 실패(무시):', e?.message || e);
    }
  }

  // 알림 훅: 해당 주문의 최초 공정 시작 + NOTIFY_STARTED=1 → started (실패해도 본 응답에 영향 없음)
  // allProcesses는 UPDATE 이전 스냅샷 — 전부 waiting이었다면 이번이 첫 시작
  if (NOTIFY_STARTED_ENABLED && order && allProcesses.every((p) => p.status === 'waiting')) {
    try {
      const { maybeNotify } = await import('../../_lib/notify.js');
      await maybeNotify(db, order, 'started');
    } catch (e) {
      console.error('[start] started 알림 발송 실패(무시):', e?.message || e);
    }
  }

  const { rows: updatedRows } = await db.execute({
    sql: 'SELECT * FROM processes WHERE id = ?',
    args: [id]
  });

  res.json(updatedRows[0]);
}

export default cors(handleStartProcess);
