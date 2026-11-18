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
// - 사진 문자(MMS): https://solapi.com/pricing 의 '사진 MMS' 110원(VAT 미포함, 2026-11-12 확인). 환경값 SMS_PRICE_MMS 로 바꿀 수 있다.
const DEFAULT_PRICE = Object.freeze({ SMS: 18, LMS: 45, MMS: 110 });

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
  const raw = Number(env[type === 'MMS' ? 'SMS_PRICE_MMS' : type === 'LMS' ? 'SMS_PRICE_LMS' : 'SMS_PRICE_SMS']);
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
  async send({ type, from, recipients, text, subject, fileId, scheduledAt }, { fetchImpl } = {}) {
    const messages = recipients.map(to => {
      const message = { to, from, text, type };
      if ((type === 'LMS' || type === 'MMS') && subject) message.subject = subject;
      if (fileId) message.imageId = fileId;
      return message;
    });
    const body = { messages, allowDuplicates: false, showMessageList: false };
    if (scheduledAt) body.scheduledDate = scheduledAt; // ISO 8601(UTC). SDK 6.1.0 도 Date 를 JSON 으로 같은 모양으로 보낸다.
    let payload;
    try {
      payload = await call('messages/v4/send-many/detail', { method: 'POST', body }, { fetchImpl });
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

// ---- 사진 문자·예약 취소 (2026-11-12, solapi-nodejs SDK 6.1.0 dist/index.js·index.d.ts 에서 확인) ----
// - 파일 올리기: POST storage/v1/files { file:<base64>, type:'MMS', name } → { fileId }. SDK 주석: MMS 사진은 200KB 제한.
// - 사진 문자: 메시지 { type:'MMS', imageId:<fileId>, text, subject? }. (SDK messageSchema 의 imageId)
// - 예약 발송: 발송 본문 scheduledDate(ISO). 응답 groupInfo.groupId 가 그룹 id.
// - 예약 취소: DELETE messages/v4/groups/{groupId}/schedule (SDK removeReservationToGroup, 그룹 안 메시지는 실패 처리됨)
export const MMS_MAX_BYTES = 200 * 1024;
// type 을 안 주면 'MMS'(기존 호출 그대로). 알림톡 템플릿 이미지는 type 'ATA'(쏠라피 문서, 500KB).
solapi.uploadImage = async function uploadImage({ base64, name, type = 'MMS' }, { fetchImpl } = {}) {
  const payload = await call('storage/v1/files', { method: 'POST', body: { file: base64, type, name: String(name || 'photo.jpg').slice(0, 60) } }, { fetchImpl });
  const fileId = payload?.fileId;
  if (!fileId) throw new Error('fileId 없음');
  return { fileId: String(fileId).slice(0, 80) };
};
// → { ok, error }
solapi.cancelSchedule = async function cancelSchedule({ groupId }, { fetchImpl } = {}) {
  if (!/^[\w-]{4,64}$/.test(String(groupId || ''))) return { ok: false, error: '예약 번호가 올바르지 않습니다.' };
  try {
    await call(`messages/v4/groups/${groupId}/schedule`, { method: 'DELETE' }, { fetchImpl });
    return { ok: true, error: '' };
  } catch (error) {
    const status = Number(error?.status);
    return { ok: false, error: status >= 400 && status < 500 ? String(error.publicMessage || '쏠라피에서 거절했습니다.').slice(0, 200) : '취소했는지 확인하지 못했습니다.' };
  }
};

// ---- 받는 사람마다 본문·사진이 다른 발송(자동 발송용, 2026-11-13) ----
// send-many 1회. messages:[{to,text,fileId?,subject?}]. 사진이 있으면 MMS, 없으면 글자 수로 SMS·LMS. 응답은 send 와 같은 모양
// { accepted, failed, groupId, uncertain, error }. 기존 send 는 바꾸지 않는다.
solapi.sendEach = async function sendEach({ from, messages }, { fetchImpl } = {}) {
  const list = (Array.isArray(messages) ? messages : []).map(item => {
    const type = item.fileId ? 'MMS' : (classifyText(item.text, item.subject).type || 'LMS');
    const message = { to: item.to, from, text: item.text, type };
    if ((type === 'LMS' || type === 'MMS') && item.subject) message.subject = item.subject;
    if (item.fileId) message.imageId = item.fileId;
    return message;
  });
  const total = list.length;
  let payload;
  try {
    payload = await call('messages/v4/send-many/detail', { method: 'POST', body: { messages: list, allowDuplicates: false, showMessageList: false } }, { fetchImpl });
  } catch (error) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) return { accepted: 0, failed: total, groupId: null, uncertain: false, error: String(error.publicMessage || '쏠라피에서 거절했습니다.').slice(0, 200) };
    return { accepted: 0, failed: 0, groupId: null, uncertain: true, error: '보냈는지 확인하지 못했습니다. 발송 내역을 확인해 주세요' };
  }
  const failedList = Array.isArray(payload?.failedMessageList) ? payload.failedMessageList.length : 0;
  const failed = Math.min(total, Math.max(failedList, toInt(payload?.groupInfo?.count?.registeredFailed)));
  const groupId = payload?.groupInfo?.groupId || payload?.groupInfo?._id || null;
  return { accepted: total - failed, failed, groupId: groupId ? String(groupId).slice(0, 64) : null, uncertain: false, error: '' };
};

// ---- 받는 사람마다 변수가 다른 알림톡(자동 발송용, 2026-11-13 설계 19-3) ----
// send-many 1회. messages:[{to, templateId, variables:{이름:값}}]. 같은 채널(pfId)·발신번호. 응답은 sendEach 와 같은 모양. 기존 sendKakao 는 바꾸지 않는다.
solapi.sendKakaoEach = async function sendKakaoEach({ from, pfId, messages, disableSms = true }, { fetchImpl } = {}) {
  const list = (Array.isArray(messages) ? messages : []).map(item => {
    const variables = {};
    for (const [name, value] of Object.entries(item.variables || {})) variables[`#{${name}}`] = String(value ?? '');
    return { to: item.to, from, type: 'ATA', kakaoOptions: { pfId, templateId: item.templateId, variables, disableSms: disableSms !== false } };
  });
  const total = list.length;
  let payload;
  try {
    payload = await call('messages/v4/send-many/detail', { method: 'POST', body: { messages: list, allowDuplicates: false, showMessageList: false } }, { fetchImpl });
  } catch (error) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) return { accepted: 0, failed: total, groupId: null, uncertain: false, error: String(error.publicMessage || '쏠라피에서 거절했습니다.').slice(0, 200) };
    return { accepted: 0, failed: 0, groupId: null, uncertain: true, error: '보냈는지 확인하지 못했습니다. 발송 내역을 확인해 주세요' };
  }
  const failedList = Array.isArray(payload?.failedMessageList) ? payload.failedMessageList.length : 0;
  const failed = Math.min(total, Math.max(failedList, toInt(payload?.groupInfo?.count?.registeredFailed)));
  const groupId = payload?.groupInfo?.groupId || payload?.groupInfo?._id || null;
  const failedTo = Array.isArray(payload?.failedMessageList) ? payload.failedMessageList.map(item => String(item?.to ?? '').replace(/\D/g, '')).filter(Boolean) : []; // 실패 번호(있을 때만 자동 발송이 그 번호 행만 failed 로 기록)
  return { accepted: total - failed, failed, groupId: groupId ? String(groupId).slice(0, 64) : null, uncertain: false, error: '', ...(failedTo.length ? { failedTo } : {}) };
};

// ---- 브랜드메시지 자유형(BMS_FREE, 2026-11-17 설계_브랜드메시지_자유형) ----
// 단가(VAT 미포함, 2026-11-17 사장님과 확인): 자유형 100원, 실패해 장문문자(LMS)로 대체되면 45원. 환경값 SMS_PRICE_BMS 로 바꿀 수 있다.
// 메시지 { to, from, type:'BMS_FREE', text, kakaoOptions:{ pfId, disableSms:false, bms:{ targeting:'I', chatBubbleType:'TEXT'|'IMAGE', imageId?, buttons:[{ name, linkType:'WL', linkMobile }] } } }
// disableSms:false = 카카오로 못 보내면(채널 친구가 아니면) 같은 본문이 장문문자로 대체 발송된다. targeting 'I' = 채널 친구 대상(M·N 은 카카오 인허가 채널만).
const DEFAULT_BMS_PRICE = 100;
// 원본 블로그 리뷰 BMS_FREE 메시지처럼 최상위 subject 에 광고 머리말(tests/solapi-message-log.test.mjs 130줄). 대체 LMS 머리말이 여기서 오는지는 시험 발송 1건으로 확인한다.
const BMS_AD_SUBJECT = '(광고)한성쇼케이스그룹';
solapi.estimateBms = function estimateBms({ count }, env = process.env) {
  const raw = env.SMS_PRICE_BMS;
  const n = raw === undefined || raw === '' ? DEFAULT_BMS_PRICE : Number(raw);
  const unit = Number.isFinite(n) && n > 0 ? n : null;
  return { unit, total: unit === null ? null : unit * toInt(count), fallback_unit: unitPrice('LMS', env), currency: 'KRW' };
};
// messages:[{ to, text, imageId?, buttons:[{name, link}] }] → sendKakaoEach 와 같은 모양 { accepted, failed, groupId, uncertain, error, failedTo? }
solapi.sendBmsEach = async function sendBmsEach({ from, pfId, messages }, { fetchImpl } = {}) {
  const list = (Array.isArray(messages) ? messages : []).map(item => {
    const bms = { targeting: 'I', chatBubbleType: item.imageId ? 'IMAGE' : 'TEXT' };
    if (item.imageId) bms.imageId = item.imageId;
    const buttons = (Array.isArray(item.buttons) ? item.buttons : []).map(button => ({ name: button.name, linkType: 'WL', linkMobile: button.link, ...(button.linkPc ? { linkPc: button.linkPc } : {}) }));
    if (buttons.length) bms.buttons = buttons;
    return { to: item.to, from, type: 'BMS_FREE', subject: BMS_AD_SUBJECT, text: item.text, kakaoOptions: { pfId, disableSms: false, bms } };
  });
  const total = list.length;
  let payload;
  try {
    payload = await call('messages/v4/send-many/detail', { method: 'POST', body: { messages: list, allowDuplicates: false, showMessageList: false } }, { fetchImpl });
  } catch (error) {
    const status = Number(error?.status);
    if (status >= 400 && status < 500) return { accepted: 0, failed: total, groupId: null, uncertain: false, error: String(error.publicMessage || '쏠라피에서 거절했습니다.').slice(0, 200) };
    return { accepted: 0, failed: 0, groupId: null, uncertain: true, error: '보냈는지 확인하지 못했습니다. 발송 내역을 확인해 주세요' };
  }
  const failedList = Array.isArray(payload?.failedMessageList) ? payload.failedMessageList.length : 0;
  const failed = Math.min(total, Math.max(failedList, toInt(payload?.groupInfo?.count?.registeredFailed)));
  const groupId = payload?.groupInfo?.groupId || payload?.groupInfo?._id || null;
  const failedTo = Array.isArray(payload?.failedMessageList) ? payload.failedMessageList.map(item => String(item?.to ?? '').replace(/\D/g, '')).filter(Boolean) : [];
  return { accepted: total - failed, failed, groupId: groupId ? String(groupId).slice(0, 64) : null, uncertain: false, error: '', ...(failedTo.length ? { failedTo } : {}) };
};

// 접수된 그룹의 최종 결과 조회(GET messages/v4/groups/{groupId}, 조회 전용). 4xx·5xx·예외는 null(던지지 않는다).
// → { status, success, replacement, failed, total, log(마지막 로그 문구) }. status 'COMPLETE' 가 아니면 아직 처리 중이다.
solapi.groupResult = async function groupResult(groupId, { fetchImpl } = {}) {
  const id = String(groupId ?? '').trim();
  if (!id) return null;
  try {
    const payload = await call(`messages/v4/groups/${encodeURIComponent(id)}`, {}, { fetchImpl });
    if (!payload || typeof payload !== 'object') return null;
    const g = payload?.groupInfo || payload?.group || payload;
    const count = g.count || {};
    const nInt = value => (value === undefined || value === null || value === '' || !Number.isFinite(Number(value)) ? null : toInt(value)); // 필드가 없으면 0 이 아니라 null
    const log = Array.isArray(g.log) && g.log.length ? g.log[g.log.length - 1] : null;
    return { status: String(g.status || ''), success: nInt(count.sentSuccess), replacement: nInt(count.sentReplacement), failed: nInt(count.sentFailed), total: nInt(count.total), log: String(log?.message ?? '') };
  } catch { return null; }
};

const PROVIDERS = { solapi };

export function getSendProvider(name = process.env.SMS_SEND_PROVIDER || 'solapi') {
  return PROVIDERS[name] || null;
}
