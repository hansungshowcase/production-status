import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { STEPS } from '../../_lib/steps.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const stepName = decodeURIComponent(req.query.stepName);
  if (!STEPS.includes(stepName)) {
    return res.status(400).json({
      error: { message: `유효하지 않은 공정명입니다. 유효한 공정: ${STEPS.join(', ')}`, status: 400 },
    });
  }

  try {
    const db = getDb();
    const stepIndex = STEPS.indexOf(stepName);
    const prevSteps = STEPS.slice(0, stepIndex);

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
      )`;
      args.push(...prevSteps);
    }

    const { rows } = await db.execute({
      sql: `SELECT p.id AS process_id, p.step_name, p.status AS process_status,
             p.started_at, p.completed_at, p.started_by, p.completed_by,
             o.id AS order_id, o.client_name, o.product_type, o.door_type,
             o.width, o.depth, o.height, o.color, o.due_date, o.sales_person,
             o.order_date, o.created_at, o.quantity, o.design, o.notes, o.remarks,
             o.work_order_image_url,
             (SELECT ph.file_path
              FROM photos ph
              JOIN processes pp ON pp.id = ph.process_id
              WHERE pp.order_id = o.id AND pp.step_name = '포장'
              ORDER BY ph.uploaded_at DESC
              LIMIT 1) AS packing_photo_url,
             (SELECT COUNT(*) FROM processes p2 WHERE p2.order_id = o.id AND p2.status = 'completed') AS completed_steps,
             (SELECT COUNT(*) FROM processes p2 WHERE p2.order_id = o.id) AS total_steps,
             (SELECT COUNT(*) FROM issues i WHERE i.order_id = o.id AND i.resolved_at IS NULL) AS open_issues
      FROM processes p
      JOIN orders o ON o.id = p.order_id
      WHERE p.step_name = ? AND p.status IN ('waiting', 'in_progress')
        AND o.status = 'in_production'
        ${filterClause}
      ORDER BY o.id DESC`,
      args,
    });

    res.json(rows.map(row => ({ ...row, step_history: [] })));
  } catch (err) {
    console.error('by-step error:', err);
    const status = err.status || 500;
    res.status(status).json({ error: { message: err.publicMessage || '공정 데이터 조회에 실패했습니다.', status } });
  }
});
