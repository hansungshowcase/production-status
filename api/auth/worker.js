import { cors } from '../_lib/cors.js';
import { authEnabled, ensureSigningSecret, issueToken, setAuthCookie, verifyDatabaseLogin } from '../_lib/auth.js';
import { rateLimitCheck } from '../_lib/rateLimit.js';
import { WORKERS } from '../../shared/workerAccess.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: { message: 'Method not allowed', status: 405 } });
  if (!authEnabled()) return res.json({ enabled: false });
  const actor = String(req.body?.actor || '').trim();
  if (!rateLimitCheck(req, res, { windowMs: 60000, max: 5, keySuffix: actor })) return;
  await ensureSigningSecret();
  const credential = WORKERS.includes(actor) ? await verifyDatabaseLogin('worker', actor, req.body?.password) : await verifyDatabaseLogin('worker', '__invalid__', req.body?.password);
  if (!credential) return res.status(401).json({ error: { message: '이름 또는 비밀번호가 일치하지 않습니다.', status: 401 } });
  const token = issueToken({ role: 'worker', actor, credentialId: credential.id, credentialVersion: credential.credential_version });
  setAuthCookie(res, token);
  return res.json({ enabled: true, token, role: 'worker', actor });
});
