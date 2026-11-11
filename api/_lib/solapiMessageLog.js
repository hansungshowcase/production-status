import { maskCustomerPhone } from './customerNotificationHistory.js';
import { authHeader, safeText } from './customerReviewDelivery.js';
import { matchReviewCampaign } from './customerReviewCampaigns.js';
import { INTERNAL_ALERT_CONTACTS, assemblyWorkerPhone } from './internalProductionAlerts.js';
import { ALERT_ROUTES, canonicalAlertRecipientName } from './alertRoutes.js';
import { DELIVERY_ALERT_ADMIN_PHONE } from './solapiDeliveryMonitor.js';

const SOLAPI_URL = 'https://api.solapi.com/messages/v4/list';
const DAY_MS = 86400000;
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
function slimLog(log) {
  return (Array.isArray(log) ? log : []).slice(-20).map(entry => ({
    createAt: entry?.createAt || null, message: entry?.message == null ? null : String(entry.message).slice(0, 300),
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
    networkName: message.networkName || null, country: message.country || null,
    autoTypeDetect: typeof message.autoTypeDetect === 'boolean' ? message.autoTypeDetect : null,
    dateUpdated: message.dateUpdated || null, dateProcessed: message.dateProcessed || null,
    log: slimLog(message.log),
    kakaoOptions: {
      templateId: options.templateId || null,
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
export function classifyAudience(entry, dbRow, source = null) {
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
  return { audience: 'customer', category: externalCategory(entry, source), name: null, matched: false, external: true };
}

// 우리 기록에 없는 고객 문자: 본문 첫머리로 종류, 쏠라피 연동 표시(customFields 키)로 발송처를 붙인다.
const EXTERNAL_TOPICS = [
  [/주문이 정상|주문(이)? 접수|주문 확인/, '주문 안내'],
  [/출고일|출고 안내|출고되었|출고 예정/, '출고 안내'],
  [/무료 지원 이벤트/, '무료 지원 이벤트'],
  [/리뷰|후기/, '리뷰 안내'],
];
export const SOURCE_NAMES = { AUTO: '쏠라피 자동화', COMM: '스마트스토어 연동', API: '다른 API 프로그램', APP: '쏠라피 앱' };
export function externalCategory(entry, source = null) {
  const text = [entry.orig.subject, entry.orig.text, entry.final.subject, entry.final.text].filter(Boolean).join(' ').slice(0, 300);
  const found = EXTERNAL_TOPICS.find(([pattern]) => pattern.test(text));
  const topic = found ? found[1] : /\(광고\)/.test(text) ? '광고 문자' : '기타 고객 문자';
  const fields = entry.orig.customFields || {};
  const sourceName = SOURCE_NAMES[source] || ((fields.storeId || fields.store_id || fields.productOrderId) ? '스마트스토어 연동'
    : (fields.hookId || fields.hook_id) ? '쏠라피 자동발송' : '외부 발송');
  return `${topic}(${sourceName})`;
}

// ---------- item / group ----------
function cut40(value) {
  const text = String(value ?? '');
  return text.length > 40 ? `${text.slice(0, 40)}…` : text;
}

const TYPE_NAMES = { SMS: '단문문자', LMS: '장문문자', MMS: '사진문자', ATA: '알림톡', CTA: '친구톡', CTI: '친구톡', NSA: '네이버톡' };
export function typeName(type) {
  const raw = String(type || '').toUpperCase();
  if (!raw) return '';
  if (raw.startsWith('BMS')) return '브랜드메시지';
  if (raw.startsWith('RCS')) return 'RCS';
  return TYPE_NAMES[raw] || raw;
}
export function textBytes(text) {
  let bytes = 0;
  for (const ch of String(text ?? '')) bytes += ch.codePointAt(0) >= 0x80 ? 2 : 1;
  return bytes;
}
function statusText(state, code) {
  if (state.status === 'success') return '발송완료';
  if (state.status === 'failed') return code && /^[12]/.test(code) ? '발송불가' : '발송실패';
  if (/^대체 발송 대기/.test(state.status_label)) return '대체발송대기';
  if (code === '2000') return '발송대기';
  if (code === '3000') return '발송중';
  return '상태확인중';
}
function sourceOf(groupSources, groupId) {
  if (!groupSources || !groupId) return null;
  const value = groupSources instanceof Map ? groupSources.get(groupId) : groupSources[groupId];
  return value || null;
}
const nullable = value => (value == null || value === '' ? null : String(value));

export function buildItems(messages, dbRows = [], { nowMs = Date.now(), groupSources = null } = {}) {
  const index = buildDbIndex(dbRows);
  const items = collapseReplacements(messages).map(entry => {
    const { orig, final, replaced } = entry;
    const dbRow = findDbRow(index, final) || (replaced ? findDbRow(index, orig) : null);
    const source = sourceOf(groupSources, final.groupId || orig.groupId);
    const kind = classifyAudience(entry, dbRow, source);
    const replacementPossible = !replaced && isKakaoType(orig.type) && orig.kakaoOptions?.disableSms !== true;
    const state = classifyStatus(final, { nowMs, replacementPossible });
    let subject = safeText(final.subject ?? dbRow?.message_subject ?? null);
    let text = safeText(final.text);
    if (kind.external) { text = text == null ? null : cut40(text); subject = subject == null ? null : cut40(subject); }
    const disableSms = orig.kakaoOptions?.disableSms;
    const logs = (final.log?.length ? final.log : orig.log) || [];
    return {
      message_id: final.messageId, group_id: final.groupId || null, created_at: orig.dateCreated || null,
      audience: kind.audience, category: kind.category,
      recipient_name: kind.name ? safeText(kind.name) : null,
      to: maskCustomerPhone(final.to) || '', from: maskCustomerPhone(final.from) || '',
      type: final.type, type_label: replaced ? `${typeLabel(orig.type)} → ${typeLabel(final.type)}` : typeLabel(final.type),
      replaced_from: replaced ? orig.type : null,
      ...state,
      source,
      status_text: statusText(state, state.status_code),
      reason: safeText(final.reason || null),
      network_name: nullable(final.networkName), country: nullable(final.country),
      auto_type_detect: typeof final.autoTypeDetect === 'boolean' ? final.autoTypeDetect : null,
      replacement: replaced || final.replacement === true,
      disable_sms: typeof disableSms === 'boolean' ? disableSms : null,
      template_id: nullable(orig.kakaoOptions?.templateId || final.kakaoOptions?.templateId),
      bytes: textBytes(final.text), type_name: typeName(replaced ? orig.type : final.type),
      updated_at: final.dateUpdated || null, processed_at: final.dateProcessed || null,
      log: logs.slice(-20).map(entry => ({ at: entry.createAt || null, message: safeText(entry.message) })),
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
        updated_at: item.updated_at || item.created_at, sent_at: null, completed_at: null, status: null, status_label: null,
        source: item.source || null, types: [], sent_total: 0, registered_failed: 0, replacement: 0, refund: 0,
        is_refunded: false, last_log: null,
      });
    }
    const group = map.get(key);
    group.total += 1;
    group.sent_total += 1;
    group[item.status] += 1;
    if (item.replacement) group.replacement += 1;
    const typeKeyName = String(item.type || '').toUpperCase().startsWith('BMS') ? 'BMS' : item.type;
    if (typeKeyName && !group.types.includes(typeKeyName)) group.types.push(typeKeyName);
    const label = item.recipient_name || item.to;
    if (label && group.recipients_preview.length < 3 && !group.recipients_preview.includes(label)) group.recipients_preview.push(label);
  }
  return [...map.values()].sort((a, b) => Date.parse(b.created_at || '') - Date.parse(a.created_at || ''));
}

export const PAGE_SIZES = [20, 50, 100];
export function paginate(list, page, pageSize = 50) {
  const size = PAGE_SIZES.includes(pageSize) ? pageSize : 50;
  const totalPages = Math.ceil(list.length / size);
  const effective = totalPages > 0 ? Math.min(Math.max(1, page), totalPages) : 1;
  return {
    rows: list.slice((effective - 1) * size, effective * size),
    pagination: { page: effective, page_size: size, total_items: list.length, total_pages: totalPages },
  };
}

export function countSenders(items) {
  const map = new Map();
  for (const item of items) if (item.from) map.set(item.from, (map.get(item.from) || 0) + 1);
  return [...map.entries()].map(([from, count]) => ({ from, count })).sort((a, b) => b.count - a.count || a.from.localeCompare(b.from));
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
