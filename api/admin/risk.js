// 관리자용 납기 리스크 목록 — GET /api/admin/risk (인증: sales|admin)
// in_production 전체를 assessOrder 로 평가해 overdue/red/amber 목록 + counts 반환.
import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { rateLimitCheck } from '../_lib/rateLimit.js';
import { assessOrder, kstToday } from '../_lib/risk.js';

export default cors(async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  if (!rateLimitCheck(req, res)) return;
  const auth = requireAuth(req, res, { roles: ['sales', 'admin'] });
  if (!auth) return;

  const db = getDb();
  const [ordersResult, procResult] = await Promise.all([
    db.execute({
      sql: `SELECT id, client_name, order_date, due_date, ship_scheduled_date, status
              FROM orders WHERE status = 'in_production'`,
      args: [],
    }),
    db.execute({
      sql: `SELECT p.order_id, p.step_name, p.status
              FROM processes p
              JOIN orders o ON o.id = p.order_id
             WHERE o.status = 'in_production'
             ORDER BY p.order_id, p.id`,
      args: [],
    }),
  ]);

  const procByOrder = new Map();
  for (const p of procResult.rows) {
    const key = Number(p.order_id);
    if (!procByOrder.has(key)) procByOrder.set(key, []);
    procByOrder.get(key).push(p);
  }

  const today = kstToday();
  const buckets = { overdue: [], red: [], amber: [] };
  const counts = { overdue: 0, red: 0, amber: 0, green: 0, unknown: 0, total: ordersResult.rows.length };

  for (const order of ordersResult.rows) {
    const assessment = assessOrder(order, procByOrder.get(Number(order.id)) || [], today);
    counts[assessment.level] = (counts[assessment.level] || 0) + 1;
    if (buckets[assessment.level]) {
      buckets[assessment.level].push({
        id: order.id,
        client_name: order.client_name,
        order_date: order.order_date,
        due_date: order.due_date,
        ship_scheduled_date: order.ship_scheduled_date,
        days_left: assessment.daysLeft,
        est_remain: assessment.estRemain,
        slack: assessment.slack,
        current_step: assessment.currentStep,
        predicted_ship: assessment.predictedShip,
        checkpoint_started: assessment.checkpointStarted,
        reason: (assessment.reasons && assessment.reasons[0]) || '',
        reasons: assessment.reasons || [],
        level: assessment.level,
      });
    }
  }

  // 정렬: overdue 경과일 큰 순 → red/amber 여유 적은 순
  buckets.overdue.sort((a, b) => (a.days_left ?? 0) - (b.days_left ?? 0));
  buckets.red.sort((a, b) => (a.slack ?? 0) - (b.slack ?? 0));
  buckets.amber.sort((a, b) => (a.slack ?? 0) - (b.slack ?? 0));

  return res.json({ ...buckets, counts, today });
});
