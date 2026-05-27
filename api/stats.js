import { getDb } from './_lib/db.js';
import { cors } from './_lib/cors.js';
import { STEPS } from './_lib/steps.js';
import { daysUntilDue } from './_lib/daysUntilDue.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const db = getDb();

  // 11개 직렬 await → Promise.all 병렬 (응답 1~3초 → 0.3~0.5초)
  const [
    totalResult, inProdResult, shippedResult,
    waitingResult, inProgressResult, completedResult,
    openIssuesResult, byStepResult, actionableResult,
    bySalesResult, overdueResult, dueSoonResult, delayedByStepResult, delayedOrdersResult,
  ] = await Promise.all([
    db.execute({ sql: 'SELECT COUNT(*) AS count FROM orders', args: [] }),
    db.execute({ sql: "SELECT COUNT(*) AS count FROM orders WHERE status = 'in_production'", args: [] }),
    db.execute({ sql: "SELECT COUNT(*) AS count FROM orders WHERE status = 'shipped'", args: [] }),
    db.execute({ sql: "SELECT COUNT(*) AS count FROM processes WHERE status = 'waiting'", args: [] }),
    db.execute({ sql: "SELECT COUNT(*) AS count FROM processes WHERE status = 'in_progress'", args: [] }),
    db.execute({ sql: "SELECT COUNT(*) AS count FROM processes WHERE status = 'completed'", args: [] }),
    db.execute({ sql: 'SELECT COUNT(*) AS count FROM issues WHERE resolved_at IS NULL', args: [] }),
    db.execute({
      sql: `SELECT step_name,
        SUM(CASE WHEN status = 'waiting' THEN 1 ELSE 0 END) AS waiting,
        SUM(CASE WHEN status = 'in_progress' THEN 1 ELSE 0 END) AS in_progress,
        SUM(CASE WHEN status = 'completed' THEN 1 ELSE 0 END) AS completed
      FROM processes
      GROUP BY step_name
      ORDER BY MIN(id)`,
      args: [],
    }),
    db.execute({
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
    }),
    db.execute({
      sql: `SELECT sales_person,
        COUNT(*) AS total,
        SUM(CASE WHEN status = 'shipped' THEN 1 ELSE 0 END) AS shipped,
        SUM(CASE WHEN status = 'in_production' THEN 1 ELSE 0 END) AS in_production
      FROM orders
      WHERE sales_person IS NOT NULL
      GROUP BY sales_person
      ORDER BY total DESC`,
      args: [],
    }),
    db.execute({
      sql: "SELECT COUNT(*) AS count FROM orders WHERE status != 'shipped' AND due_date IS NOT NULL AND due_date < to_char(CURRENT_DATE, 'YYYY-MM-DD')",
      args: [],
    }),
    db.execute({
      sql: "SELECT COUNT(*) AS count FROM orders WHERE status != 'shipped' AND due_date IS NOT NULL AND due_date >= to_char(CURRENT_DATE, 'YYYY-MM-DD') AND due_date <= to_char(CURRENT_DATE + INTERVAL '3 days', 'YYYY-MM-DD')",
      args: [],
    }),
    db.execute({
      sql: `SELECT p.step_name,
        COUNT(*) AS delayed,
        SUM(CASE WHEN p.status = 'in_progress' THEN 1 ELSE 0 END) AS delayed_in_progress,
        SUM(CASE WHEN p.status = 'waiting' THEN 1 ELSE 0 END) AS delayed_waiting
      FROM processes p
      JOIN orders o ON o.id = p.order_id
      WHERE o.status != 'shipped'
        AND o.due_date IS NOT NULL
        AND o.due_date < to_char(CURRENT_DATE, 'YYYY-MM-DD')
        AND p.status != 'completed'
        AND NOT EXISTS (
          SELECT 1
          FROM processes p2
          WHERE p2.order_id = p.order_id
            AND p2.status != 'completed'
            AND p2.id < p.id
        )
      GROUP BY p.step_name`,
      args: [],
    }),
    db.execute({
      sql: `WITH current_delays AS (
        SELECT
          o.id AS order_id,
          o.client_name,
          o.product_type,
          o.door_type,
          o.width,
          o.depth,
          o.height,
          o.quantity,
          o.due_date,
          o.sales_person,
          p.id AS process_id,
          p.step_name,
          p.status AS process_status,
          p.started_by,
          ROW_NUMBER() OVER (PARTITION BY o.id ORDER BY p.id) AS rn
        FROM orders o
        JOIN processes p ON p.order_id = o.id
        WHERE o.status != 'shipped'
          AND o.due_date IS NOT NULL
          AND o.due_date < to_char(CURRENT_DATE, 'YYYY-MM-DD')
          AND p.status != 'completed'
      )
      SELECT *
      FROM current_delays
      WHERE rn = 1
      ORDER BY due_date ASC, order_id DESC
      LIMIT 30`,
      args: [],
    }),
  ]);

  const total_orders = totalResult.rows[0].count;
  const in_production = inProdResult.rows[0].count;
  const shipped = shippedResult.rows[0].count;
  const waiting = waitingResult.rows[0].count;
  const in_progress = inProgressResult.rows[0].count;
  const completed = completedResult.rows[0].count;
  const open_issues = openIssuesResult.rows[0].count;
  const overdue_count = overdueResult.rows[0].count;
  const due_soon_count = dueSoonResult.rows[0].count;

  const actionableMap = {};
  for (const row of actionableResult.rows) {
    actionableMap[row.step_name] = Number(row.cnt);
  }
  const delayedMap = {};
  for (const row of delayedByStepResult.rows) {
    delayedMap[row.step_name] = {
      delayed: Number(row.delayed || 0),
      delayed_in_progress: Number(row.delayed_in_progress || 0),
      delayed_waiting: Number(row.delayed_waiting || 0),
    };
  }
  const by_step = byStepResult.rows.map(row => ({
    ...row,
    actionable: actionableMap[row.step_name] || 0,
    delayed: delayedMap[row.step_name]?.delayed || 0,
    delayed_in_progress: delayedMap[row.step_name]?.delayed_in_progress || 0,
    delayed_waiting: delayedMap[row.step_name]?.delayed_waiting || 0,
  }));
  const delayed_by_step = by_step
    .filter(row => row.delayed > 0)
    .map(row => ({
      step_name: row.step_name,
      delayed: row.delayed,
      delayed_in_progress: row.delayed_in_progress,
      delayed_waiting: row.delayed_waiting,
    }))
    .sort((a, b) => b.delayed - a.delayed || STEPS.indexOf(a.step_name) - STEPS.indexOf(b.step_name));
  const delayed_orders = delayedOrdersResult.rows.map(row => ({
    ...row,
    days_overdue: Math.abs(daysUntilDue(row.due_date) || 0),
  }));
  const by_sales_person = bySalesResult.rows;

  return res.json({
    total_orders,
    in_production,
    shipped,
    process_stats: { waiting, in_progress, completed },
    open_issues,
    overdue_count,
    due_soon_count,
    by_step,
    delayed_by_step,
    delayed_orders,
    by_sales_person,
  });
});
