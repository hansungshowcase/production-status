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

  // Per-step breakdown with actionable count (single query)
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

  // Get actionable counts for all steps in a single query
  const actionableResult = await db.execute({
    sql: `SELECT p.step_name, COUNT(*) AS cnt
          FROM processes p
          JOIN orders o ON o.id = p.order_id
          WHERE p.status IN ('waiting', 'in_progress')
            AND o.status = 'in_production'
            AND NOT EXISTS (
              SELECT 1 FROM processes p2
              WHERE p2.order_id = p.order_id
                AND p2.status != 'completed'
                AND p2.id < p.id
                AND p2.step_name != p.step_name
            )
          GROUP BY p.step_name`,
    args: [],
  });

  const actionableMap = {};
  for (const row of actionableResult.rows) {
    actionableMap[row.step_name] = Number(row.cnt);
  }

  const by_step = byStepResult.rows.map(row => ({
    ...row,
    actionable: actionableMap[row.step_name] || 0,
  }));

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

  // Overdue and due-soon counts (SQL로 계산)
  const overdueResult = await db.execute({
    sql: "SELECT COUNT(*) AS count FROM orders WHERE status != 'shipped' AND due_date IS NOT NULL AND due_date < CURRENT_DATE",
    args: [],
  });
  const overdue_count = overdueResult.rows[0].count;

  const dueSoonResult = await db.execute({
    sql: "SELECT COUNT(*) AS count FROM orders WHERE status != 'shipped' AND due_date IS NOT NULL AND due_date >= CURRENT_DATE AND due_date <= CURRENT_DATE + INTERVAL '3 days'",
    args: [],
  });
  const due_soon_count = dueSoonResult.rows[0].count;

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
