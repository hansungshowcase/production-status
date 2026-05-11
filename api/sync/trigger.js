import { cors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { rateLimitCheck } from '../_lib/rateLimit.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  if (!rateLimitCheck(req, res)) return;
  const auth = requireAuth(req, res, { roles: ['admin'] });
  if (!auth) return;

  return res.status(503).json({
    success: false,
    error: 'Google Sheets 동기화 모듈이 비활성화 상태입니다. .env에서 SYNC_ENABLED=true로 설정하세요.',
  });
});
