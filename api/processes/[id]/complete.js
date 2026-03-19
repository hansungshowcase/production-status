import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const db = getDb();
  const id = req.query.id;
  const { completed_date, actor } = req.body || {};

  // Find process
  const { rows: processRows } = await db.execute({
    sql: 'SELECT * FROM processes WHERE id = ?',
    args: [id]
  });
  if (processRows.length === 0) {
    return res.status(404).json({ error: { message: '공정을 찾을 수 없습니다.', status: 404 } });
  }
  const process = processRows[0];

  if (process.status === 'completed') {
    return res.status(400).json({ error: { message: '이미 완료된 공정입니다.', status: 400 } });
  }
  if (process.status === 'waiting') {
    return res.status(400).json({ error: { message: '진행 중인 공정만 완료할 수 있습니다.', status: 400 } });
  }

  const now = new Date().toISOString();
  const completeWorker = actor || '작업자';

  await db.execute({
    sql: `UPDATE processes SET status = 'completed', completed_at = ?, completed_date = ?, completed_by = ? WHERE id = ?`,
    args: [now, completed_date || null, completeWorker, id]
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
      '공정완료',
      `${order.client_name} - ${process.step_name} 공정이 완료되었습니다. (담당: ${completeWorker})`,
      completeWorker
    ]
  });

  const { rows: updatedRows } = await db.execute({
    sql: 'SELECT * FROM processes WHERE id = ?',
    args: [id]
  });

  res.json(updatedRows[0]);
});
