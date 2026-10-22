import { cors } from '../_lib/cors.js';
import { checkPassword, ensureSigningSecret, issueToken, setAuthCookie, verifyDatabaseLogin } from '../_lib/auth.js';
import { rateLimitCheck } from '../_lib/rateLimit.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed', status: 405 } });
  if (!rateLimitCheck(req, res, { windowMs: 60000, max: 5, keySuffix: '관리자' })) return;
  await ensureSigningSecret();
  let credential = null;
  const envLogin = process.env.ADMIN_PASSWORD && checkPassword(req.body?.password, process.env.ADMIN_PASSWORD);
  if (!envLogin) credential = await verifyDatabaseLogin('admin', '관리자', req.body?.password);
  if (!envLogin && !credential) return res.status(401).json({ error: { message: '이름 또는 비밀번호가 일치하지 않습니다.', status: 401 } });
  const token = issueToken({ role: 'admin', actor: '관리자', credentialId: credential?.id, credentialVersion: credential?.credential_version });
  setAuthCookie(res, token);
  return res.json({ enabled: true, token, role: 'admin', actor: '관리자' });
});
