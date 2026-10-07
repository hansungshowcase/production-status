import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { STEPS } from '../../_lib/steps.js';
import { WORK_INSTRUCTION_RECEIPT_PENDING_MODE } from '../../../shared/workInstructionReceipt.js';

function sqlString(value) {
  return `'${String(value).replace(/'/g, "''")}'`;
}

function stepOrderCase(alias) {
  const clauses = STEPS.map((step, index) => `WHEN ${sqlString(step)} THEN ${index}`).join(' ');
  return `CASE ${alias}.step_name ${clauses} ELSE 999 END`;
}

function stepListSql() {
  return STEPS.map(sqlString).join(', ');
}

export async function handleProcessesByStep(req, res, dependencies = {}) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const stepName = decodeURIComponent(req.query.stepName);
  if (!STEPS.includes(stepName)) {
    return res.status(400).json({
      error: { message: `유효하지 않은 공정명입니다. 유효한 공정: ${STEPS.join(', ')}`, status: 400 },
    });
  }
  const mode = req.query.mode || 'actionable';
  if (mode !== 'actionable' && mode !== WORK_INSTRUCTION_RECEIPT_PENDING_MODE) {
    return res.status(400).json({ error: { message: '유효하지 않은 조회 모드입니다.', status: 400 } });
  }
  if (mode === WORK_INSTRUCTION_RECEIPT_PENDING_MODE && stepName !== '레이저작업') {
    return res.status(400).json({
      error: { message: '작업지시서 수령 대기는 레이저 공정에서만 조회할 수 있습니다.', status: 400 },
    });
  }

  try {
    const db = dependencies.db || getDb();
    const stepIndex = STEPS.indexOf(stepName);
    const prevSteps = STEPS.slice(0, stepIndex);
    const downstreamSteps = STEPS.slice(stepIndex + 1);

    const args = [stepName];
    let filterClause = '';
    if (prevSteps.length > 0) {
      const placeholders = prevSteps.map(() => '?').join(',');
      filterClause = `AND NOT EXISTS (
        SELECT 1
        FROM processes p3
        WHERE p3.order_id = p.order_id
          AND p3.step_name IN (${placeholders})
          AND p3.status != 'completed'
      )
      AND (
        SELECT COUNT(DISTINCT p4.step_name)
        FROM processes p4
        WHERE p4.order_id = p.order_id
          AND p4.step_name IN (${placeholders})
          AND p4.status = 'completed'
      ) = ${prevSteps.length}`;
      args.push(...prevSteps, ...prevSteps);
    }

    let receiptFilterClause = '';
    let candidateStatusClause = "p.status IN ('waiting', 'in_progress')";
    if (stepName === '레이저작업' && mode === 'actionable') {
      receiptFilterClause = `AND (
        p.status = 'in_progress'
        OR (
          o.work_instruction_received_revision = o.work_instruction_revision
          AND o.work_instruction_received_at IS NOT NULL
          AND NULLIF(BTRIM(o.work_instruction_received_by), '') IS NOT NULL
        )
      )`;
    } else if (mode === WORK_INSTRUCTION_RECEIPT_PENDING_MODE) {
      candidateStatusClause = "p.status = 'waiting'";
      receiptFilterClause = `AND NOT COALESCE((
        o.work_instruction_received_revision = o.work_instruction_revision
        AND o.work_instruction_received_at IS NOT NULL
        AND NULLIF(BTRIM(o.work_instruction_received_by), '') IS NOT NULL
      ), FALSE)
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
      AND NOT EXISTS (
        SELECT 1 FROM processes p_after
        WHERE p_after.order_id = o.id
          AND p_after.step_name IN (${downstreamSteps.map(sqlString).join(', ')})
          AND p_after.status IN ('in_progress', 'completed')
      )`;
    }

    const { rows } = await db.execute({
      sql: `SELECT p.id AS process_id, p.step_name, p.status AS process_status,
             p.started_at, p.completed_at, p.started_by, p.completed_by,
             o.id AS order_id, o.client_name, o.product_type, o.door_type,
             o.width, o.depth, o.height, o.color, o.due_date, o.sales_person,
             o.order_date, o.created_at, o.quantity, o.design, o.phone,
             o.notes, o.remarks, o.etc_notes, o.sale_amount, o.lead_source,
             o.ship_scheduled_date, o.safe_delivery, o.sms_sent,
             o.work_instruction_revision, o.work_instruction_received_revision,
             o.work_instruction_received_at, o.work_instruction_received_by,
             COALESCE((o.work_instruction_received_revision = o.work_instruction_revision
               AND o.work_instruction_received_at IS NOT NULL
               AND NULLIF(BTRIM(o.work_instruction_received_by), '') IS NOT NULL), FALSE) AS receipt_valid,
             ${mode === WORK_INSTRUCTION_RECEIPT_PENDING_MODE ? 'TRUE' : 'FALSE'} AS work_instruction_receipt_pending,
             CASE WHEN o.work_order_image_url IS NULL OR o.work_order_image_url = '' THEN 0 ELSE 1 END AS has_work_order_image,
             (SELECT ph.file_path
              FROM photos ph
              JOIN processes pp ON pp.id = ph.process_id
              WHERE pp.order_id = o.id AND pp.step_name = '포장'
              ORDER BY ph.uploaded_at DESC
              LIMIT 1) AS packing_photo_url,
             (SELECT COUNT(DISTINCT p2.step_name) FROM processes p2 WHERE p2.order_id = o.id AND p2.step_name IN (${stepListSql()}) AND p2.status = 'completed') AS completed_steps,
             (SELECT COUNT(DISTINCT p2.step_name) FROM processes p2 WHERE p2.order_id = o.id AND p2.step_name IN (${stepListSql()})) AS total_steps,
             (SELECT COUNT(*) FROM issues i WHERE i.order_id = o.id AND i.resolved_at IS NULL) AS open_issues,
             COALESCE(ph.step_history, '[]'::jsonb) AS step_history
      FROM (
        SELECT *
        FROM (
          SELECT p.*,
            ROW_NUMBER() OVER (
              PARTITION BY p.order_id, p.step_name
              ORDER BY
                CASE p.status
                  WHEN 'in_progress' THEN 0
                  WHEN 'waiting' THEN 1
                  ELSE 2
                END,
                p.id DESC
            ) AS rn
          FROM processes p
          WHERE p.step_name = ? AND ${candidateStatusClause}
        ) ranked_current
        WHERE rn = 1
      ) p
      JOIN orders o ON o.id = p.order_id
      LEFT JOIN (
        SELECT order_id,
          jsonb_agg(
            jsonb_build_object(
              'id', id,
              'step_name', step_name,
              'status', status,
              'started_by', started_by,
              'completed_by', completed_by,
              'completed_at', completed_at
            )
            ORDER BY ${stepOrderCase('processes')}, id
          ) AS step_history
        FROM processes
        GROUP BY order_id
      ) ph ON ph.order_id = o.id
      WHERE o.status = 'in_production'
        ${filterClause}
        ${receiptFilterClause}
      ORDER BY
        CASE WHEN o.due_date IS NULL OR o.due_date = '' THEN 1 ELSE 0 END,
        o.due_date ASC,
        o.id DESC`,
      args,
    });

    res.json(rows.map(row => ({
      ...row,
      step_history: typeof row.step_history === 'string'
        ? JSON.parse(row.step_history)
        : (row.step_history || []),
    })));
  } catch (err) {
    console.error('by-step error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: { message: err.publicMessage || '공정 데이터 조회에 실패했습니다.', status } });
  }
}

export default cors(handleProcessesByStep);
