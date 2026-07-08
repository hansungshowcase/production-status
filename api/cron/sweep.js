// 스윕 크론 — 매일 23:30 UTC (= KST 08:30, 조용시간 해제 직후)
// 1) queued(조용시간 대기)/failed(재시도, 최대 3회)/sending(5분+ 방치 = 크래시 잔재) 마일스톤 재발송
// 2) 훅 누락 복구: 마일스톤에 도달했는데 notify_state 미기록인 packed/shipped 스캔
//    (최근 3일 내 발생 건만 — 과거 데이터에 뒤늦은 알림 폭주 방지)
// 인증: Authorization: Bearer {CRON_SECRET} (Vercel Cron 이 CRON_SECRET env 존재 시 자동 첨부)
import crypto from 'crypto';
import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { ensureNotifySchema } from '../_lib/notifySchema.js';
import { maybeNotify } from '../_lib/notify.js';

const RECOVER_WINDOW_MS = 3 * 24 * 60 * 60 * 1000;
const STALE_SENDING_MS = 5 * 60 * 1000; // notify.js 의 STALE_SENDING_MS 와 동일 기준

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

  const summary = {
    retried: 0, queued: 0, recoveredPacked: 0, recoveredShipped: 0,
    skipped: 0, failed: 0, errors: [],
  };

  const runNotify = async (order, milestone, extra, counterKey) => {
    try {
      const r = await maybeNotify(db, order, milestone, extra);
      if (r?.ok) summary[counterKey] += 1;
      else if (r?.queued) summary.queued += 1;
      else if (r?.skipped) summary.skipped += 1;
      else summary.failed += 1;
    } catch (err) {
      summary.failed += 1;
      summary.errors.push(`order ${order.id} ${milestone}: ${err?.message || err}`);
    }
  };

  // ── 1) queued / failed / stale-sending 재발송 ──────────────────
  // stale sending: 발송 도중 함수 크래시/타임아웃으로 'sending' 인 채 방치된 건 —
  // maybeNotify 의 claim SQL 이 5분 지난 sending 재선점을 허용하므로 여기서 재시도 주체가 되어 준다.
  const staleBefore = new Date(Date.now() - STALE_SENDING_MS).toISOString();
  const { rows: pendingOrders } = await db.execute({
    sql: `SELECT o.* FROM orders o
           WHERE EXISTS (
             SELECT 1 FROM jsonb_each(COALESCE(o.notify_state, '{}'::jsonb)) kv
              WHERE kv.value ->> 'status' IN ('queued', 'failed')
                 OR (kv.value ->> 'status' = 'sending' AND COALESCE(kv.value ->> 'at', '') < ?)
           )
           ORDER BY o.id
           LIMIT 100`,
    args: [staleBefore],
  });

  for (const order of pendingOrders) {
    const state = (order.notify_state && typeof order.notify_state === 'object') ? order.notify_state : {};
    for (const [key, val] of Object.entries(state)) {
      const status = val?.status;
      const staleSending = status === 'sending' && String(val?.at || '') < staleBefore;
      if (status !== 'queued' && status !== 'failed' && !staleSending) continue;

      if (status === 'failed' || staleSending) {
        // 재시도 상한: notification_log 기준 failed 3회 이상이면 포기 (고객 스팸 방지)
        const { rows: fc } = await db.execute({
          sql: `SELECT COUNT(*)::int AS n FROM notification_log
                 WHERE order_id = ? AND milestone = ? AND status = 'failed'`,
          args: [order.id, key],
        });
        if ((fc[0]?.n || 0) >= 3) { summary.skipped += 1; continue; }
      }

      const isReschedule = key.startsWith('rescheduled:');
      const milestone = isReschedule ? 'rescheduled' : key;
      const extra = isReschedule ? { date: key.slice('rescheduled:'.length) } : {};
      await runNotify(order, milestone, extra, 'retried');
    }
  }

  // ── 2) 훅 누락 복구 (최근 3일 내 도달 건만) ────────────────────
  const sinceIso = new Date(Date.now() - RECOVER_WINDOW_MS).toISOString();
  const sinceDate = sinceIso.slice(0, 10);

  // packed: 포장 공정 completed 인데 notify_state.packed 미기록 (미출고 건만 — 이미 출고면 shipped 가 우선)
  const { rows: missedPacked } = await db.execute({
    sql: `SELECT DISTINCT ON (o.id) o.*
            FROM orders o
            JOIN processes p ON p.order_id = o.id AND p.step_name = '포장' AND p.status = 'completed'
           WHERE (o.notify_state -> 'packed') IS NULL
             AND o.status != 'shipped'
             AND COALESCE(p.completed_at, '') >= ?
           ORDER BY o.id
           LIMIT 50`,
    args: [sinceIso],
  });
  for (const order of missedPacked) {
    await runNotify(order, 'packed', {}, 'recoveredPacked');
  }

  // shipped: status='shipped' 인데 notify_state.shipped 미기록
  const { rows: missedShipped } = await db.execute({
    sql: `SELECT o.* FROM orders o
           WHERE o.status = 'shipped'
             AND (o.notify_state -> 'shipped') IS NULL
             AND COALESCE(o.ship_date, '') >= ?
           ORDER BY o.id
           LIMIT 50`,
    args: [sinceDate],
  });
  for (const order of missedShipped) {
    await runNotify(order, 'shipped', {}, 'recoveredShipped');
  }

  return res.json({ ok: true, ...summary });
});
