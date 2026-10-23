// 분체 미착수 경보 크론 — 매일 23:40 UTC (= KST 08:40)
// in_production 전건 평가 후 "출고 5일 이내인데 분체작업 미착수" 건만 LMS 발송.
// 영업담당자(sales_person)별로 라우팅 — 각 담당자 번호로 본인 담당 건만 발송 (alertRoutes.js).
// (그 외 납기경과·미마감 등은 문자로 안 보내고 관리자 화면에서만 확인 — 대표 지정)
// 솔라피 env 없으면 dry_run (notification_log 에 기록만). 대상 0건이면 발송하지 않음.
// 인증: Authorization: Bearer {CRON_SECRET}
import crypto from 'crypto';
import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { ensureNotificationDailyClaimsSchema, ensureNotifySchema } from '../_lib/notifySchema.js';
import { sendAdminLms } from '../_lib/notify.js';
import { assessOrder, isShipRiskAlert, isKstWeekend } from '../_lib/risk.js';
import { canonicalAlertRecipientName, routeAlerts } from '../_lib/alertRoutes.js';
import { findSolapiAttemptReceipt } from '../_lib/solapiDeliveryMonitor.js';
import { buildProductionAlertMessage } from '../_lib/productionAlertMessage.js';

// 상수시간 비교 (타이밍 사이드채널 방지)
function timingSafeMatch(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export async function claimDailyNotification(db, { kstDate, toPhone, milestone, attemptToken }) {
  const { rows } = await db.execute({
    sql: `INSERT INTO notification_daily_claims (
            kst_date, to_phone, milestone, status, attempts, attempt_token, created_at, updated_at
          ) VALUES (?::date, ?, ?, 'sending', 1, ?, NOW(), NOW())
          ON CONFLICT (kst_date, to_phone, milestone) DO NOTHING
          RETURNING attempt_token`,
    args: [kstDate, String(toPhone || '').replace(/\D/g, ''), milestone, attemptToken],
  });
  return rows[0]?.attempt_token === attemptToken;
}

export async function finishDailyNotification(db, claim, result) {
  const status = result?.dryRun
    ? 'dry_run'
    : result?.ok && result?.msgId
      ? 'success'
      : result?.explicitFailure
        ? 'failed_terminal'
        : 'uncertain';
  const { rows } = await db.execute({
    sql: `UPDATE notification_daily_claims
             SET status = ?,
                 provider_msgid = ?,
                 error = ?,
                 updated_at = NOW()
           WHERE kst_date = ?::date
             AND to_phone = ?
             AND milestone = ?
             AND attempt_token = ?
           RETURNING attempt_token`,
    args: [
      status,
      result?.msgId || null,
      result?.error ? String(result.error).slice(0, 500) : null,
      claim.kstDate,
      claim.toPhone,
      claim.milestone,
      claim.attemptToken,
    ],
  });
  return rows.length > 0;
}

export function buildChonbeAlertMessage({ today, persons, items = [] }) {
  const subject = `[한성쇼케이스 분체 미착수 경보 ${today}]`;
  return buildProductionAlertMessage({
    subject,
    recipientName: persons,
    date: today,
    summary: `분체작업 착수 확인 대상 ${items.length}건입니다.`,
    items: items.map(item => ({
      orderId: item.order_id,
      clientName: item.client_name,
      dueDay: item.due_date,
      daysLeft: item.days_left,
      detail: `현재 공정: ${item.current_step || '확인 필요'}`,
      action: '분체작업 진행 상황을 확인하고 필요한 착수 조치를 해 주시기 바랍니다.',
    })),
  });
}

export async function handleRiskDaily(req, res, dependencies = {}) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeMatch(req.headers.authorization || '', `Bearer ${secret}`)) {
    return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
  }

  // 주말(토·일, KST)엔 발송하지 않는다 — 평일 오전에만 1회.
  // 크론 스케줄(UTC 일~목)로도 막지만, 스케줄이 바뀌어도 여기서 최종 차단.
  const nowMs = dependencies.nowMs ?? Date.now();
  if (isKstWeekend(nowMs)) {
    return res.json({ ok: true, sent: 0, skipped: 'weekend' });
  }

  const db = dependencies.db || getDb();
  const ensureBaseSchema = dependencies.ensureNotifySchema || ensureNotifySchema;
  const ensureClaimsSchema = dependencies.ensureClaimsSchema || ensureNotificationDailyClaimsSchema;
  const sendLms = dependencies.sendLms || sendAdminLms;
  await ensureBaseSchema(db);
  await ensureClaimsSchema(db);

  const [ordersResult, procResult] = await Promise.all([
    db.execute({
      sql: `SELECT id, client_name, sales_person, due_date, ship_scheduled_date, status
              FROM orders WHERE status = 'in_production'`,
      args: [],
    }),
    db.execute({
      sql: `SELECT p.order_id, p.step_name, p.status
              FROM processes p
              JOIN orders o ON o.id = p.order_id
             WHERE o.status = 'in_production'
             ORDER BY p.order_id, p.id`,
      args: [],
    }),
  ]);

  const procByOrder = new Map();
  for (const p of procResult.rows) {
    const key = Number(p.order_id);
    if (!procByOrder.has(key)) procByOrder.set(key, []);
    procByOrder.get(key).push(p);
  }

  const today = dependencies.today || new Date(nowMs + 9 * 60 * 60 * 1000).toISOString().slice(0, 10);
  const alerts = [];

  for (const order of ordersResult.rows) {
    const a = assessOrder(order, procByOrder.get(Number(order.id)) || [], today);
    // 대상: 출고 5일 이내인데 분체작업 미착수 — 이것만 문자 발송
    if (isShipRiskAlert(a)) {
      alerts.push({
        order_id: Number(order.id),
        sales_person: order.sales_person || null,
        client_name: order.client_name || `주문 ${order.id}`,
        due_date: order.ship_scheduled_date || order.due_date || null,
        days_left: a.daysLeft,
        current_step: a.currentStep || '-',
      });
    }
  }

  const counts = { alerts: alerts.length, scanned: ordersResult.rows.length };

  // 대상 0건이면 미발송 (알림 피로 방지)
  if (alerts.length === 0) {
    return res.json({ ok: true, sent: 0, skipped: 'no_alert', counts });
  }

  // 담당자(sales_person)별 라우팅 — 각 담당자 번호로 본인 담당 건만 발송
  const { byPhone, unrouted } = routeAlerts(alerts);
  const results = [];
  for (const [phone, group] of byPhone) {
    const items = group.items.slice().sort((x, y) => (x.days_left ?? 0) - (y.days_left ?? 0)); // 임박한 순
    const persons = [...group.persons].join(', ');
    const { subject, text } = buildChonbeAlertMessage({ today, persons, items });
    const masked = phone.slice(0, 3) + '****' + phone.slice(-4);
    const normalizedPhone = String(phone || '').replace(/\D/g, '');
    const attemptToken = crypto.randomUUID();
    const claim = {
      kstDate: today,
      toPhone: normalizedPhone,
      milestone: 'chonbe_alert',
      attemptToken,
    };
    if (!await claimDailyNotification(db, claim)) {
      const { rows: existingClaims } = await db.execute({
        sql: `SELECT status, attempt_token, created_at
                FROM notification_daily_claims
               WHERE kst_date = ?::date AND to_phone = ? AND milestone = ?`,
        args: [today, normalizedPhone, 'chonbe_alert'],
      });
      const existing = existingClaims[0];
      if (existing && ['sending', 'uncertain'].includes(existing.status)) {
        try {
          const findReceipt = dependencies.findAttemptReceipt || findSolapiAttemptReceipt;
          const receipt = await findReceipt(normalizedPhone, existing.attempt_token, {
            at: existing.created_at,
            nowMs,
          });
          if (receipt?.messageId) {
            await finishDailyNotification(db, {
              kstDate: today,
              toPhone: normalizedPhone,
              milestone: 'chonbe_alert',
              attemptToken: existing.attempt_token,
            }, { ok: true, msgId: receipt.messageId });
          }
        } catch {}
      }
      results.push({ phone: masked, persons, count: items.length, ok: false, skipped: 'already_claimed', error: null });
      continue;
    }
    let r;
    try {
      r = await sendLms(db, {
        to: phone,
        recipientName: canonicalAlertRecipientName([...group.persons][0]) || null,
        subject,
        text,
        tag: 'chonbe_alert',
        customFields: { notificationAttemptToken: attemptToken },
      });
    } catch (err) {
      r = { ok: false, uncertain: true, error: err?.message || String(err) };
    }
    await finishDailyNotification(db, claim, r);
    results.push({ phone: masked, persons, count: items.length, ok: Boolean(r.ok), dryRun: Boolean(r.dryRun), error: r.error || null });
  }

  return res.json({
    ok: true,
    sent: results.filter(r => r.ok).length,
    dryRun: results.some(r => r.dryRun),
    counts,
    routed: results,
    unrouted: unrouted.map(u => ({ person: u.person, client_name: u.client_name, days_left: u.days_left })),
  });
}

export default cors(handleRiskDaily);
