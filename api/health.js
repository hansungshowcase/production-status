import { cors } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { readSolapiHealth } from './_lib/solapiHealth.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const body = {
    status: 'ok',
    timestamp: new Date().toISOString(),
    environment: 'vercel',
  };

  // ?deep=solapi 일 때만 DB 에 저장된 마지막 쏠라피 연동 상태를 덧붙인다(쏠라피를 직접 부르지 않는다).
  const deep = Array.isArray(req.query?.deep) ? req.query.deep[0] : req.query?.deep;
  if (deep === 'solapi') {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('CDN-Cache-Control', 'no-store');
    res.setHeader('Vercel-CDN-Cache-Control', 'no-store');
    let health = null;
    try { health = await readSolapiHealth(getDb()); } catch { health = null; }
    body.solapi = health
      ? { state: health.state, detail: health.detail, checked_at: health.checked_at, last_ok_at: health.last_ok_at,
          cron_age_seconds: health.cron_age_seconds, cron_stale: health.cron_stale }
      : { state: 'unknown', detail: 'no_record', checked_at: null, last_ok_at: null, cron_age_seconds: null, cron_stale: true };
  }

  return res.json(body);
});
