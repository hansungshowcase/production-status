// 보내기 화면의 순수 계산(화면 없음). 시험이 같이 쓴다. 번호는 이 파일 밖으로 내보내지 않는다.

export const MOBILE_RE = /^01[016789]\d{7,8}$/;

// 여러 줄·쉼표·세미콜론으로 나눈 번호 입력 → [{ digits, ok }] (같은 번호는 한 번만)
export function parsePhoneInput(text) {
  const seen = new Set();
  const list = [];
  for (const raw of String(text || '').split(/[\n,;]+/)) {
    const digits = raw.replace(/\D/g, '');
    if (!digits || seen.has(digits)) continue;
    seen.add(digits);
    list.push({ digits, ok: MOBILE_RE.test(digits) });
  }
  return list;
}

// 보낼 목록: 직접 입력 번호 + 고른 직원 id. 틀린 번호가 있으면 invalid 에 개수만.
export function buildRecipients(phoneText, staffIds) {
  const phones = parsePhoneInput(phoneText);
  const invalid = phones.filter(item => !item.ok).length;
  return { recipients: [...phones.filter(item => item.ok).map(item => item.digits), ...(staffIds || [])], invalid };
}

// 서버(api/_lib/sendProvider.js byteLength)와 같은 규칙: 한글 등 비 ASCII 2바이트, 그 밖 1바이트
export function byteLength(text) {
  let bytes = 0;
  for (const ch of String(text ?? '')) bytes += ch.codePointAt(0) <= 0x7f ? 1 : 2;
  return bytes;
}

export function textInfo(text) {
  const bytes = byteLength(String(text || '').trim());
  return { bytes, type: bytes === 0 ? '' : bytes <= 90 ? 'SMS' : 'LMS', tooLong: bytes > 2000 };
}

// 보내기 버튼 자리에 보일 한 줄(꺼짐). 켜져 있으면 ''.
export function lockedLine(options) {
  if (!options) return '';
  if (!options.enabled) return '발송이 꺼져 있습니다.';
  return '';
}

export function makeIdempotencyKey() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  return `k${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`;
}

// 미리보기와 보내기가 같은 내용인지 비교하는 서명(번호는 화면 상태 안에서만 쓰고 저장하지 않는다)
export function payloadSignature(recipients, text) {
  return JSON.stringify([recipients, String(text || '').trim()]);
}
