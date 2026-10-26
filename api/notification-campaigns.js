import { cors } from './_lib/cors.js';
import { getDb } from './_lib/db.js';
import { enforceSameOriginWrite } from './_lib/accessPolicy.js';
import { rateLimitCheck } from './_lib/rateLimit.js';
import { CAMPAIGN_VARIABLES, listNotificationCampaigns, saveNotificationCampaign } from './_lib/notificationCampaigns.js';

const value = input => Array.isArray(input) ? input[0] : input;
export async function handleNotificationCampaigns(req, res, dependencies = {}) {
  for (const header of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) res.setHeader(header, 'no-store');
  if (!['GET', 'POST', 'PUT'].includes(req.method)) return res.status(405).json({ error: { message: 'Method not allowed', status: 405 } });
  if (req.method !== 'GET' && !enforceSameOriginWrite(req, res)) return;
  if (!(dependencies.rateLimitCheck || rateLimitCheck)(req, res, { windowMs: 60000, max: req.method === 'GET' ? 60 : 15, keySuffix: req.method })) return;
  const db = dependencies.db || getDb();
  try {
    if (req.method === 'GET') {
      const audience = String(value(req.query?.audience) || '');
      if (audience && !['customer', 'employee'].includes(audience)) return res.status(400).json({ error: { message: '고객 또는 직원을 선택해 주세요.', status: 400 } });
      return res.status(200).json({ items: await listNotificationCampaigns(db, audience), variables: CAMPAIGN_VARIABLES,
        capabilities: { canRegister: true, canActivate: false }, notice: '등록한 문자는 초안으로 저장됩니다. 발송 연결을 확인한 뒤 활성화할 수 있습니다.' });
    }
    const id = req.method === 'PUT' ? String(value(req.query?.id) || '') : null;
    const item = await saveNotificationCampaign(db, req.body, { id });
    return res.status(req.method === 'POST' ? 201 : 200).json({ item });
  } catch (error) {
    if (!error.publicMessage) throw error;
    return res.status(error.status || 500).json({ error: { message: error.publicMessage, status: error.status || 500 } });
  }
}
export default cors((req, res) => handleNotificationCampaigns(req, res));
