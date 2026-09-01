import crypto from 'node:crypto';

import { cors } from '../_lib/cors.js';
import { getDb } from '../_lib/db.js';
import {
  collectInternalDailyAlerts,
  groupInternalAlerts,
  sendInternalAlertGroup,
} from '../_lib/internalProductionAlerts.js';
import { ensureNotifySchema } from '../_lib/notifySchema.js';
import { isKstWeekend, kstToday } from '../_lib/risk.js';

function timingSafeMatch(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export async function handleInternalProductionDaily(req, res, dependencies = {}) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeMatch(req.headers.authorization || '', `Bearer ${secret}`)) {
    return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
  }

  const nowMs = dependencies.nowMs ?? Date.now();
  if (isKstWeekend(nowMs)) {
    return res.json({ ok: true, sent: 0, skipped: 'weekend' });
  }

  const db = dependencies.db || getDb();
  const sendGroup = dependencies.sendGroup || sendInternalAlertGroup;
  const ensureSchema = dependencies.ensureSchema || ensureNotifySchema;
  const today = dependencies.today || kstToday();
  await ensureSchema(db);
  const [ordersResult, processesResult] = await Promise.all([
    db.execute({
      sql: `SELECT id, client_name, product_type, door_type, width, depth, height,
                   due_date, ship_scheduled_date, status
              FROM orders
             WHERE status = 'in_production'`,
      args: [],
    }),
    db.execute({
      sql: `SELECT p.order_id, p.step_name, p.status, p.started_at, p.started_by,
                   p.completed_at, p.completed_by
              FROM processes p
              JOIN orders o ON o.id = p.order_id
             WHERE o.status = 'in_production'
             ORDER BY p.order_id, p.id`,
      args: [],
    }),
  ]);

  const items = collectInternalDailyAlerts({
    orders: ordersResult.rows,
    processes: processesResult.rows,
    today,
  });
  const groups = groupInternalAlerts(items);
  const results = await Promise.all(
    groups.map(group => sendGroup(db, group, { nowMs, ensureSchema: async () => {} })),
  );

  return res.json({
    ok: true,
    groups: groups.length,
    sent: results.reduce((sum, result) => sum + (result.sent || 0), 0),
    failed: results.reduce((sum, result) => sum + (result.failed || 0), 0),
    skipped: results.reduce((sum, result) => sum + (result.skipped || 0), 0),
    dryRun: results.some(result => result.dryRun),
    counts: {
      scanned: ordersResult.rows.length,
      alerts: items.length,
    },
  });
}

export default cors(handleInternalProductionDaily);
