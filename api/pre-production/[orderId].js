import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { rateLimitCheck } from '../_lib/rateLimit.js';
import { requireAuth } from '../_lib/auth.js';
import { changedFieldKeys, describeFieldChanges } from '../../src/utils/fieldLabels.js';
import { parsePositiveInt4Id } from '../_lib/positiveInt4Id.js';

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
    if (!rateLimitCheck(req, res)) return;
    const auth = requireAuth(req, res, { roles: ['sales', 'admin'] });
    if (!auth) return;
    return handlePatch(req, res);
  } else {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
});

export async function handleGet(req, res, dependencies = {}) {
  const orderId = parsePositiveInt4Id(req.query.orderId);
  if (orderId === null) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }
  const db = dependencies.db || getDb();

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
  if (orderResult.rows.length === 0) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }
  const order = orderResult.rows[0];

  let preProdResult = await db.execute({ sql: 'SELECT * FROM pre_production WHERE order_id = ?', args: [orderId] });
  if (preProdResult.rows.length === 0) {
    const emptyPreProduction = PRE_PROD_FIELDS.reduce((acc, field) => ({ ...acc, [field]: 0 }), {});
    return res.json({ ...emptyPreProduction, order_id: orderId, client_name: order.client_name });
  }

  return res.json({ ...preProdResult.rows[0], client_name: order.client_name });
}

export async function handlePatch(req, res, dependencies = {}) {
  const orderId = parsePositiveInt4Id(req.query.orderId);
  if (orderId === null) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }
  const body = req.body || {};
  const changes = {};
  for (const field of PRE_PROD_FIELDS) {
    if (!Object.hasOwn(body, field) || body[field] === undefined) continue;
    if (body[field] === true || body[field] === 1) {
      changes[field] = 1;
    } else if (body[field] === false || body[field] === 0) {
      changes[field] = 0;
    } else {
      return res.status(400).json({
        error: { message: '사전생산 체크 값은 true/false 또는 1/0이어야 합니다.', status: 400 },
      });
    }
  }
  const touchedFields = Object.keys(changes);
  if (touchedFields.length === 0) {
    return res.status(400).json({ error: { message: '수정할 필드가 없습니다.', status: 400 } });
  }
  const db = dependencies.db || getDb();

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
  if (orderResult.rows.length === 0) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }
  const order = orderResult.rows[0];

  const preProdResult = await db.execute({ sql: 'SELECT * FROM pre_production WHERE order_id = ?', args: [orderId] });
  const beforeRow = preProdResult.rows[0]
    || PRE_PROD_FIELDS.reduce((acc, field) => ({ ...acc, [field]: 0 }), {});
  const changedFields = changedFieldKeys(beforeRow, { ...beforeRow, ...changes }, touchedFields);
  const columns = touchedFields.join(', ');
  const placeholders = touchedFields.map(() => '?').join(', ');
  const assignments = touchedFields.map(field => `${field} = EXCLUDED.${field}`).join(', ');
  const [mutationResult] = await db.atomicBatch([{
    sql: `WITH upserted_pre_production AS (
            INSERT INTO pre_production (order_id, ${columns})
            VALUES (?, ${placeholders})
            ON CONFLICT (order_id) DO UPDATE SET ${assignments}
            RETURNING *
          ),
          pre_production_activity AS (
            INSERT INTO activity_feed (order_id, action_type, description, actor)
            SELECT u.order_id, '사전생산수정', ?, ?
              FROM upserted_pre_production u
            RETURNING id
          )
          SELECT to_jsonb(u) AS pre_production_row
            FROM upserted_pre_production u
           WHERE EXISTS (SELECT 1 FROM pre_production_activity)`,
    args: [
      orderId,
      ...touchedFields.map(field => changes[field]),
      describeFieldChanges(`${order.client_name} 사전생산 체크리스트가 수정되었습니다.`, changedFields),
      body.actor || '시스템',
    ],
  }]);
  const updated = mutationResult.rows?.[0]?.pre_production_row;
  if (!updated) {
    throw new Error('사전생산 체크리스트가 원자 배치 안에서 완료되지 않았습니다.');
  }

  return res.json({ ...updated, client_name: order.client_name });
}
