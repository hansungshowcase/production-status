export async function ensureShippingProcesses(db) {
  await db.execute({
    sql: `DELETE FROM processes
          WHERE step_name = '출고'
            AND id IN (
              SELECT id
              FROM (
                SELECT id,
                  ROW_NUMBER() OVER (
                    PARTITION BY order_id, step_name
                    ORDER BY
                      CASE status
                        WHEN 'completed' THEN 1
                        WHEN 'in_progress' THEN 2
                        ELSE 3
                      END,
                      id
                  ) AS duplicate_rank
                FROM processes
                WHERE step_name = '출고'
              ) ranked
              WHERE duplicate_rank > 1
            )`,
    args: [],
  });

  await db.execute({
    sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_processes_unique_shipping
          ON processes(order_id, step_name)
          WHERE step_name = '출고'`,
    args: [],
  });

  await db.execute({
    sql: `INSERT INTO processes (order_id, step_name, status)
          SELECT o.id, '출고', 'waiting'
          FROM orders o
          WHERE o.status = 'in_production'
            AND EXISTS (
              SELECT 1 FROM processes p_pack
              WHERE p_pack.order_id = o.id AND p_pack.step_name = '포장' AND p_pack.status = 'completed'
            )
            AND NOT EXISTS (
              SELECT 1 FROM processes p_ship
              WHERE p_ship.order_id = o.id AND p_ship.step_name = '출고'
            )
          ON CONFLICT (order_id, step_name) WHERE step_name = '출고' DO NOTHING`,
    args: [],
  });

}
