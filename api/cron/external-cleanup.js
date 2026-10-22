import crypto from 'node:crypto';
import { cors } from '../_lib/cors.js';
import { getDb } from '../_lib/db.js';
import { runExternalCleanup } from '../_lib/externalCleanup.js';
import { ensureExternalCleanupSchema } from '../_lib/externalCleanupSchema.js';

function timingSafeMatch(left, right) {
  const leftBuffer = Buffer.from(String(left));
  const rightBuffer = Buffer.from(String(right));
  return leftBuffer.length === rightBuffer.length
    && crypto.timingSafeEqual(leftBuffer, rightBuffer);
}

export async function handleExternalCleanupCron(req, res, dependencies = {}) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeMatch(req.headers.authorization || '', `Bearer ${secret}`)) {
    return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
  }
  const db = dependencies.db || getDb();
  await (dependencies.ensureSchema || ensureExternalCleanupSchema)(db);
  const result = await (dependencies.run || runExternalCleanup)(db, {
    ...dependencies,
    deadlineMs: 25000,
  });
  return res.json({ ok: true, ...result });
}

export default cors(handleExternalCleanupCron);
