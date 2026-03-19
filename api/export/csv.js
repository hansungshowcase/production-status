import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { STEPS } from '../_lib/steps.js';

const CSV_HEADERS = [
  '발주일', '납기일', '담당', '거래처', '출고완료일',
  '사양', '디자인', '가로', '세로', '높이', '수량', '색상',
  '도면설계', '레이저작업', 'V-커팅작업', '절곡작업', '용접작업', '분체작업', '조립작업', '설비작업', '포장',
  '상태', '비고',
];

const STATUS_MAP = {
  waiting: '대기',
  in_progress: '진행중',
  completed: '완료',
};

function statusLabel(orderStatus) {
  if (orderStatus === 'shipped') return '출고완료';
  if (orderStatus === 'in_production') return '생산중';
  if (orderStatus === 'cancelled') return '취소';
  return orderStatus || '';
}

function escapeCSV(value) {
  if (value == null) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

export default cors(async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const db = getDb();
  const { status, sales_person, client_name } = req.query;

  let sql = 'SELECT * FROM orders WHERE 1=1';
  const params = [];

  if (status) {
    sql += ' AND status = ?';
    params.push(status);
  }
  if (sales_person) {
    sql += ' AND sales_person = ?';
    params.push(sales_person);
  }
  if (client_name) {
    sql += ' AND client_name LIKE ?';
    params.push(`%${client_name}%`);
  }

  sql += ' ORDER BY id';
  const ordersResult = await db.execute({ sql, args: params });
  const orders = ordersResult.rows;

  // Pre-fetch all processes for these orders
  const processMap = {};
  if (orders.length > 0) {
    const placeholders = orders.map(() => '?').join(',');
    const processResult = await db.execute({
      sql: `SELECT * FROM processes WHERE order_id IN (${placeholders})`,
      args: orders.map(o => o.id),
    });

    for (const p of processResult.rows) {
      if (!processMap[p.order_id]) processMap[p.order_id] = {};
      processMap[p.order_id][p.step_name] = p.status;
    }
  }

  // Build CSV
  const BOM = '\uFEFF';
  const lines = [CSV_HEADERS.map(escapeCSV).join(',')];

  for (const o of orders) {
    const procs = processMap[o.id] || {};
    const row = [
      o.order_date,
      o.due_date,
      o.sales_person,
      o.client_name,
      o.ship_date,
      o.product_type,
      o.door_type,
      o.width,
      o.depth,
      o.height,
      o.quantity,
      o.color,
      ...STEPS.map(step => STATUS_MAP[procs[step]] || '대기'),
      statusLabel(o.status),
      o.notes,
    ];
    lines.push(row.map(escapeCSV).join(','));
  }

  const csv = BOM + lines.join('\r\n');
  const filename = `orders_${new Date().toISOString().slice(0, 10)}.csv`;

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  return res.send(csv);
});
