import { cors } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import {
  audienceForMilestone,
  isPublicNotificationRow,
  NOTIFICATION_RECIPIENT_NAMES,
  PUBLIC_CHONBE_RECIPIENTS,
  recipientFilterForName,
  serializeInternalNotification,
} from './_lib/internalNotificationHistory.js';
import { ensureInternalNotificationHistorySchema } from './_lib/notifySchema.js';
import { rateLimitCheck } from './_lib/rateLimit.js';

const AUDIENCES = new Set(['all', 'executive', 'member', 'sales']);
const HISTORY_START_DATE = '2026-09-01';
const DEFAULT_PAGE_SIZE = 10;

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

function countValue(value) {
  const count = Number(value);
  return Number.isFinite(count) && count > 0 ? count : 0;
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
  if (recipient && !NOTIFICATION_RECIPIENT_NAMES.has(recipient)) {
    return res.status(400).json({
      error: { message: '등록되지 않은 수신자입니다.', status: 400 },
    });
  }

  const date = String(queryValue(req.query?.date) || '').trim();
  if (date && !isValidDate(date)) {
    return res.status(400).json({
      error: { message: '올바른 조회 날짜가 아닙니다.', status: 400 },
    });
  }

  const limit = DEFAULT_PAGE_SIZE;
  const requestedPage = Number.parseInt(queryValue(req.query?.page), 10);
  const page = Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1);
  const db = dependencies.db || getDb();
  await (dependencies.ensureSchema || ensureInternalNotificationHistorySchema)(db);

  const salesNames = PUBLIC_CHONBE_RECIPIENTS.map(({ name }) => name);
  const salesPhones = PUBLIC_CHONBE_RECIPIENTS.map(({ maskedPhone }) => maskedPhone);
  const filters = [
    `(LEFT(milestone, 9) = 'internal_'
      OR (milestone = 'chonbe_alert'
        AND (BTRIM(COALESCE(recipient_name, '')) IN (${salesNames.map(() => '?').join(', ')})
          OR ((recipient_name IS NULL OR BTRIM(recipient_name) = '')
            AND to_phone IN (${salesPhones.map(() => '?').join(', ')})))))`,
    "(created_at AT TIME ZONE 'Asia/Seoul')::date >= ?::date",
  ];
  const args = [...salesNames, ...salesPhones, HISTORY_START_DATE];
  if (audience === 'member') filters.push("milestone = 'internal_assembly_daily'");
  if (audience === 'executive') {
    filters.push("LEFT(milestone, 9) = 'internal_'");
    filters.push("milestone <> 'internal_assembly_daily'");
  }
  if (audience === 'sales') filters.push("milestone = 'chonbe_alert'");
  if (recipient) {
    const recipientFilter = recipientFilterForName(recipient);
    const legacyPhoneFilter = recipientFilter.maskedPhone ? ' AND to_phone = ?' : '';
    filters.push(`(recipient_name = ? OR ((recipient_name IS NULL OR BTRIM(recipient_name) = '') AND milestone = ?${legacyPhoneFilter}))`);
    args.push(recipient, recipientFilter.milestone);
    if (recipientFilter.maskedPhone) args.push(recipientFilter.maskedPhone);
  }
  if (date) {
    filters.push("(created_at AT TIME ZONE 'Asia/Seoul')::date = ?::date");
    args.push(date);
  }

  const { rows: countRows } = await db.execute({
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE status = 'success') AS success,
                 COUNT(*) FILTER (WHERE COALESCE(status, 'failed') NOT IN ('success', 'dry_run')) AS failed,
                 COUNT(*) FILTER (WHERE status = 'dry_run') AS dry_run
            FROM notification_log
           WHERE ${filters.join(' AND ')}`,
    args: [...args],
  });

  const countRow = countRows?.[0] || {};
  const counts = {
    total: countValue(countRow.total),
    success: countValue(countRow.success),
    failed: countValue(countRow.failed),
    dry_run: countValue(countRow.dry_run),
  };
  const totalPages = Math.ceil(counts.total / limit);
  const effectivePage = totalPages > 0 ? Math.min(page, totalPages) : 1;
  const offset = (effectivePage - 1) * limit;

  const { rows } = await db.execute({
    sql: `SELECT id, milestone, to_phone, status, recipient_name,
                 message_subject, message_text, created_at
            FROM notification_log
           WHERE ${filters.join(' AND ')}
           ORDER BY created_at DESC, id DESC
           LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  });

  const items = rows
    .filter(isPublicNotificationRow)
    .map(serializeInternalNotification)
    .filter(item => audience === 'all' || audienceForMilestone(item.milestone) === audience);

  return res.json({
    items,
    counts,
    pagination: {
      page: effectivePage,
      page_size: limit,
      total_items: counts.total,
      total_pages: totalPages,
    },
  });
}

export default cors((req, res) => handleInternalNotifications(req, res));
