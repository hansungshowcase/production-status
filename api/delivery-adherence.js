import { cors } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { calculateDeliveryAdherence, todayInSeoul } from './_lib/deliveryAdherence.js';

export function createDeliveryAdherenceHandler({ dbFactory = getDb } = {}) {
  return cors(async function handler(req, res) {
    if (req.method !== 'GET') {
      return res.status(405).json({ error: { message: 'Method not allowed' } });
    }

    const db = dbFactory();
    const result = await db.execute({
      sql: `
      SELECT
        o.id,
        o.quantity,
        o.due_date,
        o.status,
        o.ship_date,
        MIN(CASE
          WHEN p.step_name = '설비작업' AND p.status = 'completed' THEN p.completed_at
          ELSE NULL
        END) AS equipment_completed_at,
        MIN(CASE
          WHEN p.step_name IN ('포장', '출고') AND p.status IN ('in_progress', 'completed')
            THEN COALESCE(p.started_at, p.completed_at)
          ELSE NULL
        END) AS later_step_started_at
      FROM orders o
      LEFT JOIN processes p ON p.order_id = o.id
      GROUP BY o.id, o.quantity, o.due_date, o.status, o.ship_date
    `,
      args: [],
    });
    const today = todayInSeoul();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');

    return res.json({
      ...calculateDeliveryAdherence(result.rows, today),
      calculated_at: today,
    });
  });
}

export default createDeliveryAdherenceHandler();
