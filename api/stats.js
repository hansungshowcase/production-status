import { getDb } from './_lib/db.js';
import { cors } from './_lib/cors.js';
import { STEPS } from './_lib/steps.js';
import { daysUntilDue } from './_lib/daysUntilDue.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const db = getDb();

  const totalResult = await db.execute({ sql: 'SELECT COUNT(*) AS count FROM orders', args: [] });
  const total_orders = totalResult.rows[0].count;

  const inProdResult = await db.execute({ sql: "SELECT COUNT(*) AS count FROM orders WHERE status = 'in_production'", args: [] });
  const in_production = inProdResult.rows[0].count;

  const shippedResult = await db.execute({ sql: "SELECT COUNT(*) AS count FROM orders WHERE status = 'shipped'", args: [] });
  const shipped = shippedResult.rows[0].count;

  const waitingResult = await db.execute({ sql: "SELECT COUNT(*) AS count FROM processes WHERE status = 'waiting'", args: [] });
  const waiting = waitingResult.rows[0].count;

  const inProgressResult = await db.execute({ sql: "SELECT COUNT(*) AS count FROM processes WHERE status = 'in_progress'", args: [] });
  const in_progress = inProgressResult.rows[0].count;

  const completedResult = await db.execute({ sql: "SELECT COUNT(*) AS count FROM processes WHERE status = 'completed'", args: [] });
  const completed = completedResult.rows[0].count;

  const openIssuesResult = await db.execute({ sql: 'SELECT COUNT(*) AS count FROM issues WHERE resolved_at IS NULL', args: [] });
  const open_issues = openIssuesResult.rows[0].count;

  // Per-step breakdown with actionable count
  const byStepResult = await db.execute({
    sql: `SELECT step_name,
      SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting,
      SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
      SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
    FROM processes
    GROUP BY step_name
    ORDER BY MIN(id)`,
    args: [],
  });

  const by_step = [];
  for (const row of byStepResult.rows) {
    const stepIndex = STEPS.indexOf(row.step_name);
    if (stepIndex <= 0) {
      by_step.push({ ...row, actionable: Number(row.waiting) + Number(row.in_progress) });
    } else {
      const prevSteps = STEPS.slice(0, stepIndex);
      const placeholders = prevSteps.map(() => '?').join(',');
      const actionableResult = await db.execute({
        sql: `SELECT COUNT(*) AS cnt FROM processes p
              JOIN orders o ON o.id = p.order_id
              WHERE p.step_name = ? AND p.status IN ('waiting', 'in_progress')
                AND o.status = 'in_production'
                AND (SELECT COUNT(*) FROM processes p2
                     WHERE p2.order_id = p.order_id
                       AND p2.step_name IN (${placeholders})
                       AND p2.status != 'completed') = 0`,
        args: [row.step_name, ...prevSteps],
      });
      by_step.push({ ...row, actionable: actionableResult.rows[0].cnt });
    }
  }

  // Per sales person
  const bySalesResult = await db.execute({
    sql: `SELECT sales_person,
      COUNT(*) AS total,
      SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END) AS shipped,
      SUM(CASE WHEN status = 'in_production' THEN 1 ELSE 0 END) AS in_production
    FROM orders
    WHERE sales_person IS NOT NULL
    GROUP BY sales_person
    ORDER BY total DESC`,
    args: [],
  });
  const by_sales_person = bySalesResult.rows;

  // Overdue and due-soon counts
  const activeOrdersResult = await db.execute({
    sql: "SELECT due_date FROM orders WHERE status != 'shipped'",
    args: [],
  });

  let overdue_count = 0;
  let due_soon_count = 0;
  for (const order of activeOrdersResult.rows) {
    const days = daysUntilDue(order.due_date);
    if (days === null) continue;
    if (days < 0) overdue_count++;
    else if (days <= 3) due_soon_count++;
  }

  return res.json({
    total_orders,
    in_production,
    shipped,
    process_stats: { waiting, in_progress, completed },
    open_issues,
    overdue_count,
    due_soon_count,
    by_step,
    by_sales_person,
  });
});
