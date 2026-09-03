import crypto from 'node:crypto';

import { cors } from '../_lib/cors.js';
import { getDb } from '../_lib/db.js';
import { isKstWeekend } from '../_lib/risk.js';
import { runSmsDeliveryMonitor } from '../_lib/solapiDeliveryMonitor.js';

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
  if (isKstWeekend(nowMs)) {
    return res.json({ ok: true, skipped: 'weekend' });
  }

  const db = dependencies.db || getDb();
  const monitor = dependencies.monitor || runSmsDeliveryMonitor;
  const result = await monitor(db, { nowMs });
  return res.json({ ok: true, ...result });
}

export default cors(handleSmsDeliveryMonitor);
