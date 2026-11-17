// 내 문자 문구 저장소(보내기 화면에서 불러 쓰는 문구). 번호·이름은 다루지 않는다.
import { byteLength, getSendProvider } from './sendProvider.js';
import { BMS_PF_ID, BMS_SENDER, BMS_TEMPLATE_ID, bmsImageRatioError, bmsImageSig, bmsTextError, parseBmsConfig, readBmsButtons } from './smsBms.js';
import { parseSendExtras, staffDirectory } from './smsManualSend.js';
import { STEPS } from './steps.js';

export const TEXT_TEMPLATE_LIMITS = Object.freeze({ name: 40, bodyBytes: 2000, count: 100, images: 3, autoDaysMax: 365 });
export const AUTO_KIND = 'ship_plus_days';
// 기준 사건: 출고 완료 후 / 주문 등록 후(2026-11-13 더함)
export const AUTO_KINDS = Object.freeze(['ship_plus_days', 'order_plus_days']);
export const isAutoKind = kind => AUTO_KINDS.includes(kind);
// 2단계-가(2026-11-13): 기준일형(납기일·출고예정일 기준) — 항상 안내(info) 문구
// 3단계-가(설계 17절): 'ship_or_due' = 출고예정일(없으면 납기일) 기준
export const EVENT_KINDS = Object.freeze(['due_date', 'ship_scheduled', 'ship_or_due']);
export const isEventKind = kind => EVENT_KINDS.includes(kind);
// 2단계-나(2026-11-13, 설계 15절): 즉시형(주문 등록 시·공정 시작 시·공정 완료 시) — 항상 안내(info) 문구
// 3단계-나(설계 18절): 'member_joined' = 자사몰(카페24) 회원가입 시. 주문과 무관 — 공정·주문 변수 없음, 받는 사람 고객 고정.
export const INSTANT_KINDS = Object.freeze(['order_created', 'process_started', 'process_completed', 'member_joined']);
export const isInstantKind = kind => INSTANT_KINDS.includes(kind);
// 4단계(설계 19절): 'lead_plus_days' = 가입·문의 후 N일(에어테이블·카페24 접수 기준). 알림톡(auto_ata_template)을 붙일 수 있다.
export const LEAD_KINDS = Object.freeze(['lead_plus_days']);
export const isLeadKind = kind => LEAD_KINDS.includes(kind);
export const LEAD_SOURCES = Object.freeze(['', 'cafe24', 'airtable']); // 가입·문의 후 대상(접수 표 source). ''는 모두
export const isInfoKind = kind => isEventKind(kind) || isInstantKind(kind) || isLeadKind(kind);
export const isAnyAutoKind = kind => isAutoKind(kind) || isInfoKind(kind);
// 출고 완료 후 N일에 알림톡 수단을 고른 문구(2026-11-16): 광고 문자가 아니라 정보성 알림톡으로 나가며 안내(info) 발송 경로(smsEventSend)를 탄다.
export const isShipAta = template => template?.auto_kind === AUTO_KIND && Boolean(template.auto_ata_template);
// 모든 자동 발송 조건에서 알림톡 수단을 고를 수 있다(2026-11-16). 출고·주문 후 N일은 알림톡을 고르면 정보성(info) 경로를 타고,
// 날짜 기준·즉시형·가입 시·가입·문의 후는 원래 info 경로라 알림톡 id 가 있으면 발송만 알림톡으로 바뀐다. 받는 사람은 고객만(알림톡 변수는 #{고객명} 하나).
export const isDayAta = template => isAutoKind(template?.auto_kind) && Boolean(template?.auto_ata_template);
export const isAtaTemplate = template => isAnyAutoKind(template?.auto_kind) && Boolean(template?.auto_ata_template);
export const isInfoTemplate = template => isInfoKind(template?.auto_kind) || isDayAta(template);
// 조건별 알림톡 가능 여부 점검표(설계 A). 전부 가능 — 구조상 불가한 조건은 없다. 대상 조회는 기존 문자 갈래의 조회를 그대로 쓰고 발송만 알림톡이다.
export const ATA_CONDITIONS = Object.freeze({
  member_joined: '자사몰 회원가입 시: 대상=카페24 가입 웹훅 번호(signupCandidates), 이름이 없어 #{고객명}은 "고객"',
  lead_plus_days: '가입·문의 후: 대상=leadCandidates',
  order_created: '주문 등록 시: 대상=orders.created_at 창(instantCandidates)',
  order_plus_days: '주문 등록 후: 대상=findTargets(order_plus_days)',
  process_started: '공정 시작 시: 대상=processes.started_at 창(instantCandidates)',
  process_completed: '공정 완료 시: 대상=processes.completed_at 창(instantCandidates)',
  ship_plus_days: '출고 완료 후: 대상=findTargets(ship_plus_days)',
  due_date: '납기일 기준: 대상=candidates(기준일형)',
  ship_scheduled: '출고예정일 기준: 대상=candidates(기준일형)',
  ship_or_due: '출고·납기일 기준: 대상=candidates(기준일형)',
});
export const OFFSET_MAX = 365;
const STAFF_CAP = 30;
// 고객 대상 안내 문구 검사: 주문 변수가 하나 이상 있어야 하고 광고 낱말이 없어야 한다. '' 이면 통과.
const ORDER_VAR_RE = /#\{(주문번호|규격|수량|예상출고일|조회링크)\}/;
const AD_WORD_RE = /할인|이벤트|혜택|쿠폰|특가|소개|세일|무료|증정|사은품|\(광고\)/;
// 쓸 수 있는 변수(고객 / 직원). 이 밖의 #{…} 는 치환되지 않고 글자 그대로 나가므로 저장·켜기·실행에서 막는다.
const INFO_VARS = Object.freeze({ customer: ['고객명', '주문번호', '규격', '수량', '예상출고일', '조회링크'], staff: ['고객명', '주문번호', '규격', '수량', '예상출고일', '조회링크', '제품'] });
const hasUnknownVar = (text, audience) => [...text.matchAll(/#\{([^}]*)\}/g)].some(match => !INFO_VARS[audience].includes(match[1]));
export function infoCheck(body, audience = 'customer', kind = '', ata = false) {
  const text = String(body ?? '');
  if (kind === 'lead_plus_days' || ata) { // 가입·문의 후(알림톡을 고른 모든 조건이 같다): 고객명만 허용, 주문 변수 필수 면제, 광고 낱말 검사는 문자일 때만(알림톡은 카카오 검수 본문)
    if ([...text.matchAll(/#\{([^}]*)\}/g)].some(match => match[1] !== '고객명')) return 'info_unknown_var';
    return !ata && AD_WORD_RE.test(text) ? 'info_has_ad_words' : '';
  }
  if (kind === 'member_joined') { // 가입 안내: 변수 전부 거절(주문 변수는 쓸 수 없고 고객명도 웹훅에 없음), 광고 낱말 거절, 주문 변수 필수는 면제
    if (/#\{/.test(text)) return 'info_unknown_var';
    return AD_WORD_RE.test(text) ? 'info_has_ad_words' : '';
  }
  const staffLike = audience === 'staff' || audience === 'sales'; // 영업담당 수신은 직원과 같은 검사
  if (hasUnknownVar(text, staffLike ? 'staff' : 'customer')) return 'info_unknown_var';
  if (staffLike) return '';
  if (AD_WORD_RE.test(text)) return 'info_has_ad_words';
  if (!ORDER_VAR_RE.test(text)) return 'info_needs_order_var';
  return '';
}
export const INFO_CHECK_MESSAGE = Object.freeze({
  info_has_ad_words: '안내 문구에는 할인·이벤트 같은 광고 낱말을 쓸 수 없습니다.',
  info_needs_order_var: '안내 문구에는 주문 변수가 하나 이상 있어야 합니다.',
  info_unknown_var: '이 문구에서 쓸 수 없는 변수가 들어 있습니다.',
});
export const parseStaffIds = value => {
  try { const list = JSON.parse(String(value || '')); return Array.isArray(list) ? list.filter(item => typeof item === 'string' && item) : []; } catch { return []; }
};
export const AUTO_LIMITS = Object.freeze({ repeatMax: 10, intervalMax: 365, defaultRepeat: 1, defaultInterval: 30 });
const flags = new Map();
export function _resetTextTemplateSchemaForTest() { flags.clear(); }

// 표 만들기: sms_manual_sends 와 같은 방식(요청 때 CREATE TABLE IF NOT EXISTS, 인스턴스당 1회)
export async function ensureTextTemplateSchema(db) {
  if (flags.get('sms.textTemplates')) return;
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS sms_text_templates (
      id BIGSERIAL PRIMARY KEY,
      name TEXT NOT NULL UNIQUE,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    args: [],
  });
  // 사진 1장(base64 JPG). 목록 응답에는 싣지 않고 단건 조회에서만 준다.
  await db.execute({ sql: 'ALTER TABLE sms_text_templates ADD COLUMN IF NOT EXISTS image TEXT', args: [] });
  // 출고 후 자동 발송(2026-11-13): 사진 최대 3장(JSON 배열)과 자동 발송 조건·켜짐 상태. 기존 image 칸은 그대로 둔다.
  for (const column of ['images TEXT', 'auto_kind TEXT', 'auto_days INT', 'auto_enabled BOOLEAN NOT NULL DEFAULT false', 'auto_start_date TEXT', 'auto_send_from TEXT', 'auto_repeat INT NOT NULL DEFAULT 1', 'auto_interval INT NOT NULL DEFAULT 30',
    'auto_offset INT NOT NULL DEFAULT 0', 'auto_unless_step TEXT', "auto_audience TEXT NOT NULL DEFAULT 'customer'", 'auto_staff TEXT', "auto_msg_type TEXT NOT NULL DEFAULT 'ad'", 'auto_step TEXT', 'auto_enabled_at TIMESTAMPTZ',
    "auto_daily TEXT NOT NULL DEFAULT ''", 'auto_weekdays BOOLEAN NOT NULL DEFAULT false', "auto_unless_mode TEXT NOT NULL DEFAULT 'completed'", 'auto_ata_template TEXT', 'auto_send_time TEXT', "auto_copy_to TEXT NOT NULL DEFAULT ''", "auto_copy_date TEXT NOT NULL DEFAULT ''", 'auto_catchup_from TEXT', 'auto_catchup_at TEXT', 'auto_catchup_daily INTEGER', 'auto_catchup_done_at TIMESTAMPTZ', "auto_lead_source TEXT NOT NULL DEFAULT ''", 'auto_catchup_paused_at TIMESTAMPTZ', 'auto_catchup_error TEXT', 'auto_ata_fail_at TIMESTAMPTZ', 'auto_bms TEXT']) {
    await db.execute({ sql: `ALTER TABLE sms_text_templates ADD COLUMN IF NOT EXISTS ${column}`, args: [] });
  }
  flags.set('sms.textTemplates', true);
}

const ok = (body, status = 200) => ({ status, body });
const bad = (message, status = 400, extra = {}) => ({ status, body: { error: { message, status }, ...extra } });
const imageCountOf = row => Math.max(0, Number(row.image_count) || 0);
const toItem = row => ({
  id: Number(row.id), name: row.name, body: row.body, ...(row.has_image ? { has_image: true } : {}),
  ...(imageCountOf(row) > 0 ? { image_count: imageCountOf(row) } : {}),
  ...(row.auto_kind ? autoFields(row) : {}),
});
// 자동 발송 칸(응답용). send_from 은 있을 때만, repeat·interval 은 기본값으로 채운다.
function autoFields(row) {
  return {
    auto_kind: String(row.auto_kind), auto_days: Number(row.auto_days) || 0, auto_enabled: row.auto_enabled === true,
    ...(row.auto_send_from ? { auto_send_from: String(row.auto_send_from) } : {}),
    auto_repeat: Number(row.auto_repeat) || AUTO_LIMITS.defaultRepeat, auto_interval: Number(row.auto_interval) || AUTO_LIMITS.defaultInterval,
    auto_offset: Number(row.auto_offset) || 0, auto_unless_step: row.auto_unless_step ? String(row.auto_unless_step) : '',
    auto_audience: ['staff', 'sales'].includes(row.auto_audience) ? row.auto_audience : 'customer', auto_staff: parseStaffIds(row.auto_staff), auto_msg_type: row.auto_msg_type === 'info' ? 'info' : 'ad',
    ...(isEventKind(row.auto_kind) ? { auto_daily: String(row.auto_daily || ''), auto_weekdays: row.auto_weekdays === true, auto_unless_mode: row.auto_unless_mode === 'started' ? 'started' : 'completed' } : {}),
    ...(row.auto_step ? { auto_step: String(row.auto_step) } : {}),
    ...(isLeadKind(row.auto_kind) || row.auto_ata_template ? { auto_ata_template: String(row.auto_ata_template || '') } : {}),
    ...(row.auto_ata_template === BMS_TEMPLATE_ID ? bmsFields(row.auto_bms) : {}), // 브랜드메시지(자유형): 버튼·사진 올림 여부만(채널·발신번호·imageId 는 싣지 않는다)
    ...(isLeadKind(row.auto_kind) && LEAD_SOURCES.includes(row.auto_lead_source) && row.auto_lead_source ? { auto_lead_source: String(row.auto_lead_source) } : {}),
    ...(row.auto_kind === AUTO_KIND && row.auto_catchup_at ? { auto_catchup_from: String(row.auto_catchup_from || ''), auto_catchup_at: String(row.auto_catchup_at), auto_catchup_done: Boolean(row.auto_catchup_done_at), ...(Number(row.auto_catchup_daily) > 0 ? { auto_catchup_daily: Number(row.auto_catchup_daily) } : {}) } : {}),
    ...(row.auto_kind === AUTO_KIND && row.auto_catchup_at && row.auto_catchup_paused_at ? { auto_catchup_paused: true, auto_catchup_error: String(row.auto_catchup_error || '') } : {}),
    ...(row.auto_send_time ? { auto_send_time: String(row.auto_send_time) } : {}),
    ...(row.auto_copy_to ? { auto_copy_to: String(row.auto_copy_to) } : {}),
  };
}

// 브랜드메시지(자유형, 2026-11-17) 응답 칸
function bmsFields(raw) {
  const cfg = parseBmsConfig(raw);
  return { auto_bms_buttons: cfg.buttons, auto_bms_image: Boolean(cfg.imageId) };
}

// 저장된 사진 목록(base64 배열). images 칸이 비어 있으면 예전 image 1장을 쓴다.
export function storedImages(row) {
  try {
    const list = JSON.parse(String(row?.images || ''));
    if (Array.isArray(list) && list.length) return list.filter(item => typeof item === 'string' && item);
  } catch { /* 칸이 비었거나 깨졌으면 예전 image 로 본다 */ }
  return typeof row?.image === 'string' && row.image ? [row.image] : [];
}

// 입력 images → { skip } | { list:[base64…] } | { error }. 장당 형식·용량 검사는 보내기와 같은 함수.
function readImages(input) {
  if (input?.images === undefined) return { skip: true };
  if (input.images === null) return { list: [] };
  if (!Array.isArray(input.images)) return { error: '사진 목록이 올바르지 않습니다.' };
  if (input.images.length > TEXT_TEMPLATE_LIMITS.images) return { error: `사진은 최대 ${TEXT_TEMPLATE_LIMITS.images}장까지 넣을 수 있습니다.` };
  const list = [];
  for (const item of input.images) {
    const data = typeof item === 'string' ? { data: item } : item;
    const parsed = parseSendExtras({ image: data });
    if (parsed.error) return { error: parsed.error };
    list.push(parsed.image.base64);
  }
  return { list };
}

// 입력 auto → { skip } | { kind:'', days:null, … 기본값 } | { kind, days, send_from, repeat, interval } | { error }
const AD_EXTRA = Object.freeze({ offset: 0, unless_step: null, audience: 'customer', staff: null, msg_type: 'ad', step: null, daily: '', weekdays: false, unless_mode: 'completed', catchup_from: '', catchup_at: '' });
// 발송 시각(설계 28-0): 'HH:MM' 09:00~20:00 30분 단위 또는 빈 값. 시각이 뜻을 갖는 날짜형(출고·주문 후, 납기·출고예정일, 가입·문의 후 1일 이상)만 저장하고 즉시형은 빈 값.
const SEND_TIME_RE = /^(\d{2}):(\d{2})$/;
export const sendTimeMinutes = value => { const m = SEND_TIME_RE.exec(String(value || '')); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
export const isTimedKind = (kind, days = 0) => isAutoKind(kind) || isEventKind(kind) || (isLeadKind(kind) && Number(days) >= 1);
function readSendTime(input, base) {
  const raw = [input?.auto_send_time, input?.auto?.auto_send_time, input?.auto?.send_time].find(value => value !== undefined && value !== null && value !== '');
  if (raw === undefined || !isTimedKind(base.kind, base.days)) return '';
  const minutes = sendTimeMinutes(raw);
  if (typeof raw !== 'string' || minutes === null || minutes < 9 * 60 || minutes > 20 * 60 || minutes % 30 !== 0) return null;
  return raw;
}
// 사본 받을 번호(2026-11-17): 자동 발송이 고객에게 나간 날 같은 문자를 이 번호로 하루 1통 더 보낸다. 빈 값은 사본 없음.
function readCopyTo(input) {
  const raw = [input?.auto_copy_to, input?.auto?.auto_copy_to, input?.auto?.copy_to].find(value => value !== undefined && value !== null && value !== '');
  if (raw === undefined) return '';
  const number = String(raw).replace(/\D/g, '');
  return typeof raw === 'string' && /^01[016789]\d{7,8}$/.test(number) ? number : null;
}
function readAuto(input, staff = staffDirectory()) {
  const base = readAutoBase(input, staff);
  if (base.error || base.skip) return base;
  const sendTime = readSendTime(input, base);
  if (sendTime === null) return { error: '발송 시각은 09:00~20:00 사이 30분 단위로 입력해 주세요.' };
  const copyTo = readCopyTo(input);
  if (copyTo === null) return { error: '사본 받을 번호가 휴대폰 번호 형식이 아닙니다.' };
  if (base.ata === BMS_TEMPLATE_ID) { // 브랜드메시지(자유형): 버튼 검사, 광고 발송 시간(오후 8시 전)
    const picked = readBmsButtons(input.auto.bms);
    if (picked.error) return picked;
    if (sendTime && sendTimeMinutes(sendTime) >= 20 * 60) return { error: '브랜드메시지는 오후 8시 전에만 보낼 수 있어 발송 시각은 19:30까지 입력해 주세요.' };
    if (base.catchup_at && Number(String(base.catchup_at).slice(11, 13)) >= 20) return { error: '브랜드메시지 일괄 발송 시각은 오전 8시~오후 8시 전으로 입력해 주세요.', reason: 'catchup_at' };
    base.bms = picked;
  }
  return { catchup_from: '', catchup_at: '', catchup_daily: null, ...base, send_time: sendTime, copy_to: copyTo };
}
function readAutoBase(input, staff) {
  if (input?.auto === undefined) return { skip: true };
  if (input.auto === null || !input.auto?.kind) return { kind: '', days: null, send_from: null, repeat: AUTO_LIMITS.defaultRepeat, interval: AUTO_LIMITS.defaultInterval, ...AD_EXTRA };
  if (isEventKind(input.auto.kind)) return readEventAuto(input.auto, staff, typeof input.body === 'string' ? input.body : '');
  if (isLeadKind(input.auto.kind)) return readLeadAuto(input.auto, typeof input.body === 'string' ? input.body : '');
  if (isInstantKind(input.auto.kind)) return readInstantAuto(input.auto, staff, typeof input.body === 'string' ? input.body : '');
  if (!isAutoKind(input.auto.kind)) return { error: '자동 발송 종류가 올바르지 않습니다.' };
  const days = Number(input.auto.days);
  const when = input.auto.kind === AUTO_KIND ? '출고' : '주문';
  if (!(Number.isInteger(days) && days >= 1 && days <= TEXT_TEMPLATE_LIMITS.autoDaysMax)) return { error: `${when} 후 일수는 1~${TEXT_TEMPLATE_LIMITS.autoDaysMax}일로 입력해 주세요.` };
  { // 출고·주문 후 N일 + 알림톡: 정보성 알림톡. 시작일·반복 없이 번호당 1번(가입·문의 갈래와 같은 본문 검증)
    const picked = readAta(input.auto, typeof input.body === 'string' ? input.body : '', input.auto.kind);
    if (picked.error) return picked;
    if (picked.ata) {
      const catchup = input.auto.kind === AUTO_KIND ? readCatchup(input.auto.catchup) : { catchup_from: '', catchup_at: '', catchup_daily: null }; // 이미 출고된 주문에 1번 보내기는 출고 완료 후만
      if (catchup.error) return catchup;
      return { kind: input.auto.kind, days, send_from: null, repeat: AUTO_LIMITS.defaultRepeat, interval: AUTO_LIMITS.defaultInterval, ...AD_EXTRA, msg_type: 'info', ata: picked.ata, catchup_from: catchup.catchup_from, catchup_at: catchup.catchup_at, catchup_daily: catchup.catchup_daily ?? null };
    }
  }
  const rawFrom = input.auto.send_from;
  let sendFrom = null;
  if (rawFrom !== undefined && rawFrom !== null && rawFrom !== '') {
    const text = typeof rawFrom === 'string' ? rawFrom : '';
    const valid = /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
    if (!valid) return { error: '시작일은 YYYY-MM-DD 형식으로 입력해 주세요.' };
    sendFrom = text;
  }
  const repeat = input.auto.repeat === undefined || input.auto.repeat === null || input.auto.repeat === '' ? AUTO_LIMITS.defaultRepeat : Number(input.auto.repeat);
  if (!(Number.isInteger(repeat) && repeat >= 1 && repeat <= AUTO_LIMITS.repeatMax)) return { error: `반복 횟수는 1~${AUTO_LIMITS.repeatMax}번으로 입력해 주세요.` };
  const interval = input.auto.interval === undefined || input.auto.interval === null || input.auto.interval === '' ? AUTO_LIMITS.defaultInterval : Number(input.auto.interval);
  if (!(Number.isInteger(interval) && interval >= 1 && interval <= AUTO_LIMITS.intervalMax)) return { error: `반복 간격은 1~${AUTO_LIMITS.intervalMax}일로 입력해 주세요.` };
  if (typeof input.body === 'string' && [...input.body.matchAll(/#\{([^}]*)\}/g)].some(match => match[1] !== '고객명')) return { error: INFO_CHECK_MESSAGE.info_unknown_var, reason: 'info_unknown_var' };
  const adCatchup = input.auto.kind === AUTO_KIND ? readCatchup(input.auto.catchup) : { catchup_from: '', catchup_at: '', catchup_daily: null }; // 광고 문자(출고 완료 후)도 이미 출고된 주문에 한 번 보내기를 쓸 수 있다
  if (adCatchup.error) return adCatchup;
  return { kind: input.auto.kind, days, send_from: sendFrom, repeat, interval, ...AD_EXTRA, catchup_from: adCatchup.catchup_from, catchup_at: adCatchup.catchup_at, catchup_daily: adCatchup.catchup_daily ?? null };
}

// 알림톡 수단 읽기(모든 조건 공용) → { ata:'' } | { ata } | { error, reason? }. 받는 사람은 고객만, 본문은 고객명 변수만(광고 낱말 검사 없음).
function readAta(auto, body, kind, audience = 'customer') {
  const ata = typeof auto?.ata_template === 'string' ? auto.ata_template.trim() : '';
  if (!ata) return { ata: '' };
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(ata)) return { error: '알림톡 템플릿이 올바르지 않습니다.' };
  if (audience !== 'customer') return { error: '알림톡은 고객에게만 보낼 수 있습니다.', reason: 'ata_customer_only' };
  const blocked = infoCheck(body, 'customer', kind, true);
  if (blocked) return { error: INFO_CHECK_MESSAGE[blocked], reason: blocked };
  return { ata };
}
// 이미 출고된 주문에 1번 보내기(따라잡기): { from:'YYYY-MM-DD'(출고일 시작), at:'YYYY-MM-DDTHH:MM'(KST 보낼 시각, 08~20시) } 둘 다 있어야 켜진다. 없으면 꺼짐.
export const CATCHUP_AT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const validDate = text => /^\d{4}-\d{2}-\d{2}$/.test(text) && !Number.isNaN(Date.parse(`${text}T00:00:00Z`)) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text;
export function readCatchup(input) {
  if (!input || (!input.from && !input.at)) return { catchup_from: '', catchup_at: '', catchup_daily: null };
  const from = typeof input.from === 'string' ? input.from.trim() : '';
  const at = typeof input.at === 'string' ? input.at.trim() : '';
  if (!validDate(from)) return { error: '이미 출고된 주문의 출고일 시작일을 YYYY-MM-DD 로 입력해 주세요.', reason: 'catchup_from' };
  const m = CATCHUP_AT_RE.exec(at);
  if (!m || !validDate(at.slice(0, 10)) || Number(m[4]) < 8 || Number(m[4]) > 20 || Number(m[5]) > 59) return { error: '한 번 보낼 시각은 날짜와 08:00~20:59 사이로 입력해 주세요.', reason: 'catchup_at' };
  const rawDaily = input.daily === undefined || input.daily === null || input.daily === '' ? null : Number(input.daily);
  if (rawDaily !== null && !(Number.isInteger(rawDaily) && rawDaily >= 1 && rawDaily <= 1000)) return { error: '하루 최대 건수는 1~1000 사이 정수로 넣어 주세요(비우면 제한 없음).', reason: 'catchup_daily' };
  return { catchup_from: from, catchup_at: at, catchup_daily: rawDaily };
}

// 기준일형(납기일·출고예정일 기준): 항상 안내 문구. 일수·시작일·반복은 쓰지 않는다(days 0, repeat 1 고정).
function readEventAuto(auto, staff, body) {
  const offset = auto.offset === undefined || auto.offset === null || auto.offset === '' ? 0 : Number(auto.offset);
  if (!(Number.isInteger(offset) && offset >= -OFFSET_MAX && offset <= OFFSET_MAX)) return { error: `기준일 대비 일수는 -${OFFSET_MAX}~${OFFSET_MAX}일로 입력해 주세요.` };
  const unless = typeof auto.unless_step === 'string' ? auto.unless_step.trim() : '';
  if (unless && !STEPS.includes(unless)) return { error: '미완료 조건의 공정 이름이 올바르지 않습니다.' };
  const audience = auto.audience === undefined || auto.audience === null || auto.audience === '' ? 'customer' : auto.audience;
  if (audience !== 'customer' && audience !== 'staff' && audience !== 'sales') return { error: '받는 사람은 고객·직원·영업담당 중 하나여야 합니다.' };
  const daily = auto.daily === undefined || auto.daily === null ? '' : auto.daily;
  if (daily !== '' && daily !== 'until' && daily !== 'ongoing') return { error: '매일 반복 방식이 올바르지 않습니다.' };
  if (daily === 'until' && offset >= 0) return { error: '일 전부터 당일까지 매일은 기준일 이전(일 전)일 때만 고를 수 있습니다.', reason: 'offset' };
  const unlessMode = auto.unless_mode === undefined || auto.unless_mode === null || auto.unless_mode === '' ? 'completed' : auto.unless_mode;
  if (unlessMode !== 'completed' && unlessMode !== 'started') return { error: '미완료·미착수 조건이 올바르지 않습니다.' };
  let ids = null;
  if (audience === 'staff') {
    const list = Array.isArray(auto.staff) ? [...new Set(auto.staff.filter(item => typeof item === 'string' && item))] : [];
    if (!list.length) return { error: '받는 직원을 1명 이상 골라 주세요.' };
    if (list.length > STAFF_CAP || list.some(item => !staff.some(person => person.id === item))) return { error: '받는 직원이 올바르지 않습니다.' };
    ids = list.sort();
  }
  const picked = readAta(auto, body, auto.kind, audience); // 알림톡을 고르면 본문은 고객명만(readAta 가 검사)
  if (picked.error) return picked;
  const blocked = picked.ata ? '' : infoCheck(body, audience, auto.kind);
  if (blocked) return { error: INFO_CHECK_MESSAGE[blocked], reason: blocked };
  return { kind: auto.kind, days: 0, send_from: null, repeat: AUTO_LIMITS.defaultRepeat, interval: AUTO_LIMITS.defaultInterval, offset, unless_step: unless || null, audience, staff: ids ? JSON.stringify(ids) : null, msg_type: 'info', step: null, daily, weekdays: auto.weekdays === true, unless_mode: unless ? unlessMode : 'completed', ata: picked.ata };
}

// 가입·문의 후 N일: 항상 안내 문구·받는 사람 고객 고정. days 0~365(0 = 접수 당일). 알림톡 템플릿 id 가 있으면 알림톡으로 나간다.
function readLeadAuto(auto, body) {
  const days = auto.days === undefined || auto.days === null || auto.days === '' ? 0 : Number(auto.days);
  if (!(Number.isInteger(days) && days >= 0 && days <= TEXT_TEMPLATE_LIMITS.autoDaysMax)) return { error: `가입·문의 후 일수는 0~${TEXT_TEMPLATE_LIMITS.autoDaysMax}일로 입력해 주세요.` };
  const leadSource = auto.lead_source === undefined || auto.lead_source === null ? '' : auto.lead_source; // 대상: ''(가입·문의 모두) · 'cafe24'(회원가입) · 'airtable'(견적 문의)
  if (!LEAD_SOURCES.includes(leadSource)) return { error: '가입·문의 대상이 올바르지 않습니다.' };
  const picked = readAta(auto, body, auto.kind);
  if (picked.error) return picked;
  const blocked = picked.ata ? '' : infoCheck(body, 'customer', auto.kind, false);
  if (blocked) return { error: INFO_CHECK_MESSAGE[blocked], reason: blocked };
  return { kind: auto.kind, days, send_from: null, repeat: AUTO_LIMITS.defaultRepeat, interval: AUTO_LIMITS.defaultInterval, ...AD_EXTRA, msg_type: 'info', ata: picked.ata, lead_source: leadSource };
}

// 즉시형(주문 등록 시·공정 시작/완료 시): 항상 안내 문구. process_* 는 공정 필수. 일수·오프셋·미완료 조건·시작일·반복은 쓰지 않는다. 받는 사람·본문 검사는 기준일형과 같다.
function readInstantAuto(auto, staff, body) {
  const member = auto.kind === 'member_joined'; // 가입 안내: 공정 없음·받는 사람 고객 고정
  const step = auto.kind === 'order_created' || member ? null : (typeof auto.step === 'string' ? auto.step.trim() : '');
  if (auto.kind !== 'order_created' && !member && !STEPS.includes(step)) return { error: '공정을 골라 주세요.' };
  if (auto.audience === 'sales' && !member) return { error: '영업담당 수신은 날짜 기준 안내에서만 쓸 수 있습니다.' };
  const base = readEventAuto({ ...auto, ...(member ? { audience: 'customer', staff: null } : {}), offset: 0, unless_step: '', daily: '', weekdays: false, unless_mode: 'completed' }, staff, body);
  if (base.error) return base;
  return { ...base, kind: auto.kind, step };
}

// 입력 image → { skip } 건드리지 않음 | { clear } 지움 | { base64 } 저장 | { error }. 형식·용량 검사는 보내기와 같은 함수.
function readImage(input) {
  if (input?.image === undefined) return { skip: true };
  if (input.image === null || input.image === '') return { clear: true };
  const data = typeof input.image === 'string' ? { data: input.image } : input.image;
  const parsed = parseSendExtras({ image: data });
  if (parsed.error) return { error: parsed.error };
  return { base64: parsed.image.base64 };
}

// 저장한 새 칸 값 → 응답(auto_*) / DB 행 모양. 저장 직후 응답은 방금 검증한 값을 그대로 쓴다.
const newAutoColumns = auto => ({ auto_send_time: auto.send_time || '', auto_copy_to: auto.copy_to || '', auto_offset: auto.offset, auto_unless_step: auto.unless_step, auto_audience: auto.audience, auto_staff: auto.staff, auto_msg_type: auto.msg_type, auto_step: auto.step, auto_daily: auto.daily, auto_weekdays: auto.weekdays, auto_unless_mode: auto.unless_mode, auto_ata_template: auto.ata || '', auto_catchup_from: auto.catchup_from || '', auto_catchup_at: auto.catchup_at || '', auto_catchup_daily: auto.catchup_daily ?? null, auto_lead_source: auto.lead_source || '', auto_bms: auto.bms_json || null });
const newAutoFields = auto => ({ ...(auto.send_time ? { auto_send_time: auto.send_time } : {}), ...(auto.copy_to ? { auto_copy_to: auto.copy_to } : {}), auto_offset: auto.offset, auto_unless_step: auto.unless_step || '', auto_audience: auto.audience, auto_staff: parseStaffIds(auto.staff), auto_msg_type: auto.msg_type, ...(auto.step ? { auto_step: auto.step } : {}), ...(isEventKind(auto.kind) ? { auto_daily: auto.daily, auto_weekdays: auto.weekdays, auto_unless_mode: auto.unless_mode } : {}), ...(isLeadKind(auto.kind) || auto.ata ? { auto_ata_template: auto.ata || '' } : {}), ...(auto.ata === BMS_TEMPLATE_ID ? bmsFields(auto.bms_json) : {}), ...(isLeadKind(auto.kind) && auto.lead_source ? { auto_lead_source: auto.lead_source } : {}), ...(auto.kind === AUTO_KIND && auto.catchup_at ? { auto_catchup_from: auto.catchup_from, auto_catchup_at: auto.catchup_at, ...(auto.catchup_daily ? { auto_catchup_daily: auto.catchup_daily } : {}), auto_catchup_done: false } : {}) });

export async function listTextTemplates(db) {
  await ensureTextTemplateSchema(db);
  const out = await db.execute({
    sql: `SELECT id, name, body,
      ((image IS NOT NULL AND image <> '') OR COALESCE(images, '') NOT IN ('', '[]')) AS has_image,
      CASE WHEN COALESCE(images, '') NOT IN ('', '[]') THEN jsonb_array_length(images::jsonb) WHEN image IS NOT NULL AND image <> '' THEN 1 ELSE 0 END AS image_count,
      auto_kind, auto_days, auto_enabled, auto_send_from, auto_repeat, auto_interval, auto_offset, auto_unless_step, auto_audience, auto_staff, auto_msg_type, auto_step, auto_daily, auto_weekdays, auto_unless_mode, auto_ata_template, auto_send_time, auto_copy_to, auto_catchup_from, auto_catchup_at, auto_catchup_daily, auto_catchup_done_at, auto_lead_source, auto_bms
      FROM sms_text_templates ORDER BY name ASC`,
    args: [],
  });
  return ok({ items: (out.rows || []).map(toItem) });
}

export async function getTextTemplate(db, input) {
  const id = Number(input?.id);
  if (!(Number.isInteger(id) && id > 0)) return bad('올바른 문구가 아닙니다.');
  await ensureTextTemplateSchema(db);
  const out = await db.execute({ sql: 'SELECT id, name, body, image, images, auto_kind, auto_days, auto_enabled, auto_send_from, auto_repeat, auto_interval, auto_offset, auto_unless_step, auto_audience, auto_staff, auto_msg_type, auto_step, auto_daily, auto_weekdays, auto_unless_mode, auto_ata_template, auto_send_time, auto_copy_to, auto_catchup_from, auto_catchup_at, auto_catchup_daily, auto_catchup_done_at, auto_lead_source, auto_bms FROM sms_text_templates WHERE id = ?', args: [id] });
  const row = out.rows?.[0];
  if (!row) return bad('문구를 찾을 수 없습니다.', 404);
  const images = storedImages(row);
  const item = { id: Number(row.id), name: row.name, body: row.body, ...(images.length ? { has_image: true, image: images[0] } : {}) };
  if (images.length) { item.images = images; item.image_count = images.length; }
  if (row.auto_kind) Object.assign(item, autoFields(row));
  return ok({ item });
}

export async function saveTextTemplate(db, input, { staff, provider, fetchImpl } = {}) {
  const name = typeof input?.name === 'string' ? input.name.trim() : '';
  const body = typeof input?.body === 'string' ? input.body : '';
  if (!name || [...name].length > TEXT_TEMPLATE_LIMITS.name) return bad(`문구 이름은 1~${TEXT_TEMPLATE_LIMITS.name}자로 입력해 주세요.`);
  const bytes = byteLength(body.trim());
  if (bytes < 1 || bytes > TEXT_TEMPLATE_LIMITS.bodyBytes) return bad(`문구는 1~${TEXT_TEMPLATE_LIMITS.bodyBytes}바이트로 입력해 주세요.`);
  const hasId = input?.id !== undefined && input?.id !== null && input?.id !== '';
  const id = hasId ? Number(input.id) : null;
  if (hasId && !(Number.isInteger(id) && id > 0)) return bad('올바른 문구가 아닙니다.');
  const photo = readImage(input);
  if (photo.error) return bad(photo.error);
  const photos = readImages(input);
  if (photos.error) return bad(photos.error);
  const auto = readAuto(input, staff || staffDirectory());
  if (auto.error) return bad(auto.error, 400, auto.reason ? { reason: auto.reason } : {});
  if (!auto.skip) { // 브랜드메시지(자유형): 글자 수 검사 + 사진을 쏠라피에 올려 imageId 저장(저장 때 1회, 같은 사진이면 다시 올리지 않는다)
    if (auto.ata === BMS_TEMPLATE_ID) {
      const made = await buildBmsConfig(db, { id, auto, body, photo, photos, provider, fetchImpl });
      if (made.error) return bad(made.error, made.status || 400, made.reason ? { reason: made.reason } : {});
      auto.bms_json = made.json;
    } else auto.bms_json = null;
  }
  const hasNew = !photos.skip || !auto.skip;
  const imagesJson = photos.list?.length ? JSON.stringify(photos.list) : null;
  const photoCount = photos.skip ? (photo.base64 ? 1 : 0) : photos.list.length;
  await ensureTextTemplateSchema(db);
  const same = await db.execute({ sql: 'SELECT id FROM sms_text_templates WHERE name = ?', args: [name] });
  const sameId = same.rows?.[0] ? Number(same.rows[0].id) : null;
  if (sameId !== null && sameId !== id) return bad('같은 이름의 문구가 있습니다.', 409);
  const itemBase = { name, body: body.trim(), ...(photoCount ? { has_image: true } : {}), ...(photos.skip ? {} : { image_count: photos.list.length }) };
  if (id === null) {
    const count = await db.execute({ sql: 'SELECT COUNT(*) AS n FROM sms_text_templates', args: [] });
    if (Number(count.rows?.[0]?.n || 0) >= TEXT_TEMPLATE_LIMITS.count) return bad(`문구는 최대 ${TEXT_TEMPLATE_LIMITS.count}개까지 저장할 수 있습니다.`, 409);
    try {
      let out;
      if (hasNew) {
        // 사진 여러 장·자동 발송 칸이 있는 요청. 켜짐은 저장으로 켜지 않는다(기본 false, 켜기는 auto_toggle).
        const cols = ['name', 'body']; const args = [name, body.trim()];
        if (photo.base64 && photos.skip) { cols.push('image'); args.push(photo.base64); }
        if (imagesJson) { cols.push('images'); args.push(imagesJson); }
        if (!auto.skip) { cols.push('auto_kind', 'auto_days', 'auto_send_from', 'auto_repeat', 'auto_interval', 'auto_offset', 'auto_unless_step', 'auto_audience', 'auto_staff', 'auto_msg_type', 'auto_step', 'auto_daily', 'auto_weekdays', 'auto_unless_mode', 'auto_ata_template', 'auto_send_time', 'auto_copy_to', 'auto_catchup_from', 'auto_catchup_at', 'auto_catchup_daily', 'auto_lead_source', 'auto_bms'); args.push(auto.kind, auto.days, auto.send_from, auto.repeat, auto.interval, auto.offset, auto.unless_step, auto.audience, auto.staff, auto.msg_type, auto.step, auto.daily, auto.weekdays, auto.unless_mode, auto.ata || '', auto.send_time || '', auto.copy_to || '', auto.catchup_from || '', auto.catchup_at || '', auto.catchup_daily ?? null, auto.lead_source || '', auto.bms_json || null); }
        out = await db.execute({ sql: `INSERT INTO sms_text_templates (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) RETURNING id`, args });
      } else {
        out = photo.base64
          ? await db.execute({ sql: 'INSERT INTO sms_text_templates (name, body, image) VALUES (?, ?, ?) RETURNING id', args: [name, body.trim(), photo.base64] })
          : await db.execute({ sql: 'INSERT INTO sms_text_templates (name, body) VALUES (?, ?) RETURNING id', args: [name, body.trim()] });
      }
      const item = { id: Number(out.rows?.[0]?.id), ...itemBase };
      if (auto.kind) { item.auto_kind = auto.kind; item.auto_days = auto.days; item.auto_enabled = false; if (auto.send_from) item.auto_send_from = auto.send_from; item.auto_repeat = auto.repeat; item.auto_interval = auto.interval; Object.assign(item, newAutoFields(auto)); }
      return ok({ item }, 201);
    } catch (error) {
      if (error?.code === '23505') return bad('같은 이름의 문구가 있습니다.', 409);
      throw error;
    }
  }
  const found = await db.execute({ sql: 'SELECT id FROM sms_text_templates WHERE id = ?', args: [id] });
  if (!found.rows?.[0]) return bad('문구를 찾을 수 없습니다.', 404);
  let disabled = false;
  let returned = null;
  try {
    // 켜진 자동 발송 문구의 본문·일수·사진이 바뀌면 끈다(다시 켤 때 확인을 다시 거치게). 바뀐 게 없으면 아무 행도 안 건드린다.
    const changed = ['body IS DISTINCT FROM ?']; const guardArgs = [name, body.trim(), id, body.trim()];
    if (!auto.skip) {
      changed.push('auto_kind IS DISTINCT FROM ?', 'auto_days IS DISTINCT FROM ?', 'auto_send_from IS DISTINCT FROM ?', 'auto_repeat IS DISTINCT FROM ?', 'auto_interval IS DISTINCT FROM ?');
      guardArgs.push(auto.kind, auto.days, auto.send_from, auto.repeat, auto.interval);
      changed.push('auto_offset IS DISTINCT FROM ?', 'auto_unless_step IS DISTINCT FROM ?', 'auto_audience IS DISTINCT FROM ?', 'auto_staff IS DISTINCT FROM ?');
      guardArgs.push(auto.offset, auto.unless_step, auto.audience, auto.staff);
      changed.push('auto_step IS DISTINCT FROM ?'); guardArgs.push(auto.step);
      changed.push('auto_daily IS DISTINCT FROM ?', 'auto_weekdays IS DISTINCT FROM ?', 'auto_unless_mode IS DISTINCT FROM ?'); guardArgs.push(auto.daily, auto.weekdays, auto.unless_mode);
      changed.push("COALESCE(auto_ata_template, '') IS DISTINCT FROM ?"); guardArgs.push(auto.ata || '');
      changed.push("COALESCE(auto_send_time, '') IS DISTINCT FROM ?"); guardArgs.push(auto.send_time || '');
      if (auto.ata) { // 일괄 발송 값만 바뀐 저장은 광고 문구의 켜짐을 끄지 않는다(알림톡 문구는 지금처럼)
        changed.push("COALESCE(auto_catchup_from, '') IS DISTINCT FROM ?", "COALESCE(auto_catchup_at, '') IS DISTINCT FROM ?"); guardArgs.push(auto.catchup_from || '', auto.catchup_at || '');
        changed.push('auto_catchup_daily IS DISTINCT FROM ?'); guardArgs.push(auto.catchup_daily ?? null);
      }
      changed.push("COALESCE(auto_lead_source, '') IS DISTINCT FROM ?"); guardArgs.push(auto.lead_source || '');
      changed.push("COALESCE(auto_bms, '') IS DISTINCT FROM ?"); guardArgs.push(auto.bms_json || '');
    }
    if (!photos.skip) { changed.push("COALESCE(images, '') IS DISTINCT FROM ?"); guardArgs.push(imagesJson || ''); }
    else if (!photo.skip) { changed.push("COALESCE(image, '') IS DISTINCT FROM ?"); guardArgs.push(photo.base64 || ''); }
    const guard = await db.execute({
      sql: `UPDATE sms_text_templates SET name = ?, body = ?, auto_enabled = false WHERE id = ? AND auto_enabled = true AND (${changed.join(' OR ')}) RETURNING id, auto_kind`,
      args: guardArgs,
    });
    disabled = Boolean(guard.rows?.[0]?.auto_kind);
    if (hasNew) {
      const sets = ['name = ?', 'body = ?']; const args = [name, body.trim()];
      if (!photos.skip) { sets.push('images = ?', 'image = NULL'); args.push(imagesJson); }
      else if (!photo.skip) { sets.push('image = ?'); args.push(photo.base64 || null); }
      if (!auto.skip) { sets.push('auto_kind = ?', 'auto_days = ?', 'auto_send_from = ?', 'auto_repeat = ?', 'auto_interval = ?', 'auto_offset = ?', 'auto_unless_step = ?', 'auto_audience = ?', 'auto_staff = ?', 'auto_msg_type = ?', 'auto_step = ?', 'auto_daily = ?', 'auto_weekdays = ?', 'auto_unless_mode = ?', 'auto_ata_template = ?', 'auto_send_time = ?', 'auto_copy_to = ?', 'auto_catchup_paused_at = NULL', 'auto_catchup_error = NULL', 'auto_ata_fail_at = NULL', "auto_catchup_done_at = CASE WHEN COALESCE(auto_catchup_from, '') IS DISTINCT FROM ? OR COALESCE(auto_catchup_at, '') IS DISTINCT FROM ? THEN NULL ELSE auto_catchup_done_at END", 'auto_catchup_from = ?', 'auto_catchup_at = ?', 'auto_catchup_daily = ?', 'auto_lead_source = ?', 'auto_bms = ?'); args.push(auto.kind, auto.days, auto.send_from, auto.repeat, auto.interval, auto.offset, auto.unless_step, auto.audience, auto.staff, auto.msg_type, auto.step, auto.daily, auto.weekdays, auto.unless_mode, auto.ata || '', auto.send_time || '', auto.copy_to || '', auto.catchup_from || '', auto.catchup_at || '', auto.catchup_from || '', auto.catchup_at || '', auto.catchup_daily ?? null, auto.lead_source || '', auto.bms_json || null); if (!auto.kind) sets.push('auto_enabled = false'); }
      args.push(id);
      const out = await db.execute({ sql: `UPDATE sms_text_templates SET ${sets.join(', ')}, updated_at = NOW() WHERE id = ? RETURNING id, auto_kind, auto_days, auto_enabled, auto_send_from, auto_repeat, auto_interval, auto_offset, auto_unless_step, auto_audience, auto_staff, auto_msg_type, auto_step, auto_daily, auto_weekdays, auto_unless_mode, auto_ata_template, auto_send_time, auto_copy_to, auto_catchup_from, auto_catchup_at, auto_catchup_daily, auto_catchup_done_at, auto_lead_source, auto_catchup_paused_at, auto_catchup_error, auto_bms`, args });
      returned = out.rows?.[0] || null;
    } else if (photo.skip) await db.execute({ sql: 'UPDATE sms_text_templates SET name = ?, body = ?, updated_at = NOW() WHERE id = ? RETURNING id', args: [name, body.trim(), id] });
    else await db.execute({ sql: 'UPDATE sms_text_templates SET name = ?, body = ?, image = ?, updated_at = NOW() WHERE id = ? RETURNING id', args: [name, body.trim(), photo.base64 || null, id] });
  } catch (error) {
    if (error?.code === '23505') return bad('같은 이름의 문구가 있습니다.', 409);
    throw error;
  }
  const item = { id, ...itemBase };
  if (returned?.auto_kind) Object.assign(item, autoFields(auto.skip ? returned : { ...returned, ...newAutoColumns(auto) }));
  if (disabled) { item.auto_enabled = false; item.auto_disabled = true; }
  return ok({ item });
}

// 브랜드메시지(자유형) 저장 준비 → { json } | { error, status?, reason? }
// 사진: 1장만(여러 장이면 화면이 한 장으로 합친다). 같은 사진(sig 같음)이면 저장돼 있는 imageId 를 그대로 쓰고, 새 사진일 때만 쏠라피 type 'BMS' 로 올린다.
async function buildBmsConfig(db, { id, auto, body, photo, photos, provider, fetchImpl }) {
  let images = [];
  let prevRaw = null;
  if (id !== null) {
    await ensureTextTemplateSchema(db);
    const row = (await db.execute({ sql: 'SELECT image, images, auto_bms FROM sms_text_templates WHERE id = ?', args: [id] })).rows?.[0];
    prevRaw = row?.auto_bms || null;
    if (photos.skip && photo.skip) images = storedImages(row);
  }
  if (!photos.skip) images = photos.list;
  else if (!photo.skip) images = photo.base64 ? [photo.base64] : [];
  if (images.length > 1) return { error: '브랜드메시지는 사진을 1장만 보낼 수 있습니다. 여러 장이면 한 장으로 합쳐 주세요.', reason: 'bms_images' };
  const textError = bmsTextError(body, images.length === 1);
  if (textError) return { error: textError, reason: 'bms_too_long' };
  const prev = parseBmsConfig(prevRaw);
  const cfg = { pfId: prev.pfId || BMS_PF_ID, from: prev.from || BMS_SENDER, buttons: auto.bms.buttons, imageId: '', imageSig: '' };
  if (images.length === 1) {
    const ratioError = bmsImageRatioError(images[0]);
    if (ratioError) return { error: ratioError, reason: 'bms_image_ratio' };
    const sig = bmsImageSig(images[0]);
    if (prev.imageId && prev.imageSig === sig) Object.assign(cfg, { imageId: prev.imageId, imageSig: sig });
    else {
      const vendor = provider || getSendProvider();
      if (!vendor || typeof vendor.uploadImage !== 'function') return { error: '발송 업체가 설정되지 않아 사진을 올릴 수 없습니다.', status: 503 };
      let fileId = '';
      try { fileId = (await vendor.uploadImage({ base64: images[0], name: 'bms.jpg', type: 'BMS' }, { fetchImpl }))?.fileId || ''; } catch { fileId = ''; }
      if (!fileId) return { error: '사진을 올리지 못했습니다. 다시 시도해 주세요.', status: 502 };
      Object.assign(cfg, { imageId: fileId, imageSig: sig });
    }
  }
  return { json: JSON.stringify(cfg) };
}

export async function deleteTextTemplate(db, input) {
  const id = Number(input?.id);
  if (!(Number.isInteger(id) && id > 0)) return bad('올바른 문구가 아닙니다.');
  await ensureTextTemplateSchema(db);
  const out = await db.execute({ sql: 'DELETE FROM sms_text_templates WHERE id = ? RETURNING id', args: [id] });
  if (!out.rows?.[0]) return bad('문구를 찾을 수 없습니다.', 404);
  return ok({ deleted: true, id });
}
