import { cors } from '../_lib/cors.js';
import { clearAuthCookie } from '../_lib/auth.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed', status: 405 } });
  clearAuthCookie(res);
  return res.json({ ok: true });
});
