// 납기일·출고예정일 기준 안내(info) 문자(2026-11-13 설계 14절, 2단계-가). 기록 표는 새 표 sms_event_sends 하나뿐이다.
// orders·processes 는 SELECT 만 한다. 번호 전체·이름은 DB·응답·로그에 남기지 않는다(끝 4자리와 해시만).
// 안내 문구는 광고가 아니므로 광고 검사·수신거부·하루 1통·광고 상한을 적용하지 않는다. 야간 금지·전체 마감 시각·선점 INSERT·재발송 없음은 광고와 같다.
import crypto from 'node:crypto';
import { hasSolapiCredentials } from './solapiMessageLog.js';
import { getSendProvider } from './sendProvider.js';
import { staffDirectory, multiPartTimeShort, templateVariableNames, waitBeforePart } from './smsManualSend.js';
import { ALERT_ROUTES, canonicalAlertRecipientName } from './alertRoutes.js';
import { clearPhones, cafe24Connected, pollSignups, purgeStalePhones, signupCandidates } from './cafe24.js';
import { AUTO_KIND_PROCESS, AUTO_KIND_PROCESS_COMPLETED, ensureTextTemplateSchema, infoCheck, INFO_CHECK_MESSAGE, INSTANT_KINDS, isAtaTemplate, isDayAta, isEventKind, isInfoKind, isInfoTemplate, isInstantKind, isLeadKind, isProcessPlusKind, LEAD_KINDS, parseAutoChain, parseStaffIds, sendTimeMinutes, storedImages } from './smsTextTemplates.js';
import { leadCandidates, leadSourcesConnected } from './smsLeads.js';
import { AD_CATCHUP_PER_RUN, buildParts as buildAdParts, costOf as adCostOf, ensureAutoSchema, findTargets, phoneHash as autoPhoneHash } from './smsAutoSend.js'; // 출고 대상 조회 재사용(순환 import: 호출 시점에만 쓴다)
import { pollAirtableLeads } from './airtableLeads.js';
import * as kakaoTemplates from './kakaoTemplates.js';
import { bmsInWindow, bmsOptoutCheck, bmsReady, isBmsTemplate, parseBmsConfig } from './smsBms.js';
import { STEPS } from './steps.js';
import { autoEffective } from '../../shared/smsAutoEffective.js';
import { customerExpectedShipDate } from '../../src/utils/customerShippingDate.js';
import { parsePositiveIntegerQuantity } from '../../src/utils/quantity.js';

const HASH_SALT = 'hansung-sms-event-v1';
const TARGET_RE = /^010\d{7,8}$/;
const MOBILE_RE = /^01[016789]\d{7,8}$/;
const SEND_WINDOW = { from: 8, to: 21 }; // KST 08시 이상 21시 미만
const TIME_BUDGET_MS = 70000; // 설계 22-4: 함수 제한 90초(vercel.json) 안
const SEND_RESERVE_MS = 4000;
const TARGET_LIMIT = 1000;
const DEFAULT_MAX_PER_DAY = 200;
const DEFAULT_CATCHUP_MAX_PER_DAY = 1000;
const DEFAULT_CATCHUP_PER_RUN = 100;
const DEFAULT_LEAD_MAX_PER_DAY = 300; // 가입·문의 문구는 기존 안내 상한과 따로 센다
const LEAD_FROM_MINUTE = 9 * 60 + 30; // 가입·문의 후 1일 이상: KST 09:30 이후
const LEAD_KIND_SQL = LEAD_KINDS.map(kind => `'${kind}'`).join(', ');
const DATE_COLUMN = Object.freeze({ due_date: 'due_date', ship_scheduled: 'ship_scheduled_date' });
const SHIP_OR_DUE_SQL = "COALESCE(NULLIF(o.ship_scheduled_date, ''), NULLIF(o.due_date, ''))"; // 3단계-가: 출고예정일(없으면 납기일)
const PROCESS_COLUMN = Object.freeze({ process_started: 'started_at', process_completed: 'completed_at' });
const WINDOW_MS = 24 * 3600000; // 즉시형 사건 창: [max(켠 시각, 지금 − 24시간), 지금]
const KEY_CHUNK = 200;
const CATCHUP_LIMIT = 5000; // 이미 출고된 주문 1회 발송(따라잡기)의 한 번 조회 상한(번호 기준 중복 제거 전)
const AUTO_KIND_SHIP = 'ship_plus_days';
const ORDER_COLUMNS = 'o.id, o.phone, o.client_name, o.order_date, o.due_date, o.ship_scheduled_date, o.product_type, o.door_type, o.width, o.depth, o.height, o.quantity, o.sales_person';
const ATA_VARS = Object.freeze(['고객명', '업체명']); // 알림톡 허용 변수
export const CUSTOMER_VARS = Object.freeze(['고객명', '주문번호', '규격', '수량', '예상출고일', '조회링크']);
export const STAFF_VARS = Object.freeze([...CUSTOMER_VARS, '제품']);

const flags = new Map();
export function _resetEventSchemaForTest() { flags.clear(); }

const digits = value => String(value ?? '').replace(/\D/g, '');
const kstDate = nowMs => new Date(nowMs + 9 * 3600000).toISOString().slice(0, 10);
const kstHour = nowMs => new Date(nowMs + 9 * 3600000).getUTCHours();
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const kstWeekend = nowMs => { const d = new Date(nowMs + 9 * 3600000).getUTCDay(); return d === 0 || d === 6; };
const kstDayName = nowMs => ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'][new Date(nowMs + 9 * 3600000).getUTCDay()];
const inSendWindow = nowMs => { const h = kstHour(nowMs); return h >= SEND_WINDOW.from && h < SEND_WINDOW.to; };
const hashOf = phone => crypto.createHash('sha256').update(`${HASH_SALT}:${digits(phone)}`).digest('hex');
export const eventPhoneHash = hashOf; // 광고 문자 쪽이 오늘 나간 브랜드메시지 번호를 비교할 때 쓴다(광고 하루 1통)
const LEAD_CATCH_UP = 5; // 가입·문의 후 N일(N>=1): 접수일+N 이 오늘 − 5일 ~ 오늘인 아직 안 보낸 접수를 대상으로 한다(2026-11-19 S5, 중복은 dedupe 키가 막는다)
const DAY_CATCH_UP = 3; // 출고·주문 후 N일 알림톡·브랜드메시지: 예정일이 지난 뒤 이만큼의 날까지는 다시 시도한다(문자 갈래 CATCH_UP_DAYS 와 같다)
const intEnv = (value, fallback) => { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback; };
const leadFilter = lead => ` AND template_id ${lead ? 'IN' : 'NOT IN'} (SELECT id FROM sms_text_templates WHERE auto_kind IN (${LEAD_KIND_SQL}))`; // 가입·문의 문구는 따로 센다
const placeholders = list => list.map(() => '?').join(', ');
export const infoMaxPerDay = (env = process.env) => intEnv(env.SMS_AUTO_INFO_MAX_PER_DAY, DEFAULT_MAX_PER_DAY);
export const leadMaxPerDay = (env = process.env) => intEnv(env.SMS_AUTO_LEAD_MAX_PER_DAY, DEFAULT_LEAD_MAX_PER_DAY);
// 이미 출고된 주문 1회 발송(따라잡기) 전용 상한: 안내 하루 상한(200)과 따로 센다(2026-11-16 사장님 "하루에 다 보내"). 기본 1000 = 쏠라피 일일 한도.
// 크론 1회(5분)에는 CATCHUP_PER_RUN 건까지만 한 번의 send-many 로 보낸다(쏠라피 요청 8초 제한 안, 다시 보내지 않는 POST 라 한 번에 크게 보내지 않는다).
export const catchupMaxPerDay = (env = process.env) => intEnv(env.SMS_CATCHUP_MAX_PER_DAY, DEFAULT_CATCHUP_MAX_PER_DAY);
// 문구별 하루 최대(auto_catchup_daily)가 있으면 전역 상한과 둘 중 작은 값, 없으면 전역 상한.
export const catchupDailyCap = (own, env = process.env) => { const global = catchupMaxPerDay(env); const n = Math.floor(Number(own)); return n > 0 ? Math.min(n, global) : global; };
export const catchupPerRun = (env = process.env) => intEnv(env.SMS_CATCHUP_PER_RUN, DEFAULT_CATCHUP_PER_RUN);
const NOT_CATCHUP = " AND COALESCE(kind, '') <> 'catchup'"; // 안내 상한 계산에서 일괄 발송분을 뺀다
export const kstMinutes = nowMs => { const d = new Date(nowMs + 9 * 3600000); return d.getUTCHours() * 60 + d.getUTCMinutes(); };
// 발송 시각(설계 28): 'HH:MM' 부터 그날 21:00 전까지인지(시각이 지난 뒤 켜도 그날 나간다. 중복은 선점 키가 막는다). 시각이 비었거나 형식이 아니면 false.
export const SEND_TIME_END_MIN = 21 * 60;
export const inTimedWindow = (sendTime, nowMs) => { const start = sendTimeMinutes(sendTime); const now = kstMinutes(nowMs); return start !== null && now >= start && now < SEND_TIME_END_MIN; };
const autoOn = (env = process.env) => env.SMS_AUTO !== 'off';
const reply = (status, body) => ({ status, body });
const errorReply = (status, message, extra = {}) => reply(status, { error: { message, status }, ...extra });

export async function ensureEventSchema(db) {
  if (flags.get('sms.event')) return;
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS sms_event_sends (
      id BIGSERIAL PRIMARY KEY,
      template_id BIGINT NOT NULL,
      dedupe_key TEXT NOT NULL,
      order_id BIGINT,
      phone_hash TEXT NOT NULL,
      phone_last4 TEXT,
      kst_date TEXT NOT NULL,
      status TEXT NOT NULL,
      part_status TEXT,
      reason TEXT,
      group_ids TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (template_id, dedupe_key)
    )`,
    args: [],
  });
  await db.execute({ sql: 'ALTER TABLE sms_event_sends ADD COLUMN IF NOT EXISTS kind TEXT', args: [] }); // 'catchup' = 이미 출고된 주문 1회 발송분(안내 상한에서 뺀다)
  await db.execute({ sql: 'ALTER TABLE sms_event_sends ADD COLUMN IF NOT EXISTS retry_count INT DEFAULT 0', args: [] }); // 평소 발송분 실패 행을 다시 대상으로 넣은 횟수(1번만 재시도)
  await db.execute({ sql: 'ALTER TABLE sms_event_sends ADD COLUMN IF NOT EXISTS checked_at TIMESTAMPTZ', args: [] }); // 쏠라피 그룹 결과를 다시 확인한 시각(알림톡·브랜드메시지 일괄 발송분)
  await db.execute({ sql: 'ALTER TABLE sms_text_templates ADD COLUMN IF NOT EXISTS auto_skip_reason TEXT', args: [] }); // 일반 발송이 잔액 부족·제공사 없음으로 건너뛴 사유(성공하면 지움)
  await db.execute({ sql: 'ALTER TABLE sms_text_templates ADD COLUMN IF NOT EXISTS auto_skip_at TIMESTAMPTZ', args: [] });
  flags.set('sms.event', true);
}

// ---- 본문 변수(값 계산은 notify.js 와 같은 규칙, 그 파일은 고치지 않는다) ----
const orderNo = order => `HS-${String(order.order_date || '').slice(0, 4) || String(new Date().getUTCFullYear())}-${String(order.id).padStart(4, '0')}`;
const orderSize = order => (order.width && order.depth && order.height ? `${order.width}×${order.depth}×${order.height}mm` : '');
const specLine = order => [order.door_type || '', orderSize(order)].filter(Boolean).join(' ');
const fmtDate = value => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || '')); return m ? `${m[1]}-${m[2]}-${m[3]}` : '협의 예정'; };
const cleanValue = value => String(value ?? '').replace(/#\{|\}/g, '').replace(/\s+/g, ' ').trim();
export const nameVars = name => { const value = cleanValue(name).slice(0, 20) || '고객'; return { 고객명: value, 업체명: value }; }; // 알림톡 변수: #{업체명} 은 #{고객명} 과 같은 값(2026-11-19 S1)

export function orderVars(order, audience, trackUrl = '') {
  const qty = parsePositiveIntegerQuantity(order.quantity);
  const vars = {
    고객명: cleanValue(order.client_name).slice(0, 20) || '고객', 주문번호: orderNo(order), 규격: specLine(order),
    수량: qty === null ? '' : `${qty}대`, 예상출고일: fmtDate(customerExpectedShipDate(order)), 조회링크: trackUrl || '',
  };
  if (audience === 'staff' || audience === 'sales') vars.제품 = cleanValue(order.product_type) || '주문 제품';
  for (const key of Object.keys(vars)) vars[key] = cleanValue(vars[key]);
  return vars;
}
export function fillVars(body, vars) {
  return String(body).replace(/#\{([^}]+)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : all));
}
export const EXAMPLE_ORDER = Object.freeze({ id: 1, order_date: '2026-11-13', client_name: '홍길동', product_type: '쇼케이스', door_type: '슬라이딩', width: 1200, depth: 600, height: 1800, quantity: 1, due_date: '2026-11-20', ship_scheduled_date: '2026-11-23' });

// 통 구성: 사진 N장이면 N통. 1통째 = 본문 + 사진1, 2통째부터 = 사진 + 짧은 글.
export function buildEventParts(template, imageCount) {
  const n = Math.max(1, imageCount);
  const parts = [{ index: 0, image: imageCount > 0 ? 0 : -1, short: false }];
  for (let i = 1; i < n; i += 1) parts.push({ index: i, image: i, short: true });
  return parts.map(part => ({ ...part, text: part.short ? `한성쇼케이스 ${template.name} ${part.index + 1}/${n}` : null }));
}
// 시험 발송용: 예시 값으로 치환(직원 대상이면 직원용 변수까지)
export function eventExampleText(part, template) {
  if (part.short) return part.text;
  return fillVars(String(template.body).trim(), orderVars(EXAMPLE_ORDER, template.auto_audience === 'customer' ? 'customer' : 'staff', 'https://production-status.vercel.app/track/EXAMPLE'));
}

export async function loadEventTemplate(db, id) {
  await ensureTextTemplateSchema(db);
  await ensureEventSchema(db);
  const out = await db.execute({
    sql: 'SELECT id, name, body, image, images, auto_kind, auto_enabled, auto_offset, auto_unless_step, auto_audience, auto_staff, auto_msg_type, auto_step, auto_enabled_at, auto_daily, auto_weekdays, auto_unless_mode, auto_days, auto_ata_template, auto_send_time, auto_catchup_from, auto_catchup_at, auto_catchup_daily, auto_catchup_done_at, auto_lead_source, auto_catchup_paused_at, auto_catchup_error, auto_ata_fail_at, auto_bms, auto_skip_reason, auto_chain FROM sms_text_templates WHERE id = ?',
    args: [id],
  });
  const row = out.rows?.[0];
  if (!row) return null;
  return {
    auto_skip_reason: row.auto_skip_reason || '', auto_chain: parseAutoChain(row.auto_chain), auto_bms: row.auto_bms || '', id: Number(row.id), name: row.name, body: row.body, images: storedImages(row), auto_kind: row.auto_kind || '', auto_enabled: row.auto_enabled === true,
    auto_offset: Number(row.auto_offset) || 0, auto_unless_step: row.auto_unless_step || '', auto_audience: ['staff', 'sales'].includes(row.auto_audience) ? row.auto_audience : 'customer',
    auto_daily: row.auto_daily || '', auto_weekdays: row.auto_weekdays === true, auto_unless_mode: row.auto_unless_mode === 'started' ? 'started' : 'completed',
    auto_staff: parseStaffIds(row.auto_staff), auto_msg_type: 'info',
    auto_step: row.auto_step || '', auto_enabled_at: row.auto_enabled_at ? new Date(row.auto_enabled_at).toISOString() : '',
    auto_days: Number(row.auto_days) || 0, auto_ata_template: row.auto_ata_template || '', auto_send_time: row.auto_send_time || '', auto_lead_source: row.auto_lead_source || '',
    auto_catchup_from: row.auto_catchup_from || '', auto_catchup_at: row.auto_catchup_at || '', auto_catchup_daily: Number(row.auto_catchup_daily) > 0 ? Number(row.auto_catchup_daily) : 0, auto_catchup_done: Boolean(row.auto_catchup_done_at),
    auto_catchup_paused: Boolean(row.auto_catchup_paused_at), auto_catchup_error: row.auto_catchup_error || '', auto_ata_fail_at: row.auto_ata_fail_at ? new Date(row.auto_ata_fail_at).toISOString() : '',
  };
}

// 주문 행 → 받는 사람별 발송 후보. suffix 는 dedupe_key 끝 부분(기준일형: 기준일, 즉시형: 종류).
function expandItems(rows, template, staff, suffix, stats) {
  const people = template.auto_audience === 'staff'
    ? (staff || staffDirectory()).filter(person => template.auto_staff.includes(person.id) && MOBILE_RE.test(digits(person.phone)))
    : null;
  const items = [];
  for (const order of rows || []) {
    let recipients;
    if (template.auto_audience === 'sales') { // 영업담당: orders.sales_person → alertRoutes 의 이름·번호표(읽기만). 못 찾으면 건너뜀
      const phone = digits(ALERT_ROUTES[canonicalAlertRecipientName(order.sales_person)]);
      recipients = MOBILE_RE.test(phone) ? [phone] : [];
      if (!recipients.length && stats) stats.noSales += 1;
    } else recipients = people ? people.map(person => digits(person.phone)) : [digits(order.phone)].filter(phone => TARGET_RE.test(phone));
    const seen = new Set();
    for (const phone of recipients) {
      if (seen.has(phone)) continue;
      seen.add(phone);
      const hash = hashOf(phone);
      const tail = typeof suffix === 'function' ? suffix(order) : suffix; // once 모드: 주문마다 자기 기준일(due_date)
      items.push({ order, orderId: Number(order.id), phone, hash, last4: phone.slice(-4), baseDay: tail, key: `${hash}:${Number(order.id)}:${tail}` });
    }
  }
  return items;
}

// 자사몰 회원가입 후보(읽기만): 창 안의 가입 중 번호가 남은 것. 번호당 평생 1번(dedupe_key = 해시:member:member_joined).
async function memberCandidates(db, from, to) {
  const seen = new Set();
  const items = [];
  for (const row of await signupCandidates(db, from, to)) {
    const key = `${row.hash}:member:member_joined`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ order: null, orderId: null, signupId: row.id, phone: row.phone, hash: row.hash, last4: row.last4, baseDay: 'member_joined', key });
  }
  return items;
}

// 가입·문의 후 N일 후보(읽기만, 설계 19-2). KST 기준 (접수일 + N일) == 오늘. N=0 은 [max(켠 시각, 지금−24시간), 지금] 창,
// N>=1 은 접수일+N 이 켠 날(KST) 이후인 것만(켜기 전에 이미 지난 단계는 보내지 않는다). 키 = 해시:lead:접수일:dN (같은 날 같은 번호는 1통).
async function leadCandidatesFor(db, template, { nowMs, preview }) {
  const enabledMs = preview ? nowMs - WINDOW_MS : Date.parse(template.auto_enabled_at || '');
  if (!Number.isFinite(enabledMs)) return [];
  const days = Math.max(0, Number(template.auto_days) || 0);
  const today = kstDate(nowMs);
  const enabledDay = kstDate(enabledMs);
  let fromMs; let toMs = nowMs;
  if (days === 0) fromMs = Math.max(enabledMs, nowMs - WINDOW_MS);
  else { // 접수일 + N 이 [오늘 − 5일, 오늘]: 접수일 = [오늘 − N − 5일, 오늘 − N일]
    const newest = addDays(today, -days);
    fromMs = Date.parse(`${addDays(newest, -LEAD_CATCH_UP)}T00:00:00+09:00`);
    toMs = Math.min(nowMs, Date.parse(`${newest}T00:00:00+09:00`) + 24 * 3600000 - 1);
  }
  const seen = new Set();
  const items = [];
  for (const row of await leadCandidates(db, { fromIso: new Date(fromMs).toISOString(), toIso: new Date(toMs).toISOString(), source: template.auto_lead_source })) {
    const joinDay = kstDate(row.joinedAtMs);
    if (days > 0) { const due = addDays(joinDay, days); if (due > today || due < addDays(today, -LEAD_CATCH_UP) || due < enabledDay) continue; } // 켜기 전에 이미 지난 단계는 보내지 않는다
    const key = `${row.hash}:lead:${joinDay}:d${days}`;
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ order: null, orderId: null, leadId: row.id, phone: row.phone, hash: row.hash, last4: row.last4, baseDay: 'lead', key, vars: nameVars(row.name) });
  }
  return items;
}

// 출고·주문 후 N일 + 알림톡 후보(읽기만): 대상 조회(findTargets)를 재사용. KST 기준일(출고일·주문일) + N일 이 오늘 − 3일 ~ 오늘이고(2026-11-18: 그날 하루만이 아니라 3일 안은 다시 시도, 중복은 dedupe 키가 막는다),
// 기준일 + N일 이 켠 날 이상인 것만(켜기 전에 이미 지난 분은 보내지 않는다). 수신거부 번호 제외. 키 = 해시:ship | 해시:order (번호당 평생 1번).
// 출고 완료 후는 '이미 출고된 주문 1회 발송'(catchup)이 켜져 시각이 됐으면 출고일 범위의 출고분도 같은 키(해시:ship)로 더한다 → 나중 자동 발송과 겹치지 않는다.
const dayWord = template => (template.auto_kind === AUTO_KIND_SHIP ? 'ship' : template.auto_kind === AUTO_KIND_PROCESS ? 'pstart' : template.auto_kind === AUTO_KIND_PROCESS_COMPLETED ? 'pdone' : 'order');
async function optoutHashes(db) {
  await ensureAutoSchema(db);
  return new Set(((await db.execute({ sql: 'SELECT phone_hash FROM sms_optouts', args: [] })).rows || []).map(row => row.phone_hash));
}
async function dayCandidatesFor(db, template, { nowMs, preview, catchupOnly }) {
  const enabledMs = preview ? nowMs : Date.parse(template.auto_enabled_at || '');
  const days = Number(template.auto_days) || 0;
  const today = kstDate(nowMs);
  const word = dayWord(template);
  const optouts = await optoutHashes(db);
  const items = [];
  const keys = new Set();
  if (!catchupOnly && Number.isFinite(enabledMs) && (days >= 1 || (days === 0 && template.auto_kind === 'order_plus_days'))) { // 주문 후 0일 = 주문일 당일(S2). 출고·공정 후는 1일 이상만
    for (const target of await findTargets(db, { nowMs, days, startDate: addDays(today, -days - DAY_CATCH_UP), kind: template.auto_kind, step: template.auto_step })) {
      const due = addDays(target.shipDate, days); // 예정일: 오늘부터 3일 전까지는 아직 안 나간 번호를 다시 시도한다(이미 보낸 번호·주문은 pending 의 키 조회가 뺀다)
      if (due > today || due < addDays(today, -DAY_CATCH_UP) || due < kstDate(enabledMs)) continue;
      if (optouts.has(autoPhoneHash(target.phone))) continue;
      const hash = hashOf(target.phone);
      keys.add(`${hash}:${word}`);
      items.push({ order: null, orderId: target.orderId, phone: target.phone, hash, last4: target.phone.slice(-4), baseDay: word, key: `${hash}:${word}`, vars: nameVars(target.name) });
    }
  }
  if (catchupActive(template, nowMs)) {
    for (const target of await catchupTargets(db, { from: template.auto_catchup_from, to: catchupEnd(today, days) })) {
      if (optouts.has(autoPhoneHash(target.phone))) continue;
      const hash = hashOf(target.phone);
      const key = `${hash}:ship`;
      if (keys.has(key)) continue;
      keys.add(key);
      items.push({ order: null, orderId: target.orderId, phone: target.phone, hash, last4: target.phone.slice(-4), baseDay: 'ship', key, catchup: true, vars: nameVars(target.name) });
    }
  }
  return items;
}

// 일괄 발송 범위 끝: 출고일이 '오늘 − N일'(출고 후 N일이 지난 주문)까지. 그 뒤 출고분은 평소 자동 발송이 N일째에 보낸다.
export const catchupEnd = (today, days) => addDays(today, -Math.max(0, Number(days) || 0));

// 이미 출고된 주문 1회 발송(따라잡기): 켜져 있고 승인 알림톡이 걸린 출고 완료 후 문구 + 범위·시각이 있고 아직 안 끝났고 지정 시각(KST)이 지났으면 true.
// 날짜가 지난 뒤에는 매일 그 시각(시·분) 이후에만 이어서 보낸다(상한을 넘은 몫이 다음 날로 이월된다).
export function catchupActive(template, nowMs) {
  if (!template?.auto_enabled || template.auto_kind !== AUTO_KIND_SHIP || !template.auto_ata_template) return false;
  if (!template.auto_catchup_from || !template.auto_catchup_at || template.auto_catchup_done || template.auto_catchup_paused) return false; // 멈춘 일괄 발송은 화면에서 다시 저장해야 이어진다
  const at = Date.parse(`${template.auto_catchup_at}:00+09:00`);
  if (!Number.isFinite(at) || nowMs < at) return false;
  return kstMinutes(nowMs) >= Number(template.auto_catchup_at.slice(11, 13)) * 60 + Number(template.auto_catchup_at.slice(14, 16));
}
// 출고일이 [from, to] 인 출고 완료 주문의 010 번호(번호당 1건, 오래된 출고일 순). orders 는 읽기만 한다.
async function catchupTargets(db, { from, to }) {
  const out = await db.execute({
    sql: `SELECT id, phone, client_name, LEFT(ship_date, 10) AS ship_day FROM orders
      WHERE status = 'shipped' AND ship_date IS NOT NULL AND LEFT(ship_date, 10) >= ? AND LEFT(ship_date, 10) <= ?
      ORDER BY ship_date ASC, id ASC LIMIT ${CATCHUP_LIMIT}`,
    args: [from, to],
  });
  const seen = new Set();
  const targets = [];
  for (const row of out.rows || []) {
    const phone = digits(row.phone);
    if (!TARGET_RE.test(phone) || seen.has(phone)) continue;
    seen.add(phone);
    targets.push({ orderId: Number(row.id), phone, name: row.client_name, shipDate: row.ship_day });
  }
  return targets;
}
// 광고 문자 일괄 발송 미리보기용: 이 문구로 sms_auto_sends 에 행이 하나라도 있는 번호·주문(회차 무관)은 '이미 보낸' 것으로 본다.
async function adDoneKeys(db, templateId, all) {
  if (!templateId) return new Set();
  await ensureAutoSchema(db);
  const rows = (await db.execute({ sql: "SELECT phone_hash, order_id FROM sms_auto_sends WHERE template_id = ? AND status <> 'failed'", args: [Number(templateId)] })).rows || [];
  const hashes = new Set(rows.map(row => row.phone_hash));
  const orders = new Set(rows.map(row => Number(row.order_id)));
  return new Set(all.filter(item => hashes.has(autoPhoneHash(item.phone)) || orders.has(item.orderId)).map(item => item.key));
}
async function adImageCount(db, templateId) {
  if (!templateId) return 0;
  try { return storedImages((await db.execute({ sql: 'SELECT image, images FROM sms_text_templates WHERE id = ?', args: [Number(templateId)] })).rows?.[0]).length; } catch { return 0; }
}
async function doneKeys(db, templateId, keys) {
  const done = new Set();
  for (let i = 0; i < keys.length; i += KEY_CHUNK) {
    const chunk = keys.slice(i, i + KEY_CHUNK);
    for (const row of (await db.execute({ sql: `SELECT dedupe_key FROM sms_event_sends WHERE template_id = ? AND dedupe_key IN (${placeholders(chunk)})`, args: [templateId, ...chunk] })).rows || []) done.add(row.dedupe_key);
  }
  return done;
}
// 따라잡기 미리보기(읽기만): 범위별 보낼 번호 수·예상 비용(알림톡 단가 × 건수)·현재 잔액. 번호 자체는 돌려주지 않는다. 수신거부·이미 보낸(이 문구로) 번호는 뺀다.
export async function catchupPreview(db, { from, templateId = null, days = 0, nowMs = Date.now(), env = process.env, provider, kakao = kakaoTemplates, kakaoOpts, bms = false, dailyCap = 0, ad = false } = {}) {
  const today = kstDate(nowMs);
  const end = catchupEnd(today, days); // 출고 N일이 지난 주문만
  await ensureEventSchema(db);
  const start = /^\d{4}-\d{2}-\d{2}$/.test(String(from || '')) ? String(from) : today;
  const optouts = await optoutHashes(db);
  const all = [];
  for (const target of await catchupTargets(db, { from: '1970-01-01', to: end })) {
    if (optouts.has(autoPhoneHash(target.phone))) continue;
    all.push({ ...target, key: `${hashOf(target.phone)}:ship` });
  }
  const done = ad ? await adDoneKeys(db, templateId, all) : templateId ? await doneKeys(db, Number(templateId), all.map(item => item.key)) : new Set();
  const open = all.filter(item => !done.has(item.key));
  const vendor = provider || getSendProvider();
  const estimator = bms ? vendor?.estimateBms : vendor?.estimateKakao; // 브랜드메시지(자유형)는 100원 단가
  const adParts = ad ? buildAdParts({ body: '' }, await adImageCount(db, templateId)) : null; // 광고 문자: 문구 1건 값(사진 있으면 MMS)으로 센다
  const estimate = count => (ad ? (vendor && typeof vendor.estimate === 'function' ? adCostOf(vendor, adParts, count, env) : null) : typeof estimator === 'function' ? (Number(estimator.call(vendor, { count }, env)?.total) ?? null) : null);
  const count = fromDate => open.filter(item => item.shipDate >= fromDate).length;
  const oldest = open.length ? open[0].shipDate : '';
  const ranges = [
    { key: 'selected', label: '고른 범위', from: start, count: count(start) },
    { key: 'd30', label: '최근 30일', from: addDays(today, -30), count: count(addDays(today, -30)) },
    { key: 'd90', label: '최근 90일', from: addDays(today, -90), count: count(addDays(today, -90)) },
    { key: 'all', label: '가장 오래된 출고일부터', from: oldest, count: open.length },
  ].map(range => ({ ...range, cost: estimate(range.count) }));
  let balance = null;
  try { const value = await kakao.getBalance(kakaoOpts); balance = Number.isFinite(value) ? value : null; } catch { balance = null; }
  const dailyMax = catchupDailyCap(dailyCap, env); // 일괄 발송 전용 하루 상한(안내 상한과 따로)
  const perRun = ad ? AD_CATCHUP_PER_RUN : catchupPerRun(env);
  const picked = ranges[0];
  return { today, end_date: end, days: Math.max(0, Number(days) || 0), oldest_ship_date: oldest, ranges, unit: estimate(1), ...(bms ? { bms: true, fallback_unit: Number(vendor?.estimateBms?.({ count: 1 }, env)?.fallback_unit) || null } : {}), balance, daily_max: dailyMax, per_run: perRun, eta_minutes: picked.count ? Math.max(0, Math.ceil((Number(dailyCap) > 0 ? Math.min(picked.count, dailyMax) : picked.count) / perRun) - 1) * 5 : 0, days_needed: picked.count ? Math.ceil(picked.count / dailyMax) : 0, balance_short: balance !== null && picked.cost !== null && balance < picked.cost };
}

// 즉시형 사건(읽기만): 창 안에 생긴 주문 등록·공정 시작/완료. 켠 시각이 없으면 대상 없음. cancelled 주문·시각이 NULL(되돌린) 공정 제외.
async function instantCandidates(db, template, { nowMs, staff, preview }) {
  const enabledMs = preview ? nowMs - WINDOW_MS : Date.parse(template.auto_enabled_at || ''); // 켜기 전 미리 보기: 창 = [지금 − 24시간, 지금]
  if (!Number.isFinite(enabledMs)) return [];
  const from = new Date(Math.max(enabledMs, nowMs - WINDOW_MS)).toISOString();
  const to = new Date(nowMs).toISOString();
  if (template.auto_kind === 'member_joined') return memberCandidates(db, from, to); // 주문과 무관 — 주문 전제 경로(조회·expandItems)를 타지 않는다
  let out;
  if (template.auto_kind === 'order_created') {
    out = await db.execute({
      sql: `SELECT ${ORDER_COLUMNS} FROM orders o WHERE o.created_at >= ? AND o.created_at <= ? AND COALESCE(o.status, '') <> 'cancelled' ORDER BY o.id ASC LIMIT ${TARGET_LIMIT}`,
      args: [from, to],
    });
  } else {
    const column = PROCESS_COLUMN[template.auto_kind];
    if (!column || !STEPS.includes(template.auto_step)) return [];
    // 시각은 TEXT(UTC ISO). 형식이 ISO 가 아닌 값은 비교에서 빠진다(안전한 쪽).
    out = await db.execute({
      sql: `SELECT ${ORDER_COLUMNS} FROM processes p JOIN orders o ON o.id = p.order_id
        WHERE p.step_name = ? AND p.${column} IS NOT NULL AND p.${column} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.0-9]*Z$' AND p.${column} >= ? AND p.${column} <= ? AND COALESCE(o.status, '') <> 'cancelled'
        ORDER BY o.id ASC LIMIT ${TARGET_LIMIT}`,
      args: [template.auto_step, from, to],
    });
  }
  const seenOrders = new Set();
  const rows = (out.rows || []).filter(row => !seenOrders.has(Number(row.id)) && seenOrders.add(Number(row.id)));
  return expandItems(rows, template, staff, template.auto_kind);
}

const dueExpr = template => (template.auto_kind === 'ship_or_due' ? SHIP_OR_DUE_SQL : `o.${DATE_COLUMN[template.auto_kind]}`);
// auto_mark_sent(order_ids) 용: 이 문구(once 모드)가 그 주문들에 쓸 발송 후보 키와 같은 키를 만든다. 주문 상태·영업담당은 보지 않는다(표시할 주문을 호출한 쪽이 고른다).
export async function dueMarkEntries(db, template, orderIds) {
  const expr = dueExpr(template);
  const found = new Set();
  const items = [];
  for (let i = 0; i < orderIds.length; i += KEY_CHUNK) {
    const chunk = orderIds.slice(i, i + KEY_CHUNK);
    const out = await db.execute({ sql: `SELECT ${ORDER_COLUMNS}, LEFT(${expr}, 10) AS base_date FROM orders o WHERE o.id IN (${placeholders(chunk)}) AND ${expr} IS NOT NULL ORDER BY o.id ASC`, args: chunk });
    const rows = (out.rows || []).filter(row => /^\d{4}-\d{2}-\d{2}$/.test(String(row.base_date || '')));
    for (const item of expandItems(rows, template, [], order => order.base_date)) { items.push(item); found.add(item.orderId); }
  }
  return { items, found };
}

// 오늘 대상(이미 선점한 것 제외 전). 납기일/출고예정일 칸이 오늘 − offset 인 진행 중 주문만(당일만, 뒤늦게 보내지 않음).
async function candidates(db, template, { nowMs, staff, preview, warn, catchupOnly }) {
  if (isDayAta(template)) return dayCandidatesFor(db, template, { nowMs, preview, catchupOnly });
  if (isInstantKind(template.auto_kind)) return instantCandidates(db, template, { nowMs, staff, preview });
  if (isLeadKind(template.auto_kind)) return leadCandidatesFor(db, template, { nowMs, preview });
  if (!isEventKind(template.auto_kind)) return [];
  if (template.auto_chain?.days_off?.includes(kstDayName(nowMs))) return []; // 쉬는 요일(auto_chain.days_off, KST): 그날은 대상 0 (놓친 건은 다음 날 once 범위가 잡는다)
  const today = kstDate(nowMs);
  const baseDay = addDays(today, -template.auto_offset);
  const daily = template.auto_daily || '';
  const expr = dueExpr(template);
  const args = [baseDay];
  let range = ` AND LEFT(${expr}, 10) = ?`; // 기존: 기준일 그 하루만
  if (daily === 'until' || daily === 'once') { range = ` AND LEFT(${expr}, 10) >= ? AND LEFT(${expr}, 10) <= ?`; args.splice(0, 1, today, baseDay); } // 오늘 ≤ 기준일 ≤ 오늘 − offset
  else if (daily === 'ongoing') range = ` AND LEFT(${expr}, 10) ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' AND LEFT(${expr}, 10) <= ?`; // 기준일 ≤ 오늘 − offset(날짜가 빈 주문 제외)
  let unless = '';
  if (template.auto_unless_step) {
    const notDone = template.auto_unless_mode === 'started' ? "p.status NOT IN ('in_progress', 'completed')" : "p.status <> 'completed'"; // 미착수 = 진행중·완료가 아님
    unless = ` AND EXISTS (SELECT 1 FROM processes p WHERE p.order_id = o.id AND p.step_name = ? AND ${notDone})`; args.push(template.auto_unless_step);
  }
  const once = daily === 'once';
  let salesFilter = '';
  if (template.auto_chain?.sales) { salesFilter = ' AND o.sales_person = ?'; args.push(template.auto_chain.sales); } // 영업담당 필터(auto_chain.sales, S7)
  const out = await db.execute({
    sql: `SELECT ${ORDER_COLUMNS}${once ? `, LEFT(${expr}, 10) AS base_date` : ''}
      FROM orders o WHERE o.status = 'in_production' AND ${expr} IS NOT NULL${range}${unless}${salesFilter} ORDER BY o.id ASC LIMIT ${TARGET_LIMIT}`,
    args,
  });
  const stats = { noSales: 0 };
  const items = expandItems(out.rows, template, staff, once ? (order => order.base_date) : (daily ? today : baseDay), stats); // 매일 반복이면 키 끝 날짜 = 오늘(하루 1번), once 면 주문의 기준일(주문당 평생 1번)
  if (stats.noSales && warn) warn('[sms-event] 영업담당을 찾지 못해 건너뛴 건수', stats.noSales);
  return items;
}

// 평소 발송분이 실패한 행(재시도 0번)은 1번만 다시 대상으로 넣는다. 2번째 실패(retry_count>=1)나 일괄 발송분은 다시 넣지 않는다. 조회가 실패하면 다시 보내지 않는다.
async function failedRetryRows(db, template, keys) {
  const out = new Map();
  try {
    for (let i = 0; i < keys.length; i += KEY_CHUNK) {
      const chunk = keys.slice(i, i + KEY_CHUNK);
      for (const row of (await db.execute({ sql: `SELECT id, dedupe_key FROM sms_event_sends WHERE template_id = ? AND status = 'failed' AND COALESCE(retry_count, 0) = 0 AND COALESCE(kind, '') <> 'catchup' AND dedupe_key IN (${placeholders(chunk)})`, args: [template.id, ...chunk] })).rows || []) out.set(row.dedupe_key, Number(row.id));
    }
  } catch { /* 조회 실패: 재시도 없음 */ }
  return out;
}
async function pending(db, template, deps) {
  let items = await candidates(db, template, deps);
  if (!items.length) return [];
  if (isBmsTemplate(template) && !isDayAta(template)) { // 브랜드메시지는 광고라 수신거부 번호를 뺀다(출고·주문 후는 dayCandidatesFor 가 이미 뺐다)
    const optouts = await optoutHashes(db);
    items = items.filter(item => !optouts.has(autoPhoneHash(item.phone)));
    if (!items.length) return [];
  }
  let done;
  if (isInstantKind(template.auto_kind) || isLeadKind(template.auto_kind) || isDayAta(template) || template.auto_daily) { // 즉시형·매일 반복: 후보 키만 IN 조회(문구 기록 전체를 읽지 않는다)
    done = new Set();
    const keys = items.map(item => item.key);
    for (let i = 0; i < keys.length; i += KEY_CHUNK) {
      const chunk = keys.slice(i, i + KEY_CHUNK);
      for (const row of (await db.execute({ sql: `SELECT dedupe_key FROM sms_event_sends WHERE template_id = ? AND dedupe_key IN (${placeholders(chunk)})`, args: [template.id, ...chunk] })).rows || []) done.add(row.dedupe_key);
    }
  } else {
    done = new Set(((await db.execute({ sql: 'SELECT dedupe_key FROM sms_event_sends WHERE template_id = ?', args: [template.id] })).rows || []).map(row => row.dedupe_key));
  }
  const doneItems = items.filter(item => done.has(item.key) && !item.catchup).map(item => item.key);
  const retry = doneItems.length ? await failedRetryRows(db, template, doneItems) : new Map();
  return items.filter(item => !done.has(item.key) || retry.has(item.key)).map(item => (retry.has(item.key) ? { ...item, retryId: retry.get(item.key) } : item));
}

async function trackUrls(db, ids) {
  const map = new Map();
  if (!ids.length) return map;
  try {
    const rows = (await db.execute({ sql: `SELECT id, track_token FROM orders WHERE id IN (${placeholders(ids)})`, args: ids })).rows || [];
    const base = String(process.env.BASE_URL || 'https://production-status.vercel.app').replace(/\/+$/, '');
    for (const row of rows) if (row.track_token) map.set(Number(row.id), `${base}/track/${row.track_token}`);
  } catch { /* 링크 없이 보낸다(DB 에 쓰지 않는다) */ }
  return map;
}

// 알림톡 갈래 준비 확인(설계 19-3): 한성 채널·승인 상태·변수는 고객명뿐. pfId 는 수동 알림톡 보내기(smsManualSend.js runKakaoSend 261~263행)와 같은 출처 —
// 템플릿 raw.channelId, 없고 그룹 템플릿이면 환경값 KAKAO_PF_ID. → { ok, pfId }
export async function ataReady(templateId, { kakao = kakaoTemplates, kakaoOpts, env = process.env } = {}) {
  try {
    const found = await kakao.getTemplateFresh(templateId, kakaoOpts);
    if (!found?.scope?.allowed || found.template?.status !== 'APPROVED') return { ok: false, pfId: '', reason: 'ata_not_ready' };
    if (templateVariableNames(found.template).some(name => !ATA_VARS.includes(name))) return { ok: false, pfId: '', reason: 'ata_not_ready' };
    let pfId = typeof found.raw?.channelId === 'string' ? found.raw.channelId : '';
    if (!pfId && found.scope?.kind === 'group' && typeof env.KAKAO_PF_ID === 'string') pfId = env.KAKAO_PF_ID;
    return pfId ? { ok: true, pfId, names: templateVariableNames(found.template) } : { ok: false, pfId: '', reason: 'ata_no_channel' };
  } catch { return { ok: false, pfId: '', reason: 'ata_not_ready' }; }
}

// 알림톡 변수는 #{고객명} 하나: 주문 행이 있으면 그 이름, 없으면(가입 시 등) '고객'
const ataVars = item => item.vars || nameVars(item.order?.client_name);

// 템플릿이 #{업체명} 을 쓰지 않으면 업체명은 보내지 않는다(기존 알림톡 문구의 전송 변수는 그대로 고객명 하나).
export const ataSendVars = (item, names) => { const vars = { ...ataVars(item) }; if (!names.includes('업체명')) delete vars.업체명; return vars; };

// plain(auto_chain.plain === true) 안내 문구는 주문 변수 필수 검사(info_needs_order_var)만 면제한다(S3). 다른 검사는 그대로.
function infoBlocked(template, ata) {
  const blocked = infoCheck(template.body, template.auto_audience, template.auto_kind, ata);
  return blocked === 'info_needs_order_var' && template.auto_chain?.plain === true ? '' : blocked;
}

// ---- 문구 1개 실행 ----
export async function runEventSend(template, deps = {}) {
  const { db, provider, env = process.env, nowMs = Date.now(), fetchImpl, tick = Date.now, deadline, staff, warn = console.warn, sleep } = deps;
  const startedAt = tick();
  const shared = typeof deadline === 'number';
  const endAt = shared ? deadline : startedAt + TIME_BUDGET_MS;
  const timeShort = () => shared && endAt - tick() < SEND_RESERVE_MS;
  const out = { template_id: template.id, ran: false, reason: '', targets: 0, claimed: 0, sent: 0, failed: 0, uncertain: 0 };
  if (!template.auto_enabled || !autoOn(env)) return { ...out, reason: 'off' };
  const bms = isBmsTemplate(template); // 브랜드메시지(자유형): 알림톡 갈래 안전장치를 그대로 쓰되 KST 08:00~20:00 사이에만 보낸다
  if (!inSendWindow(nowMs) || (bms && !bmsInWindow(nowMs))) return { ...out, reason: 'night' };
  if (!isInfoTemplate(template)) return { ...out, reason: 'no_auto' };
  if (isEventKind(template.auto_kind) && template.auto_weekdays && kstWeekend(nowMs)) return { ...out, reason: 'weekend' }; // 평일만: KST 토·일 무동작
  const lead = isLeadKind(template.auto_kind);
  const ata = isAtaTemplate(template); // 알림톡 갈래(모든 조건): sendKakaoEach (문자는 sendEach)
  if (ata && template.auto_audience !== 'customer') return { ...out, reason: 'info_check' }; // 알림톡은 고객에게만
  if (lead && template.auto_days >= 1 && kstMinutes(nowMs) < (sendTimeMinutes(template.auto_send_time) ?? LEAD_FROM_MINUTE)) return { ...out, reason: 'early' }; // 1일 이상 단계는 문구의 발송 시각(없으면 KST 09:30) 부터
  if (needsStep(template.auto_kind) && !STEPS.includes(template.auto_step)) return { ...out, reason: 'no_step' };
  if ((template.auto_audience === 'staff' && !template.auto_staff.length) || infoBlocked(template, ata)) return { ...out, reason: 'info_check' };
  const vendor = provider || getSendProvider();
  const bmsCfg = bms ? parseBmsConfig(template.auto_bms) : null;
  const from = bms ? bmsCfg.from : digits(env.SMS_SENDER);
  if (!vendor || typeof (bms ? vendor.sendBmsEach : ata ? vendor.sendKakaoEach : vendor.sendEach) !== 'function' || !from) { await noteSkip(db, template, '발송 업체 설정 없음', warn); return { ...out, reason: 'no_provider' }; }
  if (!provider && !hasSolapiCredentials()) { await noteSkip(db, template, '발송 업체 설정 없음', warn); return { ...out, reason: 'no_provider' }; }
  if (template.auto_skip_reason) { try { await db.execute({ sql: 'UPDATE sms_text_templates SET auto_skip_reason = NULL WHERE id = ? RETURNING id', args: [template.id] }); } catch { warn('[sms-event] 건너뜀 사유 지우기 실패'); } } // 제공사 확인을 통과했으면 '업체 설정 없음' 류 사유를 지운다

  if (ata && template.auto_ata_fail_at && Date.parse(template.auto_ata_fail_at) > nowMs) return { ...out, reason: 'ata_backoff' }; // 같은 문구가 연속으로 통째 실패하면 1시간 건너뛴다

  await ensureEventSchema(db);
  const memberKind = template.auto_kind === 'member_joined';
  if (memberKind) { // 가입 문구: 24시간 지난 번호 지우기 + 보충 조회(60분에 1번, 실패는 조용히)
    try { await purgeStalePhones(db, nowMs); } catch { warn('[sms-event] 번호 정리 실패'); }
    await pollSignups(db, { env, fetchImpl, nowMs, warn });
  }
  const today = kstDate(nowMs);
  if (ata) { // 접수 뒤 전부 실패한 그룹: 행을 지웠다 → 일괄 발송분이면 멈추고, 평소 발송분이면 1시간 쉰다(같은 실행에서 다시 보내지 않는다)
    const rechecked = await recheckAtaGroups(db, template, vendor, { nowMs, fetchImpl, warn });
    if (rechecked) return { ...out, ran: true, reason: rechecked === 'paused' ? 'catchup_paused' : 'ata_failed' };
  }
  const eligible = await pending(db, template, { nowMs, staff, warn, catchupOnly: deps.catchupOnly === true });
  if (catchupActive(template, nowMs) && !eligible.some(item => item.catchup)) { // 이미 출고된 주문 1회 발송: 남은 대상이 없으면 끝(다시 돌지 않는다)
    try { await db.execute({ sql: 'UPDATE sms_text_templates SET auto_catchup_done_at = NOW() WHERE id = ? AND auto_catchup_done_at IS NULL RETURNING id', args: [template.id] }); } catch { warn('[sms-event] 1회 발송 완료 표시 실패'); }
  }
  out.targets = eligible.length;
  if (!eligible.length) return { ...out, ran: true };

  let pfId = '';
  let ataNames = [];
  if (bms) { // 브랜드메시지: 채널·사진(저장 때 올린 imageId)·글자 수를 선점 전에 다시 확인한다(쏠라피 호출 없음)
    const checked = bmsReady(template);
    if (!checked.ok) return { ...out, ran: true, reason: 'bms_not_ready' };
    pfId = checked.cfg.pfId;
  } else if (ata) { // 알림톡: 승인·변수·채널을 선점 전에 다시 확인한다. 못 정하면 아무것도 선점하지 않는다.
    const ready = await ataReady(template.auto_ata_template, { kakao: deps.kakao, kakaoOpts: deps.kakaoOpts || (fetchImpl ? { fetchImpl } : undefined), env });
    if (!ready.ok) return { ...out, ran: true, reason: ready.reason === 'ata_no_channel' ? 'ata_no_channel' : 'ata_not_ready' };
    pfId = ready.pfId;
    ataNames = ready.names || [];
  }
  const max = lead ? leadMaxPerDay(env) : infoMaxPerDay(env);
  const catchupGlobal = catchupMaxPerDay(env);
  const catchupOwn = Number(template.auto_catchup_daily) > 0 ? catchupDailyCap(template.auto_catchup_daily, env) : 0; // 문구별 하루 최대(없으면 0 = 전역 상한만)
  const countToday = async sql => Number((await db.execute({ sql, args: [today] })).rows?.[0]?.n) || 0;
  const infoSql = `SELECT COUNT(*) AS n FROM sms_event_sends WHERE kst_date = ?${leadFilter(lead)}${NOT_CATCHUP}`;
  const catchupSql = "SELECT COUNT(*) AS n FROM sms_event_sends WHERE kst_date = ? AND kind = 'catchup'";
  const catchupOwnSql = `${catchupSql} AND template_id = ${Number(template.id)}`;
  const normalItems = eligible.filter(item => !item.catchup);
  const catchupItems = eligible.filter(item => item.catchup);
  const usedToday = await countToday(infoSql);
  const catchupUsed = catchupItems.length ? await countToday(catchupSql) : 0;
  const catchupOwnUsed = catchupOwn && catchupItems.length ? await countToday(catchupOwnSql) : 0;
  // 일괄 발송분은 자기 상한(하루 catchupMax)과 크론 1회 묶음(catchupPerRun)만 따르고, 안내 상한을 쓰지도 깎지도 않는다.
  const picked = [...normalItems.slice(0, Math.max(0, max - usedToday)), ...catchupItems.slice(0, Math.max(0, Math.min(catchupPerRun(env), catchupGlobal - catchupUsed, catchupOwn ? catchupOwn - catchupOwnUsed : Infinity)))];
  if (picked.length < eligible.length) warn('[sms-event] 하루 상한·묶음으로 못 보낸 건수', eligible.length - picked.length);
  if (!picked.length) { // 하루 상한에 막힘: 사유를 남겨 화면이 '막힘'으로 보이게 한다(다음 실행이 지우고 다시 판단)
    const limit = normalItems.length ? max : Math.min(catchupGlobal, catchupOwn || Infinity);
    await noteSkip(db, template, `하루 상한 ${limit}건 도달, 남은 ${eligible.length}건 다음 날`, warn);
    return { ...out, ran: true, reason: 'cap' };
  }
  if (ata) { // 알림톡·브랜드메시지: 잔액이 모자라면 선점 전에 멈춘다(접수 뒤 잔액 부족으로 전부 실패하면 행만 sent 로 남는다). 조회 실패는 종전대로 보낸다.
    const short = await balanceShort(vendor, bms, picked.length, deps, env);
    if (short) {
      if (picked.some(item => item.catchup)) {
        try { await db.execute({ sql: 'UPDATE sms_text_templates SET auto_catchup_paused_at = NOW(), auto_catchup_error = ? WHERE id = ? RETURNING id', args: [short.why, template.id] }); } catch { warn('[sms-event] 일괄 발송 멈춤 표시 실패'); }
      }
      await noteSkip(db, template, short.why, warn);
      return { ...out, ran: true, reason: 'balance_short' };
    }
    if (template.auto_skip_reason) { try { await db.execute({ sql: 'UPDATE sms_text_templates SET auto_skip_reason = NULL WHERE id = ? RETURNING id', args: [template.id] }); } catch { warn('[sms-event] 건너뜀 사유 지우기 실패'); } } // 잔액 확인을 통과했으면 '잔액 부족' 사유를 지운다
  }

  // 문구 만들기: 한 건에서 예외가 나면 그 건만 건너뛴다.
  const links = await trackUrls(db, [...new Set(picked.map(item => item.orderId).filter(id => id !== null))]);
  const ready = [];
  for (const item of picked) {
    try { ready.push({ ...item, text: item.order ? fillVars(String(template.body).trim(), orderVars(item.order, template.auto_audience, links.get(item.orderId) || '')) : item.vars ? fillVars(String(template.body).trim(), item.vars) : String(template.body).trim() }); } catch { /* 이 건만 건너뜀 */ }
  }
  if (!ready.length) return { ...out, ran: true };

  const parts = buildEventParts(template, ata ? 0 : template.images.length); // 알림톡은 사진 없이 1통
  if (multiPartTimeShort(parts.length, endAt - tick(), env)) return { ...out, ran: true, reason: 'time' }; // 여러 통은 끝까지 나갈 시간이 모자라면 선점 전에 통째로 다음 실행으로
  if (timeShort()) return { ...out, ran: true, reason: 'time' };
  const fileIds = [];
  for (const base64 of ata ? [] : template.images) {
    let fileId = '';
    try { fileId = (await vendor.uploadImage({ base64, name: 'photo.jpg' }, { fetchImpl }))?.fileId || ''; } catch { fileId = ''; }
    if (!fileId) return { ...out, ran: true, reason: 'upload_failed' };
    fileIds.push(fileId);
  }

  if (timeShort()) return { ...out, ran: true, reason: 'time' };
  const fresh = ready.filter(item => !item.retryId);
  const claimedRows = [];
  for (const item of ready.filter(entry => entry.retryId)) { // 실패 행 재시도(1번만): 그 행을 다시 선점하고 retry_count 를 올린다
    const got = (await db.execute({ sql: "UPDATE sms_event_sends SET status = 'claimed', reason = NULL, checked_at = NULL, kst_date = ?, retry_count = COALESCE(retry_count, 0) + 1 WHERE id = ? AND status = 'failed' AND COALESCE(retry_count, 0) = 0 RETURNING id, dedupe_key", args: [today, item.retryId] })).rows || [];
    claimedRows.push(...got);
  }
  if (fresh.length) {
    const values = fresh.map(() => "(?, ?, ?, ?, ?, ?, 'claimed')").join(', ');
    const claimArgs = fresh.flatMap(item => [template.id, item.key, item.orderId, item.hash, item.last4, today]);
    claimedRows.push(...((await db.execute({
      sql: `INSERT INTO sms_event_sends (template_id, dedupe_key, order_id, phone_hash, phone_last4, kst_date, status) VALUES ${values} ON CONFLICT DO NOTHING RETURNING id, dedupe_key`,
      args: claimArgs,
    })).rows || []));
  }
  const byKey = new Map(ready.map(item => [item.key, item]));
  let active = claimedRows.map(row => ({ id: Number(row.id), item: byKey.get(row.dedupe_key) })).filter(entry => entry.item);
  const claimedCatchup = active.filter(entry => entry.item.catchup);
  if (claimedCatchup.length) await db.execute({ sql: `UPDATE sms_event_sends SET kind = 'catchup' WHERE id IN (${placeholders(claimedCatchup)})`, args: claimedCatchup.map(entry => entry.id) });
  // 크론이 겹쳐 돌았을 때: 선점 뒤 오늘 합계가 상한을 넘으면 넘은 행은 지우고 보내지 않는다(안내분·일괄 발송분을 따로 센다).
  const trim = async (group, after, limit) => {
    if (after <= limit) return;
    const drop = group.slice(Math.max(0, group.length - Math.min(group.length, after - limit)));
    if (!drop.length) return;
    await db.execute({ sql: `DELETE FROM sms_event_sends WHERE status = 'claimed' AND id IN (${placeholders(drop)})`, args: drop.map(entry => entry.id) });
    active = active.filter(entry => !drop.includes(entry));
  };
  await trim(active.filter(entry => !entry.item.catchup), await countToday(infoSql), max);
  if (claimedCatchup.length) { await trim(active.filter(entry => entry.item.catchup), await countToday(catchupSql), catchupGlobal); if (catchupOwn) await trim(active.filter(entry => entry.item.catchup), await countToday(catchupOwnSql), catchupOwn); }
  out.claimed = active.length;
  out.ran = true;
  if (!active.length) return out;
  if (memberKind) { // 선점 직후 번호를 지운다(메모리의 번호로만 보낸다)
    try { await clearPhones(db, active.map(entry => entry.item.signupId)); } catch { warn('[sms-event] 번호 지우기 실패'); }
  }

  const partStatus = [];
  const groupIds = [];
  let reason = '';
  let stop = false;
  let wholeFail = false;
  let failedPhones = null;
  for (const [partIndex, part] of parts.entries()) {
    if (stop) { partStatus.push('skipped'); continue; }
    await waitBeforePart(partIndex, { env, sleep }); // 앞 통이 먼저 도착하게 통 사이에 기다린다(마감 검사는 그 뒤)
    if (tick() >= endAt) { partStatus.push('skipped'); stop = true; reason = '시간 초과'; continue; }
    const messages = bms ? active.map(entry => ({ to: entry.item.phone, text: entry.item.text, ...(bmsCfg.imageId ? { imageId: bmsCfg.imageId } : {}), buttons: bmsCfg.buttons })) : ata ? active.map(entry => ({ to: entry.item.phone, templateId: template.auto_ata_template, variables: ataSendVars(entry.item, ataNames) })) : active.map(entry => {
      const message = { to: entry.item.phone, text: part.short ? part.text : entry.item.text };
      if (part.image >= 0) message.fileId = fileIds[part.image];
      return message;
    });
    let result;
    try { result = bms ? await vendor.sendBmsEach({ from, pfId, messages }, { fetchImpl }) : ata ? await vendor.sendKakaoEach({ from, pfId, messages, disableSms: env.SMS_AUTO_ATA_FALLBACK !== '1' }, { fetchImpl }) : await vendor.sendEach({ from, messages }, { fetchImpl }); } catch { result = ata ? { accepted: 0, failed: messages.length, uncertain: false, error: bms ? '브랜드메시지 발송 호출이 실패했습니다.' : '알림톡 발송 호출이 실패했습니다.' } : { accepted: 0, failed: 0, uncertain: true, error: '보냈는지 확인하지 못했습니다.' }; } // 알림톡의 예외는 접수 전 실패라 다시 시도할 수 있게 통째 실패로 본다(문자 갈래는 그대로)
    if (result.groupId) groupIds.push(result.groupId);
    if (result.uncertain) { partStatus.push('uncertain'); stop = true; reason = String(result.error || '불확실').slice(0, 200); }
    else if (ata && !(result.accepted > 0)) { partStatus.push('failed'); stop = true; wholeFail = true; reason = String(result.error || '거절').slice(0, 200); } // 알림톡 통째 실패(4xx·접수 0건·예외)
    else if (result.failed === 0) partStatus.push('sent');
    else if (result.accepted === 0) { partStatus.push('failed'); stop = true; reason = String(result.error || '거절').slice(0, 200); }
    else if (ata && Array.isArray(result.failedTo) && result.failedTo.length === result.failed) { partStatus.push('sent'); failedPhones = new Set(result.failedTo.map(digits)); reason = '일부 번호 실패'; } // 실패 번호를 알면 그 번호만 failed
    else { partStatus.push('uncertain'); stop = true; reason = '일부만 실패'; }
  }
  if (wholeFail) return ataWholeFail(db, template, active, { reason, warn, out });
  const status = partStatus.every(s => s === 'sent') ? 'sent' : partStatus[0] === 'failed' ? 'failed' : 'uncertain';
  if (failedPhones?.size) { // 알림톡 일부 실패: 실패 번호 행만 failed, 나머지는 sent
    const bad = active.filter(entry => failedPhones.has(entry.item.phone));
    const good = active.filter(entry => !failedPhones.has(entry.item.phone));
    const mark = async (list, st, why) => { if (!list.length) return; try { await db.execute({ sql: `UPDATE sms_event_sends SET status = ?, part_status = ?, reason = ?, group_ids = ? WHERE id IN (${placeholders(list)})`, args: [st, JSON.stringify(partStatus), why, JSON.stringify(groupIds), ...list.map(entry => entry.id)] }); } catch { /* 기록 실패가 이미 끝난 발송을 막지 않는다 */ } };
    await mark(bad, 'failed', reason);
    await mark(good, 'sent', null);
    out.failed = bad.length; out.sent = good.length;
    await clearAtaFail(db, template);
    return out;
  }
  try {
    await db.execute({
      sql: `UPDATE sms_event_sends SET status = ?, part_status = ?, reason = ?, group_ids = ? WHERE id IN (${placeholders(active)})`,
      args: [status, JSON.stringify(partStatus), reason || null, JSON.stringify(groupIds), ...active.map(entry => entry.id)],
    });
  } catch { /* 기록 실패가 이미 끝난 발송을 막지 않는다. 행은 claimed 로 남아 다음 실행이 uncertain 으로 바꾼다. */ }
  out[status] = active.length;
  if (status === 'sent') await clearAtaFail(db, template);
  return out;
}

// 선점 전 잔액 확인: 숫자 잔액이 필요 금액보다 작으면 { why }, 아니면(충분·조회 실패·단가 모름) null
async function balanceShort(vendor, bms, count, deps, env) {
  try {
    const estimator = bms ? vendor.estimateBms : vendor.estimateKakao;
    if (typeof estimator !== 'function') return null;
    return await balanceShortFor(Number(estimator.call(vendor, { count }, env)?.total), deps);
  } catch { return null; }
}
// 필요 금액(need)이 잔액보다 크면 { why }, 아니면(충분·조회 실패·단가 모름) null. 광고 문자 갈래(smsAutoSend)도 같은 확인을 쓴다.
export async function balanceShortFor(need, deps = {}) {
  try {
    const kakao = deps.kakao || kakaoTemplates;
    if (typeof kakao.getBalance !== 'function') return null;
    const balance = await kakao.getBalance(deps.kakaoOpts || (deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : undefined));
    if (!Number.isFinite(need) || typeof balance !== 'number' || !Number.isFinite(balance) || balance >= need) return null;
    return { why: `잔액 부족: 필요 ${need}원, 잔액 ${balance}원` };
  } catch { return null; }
}

// 접수 뒤 전부 실패한 그룹 찾기(알림톡·브랜드메시지): 최근 2일 안 sent 행(일괄 발송분·평소 발송분 모두)의 쏠라피 그룹 결과를 1번씩 확인한다(미확인 그룹이 있을 때만, 한 번에 최대 5그룹).
// 완료이고 성공·대체발송이 0건이면 그 그룹의 행을 지워 다시 대상이 되게 한다(일괄 발송분이 있으면 일괄 발송을 멈추고, 평소 발송분뿐이면 사유를 남기고 1시간 쉰다).
// 일부라도 성공했으면 확인 시각과 '그룹 일부 실패 N건'만 남긴다(어느 번호가 실패했는지는 그룹 결과에 없어 행 상태는 바꾸지 않는다). 완료가 아니거나 조회가 안 되면 아무것도 바꾸지 않는다.
// → 'paused'(일괄 발송을 멈춤) | 'retry'(평소 발송분을 지우고 쉼) | false
const RECHECK_GROUPS_PER_RUN = 5;
async function recheckAtaGroups(db, template, vendor, { nowMs, fetchImpl, warn }) {
  if (typeof vendor?.groupResult !== 'function') return false;
  let stopped = false;
  try {
    const rows = (await db.execute({ sql: "SELECT id, group_ids, kind FROM sms_event_sends WHERE template_id = ? AND status = 'sent' AND kst_date >= ? AND checked_at IS NULL ORDER BY id ASC", args: [template.id, addDays(kstDate(nowMs), -1)] })).rows || [];
    if (!rows.length) return false;
    const catchupIds = new Set(rows.filter(row => row.kind === 'catchup').map(row => Number(row.id)));
    const byGroup = new Map();
    const noGroup = [];
    for (const row of rows) {
      let ids = [];
      try { const parsed = JSON.parse(row.group_ids || '[]'); ids = Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []; } catch { ids = []; }
      if (!ids.length) { noGroup.push(Number(row.id)); continue; }
      for (const gid of ids) { if (!byGroup.has(gid)) byGroup.set(gid, []); byGroup.get(gid).push(Number(row.id)); }
    }
    if (noGroup.length) await db.execute({ sql: `UPDATE sms_event_sends SET checked_at = NOW() WHERE id IN (${placeholders(noGroup)})`, args: noGroup }); // 확인할 그룹이 없는 행은 다시 보지 않는다
    for (const [gid, rowIds] of [...byGroup.entries()].slice(0, RECHECK_GROUPS_PER_RUN)) {
      let result = null;
      try { result = await vendor.groupResult(gid, { fetchImpl }); } catch { result = null; }
      if (!result || (result.status !== 'COMPLETE' && result.status !== 'FAILED')) continue;
      if (![result.success, result.replacement, result.failed].every(Number.isFinite)) continue; // 숫자를 못 읽으면 아무것도 바꾸지 않는다
      if (result.success + result.replacement > 0) {
        if (result.failed > 0) await db.execute({ sql: `UPDATE sms_event_sends SET checked_at = NOW(), reason = ? WHERE id IN (${placeholders(rowIds)})`, args: [`그룹 일부 실패 ${result.failed}건(번호별 실패는 구분하지 못함)`, ...rowIds] });
        else await db.execute({ sql: `UPDATE sms_event_sends SET checked_at = NOW() WHERE id IN (${placeholders(rowIds)})`, args: rowIds });
        continue;
      }
      if (!(result.failed > 0)) continue; // 성공·대체·실패가 모두 0이면 아직 집계 전일 수 있어 그대로 둔다
      const why = `쏠라피 발송 실패: ${String(result.log || '성공 0건').slice(0, 150)}`;
      const dropIds = rowIds.filter(id => catchupIds.has(id)); // 일괄 발송분은 종전대로 지워 다시 대상이 되게 한다
      const failIds = rowIds.filter(id => !catchupIds.has(id)); // 평소 발송분은 지우지 않고 failed 로 남긴다(다시 대상이 되는 건 1번만)
      if (dropIds.length) await db.execute({ sql: `DELETE FROM sms_event_sends WHERE status = 'sent' AND id IN (${placeholders(dropIds)})`, args: dropIds });
      if (failIds.length) await db.execute({ sql: `UPDATE sms_event_sends SET status = 'failed', reason = ?, checked_at = NOW() WHERE status = 'sent' AND id IN (${placeholders(failIds)})`, args: [why, ...failIds] });
      if (rowIds.some(id => catchupIds.has(id))) {
        try { await db.execute({ sql: 'UPDATE sms_text_templates SET auto_catchup_paused_at = NOW(), auto_catchup_error = ?, auto_catchup_done_at = NULL WHERE id = ? RETURNING id', args: [why, template.id] }); } catch { warn('[sms-event] 일괄 발송 멈춤 표시 실패'); }
        stopped = 'paused';
      } else {
        await noteSkip(db, template, why, warn);
        try { await db.execute({ sql: "UPDATE sms_text_templates SET auto_ata_fail_at = CASE WHEN auto_ata_fail_at IS NULL THEN NOW() ELSE NOW() + INTERVAL '1 hour' END WHERE id = ? RETURNING id", args: [template.id] }); } catch { warn('[sms-event] 실패 표시 실패'); }
        if (!stopped) stopped = 'retry';
      }
    }
  } catch { warn('[sms-event] 쏠라피 그룹 결과 재확인 실패'); }
  return stopped;
}

// 알림톡 묶음이 통째 실패(접수 0건): 선점 행을 지워 다음에 다시 보낼 수 있게 한다.
// 일괄 발송(catchup)이 섞였으면 그 문구의 일괄 발송을 멈추고(완료 표시 없음) 사유를 남긴다 — 화면에서 다시 저장해야 이어진다.
// 평소 발송은 첫 실패는 다음 크론에 다시 시도, 연속 실패면 1시간 건너뛴다(auto_ata_fail_at 이 미래면 건너뜀, 성공하면 지움).
async function ataWholeFail(db, template, active, { reason, warn, out }) {
  try { await db.execute({ sql: `DELETE FROM sms_event_sends WHERE status = 'claimed' AND id IN (${placeholders(active)})`, args: active.map(entry => entry.id) }); } catch { warn('[sms-event] 알림톡 실패 행 삭제 실패'); }
  const why = String(reason || '알림톡 발송 실패').slice(0, 200);
  const hasCatchup = active.some(entry => entry.item.catchup);
  if (hasCatchup) {
    try { await db.execute({ sql: 'UPDATE sms_text_templates SET auto_catchup_paused_at = NOW(), auto_catchup_error = ? WHERE id = ? RETURNING id', args: [why, template.id] }); } catch { warn('[sms-event] 일괄 발송 멈춤 표시 실패'); }
  }
  if (active.some(entry => !entry.item.catchup)) {
    try { await db.execute({ sql: "UPDATE sms_text_templates SET auto_ata_fail_at = CASE WHEN auto_ata_fail_at IS NULL THEN NOW() ELSE NOW() + INTERVAL '1 hour' END WHERE id = ? RETURNING id", args: [template.id] }); } catch { warn('[sms-event] 실패 표시 실패'); }
  }
  return { ...out, failed: active.length, reason: hasCatchup ? 'catchup_paused' : 'ata_failed' };
}
async function clearAtaFail(db, template) { // 발송이 나가면 실패 표시와 건너뜀 사유를 함께 지운다
  if (!template.auto_ata_fail_at && !template.auto_skip_reason) return;
  try { await db.execute({ sql: 'UPDATE sms_text_templates SET auto_ata_fail_at = NULL, auto_skip_reason = NULL WHERE id = ? RETURNING id', args: [template.id] }); } catch { /* 다음 성공 때 다시 지운다 */ }
}
// 일반 발송이 잔액 부족·제공사 없음으로 건너뛴 사실을 남긴다(화면의 '켜짐' 판정용). 기록 실패는 발송 흐름을 막지 않는다.
export async function noteSkip(db, template, why, warn = console.warn) {
  try {
    await ensureEventSchema(db);
    await db.execute({ sql: 'UPDATE sms_text_templates SET auto_skip_reason = ?, auto_skip_at = NOW() WHERE id = ? RETURNING id', args: [String(why).slice(0, 200), template.id] });
  } catch { warn('[sms-event] 건너뜀 사유 기록 실패'); }
}

// 문구 하나의 실행이 예외로 끝나도 다음 문구는 계속한다: 사유를 남기고 null 을 돌려준다(번호처럼 긴 숫자는 가린다).
export async function runGuarded(db, template, task, warn = console.warn) {
  try { return await task(); } catch (error) {
    warn?.('[sms-auto] 문구 실행 오류');
    await noteSkip(db, template, `실행 오류: ${String(error?.message || error || '').replace(/\d{7,}/g, '***').replace(/\s+/g, ' ').trim().slice(0, 80)}`, warn);
    return null;
  }
}

// 크론 마지막 실행 시각(2026-11-18): 5분 크론이 멈춘 것을 화면이 알 수 있게 크론이 끝날 때마다 한 줄을 남긴다. 기록·조회 실패는 크론 결과를 바꾸지 않는다.
export async function recordCronRun(db, name, nowMs = Date.now()) {
  try {
    await db.execute({ sql: 'CREATE TABLE IF NOT EXISTS sms_cron_runs (name TEXT PRIMARY KEY, last_run TIMESTAMPTZ NOT NULL)', args: [] });
    await db.execute({ sql: 'INSERT INTO sms_cron_runs (name, last_run) VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET last_run = EXCLUDED.last_run', args: [String(name), new Date(nowMs).toISOString()] });
  } catch { /* 기록 실패는 조용히 */ }
}
// 두 크론(sms-auto 하루 1번, sms-auto-event 5분마다) 중 가장 최근 실행 시각(ISO). 기록이 없거나 조회가 안 되면 ''(멈춤으로 판단하지 않는다).
export async function cronLastRun(db) {
  try {
    const row = (await db.execute({ sql: 'SELECT MAX(last_run) AS last_run FROM sms_cron_runs', args: [] })).rows?.[0];
    const ms = row?.last_run ? Date.parse(row.last_run) : NaN;
    return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
  } catch { return ''; }
}

// 발송은 하지 않고 쏠라피 그룹 결과 재확인만 한다(알림톡·브랜드메시지).
async function recheckOnly(template, deps = {}) {
  const { db, provider, nowMs = Date.now(), fetchImpl, warn = console.warn } = deps;
  const out = { template_id: template.id, ran: false, reason: '', targets: 0, claimed: 0, sent: 0, failed: 0, uncertain: 0 };
  if (!template.auto_enabled || !isAtaTemplate(template)) return { ...out, reason: 'off' };
  const vendor = provider || getSendProvider();
  if (!provider && !hasSolapiCredentials()) return { ...out, reason: 'no_provider' };
  await ensureEventSchema(db);
  const rechecked = await recheckAtaGroups(db, template, vendor, { nowMs, fetchImpl, warn });
  return { ...out, ran: true, ...(rechecked ? { reason: rechecked === 'paused' ? 'catchup_paused' : 'ata_failed' } : {}) };
}

// 크론: 켜진 안내 문구를 모두 실행. 결과는 건수만.
export async function runEventSendAll(deps = {}) {
  const { db, nowMs = Date.now() } = deps;
  await ensureTextTemplateSchema(db);
  await ensureEventSchema(db);
  await db.execute({ sql: "UPDATE sms_event_sends SET status = 'uncertain', reason = '실행이 끊김' WHERE status = 'claimed' AND kst_date < ?", args: [kstDate(nowMs)] });
  const list = await db.execute({ sql: "SELECT id FROM sms_text_templates WHERE auto_enabled = true AND auto_kind IN ('due_date', 'ship_scheduled', 'ship_or_due') AND COALESCE(auto_send_time, '') = '' ORDER BY id ASC", args: [] });
  const total = { templates: 0, targets: 0, claimed: 0, sent: 0, failed: 0, uncertain: 0, skipped: 0 };
  const deadline = typeof deps.deadline === 'number' ? deps.deadline : (deps.tick || Date.now)() + TIME_BUDGET_MS;
  for (const row of list.rows || []) {
    const template = await loadEventTemplate(db, Number(row.id));
    if (!template) continue;
    total.templates += 1;
    const result = await runGuarded(db, template, () => runEventSend(template, { ...deps, deadline }), deps.warn);
    if (!result) { total.skipped += 1; continue; }
    if (result.reason && !result.ran) total.skipped += 1;
    for (const key of ['targets', 'claimed', 'sent', 'failed', 'uncertain']) total[key] += result[key];
  }
  return total;
}

// 즉시형 크론(5분마다): 켜진 즉시형 문구 SELECT 1번 — 없으면 끝. 야간(KST 21~08)에는 무동작(24시간 창 덕에 아침 첫 실행에서 나간다).
export async function runInstantSendAll(deps = {}) {
  const { db, nowMs = Date.now() } = deps;
  const total = { templates: 0, targets: 0, claimed: 0, sent: 0, failed: 0, uncertain: 0, skipped: 0 };
  // 즉시형·가입·문의 문구 + (이미 출고된 주문 1회 발송이 걸려 아직 안 끝난 출고 완료 후 알림톡 문구: 5분 크론이 지정 시각에 1번 실행)
  const sql = `SELECT id FROM sms_text_templates WHERE auto_enabled = true AND (auto_kind IN (${[...INSTANT_KINDS, ...LEAD_KINDS].map(kind => `'${kind}'`).join(', ')}) OR (auto_kind = 'ship_plus_days' AND COALESCE(auto_ata_template, '') <> '' AND COALESCE(auto_catchup_at, '') <> '' AND auto_catchup_done_at IS NULL AND auto_catchup_paused_at IS NULL) OR (COALESCE(auto_ata_template, '') <> '' AND id IN (SELECT template_id FROM sms_event_sends WHERE status = 'sent' AND kst_date >= ? AND checked_at IS NULL))) ORDER BY id ASC`; // 뒤쪽: 알림톡·브랜드메시지 문구는 최근 2일 안 미확인 그룹(일괄 발송분·평소 발송분)이 있으면 결과 재확인 때문에 목록에 넣는다
  const recheckFrom = addDays(kstDate(nowMs), -1);
  let list;
  try { list = await db.execute({ sql, args: [recheckFrom] }); } catch (error) {
    if (error?.code !== '42703' && error?.code !== '42P01') throw error; // 표·칸이 아직 없으면 만든 뒤 한 번 더
    await ensureTextTemplateSchema(db);
    await ensureEventSchema(db);
    list = await db.execute({ sql, args: [recheckFrom] });
  }
  if (!(list.rows || []).length || !inSendWindow(nowMs)) return total;
  await ensureTextTemplateSchema(db);
  await ensureEventSchema(db);
  await db.execute({ sql: "UPDATE sms_event_sends SET status = 'uncertain', reason = '실행이 끊김' WHERE status = 'claimed' AND kst_date < ?", args: [kstDate(nowMs)] });
  const deadline = typeof deps.deadline === 'number' ? deps.deadline : (deps.tick || Date.now)() + TIME_BUDGET_MS;
  let polled = false;
  for (const row of list.rows) {
    const template = await loadEventTemplate(db, Number(row.id));
    if (!template) continue;
    if (isLeadKind(template.auto_kind) && template.auto_enabled && !polled) { // 켜진 가입·문의 문구가 있을 때만, 한 번: 에어테이블 조회 + 카페24 보충 조회(실패는 조용히)
      polled = true;
      const warn = deps.warn || console.warn;
      try { await pollAirtableLeads(db, { env: deps.env || process.env, fetchImpl: deps.fetchImpl, nowMs, warn }); } catch { warn('[sms-event] 에어테이블 조회 실패'); }
      try { await pollSignups(db, { env: deps.env || process.env, fetchImpl: deps.fetchImpl, nowMs, warn }); } catch { warn('[sms-event] 카페24 보충 조회 실패'); }
    }
    total.templates += 1;
    const sendsHere = isInstantKind(template.auto_kind) || isLeadKind(template.auto_kind) || template.auto_kind === AUTO_KIND_SHIP; // 그 밖의 종류(날짜 기준·주문 후)는 자기 발송 시각을 지키려고 이 크론에서는 결과 재확인만 한다
    const result = await runGuarded(db, template, () => (sendsHere ? runEventSend(template, { ...deps, deadline, catchupOnly: template.auto_kind === AUTO_KIND_SHIP }) : recheckOnly(template, { ...deps, nowMs })), deps.warn); // 출고 문구는 평소 발송 시각을 지키려고 1회 발송 몫만 보낸다
    if (!result) { total.skipped += 1; continue; }
    if (result.reason && !result.ran) total.skipped += 1;
    for (const key of ['targets', 'claimed', 'sent', 'failed', 'uncertain']) total[key] += result[key];
  }
  return total;
}

// 공정 완료 직후(complete API): 방금 완료된 공정의 켜진 'process_completed' 문구를 크론 대기 없이 즉시 발송한다.
// sms_event_sends 의 UNIQUE(template_id, dedupe_key) 멱등 선점이 5분 크론(runInstantSendAll)과 겹쳐도 중복 발송을 막는다.
export async function triggerProcessCompletedAutoSends(db, completedStepNames = [], deps = {}) {
  const steps = [...new Set((Array.isArray(completedStepNames) ? completedStepNames : []).filter(step => STEPS.includes(step)))];
  const nowMs = deps.nowMs ?? Date.now();
  const env = deps.env || process.env;
  const total = { templates: 0, targets: 0, claimed: 0, sent: 0, failed: 0, uncertain: 0, skipped: 0 };
  if (!steps.length || !autoOn(env) || !inSendWindow(nowMs)) return total;
  let list;
  try {
    list = await db.execute({
      sql: `SELECT id FROM sms_text_templates WHERE auto_enabled = true AND auto_kind = 'process_completed' AND auto_step IN (${placeholders(steps)}) ORDER BY id ASC`,
      args: steps,
    });
  } catch (error) {
    if (error?.code === '42703' || error?.code === '42P01') return total;
    throw error;
  }
  if (!(list.rows || []).length) return total;
  await ensureTextTemplateSchema(db);
  await ensureEventSchema(db);
  const deadline = typeof deps.deadline === 'number' ? deps.deadline : (deps.tick || Date.now)() + 15000;
  for (const row of list.rows) {
    const template = await loadEventTemplate(db, Number(row.id));
    if (!template) continue;
    total.templates += 1;
    const result = await runGuarded(db, template, () => runEventSend(template, { ...deps, db, nowMs, env, deadline }), deps.warn);
    if (!result) { total.skipped += 1; continue; }
    if (result.reason && !result.ran) total.skipped += 1;
    for (const key of ['targets', 'claimed', 'sent', 'failed', 'uncertain']) total[key] += result[key];
  }
  return total;
}

// ---- 화면 자료 ----
export async function eventStatus(db, template, { nowMs = Date.now(), env = process.env, staff } = {}) {
  await ensureEventSchema(db);
  const id = template.id;
  const today = kstDate(nowMs);
  const sums = (await db.execute({ sql: "SELECT status, COUNT(*) AS n, MAX(kst_date) AS last FROM sms_event_sends WHERE template_id = ? AND COALESCE(reason, '') <> 'make_migrated' GROUP BY status", args: [id] })).rows || [];
  const count = status => Number(sums.find(row => row.status === status)?.n) || 0;
  const rows7 = (await db.execute({ sql: "SELECT status, COUNT(*) AS n FROM sms_event_sends WHERE template_id = ? AND status IN ('sent', 'failed') AND kst_date >= ? GROUP BY status", args: [id, addDays(today, -6)] })).rows || [];
  const sent7 = Number(rows7.find(row => row.status === 'sent')?.n) || 0;
  const failed7 = Number(rows7.find(row => row.status === 'failed')?.n) || 0;
  const todayTargets = (await pending(db, template, { nowMs, staff, preview: previewMode(template) })).length;
  const body = {
    enabled: template.auto_enabled && autoOn(env), no_provider: eventNoProvider(template, env), ata_backoff: Boolean(isAtaTemplate(template) && template.auto_ata_fail_at && Date.parse(template.auto_ata_fail_at) > nowMs), failed_7d: failed7, auto_skip_reason: template.auto_skip_reason || '', cron_last_run: await cronLastRun(db), days: 0, start_date: '', today_targets: todayTargets, sent_7d: sent7, sent_total: count('sent'),
    catchup_paused: Boolean(template.auto_catchup_paused), catchup_error: template.auto_catchup_paused ? String(template.auto_catchup_error || '') : '', failed_total: count('failed'), uncertain_total: count('uncertain') + count('claimed'), last_sent_date: sums.find(row => row.status === 'sent')?.last || '',
    enable_blocked_reason: eventBlockedReason(template) || (template.auto_kind === 'member_joined' && !(await cafe24Connected(db, env)) ? 'cafe24_not_connected' : '') || (isLeadKind(template.auto_kind) && !(await leadSourcesConnected(db, env)) ? 'lead_source_not_connected' : '') || eventWarnReason(template),
  };
  return reply(200, withEffective(body, nowMs));
}
// 실제 발송 판정(화면과 같은 규칙: shared/smsAutoEffective.js). effective = 지금 보내지는 상태, blocked = 막힌 사유('' 이면 막힘 없음)
export function withEffective(body, nowMs = Date.now()) {
  const result = autoEffective(body, nowMs);
  return { ...body, effective: result.tone === 'on' || result.tone === 'part', blocked: result.blocked ? String(result.text || result.blocked) : '' };
}
// 발송 제공사·발신번호가 없어 runEventSend 가 건너뛰는 상태(runEventSend 의 no_provider 판정과 같은 조건, 읽기만)
export function eventNoProvider(template, env = process.env) {
  if (!isInfoTemplate(template)) return false;
  const ata = isAtaTemplate(template);
  const bms = isBmsTemplate(template);
  const vendor = getSendProvider();
  const from = bms ? parseBmsConfig(template.auto_bms).from : digits(env.SMS_SENDER);
  return !vendor || typeof (bms ? vendor.sendBmsEach : ata ? vendor.sendKakaoEach : vendor.sendEach) !== 'function' || !from || !hasSolapiCredentials();
}

const needsStep = kind => kind === 'process_started' || kind === 'process_completed' || isProcessPlusKind(kind);
const previewMode = template => (isInstantKind(template.auto_kind) || isLeadKind(template.auto_kind) || isDayAta(template)) && !template.auto_enabled; // 켜기 전 미리 보기
// 080 줄이 없는 브랜드메시지(2026-11-18 사장님: 080 줄은 넣지 않는다): 막지 않고 경고만 남긴다(화면 '켜짐 · 080 수신거부 줄 필요').
export const eventWarnReason = template => (isBmsTemplate(template) && bmsOptoutCheck(template.body) ? 'no_optout_080' : '');
export function eventBlockedReason(template) {
  if (!isInfoTemplate(template)) return 'no_auto';
  if (needsStep(template.auto_kind) && !STEPS.includes(template.auto_step)) return 'no_step';
  if (template.auto_audience === 'staff' && !template.auto_staff.length) return 'no_staff';
  if (isAtaTemplate(template) && template.auto_audience !== 'customer') return 'ata_customer_only';
  return infoCheck(template.body, template.auto_audience, template.auto_kind, isAtaTemplate(template));
}

// 기존 고객·직원 알림과 같은 조건일 때만 true(기준일형은 기존 납기·출고일 알림이 있어 항상 true)
function instantOverlap(template) {
  const { auto_kind: kind, auto_step: step, auto_audience: audience } = template;
  if (isLeadKind(kind) || isDayAta(template)) return false; // 기존 알림이 없다
  if (!isInstantKind(kind)) return true;
  if (kind === 'member_joined') return false; // 기존 알림이 없다
  if (kind === 'order_created') return audience !== 'staff';
  if (kind === 'process_started') return audience !== 'staff' && step === '도면설계';
  return audience === 'staff' ? step === 'V-커팅작업' : step === '포장';
}

function costOf(vendor, parts, people, env) {
  let total = 0;
  for (const part of parts) total += Number(vendor.estimate({ type: part.image >= 0 ? 'MMS' : 'LMS', count: people }, env)?.total) || 0;
  return total;
}

// auto_toggle 의 켜기(enabled true). 안내 문구는 광고 검사 없이 안내 문구 검사만 거친다.
export async function eventToggleOn(body, template, { db, provider, env = process.env, nowMs = Date.now(), staff, kakao, kakaoOpts } = {}) {
  const blocked = eventBlockedReason(template);
  if (blocked) {
    const message = blocked === 'no_staff' ? '받는 직원을 1명 이상 골라야 켤 수 있습니다.' : blocked === 'no_auto' ? '자동 발송이 설정된 문구가 아닙니다.'
      : blocked === 'no_step' ? '공정을 골라 주세요.' : blocked === 'ata_customer_only' ? '알림톡은 고객에게만 보낼 수 있습니다.' : blocked === 'info_unknown_var' && template.auto_kind === 'member_joined' ? INFO_CHECK_MESSAGE.info_unknown_var : blocked === 'info_has_ad_words' ? '안내 문구에는 할인·이벤트 같은 광고 낱말을 쓸 수 없습니다.' : '안내 문구에는 주문 변수가 하나 이상 있어야 합니다.';
    return errorReply(400, message, { reason: blocked });
  }
  if (template.auto_kind === 'member_joined' && !(await cafe24Connected(db, env))) return errorReply(400, '카페24 연결이 아직 안 됐습니다.', { reason: 'cafe24_not_connected' });
  if (isLeadKind(template.auto_kind)) {
    if (!(await leadSourcesConnected(db, env))) return errorReply(400, '가입·문의 정보 연결이 아직 안 됐습니다.', { reason: 'lead_source_not_connected' });
  }
  if (isBmsTemplate(template)) {
    if (!bmsReady(template).ok) return errorReply(400, '브랜드메시지 설정(사진·글자 수)이 맞지 않습니다. 문구를 다시 저장해 주세요.', { reason: 'bms_not_ready' });
  } else if (isAtaTemplate(template)) {
    const ready = await ataReady(template.auto_ata_template, { kakao, kakaoOpts, env });
    if (!ready.ok && ready.reason === 'ata_no_channel') return errorReply(400, '카카오 채널을 찾지 못했습니다(템플릿 채널·KAKAO_PF_ID 확인).', { reason: 'ata_no_channel' });
    if (!ready.ok) return errorReply(400, '알림톡 템플릿이 승인 상태가 아니거나 고객명 외 변수가 있습니다.', { reason: 'ata_not_ready' });
  }
  const todayKind = template.auto_kind === 'member_joined' || (template.auto_kind === 'lead_plus_days' && Number(template.auto_days) === 0);
  if (todayKind) { // 가입 당일에 나가는 문구는 동시에 둘 이상 켜지 않는다(설계 19-7)
    const clash = await db.execute({ sql: "SELECT id FROM sms_text_templates WHERE auto_enabled = true AND id <> ? AND (auto_kind = 'member_joined' OR (auto_kind = 'lead_plus_days' AND auto_days = 0)) LIMIT 1", args: [template.id] });
    if (clash.rows?.length) return errorReply(400, '가입 당일에 나가는 문구가 이미 켜져 있습니다.', { reason: 'lead_overlap' });
  }
  if (!autoOn(env)) return errorReply(503, '자동 발송이 꺼져 있습니다.');
  if (body.dry_run === true) {
    const vendor = provider || getSendProvider();
    const parts = buildEventParts(template, isAtaTemplate(template) ? 0 : template.images.length);
    const targets = (await pending(db, template, { nowMs, staff, preview: previewMode(template) })).length; // 즉시형 켜기 전: 최근 24시간 사건 기준 미리 보기(읽기만)
    const leadKind = isLeadKind(template.auto_kind);
    const dailyMax = leadKind ? leadMaxPerDay(env) : infoMaxPerDay(env);
    const people = Math.min(targets, dailyMax);
    const bmsOn = isBmsTemplate(template);
    const kakaoEstimate = bmsOn ? vendor?.estimateBms : vendor?.estimateKakao;
    const cost = isAtaTemplate(template) ? (typeof kakaoEstimate === 'function' ? Number(kakaoEstimate.call(vendor, { count: people }, env)?.total) || 0 : null) : vendor ? costOf(vendor, parts, people, env) : null;
    const catchup = template.auto_kind === AUTO_KIND_SHIP && isAtaTemplate(template) && template.auto_catchup_from ? await catchupPreview(db, { from: template.auto_catchup_from, templateId: template.id, days: template.auto_days, nowMs, env, provider, kakao, kakaoOpts, bms: bmsOn, dailyCap: template.auto_catchup_daily }) : undefined;
    const unitInfo = bmsOn && typeof vendor?.estimateBms === 'function' ? vendor.estimateBms({ count: 1 }, env) : null;
    return reply(200, { ok: true, targets, parts: parts.length, cost, ...(unitInfo ? { bms: true, unit: unitInfo.unit, fallback_unit: unitInfo.fallback_unit } : {}), daily_max: dailyMax, overlap: instantOverlap(template), ...(catchup ? { catchup } : {}) });
  }
  const startDate = kstDate(nowMs);
  if (isInstantKind(template.auto_kind) || isLeadKind(template.auto_kind) || isDayAta(template)) { // 켠 시각 = NOW(). 이 시각 이전 사건은 보내지 않는다.
    await db.execute({ sql: 'UPDATE sms_text_templates SET auto_enabled = true, auto_start_date = ?, auto_enabled_at = NOW() WHERE id = ? RETURNING id', args: [startDate, template.id] });
    return reply(200, { ok: true, enabled: true, start_date: startDate });
  }
  await db.execute({ sql: 'UPDATE sms_text_templates SET auto_enabled = true, auto_start_date = ? WHERE id = ? RETURNING id', args: [startDate, template.id] });
  return reply(200, { ok: true, enabled: true, start_date: startDate });
}
