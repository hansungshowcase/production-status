// 분체 미착수 경보 크론 — 매일 23:40 UTC (= KST 08:40)
// in_production 전건 평가 후 "출고 5일 이내인데 분체작업 미착수" 건만 LMS 발송.
// 영업담당자(sales_person)별로 라우팅 — 각 담당자 번호로 본인 담당 건만 발송 (alertRoutes.js).
// (그 외 납기경과·미마감 등은 문자로 안 보내고 관리자 화면에서만 확인 — 대표 지정)
// 솔라피 env 없으면 dry_run (notification_log 에 기록만). 대상 0건이면 발송하지 않음.
// 인증: Authorization: Bearer {CRON_SECRET}
import crypto from 'crypto';
import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { ensureNotifySchema } from '../_lib/notifySchema.js';
import { sendAdminLms } from '../_lib/notify.js';
import { assessOrder, isShipRiskAlert, isKstWeekend, kstToday } from '../_lib/risk.js';
import { routeAlerts } from '../_lib/alertRoutes.js';

// 상수시간 비교 (타이밍 사이드채널 방지)
function timingSafeMatch(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

export default cors(async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeMatch(req.headers.authorization || '', `Bearer ${secret}`)) {
    return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
  }

  // 주말(토·일, KST)엔 발송하지 않는다 — 평일 오전에만 1회.
  // 크론 스케줄(UTC 일~목)로도 막지만, 스케줄이 바뀌어도 여기서 최종 차단.
  if (isKstWeekend()) {
    return res.json({ ok: true, sent: 0, skipped: 'weekend' });
  }

  const db = getDb();
  await ensureNotifySchema(db);

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

  const today = kstToday();
  const alerts = [];

  for (const order of ordersResult.rows) {
    const a = assessOrder(order, procByOrder.get(Number(order.id)) || [], today);
    // 대상: 출고 5일 이내인데 분체작업 미착수 — 이것만 문자 발송
    if (isShipRiskAlert(a)) {
      alerts.push({
        sales_person: order.sales_person || null,
        client_name: order.client_name || `주문 ${order.id}`,
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
  const MAX = 20;
  const subject = `[한성쇼케이스 분체 미착수 경보 ${today}]`;

  const results = [];
  for (const [phone, group] of byPhone) {
    const items = group.items.slice().sort((x, y) => (x.days_left ?? 0) - (y.days_left ?? 0)); // 임박한 순
    const persons = [...group.persons].join(', ');
    const listed = items.slice(0, MAX).map(a => `- ${a.client_name} D-${a.days_left} | 현재 ${a.current_step}`);
    const lines = [
      `${persons}님 담당 — 출고 5일 이내인데 분체작업 미착수 ${items.length}건 (현장 확인 요망)`,
      '',
      ...listed,
    ];
    if (items.length > MAX) lines.push(`외 ${items.length - MAX}건 — 관리자 화면에서 전체 확인`);
    const text = [subject, '', ...lines].join('\n');
    const masked = phone.slice(0, 3) + '****' + phone.slice(-4);
    try {
      const r = await sendAdminLms(db, { to: phone, subject, text, tag: 'chonbe_alert' });
      results.push({ phone: masked, persons, count: items.length, ok: Boolean(r.ok), dryRun: Boolean(r.dryRun), error: r.error || null });
    } catch (err) {
      results.push({ phone: masked, persons, count: items.length, ok: false, error: err?.message || String(err) });
    }
  }

  return res.json({
    ok: true,
    sent: results.filter(r => r.ok).length,
    dryRun: results.some(r => r.dryRun),
    counts,
    routed: results,
    unrouted: unrouted.map(u => ({ person: u.person, client_name: u.client_name, days_left: u.days_left })),
  });
});
