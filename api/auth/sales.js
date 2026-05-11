import { cors } from '../_lib/cors.js';
import { authEnabled, checkPassword, issueToken } from '../_lib/auth.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  if (!authEnabled()) {
    // 인증 비활성 — 아무 사용자나 통과시키되 토큰 발급은 안 함 (클라이언트는 토큰 없이도 진입)
    return res.json({ enabled: false });
  }
  const { password, actor } = req.body || {};
  if (!checkPassword(password, process.env.SALES_PASSWORD)) {
    return res.status(401).json({ error: { message: '비밀번호가 일치하지 않습니다.', status: 401 } });
  }
  const token = issueToken({ role: 'sales', actor: actor || null });
  return res.json({ enabled: true, token, role: 'sales', actor: actor || null });
});
