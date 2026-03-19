import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const db = getDb();
  const id = req.query.id;
  const { actor } = req.body || {};

  // Find process
  const { rows: processRows } = await db.execute({
    sql: 'SELECT * FROM processes WHERE id = ?',
    args: [id]
  });
  if (processRows.length === 0) {
    return res.status(404).json({ error: { message: '공정을 찾을 수 없습니다.', status: 404 } });
  }
  const process = processRows[0];

  if (process.status === 'waiting') {
    return res.status(400).json({ error: { message: '대기 상태의 공정은 되돌릴 수 없습니다.', status: 400 } });
  }

  // Check no later steps are started
  const { rows: allProcesses } = await db.execute({
    sql: 'SELECT * FROM processes WHERE order_id = ? ORDER BY id',
    args: [process.order_id]
  });
  const currentIndex = allProcesses.findIndex(p => Number(p.id) === Number(process.id));
  const laterSteps = allProcesses.slice(currentIndex + 1);
  const startedLater = laterSteps.filter(p => p.status !== 'waiting');
  if (startedLater.length > 0) {
    return res.status(400).json({
      error: { message: '이후 공정이 이미 진행/완료되어 되돌릴 수 없습니다.', status: 400 },
    });
  }

  // Revert status
  if (process.status === 'completed') {
    await db.execute({
      sql: "UPDATE processes SET status = 'in_progress', completed_at = NULL WHERE id = ?",
      args: [id]
    });
  } else if (process.status === 'in_progress') {
    await db.execute({
      sql: "UPDATE processes SET status = 'waiting', started_at = NULL, completed_at = NULL WHERE id = ?",
      args: [id]
    });
  }

  // Get order for activity feed
  const { rows: orderRows } = await db.execute({
    sql: 'SELECT * FROM orders WHERE id = ?',
    args: [process.order_id]
  });
  const order = orderRows[0];

  await db.execute({
    sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
    args: [
      process.order_id,
      '공정되돌리기',
      `${order.client_name} - ${process.step_name} 공정이 되돌려졌습니다.`,
      actor || '작업자'
    ]
  });

  const { rows: updatedRows } = await db.execute({
    sql: 'SELECT * FROM processes WHERE id = ?',
    args: [id]
  });

  res.json(updatedRows[0]);
});
