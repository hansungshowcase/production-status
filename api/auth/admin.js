import { cors } from '../_lib/cors.js';
import { authEnabled, checkPassword, issueToken } from '../_lib/auth.js';
import { rateLimitCheck } from '../_lib/rateLimit.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  if (!rateLimitCheck(req, res, { windowMs: 60000, max: 5 })) return;
  if (!authEnabled()) {
    return res.json({ enabled: false });
  }
  const { password } = req.body || {};
  if (!checkPassword(password, process.env.ADMIN_PASSWORD)) {
    return res.status(401).json({ error: { message: '비밀번호가 일치하지 않습니다.', status: 401 } });
  }
  const token = issueToken({ role: 'admin', actor: '관리자' });
  return res.json({ enabled: true, token, role: 'admin', actor: '관리자' });
});
