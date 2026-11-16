// 쏠라피 연동 점검 — 5분 cron(sms-delivery-monitor)에 얹혀 돈다. 조회(GET)만 쓰고 돈이 들지 않는다.
// 쓰는 쏠라피 경로: GET kakao/v2/channels (kakaoTemplates.js listDirectory 가 이미 쓰는 호출).
// 발신번호 활성 목록 경로는 저장소·설치 SDK 어디에서도 확인하지 못해 점검하지 않는다(sender_inactive 미확인).
// 허용 IP 거절도 쏠라피 오류 코드 이름을 확인하지 못해 auth_failed 와 구분하지 않는다(ip_blocked 미확인).
import { call, SolapiKakaoError } from './kakaoTemplates.js';
import { sendAdminLms } from './notify.js';
import { DELIVERY_ALERT_ADMIN_PHONE } from './solapiDeliveryMonitor.js';
import { SOLAPI_HEALTH_REASONS, CRON_STALE_SECONDS } from '../../shared/solapiHealthText.js';

const HEALTH_KEY = 'solapi_health';
const FAIL_BEFORE_ALERT = 2;
const REALERT_MS = 6 * 60 * 60 * 1000;
const MAX_CHANNEL_PAGES = 3;
const SMS_ALERT_STATES = new Set(['sender_inactive', 'channel_missing']);

const schemaFlags = new Map();

function text(value) { return String(value ?? '').trim(); }

export async function checkSolapiHealth({ env = process.env, fetchImpl = fetch, sleep } = {}) {
  const checkedAt = new Date().toISOString();
  const missing = ['SOLAPI_API_KEY', 'SOLAPI_API_SECRET', 'SMS_SENDER'].filter(name => !text(env[name]));
  if (missing.length) return { state: 'not_configured', detail: `missing: ${missing.join(', ')}`, checkedAt };
  const pfId = text(env.KAKAO_PF_ID);
  // KAKAO_PF_ID 는 그룹 템플릿일 때만 쓰는 보조 값이라 비어 있어도 정상이다(채널은 템플릿의 channelId 에서 얻는다).
  // 비어 있으면 채널 ID 대조만 건너뛰고, 인증 확인 겸 채널 목록 조회가 성공하면 ok.

  try {
    const found = new Set();
    let startKey = null;
    for (let page = 0; page < MAX_CHANNEL_PAGES; page += 1) {
      const payload = await call('kakao/v2/channels', { query: { limit: 100, startKey } }, { fetchImpl, sleep });
      const list = payload?.channelList;
      const items = Array.isArray(list) ? list : (list && typeof list === 'object' ? Object.values(list) : []);
      for (const item of items) if (item?.channelId) found.add(String(item.channelId));
      if (!pfId || found.has(pfId)) return { state: 'ok', detail: '', checkedAt };
      startKey = payload?.nextKey || null;
      if (!startKey) break;
    }
    return { state: 'channel_missing', detail: 'KAKAO_PF_ID not in channel list', checkedAt };
  } catch (error) {
    const status = error instanceof SolapiKakaoError ? error.status : 0;
    if (status === 401 || status === 403) return { state: 'auth_failed', detail: `http ${status} (키 또는 허용 IP 확인)`, checkedAt };
    return { state: 'unreachable', detail: status ? `http ${status}` : 'network', checkedAt };
  }
}

export async function ensureSolapiHealthSchema(db) {
  if (schemaFlags.get('health')) return;
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS integration_health (
      key TEXT PRIMARY KEY,
      last_state TEXT,
      last_detail TEXT,
      last_ok_at TIMESTAMPTZ,
      fail_count INT NOT NULL DEFAULT 0,
      alerted_at TIMESTAMPTZ,
      last_run_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`,
    args: [],
  });
  schemaFlags.set('health', true);
}

const toMs = value => {
  const t = value ? new Date(value).getTime() : NaN;
  return Number.isFinite(t) ? t : null;
};

async function readRow(db) {
  const { rows } = await db.execute({
    sql: 'SELECT last_state, last_detail, last_ok_at, fail_count, alerted_at, last_run_at FROM integration_health WHERE key = ?',
    args: [HEALTH_KEY],
  });
  return rows?.[0] || null;
}

// 화면·밖의 감시용: DB 에 저장된 마지막 상태만 읽는다(쏠라피를 부르지 않는다).
export async function readSolapiHealth(db, { nowMs = Date.now() } = {}) {
  try {
    await ensureSolapiHealthSchema(db);
    const row = await readRow(db);
    if (!row) return null;
    const runMs = toMs(row.last_run_at);
    const age = runMs == null ? null : Math.max(0, Math.round((nowMs - runMs) / 1000));
    const okMs = toMs(row.last_ok_at);
    return {
      state: row.last_state || 'unknown',
      detail: row.last_detail || '',
      checked_at: runMs == null ? null : new Date(runMs).toISOString(),
      last_ok_at: okMs == null ? null : new Date(okMs).toISOString(),
      cron_age_seconds: age,
      cron_stale: age == null || age > CRON_STALE_SECONDS,
    };
  } catch {
    return null;
  }
}

async function sendTelegram(message, { env = process.env, fetchImpl = fetch } = {}) {
  const token = text(env.ALERT_TELEGRAM_BOT_TOKEN);
  const chatId = text(env.ALERT_TELEGRAM_CHAT_ID);
  if (!token || !chatId) return { skipped: true };
  const res = await fetchImpl(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text: message }),
    signal: AbortSignal.timeout(5000),
  });
  return { ok: Boolean(res?.ok) };
}

function alertMessage(state, detail, recovered) {
  if (recovered) return '[쏠라피 연동] 복구됐습니다. 연동이 다시 정상입니다.';
  const reason = SOLAPI_HEALTH_REASONS[state] || state;
  return `[쏠라피 연동 이상] ${reason}${detail ? ` (${detail})` : ''}. 문자·알림톡 발송이 막혔을 수 있습니다.`;
}

// 점검 1회 + 상태 저장 + 알림. 알림 수단 하나가 실패해도 나머지는 계속 시도한다.
export async function runSolapiHealthCycle(db, options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const check = options.check || checkSolapiHealth;
  const telegram = options.telegram || sendTelegram;
  const sendAdmin = options.sendAdmin || sendAdminLms;
  const adminPhone = options.adminPhone || DELIVERY_ALERT_ADMIN_PHONE;
  const env = options.env || process.env;

  await ensureSolapiHealthSchema(db);
  const prev = await readRow(db);
  const result = await check({ env, fetchImpl: options.fetchImpl || fetch, sleep: options.sleep });
  const nowIso = new Date(nowMs).toISOString();

  let failCount = Number(prev?.fail_count) || 0;
  let alertedMs = toMs(prev?.alerted_at);
  let lastOkAt = prev?.last_ok_at || null;
  let message = null;
  let viaSms = false;

  if (result.state === 'ok') {
    // 2026-11-16: KAKAO_PF_ID 없음을 장애로 잘못 판정했던 것의 복구는 알리지 않는다(거짓 장애였음). 한 번 지나가면 쓸모없는 분기.
    if (alertedMs != null && prev?.last_detail !== 'missing: KAKAO_PF_ID') {
      message = alertMessage(result.state, '', true);
      viaSms = SMS_ALERT_STATES.has(prev?.last_state);
    }
    failCount = 0;
    alertedMs = null;
    lastOkAt = nowIso;
  } else {
    failCount += 1;
    if (failCount >= FAIL_BEFORE_ALERT && (alertedMs == null || nowMs - alertedMs >= REALERT_MS)) {
      message = alertMessage(result.state, result.detail, false);
      viaSms = SMS_ALERT_STATES.has(result.state);
      alertedMs = nowMs;
    }
  }

  const notified = { telegram: null, sms: null };
  if (message) {
    try { notified.telegram = await telegram(message, { env }); } catch (error) { notified.telegram = { error: String(error?.message || error).slice(0, 100) }; }
    if (viaSms) {
      try { notified.sms = await sendAdmin(db, { to: adminPhone, subject: '쏠라피 연동', text: message, tag: 'solapi_health_alert', recipientName: '관리자' }); } catch (error) { notified.sms = { error: String(error?.message || error).slice(0, 100) }; }
    }
  }

  await db.execute({
    sql: `INSERT INTO integration_health (key, last_state, last_detail, last_ok_at, fail_count, alerted_at, last_run_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, NOW())
          ON CONFLICT (key) DO UPDATE SET last_state = EXCLUDED.last_state, last_detail = EXCLUDED.last_detail,
            last_ok_at = EXCLUDED.last_ok_at, fail_count = EXCLUDED.fail_count, alerted_at = EXCLUDED.alerted_at,
            last_run_at = EXCLUDED.last_run_at, updated_at = NOW()`,
    args: [HEALTH_KEY, result.state, String(result.detail || '').slice(0, 200), lastOkAt, failCount,
      alertedMs == null ? null : new Date(alertedMs).toISOString(), nowIso],
  });
  return { state: result.state, fail_count: failCount, alerted: Boolean(message), notified };
}
