import { cors } from '../_lib/cors.js';
import { authConfigurationError, authEnabled, authRequired, verifyToken } from '../_lib/auth.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  if (!authEnabled()) {
    if (authRequired()) {
      return authConfigurationError(res);
    }
    return res.json({ enabled: false });
  }
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  const payload = m ? verifyToken(m[1]) : null;
  return res.json({
    enabled: true,
    authenticated: !!payload,
    role: payload?.role || null,
    actor: payload?.actor || null,
    exp: payload?.exp || null,
  });
});
