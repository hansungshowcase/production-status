// 문자 직접 보내기용 발송 업체 층. 업체마다 estimate / send 두 함수만 맞추면 갈아 끼울 수 있다(알리고는 계정·키를 받은 뒤 PROVIDERS 에 더한다).
// 번호·본문은 이 파일에서 기록하지 않는다. 여러 명은 업체의 여러 건 발송 API 를 1회만 부른다(폴링 없음).
import { call } from './kakaoTemplates.js';

// 쏠라피 문서에서 확인한 값 (확인 날짜 2026-11-12)
// - 단가: https://solapi.com/pricing — SMS 18원 / LMS 45원 (VAT 미포함). 환경값 SMS_PRICE_SMS · SMS_PRICE_LMS 로 바꿀 수 있다.
// - SMS 는 EUC-KR 90바이트(한글 45자) 이하, LMS 는 2,000바이트(한글 1,000자) 이하.
// - 여러 건 발송: POST https://api.solapi.com/messages/v4/send-many/detail, 본문 { messages:[{to,from,text,type,subject?}], allowDuplicates, showMessageList }.
//   1회 최대 건수는 SDK 문서에 10,000건(공식 개발 문서 본문은 확인하지 못함). 이 프로그램은 SMS_SEND_MAX_RECIPIENTS(기본 50)로 훨씬 작게 제한한다.
export const SMS_MAX_BYTES = 90;
export const LMS_MAX_BYTES = 2000;
const DEFAULT_PRICE = Object.freeze({ SMS: 18, LMS: 45 });

// 한글(비 ASCII) 2바이트, 그 밖 1바이트
export function byteLength(text) {
  let bytes = 0;
  for (const ch of String(text ?? '')) bytes += ch.codePointAt(0) <= 0x7f ? 1 : 2;
  return bytes;
}

// { bytes, type:'SMS'|'LMS'|null } — 제목이 있으면 LMS, 2,000바이트를 넘으면 null
export function classifyText(text, subject = '') {
  const bytes = byteLength(text);
  if (bytes > LMS_MAX_BYTES) return { bytes, type: null };
  return { bytes, type: bytes <= SMS_MAX_BYTES && !String(subject || '').trim() ? 'SMS' : 'LMS' };
}

function unitPrice(type, env = process.env) {
  const raw = Number(env[type === 'LMS' ? 'SMS_PRICE_LMS' : 'SMS_PRICE_SMS']);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_PRICE[type];
}

const toInt = value => (Number.isFinite(Number(value)) ? Math.max(0, Math.trunc(Number(value))) : 0);

const solapi = {
  name: 'solapi',
  estimate({ type, count }, env = process.env) {
    const unit = unitPrice(type, env);
    return { unit, total: unit * toInt(count), currency: 'KRW' };
  },
  // → { accepted, failed, groupId, uncertain, error }
  //   accepted+failed = 보낸 건수. uncertain=true 면 업체가 받았는지 알 수 없다(다시 보내지 말고 발송 내역에서 확인).
  async send({ type, from, recipients, text, subject }, { fetchImpl } = {}) {
    const messages = recipients.map(to => {
      const message = { to, from, text, type };
      if (type === 'LMS' && subject) message.subject = subject;
      return message;
    });
    let payload;
    try {
      payload = await call('messages/v4/send-many/detail', {
        method: 'POST', body: { messages, allowDuplicates: false, showMessageList: false },
      }, { fetchImpl });
    } catch (error) {
      const status = Number(error?.status);
      if (status >= 400 && status < 500) return { accepted: 0, failed: recipients.length, groupId: null, uncertain: false, error: String(error.publicMessage || '쏠라피에서 거절했습니다.').slice(0, 200) };
      return { accepted: 0, failed: 0, groupId: null, uncertain: true, error: '보냈는지 확인하지 못했습니다. 발송 내역을 확인해 주세요' };
    }
    const failedList = Array.isArray(payload?.failedMessageList) ? payload.failedMessageList.length : 0;
    const failed = Math.min(recipients.length, Math.max(failedList, toInt(payload?.groupInfo?.count?.registeredFailed)));
    const groupId = payload?.groupInfo?.groupId || payload?.groupInfo?._id || null;
    return { accepted: recipients.length - failed, failed, groupId: groupId ? String(groupId).slice(0, 64) : null, uncertain: false, error: '' };
  },
};

// ---- 알림톡(승인된 템플릿) ----
// 확인한 규격(2026-11-12): solapi-nodejs SDK 6.1.0 의 타입 정의(dist/index.d.ts)·소스(dist/index.js)
// - 메시지 { to, from, type:'ATA', kakaoOptions:{ pfId, templateId, variables, disableSms } }
// - disableSms:true 가 문자 대체 발송 끄기. variables 의 키는 '#{이름}' 모양(SDK formatVariableKey 가 '이름' 도 '#{이름}' 으로 바꿔 보냄).
// - 단가: https://solapi.com/pricing — 알림톡 1건 13원(VAT 미포함, 유형 무관). 환경값 SMS_PRICE_ATA 로 바꿀 수 있다. 값이 숫자가 아니면 단가를 모름(null)으로 돌려준다.
const DEFAULT_ATA_PRICE = 13;
function kakaoUnitPrice(env = process.env) {
  const raw = env.SMS_PRICE_ATA;
  if (raw === undefined || raw === '') return DEFAULT_ATA_PRICE;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : null;
}
solapi.estimateKakao = function estimateKakao({ count }, env = process.env) {
  const unit = kakaoUnitPrice(env);
  return { unit, total: unit === null ? null : unit * toInt(count), currency: 'KRW' };
};
// → send 와 같은 모양 { accepted, failed, groupId, uncertain, error }. 문자 대체는 끈다(실패 사유를 그대로 보인다).
solapi.sendKakao = async function sendKakao({ from, recipients, pfId, templateId, variables }, { fetchImpl } = {}) {
  const kakaoVariables = {};
  for (const [name, value] of Object.entries(variables || {})) kakaoVariables[`#{${name}}`] = String(value ?? '');
  const messages = recipients.map(to => ({
    to, from, type: 'ATA',
    kakaoOptions: { pfId, templateId, variables: kakaoVariables, disableSms: true },
  }));
  let payload;
  try {
    payload = await call('messages/v4/send-many/detail', {
      method: 'POST', body: { messages, allowDuplicates: false, showMessageList: false },
    }, { fetchImpl });
  } catch (error) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) return { accepted: 0, failed: recipients.length, groupId: null, uncertain: false, error: String(error.publicMessage || '쏠라피에서 거절했습니다.').slice(0, 200) };
    return { accepted: 0, failed: 0, groupId: null, uncertain: true, error: '보냈는지 확인하지 못했습니다. 발송 내역을 확인해 주세요' };
  }
  const failedList = Array.isArray(payload?.failedMessageList) ? payload.failedMessageList.length : 0;
  const failed = Math.min(recipients.length, Math.max(failedList, toInt(payload?.groupInfo?.count?.registeredFailed)));
  const groupId = payload?.groupInfo?.groupId || payload?.groupInfo?._id || null;
  return { accepted: recipients.length - failed, failed, groupId: groupId ? String(groupId).slice(0, 64) : null, uncertain: false, error: '' };
};

const PROVIDERS = { solapi };

export function getSendProvider(name = process.env.SMS_SEND_PROVIDER || 'solapi') {
  return PROVIDERS[name] || null;
}
