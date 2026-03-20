import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { sanitizeInput } from '../_lib/sanitize.js';
import { STEPS } from '../_lib/steps.js';
import { daysUntilDue } from '../_lib/daysUntilDue.js';

const ORDER_FIELDS = [
  'order_date', 'due_date', 'sales_person', 'client_name',
  'ship_date', 'sale_amount', 'lead_source', 'balance',
  'phone', 'product_type', 'door_type', 'design',
  'width', 'depth', 'height', 'quantity', 'color',
  'notes', 'remarks', 'etc_notes', 'ship_scheduled_date',
  'sms_sent', 'safe_delivery', 'status',
];

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
  const {
    sales_person, status, client_name, product_type, search,
    overdue, due_soon,
  } = req.query;

  let limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 200));
  let offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  let sql = `
    SELECT o.*,
      (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status = 'completed') AS completed_steps,
      (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id) AS total_steps,
      (SELECT COUNT(*) FROM issues i WHERE i.order_id = o.id AND i.resolved_at IS NULL) AS open_issues
    FROM orders o
    WHERE 1=1
  `;
  const params = [];

  if (sales_person) {
    sql += ' AND o.sales_person = ?';
    params.push(sales_person);
  }

  if (client_name) {
    sql += ' AND o.client_name LIKE ?';
    params.push(`%${client_name}%`);
  }

  if (product_type) {
    sql += ' AND o.product_type LIKE ?';
    params.push(`%${product_type}%`);
  }

  if (search) {
    sql += ' AND (o.client_name LIKE ? OR o.product_type LIKE ? OR o.sales_person LIKE ? OR o.color LIKE ?)';
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (status === 'shipped') {
    sql += " AND o.status = 'shipped'";
  } else if (status === 'in_production') {
    sql += " AND o.status = 'in_production'";
  } else if (status === 'completed') {
    sql += ` AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status != 'completed') = 0`;
  } else if (status === 'in_progress') {
    sql += ` AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status = 'completed') > 0
             AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status != 'completed') > 0`;
  } else if (status === 'waiting') {
    sql += ` AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status = 'completed') = 0
             AND o.status = 'in_production'`;
  }

  sql += ' ORDER BY o.id DESC LIMIT ? OFFSET ?';
  params.push(Number(limit), Number(offset));

  const result = await db.execute({ sql, args: params });
  let orders = result.rows;

  // Add computed field: days_until_due
  orders = orders.map(order => ({
    ...order,
    days_until_due: daysUntilDue(order.due_date),
  }));

  // Apply overdue filter: due_date < today AND status != 'shipped'
  if (overdue === 'true') {
    orders = orders.filter(o =>
      o.days_until_due !== null && o.days_until_due < 0 && o.status !== 'shipped'
    );
  }

  // Apply due_soon filter: due_date within 3 days AND status != 'shipped'
  if (due_soon === 'true') {
    orders = orders.filter(o =>
      o.days_until_due !== null && o.days_until_due >= 0 && o.days_until_due <= 3 && o.status !== 'shipped'
    );
  }

  // Get total count for pagination
  let countSql = 'SELECT COUNT(*) AS count FROM orders o WHERE 1=1';
  const countParams = [];
  if (sales_person) { countSql += ' AND o.sales_person = ?'; countParams.push(sales_person); }
  if (client_name) { countSql += ' AND o.client_name LIKE ?'; countParams.push(`%${client_name}%`); }
  if (product_type) { countSql += ' AND o.product_type LIKE ?'; countParams.push(`%${product_type}%`); }
  if (search) {
    countSql += ' AND (o.client_name LIKE ? OR o.product_type LIKE ? OR o.sales_person LIKE ? OR o.color LIKE ?)';
    countParams.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (status === 'shipped') {
    countSql += " AND o.status = 'shipped'";
  } else if (status === 'in_production') {
    countSql += " AND o.status = 'in_production'";
  } else if (status === 'completed') {
    countSql += ` AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status != 'completed') = 0`;
  } else if (status === 'in_progress') {
    countSql += ` AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status = 'completed') > 0
             AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status != 'completed') > 0`;
  } else if (status === 'waiting') {
    countSql += ` AND (SELECT COUNT(*) FROM processes p WHERE p.order_id = o.id AND p.status = 'completed') = 0
             AND o.status = 'in_production'`;
  }

  const countResult = await db.execute({ sql: countSql, args: countParams });
  const total = countResult.rows[0].count;

  return res.json({ orders, total });
}

async function handlePost(req, res) {
  const body = sanitizeInput(req.body);
  const {
    client_name, width, depth, height, quantity, product_type, door_type, color,
  } = body;

  // Validation
  if (!client_name) {
    return res.status(400).json({ error: { message: 'client_name은 필수 항목입니다.', status: 400 } });
  }
  if (width !== undefined && width !== null && (typeof width !== 'number' || width <= 0)) {
    return res.status(400).json({ error: { message: 'width는 양의 정수여야 합니다.', status: 400 } });
  }
  if (depth !== undefined && depth !== null && (typeof depth !== 'number' || depth <= 0)) {
    return res.status(400).json({ error: { message: 'depth는 양의 정수여야 합니다.', status: 400 } });
  }
  if (height !== undefined && height !== null && (typeof height !== 'number' || height <= 0)) {
    return res.status(400).json({ error: { message: 'height는 양의 정수여야 합니다.', status: 400 } });
  }
  if (quantity !== undefined && quantity !== null && (typeof quantity !== 'number' || quantity <= 0)) {
    return res.status(400).json({ error: { message: 'quantity는 양의 정수여야 합니다.', status: 400 } });
  }

  const {
    order_date, due_date, sales_person,
    design, phone, notes, remarks, etc_notes,
    sale_amount, lead_source, balance,
    ship_scheduled_date, sms_sent, safe_delivery,
  } = body;

  const db = getDb();
  const tx = await db.transaction('write');

  try {
    const orderResult = await tx.execute({
      sql: `INSERT INTO orders (
        order_date, due_date, sales_person, client_name,
        product_type, door_type, design, width, depth, height,
        quantity, color, phone, notes, remarks, etc_notes,
        sale_amount, lead_source, balance,
        ship_scheduled_date, sms_sent, safe_delivery, status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'in_production') RETURNING id`,
      args: [
        order_date || null, due_date || null, sales_person || null, client_name,
        product_type || null, door_type || null, design || null,
        width || null, depth || null, height || null,
        quantity || 1, color || null, phone || null,
        notes || null, remarks || null, etc_notes || null,
        sale_amount || null, lead_source || null, balance || null,
        ship_scheduled_date || null, sms_sent || null, safe_delivery || 0,
      ],
    });
    if (!orderResult.rows || orderResult.rows.length === 0) {
      throw new Error('주문 생성 실패: ID가 반환되지 않았습니다.');
    }
    const orderId = Number(orderResult.rows[0].id);

    for (const step of STEPS) {
      await tx.execute({
        sql: `INSERT INTO processes (order_id, step_name, status) VALUES (?, ?, 'waiting')`,
        args: [orderId, step],
      });
    }

    await tx.execute({
      sql: `INSERT INTO pre_production (order_id) VALUES (?)`,
      args: [orderId],
    });

    await tx.execute({
      sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
      args: [orderId, '주문등록', `${client_name} 주문이 등록되었습니다.`, sales_person || '시스템'],
    });

    await tx.commit();

    // Fetch the created order with related data
    const orderRow = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
    const processRows = await db.execute({ sql: 'SELECT * FROM processes WHERE order_id = ?', args: [orderId] });
    const preProdRow = await db.execute({ sql: 'SELECT * FROM pre_production WHERE order_id = ?', args: [orderId] });

    const created = {
      ...orderRow.rows[0],
      processes: processRows.rows,
      pre_production: preProdRow.rows[0] || null,
    };

    return res.status(201).json(created);
  } catch (err) {
    if (err.message && (err.message.includes('UNIQUE constraint') || err.message.includes('duplicate key'))) {
      return res.status(409).json({ error: { message: '이미 존재하는 주문입니다.', status: 409 } });
    }
    throw err;
  }
}
