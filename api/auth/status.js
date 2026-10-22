import { cors } from '../_lib/cors.js';
import { authEnabled, authenticateRequest, ensureSigningSecret } from '../_lib/auth.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: { message: 'Method not allowed', status: 405 } });
  if (!authEnabled()) return res.json({ enabled: false });
  await ensureSigningSecret();
  const payload = await authenticateRequest(req);
  return res.json({
    enabled: true,
    authenticated: Boolean(payload),
    role: payload?.role || null,
    actor: payload?.actor || null,
    exp: payload?.exp || null,
  });
});
