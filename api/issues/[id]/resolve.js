import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const { id } = req.query;
  const db = getDb();

  const issueResult = await db.execute({ sql: 'SELECT * FROM issues WHERE id = ?', args: [id] });
  if (issueResult.rows.length === 0) {
    return res.status(404).json({ error: { message: '이슈를 찾을 수 없습니다.', status: 404 } });
  }

  const issue = issueResult.rows[0];

  if (issue.resolved_at) {
    return res.status(400).json({ error: { message: '이미 해결된 이슈입니다.', status: 400 } });
  }

  const now = new Date().toLocaleString('sv-SE', { timeZone: 'Asia/Seoul' }).replace('T', ' ');
  await db.execute({ sql: 'UPDATE issues SET resolved_at = ? WHERE id = ?', args: [now, issue.id] });

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [issue.order_id] });
  const order = orderResult.rows.length > 0 ? orderResult.rows[0] : null;

  await db.execute({
    sql: `INSERT INTO activity_feed (order_id, action_type, description, actor)
          VALUES (?, ?, ?, ?)`,
    args: [
      issue.order_id,
      '이슈해결',
      `${order ? order.client_name : ''} - [${issue.issue_type}] ${issue.description || ''} 해결`.trim(),
      req.body?.actor || '시스템',
    ],
  });

  const updatedResult = await db.execute({ sql: 'SELECT * FROM issues WHERE id = ?', args: [issue.id] });
  const updated = updatedResult.rows[0];

  return res.json({ ...updated, client_name: order ? order.client_name : null });
});
