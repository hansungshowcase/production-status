const CUSTOMER_MILESTONE_DEFINITIONS = Object.freeze([
  ['ordered', 'ordered', '주문 접수'],
  ['started', 'started', '제작 시작'],
  ['packed', 'packed', '포장 완료'],
  ['shipped', 'shipped', '출고 완료'],
  ['rescheduled', 'rescheduled', '일정 변경'],
  ['review_blog', 'review:blog', '블로그 후기'],
  ['review_sns', 'review:sns', 'SNS 후기'],
]);

export const CUSTOMER_KINDS = Object.freeze(CUSTOMER_MILESTONE_DEFINITIONS.map(([id, _milestone, label]) => ({ id, label })));
const KIND_BY_MILESTONE = new Map(CUSTOMER_MILESTONE_DEFINITIONS.map(([id, milestone, label]) => [milestone, { id, label }]));

export const CUSTOMER_STATUS_SQL = `CASE
  WHEN n.status IN ('success', 'failed', 'queued', 'sending', 'uncertain', 'skipped', 'dry_run') THEN n.status
  ELSE 'unknown'
END`;

export const CUSTOMER_DELIVERY_SQL = `CASE
  WHEN BTRIM(COALESCE(n.delivery_status_code, '')) = '4000' THEN 'received'
  WHEN BTRIM(COALESCE(n.delivery_status_code, '')) IN ('2000', '3000') THEN 'pending'
  WHEN BTRIM(COALESCE(n.delivery_status_code, '')) ~ '^[123][0-9]{3}$' THEN 'failed'
  WHEN COALESCE(n.status, '') = 'failed' THEN 'failed'
  WHEN COALESCE(n.status, '') IN ('queued', 'skipped', 'dry_run') THEN 'not_sent'
  WHEN COALESCE(n.status, '') = 'sending' THEN 'pending'
  WHEN COALESCE(n.status, '') = 'uncertain' THEN 'uncertain'
  ELSE 'unknown'
END`;

const DELIVERY_LABELS = Object.freeze({
  received: '수신 완료', failed: '수신 실패', pending: '수신 확인 중',
  unknown: '수신 확인 불가', not_sent: '발송 안 함', uncertain: '상태 미확인',
});

const PHONE_PATTERN = /(?<!\d)(01[016789])[- .]?(\d{3,4})[- .]?(\d{4})(?!\d)/g;
const TRACK_PATTERN = /https?:\/\/[^\s]*\/track\/[^\s)]+|\/track\/[A-Za-z0-9._~-]+/gi;

export function validKstDate(value) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function milestoneKind(milestone) {
  const raw = String(milestone || '');
  if (/^rescheduled:\d{4}-\d{2}-\d{2}$/.test(raw)) return KIND_BY_MILESTONE.get('rescheduled');
  return KIND_BY_MILESTONE.get(raw) || null;
}

export function maskCustomerPhone(value) {
  const raw = String(value || '').trim();
  if (/^\d{3}\*{4}\d{4}$/.test(raw)) return raw;
  const digits = raw.replace(/\D/g, '');
  return digits.length >= 8 ? `${digits.slice(0, 3)}****${digits.slice(-4)}` : '';
}

export function redactCustomerSnapshot(value) {
  if (value == null) return null;
  return String(value)
    .replace(TRACK_PATTERN, '[링크 비공개]')
    .replace(PHONE_PATTERN, (_match, prefix, _middle, suffix) => `${prefix}****${suffix}`);
}

export function normalizeCustomerStatus(value) {
  const status = String(value || '').trim();
  return ['success', 'failed', 'queued', 'sending', 'uncertain', 'skipped', 'dry_run'].includes(status)
    ? status : 'unknown';
}

export function classifyCustomerDelivery(row) {
  const code = String(row?.delivery_status_code || '').trim();
  let state = 'unknown';
  if (code === '4000') state = 'received';
  else if (code === '2000' || code === '3000') state = 'pending';
  else if (/^[123]\d{3}$/.test(code)) state = 'failed';
  else {
    const status = normalizeCustomerStatus(row?.status);
    if (status === 'failed') state = 'failed';
    else if (['queued', 'skipped', 'dry_run'].includes(status)) state = 'not_sent';
    else if (status === 'sending') state = 'pending';
    else if (status === 'uncertain') state = 'uncertain';
  }
  return { state, label: DELIVERY_LABELS[state], code: /^\d{4}$/.test(code) ? code : null };
}

export function serializeCustomerNotification(row) {
  const kind = milestoneKind(row?.milestone);
  if (!kind) return null;
  const delivery = classifyCustomerDelivery(row);
  const subject = redactCustomerSnapshot(row?.message_subject);
  return {
    id: Number(row?.id), order_id: row?.order_id ?? null,
    customer_name: redactCustomerSnapshot(row?.recipient_name || row?.client_name || '고객명 미보관') || '고객명 미보관',
    phone: maskCustomerPhone(row?.to_phone), kind: kind.id, kind_label: kind.label,
    channel: row?.channel || null, status: normalizeCustomerStatus(row?.status),
    subject: subject || kind.label, text: redactCustomerSnapshot(row?.message_text),
    sent_at: row?.created_at || null,
    delivery: {
      state: delivery.state, label: delivery.label, code: delivery.code,
      reported_at: row?.delivery_reported_at || null,
      received_at: delivery.state === 'received' ? row?.delivery_received_at || null : null,
      checked_at: row?.delivery_checked_at || null,
    },
  };
}

export function countCustomerRows(rows = []) {
  const counts = { total: rows.length, success: 0, failed: 0, queued: 0, sending: 0, uncertain: 0, skipped: 0, dry_run: 0,
    delivery: { received: 0, failed: 0, pending: 0, unknown: 0, not_sent: 0, uncertain: 0 } };
  for (const row of rows) {
    const status = normalizeCustomerStatus(row?.status);
    if (status in counts && status !== 'total') counts[status] += 1;
    const delivery = classifyCustomerDelivery(row).state;
    counts.delivery[delivery] += 1;
  }
  return counts;
}

export const CUSTOMER_MILESTONE_PREDICATE = `(n.milestone IN ('ordered', 'started', 'packed', 'shipped', 'rescheduled', 'review:blog', 'review:sns') OR n.milestone ~ '^rescheduled:[0-9]{4}-[0-9]{2}-[0-9]{2}$')`;
