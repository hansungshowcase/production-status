import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';

const STEPS = ['도면설계', '레이저작업', 'V-커팅작업', '절곡작업', '용접작업', '분체작업', '조립작업', '설비작업', '포장'];

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

  const db = getDb();
  const stepIndex = STEPS.indexOf(stepName);

  // Main query
  const { rows } = await db.execute({
    sql: `SELECT p.id AS process_id, p.step_name, p.status AS process_status,
           p.started_at, p.completed_at, p.started_by, p.completed_by,
           o.id AS order_id, o.client_name, o.product_type, o.door_type,
           o.width, o.depth, o.height, o.color, o.due_date, o.sales_person,
           o.order_date, o.quantity, o.design, o.notes, o.remarks,
           (SELECT COUNT(*) FROM processes p2 WHERE p2.order_id = o.id AND p2.status = 'completed') AS completed_steps,
           (SELECT COUNT(*) FROM processes p2 WHERE p2.order_id = o.id) AS total_steps,
           (SELECT COUNT(*) FROM issues i WHERE i.order_id = o.id AND i.resolved_at IS NULL) AS open_issues
    FROM processes p
    JOIN orders o ON o.id = p.order_id
    WHERE p.step_name = ? AND p.status IN ('waiting', 'in_progress')
      AND o.status = 'in_production'
    ORDER BY o.due_date ASC`,
    args: [stepName]
  });

  // Filter: only include processes where all previous steps are completed
  let filtered = rows;
  if (stepIndex > 0) {
    const prevSteps = STEPS.slice(0, stepIndex);
    const results = [];
    for (const row of rows) {
      const placeholders = prevSteps.map(() => '?').join(',');
      const check = await db.execute({
        sql: `SELECT COUNT(*) AS cnt FROM processes WHERE order_id = ? AND step_name IN (${placeholders}) AND status != 'completed'`,
        args: [row.order_id, ...prevSteps]
      });
      if (Number(check.rows[0].cnt) === 0) {
        results.push(row);
      }
    }
    filtered = results;
  }

  // Attach all previous steps completion history
  const prevStepNames = STEPS.slice(0, stepIndex);
  const result = [];
  for (const row of filtered) {
    if (prevStepNames.length === 0) {
      result.push({ ...row, step_history: [] });
      continue;
    }
    const placeholders = prevStepNames.map(() => '?').join(',');
    const history = await db.execute({
      sql: `SELECT step_name, completed_by, completed_at FROM processes WHERE order_id = ? AND step_name IN (${placeholders}) AND status = 'completed' ORDER BY id ASC`,
      args: [row.order_id, ...prevStepNames]
    });
    result.push({
      ...row,
      step_history: history.rows.map(h => ({
        step_name: h.step_name,
        completed_by: h.completed_by || null,
        completed_at: h.completed_at || null,
      })),
    });
  }

  res.json(result);
});
