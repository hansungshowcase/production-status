import { cors } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import {
  audienceForMilestone,
  serializeInternalNotification,
  summarizeInternalNotifications,
} from './_lib/internalNotificationHistory.js';
import { ensureInternalNotificationHistorySchema } from './_lib/notifySchema.js';
import { rateLimitCheck } from './_lib/rateLimit.js';

const AUDIENCES = new Set(['all', 'executive', 'member']);

function queryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

export async function handleInternalNotifications(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const checkRateLimit = dependencies.rateLimitCheck || rateLimitCheck;
  if (!checkRateLimit(req, res, { windowMs: 60000, max: 60 })) return;

  const audience = String(queryValue(req.query?.audience) || 'all');
  if (!AUDIENCES.has(audience)) {
    return res.status(400).json({
      error: { message: '올바른 조회 구분이 아닙니다.', status: 400 },
    });
  }

  const requestedLimit = Number.parseInt(queryValue(req.query?.limit), 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 50));
  const db = dependencies.db || getDb();
  await (dependencies.ensureSchema || ensureInternalNotificationHistorySchema)(db);

  const filters = ["LEFT(milestone, 9) = 'internal_'"];
  if (audience === 'member') filters.push("milestone = 'internal_assembly_daily'");
  if (audience === 'executive') filters.push("milestone <> 'internal_assembly_daily'");

  const { rows } = await db.execute({
    sql: `SELECT id, milestone, to_phone, status, recipient_name,
                 message_subject, message_text, created_at
            FROM notification_log
           WHERE ${filters.join(' AND ')}
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
    args: [limit],
  });

  const items = rows
    .filter(row => String(row?.milestone || '').startsWith('internal_'))
    .map(serializeInternalNotification)
    .filter(item => audience === 'all' || audienceForMilestone(item.milestone) === audience);

  return res.json({ items, counts: summarizeInternalNotifications(items) });
}

export default cors((req, res) => handleInternalNotifications(req, res));
