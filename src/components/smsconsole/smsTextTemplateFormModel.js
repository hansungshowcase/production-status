// 문자 템플릿 등록 양식·내 문구 묶음의 순수 계산(화면 없음).
import { textInfo } from './sendPanelModel.js';

export const TEXT_NAME_MAX = 40;
export const KIND_SMS = 'sms';
export const KIND_KAKAO = 'kakao';

// 주소의 kind 값 → 'sms' | 'kakao'. 없거나 모르는 값은 문자(처음 선택).
export const normalizeKind = value => (value === KIND_KAKAO ? KIND_KAKAO : KIND_SMS);

// 양식 값 → { ok, reason, info }. 글자 수·SMS/LMS 판정은 보내기 화면과 같은 textInfo.
export function validateTextForm({ name, body, autoKind, days, sendFrom, repeat, interval, offsetDir, offsetDays, daily, audience, staff, step }) {
  const trimmed = String(name || '').trim();
  const info = textInfo(body);
  if (!trimmed) return { ok: false, reason: 'name', info };
  if ([...trimmed].length > TEXT_NAME_MAX) return { ok: false, reason: 'name', info };
  if (!info.type) return { ok: false, reason: 'body', info };
  if (info.tooLong) return { ok: false, reason: 'long', info };
  if (isImmediateKind(autoKind)) {
    if (autoKind !== AUTO_KIND_ORDER_CREATED && !step) return { ok: false, reason: 'step', info };
    if (audience === AUDIENCE_STAFF && !(Array.isArray(staff) && staff.length)) return { ok: false, reason: 'staff', info };
  } else if (isDateKind(autoKind)) {
    if (normalizeOffset(offsetDir, offsetDays, daily) === null) return { ok: false, reason: 'offset', info };
    if (audience === AUDIENCE_STAFF && !(Array.isArray(staff) && staff.length)) return { ok: false, reason: 'staff', info };
  } else if (autoKind === AUTO_KIND_MEMBER_JOINED) {
    // 이름·본문만 본다
  } else if (AUTO_KINDS.includes(autoKind)) {
    if (normalizeDays(days) === null) return { ok: false, reason: 'days', info };
    if (normalizeSendFrom(sendFrom) === null) return { ok: false, reason: 'sendFrom', info };
    const times = normalizeRepeat(repeat ?? '1');
    if (times === null) return { ok: false, reason: 'repeat', info };
    if (times >= 2 && normalizeInterval(interval ?? '30') === null) return { ok: false, reason: 'interval', info };
  }
  return { ok: true, reason: '', info };
}

export const IMAGE_MAX = 3;
export const AUTO_KIND = 'ship_plus_days';
export const AUTO_KIND_ORDER = 'order_plus_days';
export const AUTO_KIND_DUE = 'due_date';
export const AUTO_KIND_SHIP_PLAN = 'ship_scheduled';
export const AUTO_KIND_SHIP_OR_DUE = 'ship_or_due';
export const DATE_KINDS = [AUTO_KIND_DUE, AUTO_KIND_SHIP_PLAN, AUTO_KIND_SHIP_OR_DUE];
export const AUTO_KIND_ORDER_CREATED = 'order_created';
export const AUTO_KIND_PROCESS_STARTED = 'process_started';
export const AUTO_KIND_PROCESS_COMPLETED = 'process_completed';
export const IMMEDIATE_KINDS = [AUTO_KIND_ORDER_CREATED, AUTO_KIND_PROCESS_STARTED, AUTO_KIND_PROCESS_COMPLETED];
export const AUTO_KIND_MEMBER_JOINED = 'member_joined';
export const AUTO_KINDS = [AUTO_KIND, AUTO_KIND_ORDER, ...DATE_KINDS, ...IMMEDIATE_KINDS, AUTO_KIND_MEMBER_JOINED];
export const AUDIENCE_STAFF = 'staff';
export const AUDIENCE_SALES = 'sales';
export const isDateKind = (kind) => DATE_KINDS.includes(kind);
export const isImmediateKind = (kind) => IMMEDIATE_KINDS.includes(kind);
export const AUTO_DEFAULT_DAYS = 20;
export const AUTO_DEFAULT_REPEAT = 1;
export const AUTO_DEFAULT_INTERVAL = 30;
const AUTO_LABEL = { [AUTO_KIND]: '출고 완료 후', [AUTO_KIND_ORDER]: '주문 등록 후', [AUTO_KIND_DUE]: '납기일', [AUTO_KIND_SHIP_PLAN]: '출고예정일', [AUTO_KIND_SHIP_OR_DUE]: '출고·납기일', [AUTO_KIND_ORDER_CREATED]: '주문 등록 시', [AUTO_KIND_PROCESS_STARTED]: '공정 시작 시', [AUTO_KIND_PROCESS_COMPLETED]: '공정 완료 시', [AUTO_KIND_MEMBER_JOINED]: '자사몰 회원가입 시' };

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
export function autoVariables(kind, audience) {
  if (kind === AUTO_KIND_MEMBER_JOINED) return [];
  if (!isDateKind(kind) && !isImmediateKind(kind)) return AUTO_KINDS.includes(kind) ? ['고객명'] : [];
  const list = ['고객명', '주문번호', '규격', '수량', '예상출고일', '조회링크'];
  return audience === AUDIENCE_STAFF || audience === AUDIENCE_SALES ? [...list, '제품'] : list;
}

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
  if (reason === 'offset') return '일수는 0부터 365 사이로 넣어 주세요';
  if (reason === 'step') return '공정을 골라 주세요';
  if (reason === 'cafe24_not_connected') return '카페24 연결이 아직 안 됐습니다';
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
    if (a.kind === AUTO_KIND_MEMBER_JOINED) return { kind: a.kind };
    if (isImmediateKind(a.kind)) {
      const staffAudience = a.audience === AUDIENCE_STAFF;
      return { kind: a.kind, step: a.kind === AUTO_KIND_ORDER_CREATED ? '' : String(a.step || ''), audience: staffAudience ? AUDIENCE_STAFF : 'customer', staff: staffAudience && Array.isArray(a.staff) ? a.staff : [] };
    }
    if (isDateKind(a.kind)) {
      const staffAudience = a.audience === AUDIENCE_STAFF;
      const salesAudience = a.audience === AUDIENCE_SALES;
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
      };
    }
    const out = { kind: a.kind, days: normalizeDays(a.days) };
    if (a.sendFrom !== undefined) out.send_from = normalizeSendFrom(a.sendFrom) || null;
    if (a.repeat !== undefined) out.repeat = normalizeRepeat(a.repeat) ?? AUTO_DEFAULT_REPEAT;
    if (a.interval !== undefined) out.interval = normalizeInterval(a.interval) ?? AUTO_DEFAULT_INTERVAL;
    return out;
  };
  return {
    ...(id ? { id } : {}),
    name: String(name || '').trim(),
    body: String(body || ''),
    ...(image?.data ? { image: { data: image.data } } : {}),
    ...(list.length ? { images: list.map((item) => ({ data: item.data })) } : {}),
    ...(auto ? { auto: autoBody(auto) } : {}),
  };
}

// ---------- 자동 발송 문구(카드) ----------
const joinDot = (...parts) => parts.filter(Boolean).join(' · ');
const won = (value) => `${Number(value || 0).toLocaleString('ko-KR')}원`;
const shortDate = (value) => { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(value || '')); return m ? `${Number(m[1])}/${Number(m[2])}` : ''; };

// 발송 조건 한 줄
export const autoConditionLine = (entry) => (isImmediateKind(entry?.autoKind) ? joinDot(
  `${AUTO_LABEL[entry.autoKind]}${entry.autoStep ? `(${entry.autoStep})` : ''}`,
  entry.autoAudience === AUDIENCE_STAFF ? `직원 ${Number(entry.autoStaffCount) || 0}명` : '고객',
) : isDateKind(entry?.autoKind) ? joinDot(
  `${AUTO_LABEL[entry.autoKind]} ${offsetText(entry.autoOffset, entry.autoDaily)}`,
  '오전 10시',
  entry.autoWeekdays ? '평일만' : '',
  entry.autoAudience === AUDIENCE_STAFF ? `직원 ${Number(entry.autoStaffCount) || 0}명` : (entry.autoAudience === AUDIENCE_SALES ? '영업담당' : '고객'),
  entry.autoUnlessStep ? `${entry.autoUnlessStep} ${entry.autoUnlessMode === 'started' ? '미착수만' : '미완료만'}` : '',
) : entry?.autoKind === AUTO_KIND_MEMBER_JOINED ? joinDot(AUTO_LABEL[entry.autoKind], '고객'
) : AUTO_KINDS.includes(entry?.autoKind) ? joinDot(
  `${AUTO_LABEL[entry.autoKind]} ${entry.autoDays}일 뒤`,
  '오전 10시',
  '고객',
  entry.autoSendFrom ? `${shortDate(entry.autoSendFrom)}부터` : '',
  Number(entry.autoRepeat) > 1 ? `${Number(entry.autoRepeat)}번(${Number(entry.autoInterval) || AUTO_DEFAULT_INTERVAL}일 간격)` : '',
) : '');

// 현황 한 줄 (resource=auto_status 응답)
export function autoStatusLine(status) {
  if (!status) return '';
  return joinDot(
    status.enabled ? '켜짐' : '꺼짐',
    `오늘 대상 ${Number(status.today_targets) || 0}`,
    `최근 7일 ${Number(status.sent_7d) || 0}`,
    `누적 ${Number(status.sent_total) || 0}`,
    `확인 필요 ${Number(status.uncertain_total) || 0}`,
    `마지막 ${shortDate(status.last_sent_date) || '없음'}`,
  );
}

// 켜기 거절 이유(400 + reason) → 한 줄
export function toggleRejectText(reason) {
  if (reason === 'no_ad_prefix') return '본문이 (광고)로 시작해야 켤 수 있습니다.';
  if (reason === 'no_optout_080') return '본문에 무료수신거부 080 번호 줄이 있어야 켤 수 있습니다.';
  if (reason === 'cafe24_not_connected') return '카페24 연결이 아직 안 됐습니다';
  return '';
}

// 켜기·시험 dry_run 응답 → 확인 줄
export const autoConfirmLine = (out) => joinDot(
  out?.targets === undefined ? '' : `오늘 대상 ${Number(out.targets) || 0}명`,
  `1명당 ${Number(out?.parts) || 0}통`,
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
export const photoBadgeText = (entry) => (entry.imageCount > 1 || entry.autoKind ? `사진 ${entry.imageCount}장` : '사진');

// 목록 응답 items → '내 문구' 묶음. 0개면 null(묶음 자체가 안 보인다).
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
      autoKind: AUTO_KINDS.includes(item.auto_kind) ? item.auto_kind : '',
      autoDays: Number(item.auto_days) || 0,
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
    days: String(Number(item?.auto_days) || AUTO_DEFAULT_DAYS),
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
  };
}

// 단건 조회의 base64 사진 → SendPanel 이 쓰는 { data, bytes, url }
export function imageFromItem(item) {
  const data = typeof item?.image === 'string' ? item.image : '';
  if (!data) return null;
  return { data, bytes: Math.floor((data.length * 3) / 4), url: `data:image/jpeg;base64,${data}` };
}
