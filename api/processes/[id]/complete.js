import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  if (!rateLimitCheck(req, res)) return;

  const id = req.query.id;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: { message: '유효한 공정 ID가 필요합니다.', status: 400 } });
  }

  const db = getDb();
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

  if (process.step_name === '포장') {
    const { rows: photoRows } = await db.execute({
      sql: 'SELECT id FROM photos WHERE process_id = ? LIMIT 1',
      args: [process.id],
    });
    if (photoRows.length === 0) {
      return res.status(400).json({ error: { message: '포장 완료 후 출고로 넘기려면 사진 첨부가 필요합니다.', status: 400 } });
    }
  }

  const now = new Date().toISOString();
  const completeWorker = actor || '작업자';

  // Atomic update: only complete if still 'in_progress' (prevents double-click race condition)
  const { rows: updateResult } = await db.execute({
    sql: `UPDATE processes SET status = 'completed', completed_at = ?, completed_date = ?, completed_by = ? WHERE id = ? AND status = 'in_progress' RETURNING id`,
    args: [now, completed_date || null, completeWorker, id]
  });
  if (updateResult.length === 0) {
    return res.status(409).json({ error: { message: '이미 다른 작업자가 처리한 공정입니다.', status: 409 } });
  }

  // Get order for activity feed
  const { rows: orderRows } = await db.execute({
    sql: 'SELECT * FROM orders WHERE id = ?',
    args: [process.order_id]
  });
  const order = orderRows[0];
  if (order) {
    try {
      await db.execute({
        sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
        args: [
          process.order_id,
          '공정완료',
          `${order.client_name} - ${process.step_name} 공정이 완료되었습니다. (담당: ${completeWorker})`,
          completeWorker
        ]
      });
    } catch (e) {
      console.error('활동 로그 기록 실패:', e);
    }
  }

  if (process.step_name === '포장') {
    await db.execute({
      sql: `INSERT INTO processes (order_id, step_name, status)
            VALUES (?, '출고', 'waiting')
            ON CONFLICT (order_id, step_name) WHERE step_name = '출고' DO NOTHING`,
      args: [process.order_id],
    });
  }

  if (process.step_name === '출고' && order) {
    const today = new Date().toISOString().slice(0, 10);
    const { rows: shippedRows } = await db.execute({
      sql: `UPDATE orders SET status = 'shipped', ship_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status != 'shipped' RETURNING id`,
      args: [today, process.order_id],
    });
    if (shippedRows.length > 0) {
      try {
        await db.execute({
          sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
          args: [
            process.order_id,
            '출고완료',
            `${order.client_name} 주문이 출고 처리되었습니다. (출고 공정 완료)`,
            completeWorker,
          ],
        });
      } catch (e) {
        console.error('출고 로그 기록 실패:', e);
      }
    }
  }

  const { rows: updatedRows } = await db.execute({
    sql: 'SELECT * FROM processes WHERE id = ?',
    args: [id]
  });

  res.json(updatedRows[0]);
});
