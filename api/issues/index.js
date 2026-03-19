import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';

const VALID_ISSUE_TYPES = ['자재부족', '불량발생', '설비고장', '기타'];

export default cors(async function handler(req, res) {
  if (req.method === 'GET') {
    return handleGet(req, res);
  } else if (req.method === 'POST') {
    return handlePost(req, res);
  } else {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
});

async function handleGet(req, res) {
  const db = getDb();
  const { order_id } = req.query;

  if (order_id) {
    const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [order_id] });
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
    }
    const { rows } = await db.execute({
      sql: 'SELECT * FROM issues WHERE order_id = ? ORDER BY reported_at DESC',
      args: [order_id],
    });
    return res.json(rows);
  }

  const { rows } = await db.execute({ sql: 'SELECT * FROM issues ORDER BY reported_at DESC', args: [] });
  return res.json(rows);
}

async function handlePost(req, res) {
  const { order_id, process_id, issue_type, description, reported_by } = req.body;

  // Validation
  if (!order_id) {
    return res.status(400).json({ error: { message: 'order_id는 필수 항목입니다.', status: 400 } });
  }
  if (!issue_type) {
    return res.status(400).json({ error: { message: 'issue_type은 필수 항목입니다.', status: 400 } });
  }
  if (!VALID_ISSUE_TYPES.includes(issue_type)) {
    return res.status(400).json({ error: { message: `issue_type은 다음 중 하나여야 합니다: ${VALID_ISSUE_TYPES.join(', ')}`, status: 400 } });
  }
  if (!reported_by) {
    return res.status(400).json({ error: { message: 'reported_by는 필수 항목입니다.', status: 400 } });
  }

  const db = getDb();

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [order_id] });
  if (orderResult.rows.length === 0) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }
  const order = orderResult.rows[0];

  const result = await db.execute({
    sql: `INSERT INTO issues (order_id, process_id, issue_type, description, reported_by)
          VALUES (?, ?, ?, ?, ?)`,
    args: [order_id, process_id || null, issue_type, description || null, reported_by || null],
  });

  await db.execute({
    sql: `INSERT INTO activity_feed (order_id, action_type, description, actor)
          VALUES (?, ?, ?, ?)`,
    args: [
      order_id,
      '이슈등록',
      `${order.client_name} - [${issue_type}] ${description || ''}`.trim(),
      reported_by || '시스템',
    ],
  });

  const issueResult = await db.execute({
    sql: 'SELECT * FROM issues WHERE id = ?',
    args: [Number(result.lastInsertRowid)],
  });

  return res.status(201).json(issueResult.rows[0]);
}
