import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { sanitizeInput } from '../../_lib/sanitize.js';

const ORDER_FIELDS = [
  'order_date', 'due_date', 'sales_person', 'client_name',
  'ship_date', 'sale_amount', 'lead_source', 'balance',
  'phone', 'product_type', 'door_type', 'design',
  'width', 'depth', 'height', 'quantity', 'color',
  'notes', 'remarks', 'etc_notes', 'ship_scheduled_date',
  'sms_sent', 'safe_delivery', 'status',
];

export default cors(async function handler(req, res) {
  const { id } = req.query;

  if (req.method === 'GET') {
    return handleGet(id, req, res);
  } else if (req.method === 'PUT') {
    return handleUpdate(id, req, res);
  } else if (req.method === 'PATCH') {
    return handleUpdate(id, req, res);
  } else if (req.method === 'DELETE') {
    return handleDelete(id, req, res);
  } else {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
});

async function handleGet(id, req, res) {
  const db = getDb();

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
  const order = orderResult.rows[0];

  if (!order) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }

  const processesResult = await db.execute({
    sql: 'SELECT * FROM processes WHERE order_id = ? ORDER BY id',
    args: [order.id],
  });
  const preProdResult = await db.execute({
    sql: 'SELECT * FROM pre_production WHERE order_id = ?',
    args: [order.id],
  });
  const issuesResult = await db.execute({
    sql: 'SELECT * FROM issues WHERE order_id = ? ORDER BY reported_at DESC',
    args: [order.id],
  });
  const photosResult = await db.execute({
    sql: 'SELECT * FROM photos WHERE order_id = ? ORDER BY uploaded_at DESC',
    args: [order.id],
  });

  return res.json({
    ...order,
    processes: processesResult.rows,
    pre_production: preProdResult.rows[0] || null,
    issues: issuesResult.rows,
    photos: photosResult.rows,
  });
}

async function handleUpdate(id, req, res) {
  const db = getDb();
  const body = sanitizeInput(req.body);

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
  const order = orderResult.rows[0];

  if (!order) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }

  const updates = [];
  const values = [];

  for (const field of ORDER_FIELDS) {
    if (body[field] !== undefined) {
      updates.push(`${field} = ?`);
      values.push(body[field]);
    }
  }

  if (updates.length === 0) {
    return res.status(400).json({ error: { message: '수정할 필드가 없습니다.', status: 400 } });
  }

  updates.push("updated_at = CURRENT_TIMESTAMP");
  values.push(id);

  await db.execute({
    sql: `UPDATE orders SET ${updates.join(', ')} WHERE id = ?`,
    args: values,
  });

  // Log activity
  const changedFields = Object.keys(body).filter(k => ORDER_FIELDS.includes(k));
  await db.execute({
    sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
    args: [
      order.id,
      '주문수정',
      `${order.client_name} 주문이 수정되었습니다. (${changedFields.join(', ')})`,
      body.actor || '시스템',
    ],
  });

  const updatedResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
  return res.json(updatedResult.rows[0]);
}

async function handleDelete(id, req, res) {
  const db = getDb();
  const body = req.body || {};

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
  const order = orderResult.rows[0];

  if (!order) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }

  // Log before deleting (since cascade will remove activity_feed entries too)
  await db.execute({
    sql: `INSERT INTO activity_feed (action_type, description, actor) VALUES (?, ?, ?)`,
    args: [
      '주문삭제',
      `${order.client_name} 주문(ID: ${order.id})이 삭제되었습니다.`,
      body.actor || '시스템',
    ],
  });

  await db.execute({ sql: 'DELETE FROM orders WHERE id = ?', args: [id] });

  return res.json({ success: true, message: '주문이 삭제되었습니다.' });
}
