import crypto from 'node:crypto';

import { cors } from '../_lib/cors.js';
import { getDb } from '../_lib/db.js';
import { retryPendingSheetSync } from '../_lib/sheetSync.js';
import { ensureSheetSyncSchema } from '../_lib/sheetSyncSchema.js';
import { retryPendingShippingSheetSync } from '../_lib/shippingSheetSync.js';
import { ensureShippingSheetSyncSchema } from '../_lib/shippingSheetSyncSchema.js';

// Vercel 함수 한도 30초. 상태 기록 여유를 두고 25초까지 쓴다.
const SYNC_DEADLINE_MS = 25_000;
const APPEND_MINIMUM_BUDGET_MS = 16_000;
const SHIPPING_MINIMUM_BUDGET_MS = 11_000;

function emptySyncSummary() {
  return { attempted: 0, synced: 0, failed: 0, skipped: 0, errors: [] };
}

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
    now = Date.now,
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

  const startedAt = now();
  const remainingBudget = () => Math.max(
    0,
    Math.min(SYNC_DEADLINE_MS, SYNC_DEADLINE_MS - (now() - startedAt)),
  );
  let appendSummary = emptySyncSummary();
  let shippingSummary = emptySyncSummary();

  const runAppend = async () => {
    const deadlineMs = remainingBudget();
    if (deadlineMs < APPEND_MINIMUM_BUDGET_MS) return;
    appendSummary = await retry(db, { limit: 25, deadlineMs });
  };
  const runShipping = async () => {
    const deadlineMs = remainingBudget();
    if (deadlineMs < SHIPPING_MINIMUM_BUDGET_MS) return;
    shippingSummary = await retryShipping(db, { limit: 25, deadlineMs });
  };

  if (new Date(startedAt).getUTCMinutes() % 2 === 0) {
    await runAppend();
    await runShipping();
  } else {
    await runShipping();
    await runAppend();
  }
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
