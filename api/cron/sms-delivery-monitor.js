import crypto from 'node:crypto';

import { cors } from '../_lib/cors.js';
import { getDb } from '../_lib/db.js';
import { runSmsDeliveryMonitor } from '../_lib/solapiDeliveryMonitor.js';
import { runSolapiHealthCycle } from '../_lib/solapiHealth.js';

function timingSafeMatch(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export async function handleSmsDeliveryMonitor(req, res, dependencies = {}) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeMatch(req.headers.authorization || '', `Bearer ${secret}`)) {
    return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
  }

  const nowMs = dependencies.nowMs ?? Date.now();

  const db = dependencies.db || getDb();
  const monitor = dependencies.monitor || runSmsDeliveryMonitor;
  const logger = dependencies.logger || console;
  // 쏠라피 연동 점검(조회만). 실패·예외가 나도 아래 기존 전달 상태 감시는 그대로 돈다.
  try {
    const health = await (dependencies.healthCycle || runSolapiHealthCycle)(db, { nowMs });
    if (health && health.state !== 'ok') logger.warn?.('[solapi-health]', { state: health.state, fail_count: health.fail_count });
  } catch (error) {
    logger.warn?.('[solapi-health] check failed', error?.message || error);
  }
  const result = await monitor(db, { nowMs });
  logger.info?.('[sms-delivery-monitor]', result);
  return res.json({ ok: true, ...result });
}

export default cors(handleSmsDeliveryMonitor);
