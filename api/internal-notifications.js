import { cors } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import {
  audienceForMilestone,
  INTERNAL_MEMBER_NAMES,
  maskedPhoneForInternalMember,
  serializeInternalNotification,
  summarizeInternalNotifications,
} from './_lib/internalNotificationHistory.js';
import { ensureInternalNotificationHistorySchema } from './_lib/notifySchema.js';
import { rateLimitCheck } from './_lib/rateLimit.js';

const AUDIENCES = new Set(['all', 'executive', 'member']);

function queryValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

function isValidDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
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


  const recipient = String(queryValue(req.query?.recipient) || '').trim();
  if (recipient && !INTERNAL_MEMBER_NAMES.has(recipient)) {
    return res.status(400).json({
      error: { message: '등록되지 않은 팀원입니다.', status: 400 },
    });
  }

  const date = String(queryValue(req.query?.date) || '').trim();
  if (date && !isValidDate(date)) {
    return res.status(400).json({
      error: { message: '올바른 조회 날짜가 아닙니다.', status: 400 },
    });
  }

  const requestedLimit = Number.parseInt(queryValue(req.query?.limit), 10);
  const limit = Math.min(100, Math.max(1, Number.isFinite(requestedLimit) ? requestedLimit : 50));
  const db = dependencies.db || getDb();
  await (dependencies.ensureSchema || ensureInternalNotificationHistorySchema)(db);

  const filters = ["LEFT(milestone, 9) = 'internal_'"];
  const args = [];
  if (audience === 'member') filters.push("milestone = 'internal_assembly_daily'");
  if (audience === 'executive') filters.push("milestone <> 'internal_assembly_daily'");
  if (recipient) {
    filters.push("(recipient_name = ? OR ((recipient_name IS NULL OR BTRIM(recipient_name) = '') AND to_phone = ?))");
    args.push(recipient, maskedPhoneForInternalMember(recipient));
  }
  if (date) {
    filters.push("(created_at AT TIME ZONE 'Asia/Seoul')::date = ?::date");
    args.push(date);
  }
  args.push(limit);

  const { rows } = await db.execute({
    sql: `SELECT id, milestone, to_phone, status, recipient_name,
                 message_subject, message_text, created_at
            FROM notification_log
           WHERE ${filters.join(' AND ')}
           ORDER BY created_at DESC, id DESC
           LIMIT ?`,
    args,
  });

  const items = rows
    .filter(row => String(row?.milestone || '').startsWith('internal_'))
    .map(serializeInternalNotification)
    .filter(item => audience === 'all' || audienceForMilestone(item.milestone) === audience);

  return res.json({ items, counts: summarizeInternalNotifications(items) });
}

export default cors((req, res) => handleInternalNotifications(req, res));
