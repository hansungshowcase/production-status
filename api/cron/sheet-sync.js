import crypto from 'node:crypto';

import { cors } from '../_lib/cors.js';
import { getDb } from '../_lib/db.js';
import { retryPendingSheetSync } from '../_lib/sheetSync.js';
import { ensureSheetSyncSchema } from '../_lib/sheetSyncSchema.js';

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
  { retry = retryPendingSheetSync } = {},
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
  const summary = await retry(db, { limit: 10, deadlineMs: 20_000 });
  return res.json({ ok: true, ...summary });
}

export default cors(async function handler(req, res) {
  return handleSheetSyncCron(req, res);
});
