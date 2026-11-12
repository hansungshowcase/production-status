// 문자 템플릿 등록 양식·내 문구 묶음의 순수 계산(화면 없음).
import { textInfo } from './sendPanelModel.js';

export const TEXT_NAME_MAX = 40;
export const KIND_SMS = 'sms';
export const KIND_KAKAO = 'kakao';

// 주소의 kind 값 → 'sms' | 'kakao'. 없거나 모르는 값은 문자(처음 선택).
export const normalizeKind = value => (value === KIND_KAKAO ? KIND_KAKAO : KIND_SMS);

// 양식 값 → { ok, reason, info }. 글자 수·SMS/LMS 판정은 보내기 화면과 같은 textInfo.
export function validateTextForm({ name, body, autoKind, days }) {
  const trimmed = String(name || '').trim();
  const info = textInfo(body);
  if (!trimmed) return { ok: false, reason: 'name', info };
  if ([...trimmed].length > TEXT_NAME_MAX) return { ok: false, reason: 'name', info };
  if (!info.type) return { ok: false, reason: 'body', info };
  if (info.tooLong) return { ok: false, reason: 'long', info };
  if (autoKind === AUTO_KIND && normalizeDays(days) === null) return { ok: false, reason: 'days', info };
  return { ok: true, reason: '', info };
}

export const IMAGE_MAX = 3;
export const AUTO_KIND = 'ship_plus_days';
export const AUTO_DEFAULT_DAYS = 20;

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
  return '';
}

// 저장 요청 본문. 사진이 없으면 image·images 칸을 아예 넣지 않는다. 새 양식은 images(최대 3장)로 보낸다.
export function buildSaveBody({ name, body, image, images, auto }) {
  const list = (Array.isArray(images) ? images : []).filter((item) => item?.data).slice(0, IMAGE_MAX);
  return {
    name: String(name || '').trim(),
    body: String(body || ''),
    ...(image?.data ? { image: { data: image.data } } : {}),
    ...(list.length ? { images: list.map((item) => ({ data: item.data })) } : {}),
    ...(auto ? { auto: auto.kind === AUTO_KIND ? { kind: AUTO_KIND, days: normalizeDays(auto.days) } : { kind: '' } } : {}),
  };
}

// ---------- 자동 발송 문구(카드) ----------
const joinDot = (...parts) => parts.filter(Boolean).join(' · ');
const won = (value) => `${Number(value || 0).toLocaleString('ko-KR')}원`;
const shortDate = (value) => { const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(value || '')); return m ? `${Number(m[1])}/${Number(m[2])}` : ''; };

// 발송 조건 한 줄
export const autoConditionLine = (entry) => (entry?.autoKind === AUTO_KIND ? joinDot(`출고 완료 후 ${entry.autoDays}일 뒤`, '오전 10시', '고객') : '');

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
      autoKind: item.auto_kind === AUTO_KIND ? AUTO_KIND : '',
      autoDays: Number(item.auto_days) || 0,
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

// 단건 조회의 base64 사진 → SendPanel 이 쓰는 { data, bytes, url }
export function imageFromItem(item) {
  const data = typeof item?.image === 'string' ? item.image : '';
  if (!data) return null;
  return { data, bytes: Math.floor((data.length * 3) / 4), url: `data:image/jpeg;base64,${data}` };
}
