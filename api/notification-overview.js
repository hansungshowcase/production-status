import { cors } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { loadNotificationOverview } from './_lib/notificationOverview.js';
import { rateLimitCheck } from './_lib/rateLimit.js';

export async function handleNotificationOverview(req, res, dependencies = {}) {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Vercel-CDN-Cache-Control', 'no-store');

  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const checkRateLimit = dependencies.rateLimitCheck || rateLimitCheck;
  if (!checkRateLimit(req, res, { windowMs: 60000, max: 60 })) return;

  let db;
  try {
    db = dependencies.db || getDb();
  } catch {
    db = { execute: async () => { throw new Error('notification log unavailable'); } };
  }

  const loadOverview = dependencies.loadOverview || loadNotificationOverview;
  const overview = await loadOverview(
    db,
    dependencies.env || process.env,
    dependencies.now || new Date(),
  );
  return res.status(200).json(overview);
}

export default cors((req, res) => handleNotificationOverview(req, res));
