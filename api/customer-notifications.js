import { cors } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { rateLimitCheck } from './_lib/rateLimit.js';
import {
  CUSTOMER_DELIVERY_SQL, CUSTOMER_KINDS, CUSTOMER_MILESTONE_PREDICATE, CUSTOMER_STATUS_SQL,
  serializeCustomerNotification, validKstDate,
} from './_lib/customerNotificationHistory.js';

import { buildReviewDeliveryHistory, fetchReviewMessages } from './_lib/customerReviewDelivery.js';

const PAGE_SIZE = 10;
const queryValue = (value) => (Array.isArray(value) ? value[0] : value);
const countValue = (value) => Math.max(0, Number(value) || 0);

function filters(date, kind) {
  const clauses = [CUSTOMER_MILESTONE_PREDICATE];
  const args = [];
  if (date) {
    clauses.push(`(n.created_at AT TIME ZONE 'Asia/Seoul')::date = ?::date`);
    args.push(date);
  }
  if (kind) {
    clauses.push(kind === 'rescheduled' ? "(n.milestone = 'rescheduled' OR n.milestone LIKE 'rescheduled:%')" : 'n.milestone = ?');
    if (kind !== 'rescheduled') args.push(kind === 'review_blog' ? 'review:blog' : kind === 'review_sns' ? 'review:sns' : kind);
  }
  return { where: clauses.join(' AND '), args };
}

export async function handleCustomerNotifications(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: { message: 'Method not allowed' } });
  const checkRateLimit = dependencies.rateLimitCheck || rateLimitCheck;
  if (!checkRateLimit(req, res, { windowMs: 60000, max: 60 })) return;
  const date = String(queryValue(req.query?.date) || '').trim();
  if (date && !validKstDate(date)) return res.status(400).json({ error: { message: '유효한 KST 날짜가 필요합니다.', status: 400 } });
  const requestedKind = String(queryValue(req.query?.kind) || '').trim();
  const kind = requestedKind ? CUSTOMER_KINDS.find((item) => item.id === requestedKind) : null;
  if (requestedKind && !kind) return res.status(400).json({ error: { message: '유효하지 않은 고객 이력 종류입니다.', status: 400 } });
  const requestedPage = Number.parseInt(String(queryValue(req.query?.page) || '1'), 10);
  const page = Number.isFinite(requestedPage) ? Math.max(1, requestedPage) : 1;
  const db = dependencies.db || getDb();
  const filter = filters(date, kind?.id || '');
  const base = `FROM notification_log n LEFT JOIN orders o ON o.id = n.order_id WHERE ${filter.where}`;
  const countsResult = await db.execute({ sql: `SELECT COUNT(*) AS total,
    COUNT(*) FILTER (WHERE (${CUSTOMER_STATUS_SQL}) = 'success') AS success,
    COUNT(*) FILTER (WHERE (${CUSTOMER_STATUS_SQL}) = 'failed') AS failed,
    COUNT(*) FILTER (WHERE (${CUSTOMER_STATUS_SQL}) = 'queued') AS queued,
    COUNT(*) FILTER (WHERE (${CUSTOMER_STATUS_SQL}) = 'sending') AS sending,
    COUNT(*) FILTER (WHERE (${CUSTOMER_STATUS_SQL}) = 'uncertain') AS uncertain,
    COUNT(*) FILTER (WHERE (${CUSTOMER_STATUS_SQL}) = 'skipped') AS skipped,
    COUNT(*) FILTER (WHERE (${CUSTOMER_STATUS_SQL}) = 'dry_run') AS dry_run,
    COUNT(*) FILTER (WHERE (${CUSTOMER_DELIVERY_SQL}) = 'received') AS delivery_received,
    COUNT(*) FILTER (WHERE (${CUSTOMER_DELIVERY_SQL}) = 'failed') AS delivery_failed,
    COUNT(*) FILTER (WHERE (${CUSTOMER_DELIVERY_SQL}) = 'pending') AS delivery_pending,
    COUNT(*) FILTER (WHERE (${CUSTOMER_DELIVERY_SQL}) = 'unknown') AS delivery_unknown,
    COUNT(*) FILTER (WHERE (${CUSTOMER_DELIVERY_SQL}) = 'not_sent') AS delivery_not_sent,
    COUNT(*) FILTER (WHERE (${CUSTOMER_DELIVERY_SQL}) = 'uncertain') AS delivery_uncertain ${base}`, args: filter.args });
  const countRow = countsResult.rows?.[0] || {};
  const localTotal = countValue(countRow.total);
  const counts = { total: localTotal, success: countValue(countRow.success), failed: countValue(countRow.failed), queued: countValue(countRow.queued), sending: countValue(countRow.sending), uncertain: countValue(countRow.uncertain), skipped: countValue(countRow.skipped), dry_run: countValue(countRow.dry_run), delivery: { received: countValue(countRow.delivery_received), failed: countValue(countRow.delivery_failed), pending: countValue(countRow.delivery_pending), unknown: countValue(countRow.delivery_unknown), not_sent: countValue(countRow.delivery_not_sent), uncertain: countValue(countRow.delivery_uncertain) } };
  let reviews = [];
  let reviewSync = { state: 'not_requested', notice: '' };
  if (!requestedKind || requestedKind.startsWith('review_')) {
    reviewSync = { state: 'date_required', notice: '기존 리뷰 발송이력은 날짜를 선택하면 함께 조회됩니다.' };
    if (date) {
      try {
        const source = await (dependencies.fetchReviewMessages || fetchReviewMessages)(date);
        const checkedAt = new Date().toISOString();
        const customerNames = await resolveCustomerNames(db, source.messages);
        reviews = buildReviewDeliveryHistory(source.messages, { checkedAt, complete: source.complete, customerNames })
          .filter(item => !requestedKind || item.kind === requestedKind);
        reviewSync = { state: source.complete ? 'ready' : 'partial', checked_at: checkedAt,
          notice: source.complete ? '기존 SOLAPI 리뷰 발송 결과가 반영됐습니다.' : '기존 리뷰 발송량이 많아 일부 기록만 조회됐습니다. 표시된 합계는 조회된 기록 기준입니다.' };
      } catch {
        reviewSync = { state: 'error', notice: '기존 리뷰 발송이력을 조회하지 못했습니다. 아래에는 프로그램에 보관된 기록만 표시됩니다.' };
      }
    }
  }
  for (const item of reviews) {
    counts.total += 1;
    if (Object.hasOwn(counts, item.status)) counts[item.status] += 1;
    if (Object.hasOwn(counts.delivery, item.delivery.state)) counts.delivery[item.delivery.state] += 1;
  }
  const totalPages = Math.ceil(counts.total / PAGE_SIZE);
  const effectivePage = totalPages ? Math.min(page, totalPages) : 1;
  const offset = (effectivePage - 1) * PAGE_SIZE;
  const mergeReviews = reviews.length > 0;
  const rowsResult = await db.execute({ sql: `SELECT n.id, n.order_id, n.milestone, n.channel, n.to_phone, n.status,
    n.recipient_name, o.client_name, n.message_subject, n.message_text, n.created_at,
    n.delivery_status_code, n.delivery_reported_at, n.delivery_received_at, n.delivery_checked_at
    ${base} ORDER BY n.created_at DESC, n.id DESC LIMIT ? OFFSET ?`, args: [...filter.args, mergeReviews ? effectivePage * PAGE_SIZE : PAGE_SIZE, mergeReviews ? 0 : offset] });
  let items = (rowsResult.rows || []).map(serializeCustomerNotification).filter(Boolean);
  if (mergeReviews) items = [...items, ...reviews].sort((a, b) => Date.parse(b.sent_at || '') - Date.parse(a.sent_at || '') || String(b.id).localeCompare(String(a.id))).slice(offset, offset + PAGE_SIZE);
  return res.status(200).json({
    items, kinds: CUSTOMER_KINDS, counts, review_sync: reviewSync,
    pagination: { page: effectivePage, page_size: PAGE_SIZE, total_items: counts.total, total_pages: totalPages },
  });
}

async function resolveCustomerNames(db, messages) {
  const phones = [...new Set((messages || []).map(message => String(message.to || '').replace(/[^0-9]/g, '')).filter(phone => /^01[016789][0-9]{7,8}$/.test(phone)))];
  if (!phones.length) return new Map();
  const result = await db.execute({ sql: `SELECT REGEXP_REPLACE(phone, '[^0-9]', '', 'g') AS recipient,
    CASE WHEN COUNT(DISTINCT client_name) = 1 THEN MIN(client_name) END AS customer_name
    FROM orders WHERE REGEXP_REPLACE(phone, '[^0-9]', '', 'g') IN (${phones.map(() => '?').join(',')})
    GROUP BY REGEXP_REPLACE(phone, '[^0-9]', '', 'g')`, args: phones });
  return new Map((result.rows || []).filter(row => row.customer_name).map(row => [row.recipient, row.customer_name]));
}

export default cors((req, res) => handleCustomerNotifications(req, res));
