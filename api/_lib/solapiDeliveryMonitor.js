import crypto from 'node:crypto';

import { sendAdminLms } from './notify.js';
import { ensureSmsDeliveryMonitorSchema } from './notifySchema.js';

const SOLAPI_LIST_ENDPOINT = 'https://api.solapi.com/messages/v4/list';
const MONITOR_START_DATE = '2026-09-03';
const DEFAULT_BATCH_SIZE = 50;
const MAX_LOGS_PER_RUN = 20;
const MAX_ADMIN_ALERT_ACTIONS_PER_RUN = 2;
const ADMIN_ALERT_CUSTOM_FIELD = 'deliveryAlertKey';

export const DELIVERY_ALERT_ADMIN_PHONE = '010-7731-4237';
export const BLOCK_STATUS_CODES = new Set(['1061', '2061', '3047', '3054', '3055', '3061']);

const ALERT_LABELS = {
  internal_vcut_completed: 'V-커팅 완료 자재 입고 요청',
  internal_design_due: '도면 작업 납기 알림',
  internal_laser_due: '레이저 작업 납기 알림',
  internal_welding_due: '용접 착수 납기 알림',
  internal_assembly_due: '조립 작업 납기 알림',
  internal_packing_due: '포장 완료 납기 알림',
  internal_assembly_daily: '조립팀 포장 완료 일일 알림',
  chonbe_alert: '분체 미착수 영업담당자 알림',
};

function solapiAuthHeader() {
  const apiKey = process.env.SOLAPI_API_KEY;
  const apiSecret = process.env.SOLAPI_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('Solapi API credentials are not configured');
  }
  const date = new Date().toISOString();
  const salt = crypto.randomBytes(16).toString('hex');
  const signature = crypto
    .createHmac('sha256', apiSecret)
    .update(date + salt)
    .digest('hex');
  return `HMAC-SHA256 apiKey=${apiKey}, date=${date}, salt=${salt}, signature=${signature}`;
}

function sanitizedReport(message) {
  return {
    messageId: String(message?.messageId || ''),
    status: String(message?.status || ''),
    statusCode: message?.statusCode == null ? null : String(message.statusCode),
    reason: message?.reason == null ? null : String(message.reason).slice(0, 500),
    dateReported: message?.dateReported || null,
    dateReceived: message?.dateReceived || null,
  };
}

export async function fetchSolapiDeliveryReports(messageIds, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const batchSize = Math.max(1, Math.min(Number(options.batchSize) || DEFAULT_BATCH_SIZE, 100));
  const uniqueIds = [...new Set((messageIds || []).map(String).filter(Boolean))];
  const reports = [];

  for (let index = 0; index < uniqueIds.length; index += batchSize) {
    const batch = uniqueIds.slice(index, index + batchSize);
    const url = new URL(SOLAPI_LIST_ENDPOINT);
    url.searchParams.set('messageIds', JSON.stringify(batch));
    url.searchParams.set('limit', String(batch.length));
    const response = await fetchImpl(url, {
      headers: { Authorization: solapiAuthHeader() },
      signal: AbortSignal.timeout(5_000),
    });
    const payload = await response.json().catch(() => null);
    if (!response.ok) {
      const detail = payload?.errorCode || payload?.errorMessage || 'unknown error';
      throw new Error(`Solapi delivery lookup failed: HTTP ${response.status} ${detail}`);
    }
    for (const message of Object.values(payload?.messageList || {})) {
      const report = sanitizedReport(message);
      if (report.messageId) reports.push(report);
    }
  }

  return reports;
}

export async function findSolapiAdminAlert(alertToken, options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const nowMs = options.nowMs ?? Date.now();
  const date = options.kstDate || kstDate(nowMs);
  const startMs = Date.parse(`${date}T00:00:00+09:00`);
  if (!Number.isFinite(startMs)) throw new Error('Invalid KST date for administrator alert lookup');
  const currentDayStartMs = Date.parse(`${kstDate(nowMs)}T00:00:00+09:00`);
  const endMs = Math.max(startMs, currentDayStartMs) + 24 * 60 * 60 * 1000;

  const url = new URL(SOLAPI_LIST_ENDPOINT);
  url.searchParams.set('to', DELIVERY_ALERT_ADMIN_PHONE.replace(/\D/g, ''));
  url.searchParams.set('startDate', new Date(startMs).toISOString());
  url.searchParams.set('endDate', new Date(endMs).toISOString());
  url.searchParams.set('limit', '500');
  const response = await fetchImpl(url, {
    headers: { Authorization: solapiAuthHeader() },
    signal: AbortSignal.timeout(5_000),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = payload?.errorCode || payload?.errorMessage || 'unknown error';
    throw new Error(`Solapi administrator alert lookup failed: HTTP ${response.status} ${detail}`);
  }

  for (const message of Object.values(payload?.messageList || {})) {
    if (message?.customFields?.[ADMIN_ALERT_CUSTOM_FIELD] === alertToken) {
      return sanitizedReport(message);
    }
  }
  return null;
}

function isMonitoredMilestone(milestone) {
  const value = String(milestone || '');
  return value.startsWith('internal_') || value === 'chonbe_alert';
}

function kstDate(nowMs) {
  return new Date(nowMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function kstDateTime(nowMs) {
  return new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  }).format(new Date(nowMs));
}

function buildAlertKey(row, report, nowMs) {
  return [
    kstDate(nowMs),
    String(row.recipient_name || '').trim(),
    String(row.to_phone || '').trim(),
    report.statusCode,
  ].join(':');
}

function buildAlertToken(alertKey) {
  return crypto.createHash('sha256').update(alertKey).digest('hex').slice(0, 48);
}

function buildAdminAlert(row, report, nowMs, alertToken) {
  const recipient = String(row.recipient_name || '').trim() || '수신자 미확인';
  const phone = String(row.to_phone || '').trim() || '번호 미확인';
  const label = ALERT_LABELS[row.milestone] || row.milestone;
  const reason = report.reason || '수신거부 또는 차단';
  const subject = '[한성쇼케이스 문자 수신 이상]';
  return {
    to: DELIVERY_ALERT_ADMIN_PHONE,
    subject,
    tag: 'sms_delivery_block_admin_alert',
    customFields: { [ADMIN_ALERT_CUSTOM_FIELD]: alertToken },
    text: [
      subject,
      `수신자: ${recipient} (${phone})`,
      `알림 종류: ${label}`,
      `확인 결과: ${report.statusCode} ${reason}`,
      `확인 시각: ${kstDateTime(nowMs)}`,
      '',
      '수신거부 또는 차단 여부를 확인해 주세요.',
    ].join('\n'),
  };
}

async function updateDeliveryReport(db, row, report) {
  await db.execute({
    sql: `UPDATE notification_log
             SET delivery_status = ?,
                 delivery_status_code = ?,
                 delivery_reason = ?,
                 delivery_reported_at = ?,
                 delivery_received_at = ?,
                 delivery_checked_at = NOW()
           WHERE id = ?
           RETURNING id`,
    args: [
      report.status || null,
      report.statusCode,
      report.reason,
      report.dateReported,
      report.dateReceived,
      row.id,
    ],
  });
}

async function claimAdminAlert(db, row, report, alertKey) {
  const { rows } = await db.execute({
    sql: `INSERT INTO notification_delivery_alerts (
            alert_key, source_log_id, provider_msgid, recipient_name, to_phone,
            status_code, reason, status, attempts, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, 'sending', 1, NOW(), NOW())
          ON CONFLICT (alert_key) DO UPDATE
             SET source_log_id = EXCLUDED.source_log_id,
                 provider_msgid = EXCLUDED.provider_msgid,
                 reason = EXCLUDED.reason,
                 status = 'sending',
                 attempts = notification_delivery_alerts.attempts + 1,
                 error = NULL,
                 updated_at = NOW()
           WHERE notification_delivery_alerts.status IN ('queued', 'failed')
              OR (
                notification_delivery_alerts.status = 'sending'
                AND notification_delivery_alerts.updated_at < NOW() - INTERVAL '10 minutes'
              )
          RETURNING alert_key, attempts`,
    args: [
      alertKey,
      row.id,
      row.provider_msgid,
      String(row.recipient_name || '').trim() || null,
      String(row.to_phone || '').trim() || null,
      report.statusCode,
      report.reason,
    ],
  });
  if (!rows[0]?.alert_key) return null;
  return {
    alertKey: rows[0].alert_key,
    attempts: Number(rows[0].attempts) || 1,
  };
}

async function queueAdminAlert(db, alertKey) {
  await db.execute({
    sql: `UPDATE notification_delivery_alerts
             SET status = 'queued',
                 error = NULL,
                 updated_at = NOW()
           WHERE alert_key = ?
           RETURNING alert_key`,
    args: [alertKey],
  });
}

async function finishAdminAlert(db, alertKey, result) {
  if (result?.ok) {
    await db.execute({
      sql: `UPDATE notification_delivery_alerts
               SET status = 'sent',
                   admin_provider_msgid = ?,
                   error = NULL,
                   alerted_at = NOW(),
                   updated_at = NOW()
             WHERE alert_key = ?
             RETURNING alert_key`,
      args: [result.msgId || null, alertKey],
    });
    return true;
  }

  await db.execute({
    sql: `UPDATE notification_delivery_alerts
             SET status = 'failed',
                 error = ?,
                 updated_at = NOW()
           WHERE alert_key = ?
           RETURNING alert_key`,
    args: [String(result?.error || '관리자 문자 발송 실패').slice(0, 500), alertKey],
  });
  return false;
}

export async function runSmsDeliveryMonitor(db, options = {}) {
  const ensureSchema = options.ensureSchema || ensureSmsDeliveryMonitorSchema;
  const fetchReports = options.fetchReports || fetchSolapiDeliveryReports;
  const findAdminAlert = options.findAdminAlert || findSolapiAdminAlert;
  const sendAdmin = options.sendAdmin || sendAdminLms;
  const nowMs = options.nowMs ?? Date.now();
  await ensureSchema(db);

  const { rows } = await db.execute({
    sql: `SELECT notification_log.id AS id,
                 notification_log.milestone AS milestone,
                 notification_log.recipient_name AS recipient_name,
                 notification_log.to_phone AS to_phone,
                 notification_log.provider_msgid AS provider_msgid,
                 notification_log.created_at AS created_at,
                 notification_log.delivery_status_code AS delivery_status_code,
                 delivery_alert.alert_key AS delivery_alert_key
            FROM notification_log
            LEFT JOIN notification_delivery_alerts delivery_alert
              ON delivery_alert.provider_msgid = notification_log.provider_msgid
             AND delivery_alert.status <> 'sent'
           WHERE (notification_log.created_at AT TIME ZONE 'Asia/Seoul')::date >= ?::date
             AND notification_log.status = 'success'
             AND notification_log.provider_msgid IS NOT NULL
             AND (LEFT(milestone, 9) = 'internal_' OR milestone = 'chonbe_alert')
             AND (
               delivery_status_code IS NULL
               OR delivery_status_code IN ('2000', '3000')
               OR delivery_alert.status IN ('queued', 'failed')
               OR (
                 delivery_alert.status = 'sending'
                 AND delivery_alert.updated_at < NOW() - INTERVAL '10 minutes'
               )
             )
           ORDER BY COALESCE(
                      delivery_alert.updated_at,
                      notification_log.delivery_checked_at,
                      notification_log.created_at
                    ) ASC,
                    notification_log.id ASC
           LIMIT ?`,
    args: [MONITOR_START_DATE, MAX_LOGS_PER_RUN],
  });
  const candidates = rows.filter((row) => isMonitoredMilestone(row.milestone));
  const reports = await fetchReports(candidates.map((row) => row.provider_msgid));
  const reportsById = new Map(reports.map((report) => [report.messageId, report]));
  const summary = {
    scanned: candidates.length,
    reported: 0,
    received: 0,
    blocked: 0,
    alerted: 0,
    failed: 0,
  };
  let alertActions = 0;
  const handledAlertKeys = new Set();

  for (const row of candidates) {
    const report = reportsById.get(row.provider_msgid);
    if (!report) continue;
    summary.reported += 1;
    if (report.statusCode === '4000') summary.received += 1;
    if (!BLOCK_STATUS_CODES.has(report.statusCode)) {
      await updateDeliveryReport(db, row, report);
      continue;
    }

    summary.blocked += 1;
    const alertKey = row.delivery_alert_key || buildAlertKey(row, report, nowMs);
    if (handledAlertKeys.has(alertKey)) {
      await updateDeliveryReport(db, row, report);
      continue;
    }
    handledAlertKeys.add(alertKey);

    const isQueuedRetry = row.delivery_status_code != null
      && !['2000', '3000'].includes(row.delivery_status_code);
    if (isQueuedRetry && alertActions >= MAX_ADMIN_ALERT_ACTIONS_PER_RUN) continue;

    const claim = await claimAdminAlert(db, row, report, alertKey);
    if (!claim) {
      await updateDeliveryReport(db, row, report);
      continue;
    }
    if (alertActions >= MAX_ADMIN_ALERT_ACTIONS_PER_RUN) {
      await queueAdminAlert(db, claim.alertKey);
      await updateDeliveryReport(db, row, report);
      continue;
    }
    alertActions += 1;

    const alertToken = buildAlertToken(claim.alertKey);
    if (claim.attempts > 1) {
      const accepted = await findAdminAlert(alertToken, {
        nowMs,
        kstDate: claim.alertKey.slice(0, 10),
      });
      if (accepted?.messageId) {
        if (await finishAdminAlert(db, claim.alertKey, { ok: true, msgId: accepted.messageId })) {
          summary.alerted += 1;
        }
        await updateDeliveryReport(db, row, report);
        continue;
      }
    }

    let result;
    try {
      result = await sendAdmin(db, buildAdminAlert(row, report, nowMs, alertToken));
    } catch (error) {
      result = { ok: false, error: error?.message || String(error) };
    }
    if (await finishAdminAlert(db, claim.alertKey, result)) summary.alerted += 1;
    else summary.failed += 1;
    await updateDeliveryReport(db, row, report);
  }

  return summary;
}
