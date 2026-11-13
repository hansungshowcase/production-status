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

// 내 문구 선택 칸 묶음: 내 문구 / 자동 발송 문구(auto_kind 있음). 빈 묶음은 뺀다.
export function groupTexts(items) {
  const list = items || [];
  return [
    { label: '내 문구', items: list.filter(item => !item.auto_kind) },
    { label: '자동 발송 문구', items: list.filter(item => item.auto_kind) },
  ].filter(group => group.items.length);
}

// 보내기 한 버튼의 글자: 처음 '보내기' → 요약 확인 뒤 'N명에게 보내기 확인'(예약이면 '예약 확인')
export function sendButtonLabel(busy, preview) {
  if (busy === 'preview') return '확인 중…';
  if (busy === 'send') return '보내는 중…';
  if (!preview) return '보내기';
  return preview.at ? '예약 확인' : `${preview.count}명에게 보내기 확인`;
}

// ---- 알림톡 템플릿으로 보내기 ----
// 템플릿의 변수 이름 목록(쏠라피 variables 의 '#{이름}' 과 본문의 #{이름} 을 합침). 서버 smsManualSend.js templateVariableNames 와 같은 규칙.
export function templateVariableNames(template) {
  const names = [];
  const add = value => {
    const raw = String(value ?? '').trim();
    const match = /^#\{(.+)\}$/.exec(raw);
    const name = (match ? match[1] : raw).trim();
    if (name && !names.includes(name)) names.push(name);
  };
  for (const item of template?.variables || []) add(item);
  for (const match of String(template?.content || '').matchAll(/#\{([^{}]+)\}/g)) add(match[1]);
  return names;
}

// 본문의 #{이름} 을 입력값으로 바꾼다(비어 있으면 그대로 둔다)
export function fillTemplateContent(content, values) {
  return String(content || '').replace(/#\{([^{}]+)\}/g, (all, name) => {
    const value = String(values?.[name.trim()] ?? '').trim();
    return value || all;
  });
}

export const allVariablesFilled = (names, values) => names.every(name => String(values?.[name] ?? '').trim() !== '');

// 미리보기와 보내기가 같은 내용인지 비교하는 서명(번호는 화면 상태 안에서만 쓰고 저장하지 않는다)
export function payloadSignature(recipients, text) {
  return JSON.stringify([recipients, String(text || '').trim()]);
}

// ---- 예약·사진 문자 ----
export const IMAGE_MAX_BYTES = 200 * 1024; // 쏠라피 MMS 사진 용량 상한(SDK 6.1.0 문서 주석)
export const IMAGE_MAX_EDGE = 1500; // 가로·세로 상한은 확인하지 못해 보수적으로 잡은 값
export const SCHEDULE_MIN_MS = 5 * 60 * 1000;

// <input type="datetime-local"> 값(KST 로 입력) → { ok, text, error }. 서버 parseKstSchedule 과 같은 형식('YYYY-MM-DDTHH:mm').
export function scheduleInfo(value, nowMs = Date.now()) {
  const text = String(value || '').trim();
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})$/.exec(text);
  if (!m) return { ok: false, text: '', error: '' };
  const ms = Date.parse(`${text}:00+09:00`);
  if (!Number.isFinite(ms)) return { ok: false, text: '', error: '시각 형식이 올바르지 않습니다.' };
  if (ms < nowMs + SCHEDULE_MIN_MS) return { ok: false, text, error: '지금부터 5분 뒤 이후로 정해 주세요.' };
  return { ok: true, text, error: '' };
}

// 예약 목록·미리보기에 보일 짧은 시각(KST) '11/13 09:30'
export function shortKst(value) {
  const ms = typeof value === 'number' ? value : Date.parse(value);
  if (!Number.isFinite(ms)) return '';
  const t = new Date(ms + 9 * 3600000).toISOString();
  return `${t.slice(5, 7)}/${t.slice(8, 10)} ${t.slice(11, 16)}`;
}

// 긴 변이 max 를 넘으면 비율을 지켜 줄인 크기(자르지 않는다)
export function fitDimensions(width, height, max = IMAGE_MAX_EDGE) {
  const long = Math.max(width, height);
  if (!(long > 0)) return { width: 0, height: 0 };
  const scale = long > max ? max / long : 1;
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

// 브라우저에서 사진을 JPG 로 줄여 규격(200KB·긴 변 1500px) 안에 맞춘다. 안 되면 Error('사진이 너무 큽니다').
// → { data(base64), bytes, url(미리보기용 object URL) }
export async function shrinkImage(file) {
  if (!file || !/^image\//.test(file.type || '')) throw new Error('사진 파일을 골라 주세요.');
  let bitmap;
  try { bitmap = await createImageBitmap(file); } catch { throw new Error('사진 파일을 골라 주세요.'); }
  let { width, height } = fitDimensions(bitmap.width, bitmap.height);
  for (let round = 0; round < 6; round += 1) {
    const canvas = document.createElement('canvas');
    canvas.width = width; canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(bitmap, 0, 0, width, height);
    for (const quality of [0.85, 0.7, 0.55, 0.4]) {
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', quality));
      if (blob && blob.size <= IMAGE_MAX_BYTES) {
        const buffer = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let i = 0; i < buffer.length; i += 0x8000) binary += String.fromCharCode(...buffer.subarray(i, i + 0x8000));
        if (bitmap.close) bitmap.close();
        return { data: btoa(binary), bytes: blob.size, url: URL.createObjectURL(blob) };
      }
    }
    width = Math.max(1, Math.round(width * 0.8)); height = Math.max(1, Math.round(height * 0.8));
  }
  if (bitmap.close) bitmap.close();
  throw new Error('사진이 너무 큽니다');
}
