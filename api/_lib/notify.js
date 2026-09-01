// 고객 알림 발송 핵심 모듈 — 멱등 선점 → 조용시간 → 메시지 빌드 → 솔라피 발송 → 상태 확정 + 로그
// 설계 근거: 03_백엔드_연동_스펙.md(멱등성·마스킹), 02_알림톡_템플릿.md(문구 ①~⑤)
// - 마일스톤: ordered | started | packed | shipped | rescheduled (rescheduled 키는 'rescheduled:YYYY-MM-DD')
// - 멱등성: orders.notify_state JSONB, 조건부 UPDATE 선점 (Neon HTTP — 트랜잭션 없음)
// - 솔라피 env 없으면 dry_run (notification_log 에 기록만, 실발송 없음)
import crypto from 'crypto';
import {
  ensureInternalNotificationHistorySchema,
  ensureNotifySchema,
} from './notifySchema.js';
import { ensureTrackToken } from './trackToken.js';

const SOLAPI_ENDPOINT = 'https://api.solapi.com/messages/v4/send';
// 종결 상태 = success/dry_run/skipped (claim SQL 에 인라인) — queued/failed/sending(stale) 은 스윕이 재처리
const STALE_SENDING_MS = 5 * 60 * 1000; // 'sending' 이 5분 넘게 방치되면 크래시로 보고 재선점 허용

const TEMPLATE_ENV = {
  ordered: 'SOLAPI_TPL_ORDERED',
  started: 'SOLAPI_TPL_STARTED',
  packed: 'SOLAPI_TPL_PACKED',
  shipped: 'SOLAPI_TPL_SHIPPED',
  rescheduled: 'SOLAPI_TPL_RESCHEDULED',
};

// ── 시간 유틸 (KST) ──────────────────────────────────────────────
function kstNow() {
  // UTC 메서드로 읽으면 KST 벽시계가 되도록 9시간 offset
  return new Date(Date.now() + 9 * 60 * 60 * 1000);
}

export function kstTodayStr() {
  return kstNow().toISOString().slice(0, 10);
}

// 조용시간: KST 08:00~21:00 밖이면 true
export function isQuietHours(d = kstNow()) {
  const h = d.getUTCHours();
  return h < 8 || h >= 21;
}

// ── 마스킹/포맷 유틸 ─────────────────────────────────────────────
export function maskPhone(phone) {
  const digits = String(phone || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length < 8) return digits.slice(0, 2) + '****';
  return digits.slice(0, 3) + '****' + digits.slice(-4);
}

function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

function fmtDate(d, fallback = '협의 예정') {
  if (!d) return fallback;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(d));
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(d);
}

function orderNo(order) {
  const year = String(order.order_date || '').slice(0, 4) || String(kstNow().getUTCFullYear());
  return `HS-${year}-${String(order.id).padStart(4, '0')}`;
}

function orderSize(order) {
  return order.width && order.depth && order.height
    ? `${order.width}×${order.depth}×${order.height}mm` : '';
}

function productLine(order) {
  return [
    order.product_type || '주문 제품',
    order.door_type ? `(${order.door_type})` : '',
    orderSize(order),
  ].filter(Boolean).join(' ');
}

// 고객 문자 본문에는 품명을 넣지 않는다. product_type 에 '하나로냉장' 처럼 내부 분류·거래처
// 표기가 들어가 있는 경우가 있어 고객이 받는 문구로는 부적절하다(2026-08-10 요청).
// 알림톡 템플릿 변수(#{제품})는 카카오에 등록된 서식과 맞춰야 하므로 그대로 둔다.
function customerSpecLine(order) {
  return [
    order.door_type || '',
    orderSize(order),
  ].filter(Boolean).join(' ');
}

// ── 메시지 빌드 (02 문서 문구 기반, 빈 변수 방어) ────────────────
export function buildMessage(order, milestone, trackUrl, extra = {}) {
  const 고객명 = order.client_name || '고객';
  const 주문번호 = orderNo(order);
  const 제품규격 = productLine(order);
  const 고객규격 = customerSpecLine(order);
  const 수량 = `${order.quantity || 1}대`;
  const 예상출고일 = fmtDate(order.due_date);
  const 조회링크 = trackUrl || '';
  // 알림톡 웹링크 버튼이 https://.../track/#{토큰} 형태라 토큰 변수도 함께 넘긴다
  const 토큰 = trackUrl ? (String(trackUrl).split('/track/')[1] || '') : '';

  const footer = ['', '문의: 한성쇼케이스 고객센터'];
  const linkBlock = 조회링크 ? ['', '제작 진행 상황 실시간 조회', `▶ ${조회링크}`] : [];

  let subject = '';
  let lines = [];
  const variables = { 고객명, 주문번호, 제품: order.product_type || '주문 제품', 규격: 제품규격, 수량, 예상출고일, 조회링크, 토큰 };

  switch (milestone) {
    case 'ordered':
      subject = '[한성쇼케이스] 주문 접수 안내';
      lines = [
        `${고객명}님, 주문이 정상 접수되었습니다.`,
        '',
        `- 주문번호: ${주문번호}`,
        `- 규격: ${고객규격}`,
        `- 수량: ${수량}`,
        `- 예상 출고일: ${예상출고일}`,
        ...linkBlock,
        '',
        '단계별로 진행 알림을 보내드립니다.',
        ...footer.slice(1),
      ];
      break;
    case 'started':
      subject = '[한성쇼케이스] 제작 시작 안내';
      variables.현재단계 = '도면설계';
      lines = [
        `${고객명}님, 주문하신 제품의 제작이 시작되었습니다.`,
        '',
        `- 주문번호: ${주문번호}`,
        `- 규격: ${고객규격}`,
        `- 예상 출고일: ${예상출고일}`,
        ...linkBlock,
        ...footer,
      ];
      break;
    case 'packed': {
      subject = '[한성쇼케이스] 포장 완료 안내';
      const 출고예정 = fmtDate(order.ship_scheduled_date || order.due_date);
      variables.예상출고일 = 출고예정;
      lines = [
        `${고객명}님, 주문하신 제품의 포장이 완료되어 곧 출고될 예정입니다.`,
        '',
        `- 주문번호: ${주문번호}`,
        `- 규격: ${고객규격}`,
        `- 수량: ${수량}`,
        `- 예상 출고일: ${출고예정}`,
        ...(조회링크 ? ['', '포장 상태는 아래 링크에서 확인하실 수 있습니다.', `▶ ${조회링크}`] : []),
        '',
        '출고 완료 시 다시 안내드립니다.',
        ...footer.slice(1),
      ];
      break;
    }
    case 'shipped': {
      subject = '[한성쇼케이스] 출고 완료 안내';
      const 출고일 = fmtDate(order.ship_date, kstTodayStr());
      variables.출고일 = 출고일;
      lines = [
        `${고객명}님, 주문하신 제품이 출고되었습니다.`,
        '',
        `- 주문번호: ${주문번호}`,
        `- 규격: ${고객규격}`,
        `- 수량: ${수량}`,
        `- 출고일: ${출고일}`,
        ...(조회링크 ? ['', '배송 세부사항 조회', `▶ ${조회링크}`] : []),
        '',
        '수령 시 제품 상태를 확인해 주시고,',
        '이상 발견 시 고객센터로 연락 부탁드립니다.',
        ...footer.slice(1),
      ];
      break;
    }
    case 'rescheduled': {
      subject = '[한성쇼케이스] 출고 예정일 안내';
      const 새출고예정일 = fmtDate(extra.date || order.ship_scheduled_date);
      variables.새출고예정일 = 새출고예정일;
      lines = [
        `${고객명}님, 주문하신 제품의 제작 일정에 따라`,
        '출고 예정일을 다시 안내드립니다.',
        '',
        `- 주문번호: ${주문번호}`,
        `- 규격: ${고객규격}`,
        `- 수량: ${수량}`,
        `- 출고 예정일: ${새출고예정일}`,
        ...linkBlock,
        '',
        '기다려 주셔서 감사합니다.',
        ...footer.slice(1),
      ];
      break;
    }
    default:
      throw new Error(`알 수 없는 마일스톤: ${milestone}`);
  }

  return { subject, text: lines.join('\n'), variables, templateEnv: TEMPLATE_ENV[milestone] };
}

// ── 솔라피 발송 계층 ─────────────────────────────────────────────
function solapiConfigured() {
  return Boolean(process.env.SOLAPI_API_KEY && process.env.SOLAPI_API_SECRET);
}

function solapiAuthHeader() {
  // HMAC-SHA256: signature = HMAC(date + salt, apiSecret)
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString('hex');
  const signature = crypto
    .createHmac('sha256', process.env.SOLAPI_API_SECRET)
    .update(date + salt)
    .digest('hex');
  return `HMAC-SHA256 apiKey=${process.env.SOLAPI_API_KEY}, date=${date}, salt=${salt}, signature=${signature}`;
}

async function solapiSend(message, channel) {
  try {
    const res = await fetch(SOLAPI_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: solapiAuthHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message }),
      // 행(hang) 방지: 솔라피 지연 시 본 응답(주문생성/출고 등)이 maxDuration 까지 끌려가며
      // 함수가 킬되는 것 차단 — 타임아웃은 catch 로 수렴해 {ok:false} 처리 (googleSheets.js 와 동일 패턴)
      signal: AbortSignal.timeout(5000),
    });
    let data = null;
    try { data = await res.json(); } catch { /* 비JSON 응답 방어 */ }
    if (!res.ok) {
      const detail = [data?.errorCode, data?.errorMessage].filter(Boolean).join(' ');
      return { ok: false, channel, msgId: null, error: `HTTP ${res.status}${detail ? ' ' + detail : ''}` };
    }
    const msgId = data?.messageId || data?.groupId || data?.groupInfo?.groupId || null;
    return { ok: true, channel, msgId };
  } catch (err) {
    return { ok: false, channel, msgId: null, error: err?.message || String(err) };
  }
}

// 고객 발송: 알림톡(템플릿 env 있을 때) 시도 + disableSms:false 로 문자 자동 대체.
// 템플릿 코드 없으면 LMS 직발송(SMS_SENDER 필수). 솔라피 env 없으면 dry_run.
async function sendCustomerMessage({ to, subject, text, variables, templateEnv }) {
  const templateId = templateEnv ? process.env[templateEnv] : null;
  const pfId = process.env.KAKAO_PF_ID;
  const from = normalizePhone(process.env.SMS_SENDER);

  if (!solapiConfigured()) {
    return { ok: true, dryRun: true, channel: pfId && templateId ? 'alimtalk' : 'lms', msgId: null };
  }

  // 실발송 여부는 위 solapiConfigured() 하나로만 판단한다.
  // 2026-07-09 dca9af0 이 여기에 영업/관리자 인증 활성 여부를 보는 게이트를 추가했는데,
  // 그 비밀번호를 쓰지 않는 이 배포에서는 항상 막혀 고객 알림이 한 달간 전량 차단됐다
  // (notification_log 실패 506건). 인증 설정과 고객 문자 발송은 별개 관심사이므로 결합을 되돌린다.
  if (pfId && templateId) {
    const kakaoVariables = {};
    for (const [k, v] of Object.entries(variables || {})) {
      kakaoVariables[`#{${k}}`] = String(v ?? '');
    }
    const message = {
      to,
      text, // 대체 문자 본문
      kakaoOptions: {
        pfId,
        templateId,
        variables: kakaoVariables,
        disableSms: false, // 알림톡 실패 시 문자 자동 대체 (대행사 레벨 폴백)
      },
    };
    if (from) message.from = from;
    return solapiSend(message, 'alimtalk');
  }

  if (!from) {
    return { ok: false, channel: 'lms', msgId: null, error: 'SMS_SENDER 미설정 — LMS 직발송 불가' };
  }
  return solapiSend({ to, from, subject: String(subject || '').slice(0, 40), text, type: 'LMS' }, 'lms');
}

// ── notification_log 기록 (attempt = 해당 주문·마일스톤의 기존 로그 수 + 1) ──
async function logAttempt(db, { orderId, milestoneKey, channel, toPhone, status, msgId, error }) {
  let attempt = 1;
  try {
    const { rows } = await db.execute({
      sql: 'SELECT COUNT(*)::int AS n FROM notification_log WHERE order_id = ? AND milestone = ?',
      args: [orderId, milestoneKey],
    });
    attempt = (rows[0]?.n || 0) + 1;
  } catch { /* 카운트 실패는 attempt=1 로 계속 */ }
  await db.execute({
    sql: `INSERT INTO notification_log (order_id, milestone, channel, to_phone, status, provider_msgid, error, attempt)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      orderId, milestoneKey, channel || null, toPhone || null, status,
      msgId || null, error ? String(error).slice(0, 500) : null, attempt,
    ],
  });
  return attempt;
}

async function setNotifyState(db, orderId, key, stateObj) {
  await db.execute({
    sql: `UPDATE orders
             SET notify_state = COALESCE(notify_state, '{}'::jsonb) || jsonb_build_object(?::text, ?::jsonb)
           WHERE id = ?`,
    args: [key, JSON.stringify(stateObj), orderId],
  });
}

// ── 핵심 진입점 ──────────────────────────────────────────────────
// maybeNotify(db, order, milestone, extra?)
//   extra: rescheduled 일 때 { date: 'YYYY-MM-DD' } (또는 날짜 문자열)
// 반환: { ok?, queued?, skipped?, dryRun?, channel?, reason?, error? }
export async function maybeNotify(db, order, milestone, extra = {}) {
  await ensureNotifySchema(db);
  if (typeof extra === 'string') extra = { date: extra };

  const orderId = Number(order.id);
  if (!orderId || Number.isNaN(orderId)) return { skipped: true, reason: 'invalid_order' };

  let key = milestone;
  if (milestone === 'rescheduled') {
    const date = fmtDate(extra.date || order.ship_scheduled_date, '');
    if (!date) return { skipped: true, reason: 'no_reschedule_date' };
    extra = { ...extra, date };
    key = `rescheduled:${date}`; // 날짜별 1회 — 날짜가 다시 바뀌면 새 키로 재발송 가능
  }
  if (!TEMPLATE_ENV[milestone]) return { skipped: true, reason: 'unknown_milestone' };

  const nowIso = new Date().toISOString();
  const staleBefore = new Date(Date.now() - STALE_SENDING_MS).toISOString();

  // 1) 멱등 선점 — 조건부 UPDATE (success/dry_run/skipped 는 재발송 금지,
  //    5분 이내의 'sending' 은 동시 발송 중으로 보고 양보)
  const { rows: claimed } = await db.execute({
    sql: `UPDATE orders
             SET notify_state = COALESCE(notify_state, '{}'::jsonb) || jsonb_build_object(?::text, ?::jsonb)
           WHERE id = ?
             AND COALESCE(notify_state -> (?::text) ->> 'status', '') NOT IN ('success', 'dry_run', 'skipped')
             AND NOT (
               COALESCE(notify_state -> (?::text) ->> 'status', '') = 'sending'
               AND COALESCE(notify_state -> (?::text) ->> 'at', '') > ?
             )
           RETURNING id`,
    args: [key, JSON.stringify({ status: 'sending', at: nowIso }), orderId, key, key, key, staleBefore],
  });
  if (claimed.length === 0) {
    return { skipped: true, reason: 'already_sent_or_claimed' };
  }

  const toPhoneMasked = maskPhone(order.phone);

  try {
    // 2) 대상성 검사 — 전화번호 없으면 skip 확정
    const to = normalizePhone(order.phone);
    if (!to || to.length < 9) {
      await setNotifyState(db, orderId, key, { status: 'skipped', reason: 'no_phone', at: nowIso });
      await logAttempt(db, { orderId, milestoneKey: key, channel: null, toPhone: toPhoneMasked, status: 'skipped', error: 'no_phone' });
      return { skipped: true, reason: 'no_phone' };
    }
    // 이미 출고된 주문에 일정조정 안내는 무의미 → skip 확정
    if (milestone === 'rescheduled' && order.status === 'shipped') {
      await setNotifyState(db, orderId, key, { status: 'skipped', reason: 'already_shipped', at: nowIso });
      await logAttempt(db, { orderId, milestoneKey: key, channel: null, toPhone: toPhoneMasked, status: 'skipped', error: 'already_shipped' });
      return { skipped: true, reason: 'already_shipped' };
    }
    // 예정일이 그 사이 또 바뀐 '구 날짜' 키 → superseded 로 종결
    // (조용시간 중 날짜가 두 번 바뀌면 아침 스윕이 폐기된 날짜 안내까지 발송하는 것 방지 —
    //  스윕은 항상 최신 order row 를 넘기므로 이 검사로 낡은 키가 자동 소멸)
    if (milestone === 'rescheduled' && extra.date !== fmtDate(order.ship_scheduled_date, '')) {
      await setNotifyState(db, orderId, key, { status: 'skipped', reason: 'superseded', at: nowIso });
      await logAttempt(db, { orderId, milestoneKey: key, channel: null, toPhone: toPhoneMasked, status: 'skipped', error: 'superseded' });
      return { skipped: true, reason: 'superseded' };
    }

    // 3) 조용시간(KST 08~21시 밖) → queued 기록, 아침 스윕 크론이 발송
    if (isQuietHours()) {
      await setNotifyState(db, orderId, key, { status: 'queued', at: nowIso });
      await logAttempt(db, { orderId, milestoneKey: key, channel: null, toPhone: toPhoneMasked, status: 'queued' });
      return { queued: true };
    }

    // 4) track 링크 보장 + 메시지 빌드
    let trackUrl = '';
    try {
      const token = await ensureTrackToken(db, { id: orderId, track_token: order.track_token });
      if (token) {
        const base = (process.env.BASE_URL || 'https://production-status.vercel.app').replace(/\/+$/, '');
        trackUrl = `${base}/track/${token}`;
      }
    } catch (err) {
      console.error('[notify] track_token 확보 실패(링크 없이 계속):', err?.message || err);
    }
    const msg = buildMessage(order, milestone, trackUrl, extra);

    // 5) 발송 (env 없으면 dry_run)
    const result = await sendCustomerMessage({ to, ...msg });
    const doneAt = new Date().toISOString();

    // 6) 상태 확정 + 로그
    // 불변식: 발송이 실제로 나간 뒤(success/dry_run)에는 기록 실패가 있어도 절대 'failed' 로 강등하지 않는다.
    // ('failed' 로 남으면 아침 스윕이 재발송 → 고객이 같은 알림을 중복 수신)
    if (result.dryRun || result.ok) {
      const finalStatus = result.dryRun ? 'dry_run' : 'success';
      const stateObj = result.dryRun
        ? { status: 'dry_run', channel: result.channel, at: doneAt }
        : { status: 'success', channel: result.channel, msg_id: result.msgId, at: doneAt };
      let recorded = false;
      for (let i = 0; i < 3 && !recorded; i += 1) {
        try {
          await setNotifyState(db, orderId, key, stateObj);
          recorded = true;
        } catch (recErr) {
          console.error(`[notify] ${finalStatus} 상태 기록 실패 (${i + 1}/3):`, recErr?.message || recErr);
        }
      }
      try {
        await logAttempt(db, { orderId, milestoneKey: key, channel: result.channel, toPhone: toPhoneMasked, status: finalStatus, msgId: result.msgId || null });
      } catch (logErr) {
        console.error('[notify] 발송 성공 로그 기록 실패(무시):', logErr?.message || logErr);
      }
      return result.dryRun
        ? { ok: true, dryRun: true, channel: result.channel }
        : { ok: true, channel: result.channel, msgId: result.msgId };
    }
    await setNotifyState(db, orderId, key, { status: 'failed', channel: result.channel, error: String(result.error || '').slice(0, 200), at: doneAt });
    await logAttempt(db, { orderId, milestoneKey: key, channel: result.channel, toPhone: toPhoneMasked, status: 'failed', error: result.error });
    return { ok: false, error: result.error };
  } catch (err) {
    // 발송 '이전' 단계 예외 → failed 기록 (스윕이 최대 3회까지 재시도)
    // 발송 성공 이후의 기록 예외는 위 블록에서 개별 처리되므로 여기로 오지 않음 (중복 발송 방지 불변식)
    try {
      await setNotifyState(db, orderId, key, { status: 'failed', error: String(err?.message || err).slice(0, 200), at: new Date().toISOString() });
      await logAttempt(db, { orderId, milestoneKey: key, channel: null, toPhone: toPhoneMasked, status: 'failed', error: err?.message || err });
    } catch (inner) {
      console.error('[notify] 실패 상태 기록마저 실패:', inner?.message || inner);
    }
    return { ok: false, error: err?.message || String(err) };
  }
}

// ── 관리자 LMS (리스크 리포트 등) — notification_log 에만 기록 (order_id NULL) ──
export async function sendAdminLms(db, {
  to,
  subject,
  text,
  tag = 'admin_daily',
  recipientName = null,
}) {
  await ensureInternalNotificationHistorySchema(db);
  const phone = normalizePhone(to);
  if (!phone) return { ok: false, error: '수신 번호 없음' };

  let result;
  if (!solapiConfigured()) {
    result = { ok: true, dryRun: true, channel: 'lms', msgId: null };
  } else {
    const from = normalizePhone(process.env.SMS_SENDER);
    if (!from) {
      result = { ok: false, channel: 'lms', msgId: null, error: 'SMS_SENDER 미설정' };
    } else {
      result = await solapiSend({ to: phone, from, subject: String(subject || '').slice(0, 40), text, type: 'LMS' }, 'lms');
    }
  }

  const status = result.dryRun ? 'dry_run' : result.ok ? 'success' : 'failed';
  const historyTag = String(tag || '');
  const isInternalHistory = historyTag.startsWith('internal_') || historyTag === 'chonbe_alert';
  try {
    await db.execute({
      sql: `INSERT INTO notification_log (
              order_id, milestone, channel, to_phone, status, provider_msgid, error, attempt,
              recipient_name, message_subject, message_text
            ) VALUES (NULL, ?, 'lms', ?, ?, ?, ?, 1, ?, ?, ?)`,
      args: [
        tag,
        maskPhone(phone),
        status,
        result.msgId || null,
        result.error ? String(result.error).slice(0, 500) : null,
        isInternalHistory ? recipientName : null,
        isInternalHistory ? String(subject || '').slice(0, 200) : null,
        isInternalHistory ? String(text || '').slice(0, 5000) : null,
      ],
    });
  } catch (err) {
    console.error('[notify] 관리자 발송 로그 기록 실패:', err?.message || err);
  }
  return result;
}
