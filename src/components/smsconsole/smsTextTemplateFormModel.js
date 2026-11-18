// 문자 템플릿 등록 양식·내 문구 묶음의 순수 계산(화면 없음).
import { IMAGE_MAX_EDGE, textInfo } from './sendPanelModel.js';
import { autoEffective } from '../../../shared/smsAutoEffective.js';
import { BMS_TEMPLATE_ID, bmsButtonsCheck, bmsTextError } from '../../../shared/smsBmsLimits.js';

export { BMS_TEMPLATE_ID };
export const isBmsAta = (ataTemplate) => ataTemplate === BMS_TEMPLATE_ID; // 수단이 브랜드메시지(자유형)인지
// 발송 조건 줄의 수단 이름
// 일괄 발송 안내의 시간 문구(대상 미리보기 응답 info). 하루 상한 때문에 하루를 넘으면 첫날 분량과 일수를 같이 쓴다.
export const catchupSpanText = (info) => (Number(info?.days_needed) > 1
  ? `첫날 약 ${info.eta_minutes}분, 하루 ${info.daily_max}건씩 약 ${info.days_needed}일이 걸립니다`
  : `시작 후 약 ${info?.eta_minutes}분 안에 모두 나갑니다`);

export const viaLabel = (entry) => (entry?.autoAtaTemplate === BMS_TEMPLATE_ID ? '브랜드메시지' : entry?.autoAtaTemplate ? '알림톡' : '');

export const TEXT_NAME_MAX = 40;
export const KIND_SMS = 'sms';
export const KIND_KAKAO = 'kakao';

// 주소의 kind 값 → 'sms' | 'kakao'. 없거나 모르는 값은 문자(처음 선택).
export const normalizeKind = value => (value === KIND_KAKAO ? KIND_KAKAO : KIND_SMS);

// 양식 값 → { ok, reason, info }. 글자 수·SMS/LMS 판정은 보내기 화면과 같은 textInfo.
export function validateTextForm({ name, body, autoKind, days, sendFrom, repeat, interval, offsetDir, offsetDays, daily, audience: audienceIn, staff, step, ataTemplate = '', catchupOn = false, catchupFrom = '', catchupAt = '', catchupDaily = '', copyTo = '', imageCount = 0, bmsButtons = [] }) {
  const audience = ataTemplate ? 'customer' : audienceIn; // 알림톡은 고객에게만 간다
  const trimmed = String(name || '').trim();
  const info = textInfo(body);
  if (!trimmed) return { ok: false, reason: 'name', info };
  if ([...trimmed].length > TEXT_NAME_MAX) return { ok: false, reason: 'name', info };
  if (!info.type) return { ok: false, reason: 'body', info };
  if (info.tooLong) return { ok: false, reason: 'long', info };
  if (isBmsAta(ataTemplate)) { // 브랜드메시지(자유형): 이미지와 함께면 400자·줄바꿈 29, 글만이면 1300자·줄바꿈 99, 사진 1장, 버튼 이름 14자·링크 https·최대 5개
    if (Number(imageCount) > 1) return { ok: false, reason: 'bms_images', info };
    if (bmsTextError(body, Number(imageCount) === 1)) return { ok: false, reason: 'bms_too_long', info, detail: bmsTextError(body, Number(imageCount) === 1) };
    if (bmsButtonsCheck(bmsButtons).error) return { ok: false, reason: 'bms_button', info, detail: bmsButtonsCheck(bmsButtons).error };
  }
  { const allowed = autoVariables(autoKind, audience, ataTemplate); if (bodyVarNames(body).some(item => !allowed.includes(item))) return { ok: false, reason: 'info_unknown_var', info }; }
  if (isImmediateKind(autoKind)) {
    if (autoKind !== AUTO_KIND_ORDER_CREATED && !step) return { ok: false, reason: 'step', info };
    if (audience === AUDIENCE_STAFF && !(Array.isArray(staff) && staff.length)) return { ok: false, reason: 'staff', info };
  } else if (isDateKind(autoKind)) {
    if (normalizeOffset(offsetDir, offsetDays, daily) === null) return { ok: false, reason: 'offset', info };
    if (audience === AUDIENCE_STAFF && !(Array.isArray(staff) && staff.length)) return { ok: false, reason: 'staff', info };
  } else if (autoKind === AUTO_KIND_MEMBER_JOINED) {
    // 이름·본문만 본다
  } else if (autoKind === AUTO_KIND_LEAD_PLUS) {
    if (normalizeLeadDays(days) === null) return { ok: false, reason: 'offset', info };
  } else if (AUTO_KINDS.includes(autoKind)) {
    if (autoKind === AUTO_KIND_PROCESS_PLUS && !step) return { ok: false, reason: 'step', info };
    if (normalizeDays(days) === null) return { ok: false, reason: 'days', info };
    if (normalizeSendFrom(sendFrom) === null) return { ok: false, reason: 'sendFrom', info };
    const times = normalizeRepeat(repeat ?? '1');
    if (times === null) return { ok: false, reason: 'repeat', info };
    if (times >= 2 && normalizeInterval(interval ?? '30') === null) return { ok: false, reason: 'interval', info };
    if (!ataTemplate && String(copyTo || '').trim() && !/^01[016789]\d{7,8}$/.test(String(copyTo).replace(/\D/g, ''))) return { ok: false, reason: 'copyTo', info };
  }
  if (catchupOn && autoKind === AUTO_KIND) { // 이미 출고된 주문에 한 번 보내기: 출고일 시작일 + 보낼 시각(날짜·시각, 08~20시)
    if (!normalizeSendFrom(catchupFrom)) return { ok: false, reason: 'catchup_from', info };
    const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})$/.exec(String(catchupAt || ''));
    if (!m || normalizeSendFrom(m[1]) === null || Number(m[2]) < 8 || Number(m[2]) > (isBmsAta(ataTemplate) ? 19 : 20)) return { ok: false, reason: 'catchup_at', info };
    if (String(catchupDaily ?? '').trim() !== '' && !(/^\d+$/.test(String(catchupDaily).trim()) && Number(catchupDaily) >= 1 && Number(catchupDaily) <= 1000)) return { ok: false, reason: 'catchup_daily', info };
  }
  return { ok: true, reason: '', info };
}

// 사진 여러 장을 한 장으로 합칠 때의 배치 계산(순수). sizes=[{width,height}], 가로로 긴 사진이 하나라도 있으면 위→아래, 아니면 왼쪽→오른쪽.
// 이어 붙인 크기를 긴 변 maxEdge 안으로 줄인다. → { mode, width, height, rects:[{x,y,w,h}] }
export function mergeLayout(sizes, { maxEdge = IMAGE_MAX_EDGE } = {}) {
  const list = (Array.isArray(sizes) ? sizes : []).filter((s) => s && s.width > 0 && s.height > 0);
  if (!list.length) return { mode: 'row', width: 0, height: 0, rects: [] };
  const stack = list.some((s) => s.width / s.height > 1.1);
  const base = stack ? Math.min(...list.map((s) => s.width)) : Math.min(...list.map((s) => s.height));
  const raw = list.map((s) => (stack ? { w: base, h: (s.height * base) / s.width } : { w: (s.width * base) / s.height, h: base }));
  const total = stack ? { w: base, h: raw.reduce((a, r) => a + r.h, 0) } : { w: raw.reduce((a, r) => a + r.w, 0), h: base };
  const k = Math.max(total.w, total.h) > maxEdge ? maxEdge / Math.max(total.w, total.h) : 1;
  let at = 0;
  const rects = raw.map((r) => {
    const w = Math.max(1, Math.round(r.w * k)); const h = Math.max(1, Math.round(r.h * k));
    const rect = stack ? { x: 0, y: at, w, h } : { x: at, y: 0, w, h };
    at += stack ? h : w;
    return rect;
  });
  return { mode: stack ? 'column' : 'row', width: stack ? Math.max(...rects.map((r) => r.w)) : at, height: stack ? at : Math.max(...rects.map((r) => r.h)), rects };
}

export const IMAGE_MAX = 3;
export const AUTO_KIND = 'ship_plus_days';
export const AUTO_KIND_ORDER = 'order_plus_days';
export const AUTO_KIND_PROCESS_PLUS = 'process_started_plus_days'; // 공정 시작일+N일(설비 진입 후 N일 등). 공정 선택이 필요하다
export const AUTO_KIND_DUE = 'due_date';
export const AUTO_KIND_SHIP_PLAN = 'ship_scheduled';
export const AUTO_KIND_SHIP_OR_DUE = 'ship_or_due';
export const DATE_KINDS = [AUTO_KIND_DUE, AUTO_KIND_SHIP_PLAN, AUTO_KIND_SHIP_OR_DUE];
export const AUTO_KIND_ORDER_CREATED = 'order_created';
export const AUTO_KIND_PROCESS_STARTED = 'process_started';
export const AUTO_KIND_PROCESS_COMPLETED = 'process_completed';
export const IMMEDIATE_KINDS = [AUTO_KIND_ORDER_CREATED, AUTO_KIND_PROCESS_STARTED, AUTO_KIND_PROCESS_COMPLETED];
export const AUTO_KIND_MEMBER_JOINED = 'member_joined';
export const AUTO_KIND_LEAD_PLUS = 'lead_plus_days';
// 가입·문의 후 대상(접수 표 source): ''(가입·문의 모두) · 'cafe24'(회원가입) · 'airtable'(견적 문의)
export const LEAD_SOURCES = ['', 'cafe24', 'airtable'];
export const LEAD_SOURCE_OPTION_LABEL = { '': '가입·문의 모두', cafe24: '회원가입만', airtable: '견적 문의만' };
export const LEAD_SOURCE_FLOW_LABEL = { '': '가입·문의', cafe24: '회원가입', airtable: '견적 문의' };
export const AUTO_KINDS = [AUTO_KIND, AUTO_KIND_ORDER, AUTO_KIND_PROCESS_PLUS, ...DATE_KINDS, ...IMMEDIATE_KINDS, AUTO_KIND_MEMBER_JOINED, AUTO_KIND_LEAD_PLUS];
export const AUDIENCE_STAFF = 'staff';
export const AUDIENCE_SALES = 'sales';
// 광고 문구로 저장되는 종류(서버 auto_msg_type 'ad' = 출고 완료 후·주문 등록 후)
// 출고 완료 후·주문 등록 후 + 알림톡을 고르면 광고가 아니라 정보성 알림톡이다(ataTemplate 를 넘기면 광고 표기 대상에서 뺀다)
export const isAdKind = (kind, ataTemplate = '') => (kind === AUTO_KIND || kind === AUTO_KIND_ORDER || kind === AUTO_KIND_PROCESS_PLUS) && !ataTemplate;
const AD_OPTOUT_LINE = '무료수신거부 080-500-4233';
const AD_OPTOUT_RE = /무료\s*수신\s*거부[^\n]*080[-\d]{7,}/;
// 광고 표기: 맨 앞 "(광고)"와 080 무료수신거부 줄이 없으면 붙인 본문을 돌려준다(있으면 그대로). 서버 adCheck 를 통과하는 모양.
export function withAdFormat(body) {
  const raw = String(body ?? '');
  if (!raw.trim()) return raw;
  let text = raw;
  if (!text.replace(/\r\n?/g, '\n').trim().startsWith('(광고)')) text = `(광고) ${text.trimStart()}`;
  if (!AD_OPTOUT_RE.test(text)) text = `${text.replace(/\s+$/, '')}\n\n${AD_OPTOUT_LINE}`;
  return text;
}
// 사진 순서: index 번째를 바로 앞 사진과 자리 바꾼 새 배열(첫 사진·범위 밖이면 그대로)
export function moveImageEarlier(images, index) {
  const list = Array.isArray(images) ? images : [];
  if (!(index > 0 && index < list.length)) return list;
  const next = list.slice();
  [next[index - 1], next[index]] = [next[index], next[index - 1]];
  return next;
}
export const isDateKind = (kind) => DATE_KINDS.includes(kind);
export const isImmediateKind = (kind) => IMMEDIATE_KINDS.includes(kind);
export const AUTO_DEFAULT_DAYS = 20;
export const AUTO_DEFAULT_REPEAT = 1;
export const AUTO_DEFAULT_INTERVAL = 30;
const AUTO_LABEL = { [AUTO_KIND]: '출고 완료 후', [AUTO_KIND_ORDER]: '주문 등록 후', [AUTO_KIND_PROCESS_PLUS]: '공정 시작 후', [AUTO_KIND_DUE]: '납기일', [AUTO_KIND_SHIP_PLAN]: '출고예정일', [AUTO_KIND_SHIP_OR_DUE]: '출고·납기일', [AUTO_KIND_ORDER_CREATED]: '주문 등록 시', [AUTO_KIND_PROCESS_STARTED]: '공정 시작 시', [AUTO_KIND_PROCESS_COMPLETED]: '공정 완료 시', [AUTO_KIND_MEMBER_JOINED]: '자사몰 회원가입 시', [AUTO_KIND_LEAD_PLUS]: '가입·문의' };

// 기준일형: 방향('before' 일 전 | 'same' 당일 | 'after' 일 지남) + 일수 → 부호 있는 정수(전 = 음수), 잘못이면 null. 매일 반복(daily)은 별도 체크
export const dirDaily = (dir, daily) => (daily ? (dir === 'before' ? 'until' : 'ongoing') : '');
export function normalizeOffset(dir, value, daily) {
  if (dir === 'same') return 0;
  const text = String(value ?? '').trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const n = Number(text);
  if (n > 365 || (dir !== 'before' && dir !== 'after')) return null;
  if (dir === 'before' && daily && n === 0) return null;
  return dir === 'before' ? -n : n;
}
// 부호 있는 정수(+ 서버의 daily 값) → { dir, days, daily }
export const offsetParts = (offset, daily) => {
  const n = Number(offset) || 0;
  return { dir: n < 0 ? 'before' : (n > 0 ? 'after' : 'same'), days: String(Math.abs(n)), daily: daily === 'until' || daily === 'ongoing' };
};
const offsetText = (offset, daily) => {
  const n = Number(offset) || 0;
  if (daily === 'until') return `${-n}일 전부터 당일까지 매일`;
  if (daily === 'ongoing') return n > 0 ? `${n}일 지난 뒤 매일` : '당일부터 매일';
  return n === 0 ? '당일' : (n < 0 ? `${-n}일 전` : `${n}일 지남`);
};

// 본문에 넣을 수 있는 변수(고른 종류·받는 사람 기준). 1단계 광고 2종은 고객명만.
export function autoVariables(kind, audience, ataTemplate = '') {
  if (ataTemplate && AUTO_KINDS.includes(kind)) return ['고객명']; // 알림톡은 변수가 고객명 하나(모든 조건 공통)
  if (kind === AUTO_KIND_MEMBER_JOINED) return [];
  if (kind === AUTO_KIND_LEAD_PLUS) return ['고객명'];
  if (!isDateKind(kind) && !isImmediateKind(kind)) return AUTO_KINDS.includes(kind) || !kind ? ['고객명'] : [];
  const list = ['고객명', '주문번호', '규격', '수량', '예상출고일', '조회링크'];
  return audience === AUDIENCE_STAFF || audience === AUDIENCE_SALES ? [...list, '제품'] : list;
}

// 본문의 #{이름} 이름들(중복 없이)
export const bodyVarNames = body => [...new Set([...String(body ?? '').matchAll(/#\{([^}]+)\}/g)].map(m => m[1]))];
// 미리보기용 예시 값(api/_lib/smsEventSend.js EXAMPLE_ORDER·orderVars 와 같은 값)
export const PREVIEW_VARS = Object.freeze({ 고객명: '홍길동', 주문번호: 'HS-2026-0001', 규격: '슬라이딩 1200×600×1800mm', 수량: '1대', 예상출고일: '2026-11-23', 조회링크: 'https://production-status.vercel.app/track/EXAMPLE', 제품: '쇼케이스' });
// #{이름} 을 예시 값으로 바꾼다(모르는 이름은 그대로). 저장되는 본문은 바꾸지 않는다.
export const previewFill = body => String(body ?? '').replace(/#\{([^}]+)\}/g, (all, name) => (Object.prototype.hasOwnProperty.call(PREVIEW_VARS, name) ? PREVIEW_VARS[name] : all));

// 반복 횟수 1~10, 간격 1~365 정수, 아니면 null
export function normalizeRepeat(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,2}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 10 ? n : null;
}
export function normalizeInterval(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const n = Number(text);
  return n >= 1 && n <= 365 ? n : null;
}
// 시작일 칸 → '' (없음) | 'YYYY-MM-DD' | null (잘못됨)
export function normalizeSendFrom(value) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (!m) return null;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]) ? text : null;
}

// 가입·문의 후 일수 칸 → 0~365 정수, 아니면 null
export function normalizeLeadDays(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const days = Number(text);
  return days <= 365 ? days : null;
}

// 일수 칸 → 1~365 정수, 아니면 null
export function normalizeDays(value) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,3}$/.test(text)) return null;
  const days = Number(text);
  return days >= 1 && days <= 365 ? days : null;
}

// [등록]을 눌렀는데 못 넘어갈 때 버튼 위에 보일 한 줄(버튼을 꺼 두지 않고 이유를 알려 준다)
export function textFormStopText(reason) {
  if (reason === 'name') return '이름을 입력해 주세요';
  if (reason === 'body') return '내용을 입력해 주세요';
  if (reason === 'long') return '내용이 너무 깁니다';
  if (reason === 'days') return '일수는 1부터 365 사이로 넣어 주세요';
  if (reason === 'sendFrom') return '시작일은 날짜로 넣어 주세요';
  if (reason === 'repeat') return '횟수는 1부터 10 사이로 넣어 주세요';
  if (reason === 'interval') return '간격은 1부터 365 사이로 넣어 주세요';
  if (reason === 'copyTo') return '사본 받을 번호는 휴대폰 번호로 넣어 주세요';
  if (reason === 'offset') return '일수는 0부터 365 사이로 넣어 주세요';
  if (reason === 'step') return '공정을 골라 주세요';
  if (reason === 'dup') return '같은 일수 단계가 있습니다';
  if (reason === 'cafe24_not_connected') return '카페24 연결이 아직 안 됐습니다';
  if (reason === 'lead_source_not_connected') return '가입·문의 정보 연결이 아직 안 됐습니다.';
  if (reason === 'ata_not_ready') return '선택한 알림톡 템플릿이 아직 쓸 수 없는 상태입니다.';
  if (reason === 'ata_customer_only') return '알림톡은 고객에게만 보낼 수 있습니다';
  if (reason === 'catchup_from') return '이미 출고된 주문의 출고일 시작일을 날짜로 넣어 주세요';
  if (reason === 'catchup_daily') return '하루 최대 건수는 1~1000 사이 숫자로 넣어 주세요(비우면 제한 없음)';
  if (reason === 'catchup_at') return '한 번 보낼 시각을 날짜와 오전 8시~오후 8시 사이로 넣어 주세요';
  if (reason === 'bms_images') return '브랜드메시지는 사진을 1장만 보낼 수 있습니다(여러 장은 한 장으로 합쳐 주세요)';
  if (reason === 'bms_too_long') return '브랜드메시지 글자 수를 넘었습니다(이미지와 함께면 400자, 글만이면 1300자)';
  if (reason === 'bms_button') return '버튼은 이름(14자까지)과 https:// 링크를 함께 넣어 주세요(최대 5개)';
  if (reason === 'bms_image_ratio') return '브랜드메시지 이미지는 가로:세로가 2:1에서 3:4 사이여야 합니다';
  if (reason === 'bms_not_ready') return '브랜드메시지 설정(사진·글자 수)이 맞지 않습니다. 문구를 다시 저장해 주세요';
  if (reason === 'staff') return '받을 직원을 한 명 이상 골라 주세요';
  if (reason === 'info_has_ad_words') return '안내 문구에는 할인·이벤트 같은 광고 낱말을 쓸 수 없습니다';
  if (reason === 'info_needs_order_var') return '안내 문구에는 주문 변수가 하나 이상 있어야 합니다';
  if (reason === 'info_unknown_var') return '이 문구에서 쓸 수 없는 변수가 들어 있습니다';
  return '';
}

// 저장 요청 본문. 사진이 없으면 image·images 칸을 아예 넣지 않는다. 새 양식은 images(최대 3장)로 보낸다.
export function buildSaveBody({ id, name, body, image, images, auto }) {
  const list = (Array.isArray(images) ? images : []).filter((item) => item?.data).slice(0, IMAGE_MAX);
  const autoBody = (a) => {
    if (!AUTO_KINDS.includes(a.kind)) return { kind: '' };
    const bmsOut = a.ataTemplate === BMS_TEMPLATE_ID ? { bms: { buttons: (Array.isArray(a.bmsButtons) ? a.bmsButtons : []).filter((b) => b && (b.name || b.link)).map((b) => ({ name: String(b.name || ''), link: String(b.link || '') })) } } : {}; // 브랜드메시지(자유형)의 버튼
    const ata = a.ataTemplate ? { ata_template: String(a.ataTemplate), ...bmsOut } : {}; // 알림톡을 고르면 모든 조건에서 받는 사람은 고객
    if (a.kind === AUTO_KIND_MEMBER_JOINED) return { kind: a.kind, ...ata };
    if (a.kind === AUTO_KIND_LEAD_PLUS) return { kind: a.kind, days: normalizeLeadDays(a.days), ata_template: String(a.ataTemplate || ''), ...bmsOut, ...(a.leadSource === 'cafe24' || a.leadSource === 'airtable' ? { lead_source: a.leadSource } : {}) };
    if (isImmediateKind(a.kind)) {
      const staffAudience = a.audience === AUDIENCE_STAFF && !a.ataTemplate;
      return { kind: a.kind, step: a.kind === AUTO_KIND_ORDER_CREATED ? '' : String(a.step || ''), audience: staffAudience ? AUDIENCE_STAFF : 'customer', staff: staffAudience && Array.isArray(a.staff) ? a.staff : [], ...ata };
    }
    if (isDateKind(a.kind)) {
      const staffAudience = a.audience === AUDIENCE_STAFF && !a.ataTemplate;
      const salesAudience = a.audience === AUDIENCE_SALES && !a.ataTemplate;
      const daily = dirDaily(a.offsetDir, a.daily);
      return {
        kind: a.kind,
        offset: normalizeOffset(a.offsetDir, a.offsetDays, a.daily),
        ...(daily ? { daily } : {}),
        ...(a.weekdays ? { weekdays: true } : {}),
        unless_step: String(a.unlessStep || ''),
        ...(a.unlessStep && a.unlessMode === 'started' ? { unless_mode: 'started' } : {}),
        audience: staffAudience ? AUDIENCE_STAFF : (salesAudience ? AUDIENCE_SALES : 'customer'),
        staff: staffAudience && Array.isArray(a.staff) ? a.staff : [],
        ...ata,
      };
    }
    const out = { kind: a.kind, days: normalizeDays(a.days) };
    if (a.kind === AUTO_KIND_PROCESS_PLUS) out.step = String(a.step || ''); // 어느 공정의 시작일 기준인지
    if (a.ataTemplate) Object.assign(out, ata);
    if (a.kind === AUTO_KIND && a.catchupOn && a.catchupFrom && a.catchupAt) out.catchup = { from: String(a.catchupFrom), at: String(a.catchupAt), ...(String(a.catchupDaily ?? '').trim() ? { daily: Number(a.catchupDaily) } : {}) }; // 이미 출고된 주문에 한 번 보내기(꺼져 있으면 칸 자체를 보내지 않는다)
    if (a.sendFrom !== undefined) out.send_from = normalizeSendFrom(a.sendFrom) || null;
    if (a.repeat !== undefined) out.repeat = normalizeRepeat(a.repeat) ?? AUTO_DEFAULT_REPEAT;
    if (a.interval !== undefined) out.interval = normalizeInterval(a.interval) ?? AUTO_DEFAULT_INTERVAL;
    return out;
  };
  // 시각은 값이 넘어왔을 때만 싣는다: 시각이 뜻을 갖는 조건이면 고른 값(없으면 빈 값), 그 밖은 빈 값
  const autoOut = (a) => {
    const o = autoBody(a);
    if (!o.kind) return o;
    const r = a.sendTime !== undefined ? { ...o, auto_send_time: hasSendTime(a.kind, a.days) && SEND_TIMES.includes(a.sendTime) ? a.sendTime : '' } : o;
    // 사본 번호(2026-11-17): 값이 넘어왔을 때만 싣는다. 출고·주문 후 N일 문자(알림톡 제외)만 뜻이 있고 그 밖은 빈 값
    return a.copyTo !== undefined ? { ...r, auto_copy_to: (a.kind === AUTO_KIND || a.kind === AUTO_KIND_ORDER) && !a.ataTemplate ? String(a.copyTo || '').replace(/\D/g, '') : '' } : r;
  };
  return {
    ...(id ? { id } : {}),
    name: String(name || '').trim(),
    body: String(body || ''),
    ...(image?.data ? { image: { data: image.data } } : {}),
    ...(list.length ? { images: list.map((item) => ({ data: item.data })) } : {}),
    ...(auto ? { auto: autoOut(auto) } : {}),
  };
}

// ---------- 자동 발송 문구(카드) ----------
const joinDot = (...parts) => parts.filter(Boolean).join(' · ');
const won = (value) => `${Number(value || 0).toLocaleString('ko-KR')}원`;
const shortDate = (value) => { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(value || '')); return m ? `${Number(m[1])}/${Number(m[2])}` : ''; };

// ---------- 발송 시각(날짜형 조건) · 흐름의 단계 ----------
export const SEND_TIMES = Array.from({ length: 23 }, (_, i) => `${String(9 + Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
// 'HH:MM'(09:00~20:00, 30분 단위) → '오전 9:00' · '오후 2:30'. 목록 밖 값·빈 값이면 ''.
export function sendTimeLabel(time) {
  if (!SEND_TIMES.includes(time)) return '';
  const hour = Number(time.slice(0, 2));
  return `${hour < 12 ? '오전' : '오후'} ${hour > 12 ? hour - 12 : hour}:${time.slice(3)}`;
}
// 시각 칸이 뜻을 갖는 조건: 날짜형·출고 완료 후·주문 등록 후, 가입·문의 후(일수 1 이상). 즉시형·회원가입 시는 없다.
export const hasSendTime = (kind, days) => (kind === AUTO_KIND_LEAD_PLUS ? (normalizeLeadDays(days) ?? 0) >= 1 : kind === AUTO_KIND || kind === AUTO_KIND_ORDER || kind === AUTO_KIND_PROCESS_PLUS || isDateKind(kind));
// 사장님이 고르지 않았을 때 칸에 골라져 보이는 값(가입·문의 후 09:30, 그 밖 날짜형 10:00)
export const defaultSendTime = (kind) => (kind === AUTO_KIND_LEAD_PLUS ? '09:30' : (hasSendTime(kind, '1') ? '10:00' : ''));

// 폼 값 한 벌(등록 팝업 상태). item 은 formInitialFromItem 모양(없으면 빈 등록).
export function formValuesFromItem(item) {
  const i = item || {};
  return {
    name: i.name || '', body: i.body || '', images: Array.isArray(i.images) ? i.images : [],
    autoKind: i.autoKind || '', days: i.days || String(AUTO_DEFAULT_DAYS), sendFrom: i.sendFrom || '',
    repeat: i.repeat || String(AUTO_DEFAULT_REPEAT), interval: i.interval || String(AUTO_DEFAULT_INTERVAL),
    offsetDir: i.offsetDir || 'before', offsetDays: i.offsetDays || '3', unlessStep: i.unlessStep || '', unlessMode: i.unlessMode || 'completed',
    daily: Boolean(i.daily), weekdays: Boolean(i.weekdays), step: i.step || '', audience: i.audience || 'customer',
    staff: Array.isArray(i.staff) ? i.staff : [], ataTemplate: i.ataTemplate || '', bmsButtons: Array.isArray(i.bmsButtons) ? i.bmsButtons.map((b) => ({ name: String(b?.name || ''), link: String(b?.link || '') })) : [], sendTime: SEND_TIMES.includes(i.sendTime) ? i.sendTime : '', copyTo: i.copyTo || '',
    catchupOn: Boolean(i.catchupOn), catchupFrom: i.catchupFrom || '', catchupAt: i.catchupAt || '', catchupDaily: i.catchupDaily ? String(i.catchupDaily) : '', leadSource: LEAD_SOURCES.includes(i.leadSource) ? i.leadSource : '',
  };
}
// 단계 순서값(일수 오름차순에 쓴다). 즉시형·회원가입 시는 0, 입력이 올바르지 않으면 null.
export function stageOrder(f) {
  const kind = f?.autoKind;
  if (kind === AUTO_KIND_LEAD_PLUS) return normalizeLeadDays(f.days);
  if (kind === AUTO_KIND || kind === AUTO_KIND_ORDER || kind === AUTO_KIND_PROCESS_PLUS) return normalizeDays(f.days);
  if (isDateKind(kind)) return normalizeOffset(f.offsetDir, f.offsetDays, f.daily);
  return AUTO_KINDS.includes(kind) ? 0 : null;
}
// 단계 칩 글자: 당일 · 2일 · 3일 전 · 2일 후 · 즉시
export function stageLabel(f) {
  const n = stageOrder(f);
  if (n === null) return '새 단계';
  if (isDateKind(f.autoKind)) return n === 0 ? '당일' : (n < 0 ? `${-n}일 전` : `${n}일 후`);
  if (isImmediateKind(f.autoKind) || f.autoKind === AUTO_KIND_MEMBER_JOINED) return '즉시';
  return n === 0 ? '당일' : `${n}일`;
}
// 같은 종류·같은 순서값인 단계들의 자리(한 사람에게 2통 방지). → Set<index>
export function duplicateStages(forms) {
  const seen = new Map();
  // 날짜 기준은 공정 조건이 다르면 다른 단계다. 즉시형(주문 등록 시·공정 시작/완료 시·회원가입 시)은 공정·받는 사람까지 같으면 중복이다(둘 다 발송됨).
  forms.forEach((f, i) => { const n = stageOrder(f); if (n === null) return; const imm = isImmediateKind(f.autoKind) || f.autoKind === AUTO_KIND_MEMBER_JOINED; const key = imm ? `${f.autoKind}|${f.step || ''}|${f.audience || ''}|${[...(f.staff || [])].sort().join(',')}` : `${f.autoKind}|${n}|${f.unlessStep || ''}${f.autoKind === AUTO_KIND_LEAD_PLUS && f.leadSource ? `|${f.leadSource}` : ''}`; seen.set(key, [...(seen.get(key) || []), i]); });
  const out = new Set();
  seen.forEach((list) => { if (list.length > 1) list.forEach((i) => out.add(i)); });
  return out;
}
// 바뀜 판정용 짧은 서명(사진은 길이·앞뒤 일부만 본다)
export function stageDirtySig(f) {
  const photo = (item) => { const d = String(item?.data || item?.url || ''); return `${d.length}:${d.slice(0, 24)}:${d.slice(-24)}`; };
  return JSON.stringify({ ...f, images: (f.images || []).map(photo) });
}
// 새 단계의 폼 값. 기본은 조건만 복사하고 이름·내용·사진을 비운다. withContent 면 내용까지 복사하고 일수만 비운다.
export function newStageValues(from, withContent) {
  const base = { ...from, staff: [...(from.staff || [])] };
  if (!withContent) return { ...base, name: '', body: '', images: [] };
  const dayless = isDateKind(base.autoKind) ? { offsetDir: base.offsetDir === 'same' ? 'after' : base.offsetDir, offsetDays: '' } : { days: '' };
  return { ...base, ...dayless, images: (from.images || []).map((i) => ({ data: i.data, bytes: i.bytes, url: i.data ? `data:image/jpeg;base64,${i.data}` : i.url })) };
}
// 팝업을 열 때의 단계 묶음: { stages:[{key,id,form,base,failed}], activeKey, values }
export function bootStages(initial, siblings, startNew) {
  const cur = formValuesFromItem(initial);
  const mk = (id, form) => ({ key: `s${id}`, id, form, base: stageDirtySig(form), failed: false });
  const list = (Array.isArray(siblings) ? siblings : []).filter((s) => s && s.id !== undefined && s.id !== null);
  const stages = list.map((s) => (initial?.id && s.id === initial.id ? mk(s.id, cur) : mk(s.id, formValuesFromItem(s))));
  if (initial?.id && !stages.some((s) => s.id === initial.id)) stages.push(mk(initial.id, cur));
  if (!stages.length) stages.push(initial?.id ? mk(initial.id, cur) : { key: 'n0', id: undefined, form: cur, base: null, failed: false });
  if (startNew && !initial?.id) {
    const last = [...stages].sort((a, b) => (stageOrder(a.form) ?? 9999) - (stageOrder(b.form) ?? 9999)).pop();
    const fresh = { key: 'n1', id: undefined, form: newStageValues(last.form, false), base: null, failed: false };
    stages.push(fresh);
    return { stages, activeKey: fresh.key, values: fresh.form };
  }
  const active = stages.find((s) => initial?.id && s.id === initial.id) || stages[0];
  return { stages, activeKey: active.key, values: active.form };
}
// 단계 줄을 그릴지: siblings 가 왔거나 자동 발송 조건을 고른 상태
export const hasStageRow = (kind, hasSiblings) => Boolean(hasSiblings) || AUTO_KINDS.includes(kind);

// 광고 문자(알림톡 아님) 출고 완료 후 줄 끝에 붙는 일괄 발송 글(알림톡 상세 줄과 같은 표현)
function adCatchupText(entry) {
  return entry.autoKind === AUTO_KIND && (!entry.autoAtaTemplate || entry.autoAtaTemplate === BMS_TEMPLATE_ID) && entry.autoCatchupAt
    ? `일괄 ${entry.autoCatchupAt.replace('T', ' ')} · 출고일 ${entry.autoCatchupFrom || '처음'}~오늘${entry.autoCatchupDone ? ' (완료)' : ''}` : '';
}

// 발송 조건 한 줄
export const autoConditionLine = (entry) => (isImmediateKind(entry?.autoKind) ? joinDot(
  `${AUTO_LABEL[entry.autoKind]}${entry.autoStep ? `(${entry.autoStep})` : ''}`,
  entry.autoAudience === AUDIENCE_STAFF ? `직원 ${Number(entry.autoStaffCount) || 0}명` : '고객',
  viaLabel(entry),
) : isDateKind(entry?.autoKind) ? joinDot(
  `${AUTO_LABEL[entry.autoKind]} ${offsetText(entry.autoOffset, entry.autoDaily)}`,
  sendTimeLabel(entry.autoSendTime) || '오전 10시',
  entry.autoWeekdays ? '평일만' : '',
  entry.autoAudience === AUDIENCE_STAFF ? `직원 ${Number(entry.autoStaffCount) || 0}명` : (entry.autoAudience === AUDIENCE_SALES ? '영업담당' : '고객'),
  entry.autoUnlessStep ? `${entry.autoUnlessStep} ${entry.autoUnlessMode === 'started' ? '미착수만' : '미완료만'}` : '',
  viaLabel(entry),
) : entry?.autoKind === AUTO_KIND_MEMBER_JOINED ? joinDot(AUTO_LABEL[entry.autoKind], '고객', viaLabel(entry)
) : entry?.autoKind === AUTO_KIND_LEAD_PLUS ? joinDot(
  Number(entry.autoDays) > 0 ? `${LEAD_SOURCE_FLOW_LABEL[entry.autoLeadSource || '']} 후 ${Number(entry.autoDays)}일 뒤` : `${LEAD_SOURCE_FLOW_LABEL[entry.autoLeadSource || '']} 당일`,
  Number(entry.autoDays) > 0 ? (sendTimeLabel(entry.autoSendTime) || '오전 9시 30분') : '',
  '고객',
  viaLabel(entry),
) : AUTO_KINDS.includes(entry?.autoKind) ? joinDot(
  `${AUTO_LABEL[entry.autoKind]}${entry.autoKind === AUTO_KIND_PROCESS_PLUS && entry.autoStep ? `(${entry.autoStep})` : ''} ${entry.autoDays}일 뒤`,
  sendTimeLabel(entry.autoSendTime) || '오전 10시',
  '고객',
  viaLabel(entry),
  entry.autoSendFrom ? `${shortDate(entry.autoSendFrom)}부터` : '',
  Number(entry.autoRepeat) > 1 ? `${Number(entry.autoRepeat)}번(${Number(entry.autoInterval) || AUTO_DEFAULT_INTERVAL}일 간격)` : '',
  entry.autoCopyTo ? `사본 ${String(entry.autoCopyTo).replace(/\D/g, '').slice(-4)}` : '',
  adCatchupText(entry),
) : '');

// 발송 대상 한 줄: 서버(api/_lib/smsAutoSend.js·smsEventSend.js)가 실제로 고르는 조건을 글로 옮긴 것. 근거를 못 찾은 종류는 빈 글.
export function autoTargetText(entry) {
  const kind = entry?.autoKind;
  const days = Number(entry?.autoDays) || 0;
  const times = Number(entry?.autoRepeat) > 1 ? `번호당 ${Number(entry.autoRepeat)}회(${Number(entry.autoInterval) || AUTO_DEFAULT_INTERVAL}일 간격)` : '번호당 1회';
  if (kind === AUTO_KIND) return joinDot('주문 상태 출고완료', `출고일+${days}일=오늘(3일 지난 건까지)`, '수신거부·중복번호 제외', times);
  if (kind === AUTO_KIND_PROCESS_PLUS) return joinDot(`${entry.autoStep || '고른'} 공정 시작일+${days}일=오늘(3일 지난 건까지)`, '취소 주문 제외', '수신거부·중복번호 제외', times);
  if (kind === AUTO_KIND_ORDER) return joinDot(`주문일+${days}일=오늘(3일 지난 건까지)`, '취소 주문 제외', '수신거부·중복번호 제외', times);
  if (isDateKind(kind)) {
    const label = kind === AUTO_KIND_SHIP_OR_DUE ? '출고예정일(없으면 납기일)' : (kind === AUTO_KIND_SHIP_PLAN ? '출고예정일' : '납기일');
    return joinDot(
      '주문 상태 제작 중',
      `${label} ${offsetText(entry.autoOffset, entry.autoDaily)}=오늘`,
      entry.autoWeekdays ? '평일만(토·일 안 보냄)' : '',
      entry.autoUnlessStep ? `${entry.autoUnlessStep} 공정 ${entry.autoUnlessMode === 'started' ? '미착수' : '미완료'}인 주문만` : '',
      entry.autoDaily ? '번호·주문당 하루 1번' : '번호·주문당 1번',
    );
  }
  if (kind === AUTO_KIND_LEAD_PLUS) {
    const flow = LEAD_SOURCE_FLOW_LABEL[entry.autoLeadSource || ''];
    return days > 0
      ? joinDot(`카페24 ${flow} 접수일+${days}일=오늘`, '번호가 남아 있는 접수만', '번호당 1번')
      : joinDot(`카페24 ${flow} 접수 즉시(켠 뒤 24시간 안 접수)`, '번호당 1번');
  }
  if (kind === AUTO_KIND_MEMBER_JOINED) return '카페24 회원가입 즉시(켠 뒤 24시간 안 가입) · 번호당 1번';
  if (kind === AUTO_KIND_ORDER_CREATED) return '주문 등록 즉시(켠 뒤 24시간 안 등록) · 취소 주문 제외 · 번호·주문당 1번';
  if (kind === AUTO_KIND_PROCESS_STARTED || kind === AUTO_KIND_PROCESS_COMPLETED) {
    return joinDot(`${entry.autoStep || '고른'} 공정 ${kind === AUTO_KIND_PROCESS_STARTED ? '시작' : '완료'} 시각이 기록된 주문(켠 뒤 24시간 안)`, '취소 주문 제외', '번호·주문당 1번');
  }
  return '';
}

// 발송 조건을 조각으로: { when, who, via, extras[] } — autoConditionLine 과 같은 글을 ' · ' 로 나눠 만든다
export function autoConditionParts(entry) {
  const list = autoConditionLine(entry).split(' · ').filter(Boolean);
  const parts = { when: list[0] || '', who: '', via: '', extras: [] };
  list.slice(1).forEach((text) => {
    if (!parts.who && /^(고객|영업담당|직원 \d+명)$/.test(text)) parts.who = text;
    else if (!parts.via && (text === '알림톡' || text === '브랜드메시지')) parts.via = text;
    else parts.extras.push(text);
  });
  return parts;
}

// 일괄 발송이 통째 실패로 멈췄을 때 화면 문구(resource=auto_status 의 catchup_paused·catchup_error). 멈추지 않았으면 빈 문자열.
export function catchupPausedText(status) {
  if (!status?.catchup_paused) return '';
  const why = String(status.catchup_error || '').trim() || '사유를 알 수 없습니다';
  return `일괄 발송이 멈췄습니다: ${why}. 확인 후 다시 저장하면 이어서 보냅니다.`;
}

// 알림톡 템플릿 상세의 '자동 발송 조건' 한 줄: 조건 이름 · 회차(알림톡 갈래는 번호당 1회) · 보내는 시각 · 켜짐/꺼짐 · 이미 출고분 일괄 발송 예약 · 최근 7일 건수
// entry = myTextSection 항목, status = resource=auto_status 응답(없으면 건수 칸을 뺀다)
export function ataLinkLine(entry, status) {
  const parts = autoConditionLine(entry).split(' · ').filter(Boolean).filter((text) => text !== '알림톡' && text !== '고객');
  const when = parts.shift() || '';
  const timeText = parts.length ? parts.join(' · ') : '';
  const effective = autoEffective(status);
  const catchup = entry.autoKind === AUTO_KIND && entry.autoCatchupAt
    ? `일괄 ${entry.autoCatchupAt.replace('T', ' ')} · 출고일 ${entry.autoCatchupFrom || '처음'}~오늘${entry.autoCatchupDone ? ' (완료)' : ''}` : '';
  return joinDot(when, timeText, '1회', effective.text, catchup, status ? `최근 7일 ${Number(status.sent_7d) || 0}건` : '', catchupPausedText(status));
}

// 현황 한 줄 (resource=auto_status 응답)
export function autoStatusLine(status) {
  if (!status) return '';
  return joinDot(
    autoEffective(status).text,
    `오늘 대상 ${Number(status.today_targets) || 0}`,
    `최근 7일 ${Number(status.sent_7d) || 0}`,
    `누적 ${Number(status.sent_total) || 0}`,
    `확인 필요 ${Number(status.uncertain_total) || 0}`,
    `마지막 ${shortDate(status.last_sent_date) || '없음'}`,
    catchupPausedText(status),
  );
}

// 켜기 거절 이유(400 + reason) → 한 줄
export function toggleRejectText(reason) {
  if (reason === 'no_ad_prefix') return '본문이 (광고)로 시작해야 켤 수 있습니다.';
  if (reason === 'no_optout_080') return '본문에 무료수신거부 080 번호 줄이 있어야 켤 수 있습니다.';
  if (reason === 'cafe24_not_connected') return '카페24 연결이 아직 안 됐습니다';
  if (reason === 'lead_source_not_connected') return '가입·문의 정보 연결이 아직 안 됐습니다.';
  if (reason === 'ata_not_ready') return '선택한 알림톡 템플릿이 아직 쓸 수 없는 상태입니다.';
  if (reason === 'bms_not_ready') return '브랜드메시지 설정(사진·글자 수)이 맞지 않습니다. 문구를 다시 저장해 주세요.';
  if (reason === 'lead_overlap') return '가입 당일에 나가는 문구가 이미 켜져 있습니다.';
  return '';
}

// 켜기·시험 dry_run 응답 → 확인 줄
// 브랜드메시지(자유형) 확인 줄: "브랜드메시지(자유형) N건, 약 N×100원(친구가 아니면 장문문자 45원으로 대체)"
export const bmsConfirmLine = (out) => {
  const unit = Number(out?.unit) || 0;
  const n = out?.targets === undefined ? 1 : Math.min(Number(out.targets) || 0, Number(out.daily_max) || Number.MAX_SAFE_INTEGER);
  return joinDot(
    out?.targets === undefined ? '' : `오늘 대상 ${Number(out.targets) || 0}명`,
    `브랜드메시지(자유형) ${n}건, 약 ${n}×${unit}원${Number(out?.fallback_unit) ? `(친구가 아니면 장문문자 ${Number(out.fallback_unit)}원으로 대체)` : ''}`,
    `예상 비용 ${won(out?.cost)}`,
  );
};
export const autoConfirmLine = (out, photos = 0) => out?.bms ? bmsConfirmLine(out) : joinDot(
  out?.targets === undefined ? '' : `오늘 대상 ${Number(out.targets) || 0}명`,
  `1명당 ${Number(out?.parts) || 0}통${Number(photos) > 1 ? `(사진 ${Number(photos)}장)` : ''}`,
  `예상 비용 ${won(out?.cost)}`,
);

// 시험 발송 결과 한 줄 (통별 결과 results 가 있으면 성공 통 수)
export function testResultText(out) {
  const parts = Array.isArray(out?.part_status) ? out.part_status : out?.results;
  if (Array.isArray(parts)) {
    const ok = parts.filter((part) => part === true || part === 'sent' || part?.ok === true).length;
    return `${parts.length}통 중 ${ok}통 발송했습니다.`;
  }
  return out?.ok === false ? '발송하지 못했습니다.' : '발송했습니다.';
}

// 시험 받는 번호: 숫자만 남겨 01 로 시작하는 10~11자리
export function testPhoneDigits(value) {
  const digits = String(value || '').replace(/\D/g, '');
  return /^01\d{8,9}$/.test(digits) ? digits : '';
}

// '발송 중' 묶음의 고객·이벤트·혜택 아래에 켜진 자동 문구를 더하려고, 그 칸이 없으면 만들어 돌려준다(없을 때만 새로 만듦)
export function ensureAutoSection(sections, autoCount) {
  const list = Array.isArray(sections) ? sections : [];
  if (!autoCount) return list;
  const hasKind = (aud) => aud.kinds.some((section) => section.kind === '이벤트·혜택');
  const aud = list.find((item) => item.group === '고객');
  if (!aud) return [...list, { group: '고객', count: 0, kinds: [{ kind: '이벤트·혜택', items: [] }] }];
  if (hasKind(aud)) return list;
  return list.map((item) => (item === aud ? { ...aud, kinds: [...aud.kinds, { kind: '이벤트·혜택', items: [] }] } : item));
}

// 사진 배지 글
// 카드 종류 표기·건당 비용(서버 send_cost = { type, unit, parts:[{type,count}], fallback_unit? })
const KIND_LABELS = { BMS: '브랜드메시지', ATA: '알림톡', SMS: '단문 문자', LMS: '장문 문자', MMS: '사진 문자' };
export const sendKindLabel = (type) => KIND_LABELS[type] || '';
export function sendCostText(sendCost) {
  if (!sendCost || !KIND_LABELS[sendCost.type]) return '';
  const parts = Array.isArray(sendCost.parts) ? sendCost.parts : [];
  const label = parts.length > 1 || (parts[0] && parts[0].count > 1)
    ? parts.map((part) => `${sendKindLabel(part.type)} ${part.count}통`).join(' + ')
    : sendKindLabel(sendCost.type);
  const unit = Number(sendCost.unit);
  const cost = Number.isFinite(unit) && sendCost.unit !== null ? `건당 ${unit.toLocaleString('ko-KR')}원` : '';
  const fb = Number(sendCost.fallback_unit);
  const fallback = sendCost.type === 'BMS' && sendCost.fallback_unit != null && Number.isFinite(fb) ? `친구 아니면 장문 문자 ${fb.toLocaleString('ko-KR')}원` : '';
  return [label, cost, fallback].filter(Boolean).join(' · ');
}
export const photoBadgeText = (entry) => (entry.imageCount > 1 || entry.autoKind ? `사진 ${entry.imageCount}장` : '사진');

// 목록 응답 items → '내 문구' 묶음. 0개면 null(묶음 자체가 안 보인다).
// 이 알림톡(ataId)을 auto_ata_template 으로 쓰는 문자 문구들(text_templates 응답 items 기준, 응답 순서 그대로). 상세 화면의 '이 알림톡으로 자동 발송 설정'이 새로 만들기 전에 기존 연결 문구를 찾는 데 쓴다.
export function linkedTextEntries(items, ataId) {
  const id = String(ataId || '');
  if (!id) return [];
  return (myTextSection((Array.isArray(items) ? items : []).filter(item => item && item.auto_ata_template === id))?.items) || [];
}

export function myTextSection(items) {
  const list = Array.isArray(items) ? items : [];
  if (list.length === 0) return null;
  return {
    count: list.length,
    items: list.map(item => ({
      id: item.id,
      name: item.name,
      preview: String(item.body || '').replace(/\s+/g, ' ').trim().slice(0, 60),
      hasImage: Boolean(item.has_image) || Number(item.image_count) > 0,
      imageCount: Number(item.image_count) || (item.has_image ? 1 : 0),
      sendCost: item.send_cost || null,
      autoKind: AUTO_KINDS.includes(item.auto_kind) ? item.auto_kind : '',
      autoDays: Number(item.auto_days) || 0,
      autoAtaTemplate: String(item.auto_ata_template || ''),
      autoLeadSource: LEAD_SOURCES.includes(item.auto_lead_source) ? item.auto_lead_source : '',
      autoCatchupAt: String(item.auto_catchup_at || ''),
      autoCatchupFrom: String(item.auto_catchup_from || ''),
      autoCatchupDaily: Number(item.auto_catchup_daily) > 0 ? String(Number(item.auto_catchup_daily)) : '',
      autoCatchupDone: Boolean(item.auto_catchup_done),
      autoSendFrom: String(item.auto_send_from || '').slice(0, 10),
      autoRepeat: Number(item.auto_repeat) || AUTO_DEFAULT_REPEAT,
      autoInterval: Number(item.auto_interval) || AUTO_DEFAULT_INTERVAL,
      autoOffset: Number(item.auto_offset) || 0,
      autoDaily: item.auto_daily === 'until' || item.auto_daily === 'ongoing' ? item.auto_daily : '',
      autoWeekdays: Boolean(item.auto_weekdays),
      autoUnlessMode: item.auto_unless_mode === 'started' ? 'started' : 'completed',
      autoUnlessStep: String(item.auto_unless_step || ''),
      autoStep: String(item.auto_step || ''),
      autoAudience: item.auto_audience === AUDIENCE_STAFF || item.auto_audience === AUDIENCE_SALES ? item.auto_audience : 'customer',
      autoStaffCount: Array.isArray(item.auto_staff) ? item.auto_staff.length : 0,
      autoEnabled: Boolean(item.auto_enabled),
      autoSendTime: SEND_TIMES.includes(item.auto_send_time) ? item.auto_send_time : '',
      autoCopyTo: String(item.auto_copy_to || ''),
    })),
  };
}

// 단건 조회의 사진들(images 배열, 없으면 기존 image 1장) → 미리보기 주소들
export function imageUrlsFromItem(item) {
  const list = Array.isArray(item?.images) ? item.images.filter((data) => typeof data === 'string' && data) : [];
  if (list.length) return list.map((data) => `data:image/jpeg;base64,${data}`);
  const one = imageFromItem(item);
  return one ? [one.url] : [];
}

// 단건 조회 응답 item → 등록 양식을 고치기용으로 여는 initial 값
export function formInitialFromItem(item) {
  const photos = Array.isArray(item?.images) && item.images.length ? item.images.filter((d) => typeof d === 'string' && d) : (item?.image ? [item.image] : []);
  return {
    id: item?.id,
    name: String(item?.name || ''),
    body: String(item?.body || ''),
    images: photos.map((data) => ({ data, url: `data:image/jpeg;base64,${data}` })),
    autoKind: AUTO_KINDS.includes(item?.auto_kind) ? item.auto_kind : '',
    days: item?.auto_kind === AUTO_KIND_LEAD_PLUS ? String(Number(item?.auto_days) || 0) : String(Number(item?.auto_days) || AUTO_DEFAULT_DAYS),
    ataTemplate: String(item?.auto_ata_template || ''),
    bmsButtons: Array.isArray(item?.auto_bms_buttons) ? item.auto_bms_buttons.map((b) => ({ name: String(b?.name || ''), link: String(b?.link || '') })) : [],
    leadSource: LEAD_SOURCES.includes(item?.auto_lead_source) ? item.auto_lead_source : '',
    catchupOn: Boolean(item?.auto_catchup_at), catchupFrom: String(item?.auto_catchup_from || ''), catchupAt: String(item?.auto_catchup_at || ''), catchupDaily: Number(item?.auto_catchup_daily) > 0 ? String(Number(item.auto_catchup_daily)) : '',
    sendFrom: String(item?.auto_send_from || '').slice(0, 10),
    repeat: String(Number(item?.auto_repeat) || AUTO_DEFAULT_REPEAT),
    interval: String(Number(item?.auto_interval) || AUTO_DEFAULT_INTERVAL),
    offsetDir: offsetParts(item?.auto_offset, item?.auto_daily).dir,
    offsetDays: offsetParts(item?.auto_offset, item?.auto_daily).days,
    daily: offsetParts(item?.auto_offset, item?.auto_daily).daily,
    weekdays: Boolean(item?.auto_weekdays),
    unlessMode: item?.auto_unless_mode === 'started' ? 'started' : 'completed',
    unlessStep: String(item?.auto_unless_step || ''),
    step: String(item?.auto_step || ''),
    audience: item?.auto_audience === AUDIENCE_STAFF || item?.auto_audience === AUDIENCE_SALES ? item.auto_audience : 'customer',
    staff: Array.isArray(item?.auto_staff) ? item.auto_staff : [],
    sendTime: SEND_TIMES.includes(item?.auto_send_time) ? item.auto_send_time : '',
    copyTo: String(item?.auto_copy_to || ''),
  };
}

// 단건 조회의 base64 사진 → SendPanel 이 쓰는 { data, bytes, url }
export function imageFromItem(item) {
  const data = typeof item?.image === 'string' ? item.image : '';
  if (!data) return null;
  return { data, bytes: Math.floor((data.length * 3) / 4), url: `data:image/jpeg;base64,${data}` };
}
