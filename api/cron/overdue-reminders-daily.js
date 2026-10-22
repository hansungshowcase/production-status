import crypto from 'node:crypto';

import { cors } from '../_lib/cors.js';
import { getDb } from '../_lib/db.js';
import {
  buildOverdueReminderMessage,
  collectOverdueReminderGroups,
} from '../_lib/overdueReminders.js';
import { ensureNotificationDailyClaimsSchema, ensureNotifySchema } from '../_lib/notifySchema.js';
import { sendAdminLms } from '../_lib/notify.js';
import {
  claimDailyNotification as claimDailyNotificationDefault,
  finishDailyNotification as finishDailyNotificationDefault,
} from './risk-daily.js';

function timingSafeMatch(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

const ORDER_COLUMNS = 'id, client_name, sales_person, due_date, status, ship_date';

async function queryInitialSnapshot(db) {
  const [ordersResult, processesResult] = await Promise.all([
    db.execute({
      sql: `SELECT ${ORDER_COLUMNS} FROM orders WHERE status = 'in_production'`,
      args: [],
    }),
    db.execute({
      sql: `SELECT p.order_id, p.step_name, p.status, p.started_by
              FROM processes p
              JOIN orders o ON o.id = p.order_id
             WHERE o.status = 'in_production'
             ORDER BY p.order_id, p.id`,
      args: [],
    }),
  ]);
  return { orders: ordersResult.rows, processes: processesResult.rows };
}

async function queryCurrentSnapshot(db, orderIds) {
  if (orderIds.length === 0) return { orders: [], processes: [] };
  const placeholders = orderIds.map(() => '?').join(', ');
  const [ordersResult, processesResult] = await Promise.all([
    db.execute({
      sql: `SELECT ${ORDER_COLUMNS}
              FROM orders
             WHERE status = 'in_production' AND id IN (${placeholders})`,
      args: orderIds,
    }),
    db.execute({
      sql: `SELECT order_id, step_name, status, started_by
              FROM processes
             WHERE order_id IN (${placeholders})
             ORDER BY order_id, id`,
      args: orderIds,
    }),
  ]);
  return { orders: ordersResult.rows, processes: processesResult.rows };
}

function publicCounts(collection) {
  return {
    scannedOrders: collection.scannedOrders,
    missingOrInvalidDue: collection.missingOrInvalidDue,
    categories: collection.categoryCounts,
    unknownAssignments: collection.unknownAssignments.length,
  };
}

export async function handleOverdueRemindersDaily(req, res, dependencies = {}) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  const env = dependencies.env || process.env;
  const secret = env.CRON_SECRET;
  if (!secret || !timingSafeMatch(req.headers.authorization || '', `Bearer ${secret}`)) {
    return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
  }

  const db = dependencies.db || getDb();
  const nowMs = dependencies.nowMs ?? Date.now();
  const ensureBaseSchema = dependencies.ensureNotifySchema || ensureNotifySchema;
  const ensureClaimsSchema = dependencies.ensureClaimsSchema || ensureNotificationDailyClaimsSchema;
  const loadInitialSnapshot = dependencies.loadInitialSnapshot || queryInitialSnapshot;
  const loadCurrentSnapshot = dependencies.loadCurrentSnapshot || queryCurrentSnapshot;
  const claimDailyNotification = dependencies.claimDailyNotification || claimDailyNotificationDefault;
  const finishDailyNotification = dependencies.finishDailyNotification || finishDailyNotificationDefault;
  const sendLms = dependencies.sendLms || sendAdminLms;
  const randomUUID = dependencies.randomUUID || crypto.randomUUID;

  let initial;
  try {
    await ensureBaseSchema(db);
    await ensureClaimsSchema(db);
    initial = await loadInitialSnapshot(db);
  } catch {
    return res.status(500).json({
      ok: false,
      sent: 0,
      failed: 1,
      errors: [{ phase: 'initial_query' }],
    });
  }

  const collection = collectOverdueReminderGroups({ ...initial, nowMs });
  const counts = publicCounts(collection);
  if (collection.groups.length === 0) {
    return res.json({
      ok: true,
      sent: 0,
      skipped: collection.unknownAssignments.length > 0 ? 'no_routed_recipient' : 'no_eligible',
      counts,
    });
  }

  const results = await Promise.all(collection.groups.map(async initialGroup => {
    const claim = {
      kstDate: collection.kstDate,
      toPhone: initialGroup.toPhone,
      milestone: initialGroup.kind,
      attemptToken: randomUUID(),
    };
    let claimed;
    try {
      claimed = await claimDailyNotification(db, claim);
    } catch {
      return { kind: initialGroup.kind, status: 'claim_error', count: initialGroup.orders.length };
    }
    if (!claimed) {
      return { kind: initialGroup.kind, status: 'already_claimed', count: initialGroup.orders.length };
    }

    try {
      const current = await loadCurrentSnapshot(db, initialGroup.orders.map(order => order.orderId));
      const refreshed = collectOverdueReminderGroups({ ...current, nowMs });
      const currentGroup = refreshed.groups.find(group => (
        group.kind === initialGroup.kind && group.toPhone === initialGroup.toPhone
      ));
      if (!currentGroup || currentGroup.orders.length === 0) {
        await finishDailyNotification(db, claim, {
          ok: false,
          explicitFailure: true,
          error: 'cancelled_after_recheck:no_eligible_orders',
        });
        return { kind: initialGroup.kind, status: 'cancelled_after_recheck', count: 0 };
      }

      const message = buildOverdueReminderMessage(currentGroup);
      let sendResult;
      try {
        sendResult = await sendLms(db, {
          to: currentGroup.toPhone,
          recipientName: currentGroup.recipientName,
          subject: message.subject,
          text: message.text,
          tag: currentGroup.kind,
          customFields: { notificationAttemptToken: claim.attemptToken },
        });
      } catch {
        sendResult = { ok: false, uncertain: true, error: 'send_exception' };
      }
      await finishDailyNotification(db, claim, sendResult);
      return {
        kind: initialGroup.kind,
        status: sendResult.dryRun ? 'dry_run' : sendResult.ok ? 'success' : sendResult.explicitFailure ? 'failed' : 'uncertain',
        count: currentGroup.orders.length,
      };
    } catch {
      try {
        await finishDailyNotification(db, claim, { ok: false, uncertain: true, error: 'group_exception' });
      } catch {}
      return { kind: initialGroup.kind, status: 'group_error', count: initialGroup.orders.length };
    }
  }));

  const errorStatuses = new Set(['claim_error', 'group_error', 'failed', 'uncertain']);
  const failed = results.filter(result => errorStatuses.has(result.status)).length;
  return res.json({
    ok: failed === 0,
    sent: results.filter(result => result.status === 'success').length,
    dryRun: results.some(result => result.status === 'dry_run'),
    failed,
    skipped: results.filter(result => ['already_claimed', 'cancelled_after_recheck'].includes(result.status)).length,
    counts,
    results,
  });
}

export default cors(handleOverdueRemindersDaily);
