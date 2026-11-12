// 문자 직접 보내기('보내기' 메뉴) 서버 처리. api/sms-console.js 의 action 'send' 와 GET resource 'send' 가 쓴다.
// 번호 전체·이름·본문 전문은 DB·응답·로그에 남기지 않는다(받는 번호는 끝 4자리 목록과 해시만).
// notify.js(자동 알림)의 중복 방지·기록 표와는 섞이지 않는다.
import crypto from 'node:crypto';
import { hasSolapiCredentials } from './solapiMessageLog.js';
import { assemblyWorkerPhone, INTERNAL_ALERT_CONTACTS } from './internalProductionAlerts.js';
import { classifyText, getSendProvider, LMS_MAX_BYTES, MMS_MAX_BYTES } from './sendProvider.js';
import { TEMPLATE_ID_RE } from '../../shared/smsConsole.js';

const DEFAULT_MAX_RECIPIENTS = 50;
const DEFAULT_DAILY_LIMIT = 300;
const RAW_RECIPIENT_CAP = 1000;
const KEY_RE = /^[\w-]{8,80}$/;
const MOBILE_RE = /^01[016789]\d{7,8}$/;
const STAFF_ID_RE = /^(contact|worker)-[^\s]{1,40}$/;
const SUBJECT_MAX = 40;
// 조립 직원(이름만 정해 두고 번호는 internalProductionAlerts 의 것을 쓴다)
const ASSEMBLY_WORKER_NAMES = Object.freeze(['카우사르', '나타왓', '마카라', '백승정', '까지']);

const schemaFlags = new Map();
export function _resetManualSendSchemaForTest() { schemaFlags.clear(); }

// 표 만들기: notifySchema.js 와 같은 방식(요청 때 CREATE TABLE IF NOT EXISTS + 같은 인스턴스에서 1회만 실행). 마이그레이션 파일 없음.
export async function ensureManualSendSchema(db) {
  if (schemaFlags.get('sms.manualSends')) return;
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS sms_manual_sends (
      id BIGSERIAL PRIMARY KEY,
      idem_key TEXT NOT NULL UNIQUE,
      sent_at TIMESTAMPTZ DEFAULT NOW(),
      msg_type TEXT,
      recipient_count INT NOT NULL DEFAULT 0,
      success_count INT NOT NULL DEFAULT 0,
      fail_count INT NOT NULL DEFAULT 0,
      text_length INT NOT NULL DEFAULT 0,
      tails TEXT,
      recipients_hash TEXT,
      group_id TEXT,
      status TEXT NOT NULL,
      error TEXT
    )`,
    args: [],
  });
  schemaFlags.set('sms.manualSends', true);
}

const digits = value => String(value ?? '').replace(/\D/g, '');
const intEnv = (value, fallback) => { const n = Number(value); return Number.isInteger(n) && n > 0 ? n : fallback; };

export function sendSettings(env = process.env, writeEnabled = true) {
  return {
    // 템플릿 등록·삭제와 같은 쓰기 스위치(SMS_CONSOLE_WRITE, smsConsoleGuard)가 켜져 있으면 열리고, SMS_SEND=off 로 발송만 끌 수 있다.
    enabled: writeEnabled !== false && env.SMS_SEND !== 'off',
    max: intEnv(env.SMS_SEND_MAX_RECIPIENTS, DEFAULT_MAX_RECIPIENTS),
    daily: intEnv(env.SMS_SEND_DAILY_LIMIT, DEFAULT_DAILY_LIMIT),
  };
}

// 직원 명단: [{ id, name, phone }]  (전체 번호는 서버 안에서만 쓴다)
export function staffDirectory() {
  const list = Object.entries(INTERNAL_ALERT_CONTACTS).map(([key, item]) => ({ id: `contact-${key}`, name: item.name, phone: digits(item.phone) }));
  for (const name of ASSEMBLY_WORKER_NAMES) {
    const phone = digits(assemblyWorkerPhone(name));
    if (phone) list.push({ id: `worker-${name}`, name, phone });
  }
  return list;
}

// GET resource=send — 화면이 열릴 때 1번. 번호 전체는 주지 않고 끝 4자리만 준다.
export function sendOptions(env = process.env, staff = staffDirectory(), writeEnabled = true) {
  const settings = sendSettings(env, writeEnabled);
  return {
    enabled: settings.enabled, max: settings.max,
    staff: staff.map(item => ({ id: item.id, name: item.name, tail: item.phone.slice(-4) })),
  };
}

const reply = (status, body) => ({ status, body });
const errorReply = (status, message) => reply(status, { error: { message, status } });

function kstDayStartIso(nowMs) {
  const kstDate = new Date(nowMs + 9 * 3600000).toISOString().slice(0, 10);
  return new Date(Date.parse(`${kstDate}T00:00:00Z`) - 9 * 3600000).toISOString();
}

// 받는 사람 목록(번호 또는 직원 id) → { phones:[숫자만, 중복 제거] } | { error }
function resolveRecipients(list, staff) {
  if (!Array.isArray(list) || !list.length) return { error: '받는 사람을 넣어 주세요.' };
  if (list.length > RAW_RECIPIENT_CAP) return { error: '받는 사람이 너무 많습니다.' };
  const byId = new Map(staff.map(item => [item.id, item.phone]));
  const phones = [];
  let bad = 0;
  for (const item of list) {
    const text = typeof item === 'string' ? item.trim() : '';
    const phone = STAFF_ID_RE.test(text) ? byId.get(text) : digits(text);
    if (!phone || !MOBILE_RE.test(phone)) { bad += 1; continue; }
    if (!phones.includes(phone)) phones.push(phone);
  }
  if (bad) return { error: `받는 번호 ${bad}개가 휴대폰 번호 형식이 아닙니다.` };
  return { phones };
}

// 처리 순서(비밀번호는 두지 않는다 - 2026-11-12 사장님 결정): ① 스위치 ③ 입력 검증 ④ 1회 인원 ⑤ 하루 상한 ⑥ 멱등 키 ⑦ dry_run ⑧ 업체 호출 ⑨ 기록
// 안 해 둔 것: dry_run 은 멱등 키를 쓰지 않고(기록 없음) 하루 상한만 읽기로 확인한다.
export async function runSend(body, { env = process.env, db, provider, fetchImpl, nowMs = Date.now(), staff, writeEnabled = true } = {}) {
  const settings = sendSettings(env, writeEnabled);
  if (!settings.enabled) return errorReply(403, '발송이 꺼져 있습니다.');

  const dryRun = body.dry_run === true;
  const text = typeof body.text === 'string' ? body.text.replace(/\r\n?/g, '\n').trim() : '';
  const subject = typeof body.subject === 'string' ? body.subject.trim() : '';
  if (!text) return errorReply(400, '내용을 넣어 주세요.');
  if ([...subject].length > SUBJECT_MAX) return errorReply(400, `제목은 ${SUBJECT_MAX}자 이하로 적어 주세요.`);
  if (/^\(광고\)/.test(text) || /^\(광고\)/.test(subject)) return errorReply(400, '광고 문자는 아직 여기서 보낼 수 없습니다.');
  const kind = classifyText(text, subject);
  if (!kind.type) return errorReply(400, `내용은 ${LMS_MAX_BYTES}바이트(한글 약 ${LMS_MAX_BYTES / 2}자) 이하로 적어 주세요.`);
  const resolved = resolveRecipients(body.recipients, staff || staffDirectory());
  if (resolved.error) return errorReply(400, resolved.error);
  const phones = resolved.phones;
  const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  if (!dryRun && !KEY_RE.test(key)) return errorReply(400, '올바른 요청이 아닙니다.');

  if (phones.length > settings.max) return errorReply(400, `한 번에 ${settings.max}명까지 보낼 수 있습니다.`);

  // 예약·사진(둘 다 없으면 아래 값은 모두 비어 있고 지금과 같은 경로를 탄다)
  const extra = parseSendExtras(body, { env, nowMs });
  if (extra.error) return errorReply(400, extra.error);
  const msgType = extra.image ? 'MMS' : kind.type;

  await ensureManualSendSchema(db);
  if (extra.scheduled) await ensureScheduleColumn(db);
  const { rows: usedRows } = await db.execute({
    sql: 'SELECT COALESCE(SUM(recipient_count), 0)::int AS n FROM sms_manual_sends WHERE sent_at >= ?',
    args: [kstDayStartIso(nowMs)],
  });
  const used = Number(usedRows?.[0]?.n) || 0;
  if (used + phones.length > settings.daily) return errorReply(429, `하루 ${settings.daily}건까지 보낼 수 있습니다. 오늘 ${used}건 보냈습니다.`);

  const vendor = provider || getSendProvider();
  if (!vendor) return errorReply(503, '발송 업체가 설정되지 않았습니다.');
  if (extra.image && typeof vendor.uploadImage !== 'function') return errorReply(503, '이 발송 업체는 사진 문자를 지원하지 않습니다.');
  const estimate = vendor.estimate({ type: msgType, count: phones.length }, env);
  if (dryRun) {
    const preview = { dry_run: true, count: phones.length, type: msgType, bytes: kind.bytes, cost: estimate.total, unit: estimate.unit };
    if (extra.scheduled) preview.scheduled_at = extra.scheduled.text;
    return reply(200, preview);
  }

  const from = digits(env.SMS_SENDER);
  if (!from) return errorReply(503, '발신번호가 설정되지 않았습니다.');
  if (!provider && !hasSolapiCredentials()) return errorReply(503, '쏠라피 연결이 설정되지 않았습니다.');

  const tails = phones.map(phone => phone.slice(-4)).join(',');
  const hash = crypto.createHmac('sha256', String(env.SOLAPI_API_SECRET || 'sms-manual-send')).update([...phones].sort().join(',')).digest('hex');
  const inserted = await db.execute({
    sql: `INSERT INTO sms_manual_sends (idem_key, msg_type, recipient_count, text_length, tails, recipients_hash, status)
          VALUES (?, ?, ?, ?, ?, ?, 'sending') ON CONFLICT (idem_key) DO NOTHING RETURNING id`,
    args: [key, msgType, phones.length, [...text].length, tails, hash],
  });
  if (!inserted.rows?.length) {
    const { rows } = await db.execute({
      sql: 'SELECT status, msg_type, recipient_count, success_count, fail_count FROM sms_manual_sends WHERE idem_key = ?',
      args: [key],
    });
    const row = rows?.[0] || {};
    return reply(200, { sent: row.status === 'sent' || row.status === 'partial', duplicate: true, status: row.status || 'sending', type: row.msg_type || msgType,
      count: Number(row.recipient_count) || phones.length, success: Number(row.success_count) || 0, fail: Number(row.fail_count) || 0 });
  }

  // INSERT 뒤 합계를 다시 읽는다: 동시 요청이 INSERT 전 확인을 함께 통과해도 여기서 막힌다(방금 넣은 행 포함, rejected 행은 0건).
  const { rows: afterRows } = await db.execute({
    sql: 'SELECT COALESCE(SUM(recipient_count), 0)::int AS n FROM sms_manual_sends WHERE sent_at >= ?',
    args: [kstDayStartIso(nowMs)],
  });
  const usedAfter = Number(afterRows?.[0]?.n) || 0;
  if (usedAfter > settings.daily) {
    await db.execute({ sql: "UPDATE sms_manual_sends SET status = 'rejected', recipient_count = 0 WHERE idem_key = ?", args: [key] });
    return errorReply(429, `하루 ${settings.daily}건까지 보낼 수 있습니다. 오늘 ${Math.max(0, usedAfter - phones.length)}건 보냈습니다.`);
  }

  let fileId = '';
  if (extra.image) {
    // 올리기는 멱등 확인(위 중복 응답) 뒤에 1번만 한다. 올리기가 실패하면 아무것도 안 나갔으므로 같은 키로 다시 보낼 수 있게 기록을 지운다.
    try {
      fileId = (await vendor.uploadImage({ base64: extra.image.base64, name: extra.image.name }, { fetchImpl }))?.fileId || '';
    } catch { fileId = ''; }
    if (!fileId) {
      try { await db.execute({ sql: 'DELETE FROM sms_manual_sends WHERE idem_key = ?', args: [key] }); } catch { /* 기록 정리 실패는 무시 */ }
      return errorReply(502, '사진을 올리지 못했습니다. 다시 시도해 주세요.');
    }
  }
  const sendInput = { type: msgType, from, recipients: phones, text, subject };
  if (fileId) sendInput.fileId = fileId;
  if (extra.scheduled) sendInput.scheduledAt = extra.scheduled.iso;
  let result;
  try {
    result = await vendor.send(sendInput, { fetchImpl });
  } catch {
    result = { accepted: 0, failed: 0, groupId: null, uncertain: true, error: '보냈는지 확인하지 못했습니다. 발송 내역을 확인해 주세요' };
  }
  const status = result.uncertain ? 'uncertain' : result.failed === 0 ? 'sent' : result.accepted === 0 ? 'failed' : 'partial';
  try {
    await db.execute({
      sql: 'UPDATE sms_manual_sends SET status = ?, success_count = ?, fail_count = ?, group_id = ?, error = ? WHERE idem_key = ?',
      args: [status, result.accepted || 0, result.failed || 0, result.groupId || null, result.error ? String(result.error).slice(0, 200) : null, key],
    });
  } catch { /* 기록 실패가 이미 끝난 발송 결과 응답을 막지 않게 한다 */ }
  if (extra.scheduled && status !== 'failed') {
    try { await db.execute({ sql: 'UPDATE sms_manual_sends SET scheduled_at = ? WHERE idem_key = ?', args: [extra.scheduled.iso, key] }); } catch { /* 기록 실패가 이미 끝난 예약 응답을 막지 않게 한다 */ }
  }
  console.info('[sms-send]', status, phones.length, msgType);
  const out = { sent: status === 'sent' || status === 'partial', status, type: msgType, count: phones.length, success: result.accepted || 0, fail: result.failed || 0, cost: estimate.total };
  if (extra.scheduled) out.scheduled_at = extra.scheduled.text;
  if (result.uncertain) out.uncertain = true;
  if (result.error) out.message = String(result.error).slice(0, 200);
  return reply(200, out);
}

// ---- 승인된 알림톡 템플릿으로 보내기 (action 'send' 에 kakao:{templateId, variables} 가 있을 때) ----
// 문자 발송(runSend)은 건드리지 않고, 같은 상한·멱등·기록 표·1회 인원 규칙을 따로 한 번 더 지난다.
// 채널(pfId)은 요청에서 받지 않고 서버가 다시 읽은 템플릿의 것만 쓴다. 변수 값·본문·번호 전체는 저장하지 않는다.
const VARIABLE_VALUE_MAX = 1000;
const variableName = key => { const m = /^#\{(.+)\}$/.exec(String(key ?? '').trim()); return (m ? m[1] : String(key ?? '')).trim(); };

// 템플릿의 변수 이름 목록(쏠라피 variables 의 '#{이름}' 과 본문의 #{이름} 을 합침, 중복 제거)
export function templateVariableNames(template) {
  const names = [];
  const add = value => { const name = variableName(value); if (name && !names.includes(name)) names.push(name); };
  for (const item of template?.variables || []) add(item);
  for (const match of String(template?.content || '').matchAll(/#\{([^{}]+)\}/g)) add(match[1]);
  return names;
}

export async function runKakaoSend(body, { env = process.env, db, provider, fetchImpl, nowMs = Date.now(), staff, writeEnabled = true, kakao, kakaoOpts } = {}) {
  const settings = sendSettings(env, writeEnabled);
  if (!settings.enabled) return errorReply(403, '발송이 꺼져 있습니다.');

  const dryRun = body.dry_run === true;
  const request = body.kakao && typeof body.kakao === 'object' && !Array.isArray(body.kakao) ? body.kakao : null;
  const templateId = typeof request?.templateId === 'string' ? request.templateId : '';
  if (!TEMPLATE_ID_RE.test(templateId)) return errorReply(400, '올바른 템플릿이 아닙니다.');
  const given = request.variables && typeof request.variables === 'object' && !Array.isArray(request.variables) ? request.variables : {};
  const resolved = resolveRecipients(body.recipients, staff || staffDirectory());
  if (resolved.error) return errorReply(400, resolved.error);
  const phones = resolved.phones;
  const key = typeof body.idempotencyKey === 'string' ? body.idempotencyKey : '';
  if (!dryRun && !KEY_RE.test(key)) return errorReply(400, '올바른 요청이 아닙니다.');
  if (phones.length > settings.max) return errorReply(400, `한 번에 ${settings.max}명까지 보낼 수 있습니다.`);

  // 템플릿은 쏠라피에서 다시 읽어 확인한다(한성 채널·승인 상태). 하나라도 아니면 업체 발송 호출 0.
  let found;
  try {
    found = await kakao.getTemplateFresh(templateId, kakaoOpts);
  } catch {
    return errorReply(502, '템플릿을 쏠라피에서 불러오지 못했습니다.');
  }
  if (!found) return errorReply(404, '템플릿을 찾을 수 없습니다.');
  if (!found.scope?.allowed) return errorReply(403, '이 템플릿은 보낼 수 없는 채널의 템플릿입니다.');
  const template = found.template || {};
  if (template.status !== 'APPROVED') return errorReply(409, '승인된 템플릿만 보낼 수 있습니다.');
  let pfId = typeof found.raw?.channelId === 'string' ? found.raw.channelId : '';
  // 그룹 템플릿은 채널 id 가 비어 있다. 한성 것으로 허용된 그룹 템플릿이면 자동 알림과 같은 서버 환경값을 쓴다.
  if (!pfId && found.scope?.kind === 'group' && typeof env.KAKAO_PF_ID === 'string') pfId = env.KAKAO_PF_ID;
  if (!pfId) return errorReply(409, '이 템플릿은 보낼 채널이 정해져 있지 않아 여기서 보낼 수 없습니다.');

  const variables = {};
  const missing = [];
  const byName = new Map(Object.entries(given).map(([name, value]) => [variableName(name), value]));
  for (const name of templateVariableNames(template)) {
    const value = byName.get(name);
    const text = typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
    if (!text) { missing.push(name); continue; }
    if ([...text].length > VARIABLE_VALUE_MAX) return errorReply(400, `변수 값은 ${VARIABLE_VALUE_MAX}자 이하로 적어 주세요.`);
    variables[name] = text;
  }
  if (missing.length) return errorReply(400, `변수를 채워 주세요: ${missing.join(', ')}`);

  await ensureManualSendSchema(db);
  const { rows: usedRows } = await db.execute({
    sql: 'SELECT COALESCE(SUM(recipient_count), 0)::int AS n FROM sms_manual_sends WHERE sent_at >= ?',
    args: [kstDayStartIso(nowMs)],
  });
  const used = Number(usedRows?.[0]?.n) || 0;
  if (used + phones.length > settings.daily) return errorReply(429, `하루 ${settings.daily}건까지 보낼 수 있습니다. 오늘 ${used}건 보냈습니다.`);

  const vendor = provider || getSendProvider();
  if (!vendor || typeof vendor.sendKakao !== 'function' || typeof vendor.estimateKakao !== 'function') return errorReply(503, '발송 업체가 설정되지 않았습니다.');
  const estimate = vendor.estimateKakao({ count: phones.length }, env);
  if (dryRun) return reply(200, { dry_run: true, count: phones.length, type: 'ATA', cost: estimate.total, unit: estimate.unit });

  const from = digits(env.SMS_SENDER);
  if (!from) return errorReply(503, '발신번호가 설정되지 않았습니다.');
  if (!provider && !hasSolapiCredentials()) return errorReply(503, '쏠라피 연결이 설정되지 않았습니다.');

  const tails = phones.map(phone => phone.slice(-4)).join(',');
  const hash = crypto.createHmac('sha256', String(env.SOLAPI_API_SECRET || 'sms-manual-send')).update([...phones].sort().join(',')).digest('hex');
  const inserted = await db.execute({
    sql: `INSERT INTO sms_manual_sends (idem_key, msg_type, recipient_count, text_length, tails, recipients_hash, status)
          VALUES (?, ?, ?, ?, ?, ?, 'sending') ON CONFLICT (idem_key) DO NOTHING RETURNING id`,
    args: [key, 'ATA', phones.length, 0, tails, hash],
  });
  if (!inserted.rows?.length) {
    const { rows } = await db.execute({
      sql: 'SELECT status, msg_type, recipient_count, success_count, fail_count FROM sms_manual_sends WHERE idem_key = ?',
      args: [key],
    });
    const row = rows?.[0] || {};
    return reply(200, { sent: row.status === 'sent' || row.status === 'partial', duplicate: true, status: row.status || 'sending', type: row.msg_type || 'ATA',
      count: Number(row.recipient_count) || phones.length, success: Number(row.success_count) || 0, fail: Number(row.fail_count) || 0 });
  }

  const { rows: afterRows } = await db.execute({
    sql: 'SELECT COALESCE(SUM(recipient_count), 0)::int AS n FROM sms_manual_sends WHERE sent_at >= ?',
    args: [kstDayStartIso(nowMs)],
  });
  const usedAfter = Number(afterRows?.[0]?.n) || 0;
  if (usedAfter > settings.daily) {
    await db.execute({ sql: "UPDATE sms_manual_sends SET status = 'rejected', recipient_count = 0 WHERE idem_key = ?", args: [key] });
    return errorReply(429, `하루 ${settings.daily}건까지 보낼 수 있습니다. 오늘 ${Math.max(0, usedAfter - phones.length)}건 보냈습니다.`);
  }

  let result;
  try {
    result = await vendor.sendKakao({ from, recipients: phones, pfId, templateId, variables }, { fetchImpl });
  } catch {
    result = { accepted: 0, failed: 0, groupId: null, uncertain: true, error: '보냈는지 확인하지 못했습니다. 발송 내역을 확인해 주세요' };
  }
  const status = result.uncertain ? 'uncertain' : result.failed === 0 ? 'sent' : result.accepted === 0 ? 'failed' : 'partial';
  try {
    await db.execute({
      sql: 'UPDATE sms_manual_sends SET status = ?, success_count = ?, fail_count = ?, group_id = ?, error = ? WHERE idem_key = ?',
      args: [status, result.accepted || 0, result.failed || 0, result.groupId || null, result.error ? String(result.error).slice(0, 200) : null, key],
    });
  } catch { /* 기록 실패가 이미 끝난 발송 결과 응답을 막지 않게 한다 */ }
  console.info('[sms-send]', status, phones.length, 'ATA');
  const out = { sent: status === 'sent' || status === 'partial', status, type: 'ATA', count: phones.length, success: result.accepted || 0, fail: result.failed || 0, cost: estimate.total };
  if (result.uncertain) out.uncertain = true;
  if (result.error) out.message = String(result.error).slice(0, 200);
  return reply(200, out);
}

// ---- 예약 발송·사진 문자 (5단계) ----
// 쏠라피 규격(solapi-nodejs SDK 6.1.0): 예약은 발송 본문 scheduledDate, 취소는 DELETE groups/{groupId}/schedule, 사진은 storage/v1/files(type MMS, 200KB) 의 fileId 를 메시지 imageId 로.
// 예약 최대 기간은 공식 문서에서 확인하지 못해 SMS_SCHEDULE_MAX_DAYS(기본 30일)로 자체 제한한다.
const MIN_SCHEDULE_MS = 5 * 60 * 1000;
const SCHEDULED_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const IMAGE_BASE64_MAX = Math.ceil(MMS_MAX_BYTES / 3) * 4 + 8;

// KST 'YYYY-MM-DDTHH:mm' → { text, iso, ms } | null
export function parseKstSchedule(value) {
  const m = SCHEDULED_RE.exec(String(value ?? '').trim());
  if (!m) return null;
  const ms = Date.parse(`${m[0]}:00+09:00`);
  if (!Number.isFinite(ms)) return null;
  const back = new Date(ms + 9 * 3600000).toISOString().slice(0, 16);
  if (back !== m[0]) return null; // 2월 31일 같은 날짜
  return { text: m[0], iso: new Date(ms).toISOString(), ms };
}

// body.scheduled_at · body.image({ data }) 검증 → { scheduled, image } | { error }
export function parseSendExtras(body, { env = process.env, nowMs = Date.now() } = {}) {
  const out = { scheduled: null, image: null };
  if (body.scheduled_at !== undefined && body.scheduled_at !== null && body.scheduled_at !== '') {
    const parsed = parseKstSchedule(body.scheduled_at);
    if (!parsed) return { error: '예약 시각 형식이 올바르지 않습니다.' };
    const maxDays = intEnv(env.SMS_SCHEDULE_MAX_DAYS, 30);
    if (parsed.ms < nowMs + MIN_SCHEDULE_MS) return { error: '예약은 지금부터 5분 뒤 이후로만 걸 수 있습니다.' };
    if (parsed.ms > nowMs + maxDays * 86400000) return { error: `예약은 ${maxDays}일 안으로만 걸 수 있습니다.` };
    out.scheduled = parsed;
  }
  if (body.image !== undefined && body.image !== null) {
    const raw = typeof body.image === 'object' && !Array.isArray(body.image) ? body.image.data : '';
    const base64 = typeof raw === 'string' ? raw.replace(/^data:image\/jpe?g;base64,/i, '').replace(/\s+/g, '') : '';
    if (!base64 || base64.length > IMAGE_BASE64_MAX || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) return { error: '사진이 너무 크거나 올바르지 않습니다.' };
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > MMS_MAX_BYTES) return { error: '사진이 너무 큽니다.' };
    if (buffer.length < 4 || buffer[0] !== 0xff || buffer[1] !== 0xd8 || buffer[2] !== 0xff) return { error: '사진은 JPG 형식만 보낼 수 있습니다.' };
    out.image = { base64, bytes: buffer.length, name: 'photo.jpg' };
  }
  return out;
}

export async function ensureScheduleColumn(db) {
  if (schemaFlags.get('sms.manualSends.scheduled')) return;
  await db.execute({ sql: 'ALTER TABLE sms_manual_sends ADD COLUMN IF NOT EXISTS scheduled_at TIMESTAMPTZ', args: [] });
  schemaFlags.set('sms.manualSends.scheduled', true);
}

// 아직 안 나간 예약(시각·인원·종류·끝 4자리). 번호 전체는 기록에 없다.
export async function listScheduledSends(db, nowMs = Date.now()) {
  await ensureManualSendSchema(db);
  await ensureScheduleColumn(db);
  const { rows } = await db.execute({
    sql: `SELECT id, scheduled_at, recipient_count, msg_type, tails FROM sms_manual_sends
          WHERE scheduled_at > ? AND status IN ('sent', 'partial') AND group_id IS NOT NULL ORDER BY scheduled_at ASC LIMIT 50`,
    args: [new Date(nowMs).toISOString()],
  });
  return (rows || []).map(row => ({
    id: Number(row.id), at: new Date(row.scheduled_at).toISOString(), count: Number(row.recipient_count) || 0,
    type: row.msg_type || '', tails: String(row.tails || '').split(',').filter(Boolean).slice(0, 10),
  }));
}

// action 'send_cancel' {id}: 아직 안 나간 예약만 쏠라피에서 취소한다.
export async function runSendCancel(body, { env = process.env, db, provider, fetchImpl, nowMs = Date.now(), writeEnabled = true } = {}) {
  const settings = sendSettings(env, writeEnabled);
  if (!settings.enabled) return errorReply(403, '발송이 꺼져 있습니다.');
  const id = Number(body.id);
  if (!Number.isInteger(id) || id <= 0) return errorReply(400, '올바른 요청이 아닙니다.');
  const vendor = provider || getSendProvider();
  if (!vendor || typeof vendor.cancelSchedule !== 'function') return errorReply(503, '발송 업체가 설정되지 않았습니다.');
  await ensureManualSendSchema(db);
  await ensureScheduleColumn(db);
  const { rows } = await db.execute({ sql: 'SELECT id, status, scheduled_at, group_id FROM sms_manual_sends WHERE id = ?', args: [id] });
  const row = rows?.[0];
  if (!row) return errorReply(404, '예약을 찾을 수 없습니다.');
  if (row.status === 'cancelled') return errorReply(409, '이미 취소된 예약입니다.');
  const at = row.scheduled_at ? Date.parse(row.scheduled_at) : NaN;
  if (!Number.isFinite(at) || at <= nowMs || !row.group_id || !['sent', 'partial'].includes(row.status)) return errorReply(409, '이미 나갔거나 취소할 수 없는 문자입니다.');
  const out = await vendor.cancelSchedule({ groupId: row.group_id }, { fetchImpl });
  if (!out?.ok) return errorReply(502, out?.error || '예약을 취소하지 못했습니다.');
  try { await db.execute({ sql: "UPDATE sms_manual_sends SET status = 'cancelled' WHERE id = ?", args: [id] }); } catch { /* 취소는 이미 끝났다 */ }
  console.info('[sms-send]', 'cancelled', id);
  return reply(200, { cancelled: true, id });
}
