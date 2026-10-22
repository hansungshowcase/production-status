// 고객 조회링크 발급 — POST/GET /api/orders/:id/track-link
// track_token 은 공개 주문목록 응답(GET /api/orders)에 절대 싣지 않는다.
// 영업 화면에서 버튼 클릭 시 이 엔드포인트로만 발급/조회 (requireAuth — 인증 활성 시 sales 만).
import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { requireAuth } from '../../_lib/auth.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { ensureTrackToken } from '../../_lib/trackToken.js';
import { parsePositiveInt4Id } from '../../_lib/positiveInt4Id.js';

export async function handleTrackLink(req, res, dependencies = {}) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  const checkRateLimit = dependencies.rateLimitCheck || rateLimitCheck;
  if (!checkRateLimit(req, res)) return;

  const checkAuth = dependencies.requireAuth || requireAuth;
  const auth = await checkAuth(req, res, { roles: ['sales'] });
  if (!auth) return;

  const id = parsePositiveInt4Id(req.query.id);
  if (id === null) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }

  const db = dependencies.db || getDb();
  const ensureToken = dependencies.ensureTrackToken || ensureTrackToken;
  const token = await ensureToken(db, id);
  if (!token) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }

  const base = (process.env.BASE_URL || 'https://production-status.vercel.app').replace(/\/+$/, '');
  return res.json({ token, url: `${base}/track/${token}` });
}

export default cors(handleTrackLink);
