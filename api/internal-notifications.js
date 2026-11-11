import { cors } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import {
  audienceForMilestone,
  isPublicNotificationRow,
  maskedPhoneForInternalMember,
  NOTIFICATION_RECIPIENT_NAMES,
  PUBLIC_CHONBE_RECIPIENTS,
  DELIVERY_CLASSIFICATION_SQL,
  recipientFilterForName,
  serializeInternalNotification,
} from './_lib/internalNotificationHistory.js';
import { INTERNAL_ALERT_CONTACTS } from './_lib/internalProductionAlerts.js';
import { rateLimitCheck } from './_lib/rateLimit.js';

const AUDIENCES = new Set(['all', 'executive', 'member', 'sales']);
const HISTORY_START_DATE = '2026-09-01';
const DEFAULT_PAGE_SIZE = 10;
// 직원 문자 관리 '하루 보기'(2026-11-11 사장님 "이름 누르면 그날 발송된 문자 … 전체보기를 누르면 발송 순서대로"):
// 그날 기록을 한 번에, 먼저 보낸 것부터. 하루 실측 20~40건이라 300건이면 넉넉하다.
const DAY_VIEW_LIMIT = 300;

function phoneTail(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return digits.length >= 4 ? digits.slice(-4) : '';
}

// 문자를 받도록 등록된 직원(수신자 필터 순서)과 번호 끝 4자리. 전체·가린 번호는 내보내지 않는다.
export function registeredRecipients() {
  const executivePhones = Object.fromEntries(
    Object.values(INTERNAL_ALERT_CONTACTS).map(({ name, phone }) => [name, phone]),
  );
  const salesPhones = Object.fromEntries(PUBLIC_CHONBE_RECIPIENTS.map(({ name, maskedPhone }) => [name, maskedPhone]));
  return [...NOTIFICATION_RECIPIENT_NAMES].map(name => ({
    name,
    phone_tail: phoneTail(executivePhones[name] || salesPhones[name] || maskedPhoneForInternalMember(name)),
  }));
}

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

  const dayView = String(queryValue(req.query?.view) || '') === 'day';
  if (dayView && !date) {
    return res.status(400).json({
      error: { message: '하루 보기는 날짜가 필요합니다.', status: 400 },
    });
  }

  const limit = DEFAULT_PAGE_SIZE;
  const requestedPage = Number.parseInt(queryValue(req.query?.page), 10);
  const page = Math.max(1, Number.isFinite(requestedPage) ? requestedPage : 1);
  const db = dependencies.db || getDb();

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

  const selectColumns = `SELECT id, milestone, to_phone, status, recipient_name,
                 message_subject, message_text, created_at,
                 delivery_status_code, delivery_reported_at,
                 delivery_received_at, delivery_checked_at
            FROM notification_log
           WHERE ${filters.join(' AND ')}`;
  const toItems = rows => rows
    .filter(isPublicNotificationRow)
    .map(serializeInternalNotification)
    .filter(item => audience === 'all' || audienceForMilestone(item.milestone) === audience);

  // 하루 보기: 건수 집계 없이 그날 기록만(먼저 보낸 것부터). 한 건 더 읽어 상한을 넘었는지 본다.
  if (dayView) {
    const { rows: dayRows } = await db.execute({
      sql: `${selectColumns}
           ORDER BY created_at ASC, id ASC
           LIMIT ?`,
      args: [...args, DAY_VIEW_LIMIT + 1],
    });
    return res.json({
      items: toItems(dayRows.slice(0, DAY_VIEW_LIMIT)),
      recipients: registeredRecipients(),
      truncated: dayRows.length > DAY_VIEW_LIMIT,
    });
  }

  const { rows: countRows } = await db.execute({
    sql: `SELECT COUNT(*) AS total,
                 COUNT(*) FILTER (WHERE status = 'success') AS success,
                 COUNT(*) FILTER (WHERE COALESCE(status, 'failed') NOT IN ('success', 'dry_run')) AS failed,
                 COUNT(*) FILTER (WHERE status = 'dry_run') AS dry_run,
                 COUNT(*) FILTER (WHERE (${DELIVERY_CLASSIFICATION_SQL}) = 'received') AS delivery_received,
                 COUNT(*) FILTER (WHERE (${DELIVERY_CLASSIFICATION_SQL}) = 'failed') AS delivery_failed,
                 COUNT(*) FILTER (WHERE (${DELIVERY_CLASSIFICATION_SQL}) = 'pending') AS delivery_pending,
                 COUNT(*) FILTER (WHERE (${DELIVERY_CLASSIFICATION_SQL}) = 'unknown') AS delivery_unknown
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
    delivery: {
      received: countValue(countRow.delivery_received),
      failed: countValue(countRow.delivery_failed),
      pending: countValue(countRow.delivery_pending),
      unknown: countValue(countRow.delivery_unknown),
    },
  };
  const totalPages = Math.ceil(counts.total / limit);
  const effectivePage = totalPages > 0 ? Math.min(page, totalPages) : 1;
  const offset = (effectivePage - 1) * limit;

  const { rows } = await db.execute({
    sql: `${selectColumns}
           ORDER BY created_at DESC, id DESC
           LIMIT ? OFFSET ?`,
    args: [...args, limit, offset],
  });

  const items = toItems(rows);

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
