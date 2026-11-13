// 납기일·출고예정일 기준 안내(info) 문자(2026-11-13 설계 14절, 2단계-가). 기록 표는 새 표 sms_event_sends 하나뿐이다.
// orders·processes 는 SELECT 만 한다. 번호 전체·이름은 DB·응답·로그에 남기지 않는다(끝 4자리와 해시만).
// 안내 문구는 광고가 아니므로 광고 검사·수신거부·하루 1통·광고 상한을 적용하지 않는다. 야간 금지·전체 마감 시각·선점 INSERT·재발송 없음은 광고와 같다.
import crypto from 'node:crypto';
import { hasSolapiCredentials } from './solapiMessageLog.js';
import { getSendProvider } from './sendProvider.js';
import { staffDirectory } from './smsManualSend.js';
import { ensureTextTemplateSchema, infoCheck, INSTANT_KINDS, isEventKind, isInfoKind, isInstantKind, parseStaffIds, storedImages } from './smsTextTemplates.js';
import { STEPS } from './steps.js';
import { customerExpectedShipDate } from '../../src/utils/customerShippingDate.js';
import { parsePositiveIntegerQuantity } from '../../src/utils/quantity.js';

const HASH_SALT = 'hansung-sms-event-v1';
const TARGET_RE = /^010\d{7,8}$/;
const MOBILE_RE = /^01[016789]\d{7,8}$/;
const SEND_WINDOW = { from: 8, to: 21 }; // KST 08시 이상 21시 미만
const TIME_BUDGET_MS = 20000;
const SEND_RESERVE_MS = 4000;
const TARGET_LIMIT = 1000;
const DEFAULT_MAX_PER_DAY = 200;
const DATE_COLUMN = Object.freeze({ due_date: 'due_date', ship_scheduled: 'ship_scheduled_date' });
const PROCESS_COLUMN = Object.freeze({ process_started: 'started_at', process_completed: 'completed_at' });
const WINDOW_MS = 24 * 3600000; // 즉시형 사건 창: [max(켠 시각, 지금 − 24시간), 지금]
const KEY_CHUNK = 200;
const ORDER_COLUMNS = 'o.id, o.phone, o.client_name, o.order_date, o.due_date, o.ship_scheduled_date, o.product_type, o.door_type, o.width, o.depth, o.height, o.quantity';
export const CUSTOMER_VARS = Object.freeze(['고객명', '주문번호', '규격', '수량', '예상출고일', '조회링크']);
export const STAFF_VARS = Object.freeze([...CUSTOMER_VARS, '제품']);

const flags = new Map();
export function _resetEventSchemaForTest() { flags.clear(); }

const digits = value => String(value ?? '').replace(/\D/g, '');
const kstDate = nowMs => new Date(nowMs + 9 * 3600000).toISOString().slice(0, 10);
const kstHour = nowMs => new Date(nowMs + 9 * 3600000).getUTCHours();
const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const inSendWindow = nowMs => { const h = kstHour(nowMs); return h >= SEND_WINDOW.from && h < SEND_WINDOW.to; };
const hashOf = phone => crypto.createHash('sha256').update(`${HASH_SALT}:${digits(phone)}`).digest('hex');
const intEnv = (value, fallback) => { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback; };
const placeholders = list => list.map(() => '?').join(', ');
export const infoMaxPerDay = (env = process.env) => intEnv(env.SMS_AUTO_INFO_MAX_PER_DAY, DEFAULT_MAX_PER_DAY);
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
  flags.set('sms.event', true);
}

// ---- 본문 변수(값 계산은 notify.js 와 같은 규칙, 그 파일은 고치지 않는다) ----
const orderNo = order => `HS-${String(order.order_date || '').slice(0, 4) || String(new Date().getUTCFullYear())}-${String(order.id).padStart(4, '0')}`;
const orderSize = order => (order.width && order.depth && order.height ? `${order.width}×${order.depth}×${order.height}mm` : '');
const specLine = order => [order.door_type || '', orderSize(order)].filter(Boolean).join(' ');
const fmtDate = value => { const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(value || '')); return m ? `${m[1]}-${m[2]}-${m[3]}` : '협의 예정'; };
const cleanValue = value => String(value ?? '').replace(/#\{|\}/g, '').replace(/\s+/g, ' ').trim();

export function orderVars(order, audience, trackUrl = '') {
  const qty = parsePositiveIntegerQuantity(order.quantity);
  const vars = {
    고객명: cleanValue(order.client_name).slice(0, 20) || '고객', 주문번호: orderNo(order), 규격: specLine(order),
    수량: qty === null ? '' : `${qty}대`, 예상출고일: fmtDate(customerExpectedShipDate(order)), 조회링크: trackUrl || '',
  };
  if (audience === 'staff') vars.제품 = cleanValue(order.product_type) || '주문 제품';
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
  return fillVars(String(template.body).trim(), orderVars(EXAMPLE_ORDER, template.auto_audience === 'staff' ? 'staff' : 'customer', 'https://production-status.vercel.app/track/EXAMPLE'));
}

export async function loadEventTemplate(db, id) {
  await ensureTextTemplateSchema(db);
  const out = await db.execute({
    sql: 'SELECT id, name, body, image, images, auto_kind, auto_enabled, auto_offset, auto_unless_step, auto_audience, auto_staff, auto_msg_type, auto_step, auto_enabled_at FROM sms_text_templates WHERE id = ?',
    args: [id],
  });
  const row = out.rows?.[0];
  if (!row) return null;
  return {
    id: Number(row.id), name: row.name, body: row.body, images: storedImages(row), auto_kind: row.auto_kind || '', auto_enabled: row.auto_enabled === true,
    auto_offset: Number(row.auto_offset) || 0, auto_unless_step: row.auto_unless_step || '', auto_audience: row.auto_audience === 'staff' ? 'staff' : 'customer',
    auto_staff: parseStaffIds(row.auto_staff), auto_msg_type: 'info',
    auto_step: row.auto_step || '', auto_enabled_at: row.auto_enabled_at ? new Date(row.auto_enabled_at).toISOString() : '',
  };
}

// 주문 행 → 받는 사람별 발송 후보. suffix 는 dedupe_key 끝 부분(기준일형: 기준일, 즉시형: 종류).
function expandItems(rows, template, staff, suffix) {
  const people = template.auto_audience === 'staff'
    ? (staff || staffDirectory()).filter(person => template.auto_staff.includes(person.id) && MOBILE_RE.test(digits(person.phone)))
    : null;
  const items = [];
  for (const order of rows || []) {
    const recipients = people ? people.map(person => digits(person.phone)) : [digits(order.phone)].filter(phone => TARGET_RE.test(phone));
    const seen = new Set();
    for (const phone of recipients) {
      if (seen.has(phone)) continue;
      seen.add(phone);
      const hash = hashOf(phone);
      items.push({ order, orderId: Number(order.id), phone, hash, last4: phone.slice(-4), baseDay: suffix, key: `${hash}:${Number(order.id)}:${suffix}` });
    }
  }
  return items;
}

// 즉시형 사건(읽기만): 창 안에 생긴 주문 등록·공정 시작/완료. 켠 시각이 없으면 대상 없음. cancelled 주문·시각이 NULL(되돌린) 공정 제외.
async function instantCandidates(db, template, { nowMs, staff, preview }) {
  const enabledMs = preview ? nowMs - WINDOW_MS : Date.parse(template.auto_enabled_at || ''); // 켜기 전 미리 보기: 창 = [지금 − 24시간, 지금]
  if (!Number.isFinite(enabledMs)) return [];
  const from = new Date(Math.max(enabledMs, nowMs - WINDOW_MS)).toISOString();
  const to = new Date(nowMs).toISOString();
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
        WHERE p.step_name = ? AND p.${column} IS NOT NULL AND p.${column} ~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\\.[0-9]+)?Z$' AND p.${column} >= ? AND p.${column} <= ? AND COALESCE(o.status, '') <> 'cancelled'
        ORDER BY o.id ASC LIMIT ${TARGET_LIMIT}`,
      args: [template.auto_step, from, to],
    });
  }
  const seenOrders = new Set();
  const rows = (out.rows || []).filter(row => !seenOrders.has(Number(row.id)) && seenOrders.add(Number(row.id)));
  return expandItems(rows, template, staff, template.auto_kind);
}

// 오늘 대상(이미 선점한 것 제외 전). 납기일/출고예정일 칸이 오늘 − offset 인 진행 중 주문만(당일만, 뒤늦게 보내지 않음).
async function candidates(db, template, { nowMs, staff, preview }) {
  if (isInstantKind(template.auto_kind)) return instantCandidates(db, template, { nowMs, staff, preview });
  if (!isEventKind(template.auto_kind)) return [];
  const column = DATE_COLUMN[template.auto_kind];
  const baseDay = addDays(kstDate(nowMs), -template.auto_offset);
  const args = [baseDay];
  let unless = '';
  if (template.auto_unless_step) { unless = " AND EXISTS (SELECT 1 FROM processes p WHERE p.order_id = o.id AND p.step_name = ? AND p.status <> 'completed')"; args.push(template.auto_unless_step); }
  const out = await db.execute({
    sql: `SELECT ${ORDER_COLUMNS}
      FROM orders o WHERE o.status = 'in_production' AND o.${column} IS NOT NULL AND LEFT(o.${column}, 10) = ?${unless} ORDER BY o.id ASC LIMIT ${TARGET_LIMIT}`,
    args,
  });
  return expandItems(out.rows, template, staff, baseDay);
}

async function pending(db, template, deps) {
  const items = await candidates(db, template, deps);
  if (!items.length) return [];
  if (isInstantKind(template.auto_kind)) { // 즉시형: 후보 키만 IN 조회(문구 기록 전체를 읽지 않는다)
    const done = new Set();
    const keys = items.map(item => item.key);
    for (let i = 0; i < keys.length; i += KEY_CHUNK) {
      const chunk = keys.slice(i, i + KEY_CHUNK);
      for (const row of (await db.execute({ sql: `SELECT dedupe_key FROM sms_event_sends WHERE template_id = ? AND dedupe_key IN (${placeholders(chunk)})`, args: [template.id, ...chunk] })).rows || []) done.add(row.dedupe_key);
    }
    return items.filter(item => !done.has(item.key));
  }
  const claimed = new Set(((await db.execute({ sql: 'SELECT dedupe_key FROM sms_event_sends WHERE template_id = ?', args: [template.id] })).rows || []).map(row => row.dedupe_key));
  return items.filter(item => !claimed.has(item.key));
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

// ---- 문구 1개 실행 ----
export async function runEventSend(template, { db, provider, env = process.env, nowMs = Date.now(), fetchImpl, tick = Date.now, deadline, staff, warn = console.warn } = {}) {
  const startedAt = tick();
  const shared = typeof deadline === 'number';
  const endAt = shared ? deadline : startedAt + TIME_BUDGET_MS;
  const timeShort = () => shared && endAt - tick() < SEND_RESERVE_MS;
  const out = { template_id: template.id, ran: false, reason: '', targets: 0, claimed: 0, sent: 0, failed: 0, uncertain: 0 };
  if (!template.auto_enabled || !autoOn(env)) return { ...out, reason: 'off' };
  if (!inSendWindow(nowMs)) return { ...out, reason: 'night' };
  if (!isInfoKind(template.auto_kind)) return { ...out, reason: 'no_auto' };
  if (isInstantKind(template.auto_kind) && template.auto_kind !== 'order_created' && !STEPS.includes(template.auto_step)) return { ...out, reason: 'no_step' };
  if ((template.auto_audience === 'staff' && !template.auto_staff.length) || infoCheck(template.body, template.auto_audience)) return { ...out, reason: 'info_check' };
  const vendor = provider || getSendProvider();
  const from = digits(env.SMS_SENDER);
  if (!vendor || typeof vendor.sendEach !== 'function' || !from) return { ...out, reason: 'no_provider' };
  if (!provider && !hasSolapiCredentials()) return { ...out, reason: 'no_provider' };

  await ensureEventSchema(db);
  const today = kstDate(nowMs);
  const eligible = await pending(db, template, { nowMs, staff });
  out.targets = eligible.length;
  if (!eligible.length) return { ...out, ran: true };

  const max = infoMaxPerDay(env);
  const usedToday = Number((await db.execute({ sql: 'SELECT COUNT(*) AS n FROM sms_event_sends WHERE kst_date = ?', args: [today] })).rows?.[0]?.n) || 0;
  const picked = eligible.slice(0, Math.max(0, max - usedToday));
  if (picked.length < eligible.length) warn('[sms-event] 하루 상한으로 못 보낸 건수', eligible.length - picked.length);
  if (!picked.length) return { ...out, ran: true, reason: 'cap' };

  // 문구 만들기: 한 건에서 예외가 나면 그 건만 건너뛴다.
  const links = await trackUrls(db, [...new Set(picked.map(item => item.orderId))]);
  const ready = [];
  for (const item of picked) {
    try { ready.push({ ...item, text: fillVars(String(template.body).trim(), orderVars(item.order, template.auto_audience, links.get(item.orderId) || '')) }); } catch { /* 이 건만 건너뜀 */ }
  }
  if (!ready.length) return { ...out, ran: true };

  const parts = buildEventParts(template, template.images.length);
  if (timeShort()) return { ...out, ran: true, reason: 'time' };
  const fileIds = [];
  for (const base64 of template.images) {
    let fileId = '';
    try { fileId = (await vendor.uploadImage({ base64, name: 'photo.jpg' }, { fetchImpl }))?.fileId || ''; } catch { fileId = ''; }
    if (!fileId) return { ...out, ran: true, reason: 'upload_failed' };
    fileIds.push(fileId);
  }

  if (timeShort()) return { ...out, ran: true, reason: 'time' };
  const values = ready.map(() => "(?, ?, ?, ?, ?, ?, 'claimed')").join(', ');
  const claimArgs = ready.flatMap(item => [template.id, item.key, item.orderId, item.hash, item.last4, today]);
  const claimedRows = (await db.execute({
    sql: `INSERT INTO sms_event_sends (template_id, dedupe_key, order_id, phone_hash, phone_last4, kst_date, status) VALUES ${values} ON CONFLICT DO NOTHING RETURNING id, dedupe_key`,
    args: claimArgs,
  })).rows || [];
  const byKey = new Map(ready.map(item => [item.key, item]));
  let active = claimedRows.map(row => ({ id: Number(row.id), item: byKey.get(row.dedupe_key) })).filter(entry => entry.item);
  // 크론이 겹쳐 돌았을 때: 선점 뒤 오늘 합계가 상한을 넘으면 넘은 행은 지우고 보내지 않는다.
  const after = Number((await db.execute({ sql: 'SELECT COUNT(*) AS n FROM sms_event_sends WHERE kst_date = ?', args: [today] })).rows?.[0]?.n) || 0;
  if (after > max) {
    const over = Math.min(active.length, after - max);
    const drop = active.slice(active.length - over);
    if (drop.length) {
      await db.execute({ sql: `DELETE FROM sms_event_sends WHERE status = 'claimed' AND id IN (${placeholders(drop)})`, args: drop.map(entry => entry.id) });
      active = active.slice(0, active.length - over);
    }
  }
  out.claimed = active.length;
  out.ran = true;
  if (!active.length) return out;

  const partStatus = [];
  const groupIds = [];
  let reason = '';
  let stop = false;
  for (const part of parts) {
    if (stop) { partStatus.push('skipped'); continue; }
    if (tick() >= endAt) { partStatus.push('skipped'); stop = true; reason = '시간 초과'; continue; }
    const messages = active.map(entry => {
      const message = { to: entry.item.phone, text: part.short ? part.text : entry.item.text };
      if (part.image >= 0) message.fileId = fileIds[part.image];
      return message;
    });
    let result;
    try { result = await vendor.sendEach({ from, messages }, { fetchImpl }); } catch { result = { accepted: 0, failed: 0, uncertain: true, error: '보냈는지 확인하지 못했습니다.' }; }
    if (result.groupId) groupIds.push(result.groupId);
    if (result.uncertain) { partStatus.push('uncertain'); stop = true; reason = String(result.error || '불확실').slice(0, 200); }
    else if (result.failed === 0) partStatus.push('sent');
    else if (result.accepted === 0) { partStatus.push('failed'); stop = true; reason = String(result.error || '거절').slice(0, 200); }
    else { partStatus.push('uncertain'); stop = true; reason = '일부만 실패'; }
  }
  const status = partStatus.every(s => s === 'sent') ? 'sent' : partStatus[0] === 'failed' ? 'failed' : 'uncertain';
  try {
    await db.execute({
      sql: `UPDATE sms_event_sends SET status = ?, part_status = ?, reason = ?, group_ids = ? WHERE id IN (${placeholders(active)})`,
      args: [status, JSON.stringify(partStatus), reason || null, JSON.stringify(groupIds), ...active.map(entry => entry.id)],
    });
  } catch { /* 기록 실패가 이미 끝난 발송을 막지 않는다. 행은 claimed 로 남아 다음 실행이 uncertain 으로 바꾼다. */ }
  out[status] = active.length;
  return out;
}

// 크론: 켜진 안내 문구를 모두 실행. 결과는 건수만.
export async function runEventSendAll(deps = {}) {
  const { db, nowMs = Date.now() } = deps;
  await ensureTextTemplateSchema(db);
  await ensureEventSchema(db);
  await db.execute({ sql: "UPDATE sms_event_sends SET status = 'uncertain', reason = '실행이 끊김' WHERE status = 'claimed' AND kst_date < ?", args: [kstDate(nowMs)] });
  const list = await db.execute({ sql: "SELECT id FROM sms_text_templates WHERE auto_enabled = true AND auto_kind IN ('due_date', 'ship_scheduled') ORDER BY id ASC", args: [] });
  const total = { templates: 0, targets: 0, claimed: 0, sent: 0, failed: 0, uncertain: 0, skipped: 0 };
  const deadline = typeof deps.deadline === 'number' ? deps.deadline : (deps.tick || Date.now)() + TIME_BUDGET_MS;
  for (const row of list.rows || []) {
    const template = await loadEventTemplate(db, Number(row.id));
    if (!template) continue;
    total.templates += 1;
    const result = await runEventSend(template, { ...deps, deadline });
    if (result.reason && !result.ran) total.skipped += 1;
    for (const key of ['targets', 'claimed', 'sent', 'failed', 'uncertain']) total[key] += result[key];
  }
  return total;
}

// 즉시형 크론(5분마다): 켜진 즉시형 문구 SELECT 1번 — 없으면 끝. 야간(KST 21~08)에는 무동작(24시간 창 덕에 아침 첫 실행에서 나간다).
export async function runInstantSendAll(deps = {}) {
  const { db, nowMs = Date.now() } = deps;
  const total = { templates: 0, targets: 0, claimed: 0, sent: 0, failed: 0, uncertain: 0, skipped: 0 };
  const sql = `SELECT id FROM sms_text_templates WHERE auto_enabled = true AND auto_kind IN (${INSTANT_KINDS.map(kind => `'${kind}'`).join(', ')}) ORDER BY id ASC`;
  let list;
  try { list = await db.execute({ sql, args: [] }); } catch (error) {
    if (error?.code !== '42703' && error?.code !== '42P01') throw error; // 표·칸이 아직 없으면 만든 뒤 한 번 더
    await ensureTextTemplateSchema(db);
    list = await db.execute({ sql, args: [] });
  }
  if (!(list.rows || []).length || !inSendWindow(nowMs)) return total;
  await ensureTextTemplateSchema(db);
  await ensureEventSchema(db);
  await db.execute({ sql: "UPDATE sms_event_sends SET status = 'uncertain', reason = '실행이 끊김' WHERE status = 'claimed' AND kst_date < ?", args: [kstDate(nowMs)] });
  const deadline = typeof deps.deadline === 'number' ? deps.deadline : (deps.tick || Date.now)() + TIME_BUDGET_MS;
  for (const row of list.rows) {
    const template = await loadEventTemplate(db, Number(row.id));
    if (!template) continue;
    total.templates += 1;
    const result = await runEventSend(template, { ...deps, deadline });
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
  const sums = (await db.execute({ sql: 'SELECT status, COUNT(*) AS n, MAX(kst_date) AS last FROM sms_event_sends WHERE template_id = ? GROUP BY status', args: [id] })).rows || [];
  const count = status => Number(sums.find(row => row.status === status)?.n) || 0;
  const sent7 = Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM sms_event_sends WHERE template_id = ? AND status = 'sent' AND kst_date >= ?", args: [id, addDays(today, -6)] })).rows?.[0]?.n) || 0;
  const todayTargets = (await pending(db, template, { nowMs, staff, preview: isInstantKind(template.auto_kind) && !template.auto_enabled })).length;
  return reply(200, {
    enabled: template.auto_enabled && autoOn(env), days: 0, start_date: '', today_targets: todayTargets, sent_7d: sent7, sent_total: count('sent'),
    failed_total: count('failed'), uncertain_total: count('uncertain') + count('claimed'), last_sent_date: sums.find(row => row.status === 'sent')?.last || '',
    enable_blocked_reason: eventBlockedReason(template),
  });
}

export function eventBlockedReason(template) {
  if (!isInfoKind(template.auto_kind)) return 'no_auto';
  if (isInstantKind(template.auto_kind) && template.auto_kind !== 'order_created' && !STEPS.includes(template.auto_step)) return 'no_step';
  if (template.auto_audience === 'staff' && !template.auto_staff.length) return 'no_staff';
  return infoCheck(template.body, template.auto_audience);
}

// 기존 고객·직원 알림과 같은 조건일 때만 true(기준일형은 기존 납기·출고일 알림이 있어 항상 true)
function instantOverlap(template) {
  const { auto_kind: kind, auto_step: step, auto_audience: audience } = template;
  if (!isInstantKind(kind)) return true;
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
export async function eventToggleOn(body, template, { db, provider, env = process.env, nowMs = Date.now(), staff } = {}) {
  const blocked = eventBlockedReason(template);
  if (blocked) {
    const message = blocked === 'no_staff' ? '받는 직원을 1명 이상 골라야 켤 수 있습니다.' : blocked === 'no_auto' ? '자동 발송이 설정된 문구가 아닙니다.'
      : blocked === 'no_step' ? '공정을 골라 주세요.' : blocked === 'info_has_ad_words' ? '안내 문구에는 할인·이벤트 같은 광고 낱말을 쓸 수 없습니다.' : '안내 문구에는 주문 변수가 하나 이상 있어야 합니다.';
    return errorReply(400, message, { reason: blocked });
  }
  if (!autoOn(env)) return errorReply(503, '자동 발송이 꺼져 있습니다.');
  if (body.dry_run === true) {
    const vendor = provider || getSendProvider();
    const parts = buildEventParts(template, template.images.length);
    const targets = (await pending(db, template, { nowMs, staff, preview: isInstantKind(template.auto_kind) && !template.auto_enabled })).length; // 즉시형 켜기 전: 최근 24시간 사건 기준 미리 보기(읽기만)
    const people = Math.min(targets, infoMaxPerDay(env));
    return reply(200, { ok: true, targets, parts: parts.length, cost: vendor ? costOf(vendor, parts, people, env) : null, daily_max: infoMaxPerDay(env), overlap: instantOverlap(template) });
  }
  const startDate = kstDate(nowMs);
  if (isInstantKind(template.auto_kind)) { // 켠 시각 = NOW(). 이 시각 이전 사건은 보내지 않는다.
    await db.execute({ sql: 'UPDATE sms_text_templates SET auto_enabled = true, auto_start_date = ?, auto_enabled_at = NOW() WHERE id = ? RETURNING id', args: [startDate, template.id] });
    return reply(200, { ok: true, enabled: true, start_date: startDate });
  }
  await db.execute({ sql: 'UPDATE sms_text_templates SET auto_enabled = true, auto_start_date = ? WHERE id = ? RETURNING id', args: [startDate, template.id] });
  return reply(200, { ok: true, enabled: true, start_date: startDate });
}
