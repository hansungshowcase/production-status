import { cors } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { rateLimitCheck } from './_lib/rateLimit.js';
import { maskCustomerPhone, redactCustomerSnapshot } from './_lib/customerNotificationHistory.js';
import { publicReviewCampaigns } from './_lib/customerReviewCampaigns.js';

const PAGE_SIZE = 10;
const value = input => Array.isArray(input) ? input[0] : input;
const PACKED_TARGET = `FROM orders o JOIN (
  SELECT order_id, MAX(completed_at) AS packed_at FROM processes
  WHERE step_name = '포장' AND status = 'completed' GROUP BY order_id
) p ON p.order_id = o.id
WHERE o.status IN ('in_production', 'shipped')
  AND COALESCE(o.lead_source, '') !~* '(스마트스토어|smartstore|네이버스토어)'`;

export function serializeReviewTarget(row, campaignId) {
  const reasons = [];
  if (!/^01[016789][0-9]{7,8}$/.test(String(row.phone || '').replace(/\D/g, ''))) reasons.push({ code: 'phone_missing', label: '연락처 확인 필요' });
  if (!String(row.lead_source || '').trim()) reasons.push({ code: 'source_unknown', label: '구매 경로 확인 필요' });
  else reasons.push({ code: 'source_unverified', label: '리뷰 대상 구매 경로 대조 필요' });
  reasons.push({ code: 'consent_unverified', label: '리뷰 안내 수신 동의 확인 필요' });
  return {
    orderId: Number(row.id), customer_name: redactCustomerSnapshot(row.client_name || '고객명 미확인'),
    maskedRecipient: maskCustomerPhone(row.phone), packedAt: row.packed_at || null,
    campaignId, eligibility: 'blocked', reasons,
  };
}

export async function handleCustomerReviews(req, res, dependencies = {}) {
  for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) res.setHeader(header, 'no-store');
  if (req.method !== 'GET') return res.status(405).json({ error: { message: 'Method not allowed' } });
  if (!(dependencies.rateLimitCheck || rateLimitCheck)(req, res, { windowMs: 60000, max: 60 })) return;
  const campaigns = publicReviewCampaigns();
  const campaignId = String(value(req.query?.campaign) || 'blog');
  if (!campaigns.some(item => item.id === campaignId)) return res.status(400).json({ error: { message: '등록되지 않은 리뷰 이벤트입니다.', status: 400 } });
  const db = dependencies.db || getDb();
  const counted = await db.execute({ sql: `SELECT COUNT(*) AS total ${PACKED_TARGET}`, args: [] });
  const total = Math.max(0, Number(counted.rows?.[0]?.total) || 0);
  const pages = Math.ceil(total / PAGE_SIZE);
  const requested = Number.parseInt(String(value(req.query?.page) || '1'), 10);
  const page = pages ? Math.min(Math.max(1, Number.isFinite(requested) ? requested : 1), pages) : 1;
  const result = await db.execute({ sql: `SELECT o.id, o.client_name, o.phone, o.lead_source, p.packed_at
    ${PACKED_TARGET} ORDER BY p.packed_at DESC NULLS LAST, o.id DESC LIMIT ? OFFSET ?`, args: [PAGE_SIZE, (page - 1) * PAGE_SIZE] });
  return res.status(200).json({
    campaigns, items: (result.rows || []).map(row => serializeReviewTarget(row, campaignId)),
    counts: { total, ready: 0, blocked: total },
    pagination: { page, page_size: PAGE_SIZE, total_items: total, total_pages: pages },
    connection: { state: 'pending', label: '기존 리뷰 발송 연결 확인 필요', canSend: false,
      notice: '발송이력은 고객 발송이력에서 확인할 수 있습니다. 신규 발송은 기존 Make 연결과 대상 구매 경로·수신 동의 확인 후 사용할 수 있습니다.' },
  });
}

export default cors((req, res) => handleCustomerReviews(req, res));
