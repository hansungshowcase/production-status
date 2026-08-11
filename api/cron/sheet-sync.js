import crypto from 'node:crypto';

import { cors } from '../_lib/cors.js';
import { getDb } from '../_lib/db.js';
import { retryPendingSheetSync } from '../_lib/sheetSync.js';
import { ensureSheetSyncSchema } from '../_lib/sheetSyncSchema.js';
import { retryPendingShippingSheetSync } from '../_lib/shippingSheetSync.js';
import { ensureShippingSheetSyncSchema } from '../_lib/shippingSheetSyncSchema.js';

// Vercel 함수 한도 30초. 상태 기록 여유를 두고 25초까지 쓴다.
const SYNC_DEADLINE_MS = 25_000;

function timingSafeMatch(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export async function handleSheetSyncCron(
  req,
  res,
  db,
  {
    retry = retryPendingSheetSync,
    retryShipping = retryPendingShippingSheetSync,
  } = {},
) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeMatch(req.headers.authorization || '', `Bearer ${secret}`)) {
    return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
  }

  db ??= getDb();
  await ensureSheetSyncSchema(db);
  await ensureShippingSheetSyncSchema(db);

  const startedAt = Date.now();
  const appendSummary = await retry(db, { limit: 25, deadlineMs: SYNC_DEADLINE_MS });
  const remainingDeadlineMs = Math.max(0, SYNC_DEADLINE_MS - (Date.now() - startedAt));
  const shippingSummary = await retryShipping(db, {
    limit: 10,
    deadlineMs: remainingDeadlineMs,
  });
  return res.json({
    ok: true,
    ...appendSummary,
    append: appendSummary,
    shipping: shippingSummary,
  });
}

export default cors(async function handler(req, res) {
  return handleSheetSyncCron(req, res);
});
