import { getDb } from './_lib/db.js';
import { cors } from './_lib/cors.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const db = getDb();
  const { sales_person } = req.query;
  const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
  const offset = Math.max(0, parseInt(req.query.offset, 10) || 0);

  let sql = `
    SELECT af.*, o.client_name, o.product_type
    FROM activity_feed af
    LEFT JOIN orders o ON af.order_id = o.id
  `;
  const params = [];

  if (sales_person) {
    sql += ' WHERE o.sales_person = ?';
    params.push(sales_person);
  }

  sql += ' ORDER BY af.created_at DESC LIMIT ? OFFSET ?';
  params.push(limit, offset);

  const { rows } = await db.execute({ sql, args: params });
  return res.json(rows);
});
