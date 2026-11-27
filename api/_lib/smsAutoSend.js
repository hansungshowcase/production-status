// 출고 완료 후 N일 뒤 자동 문자(2026-11-13 설계). 문자 관리 쪽 새 표(sms_auto_sends·sms_optouts)만 쓴다.
// orders 는 SELECT 만 한다(orders·processes·notification_log 에 쓰지 않는다). 번호 전체·이름은 DB·응답·로그에 남기지 않는다(끝 4자리와 해시만).
// 자동 재시도는 없다: 불확실하거나 일부만 실패하면 'uncertain' 으로 두고 다시 보내지 않는다.
import crypto from 'node:crypto';
import { hasSolapiCredentials } from './solapiMessageLog.js';
import { classifyText, getSendProvider } from './sendProvider.js';
import { ensureManualSendSchema, multiPartTimeShort, sendSettings, waitBeforePart } from './smsManualSend.js';
import { AUTO_KIND, AUTO_KIND_PROCESS, AUTO_KIND_PROCESS_COMPLETED, AUTO_LIMITS, adCheck, isAtaTemplate, isAutoKind, isDayAta, isEventKind, isInfoTemplate, isProcessPlusKind, ensureTextTemplateSchema, isLeadKind, OPTOUT_LINE_RE, parseAutoChain, parseStaffIds, storedImages } from './smsTextTemplates.js';
import { STEPS } from './steps.js';
import { BMS_TEMPLATE_ID, bmsReady, bmsTestInWindow, isBmsTemplate, parseBmsConfig } from './smsBms.js';
import { dueMarkEntries, ataReady, ataSendVars, nameVars, balanceShortFor, buildEventParts, catchupActive, catchupDailyCap, catchupMaxPerDay, cronLastRun, ensureEventSchema, eventExampleText, eventPhoneHash, fillVars, eventStatus, eventToggleOn, inTimedWindow, kstMinutes, loadEventTemplate, noteSkip, runEventSend, runGuarded, withEffective } from './smsEventSend.js';
import { buildAdminCopySms, sendAdminCopySms } from './adminCopySms.js';

export { buildAdminCopySms };

const DAY_MS = 86400000;
const HASH_SALT = 'hansung-sms-auto-v1';
const TARGET_RE = /^010\d{7,8}$/;
const MOBILE_RE = /^01[016789]\d{7,8}$/;
const KEY_RE = /^[\w-]{8,80}$/;
const CATCH_UP_DAYS = 3;
const DEFAULT_MAX_PER_DAY = 30;
const SEND_WINDOW = { from: 8, to: 21 }; // KST 08시 이상 21시 미만
const TIME_BUDGET_MS = 70000; // 여러 통 사이 기다림(설계 22-4) 때문에 20초에서 올림. 함수 제한 90초(vercel.json) 안
export const AUTO_TIME_BUDGET_MS = TIME_BUDGET_MS; // 크론이 광고·안내 실행에 같은 전체 마감 시각을 넘길 때 쓴다
const SEND_RESERVE_MS = 4000; // 전체 마감까지 이만큼도 안 남았으면 사진 올리기·선점을 시작하지 않는다
const TARGET_LIMIT = 1000;
export const AD_CATCHUP_PER_RUN = 30; // 광고 문자 일괄 발송(이미 출고된 주문 한 번 보내기)은 실행 1번에 이만큼까지
const AD_CATCHUP_LIMIT = 20000; // 일괄 후보 한 번 조회 상한(번호 기준 중복 제거 전)

// 주문 후 N일(order_plus_days)만 0일(주문 당일, 지정 시각)을 허용한다. 출고·공정 후 N일은 종전대로 1일 이상.
const daysOk = template => Number(template?.auto_days) >= (template?.auto_kind === 'order_plus_days' ? 0 : 1);

const flags = new Map();
export function _resetAutoSchemaForTest() { flags.clear(); }

export async function ensureAutoSchema(db) {
  if (flags.get('sms.auto')) return;
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS sms_auto_sends (
      id BIGSERIAL PRIMARY KEY,
      template_id BIGINT NOT NULL,
      phone_hash TEXT NOT NULL,
      phone_last4 TEXT,
      order_id BIGINT,
      ship_date TEXT,
      kst_date TEXT NOT NULL,
      status TEXT NOT NULL,
      part_status TEXT,
      reason TEXT,
      group_ids TEXT,
      round INT NOT NULL DEFAULT 1,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    args: [],
  });
  // 회차(2026-11-13): 순서 고정 — ① 칸 추가 ② 새 유일 인덱스 ③ 옛 유일 제약 삭제. 실패하면 이 실행이 실패로 끝난다(선점 전).
  await db.execute({ sql: 'ALTER TABLE sms_auto_sends ADD COLUMN IF NOT EXISTS round INT NOT NULL DEFAULT 1', args: [] });
  await db.execute({ sql: 'ALTER TABLE sms_auto_sends ADD COLUMN IF NOT EXISTS kind TEXT', args: [] }); // 'catchup' = 이미 출고된 주문 한 번 보내기분(평소 하루 상한에서 뺀다)
  await db.execute({ sql: 'CREATE UNIQUE INDEX IF NOT EXISTS sms_auto_sends_tpl_phone_round ON sms_auto_sends (template_id, phone_hash, round)', args: [] });
  await db.execute({ sql: 'CREATE UNIQUE INDEX IF NOT EXISTS sms_auto_sends_tpl_order_round ON sms_auto_sends (template_id, order_id, round)', args: [] });
  const oldUnique = (await db.execute({ sql: "SELECT conname FROM pg_constraint WHERE conrelid = 'sms_auto_sends'::regclass AND contype = 'u'", args: [] })).rows || [];
  for (const row of oldUnique) {
    const name = String(row.conname || '');
    if (name) await db.execute({ sql: `ALTER TABLE sms_auto_sends DROP CONSTRAINT IF EXISTS "${name.replace(/"/g, '""')}"`, args: [] });
  }
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS sms_optouts (
      id BIGSERIAL PRIMARY KEY,
      phone_hash TEXT NOT NULL UNIQUE,
      phone_last4 TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    args: [],
  });
  flags.set('sms.auto', true);
}

const reply = (status, body) => ({ status, body });
const errorReply = (status, message, extra = {}) => reply(status, { error: { message, status }, ...extra });
const digits = value => String(value ?? '').replace(/\D/g, '');
const intEnv = (value, fallback) => { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback; };

export const phoneHash = phone => crypto.createHash('sha256').update(`${HASH_SALT}:${digits(phone)}`).digest('hex');
export const kstDate = nowMs => new Date(nowMs + 9 * 3600000).toISOString().slice(0, 10);
export const kstHour = nowMs => new Date(nowMs + 9 * 3600000).getUTCHours();
export const addDays = (date, n) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const inSendWindow = nowMs => { const h = kstHour(nowMs); return h >= SEND_WINDOW.from && h < SEND_WINDOW.to; };

export function autoSettings(env = process.env) {
  return { on: env.SMS_AUTO !== 'off', maxPerDay: intEnv(env.SMS_AUTO_MAX_PER_DAY, DEFAULT_MAX_PER_DAY) };
}

// 광고 형식: '' | 'no_ad_prefix' | 'no_optout_080' (본체는 smsTextTemplates.adCheck 로 옮김 — 가입·문의 광고 저장과 공용, 2026-11-26)
export { adCheck };
// 연쇄 발송 문구(auto_chain.plain)는 Make 와 같게 광고 형식((광고)·080)을 요구하지 않는다(2026-11-18). 없으면 종전 adCheck 그대로.
const adCheckOf = template => (template.auto_chain?.plain ? '' : adCheck(template.body));
const subjectOf = template => (template.auto_chain?.subject ? { subject: template.auto_chain.subject } : {}); // 연쇄 문구의 문자 제목(없으면 종전처럼 싣지 않는다)
const optoutLineOf = body => String(body ?? '').split('\n').map(line => line.trim()).find(line => OPTOUT_LINE_RE.test(line)) || '';

const cleanName = value => {
  const name = String(value ?? '').replace(/#\{|\}/g, '').replace(/\s+/g, ' ').trim().slice(0, 20);
  return name || '고객';
};
const fillName = (body, name) => String(body).replace(/#\{고객명\}/g, cleanName(name));

// 통 구성(MMS 1통에 사진 1장): 사진 2장 이상이면 사진 N통 + 본문 1통, 사진 1장이면 사진+본문 1통, 사진이 없으면 본문만 1통.
export function buildParts(template, imageCount) {
  // 2026-11-16 사장님 "이미지 순서에 맞게 날라오고 그리고 본문이 날라와야지", "아니 이미지먼저보내고 본문 보낼 수 없니":
  // 사진이 2장 이상이면 사진을 등록 순서대로 한 통씩 먼저 보내고, 본문은 맨 끝에 글만 한 통으로 한 번 보낸다.
  // 사진이 1장이면 종전대로 사진+본문 1통, 사진이 없으면 본문만 1통.
  // 사진 통의 글: 쏠라피가 글 없는 사진 문자를 거절한다(1010 text 필수, 2026-11-16 실측). 그래서 광고 표기와 수신거부 한 줄만 붙인다.
  if (imageCount < 2) return [{ index: 0, image: imageCount > 0 ? 0 : -1, short: false, text: null }];
  const tail = optoutLineOf(template.body);
  const shortText = `(광고) 한성쇼케이스${tail ? `\n${tail}` : ''}`;
  const photos = Array.from({ length: imageCount }, (_, i) => ({ index: i, image: i, short: true, text: shortText }));
  return [...photos, { index: imageCount, image: -1, short: false, text: null }];
}
const partText = (part, template, name) => (part.short ? part.text : fillName(String(template.body).trim(), name));

async function loadTemplate(db, id) {
  await ensureTextTemplateSchema(db);
  await ensureEventSchema(db); // auto_skip_reason 칸을 쓰기 위해(광고 문자도 건너뜀 사유를 남긴다)
  const out = await db.execute({
    sql: 'SELECT id, name, body, image, images, auto_kind, auto_days, auto_enabled, auto_start_date, auto_send_from, auto_repeat, auto_interval, auto_offset, auto_unless_step, auto_audience, auto_staff, auto_msg_type, auto_step, auto_enabled_at, auto_daily, auto_weekdays, auto_unless_mode, auto_ata_template, auto_send_time, auto_copy_to, auto_catchup_from, auto_catchup_at, auto_catchup_daily, auto_catchup_done_at, auto_catchup_paused_at, auto_catchup_error, auto_ata_fail_at, auto_bms, auto_skip_reason, auto_chain, auto_lead_source FROM sms_text_templates WHERE id = ?',
    args: [id],
  });
  const row = out.rows?.[0];
  if (!row) return null;
  return {
    auto_skip_reason: row.auto_skip_reason || '', auto_bms: row.auto_bms || '', auto_chain: parseAutoChain(row.auto_chain), id: Number(row.id), name: row.name, body: row.body, images: storedImages(row), auto_kind: row.auto_kind || '', auto_days: Number(row.auto_days) || 0, auto_enabled: row.auto_enabled === true, auto_start_date: row.auto_start_date || '',
    auto_send_from: row.auto_send_from || '', auto_repeat: Number(row.auto_repeat) || AUTO_LIMITS.defaultRepeat, auto_interval: Number(row.auto_interval) || AUTO_LIMITS.defaultInterval,
    auto_offset: Number(row.auto_offset) || 0, auto_unless_step: row.auto_unless_step || '', auto_audience: ['staff', 'sales'].includes(row.auto_audience) ? row.auto_audience : 'customer',
    auto_daily: row.auto_daily || '', auto_weekdays: row.auto_weekdays === true, auto_unless_mode: row.auto_unless_mode === 'started' ? 'started' : 'completed',
    auto_staff: parseStaffIds(row.auto_staff), auto_msg_type: row.auto_msg_type === 'info' ? 'info' : 'ad',
    auto_step: row.auto_step || '', auto_enabled_at: row.auto_enabled_at ? new Date(row.auto_enabled_at).toISOString() : '', auto_send_time: row.auto_send_time || '', auto_copy_to: row.auto_copy_to || '', auto_ata_template: row.auto_ata_template || '', auto_lead_source: row.auto_lead_source || '',
    auto_catchup_from: row.auto_catchup_from || '', auto_catchup_at: row.auto_catchup_at || '', auto_catchup_daily: Number(row.auto_catchup_daily) > 0 ? Number(row.auto_catchup_daily) : 0, auto_catchup_done: Boolean(row.auto_catchup_done_at),
    auto_catchup_paused: Boolean(row.auto_catchup_paused_at), auto_catchup_error: row.auto_catchup_error || '', auto_ata_fail_at: row.auto_ata_fail_at ? new Date(row.auto_ata_fail_at).toISOString() : '',
  };
}

// 대상 조회: orders 읽기 전용 SELECT 1개. 기준일(출고 완료일 또는 주문 등록일)로부터 days 일이 된 날부터 3일 전 기준일분까지, 시작일 이후 기준일분만.
// kind: 'ship_plus_days'(status shipped 의 ship_date, 기본) | 'order_plus_days'(order_date, 상태 조건 없음)
export async function findTargets(db, { nowMs, days, startDate, kind = AUTO_KIND, step = '' }) {
  const today = kstDate(nowMs);
  const upper = addDays(today, -days);
  let lower = addDays(upper, -CATCH_UP_DAYS);
  if (startDate && startDate > lower) lower = startDate;
  if (lower > upper) return [];
  if (isProcessPlusKind(kind)) return processDateTargets(db, { step, column: kind === AUTO_KIND_PROCESS_COMPLETED ? 'completed_at' : 'started_at', lower, upper });
  const out = await db.execute({
    sql: kind === 'order_plus_days'
      ? `SELECT id, phone, client_name, LEFT(order_date, 10) AS ship_day FROM orders
          WHERE order_date IS NOT NULL AND COALESCE(status, '') <> 'cancelled' AND LEFT(order_date, 10) >= ? AND LEFT(order_date, 10) <= ?
          ORDER BY order_date ASC, id ASC LIMIT ${TARGET_LIMIT}`
      : `SELECT id, phone, client_name, LEFT(ship_date, 10) AS ship_day FROM orders
          WHERE status = 'shipped' AND ship_date IS NOT NULL AND LEFT(ship_date, 10) >= ? AND LEFT(ship_date, 10) <= ?
          ORDER BY ship_date ASC, id ASC LIMIT ${TARGET_LIMIT}`,
    args: [lower, upper],
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

// 공정 시작·완료 후 N일: 기준일 = 공정(step) started_at 또는 completed_at(UTC ISO)의 KST 날짜. 취소 주문·전화 없음(TARGET_RE) 제외.
// 날짜 칸은 TEXT(UTC ISO)라 ISO 형식만 보고, KST 날짜 경계는 아래에서 JS 로 정확히 거른다.
const ISO_RE = '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}[.0-9]*Z$'; // SQL 안에 ? 를 쓰지 않는다(db.js 가 ? 를 모두 자리표시자로 바꾼다)
async function processDateTargets(db, { step, column, lower, upper }) {
  if (!STEPS.includes(step)) return [];
  const col = column === 'completed_at' ? 'completed_at' : 'started_at';
  const fromIso = new Date(Date.parse(`${lower}T00:00:00Z`) - 9 * 3600000).toISOString(); // lower 00:00 KST
  const toIso = new Date(Date.parse(`${addDays(upper, 1)}T00:00:00Z`) - 9 * 3600000).toISOString(); // upper 다음 날 00:00 KST(미포함)
  const out = await db.execute({
    sql: `SELECT o.id AS id, o.phone AS phone, o.client_name AS client_name, p.${col} AS target_at FROM processes p JOIN orders o ON o.id = p.order_id
      WHERE p.step_name = ? AND p.${col} IS NOT NULL AND p.${col} ~ '${ISO_RE}' AND p.${col} >= ? AND p.${col} < ? AND COALESCE(o.status, '') <> 'cancelled'
      ORDER BY p.${col} ASC, o.id ASC LIMIT ${TARGET_LIMIT}`,
    args: [step, fromIso, toIso],
  });
  const seen = new Set();
  const targets = [];
  for (const row of out.rows || []) {
    const targetMs = Date.parse(row.target_at ?? row[col]);
    if (!Number.isFinite(targetMs)) continue;
    const day = kstDate(targetMs);
    if (day < lower || day > upper) continue;
    const phone = digits(row.phone);
    if (!TARGET_RE.test(phone) || seen.has(phone)) continue;
    seen.add(phone);
    targets.push({ orderId: Number(row.id), phone, name: row.client_name, shipDate: day });
  }
  return targets;
}

// 오늘 나간 브랜드메시지(광고) 번호의 해시(sms_event_sends 쪽 해시). 광고 문자와 브랜드메시지가 같은 날 한 사람에게 겹치지 않게 한다. 조회가 안 되면 빈 집합(종전 동작).
async function todayBmsHashes(db, today) {
  try {
    await ensureEventSchema(db);
    const rows = (await db.execute({ sql: `SELECT DISTINCT e.phone_hash FROM sms_event_sends e JOIN sms_text_templates t ON t.id = e.template_id WHERE e.kst_date = ? AND e.status <> 'failed' AND t.auto_ata_template = '${BMS_TEMPLATE_ID}'`, args: [today] })).rows || [];
    return new Set(rows.map(row => row.phone_hash));
  } catch { console.error('[sms-auto] 오늘 브랜드메시지 번호 조회 실패'); return new Set(); }
}

// 연쇄 발송: 오늘 앞 문구(afterId)가 'sent' 로 나간 번호의 해시(실패·불확실은 제외). 이벤트·자동 두 기록 표 모두 본다. 조회가 안 되면 빈 집합 = 아무에게도 보내지 않는다(안전 쪽).
async function chainReceivedHashes(db, afterId, today) {
  const out = { event: new Set(), auto: new Set() };
  try {
    await ensureEventSchema(db);
    for (const row of (await db.execute({ sql: "SELECT DISTINCT phone_hash FROM sms_event_sends WHERE template_id = ? AND kst_date = ? AND status = 'sent'", args: [afterId, today] })).rows || []) out.event.add(row.phone_hash);
    for (const row of (await db.execute({ sql: "SELECT DISTINCT phone_hash FROM sms_auto_sends WHERE template_id = ? AND kst_date = ? AND status = 'sent'", args: [afterId, today] })).rows || []) out.auto.add(row.phone_hash);
  } catch { console.error('[sms-auto] 연쇄 앞 문구 수신 번호 조회 실패'); return { event: new Set(), auto: new Set() }; }
  return out;
}

// 수신거부·이미 보낸(선점한) 번호·주문(회차별)·오늘 이미 나간 번호를 뺀 오늘 대상. 모든 회차를 한 목록으로 합친다.
// 회차 r(1..repeat)의 예정일 = 기준일 + days + (r−1)×interval. r≥2 는 같은 문구·같은 번호의 r−1 이 'sent' 일 때만.
// 번호당 1건(낮은 회차 우선), 결과는 예정일이 오래된 순. auto_send_from 전이면 대상 없음.
async function eligibleTargets(db, template, { nowMs, startDate }) {
  const today = kstDate(nowMs);
  if (template.auto_send_from && today < template.auto_send_from) return [];
  const kind = template.auto_kind || AUTO_KIND;
  const repeat = Math.max(1, Math.min(AUTO_LIMITS.repeatMax, Number(template.auto_repeat) || 1));
  const interval = Number(template.auto_interval) || AUTO_LIMITS.defaultInterval;
  const claimed = ((await db.execute({ sql: 'SELECT phone_hash, order_id, round, status, kst_date FROM sms_auto_sends WHERE template_id = ?', args: [template.id] })).rows || []).filter(row => row.status !== 'failed'); // 접수 0건 통째 실패('failed')는 선점으로 치지 않는다 → 다시 대상이 된다(2026-11-18 사장님 결정)
  const roundOf = row => Number(row.round) || 1;
  const claimedHash = new Set(claimed.map(row => `${row.phone_hash}|${roundOf(row)}`));
  const claimedOrder = new Set(claimed.map(row => `${Number(row.order_id)}|${roundOf(row)}`));
  const sentHash = new Set(claimed.filter(row => row.status === 'sent').map(row => `${row.phone_hash}|${roundOf(row)}`));
  const sentRounds = new Set(claimed.filter(row => row.status === 'sent').map(roundOf));
  const repeatTracked = kind === AUTO_KIND || isProcessPlusKind(kind); // 출고·공정 후 반복 문구: 번호별 이 문구의 가장 최근 기록일(failed 제외)
  const lastByHash = new Map();
  if (repeatTracked) for (const row of claimed) { const d = String(row.kst_date || '').slice(0, 10); if (d && (!lastByHash.has(row.phone_hash) || d > lastByHash.get(row.phone_hash))) lastByHash.set(row.phone_hash, d); }
  const recentLimit = addDays(today, -Math.floor(interval / 2));
  const raw = [];
  for (let round = 1; round <= repeat; round += 1) {
    if (round > 1 && !sentRounds.has(round - 1)) continue; // 앞 회차가 나간 적이 없으면 이 회차는 조회하지 않는다
    const shift = (round - 1) * interval;
    for (const t of await findTargets(db, { nowMs, days: template.auto_days + shift, startDate, kind, step: template.auto_step })) {
      raw.push({ ...t, round, due: addDays(t.shipDate, template.auto_days + shift) });
    }
  }
  if (!raw.length) return [];
  const optouts = new Set(((await db.execute({ sql: 'SELECT phone_hash FROM sms_optouts', args: [] })).rows || []).map(row => row.phone_hash));
  const todayHash = new Set(((await db.execute({ sql: "SELECT DISTINCT phone_hash FROM sms_auto_sends WHERE kst_date = ? AND status <> 'failed'", args: [today] })).rows || []).map(row => row.phone_hash));
  const chain = template.auto_chain;
  const plainAd = Boolean(chain?.after || chain?.plain); // 연쇄·plain 문구는 광고 하루 1통 규칙을 적용하지 않는다(Make 와 같게)
  const bmsToday = plainAd ? new Set() : await todayBmsHashes(db, today); // 오늘 브랜드메시지(광고)가 나간 번호는 광고 문자를 보내지 않는다(광고 하루 1통). 연쇄 문구는 반대로 앞 문구를 받은 번호에만 나간다.
  const chainOk = chain?.after ? await chainReceivedHashes(db, chain.after, today) : null; // after 가 없으면 연쇄 판정을 하지 않는다
  const free = raw.filter(t => {
    const hash = phoneHash(t.phone);
    t.hash = hash;
    if (chain?.after) { if (optouts.has(hash) || !(chainOk.event.has(eventPhoneHash(t.phone)) || chainOk.auto.has(hash))) return false; }
    else if (optouts.has(hash) || (!plainAd && todayHash.has(hash)) || bmsToday.has(eventPhoneHash(t.phone))) return false;
    if (claimedHash.has(`${hash}|${t.round}`) || claimedOrder.has(`${t.orderId}|${t.round}`)) return false;
    if (repeatTracked && t.round === 1 && lastByHash.has(hash)) return false; // 2026-11-19 이틀 연속 발송 3건: 일괄 발송·기준 전환과 새 주문 1회차가 겹침 → 이 문구를 받은 번호는 새 주문 1회차를 받지 않는다
    if (repeatTracked && lastByHash.has(hash) && lastByHash.get(hash) > recentLimit) return false; // 2026-11-19 이틀 연속 발송 3건: 최근 기록이 간격의 절반 안이면 어느 회차든 보내지 않는다
    return t.round === 1 || sentHash.has(`${hash}|${t.round - 1}`);
  });
  const byPhone = new Map();
  for (const t of [...free].sort((a, b) => a.round - b.round || (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || a.orderId - b.orderId)) {
    if (!byPhone.has(t.hash)) byPhone.set(t.hash, t);
  }
  return [...byPhone.values()].sort((a, b) => (a.due < b.due ? -1 : a.due > b.due ? 1 : 0) || a.round - b.round || a.orderId - b.orderId);
}

const placeholders = list => list.map(() => '?').join(', ');

// 광고 문자 일괄 발송(이미 출고된 주문 한 번 보내기): 출고일이 [시작일, 오늘 − days] 인 출고 완료 주문의 번호(번호당 최근 출고 1건).
// 수신거부·오늘 이미 나간 번호·이 문구로 행이 하나라도 있는 번호/주문·이번 실행의 평소 대상 번호는 뺀다.
// 회차 = 예정일이 이미 지났거나 간격의 절반 안에 닥칠 회차까지를 이번 1통으로 친다(다음 회차는 그 뒤 예정일에 평소 규칙대로).
async function adCatchupTargets(db, template, { nowMs, skipHashes }) {
  const today = kstDate(nowMs);
  const upper = addDays(today, -template.auto_days);
  if (template.auto_catchup_from > upper) return [];
  const out = await db.execute({
    sql: `SELECT id, phone, client_name, LEFT(ship_date, 10) AS ship_day FROM orders
      WHERE status = 'shipped' AND ship_date IS NOT NULL AND LEFT(ship_date, 10) >= ? AND LEFT(ship_date, 10) <= ?
      ORDER BY ship_date DESC, id DESC LIMIT ${AD_CATCHUP_LIMIT}`,
    args: [template.auto_catchup_from, upper],
  });
  const claimed = (await db.execute({ sql: "SELECT phone_hash, order_id FROM sms_auto_sends WHERE template_id = ? AND status <> 'failed'", args: [template.id] })).rows || []; // 통째 실패 행은 선점으로 치지 않는다
  const claimedHash = new Set(claimed.map(row => row.phone_hash));
  const claimedOrder = new Set(claimed.map(row => Number(row.order_id)));
  const optouts = new Set(((await db.execute({ sql: 'SELECT phone_hash FROM sms_optouts', args: [] })).rows || []).map(row => row.phone_hash));
  const todayHash = new Set(((await db.execute({ sql: "SELECT DISTINCT phone_hash FROM sms_auto_sends WHERE kst_date = ? AND status <> 'failed'", args: [today] })).rows || []).map(row => row.phone_hash));
  const bmsToday = await todayBmsHashes(db, today);
  const repeat = Math.max(1, Math.min(AUTO_LIMITS.repeatMax, Number(template.auto_repeat) || 1));
  const interval = Number(template.auto_interval) || AUTO_LIMITS.defaultInterval;
  const seen = new Set();
  const targets = [];
  for (const row of out.rows || []) {
    const phone = digits(row.phone);
    if (!TARGET_RE.test(phone) || seen.has(phone)) continue;
    seen.add(phone); // 번호당 첫 1건(최근 출고)만 본다
    const hash = phoneHash(phone);
    if (optouts.has(hash) || todayHash.has(hash) || claimedHash.has(hash) || claimedOrder.has(Number(row.id)) || skipHashes.has(hash) || bmsToday.has(eventPhoneHash(phone))) continue;
    const age = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${row.ship_day}T00:00:00Z`)) / DAY_MS);
    const round = Math.max(1, Math.min(repeat, Math.floor((age - template.auto_days + Math.floor(interval / 2)) / interval) + 1));
    targets.push({ orderId: Number(row.id), phone, name: row.client_name, shipDate: row.ship_day, hash, round, catchup: true });
  }
  return targets;
}

// ---- 자동 발송 1개 문구 실행(설계 3절 ①~⑧ 순서 그대로) ----
// deadline: runAutoSendAll 이 만든 전체 마감 시각(tick 기준). 없으면(단독 실행) 이 문구만 TIME_BUDGET_MS.
export async function runAutoSend(template, { db, provider, env = process.env, nowMs = Date.now(), fetchImpl, tick = Date.now, deadline, sleep, kakao, kakaoOpts } = {}) {
  const startedAt = tick();
  const shared = typeof deadline === 'number';
  const endAt = shared ? deadline : startedAt + TIME_BUDGET_MS;
  const timeShort = () => shared && endAt - tick() < SEND_RESERVE_MS;
  if (template.auto_msg_type === 'info' || isDayAta(template) || isLeadKind(template.auto_kind)) return runEventSend(template, { db, provider, env, nowMs, fetchImpl, tick, deadline, sleep, kakao, kakaoOpts }); // 안내 문구는 새 모듈
  const out = { template_id: template.id, ran: false, reason: '', targets: 0, claimed: 0, sent: 0, failed: 0, uncertain: 0 };
  const settings = autoSettings(env);
  if (!template.auto_enabled || !settings.on) return { ...out, reason: 'off' }; // ①
  if (!inSendWindow(nowMs)) return { ...out, reason: 'night' }; // ② 선점도 하지 않는다
  const blocked = adCheckOf(template); // ③
  if (blocked) return { ...out, reason: blocked };
  if (!isAutoKind(template.auto_kind) || !daysOk(template)) return { ...out, reason: 'no_auto' };
  if (isProcessPlusKind(template.auto_kind) && !STEPS.includes(template.auto_step)) return { ...out, reason: 'no_step' }; // 공정 시작·완료 후 N일은 공정이 있어야 한다

  const vendor = provider || getSendProvider();
  const from = digits(template.auto_chain?.from) || digits(env.SMS_SENDER); // 연쇄 문구는 자기 발신번호(Make 와 같게)
  if (!vendor || typeof vendor.sendEach !== 'function' || !from) return { ...out, reason: 'no_provider' };
  if (!provider && !hasSolapiCredentials()) return { ...out, reason: 'no_provider' };
  if (template.auto_ata_fail_at && Date.parse(template.auto_ata_fail_at) > nowMs) return { ...out, reason: 'ata_backoff' }; // 통째 실패가 이어지면 1시간 쉰다(성공하면 지움)
  if (template.auto_skip_reason) { try { await db.execute({ sql: 'UPDATE sms_text_templates SET auto_skip_reason = NULL WHERE id = ? RETURNING id', args: [template.id] }); } catch { console.error('[sms-auto] 건너뜀 사유 지우기 실패'); } } // 업체 확인을 통과했으면 지난 사유를 지우고, 아래에서 다시 막히면 다시 적는다

  await ensureAutoSchema(db);
  const today = kstDate(nowMs);
  const eligible = await eligibleTargets(db, template, { nowMs, startDate: template.auto_start_date }); // ④
  let catchupList = []; // 이미 출고된 주문 한 번 보내기(일괄 발송): 설정이 있고 시각이 됐을 때만 조회한다
  if (!template.auto_chain && catchupActive({ ...template, auto_ata_template: 'ad' }, nowMs)) { // 광고 문구는 알림톡 칸이 비어 있어 같은 판정을 쓰려고 칸만 채워 넘긴다
    catchupList = await adCatchupTargets(db, template, { nowMs, skipHashes: new Set(eligible.map(t => t.hash)) });
    if (!catchupList.length) {
      try { await db.execute({ sql: 'UPDATE sms_text_templates SET auto_catchup_done_at = NOW() WHERE id = ? AND auto_catchup_done_at IS NULL RETURNING id', args: [template.id] }); } catch { console.error('[sms-auto] 일괄 발송 완료 표시 실패'); }
    }
  }
  out.targets = eligible.length;
  if (!eligible.length && !catchupList.length) return { ...out, ran: true };

  const usedToday = eligible.length ? Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM sms_auto_sends WHERE kst_date = ? AND COALESCE(kind, '') <> 'catchup'", args: [today] })).rows?.[0]?.n) || 0 : 0; // ⑤ 평소 상한은 일괄 발송분을 세지 않는다
  const room = Math.max(0, settings.maxPerDay - usedToday);
  const picked = eligible.slice(0, room);
  let catchupPicked = [];
  if (catchupList.length) { // 일괄 발송분은 자기 하루 상한과 실행 1번 30건 중 작은 쪽까지
    const catchupUsed = Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM sms_auto_sends WHERE kst_date = ? AND kind = 'catchup'", args: [today] })).rows?.[0]?.n) || 0;
    const ownCap = Number(template.auto_catchup_daily) > 0 ? catchupDailyCap(template.auto_catchup_daily, env) : 0; // 문구별 하루 최대(없으면 0 = 전역 상한만)
    const ownUsed = ownCap ? Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM sms_auto_sends WHERE kst_date = ? AND kind = 'catchup' AND template_id = ?", args: [today, template.id] })).rows?.[0]?.n) || 0 : 0;
    catchupPicked = catchupList.slice(0, Math.max(0, Math.min(AD_CATCHUP_PER_RUN, catchupMaxPerDay(env) - catchupUsed, ownCap ? ownCap - ownUsed : Infinity)));
  }
  if (!picked.length && !catchupPicked.length) { // 하루 상한에 막힘: 사유를 남겨 화면이 '막힘'으로 보이게 한다
    await noteSkip(db, template, `하루 상한 ${eligible.length ? settings.maxPerDay : catchupMaxPerDay(env)}건 도달, 남은 ${eligible.length + catchupList.length}건 다음 날`);
    return { ...out, ran: true, reason: 'cap' };
  }
  const sendList = [...picked, ...catchupPicked];

  const parts = buildParts(template, template.images.length);
  if (multiPartTimeShort(parts.length, endAt - tick(), env)) return { ...out, ran: true, reason: 'time' }; // 여러 통은 끝까지 나갈 시간이 모자라면 선점 전에 통째로 다음 실행으로
  if (timeShort()) return { ...out, ran: true, reason: 'time' }; // 전체 마감이 가까우면 사진 올리기·선점 없이 끝
  let need = NaN; // 선점 전 잔액 확인(알림톡·브랜드메시지와 같은 방식): 모자라면 선점 없이 끝내고 사유를 남긴다. 조회 실패·단가 모름은 종전대로 보낸다.
  try { if (typeof vendor.estimate === 'function') need = costOf(vendor, parts, sendList.length, env); } catch { need = NaN; }
  const short = await balanceShortFor(need, { kakao, kakaoOpts, fetchImpl });
  if (short) {
    if (catchupPicked.length) { try { await db.execute({ sql: 'UPDATE sms_text_templates SET auto_catchup_paused_at = NOW(), auto_catchup_error = ? WHERE id = ? RETURNING id', args: [short.why, template.id] }); } catch { console.error('[sms-auto] 일괄 발송 멈춤 표시 실패'); } }
    await noteSkip(db, template, short.why);
    return { ...out, ran: true, reason: 'balance_short' };
  }
  const fileIds = []; // ⑥ 사진 올리기: 장당 1번(받는 사람 수와 무관), 하나라도 실패하면 선점 없이 끝
  for (const base64 of template.images) {
    let fileId = '';
    try { fileId = (await vendor.uploadImage({ base64, name: 'photo.jpg' }, { fetchImpl }))?.fileId || ''; } catch { fileId = ''; }
    if (!fileId) return { ...out, ran: true, reason: 'upload_failed' };
    fileIds.push(fileId);
  }

  // ⑦ 선점: 여러 행 INSERT 1번. 돌아온 행만 보낸다. (회차 round 포함, 모든 회차 대상을 한 번에)
  if (timeShort()) return { ...out, ran: true, reason: 'time' };
  // 이전에 통째 실패('failed')로 남은 행도 유일 인덱스를 잡고 있으므로, 다시 보낼 번호·주문의 실패 행만 먼저 지운다(2026-11-18 사장님 결정: 접수 0건 실패는 다시 대상). 그 실행의 실패 사유는 건너뜀 사유에 남아 있다.
  await db.execute({ sql: `DELETE FROM sms_auto_sends WHERE template_id = ? AND status = 'failed' AND (phone_hash IN (${placeholders(sendList)}) OR order_id IN (${placeholders(sendList)}))`, args: [template.id, ...sendList.map(t => t.hash), ...sendList.map(t => t.orderId)] });
  const withKind = catchupPicked.length > 0; // 일괄 항목이 섞였을 때만 kind 칸을 넣는다(평소 항목은 NULL)
  const values = sendList.map(t => (withKind ? `(?, ?, ?, ?, ?, ?, 'claimed', ?, ${t.catchup ? "'catchup'" : 'NULL'})` : "(?, ?, ?, ?, ?, ?, 'claimed', ?)")).join(', ');
  const claimArgs = sendList.flatMap(t => [template.id, t.hash, t.phone.slice(-4), t.orderId, t.shipDate, today, t.round]);
  const claimedRows = (await db.execute({
    sql: `INSERT INTO sms_auto_sends (template_id, phone_hash, phone_last4, order_id, ship_date, kst_date, status, round${withKind ? ', kind' : ''}) VALUES ${values} ON CONFLICT DO NOTHING RETURNING id, phone_hash, round`,
    args: claimArgs,
  })).rows || [];
  const byHash = new Map(sendList.map(t => [t.hash, t]));
  let active = claimedRows.map(row => ({ id: Number(row.id), target: byHash.get(row.phone_hash) })).filter(item => item.target);
  // 크론이 겹쳐 돌았을 때: 선점 뒤 오늘 합계가 상한을 넘으면 넘은 행은 지우고 보내지 않는다.
  // 평소 항목과 일괄 항목은 따로 센다(일괄 항목은 하루 catchupMaxPerDay).
  const trim = async (group, after, limit) => {
    if (after <= limit) return;
    const drop = group.slice(group.length - Math.min(group.length, after - limit));
    if (!drop.length) return;
    await db.execute({ sql: `DELETE FROM sms_auto_sends WHERE status = 'claimed' AND id IN (${placeholders(drop)})`, args: drop.map(item => item.id) });
    active = active.filter(item => !drop.includes(item));
  };
  const after = Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM sms_auto_sends WHERE kst_date = ? AND COALESCE(kind, '') <> 'catchup'", args: [today] })).rows?.[0]?.n) || 0;
  await trim(active.filter(item => !item.target.catchup), after, settings.maxPerDay);
  if (active.some(item => item.target.catchup)) {
    const afterCatchup = Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM sms_auto_sends WHERE kst_date = ? AND kind = 'catchup'", args: [today] })).rows?.[0]?.n) || 0;
    await trim(active.filter(item => item.target.catchup), afterCatchup, catchupMaxPerDay(env));
    if (Number(template.auto_catchup_daily) > 0) {
      const afterOwn = Number((await db.execute({ sql: "SELECT COUNT(*) AS n FROM sms_auto_sends WHERE kst_date = ? AND kind = 'catchup' AND template_id = ?", args: [today, template.id] })).rows?.[0]?.n) || 0;
      await trim(active.filter(item => item.target.catchup), afterOwn, catchupDailyCap(template.auto_catchup_daily, env));
    }
  }
  out.claimed = active.length;
  out.ran = true;
  if (!active.length) return out;

  // ⑧ 통별 발송. 어느 통이든 깨끗한 성공이 아니면 그 뒤 통은 보내지 않는다(모두 같은 결과를 갖는다).
  const partStatus = [];
  const groupIds = [];
  let reason = '';
  let stop = false;
  for (const [partIndex, part] of parts.entries()) {
    if (stop) { partStatus.push('skipped'); continue; }
    await waitBeforePart(partIndex, { env, sleep }); // 앞 통이 먼저 도착하게 통 사이에 기다린다(마감 검사는 그 뒤)
    if (tick() >= endAt) { partStatus.push('skipped'); stop = true; reason = '시간 초과'; continue; }
    const messages = active.map(item => {
      const message = { to: item.target.phone, text: partText(part, template, item.target.name), ...subjectOf(template) };
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
  const wholeFail = status === 'failed'; // 첫 통이 접수 0건(통째 실패): 이 회차의 선점 행을 지워 다음 실행이 다시 보내게 한다. 사유는 건너뜀 사유에 남긴다(2026-11-18 사장님 결정)
  try {
    if (wholeFail) await db.execute({ sql: `DELETE FROM sms_auto_sends WHERE status = 'claimed' AND id IN (${placeholders(active)})`, args: active.map(item => item.id) });
    else await db.execute({
      sql: `UPDATE sms_auto_sends SET status = ?, part_status = ?, reason = ?, group_ids = ? WHERE id IN (${placeholders(active)})`,
      args: [status, JSON.stringify(partStatus), reason || null, JSON.stringify(groupIds), ...active.map(item => item.id)],
    });
  } catch { /* 기록 실패가 이미 끝난 발송 결과를 막지 않는다. 행은 claimed 로 남아 다음 실행이 uncertain 으로 바꾼다. */ }
  if (wholeFail) {
    await noteSkip(db, template, `발송 실패: ${String(reason || '거절').slice(0, 150)}`);
    try { await db.execute({ sql: "UPDATE sms_text_templates SET auto_ata_fail_at = CASE WHEN auto_ata_fail_at IS NULL THEN NOW() ELSE NOW() + INTERVAL '1 hour' END WHERE id = ? RETURNING id", args: [template.id] }); } catch { console.error('[sms-auto] 실패 표시 실패'); }
  } else if (status === 'sent' && template.auto_ata_fail_at) {
    try { await db.execute({ sql: 'UPDATE sms_text_templates SET auto_ata_fail_at = NULL WHERE id = ? RETURNING id', args: [template.id] }); } catch { /* 다음 성공 때 다시 지운다 */ }
  }
  out[status] = active.length;
  const catchupActiveItems = active.filter(item => item.target.catchup);
  if (catchupActiveItems.length) { // 일괄 항목이 섞인 실행: 깨끗한 성공이 아니면 이 문구의 일괄 발송을 멈춘다(화면에서 다시 저장해야 이어진다). 평소 발송은 계속된다.
    out.catchup = status === 'sent' ? catchupActiveItems.length : 0;
    if (status !== 'sent') {
      try { await db.execute({ sql: 'UPDATE sms_text_templates SET auto_catchup_paused_at = NOW(), auto_catchup_error = ? WHERE id = ? RETURNING id', args: [String(reason || (status === 'failed' ? '거절' : '불확실')).slice(0, 200), template.id] }); } catch { console.error('[sms-auto] 일괄 발송 멈춤 표시 실패'); }
    }
  }
  if (out.sent >= 1 && template.auto_copy_to && !timeShort()) { // 관리자 확인 단문(18원): 고객 발송·기록이 끝난 뒤 하루 1통. 실패해도 위 결과는 그대로
    const copyStatus = await sendAdminCopySms({
      db,
      vendor,
      from,
      to: template.auto_copy_to,
      templateId: template.id,
      templateName: template.name,
      recipientNames: active.map(item => item.target.name),
      today,
      fetchImpl,
    });
    if (copyStatus) out.copy = copyStatus;
  }
  return out;
}

// 하루 지난 claimed(실행이 끊긴 것)는 uncertain 으로 바꾼다. 다시 보내지 않는다.
export async function sweepStaleClaims(db, nowMs) {
  await ensureAutoSchema(db);
  await db.execute({ sql: "UPDATE sms_auto_sends SET status = 'uncertain', reason = '실행이 끊김' WHERE status = 'claimed' AND kst_date < ?", args: [kstDate(nowMs)] });
}

// 크론: 켜진 자동 문구를 모두 실행. 결과는 건수만.
export async function runAutoSendAll(deps = {}) {
  const { db, nowMs = Date.now() } = deps;
  await ensureTextTemplateSchema(db);
  await sweepStaleClaims(db, nowMs);
  const list = await db.execute({ sql: "SELECT id FROM sms_text_templates WHERE auto_enabled = true AND auto_kind IN ('ship_plus_days', 'order_plus_days', 'process_started_plus_days', 'process_completed_plus_days') AND COALESCE(auto_send_time, '') = '' ORDER BY id ASC", args: [] });
  const total = { templates: 0, targets: 0, claimed: 0, sent: 0, failed: 0, uncertain: 0, skipped: 0 };
  const deadline = typeof deps.deadline === 'number' ? deps.deadline : (deps.tick || Date.now)() + TIME_BUDGET_MS; // 전체 마감 시각 하나를 문구마다 넘긴다
  for (const row of list.rows || []) {
    const template = await loadTemplate(db, Number(row.id));
    if (!template) continue;
    total.templates += 1;
    const result = await runGuarded(db, template, () => runAutoSend(template, { ...deps, deadline }), deps.warn); // 한 문구가 예외로 끝나도 다음 문구는 계속한다
    if (!result) { total.skipped += 1; continue; }
    if (result.reason && !result.ran) total.skipped += 1;
    for (const key of ['targets', 'claimed', 'sent', 'failed', 'uncertain']) total[key] += result[key];
  }
  return total;
}

// 발송 시각이 있는 날짜형 문구(출고·주문 후, 납기·출고예정일): 5분 크론이 그 시각부터 그날 21:00 전까지 실행한다(10:00 크론은 건너뜀).
// 가입·문의 후는 runInstantSendAll 이 문구의 시각을 보고 처리한다. 중복 방지(선점 키)·상한·밤 시간 창·마감 시각은 runAutoSend·runEventSend 그대로.
export async function runTimedSendAll(deps = {}) {
  const { db, nowMs = Date.now() } = deps;
  const total = { templates: 0, targets: 0, claimed: 0, sent: 0, failed: 0, uncertain: 0, skipped: 0 };
  if (kstMinutes(nowMs) < 9 * 60) return total; // 가장 이른 시각(09:00) 전에는 조회도 하지 않는다
  await ensureTextTemplateSchema(db);
  const list = await db.execute({ sql: "SELECT id, auto_kind, auto_send_time FROM sms_text_templates WHERE auto_enabled = true AND auto_kind IN ('ship_plus_days', 'order_plus_days', 'process_started_plus_days', 'process_completed_plus_days', 'due_date', 'ship_scheduled', 'ship_or_due') AND COALESCE(auto_send_time, '') <> '' ORDER BY id ASC", args: [] });
  const deadline = typeof deps.deadline === 'number' ? deps.deadline : (deps.tick || Date.now)() + TIME_BUDGET_MS;
  for (const row of list.rows || []) {
    if (!inTimedWindow(row.auto_send_time, nowMs)) continue;
    const template = isEventKind(row.auto_kind) ? await loadEventTemplate(db, Number(row.id)) : await loadTemplate(db, Number(row.id));
    if (!template) continue;
    total.templates += 1;
    const result = await runGuarded(db, template, () => (isEventKind(row.auto_kind) ? runEventSend(template, { ...deps, deadline }) : runAutoSend(template, { ...deps, deadline })), deps.warn);
    if (!result) { total.skipped += 1; continue; }
    if (result.reason && !result.ran) total.skipped += 1;
    for (const key of ['targets', 'claimed', 'sent', 'failed', 'uncertain']) total[key] += result[key];
  }
  return total;
}

// ---- 화면 자료 ----
export async function autoStatus(db, { id, nowMs = Date.now(), env = process.env } = {}) {
  const templateId = Number(id);
  if (!(Number.isInteger(templateId) && templateId > 0)) return errorReply(400, '올바른 문구가 아닙니다.');
  await ensureAutoSchema(db);
  const template = await loadTemplate(db, templateId);
  if (!template) return errorReply(404, '문구를 찾을 수 없습니다.');
  if (isInfoTemplate(template)) return eventStatus(db, template, { nowMs, env }); // 안내 문구는 새 모듈
  const today = kstDate(nowMs);
  const sums = (await db.execute({ sql: "SELECT status, COUNT(*) AS n, MAX(kst_date) AS last FROM sms_auto_sends WHERE template_id = ? AND COALESCE(reason, '') <> 'make_migrated' GROUP BY status", args: [templateId] })).rows || [];
  const count = status => Number(sums.find(row => row.status === status)?.n) || 0;
  const rows7 = (await db.execute({ sql: "SELECT status, COUNT(*) AS n FROM sms_auto_sends WHERE template_id = ? AND status IN ('sent', 'failed') AND kst_date >= ? GROUP BY status", args: [templateId, addDays(today, -6)] })).rows || [];
  const sent7 = Number(rows7.find(row => row.status === 'sent')?.n) || 0;
  const failed7 = Number(rows7.find(row => row.status === 'failed')?.n) || 0;
  let todayTargets = 0;
  if (isAutoKind(template.auto_kind) && daysOk(template)) {
    const startDate = template.auto_start_date || addDays(today, -template.auto_days);
    todayTargets = (await eligibleTargets(db, template, { nowMs, startDate })).length;
  }
  const reason = !isAutoKind(template.auto_kind) ? 'no_auto' : (isProcessPlusKind(template.auto_kind) && !STEPS.includes(template.auto_step) ? 'no_step' : adCheckOf(template));
  return reply(200, withEffective({
    enabled: template.auto_enabled && autoSettings(env).on, no_provider: !getSendProvider() || !hasSolapiCredentials(), ata_backoff: false, failed_7d: failed7, auto_skip_reason: template.auto_skip_reason || '', cron_last_run: await cronLastRun(db), days: template.auto_days, start_date: template.auto_start_date || '',
    today_targets: todayTargets, sent_7d: sent7, sent_total: count('sent'), failed_total: count('failed'), uncertain_total: count('uncertain') + count('claimed'),
    last_sent_date: sums.find(row => row.status === 'sent')?.last || '', enable_blocked_reason: reason,
    ...(template.auto_kind === AUTO_KIND && template.auto_catchup_at && template.auto_catchup_paused ? { catchup_paused: true, catchup_error: template.auto_catchup_error } : {}),
  }, nowMs));
}

// 여러 자동 발송 문구의 현황을 한 번에 조회한다(N+1 HTTP 왕복 제거).
export async function autoStatusBatch(db, { ids = [], nowMs = Date.now(), env = process.env } = {}) {
  await ensureAutoSchema(db);
  await ensureTextTemplateSchema(db);
  let targetIds = [...new Set((Array.isArray(ids) ? ids : []).map(Number).filter(n => Number.isInteger(n) && n > 0))].slice(0, 60);
  if (!targetIds.length) {
    const rows = (await db.execute({ sql: "SELECT id FROM sms_text_templates WHERE COALESCE(auto_kind, '') <> '' ORDER BY id ASC LIMIT 60", args: [] })).rows || [];
    targetIds = rows.map(row => Number(row.id)).filter(n => Number.isInteger(n) && n > 0);
  }
  const statuses = {};
  for (let i = 0; i < targetIds.length; i += 6) {
    const chunk = targetIds.slice(i, i + 6);
    const settled = await Promise.allSettled(chunk.map(id => autoStatus(db, { id, nowMs, env }).then(out => ({ id, out }))));
    for (const item of settled) {
      if (item.status === 'fulfilled' && item.value.out?.status === 200) {
        statuses[item.value.id] = item.value.out.body;
      }
    }
  }
  return reply(200, { statuses });
}

// action auto_mark_sent { template_id, phones[] }: Make 에서 넘어올 때 이미 보낸 번호를 '보냄'으로만 기록한다(실제 발송 없음).
// 기록 키는 그 문구 종류의 '발송 때 쓰는 dedupe 키'와 같은 형식이다(smsEventSend.js 의 dayCandidatesFor·expandItems 와 같은 규칙).
//   출고 후 N일 + 알림톡·브랜드메시지  → sms_event_sends '<해시>:ship'
//   주문 후 N일 + 알림톡·브랜드메시지  → sms_event_sends '<해시>:order'
//   주문 등록 시(order_created)         → sms_event_sends '<해시>:<주문번호>:order_created'  (주문 단위 키 — 번호만 받으므로 그 번호의 기존 주문들을 찾아 주문마다 1개씩 넣는다)
//   공정 시작 시(process_started)       → sms_event_sends '<해시>:<주문번호>:process_started' (그 번호의 주문 중 이 문구의 공정이 이미 시작된 주문만)
//   문자 갈래(출고·주문·공정 후 N일 문자·MMS·plain) → sms_auto_sends 회차 1(번호 해시 기준, 종전 그대로)
//   가입·문의 후 N일(lead_plus_days)·납기일 등 나머지 → 번호·주문 하나로 키를 만들 수 없으므로 거절(unsupported_kind)
// 이미 있으면 건너뛴다. kst_date 는 하루 상한·'오늘 받은 번호' 판정에 안 잡히게 옛 날짜(1970-01-01)로 둔다.
export const MARK_DATE = '1970-01-01';
const MARK_MAX = 5000;
const MARK_CHUNK = 200;
const MARK_ORDER_KINDS = Object.freeze(['order_created', 'process_started']);
// 번호 목록(숫자만) → 그 번호의 주문 번호들. 전화 칸에 하이픈이 섞여 있어도 숫자만 남겨 비교한다. process_started 는 문구의 공정이 이미 시작된 주문만.
async function ordersOfPhones(db, template, list) {
  const byPhone = new Map();
  const started = template.auto_kind === 'process_started';
  for (let i = 0; i < list.length; i += MARK_CHUNK) {
    const chunk = list.slice(i, i + MARK_CHUNK);
    const sql = started
      ? `SELECT DISTINCT o.id AS id, o.phone AS phone FROM orders o JOIN processes p ON p.order_id = o.id WHERE p.step_name = ? AND p.started_at IS NOT NULL AND regexp_replace(o.phone, '[^0-9]', '', 'g') IN (${placeholders(chunk)})`
      : `SELECT o.id AS id, o.phone AS phone FROM orders o WHERE regexp_replace(o.phone, '[^0-9]', '', 'g') IN (${placeholders(chunk)})`;
    for (const row of (await db.execute({ sql, args: started ? [template.auto_step, ...chunk] : chunk })).rows || []) {
      const phone = digits(row.phone);
      if (!byPhone.has(phone)) byPhone.set(phone, new Set());
      byPhone.get(phone).add(Number(row.id));
    }
  }
  return byPhone;
}
// 한 번만(once) 납기 문구: 주문 번호 목록으로 표시한다. 키 = 발송 후보 키와 같은 '<해시>:<주문번호>:<기준일(due_date)>' (smsEventSend.js dueMarkEntries).
async function markDueOrders(db, id, template, orderIds) {
  if (!(isEventKind(template.auto_kind) && template.auto_daily === 'once')) return reply(400, { ok: false, error: 'unsupported_kind', reason: 'unsupported_kind', kind: template.auto_kind });
  const ids = [...new Set(orderIds.map(Number))];
  if (!ids.length || ids.length > MARK_MAX || ids.some(n => !(Number.isInteger(n) && n > 0))) return errorReply(400, `주문 번호는 1~${MARK_MAX}개의 양의 정수로 보내 주세요.`);
  await ensureEventSchema(db);
  const { items, found } = await dueMarkEntries(db, template, ids);
  const entries = items.map(item => ({ phone: item.phone, hash: item.hash, key: item.key }));
  const { inserted, updatedFailed } = await insertMarks(db, id, entries);
  return reply(200, { ok: true, via: 'event', per_order: true, by_order_ids: true, requested: ids.length, no_order: ids.filter(n => !found.has(n)).length, keys: entries.length, inserted, updated_failed: updatedFailed, skipped: entries.length - inserted - updatedFailed });
}
async function insertMarks(db, id, entries) {
  let inserted = 0;
  let updatedFailed = 0;
  for (let i = 0; i < entries.length; i += MARK_CHUNK) {
    const chunk = entries.slice(i, i + MARK_CHUNK);
    const rows = (await db.execute({
      sql: `INSERT INTO sms_event_sends (template_id, dedupe_key, order_id, phone_hash, phone_last4, kst_date, status, reason) VALUES ${chunk.map(() => "(?, ?, NULL, ?, ?, ?, 'sent', 'make_migrated')").join(', ')} ON CONFLICT (template_id, dedupe_key) DO UPDATE SET status = 'sent', reason = 'make_migrated' WHERE sms_event_sends.status = 'failed' RETURNING id, (xmax = 0) AS fresh`,
      args: chunk.flatMap(entry => [id, entry.key, entry.hash, entry.phone.slice(-4), MARK_DATE]),
    })).rows || [];
    inserted += rows.filter(row => row.fresh !== false).length; updatedFailed += rows.filter(row => row.fresh === false).length;
  }
  return { inserted, updatedFailed };
}
export async function autoMarkSent(body, { db } = {}) {
  const id = Number(body?.template_id);
  if (!(Number.isInteger(id) && id > 0)) return errorReply(400, '올바른 문구가 아닙니다.');
  const byOrders = Array.isArray(body?.order_ids);
  if (!byOrders && (!Array.isArray(body?.phones) || !body.phones.length || body.phones.length > MARK_MAX)) return errorReply(400, `번호는 1~${MARK_MAX}개로 보내 주세요.`);
  const template = await loadTemplate(db, id);
  if (!template) return errorReply(404, '문구를 찾을 수 없습니다.');
  if (byOrders) return markDueOrders(db, id, template, body.order_ids);
  const viaDay = isDayAta(template); // 출고·주문 후 N일 + 알림톡·브랜드메시지는 안내 발송 경로(sms_event_sends)
  const viaOrder = !viaDay && MARK_ORDER_KINDS.includes(template.auto_kind) && template.auto_audience === 'customer'; // 즉시형(고객 수신)은 주문 단위 키
  const viaEvent = viaDay || viaOrder;
  if (!viaEvent && !isAutoKind(template.auto_kind)) {
    if (isInfoTemplate(template)) return reply(400, { ok: false, error: 'unsupported_kind', reason: 'unsupported_kind', kind: template.auto_kind });
    return errorReply(400, '출고·주문·공정 후 N일 문구만 쓸 수 있습니다.', { reason: 'no_auto' });
  }
  if (viaOrder && template.auto_kind === 'process_started' && !STEPS.includes(template.auto_step)) return errorReply(400, '공정을 골라야 합니다.', { reason: 'no_step' });
  const phones = new Map();
  let invalid = 0;
  for (const raw of body.phones) {
    const phone = digits(raw);
    if (!MOBILE_RE.test(phone)) { invalid += 1; continue; }
    phones.set(phone, true);
  }
  const list = [...phones.keys()];
  let inserted = 0;
  let updatedFailed = 0; // 실패 행이 있던 번호는 sent 로 고친다(실패 행이 '이미 보냄' 기록을 막지 않게)
  let noOrder = 0; // 주문 단위 키 문구에서 그 번호의 (해당) 주문이 하나도 없어 기록할 키가 없었던 번호 수
  let keyCount = list.length;
  if (viaEvent) {
    await ensureEventSchema(db);
    const entries = [];
    if (viaOrder) {
      const orders = await ordersOfPhones(db, template, list);
      for (const phone of list) {
        const ids = [...(orders.get(phone) || [])].sort((a, b) => a - b);
        if (!ids.length) { noOrder += 1; continue; }
        const hash = eventPhoneHash(phone);
        for (const orderId of ids) entries.push({ phone, hash, key: `${hash}:${orderId}:${template.auto_kind}` });
      }
    } else {
      const word = template.auto_kind === AUTO_KIND ? 'ship' : template.auto_kind === AUTO_KIND_PROCESS ? 'pstart' : template.auto_kind === AUTO_KIND_PROCESS_COMPLETED ? 'pdone' : 'order'; // smsEventSend.js dayWord 와 같은 규칙
      for (const phone of list) { const hash = eventPhoneHash(phone); entries.push({ phone, hash, key: `${hash}:${word}` }); }
    }
    keyCount = entries.length;
    for (let i = 0; i < entries.length; i += MARK_CHUNK) {
      const chunk = entries.slice(i, i + MARK_CHUNK);
      const rows = (await db.execute({
        sql: `INSERT INTO sms_event_sends (template_id, dedupe_key, order_id, phone_hash, phone_last4, kst_date, status, reason) VALUES ${chunk.map(() => "(?, ?, NULL, ?, ?, ?, 'sent', 'make_migrated')").join(', ')} ON CONFLICT (template_id, dedupe_key) DO UPDATE SET status = 'sent', reason = 'make_migrated' WHERE sms_event_sends.status = 'failed' RETURNING id, (xmax = 0) AS fresh`,
        args: chunk.flatMap(entry => [id, entry.key, entry.hash, entry.phone.slice(-4), MARK_DATE]),
      })).rows || [];
      inserted += rows.filter(row => row.fresh !== false).length; updatedFailed += rows.filter(row => row.fresh === false).length;
    }
  } else {
    await ensureAutoSchema(db);
    for (let i = 0; i < list.length; i += MARK_CHUNK) {
      const chunk = list.slice(i, i + MARK_CHUNK);
      const rows = (await db.execute({
        sql: `INSERT INTO sms_auto_sends (template_id, phone_hash, phone_last4, order_id, ship_date, kst_date, status, round, reason) VALUES ${chunk.map(() => "(?, ?, ?, NULL, NULL, ?, 'sent', 1, 'make_migrated')").join(', ')} ON CONFLICT (template_id, phone_hash, round) DO UPDATE SET status = 'sent', reason = 'make_migrated' WHERE sms_auto_sends.status = 'failed' RETURNING id, (xmax = 0) AS fresh`,
        args: chunk.flatMap(phone => [id, phoneHash(phone), phone.slice(-4), MARK_DATE]),
      })).rows || [];
      inserted += rows.filter(row => row.fresh !== false).length; updatedFailed += rows.filter(row => row.fresh === false).length;
    }
  }
  return reply(200, { ok: true, via: viaEvent ? 'event' : 'auto', ...(viaOrder ? { per_order: true, no_order: noOrder, keys: keyCount } : {}), inserted, updated_failed: updatedFailed, skipped: keyCount - inserted - updatedFailed, invalid, duplicated_in_request: body.phones.length - invalid - list.length });
}

export function costOf(vendor, parts, people, env) {
  let total = 0;
  for (const part of parts) {
    const type = part.image >= 0 ? 'MMS' : 'LMS';
    total += Number(vendor.estimate({ type, count: people }, env)?.total) || 0;
  }
  return total;
}

// 문구 카드에 보이는 건당 비용(1명 기준). 브랜드메시지는 대체 문자 단가를, 문자는 통 구성을 함께 돌려준다. vendor 가 없으면 null.
export function sendCostOf(item, vendor, env = process.env) {
  if (!vendor || !item) return null;
  const num = value => (Number.isFinite(Number(value)) ? Number(value) : null);
  if (isBmsTemplate(item)) {
    const info = typeof vendor.estimateBms === 'function' ? vendor.estimateBms({ count: 1 }, env) : null;
    return info ? { type: 'BMS', unit: num(info.total), parts: [{ type: 'BMS', count: 1 }], fallback_unit: num(info.fallback_unit) } : null;
  }
  if (isAtaTemplate(item)) {
    const info = typeof vendor.estimateKakao === 'function' ? vendor.estimateKakao({ count: 1 }, env) : null;
    return info ? { type: 'ATA', unit: num(info.total), parts: [{ type: 'ATA', count: 1 }] } : null;
  }
  const images = Math.max(0, Number(item.image_count) || 0);
  const list = isInfoTemplate(item) ? buildEventParts(item, images) : buildParts(item, images);
  const counts = new Map();
  let total = 0;
  for (const part of list) {
    const type = part.image >= 0 ? 'MMS' : (classifyText(part.text || item.body || '').type || 'LMS');
    counts.set(type, (counts.get(type) || 0) + 1);
    total += Number(vendor.estimate({ type, count: 1 }, env)?.total) || 0;
  }
  const parts = [...counts].map(([type, count]) => ({ type, count }));
  return { type: parts.find(part => part.type === 'MMS')?.type || parts[parts.length - 1].type, unit: total, parts };
}

// action auto_toggle { id, enabled, dry_run }
export async function autoToggle(body, { db, provider, env = process.env, nowMs = Date.now(), kakao, kakaoOpts } = {}) {
  const id = Number(body?.id);
  if (!(Number.isInteger(id) && id > 0)) return errorReply(400, '올바른 문구가 아닙니다.');
  if (typeof body.enabled !== 'boolean') return errorReply(400, '올바른 요청이 아닙니다.');
  await ensureAutoSchema(db);
  const template = await loadTemplate(db, id);
  if (!template) return errorReply(404, '문구를 찾을 수 없습니다.');
  if (!body.enabled) {
    if (body.dry_run === true) return reply(200, { ok: true, enabled: false });
    await db.execute({ sql: 'UPDATE sms_text_templates SET auto_enabled = false WHERE id = ? RETURNING id', args: [id] });
    return reply(200, { ok: true, enabled: false, start_date: template.auto_start_date || '' });
  }
  if (isInfoTemplate(template)) { await ensureEventSchema(db); return eventToggleOn(body, template, { db, provider, env, nowMs, kakao, kakaoOpts }); } // 안내 문구는 새 모듈
  if (!isAutoKind(template.auto_kind) || !daysOk(template)) return errorReply(400, '자동 발송이 설정된 문구가 아닙니다.', { reason: 'no_auto' });
  if (isProcessPlusKind(template.auto_kind) && !STEPS.includes(template.auto_step)) return errorReply(400, '공정을 골라야 켤 수 있습니다.', { reason: 'no_step' });
  const blocked = adCheckOf(template);
  if (blocked) return errorReply(400, blocked === 'no_ad_prefix' ? '본문이 (광고) 로 시작해야 켤 수 있습니다.' : '본문에 080 무료수신거부 번호가 있어야 켤 수 있습니다.', { reason: blocked });
  if (!autoSettings(env).on) return errorReply(503, '자동 발송이 꺼져 있습니다.');
  const startDate = addDays(kstDate(nowMs), -template.auto_days);
  if (body.dry_run === true) {
    const vendor = provider || getSendProvider();
    const parts = buildParts(template, template.images.length);
    const targets = (await eligibleTargets(db, template, { nowMs, startDate })).length;
    const people = Math.min(targets, autoSettings(env).maxPerDay);
    return reply(200, { ok: true, targets, parts: parts.length, cost: vendor ? costOf(vendor, parts, people, env) : null, daily_max: autoSettings(env).maxPerDay });
  }
  await db.execute({ sql: 'UPDATE sms_text_templates SET auto_enabled = true, auto_start_date = ? WHERE id = ? RETURNING id', args: [startDate, id] });
  return reply(200, { ok: true, enabled: true, start_date: startDate });
}

// action auto_test { id, to, dry_run, idempotencyKey }: 번호 1개 전용. 자동 발송과 같은 통 구성, #{고객명} 은 '고객'.
// sms_auto_sends 에는 적지 않고 sms_manual_sends 에 건수를 남긴다(그 표의 하루 상한에 잡힌다).
export async function autoTest(body, { db, provider, env = process.env, nowMs = Date.now(), fetchImpl, writeEnabled = true, sleep, kakao, kakaoOpts } = {}) {
  const settings = sendSettings(env, writeEnabled);
  if (!settings.enabled) return errorReply(403, '발송이 꺼져 있습니다.');
  const id = Number(body?.id);
  if (!(Number.isInteger(id) && id > 0)) return errorReply(400, '올바른 문구가 아닙니다.');
  const to = digits(body?.to);
  if (typeof body?.to !== 'string' || !MOBILE_RE.test(to)) return errorReply(400, '받는 번호가 휴대폰 번호 형식이 아닙니다.');
  const dryRun = body.dry_run === true;
  const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  if (!dryRun && !KEY_RE.test(key)) return errorReply(400, '올바른 요청이 아닙니다.');
  // 시험 발송은 사장님이 직접 넣은 번호 1개로만 가므로 시간 제한을 두지 않는다(고객 자동 발송의 야간 금지는 runAutoSend 에 그대로).
  const template = await loadTemplate(db, id);
  if (!template) return errorReply(404, '문구를 찾을 수 없습니다.');
  const vendor = provider || getSendProvider();
  const ata = isAtaTemplate(template); // 수단이 알림톡이면 알림톡으로 시험한다(문자 수단은 아래 기존 흐름 그대로)
  const bms = isBmsTemplate(template); // 브랜드메시지(자유형)도 알림톡 갈래를 타되 BMS_FREE 로 보낸다
  if (!vendor || typeof (bms ? vendor.sendBmsEach : ata ? vendor.sendKakaoEach : vendor.sendEach) !== 'function') return errorReply(503, '발송 업체가 설정되지 않았습니다.');
  let pfId = '';
  let ataNames = [];
  const bmsCfg = bms ? parseBmsConfig(template.auto_bms) : null;
  if (bms) { // 채널·사진(저장 때 올린 imageId)·글자 수 확인(쏠라피 호출 없음)
    const checked = bmsReady(template);
    if (!checked.ok) return errorReply(400, '브랜드메시지 설정(사진·글자 수)이 맞지 않습니다. 문구를 다시 저장해 주세요.', { reason: 'bms_not_ready' });
    pfId = checked.cfg.pfId;
    if (!bmsTestInWindow(nowMs)) return errorReply(400, '카카오 브랜드메시지는 오전 8시~오후 8시 50분에만 보낼 수 있습니다. 지금 보내면 카톡이 아니라 문자로 갑니다.', { reason: 'bms_out_of_hours' });
  } else if (ata) { // 승인·채널 확인: 못 정하면 보내지 않고 현재 상태를 알려 준다
    const ready = await ataReady(template.auto_ata_template, { kakao, kakaoOpts, env });
    if (!ready.ok) {
      let status = '확인하지 못함';
      try { status = (await (kakao || (await import('./kakaoTemplates.js'))).getTemplateFresh(template.auto_ata_template, kakaoOpts))?.template?.status || status; } catch { /* 상태를 못 읽어도 안내는 낸다 */ }
      return errorReply(400, `카카오 승인 전에는 알림톡 시험을 보낼 수 없습니다(현재 상태: ${status}).`, { reason: 'ata_not_ready' });
    }
    pfId = ready.pfId;
    ataNames = ready.names || [];
  }
  const info = isInfoTemplate(template); // 안내 문구는 예시 값으로 치환
  const parts = ata ? [{ ata: true, image: -1 }] : info ? buildEventParts(template, template.images.length) : buildParts(template, template.images.length);
  const unitInfo = bms && typeof vendor.estimateBms === 'function' ? vendor.estimateBms({ count: 1 }, env) : null;
  const cost = bms ? (unitInfo ? unitInfo.total ?? null : null) : ata ? (typeof vendor.estimateKakao === 'function' ? vendor.estimateKakao({ count: 1 }, env)?.total ?? null : null) : costOf(vendor, parts, 1, env);
  if (dryRun) return reply(200, { ok: true, dry_run: true, parts: parts.length, cost, ...(ata ? { ata: true } : {}), ...(unitInfo ? { bms: true, unit: unitInfo.unit, fallback_unit: unitInfo.fallback_unit } : {}) });
  const from = bms ? bmsCfg.from : (digits(template.auto_chain?.from) || digits(env.SMS_SENDER));
  if (!from) return errorReply(503, '발신번호가 설정되지 않았습니다.');
  if (!provider && !hasSolapiCredentials()) return errorReply(503, '쏠라피 연결이 설정되지 않았습니다.');

  await ensureManualSendSchema(db);
  const dayStart = new Date(Date.parse(`${kstDate(nowMs)}T00:00:00Z`) - 9 * 3600000).toISOString();
  const used = Number((await db.execute({ sql: 'SELECT COALESCE(SUM(recipient_count), 0)::int AS n FROM sms_manual_sends WHERE sent_at >= ?', args: [dayStart] })).rows?.[0]?.n) || 0;
  if (used + parts.length > settings.daily) return errorReply(429, `하루 ${settings.daily}건까지 보낼 수 있습니다. 오늘 ${used}건 보냈습니다.`);
  const msgType = bms ? 'BMS_FREE' : ata ? 'ATA' : template.images.length ? 'MMS' : classifyText(template.body).type || 'LMS';
  const hash = crypto.createHmac('sha256', String(env.SOLAPI_API_SECRET || 'sms-manual-send')).update(to).digest('hex');
  const inserted = await db.execute({
    sql: `INSERT INTO sms_manual_sends (idem_key, msg_type, recipient_count, text_length, tails, recipients_hash, status)
          VALUES (?, ?, ?, ?, ?, ?, 'sending') ON CONFLICT (idem_key) DO NOTHING RETURNING id`,
    args: [key, msgType, parts.length, [...String(template.body)].length, to.slice(-4), hash],
  });
  if (!inserted.rows?.length) {
    const row = (await db.execute({ sql: 'SELECT status, recipient_count FROM sms_manual_sends WHERE idem_key = ?', args: [key] })).rows?.[0] || {};
    return reply(200, { ok: true, duplicate: true, status: row.status || 'sending', parts: Number(row.recipient_count) || parts.length });
  }
  const fileIds = [];
  for (const base64 of (ata ? [] : template.images)) {
    let fileId = '';
    try { fileId = (await vendor.uploadImage({ base64, name: 'photo.jpg' }, { fetchImpl }))?.fileId || ''; } catch { fileId = ''; }
    if (!fileId) {
      try { await db.execute({ sql: 'DELETE FROM sms_manual_sends WHERE idem_key = ?', args: [key] }); } catch { /* 정리 실패는 무시 */ }
      return errorReply(502, '사진을 올리지 못했습니다. 다시 시도해 주세요.');
    }
    fileIds.push(fileId);
  }
  const results = [];
  let stop = false;
  let groupId = null;
  let message = '';
  for (const [partIndex, part] of parts.entries()) {
    if (stop) { results.push('skipped'); continue; }
    await waitBeforePart(partIndex, { env, sleep });
    const item = bms ? { to, text: fillVars(String(template.body).trim(), { 고객명: '고객' }), ...(bmsCfg.imageId ? { imageId: bmsCfg.imageId } : {}), buttons: bmsCfg.buttons } : ata ? { to, templateId: template.auto_ata_template, variables: ataSendVars({ vars: nameVars('고객') }, ataNames) } : { to, text: info ? eventExampleText(part, template) : partText(part, template, '고객'), ...(!info ? subjectOf(template) : {}) };
    if (!ata && part.image >= 0) item.fileId = fileIds[part.image];
    let result;
    try { result = bms ? await vendor.sendBmsEach({ from, pfId, messages: [item] }, { fetchImpl }) : ata ? await vendor.sendKakaoEach({ from, pfId, messages: [item], disableSms: true }, { fetchImpl }) : await vendor.sendEach({ from, messages: [item] }, { fetchImpl }); } catch { result = { accepted: 0, failed: 0, uncertain: true, error: '보냈는지 확인하지 못했습니다.' }; }
    if (result.groupId) groupId = result.groupId;
    if (result.uncertain) { results.push('uncertain'); stop = true; message = String(result.error || '').slice(0, 200); }
    else if (result.failed === 0) results.push('sent');
    else { results.push('failed'); stop = true; message = String(result.error || '').slice(0, 200); }
  }
  const okCount = results.filter(r => r === 'sent').length;
  const status = results.every(r => r === 'sent') ? 'sent' : results.includes('uncertain') ? 'uncertain' : okCount ? 'partial' : 'failed';
  try {
    await db.execute({
      sql: 'UPDATE sms_manual_sends SET status = ?, success_count = ?, fail_count = ?, group_id = ?, error = ? WHERE idem_key = ?',
      args: [status, okCount, results.filter(r => r === 'failed').length, groupId, message || null, key],
    });
  } catch { /* 기록 실패가 이미 끝난 발송 결과 응답을 막지 않게 한다 */ }
  const out = { ok: true, sent: okCount > 0, status, parts: parts.length, part_status: results, cost };
  if (message) out.message = message;
  return reply(200, out);
}

// ---- 수신거부 번호 ----
export async function optoutAdd(body, { db } = {}) {
  const phone = digits(body?.phone);
  if (typeof body?.phone !== 'string' || !MOBILE_RE.test(phone)) return errorReply(400, '휴대폰 번호 형식이 아닙니다.');
  await ensureAutoSchema(db);
  const hash = phoneHash(phone);
  const inserted = await db.execute({ sql: 'INSERT INTO sms_optouts (phone_hash, phone_last4) VALUES (?, ?) ON CONFLICT (phone_hash) DO NOTHING RETURNING id', args: [hash, phone.slice(-4)] });
  const row = inserted.rows?.[0] || (await db.execute({ sql: 'SELECT id FROM sms_optouts WHERE phone_hash = ?', args: [hash] })).rows?.[0];
  return reply(inserted.rows?.length ? 201 : 200, { ok: true, item: { id: Number(row?.id), last4: phone.slice(-4) }, duplicate: !inserted.rows?.length });
}

export async function optoutDelete(body, { db } = {}) {
  const id = Number(body?.id);
  if (!(Number.isInteger(id) && id > 0)) return errorReply(400, '올바른 번호가 아닙니다.');
  await ensureAutoSchema(db);
  const out = await db.execute({ sql: 'DELETE FROM sms_optouts WHERE id = ? RETURNING id', args: [id] });
  if (!out.rows?.[0]) return errorReply(404, '번호를 찾을 수 없습니다.');
  return reply(200, { ok: true, deleted: true, id });
}

export async function optoutList(db) {
  await ensureAutoSchema(db);
  const out = await db.execute({ sql: 'SELECT id, phone_last4, created_at FROM sms_optouts ORDER BY id DESC LIMIT 500', args: [] });
  const items = (out.rows || []).map(row => ({ id: Number(row.id), last4: String(row.phone_last4 || ''), created_at: row.created_at ? new Date(row.created_at).toISOString() : null }));
  return reply(200, { items, count: items.length });
}
