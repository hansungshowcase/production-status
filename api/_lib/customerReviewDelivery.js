import crypto from 'node:crypto';
import { redactCustomerSnapshot, maskCustomerPhone, validKstDate } from './customerNotificationHistory.js';
import { matchReviewCampaign } from './customerReviewCampaigns.js';

const CACHE = new Map();
const SOLAPI_URL = 'https://api.solapi.com/messages/v4/list';
const normalizePhone = value => String(value || '').replace(/\D/g, '');
const validPhone = value => /^01[016789][0-9]{7,8}$/.test(value);
export const matchReviewMessage = matchReviewCampaign;

function safeText(value) {
  if (value == null) return null;
  return redactCustomerSnapshot(String(value).replace(/https?:\/\/[^\s]*(?:coolsms-storage|amazonaws\.com)[^\s]*/gi, '[만료되는 이미지 링크]'));
}
function codeOf(message) {
  const code = String(message.statusCode || '').trim();
  return /^\d{4}$/.test(code) ? code : null;
}
function stateOf(message, complete, checkedAt) {
  const code = codeOf(message);
  if (code === '4000') return 'received';
  if (code === '2000' || code === '3000') return 'pending';
  if (code && /^[123]\d{3}$/.test(code)) {
    const age = Date.parse(checkedAt) - Date.parse(message.dateReported || message.dateCreated || '');
    if (code === '3120' && message.kakaoOptions?.disableSms === false && (!Number.isFinite(age) || age < 600000)) return 'pending';
    return complete ? 'failed' : 'unknown';
  }
  return 'unknown';
}
function stateLabel(state, code) {
  if (state === 'failed' && code === '1011') return '접수 실패 · 발송정보 형식 오류';
  return { received: '수신 완료', pending: '전달 확인 중', failed: '전달 실패', uncertain: '상태 불확실', unknown: '전달 미확인' }[state];
}

export function buildReviewDeliveryHistory(messages = [], { checkedAt = new Date().toISOString(), complete = true, customerNames = new Map() } = {}) {
  const groups = new Map();
  const seen = new Set();
  for (const message of messages) {
    const campaign = matchReviewCampaign(message);
    if (!campaign || !message.groupId || !message.messageId || seen.has(message.messageId)) continue;
    seen.add(message.messageId);
    const recipient = normalizePhone(message.to);
    const key = `${validPhone(recipient) ? recipient : `invalid:${message.messageId}`}|${message.groupId}|${campaign.id}`;
    if (!groups.has(key)) groups.set(key, { campaign, messages: [] });
    groups.get(key).messages.push(message);
  }
  return [...groups.entries()].map(([key, group]) => {
    const ordered = group.messages.sort((a, b) => Date.parse(a.dateCreated || '') - Date.parse(b.dateCreated || ''));
    const final = ordered.at(-1);
    const recipient = normalizePhone(final.to);
    const ambiguous = ordered.filter(message => !message.replacement).length > 1;
    const state = ambiguous ? 'uncertain' : stateOf(final, complete, checkedAt);
    const code = codeOf(final);
    return {
      id: `solapi:${crypto.createHash('sha256').update(key).digest('hex').slice(0, 24)}`,
      order_id: null, customer_name: safeText(customerNames.get(recipient) || '기존 리뷰 고객'),
      phone: validPhone(recipient) ? maskCustomerPhone(recipient) : '번호 형식 오류',
      kind: `review_${group.campaign.id}`, kind_label: group.campaign.name,
      channel: [...new Set(ordered.map(message => message.type))].join(' → '),
      status: state === 'received' ? 'success' : state === 'pending' ? 'sending' : state,
      subject: safeText(final.subject) || group.campaign.subject, text: safeText(final.text),
      sent_at: ordered[0].dateCreated || null,
      delivery: { state, label: stateLabel(state, code), code, reported_at: final.dateReported || null,
        received_at: state === 'received' ? final.dateReceived || null : null, checked_at: checkedAt },
      attempts: ordered.map(message => {
        const attemptState = stateOf(message, complete, checkedAt), attemptCode = codeOf(message);
        return { channel: message.type, code: attemptCode, state: attemptState, label: stateLabel(attemptState, attemptCode) };
      }),
      attempt_count: ordered.length,
    };
  });
}

function authHeader() {
  const key = process.env.SOLAPI_API_KEY, secret = process.env.SOLAPI_API_SECRET;
  if (!key || !secret) throw new Error('Solapi credentials are not configured');
  const date = new Date().toISOString(), salt = crypto.randomBytes(16).toString('hex');
  const signature = crypto.createHmac('sha256', secret).update(date + salt).digest('hex');
  return `HMAC-SHA256 apiKey=${key}, date=${date}, salt=${salt}, signature=${signature}`;
}

export async function fetchReviewMessages(date, { fetchImpl = fetch, nowMs = Date.now(), cache = true } = {}) {
  if (!validKstDate(date)) throw new Error('Invalid review lookup date');
  const hit = CACHE.get(date);
  if (cache && hit && nowMs - hit.at >= 0 && nowMs - hit.at < 60000) return hit.value;
  const start = Date.parse(`${date}T00:00:00+09:00`);
  let startKey;
  const messages = [];
  let complete = true;
  for (let page = 0; page < 3; page += 1) {
    const url = new URL(SOLAPI_URL);
    url.searchParams.set('startDate', new Date(start).toISOString());
    url.searchParams.set('endDate', new Date(start + 86400000).toISOString());
    url.searchParams.set('limit', '500');
    if (startKey) url.searchParams.set('startKey', startKey);
    const response = await fetchImpl(url, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(5000) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.messageList || typeof payload.messageList !== 'object') throw new Error(`Solapi review lookup failed: HTTP ${response.status}`);
    for (const message of Object.values(payload.messageList)) {
      const at = Date.parse(message.dateCreated || '');
      if (at >= start && at < start + 86400000 && matchReviewCampaign(message)) messages.push(message);
    }
    startKey = payload.nextKey || null;
    if (!startKey) break;
    if (page === 2) complete = false;
  }
  const value = { messages, complete };
  if (cache) {
    CACHE.set(date, { at: nowMs, value });
    while (CACHE.size > 32) CACHE.delete(CACHE.keys().next().value);
  }
  return value;
}
export function clearReviewMessageCache() { CACHE.clear(); }
