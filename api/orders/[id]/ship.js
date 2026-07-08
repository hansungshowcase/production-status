import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { requireAuth, resolveActor } from '../../_lib/auth.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { maybeNotify, kstTodayStr } from '../../_lib/notify.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  if (!rateLimitCheck(req, res)) return;

  const auth = requireAuth(req, res, { roles: ['sales'] });
  if (!auth) return;

  const { id } = req.query;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }
  const db = getDb();

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
  const order = orderResult.rows[0];

  if (!order) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }

  if (order.status === 'shipped') {
    return res.status(400).json({ error: { message: '이미 출고 처리된 주문입니다.', status: 400 } });
  }

  // KST 기준 오늘 (UTC .toISOString() 사용 시 KST 00~09시 출고가 전날로 기록되어 고객 안내 문자에 노출됨)
  const today = kstTodayStr();

  await db.execute({
    sql: `UPDATE orders SET status = 'shipped', ship_date = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
    args: [today, id],
  });

  const body = req.body || {};
  await db.execute({
    sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
    args: [
      order.id,
      '출고완료',
      `${order.client_name} 주문이 출고 처리되었습니다.`,
      resolveActor(req),
    ],
  });

  // 알림 훅: 출고 처리 → shipped (실패해도 본 응답에 영향 없음)
  try {
    await maybeNotify(db, { ...order, status: 'shipped', ship_date: today }, 'shipped');
  } catch (e) {
    console.error('[ship] shipped 알림 발송 실패(무시):', e);
  }

  const updatedResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [id] });
  return res.json(updatedResult.rows[0]);
});
