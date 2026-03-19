import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';

const PRE_PROD_FIELDS = [
  'instruction_check',
  'material_drawing',
  'laser_drawing',
  'material_order_received',
  'material_order_completed',
  'material_received',
];

export default cors(async function handler(req, res) {
  if (req.method === 'GET') {
    return handleGet(req, res);
  } else if (req.method === 'PATCH') {
    return handlePatch(req, res);
  } else {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
});

async function handleGet(req, res) {
  const db = getDb();
  const { orderId } = req.query;

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
  if (orderResult.rows.length === 0) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }
  const order = orderResult.rows[0];

  let preProdResult = await db.execute({ sql: 'SELECT * FROM pre_production WHERE order_id = ?', args: [orderId] });
  if (preProdResult.rows.length === 0) {
    await db.execute({ sql: 'INSERT INTO pre_production (order_id) VALUES (?)', args: [orderId] });
    preProdResult = await db.execute({ sql: 'SELECT * FROM pre_production WHERE order_id = ?', args: [orderId] });
  }

  return res.json({ ...preProdResult.rows[0], client_name: order.client_name });
}

async function handlePatch(req, res) {
  const db = getDb();
  const { orderId } = req.query;

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
  if (orderResult.rows.length === 0) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }
  const order = orderResult.rows[0];

  let preProdResult = await db.execute({ sql: 'SELECT * FROM pre_production WHERE order_id = ?', args: [orderId] });
  if (preProdResult.rows.length === 0) {
    await db.execute({ sql: 'INSERT INTO pre_production (order_id) VALUES (?)', args: [orderId] });
  }

  const updates = [];
  const values = [];

  for (const field of PRE_PROD_FIELDS) {
    if (req.body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(req.body[field]);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: { message: '수정할 필드가 없습니다.', status: 400 } });
  }

  values.push(orderId);
  await db.execute({
    sql: `UPDATE pre_production SET ${updates.join(', ')} WHERE order_id = ?`,
    args: values,
  });

  // Log activity
  const changedFields = Object.keys(req.body).filter(k => PRE_PROD_FIELDS.includes(k));
  await db.execute({
    sql: `INSERT INTO activity_feed (order_id, action_type, description, actor)
          VALUES (?, ?, ?, ?)`,
    args: [
      order.id,
      '사전생산수정',
      `${order.client_name} 사전생산 체크리스트가 수정되었습니다. (${changedFields.join(', ')})`,
      req.body.actor || '시스템',
    ],
  });

  const updatedResult = await db.execute({ sql: 'SELECT * FROM pre_production WHERE order_id = ?', args: [orderId] });

  return res.json({ ...updatedResult.rows[0], client_name: order.client_name });
}
