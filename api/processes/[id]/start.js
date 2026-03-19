import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const db = getDb();
  const id = req.query.id;
  const { work_date, actor, assigned_worker, assigned_team } = req.body || {};

  // Validate required fields
  if (assigned_worker !== undefined && typeof assigned_worker !== 'string') {
    return res.status(400).json({ error: { message: 'assigned_worker must be a string', status: 400 } });
  }
  if (assigned_team !== undefined && typeof assigned_team !== 'string') {
    return res.status(400).json({ error: { message: 'assigned_team must be a string', status: 400 } });
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

  if (process.status !== 'waiting') {
    return res.status(400).json({ error: { message: '대기 상태의 공정만 시작할 수 있습니다.', status: 400 } });
  }

  // Validate that all previous steps are completed
  const { rows: allProcesses } = await db.execute({
    sql: 'SELECT * FROM processes WHERE order_id = ? ORDER BY id',
    args: [process.order_id]
  });

  const currentIndex = allProcesses.findIndex(p => Number(p.id) === Number(process.id));
  const previousSteps = allProcesses.slice(0, currentIndex);
  const incompletePrereqs = previousSteps.filter(p => p.status !== 'completed');
  if (incompletePrereqs.length > 0) {
    return res.status(400).json({
      error: {
        message: '이전 공정이 모두 완료되어야 시작할 수 있습니다.',
        status: 400,
      },
    });
  }

  const now = new Date().toISOString();
  const workerName = actor || assigned_worker || '작업자';

  await db.execute({
    sql: `UPDATE processes SET status = 'in_progress', started_at = ?, started_by = ? WHERE id = ?`,
    args: [work_date || now, workerName, id]
  });

  // Get order for activity feed
  const { rows: orderRows } = await db.execute({
    sql: 'SELECT * FROM orders WHERE id = ?',
    args: [process.order_id]
  });
  if (orderRows.length === 0) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }
  const order = orderRows[0];

  await db.execute({
    sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
    args: [
      process.order_id,
      '공정시작',
      `${order.client_name} - ${process.step_name} 공정이 시작되었습니다. (담당: ${workerName})`,
      workerName
    ]
  });

  const { rows: updatedRows } = await db.execute({
    sql: 'SELECT * FROM processes WHERE id = ?',
    args: [id]
  });

  res.json(updatedRows[0]);
});
