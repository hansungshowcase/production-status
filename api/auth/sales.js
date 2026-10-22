import { cors } from '../_lib/cors.js';
import { authEnabled, checkPassword, ensureSigningSecret, issueToken, setAuthCookie, verifyDatabaseLogin } from '../_lib/auth.js';
import { rateLimitCheck } from '../_lib/rateLimit.js';
import { SALES_PERSON_NAMES } from '../../shared/workerAccess.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed', status: 405 } });
  if (!authEnabled()) return res.json({ enabled: false });
  const actor = String(req.body?.actor || '').trim();
  if (!rateLimitCheck(req, res, { windowMs: 60000, max: 10, keySuffix: actor })) return;
  await ensureSigningSecret();
  if (!SALES_PERSON_NAMES.includes(actor)) return res.status(401).json({ error: { message: '이름 또는 비밀번호가 일치하지 않습니다.', status: 401 } });
  let credential = null;
  const envLogin = process.env.SALES_PASSWORD && checkPassword(req.body?.password, process.env.SALES_PASSWORD);
  if (!envLogin) credential = await verifyDatabaseLogin('sales', '*', req.body?.password);
  if (!envLogin && !credential) return res.status(401).json({ error: { message: '이름 또는 비밀번호가 일치하지 않습니다.', status: 401 } });
  const token = issueToken({ role: 'sales', actor, credentialId: credential?.id, credentialVersion: credential?.credential_version });
  setAuthCookie(res, token);
  return res.json({ enabled: true, token, role: 'sales', actor });
});
