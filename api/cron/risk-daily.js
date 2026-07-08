// 납기 리스크 일일 리포트 크론 — 매일 23:40 UTC (= KST 08:40)
// in_production 전건 평가 후 지연위험(red)/납기경과(overdue) 요약을 ADMIN_PHONES 로 LMS 발송.
// 솔라피 env 없으면 dry_run (notification_log 에 기록만). 위험 0건이면 발송하지 않음.
// 인증: Authorization: Bearer {CRON_SECRET}
import crypto from 'crypto';
import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { ensureNotifySchema } from '../_lib/notifySchema.js';
import { sendAdminLms } from '../_lib/notify.js';
import { assessOrder, kstToday } from '../_lib/risk.js';

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

  const db = getDb();
  await ensureNotifySchema(db);

  const [ordersResult, procResult] = await Promise.all([
    db.execute({
      sql: `SELECT id, client_name, due_date, ship_scheduled_date, status
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
  const overdue = [];
  const red = [];
  let amber = 0;
  let unknown = 0;

  for (const order of ordersResult.rows) {
    const a = assessOrder(order, procByOrder.get(Number(order.id)) || [], today);
    const item = {
      client_name: order.client_name || `주문 ${order.id}`,
      days_left: a.daysLeft,
      est_remain: a.estRemain,
      current_step: a.currentStep || '-',
    };
    if (a.level === 'overdue') overdue.push(item);
    else if (a.level === 'red') red.push({ ...item, slack: a.slack });
    else if (a.level === 'amber') amber += 1;
    else if (a.level === 'unknown') unknown += 1;
  }

  overdue.sort((a, b) => (a.days_left ?? 0) - (b.days_left ?? 0)); // 가장 오래 경과한 순
  red.sort((a, b) => (a.slack ?? 0) - (b.slack ?? 0));             // 여유 적은 순

  const counts = {
    overdue: overdue.length, red: red.length, amber, unknown,
    total: ordersResult.rows.length,
  };

  // 위험 0건이면 미발송 (알림 피로 방지)
  if (counts.overdue === 0 && counts.red === 0) {
    return res.json({ ok: true, sent: 0, skipped: 'no_risk', counts });
  }

  // 상위 5건: overdue 우선, 나머지를 red 로 채움
  const top = [
    ...overdue.map(o => `- ${o.client_name} +${Math.abs(o.days_left ?? 0)}일 경과 | ${o.current_step}`),
    ...red.map(r => `- ${r.client_name} D-${r.days_left} · 잔여 약 ${r.est_remain}일 | ${r.current_step}`),
  ].slice(0, 5);

  const lines = [
    `지연위험 ${counts.red}건 / 납기경과 ${counts.overdue}건 / 주의 ${counts.amber}건 (진행중 ${counts.total}건)`,
    '',
    ...top,
  ];
  const extraCount = counts.overdue + counts.red - top.length;
  if (extraCount > 0) lines.push(`외 ${extraCount}건 — 관리자 화면에서 전체 확인`);
  if (unknown > 0) lines.push(`납기미입력 ${unknown}건`);

  const subject = `[한성쇼케이스 납기리포트 ${today}]`;
  const text = [subject, '', ...lines].join('\n');

  const phones = String(process.env.ADMIN_PHONES || '')
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  if (phones.length === 0) {
    return res.json({ ok: true, sent: 0, skipped: 'no_admin_phones', counts });
  }

  const results = [];
  for (const phone of phones) {
    try {
      const r = await sendAdminLms(db, { to: phone, subject, text, tag: 'admin_daily' });
      results.push({ ok: Boolean(r.ok), dryRun: Boolean(r.dryRun), error: r.error || null });
    } catch (err) {
      results.push({ ok: false, error: err?.message || String(err) });
    }
  }

  return res.json({
    ok: true,
    sent: results.filter(r => r.ok).length,
    dryRun: results.some(r => r.dryRun),
    counts,
    results,
  });
});
