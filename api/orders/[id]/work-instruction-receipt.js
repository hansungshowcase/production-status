import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { requireWorkerAction } from '../../_lib/auth.js';
import {
  hasValidWorkInstructionReceipt,
  isWorkInstructionReceiver,
} from '../../../shared/workInstructionReceipt.js';

const DOWNSTREAM_STEPS = [
  'V-커팅작업',
  '절곡작업',
  '용접작업',
  '분체작업',
  '조립작업',
  '설비작업',
  '포장',
  '출고',
];

function errorResponse(res, status, message) {
  return res.status(status).json({ error: { message, status } });
}

function receiptResponse(order, idempotent) {
  return {
    order_id: order.id,
    work_instruction_revision: order.work_instruction_revision,
    work_instruction_received_revision: order.work_instruction_received_revision,
    work_instruction_received_at: order.work_instruction_received_at,
    work_instruction_received_by: order.work_instruction_received_by,
    receipt_valid: hasValidWorkInstructionReceipt(order),
    idempotent,
  };
}

export async function handleWorkInstructionReceipt(req, res, dependencies = {}) {
  if (req.method !== 'PATCH') {
    return errorResponse(res, 405, 'Method not allowed');
  }
  const checkRateLimit = dependencies.rateLimitCheck || rateLimitCheck;
  if (!checkRateLimit(req, res)) return;
  const workerAction = dependencies.requireWorkerAction
    ? dependencies.requireWorkerAction(req, res)
    : requireWorkerAction(req, res);
  if (!workerAction) return;

  const id = Number(req.query.id);
  if (!Number.isInteger(id) || id <= 0) {
    return errorResponse(res, 400, '유효한 주문 ID가 필요합니다.');
  }
  const expectedRevisionInput = req.body?.expected_revision;
  const expectedRevision = Number(expectedRevisionInput);
  if (expectedRevisionInput === null
    || expectedRevisionInput === undefined
    || String(expectedRevisionInput).trim() === ''
    || !Number.isInteger(expectedRevision)
    || expectedRevision < 0) {
    return errorResponse(res, 400, '현재 작업지시서 개정 번호가 필요합니다.');
  }

  const receiver = String(workerAction.actor || '').trim();
  if (!isWorkInstructionReceiver(receiver)) {
    return errorResponse(res, 403, '작업지시서 수령 권한이 없습니다.');
  }

  const db = dependencies.db || getDb();
  let resultSets;
  try {
    resultSets = await db.atomicBatch([
      {
        sql: `SELECT id, client_name, status,
                     work_instruction_revision,
                     work_instruction_received_revision,
                     work_instruction_received_at,
                     work_instruction_received_by
                FROM orders
               WHERE id = ?
               FOR UPDATE`,
        args: [id],
      },
      {
        sql: `SELECT id, order_id, step_name, status
                FROM processes
               WHERE order_id = ?
               ORDER BY id`,
        args: [id],
      },
      {
        sql: `WITH input AS (
                SELECT ?::BIGINT AS order_id,
                       ?::INTEGER AS expected_revision,
                       ?::TEXT AS receiver
              ),
              eligible AS (
                SELECT o.id, o.client_name
                  FROM orders o
                  JOIN input i ON i.order_id = o.id
                 WHERE o.status = 'in_production'
                   AND o.work_instruction_revision = i.expected_revision
                   AND NOT COALESCE((
                     o.work_instruction_received_revision = o.work_instruction_revision
                     AND o.work_instruction_received_at IS NOT NULL
                     AND NULLIF(BTRIM(o.work_instruction_received_by), '') IS NOT NULL
                   ), FALSE)
                   AND EXISTS (
                     SELECT 1 FROM processes p
                      WHERE p.order_id = o.id AND p.step_name = '도면설계'
                   )
                   AND NOT EXISTS (
                     SELECT 1 FROM processes p
                      WHERE p.order_id = o.id
                        AND p.step_name = '도면설계'
                        AND p.status != 'completed'
                   )
                   AND (
                     SELECT COUNT(*) FROM processes p
                      WHERE p.order_id = o.id AND p.step_name = '레이저작업'
                   ) = 1
                   AND (
                     SELECT COUNT(*) FROM processes p
                      WHERE p.order_id = o.id
                        AND p.step_name = '레이저작업'
                        AND p.status = 'waiting'
                   ) = 1
                   AND NOT EXISTS (
                     SELECT 1 FROM processes p
                      WHERE p.order_id = o.id
                        AND p.step_name IN (${DOWNSTREAM_STEPS.map(() => '?').join(', ')})
                        AND p.status IN ('in_progress', 'completed')
                   )
              ),
              updated AS (
                UPDATE orders o
                   SET work_instruction_received_revision = o.work_instruction_revision,
                       work_instruction_received_at = CURRENT_TIMESTAMP,
                       work_instruction_received_by = i.receiver,
                       updated_at = CURRENT_TIMESTAMP
                  FROM eligible e, input i
                 WHERE o.id = e.id
                 RETURNING o.id, o.client_name, o.work_instruction_revision,
                           o.work_instruction_received_revision,
                           o.work_instruction_received_at,
                           o.work_instruction_received_by
              ),
              logged AS (
                INSERT INTO activity_feed (order_id, action_type, description, actor)
                SELECT u.id,
                       '작업지시서수령',
                       u.client_name || ' - 작업지시서를 받았습니다. (수령: ' || u.work_instruction_received_by || ')',
                       u.work_instruction_received_by
                  FROM updated u
                RETURNING id
              )
              SELECT u.*, EXISTS (SELECT 1 FROM logged) AS receipt_logged
                FROM updated u`,
        args: [id, expectedRevision, receiver, ...DOWNSTREAM_STEPS],
      },
    ]);
  } catch (error) {
    const status = error.status || 500;
    return errorResponse(res, status, error.publicMessage || '작업지시서 수령 처리에 실패했습니다.');
  }

  const lockedOrder = resultSets[0]?.rows?.[0];
  const processes = resultSets[1]?.rows || [];
  const updatedOrder = resultSets[2]?.rows?.[0];
  if (!lockedOrder) return errorResponse(res, 404, '주문을 찾을 수 없습니다.');
  if (Number(lockedOrder.work_instruction_revision) !== expectedRevision) {
    return errorResponse(res, 409, '도면이 변경되었습니다. 새로고침 후 다시 확인해 주세요.');
  }
  if (hasValidWorkInstructionReceipt(lockedOrder)) {
    return res.json(receiptResponse(lockedOrder, true));
  }
  if (lockedOrder.status !== 'in_production') {
    return errorResponse(res, 409, '생산 중인 주문만 작업지시서를 받을 수 있습니다.');
  }

  const drawings = processes.filter((process) => process.step_name === '도면설계');
  if (drawings.length === 0 || drawings.some((process) => process.status !== 'completed')) {
    return errorResponse(res, 409, '도면 공정이 모두 완료된 주문만 받을 수 있습니다.');
  }
  const lasers = processes.filter((process) => process.step_name === '레이저작업');
  if (lasers.length !== 1) {
    return errorResponse(res, 409, '레이저 공정이 없거나 중복되어 수령할 수 없습니다.');
  }
  if (lasers[0].status !== 'waiting') {
    return errorResponse(res, 409, '레이저 대기 상태의 주문만 받을 수 있습니다.');
  }
  const downstreamStarted = processes.some((process) => (
    DOWNSTREAM_STEPS.includes(process.step_name)
    && (process.status === 'in_progress' || process.status === 'completed')
  ));
  if (downstreamStarted) {
    return errorResponse(res, 409, '이후 공정이 이미 진행되어 작업지시서를 받을 수 없습니다.');
  }
  if (!updatedOrder) {
    return errorResponse(res, 409, '다른 작업이 동시에 처리되었습니다. 새로고침 후 다시 시도해 주세요.');
  }
  return res.json(receiptResponse(updatedOrder, false));
}

export default cors(handleWorkInstructionReceipt);
