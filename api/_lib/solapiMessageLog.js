import { maskCustomerPhone } from './customerNotificationHistory.js';
import { authHeader, safeText } from './customerReviewDelivery.js';
import { matchReviewCampaign } from './customerReviewCampaigns.js';
import { INTERNAL_ALERT_CONTACTS, assemblyWorkerPhone } from './internalProductionAlerts.js';
import { ALERT_ROUTES, canonicalAlertRecipientName } from './alertRoutes.js';
import { DELIVERY_ALERT_ADMIN_PHONE } from './solapiDeliveryMonitor.js';

const SOLAPI_URL = 'https://api.solapi.com/messages/v4/list';
const DAY_MS = 86400000;
const PAGE_SIZE = 20;
const CACHE_TTL_MS = 60000;
const CACHE_MAX_DATES = 8;
const PENDING_REPLACEMENT_GRACE_MS = 600000;
const ASSEMBLY_WORKER_NAMES = ['카우사르', '나타왓', '마카라', '백승정', '까지'];
const CACHE = new Map();

const digitsOf = value => String(value || '').replace(/\D/g, '');

export function clearSolapiMessageCache() { CACHE.clear(); }

// ---------- 직원 번호 목록 (번호는 기존 모듈에서만 가져온다) ----------
let staffDirectory = null;
function directory() {
  if (staffDirectory) return staffDirectory;
  const staff = new Map();
  const sales = new Set();
  const add = (phone, name, isSales = false) => {
    const digits = digitsOf(phone);
    if (!digits) return;
    if (!staff.has(digits)) staff.set(digits, name);
    if (isSales) sales.add(digits);
  };
  for (const contact of Object.values(INTERNAL_ALERT_CONTACTS)) add(contact.phone, contact.name);
  for (const worker of ASSEMBLY_WORKER_NAMES) add(assemblyWorkerPhone(worker), worker);
  for (const [name, phone] of Object.entries(ALERT_ROUTES)) add(phone, canonicalAlertRecipientName(name) || name, true);
  add(DELIVERY_ALERT_ADMIN_PHONE, '관리자');
  staffDirectory = { staff, sales };
  return staffDirectory;
}

// ---------- 타입·상태 ----------
export function typeLabel(type) {
  const raw = String(type || '').toUpperCase();
  if (!raw) return '';
  return raw.replace(/_/g, ' ');
}
const isKakaoType = type => /^(ATA|BMS)/i.test(String(type || ''));
const codeOf = message => {
  const code = String(message?.statusCode || '').trim();
  return /^\d{4}$/.test(code) ? code : null;
};

export function classifyStatus(message, { nowMs = Date.now(), replacementPossible = false } = {}) {
  const code = codeOf(message);
  if (code === '4000') return { status: 'success', status_code: code, status_label: '발송 성공' };
  if (code === '2000') return { status: 'pending', status_code: code, status_label: '발송대기' };
  if (code === '3000') return { status: 'pending', status_code: code, status_label: '발송중' };
  if (code && /^[123]\d{3}$/.test(code)) {
    const age = nowMs - Date.parse(message.dateReported || message.dateCreated || '');
    if (code[0] === '3' && replacementPossible && (!Number.isFinite(age) || age < PENDING_REPLACEMENT_GRACE_MS)) {
      return { status: 'pending', status_code: code, status_label: `대체 발송 대기 (${code})` };
    }
    const word = code[0] === '1' ? '접수 실패' : code[0] === '2' ? '검토 실패' : '발송 실패';
    return { status: 'failed', status_code: code, status_label: `${word} (${code})` };
  }
  return { status: 'pending', status_code: code, status_label: '상태 확인 중' };
}

// ---------- 쏠라피 메시지 → 필요한 필드만 ----------
function slimButtons(buttons) {
  return (Array.isArray(buttons) ? buttons : []).map(button => ({
    linkMo: button?.linkMo, linkPc: button?.linkPc, linkMobile: button?.linkMobile,
  }));
}
const FIELD_KEYS = ['hookId', 'hook_id', 'storeId', 'store_id', 'productOrderId'];
export function slimMessage(message = {}) {
  const options = message.kakaoOptions || {};
  const fields = {};
  for (const key of FIELD_KEYS) if (message.customFields?.[key] != null) fields[key] = true;
  return {
    messageId: message.messageId || null, groupId: message.groupId || null,
    to: message.to || '', from: message.from || '', type: message.type || '',
    statusCode: message.statusCode || '', reason: message.reason || message.statusMessage || null,
    dateCreated: message.dateCreated || null, dateReported: message.dateReported || null,
    dateReceived: message.dateReceived || null,
    subject: message.subject ?? null, text: message.text ?? null,
    replacement: message.replacement === true, imageId: message.imageId || null,
    customFields: fields,
    kakaoOptions: {
      pfId: options.pfId, imageId: options.imageId, disableSms: options.disableSms,
      buttons: slimButtons(options.buttons),
      bms: { imageId: options.bms?.imageId, buttons: slimButtons(options.bms?.buttons) },
    },
  };
}

// ---------- 대체 발송 묶기 ----------
export function collapseReplacements(messages = []) {
  const byKey = new Map();
  const seen = new Set();
  for (const message of messages) {
    if (!message?.messageId || seen.has(message.messageId)) continue;
    seen.add(message.messageId);
    const key = `${digitsOf(message.to) || `x:${message.messageId}`}|${message.groupId || message.messageId}`;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(message);
  }
  const entries = [];
  for (const list of byKey.values()) {
    list.sort((a, b) => Date.parse(a.dateCreated || '') - Date.parse(b.dateCreated || ''));
    const local = [];
    for (const message of list) {
      if (message.replacement && local.length) {
        const last = local.at(-1);
        last.final = message;
        last.replaced = true;
      } else local.push({ orig: message, final: message, replaced: false });
    }
    entries.push(...local);
  }
  return entries;
}

// ---------- DB 대조 ----------
const MILESTONE_LABELS = [
  [/^ordered$/, '주문 접수'], [/^started$/, '제작 시작'], [/^packed$/, '포장 완료'], [/^shipped$/, '출고 완료'],
  [/^rescheduled/, '일정 변경'], [/^review:blog$/, '리뷰 이벤트(블로그)'], [/^review:sns$/, '리뷰 이벤트(SNS)'],
  [/^internal_assembly_daily$/, '조립 팀원 알림'], [/^internal_overdue_/, '지연 알림'],
  [/^internal_ship_day$/, '출고일 알림'], [/^sms_delivery_/, '수신 이상 경고'], [/^internal_/, '생산 알림'],
];
function milestoneCategory(milestone) {
  for (const [pattern, label] of MILESTONE_LABELS) if (pattern.test(milestone)) return label;
  return milestone || '고객 문자';
}

export function buildDbIndex(rows = []) {
  const index = new Map();
  for (const row of rows) {
    const id = String(row?.provider_msgid || '').trim();
    if (!id) continue;
    if (!index.has(id)) index.set(id, []);
    index.get(id).push(row);
  }
  return index;
}

export function findDbRow(index, message) {
  const direct = index.get(message.messageId);
  if (direct?.length) return direct[0];
  const rows = message.groupId ? index.get(message.groupId) : null;
  if (!rows?.length) return null;
  const mask = maskCustomerPhone(message.to);
  const matched = rows.filter(row => {
    const stored = maskCustomerPhone(row.to_phone);
    return stored && mask && stored === mask;
  });
  if (matched.length) return matched[0];
  const unknownPhone = rows.filter(row => !maskCustomerPhone(row.to_phone));
  return unknownPhone.length === 1 && rows.length === 1 ? unknownPhone[0] : null;
}

// ---------- 구분·종류 ----------
export function classifyAudience(entry, dbRow) {
  const { staff, sales } = directory();
  const phone = digitsOf(entry.final.to);
  const staffName = staff.get(phone) || null;
  const review = matchReviewCampaign(entry.orig) || matchReviewCampaign(entry.final);
  const reviewCategory = review ? `리뷰 이벤트(${review.id === 'blog' ? '블로그' : 'SNS'})` : null;
  if (dbRow) {
    const milestone = String(dbRow.milestone || '');
    let audience = 'customer';
    let category = milestoneCategory(milestone);
    if (milestone === 'chonbe_alert') {
      audience = sales.has(phone) ? 'staff' : 'other';
      category = audience === 'staff' ? '분체 알림(영업)' : '분체 알림(기타 수신)';
    } else if (milestone.startsWith('internal_') || milestone.startsWith('sms_delivery_')) audience = 'staff';
    return { audience, category, name: dbRow.recipient_name || staffName || null, matched: true };
  }
  if (reviewCategory) return { audience: staffName ? 'staff' : 'customer', category: reviewCategory, name: staffName, matched: false };
  if (staffName) return { audience: 'staff', category: '직원 문자(기록 없음)', name: staffName, matched: false };
  return { audience: 'customer', category: '외부 발송(우리 기록 없음)', name: null, matched: false, external: true };
}

// ---------- item / group ----------
function cut40(value) {
  const text = String(value ?? '');
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

export function buildItems(messages, dbRows = [], { nowMs = Date.now() } = {}) {
  const index = buildDbIndex(dbRows);
  const items = collapseReplacements(messages).map(entry => {
    const { orig, final, replaced } = entry;
    const dbRow = findDbRow(index, final) || (replaced ? findDbRow(index, orig) : null);
    const kind = classifyAudience(entry, dbRow);
    const replacementPossible = !replaced && isKakaoType(orig.type) && orig.kakaoOptions?.disableSms !== true;
    const state = classifyStatus(final, { nowMs, replacementPossible });
    let subject = safeText(final.subject ?? dbRow?.message_subject ?? null);
    let text = safeText(final.text);
    if (kind.external) { text = text == null ? null : cut40(text); subject = subject == null ? null : cut40(subject); }
    return {
      message_id: final.messageId, group_id: final.groupId || null, created_at: orig.dateCreated || null,
      audience: kind.audience, category: kind.category,
      recipient_name: kind.name ? safeText(kind.name) : null,
      to: maskCustomerPhone(final.to) || '', from: maskCustomerPhone(final.from) || '',
      type: final.type, type_label: replaced ? `${typeLabel(orig.type)} → ${typeLabel(final.type)}` : typeLabel(final.type),
      replaced_from: replaced ? orig.type : null,
      ...state,
      reason: state.status === 'success' ? null : safeText(final.reason || null),
      reported_at: final.dateReported || null, received_at: state.status === 'success' ? final.dateReceived || null : null,
      subject, text,
    };
  });
  return items.sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''));
}

const blankCount = () => ({ total: 0, success: 0, pending: 0, failed: 0 });
export function countItems(items) {
  const counts = { all: blankCount(), customer: blankCount(), staff: blankCount(), other: blankCount() };
  for (const item of items) {
    for (const key of ['all', item.audience]) {
      counts[key].total += 1;
      counts[key][item.status] += 1;
    }
  }
  return counts;
}

export function countTypes(items) {
  const map = new Map();
  for (const item of items) map.set(item.type, (map.get(item.type) || 0) + 1);
  return [...map.entries()].map(([type, count]) => ({ type, count })).sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
}

export function typeMatches(item, type) {
  if (!type || type === 'all') return true;
  const wanted = String(type).toUpperCase();
  const names = [item.type, item.replaced_from].filter(Boolean).map(value => String(value).toUpperCase());
  return names.some(name => name === wanted || (wanted === 'BMS' && name.startsWith('BMS')));
}

export function buildGroups(items) {
  const map = new Map();
  for (const item of [...items].reverse()) {
    const key = item.group_id || item.message_id;
    if (!map.has(key)) {
      map.set(key, {
        group_id: item.group_id, created_at: item.created_at, audience: item.audience, category: item.category,
        type_label: item.type_label, total: 0, success: 0, pending: 0, failed: 0, recipients_preview: [],
      });
    }
    const group = map.get(key);
    group.total += 1;
    group[item.status] += 1;
    const label = item.recipient_name || item.to;
    if (label && group.recipients_preview.length < 3 && !group.recipients_preview.includes(label)) group.recipients_preview.push(label);
  }
  return [...map.values()].sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''));
}

export function paginate(list, page) {
  const totalPages = Math.ceil(list.length / PAGE_SIZE);
  const effective = totalPages > 0 ? Math.min(Math.max(1, page), totalPages) : 1;
  return {
    rows: list.slice((effective - 1) * PAGE_SIZE, effective * PAGE_SIZE),
    pagination: { page: effective, page_size: PAGE_SIZE, total_items: list.length, total_pages: totalPages },
  };
}

export function hasSolapiCredentials() {
  return Boolean(process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET);
}

// ---------- 쏠라피 조회 (그날 KST, 최대 3쪽) ----------
export async function fetchSolapiDay(date, { fetchImpl = fetch, nowMs = Date.now() } = {}) {
  const hit = CACHE.get(date);
  if (hit && nowMs - hit.at >= 0 && nowMs - hit.at < CACHE_TTL_MS) return hit.value;
  const start = Date.parse(`${date}T00:00:00+09:00`);
  const messages = [];
  let startKey = null;
  let partial = false;
  for (let page = 0; page < 3; page += 1) {
    const url = new URL(SOLAPI_URL);
    url.searchParams.set('startDate', new Date(start).toISOString());
    url.searchParams.set('endDate', new Date(start + DAY_MS).toISOString());
    url.searchParams.set('limit', '500');
    if (startKey) url.searchParams.set('startKey', startKey);
    const response = await fetchImpl(url, { headers: { Authorization: authHeader() }, signal: AbortSignal.timeout(8000) });
    const payload = await response.json().catch(() => null);
    if (!response.ok || !payload?.messageList || typeof payload.messageList !== 'object') {
      throw new Error(`Solapi message lookup failed: HTTP ${response.status}`);
    }
    for (const message of Object.values(payload.messageList)) {
      const at = Date.parse(message.dateCreated || '');
      if (at >= start && at < start + DAY_MS) messages.push(slimMessage(message));
    }
    startKey = payload.nextKey || null;
    if (!startKey) break;
    if (page === 2) partial = true;
  }
  const value = { messages, partial };
  CACHE.set(date, { at: nowMs, value });
  while (CACHE.size > CACHE_MAX_DATES) CACHE.delete(CACHE.keys().next().value);
  return value;
}
