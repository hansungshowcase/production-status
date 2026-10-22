import crypto from 'node:crypto';

import { cors } from '../_lib/cors.js';
import { getDb } from '../_lib/db.js';
import {
  collectInternalDailyAlerts,
  createVcutCompletionAlert,
  groupInternalAlerts,
  reconcileInternalAlertReceipt,
  sendInternalAlertGroup,
} from '../_lib/internalProductionAlerts.js';
import { ensureNotifySchema } from '../_lib/notifySchema.js';
import { readPrivateConfig } from '../_lib/privateConfig.js';
import { findSolapiAttemptReceipt } from '../_lib/solapiDeliveryMonitor.js';
import { isKstWeekend, kstToday } from '../_lib/risk.js';

function timingSafeMatch(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

async function loadVcutPolicy(db, dependencies) {
  const readConfig = dependencies.readPrivateConfig || readPrivateConfig;
  try {
    const activationAt = await readConfig('repairs.activation_at', { db });
    const allowlist = JSON.parse(await readConfig('repairs.vcut_order_ids', { db }));
    if (!Number.isFinite(Date.parse(activationAt))) throw new Error('invalid activation time');
    if (!Array.isArray(allowlist) || allowlist.some(id => !Number.isInteger(id) || id <= 0)) throw new Error('invalid allowlist');
    return { activationAt, allowlist };
  } catch {
    return null;
  }
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
  const vcutPolicy = await loadVcutPolicy(db, dependencies);
  if (vcutPolicy) {
    const { rows: heldRows } = await db.execute({
      sql: `SELECT o.id, o.client_name, o.product_type, o.door_type, o.width, o.depth, o.height,
                   o.due_date, o.ship_scheduled_date, o.status,
                   o.notify_state -> 'internal:vcut_completed' AS held_state
              FROM orders o
              JOIN processes p ON p.order_id = o.id
                             AND p.step_name = 'V-커팅작업'
                             AND p.status = 'completed'
             WHERE o.status = 'in_production'
               AND o.notify_state -> 'internal:vcut_completed' ->> 'status' IN ('internal_sending', 'internal_uncertain')
               AND COALESCE(o.notify_state -> 'internal:vcut_completed' ->> 'attempt_token', '') <> ''
               AND (
                 COALESCE(o.notify_state -> 'internal:vcut_completed' ->> 'at', '') >= ?
                 OR o.id IN (SELECT jsonb_array_elements_text(?::jsonb)::int)
               )
             ORDER BY o.id`,
      args: [vcutPolicy.activationAt, JSON.stringify(vcutPolicy.allowlist)],
    });
    const findReceipt = dependencies.findAttemptReceipt || findSolapiAttemptReceipt;
    for (const order of heldRows) {
      const item = createVcutCompletionAlert({ order, today });
      try {
        const receipt = await findReceipt(item.phone, order.held_state.attempt_token, {
          at: order.held_state.at,
          nowMs,
        });
        if (receipt?.messageId) {
          await reconcileInternalAlertReceipt(db, item, order.held_state, receipt, nowMs);
        }
      } catch {}
    }
    const { rows: retryRows } = await db.execute({
      sql: `SELECT o.id, o.client_name, o.product_type, o.door_type, o.width, o.depth, o.height,
                   o.due_date, o.ship_scheduled_date, o.status,
                   COALESCE((o.notify_state -> 'internal:vcut_completed' ->> 'attempts')::int, 1) AS attempts
              FROM orders o
              JOIN processes p ON p.order_id = o.id
                             AND p.step_name = 'V-커팅작업'
                             AND p.status = 'completed'
             WHERE o.status = 'in_production'
               AND o.notify_state -> 'internal:vcut_completed' ->> 'status' = 'internal_failed'
               AND COALESCE((o.notify_state -> 'internal:vcut_completed' ->> 'attempts')::int, 1) < 3
               AND (
                 COALESCE(o.notify_state -> 'internal:vcut_completed' ->> 'at', '') >= ?
                 OR o.id IN (SELECT jsonb_array_elements_text(?::jsonb)::int)
               )
               AND NOT EXISTS (
                 SELECT 1 FROM notification_log receipt
                  WHERE receipt.order_id = o.id
                    AND receipt.milestone = 'internal_vcut_completed'
                    AND (receipt.status IN ('success', 'dry_run') OR COALESCE(receipt.provider_msgid, '') <> '')
               )
             ORDER BY o.id`,
      args: [vcutPolicy.activationAt, JSON.stringify(vcutPolicy.allowlist)],
    });
    for (const order of retryRows) {
      items.push({
        ...createVcutCompletionAlert({ order, today }),
        attempts: Number(order.attempts) || 1,
      });
    }
  }
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
