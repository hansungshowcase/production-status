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

    // Single query: main data + previous steps filter (NOT EXISTS)
    const args = [stepName];
    let filterClause = '';
    if (prevSteps.length > 0) {
      const placeholders = prevSteps.map(() => '?').join(',');
      filterClause = `AND NOT EXISTS (SELECT 1 FROM processes p3 WHERE p3.order_id = p.order_id AND p3.step_name IN (${placeholders}) AND p3.status != 'completed')`;
      args.push(...prevSteps);
    }

    const { rows } = await db.execute({
      sql: `SELECT p.id AS process_id, p.step_name, p.status AS process_status,
             p.started_at, p.completed_at, p.started_by, p.completed_by,
             o.id AS order_id, o.client_name, o.product_type, o.door_type,
             o.width, o.depth, o.height, o.color, o.due_date, o.sales_person,
             o.order_date, o.created_at, o.quantity, o.design, o.notes, o.remarks,
             (SELECT COUNT(*) FROM processes p2 WHERE p2.order_id = o.id AND p2.status = 'completed') AS completed_steps,
             (SELECT COUNT(*) FROM processes p2 WHERE p2.order_id = o.id) AS total_steps,
             (SELECT COUNT(*) FROM issues i WHERE i.order_id = o.id AND i.resolved_at IS NULL) AS open_issues
      FROM processes p
      JOIN orders o ON o.id = p.order_id
      WHERE p.step_name = ? AND p.status IN ('waiting', 'in_progress')
        AND o.status = 'in_production'
        ${filterClause}
      ORDER BY o.id DESC`,
      args
    });

    // Batch fetch step history (1 query instead of N)
    if (prevSteps.length > 0 && rows.length > 0) {
      const orderIds = rows.map(r => r.order_id);
      const orderPlaceholders = orderIds.map(() => '?').join(',');
      const stepPlaceholders = prevSteps.map(() => '?').join(',');
      const historyResult = await db.execute({
        sql: `SELECT order_id, step_name, completed_by, completed_at FROM processes WHERE order_id IN (${orderPlaceholders}) AND step_name IN (${stepPlaceholders}) AND status = 'completed' ORDER BY id ASC`,
        args: [...orderIds, ...prevSteps]
      });

      const historyMap = {};
      for (const h of historyResult.rows) {
        if (!historyMap[h.order_id]) historyMap[h.order_id] = [];
        historyMap[h.order_id].push({
          step_name: h.step_name,
          completed_by: h.completed_by || null,
          completed_at: h.completed_at || null,
        });
      }

      return res.json(rows.map(row => ({
        ...row,
        step_history: historyMap[row.order_id] || [],
      })));
    }

    // stepIndex 0 (도면설계) or no results — no history needed
    res.json(rows.map(row => ({ ...row, step_history: [] })));
  } catch (err) {
    console.error('by-step error:', err);
    res.status(500).json({ error: { message: '공정 데이터 조회에 실패했습니다.', status: 500 } });
  }
});
