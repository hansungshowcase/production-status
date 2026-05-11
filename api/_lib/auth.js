import crypto from 'crypto';

// 환경변수 미설정 시 인증 비활성 (opt-in). 빌드/기존 호출 깨지지 않음.
// 운영자가 Vercel 환경변수에 SALES_PASSWORD / ADMIN_PASSWORD 추가하면 즉시 활성.
export function authEnabled() {
  return Boolean(process.env.SALES_PASSWORD || process.env.ADMIN_PASSWORD);
}

function getSecret() {
  // JWT_SECRET 미설정 시 비번 기반 derived secret 사용 (외부 의존성 X)
  const raw = process.env.JWT_SECRET
    || `${process.env.SALES_PASSWORD || ''}|${process.env.ADMIN_PASSWORD || ''}|prod-status`;
  return crypto.createHash('sha256').update(raw).digest();
}

function base64url(buf) {
  return Buffer.from(buf).toString('base64')
    .replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function base64urlDecode(str) {
  const pad = str.length % 4 === 2 ? '==' : str.length % 4 === 3 ? '=' : '';
  return Buffer.from(str.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

// 토큰 발급: { role, actor, exp } payload
export function issueToken({ role, actor }, ttlSec = 24 * 60 * 60) {
  const payload = { role, actor: actor || null, exp: Math.floor(Date.now() / 1000) + ttlSec };
  const body = base64url(JSON.stringify(payload));
  const sig = crypto.createHmac('sha256', getSecret()).update(body).digest();
  return `${body}.${base64url(sig)}`;
}

// 토큰 검증. 유효시 payload, 아니면 null.
export function verifyToken(token) {
  if (!token || typeof token !== 'string') return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, sig] = parts;
  let expected;
  try {
    expected = base64url(crypto.createHmac('sha256', getSecret()).update(body).digest());
  } catch { return null; }
  // timing-safe compare
  if (expected.length !== sig.length) return null;
  try {
    if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;
  } catch { return null; }
  let payload;
  try { payload = JSON.parse(base64urlDecode(body).toString('utf8')); } catch { return null; }
  if (!payload || typeof payload !== 'object') return null;
  if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
  return payload;
}

// 비번 검증 (timing-safe)
export function checkPassword(input, expected) {
  if (!expected) return false;
  const a = Buffer.from(String(input || ''));
  const b = Buffer.from(String(expected));
  if (a.length !== b.length) return false;
  try { return crypto.timingSafeEqual(a, b); } catch { return false; }
}

// 미들웨어: handler 호출 전 Bearer 토큰 검증. opt-in (auth 비활성 시 통과).
// roles: 허용 role 배열 (예: ['sales', 'admin'])
export function withAuth(handler, { roles = ['sales', 'admin'] } = {}) {
  return async (req, res) => {
    if (!authEnabled()) {
      // 환경변수 미설정 → 기존 동작 유지 (잘 되는 코드 보호)
      return handler(req, res);
    }
    const header = req.headers.authorization || '';
    const m = /^Bearer\s+(.+)$/i.exec(header);
    const token = m ? m[1] : null;
    const payload = verifyToken(token);
    if (!payload) {
      return res.status(401).json({ error: { message: '인증이 필요합니다.', status: 401 } });
    }
    if (roles.length && !roles.includes(payload.role)) {
      return res.status(403).json({ error: { message: '권한이 없습니다.', status: 403 } });
    }
    // req.auth로 노출 — 핸들러는 body.actor 대신 req.auth.actor 사용 권장
    req.auth = payload;
    return handler(req, res);
  };
}

// 헬퍼: 인증된 actor가 있으면 그걸 우선, 아니면 body의 actor (opt-in 호환)
export function resolveActor(req) {
  return req.auth?.actor || req.body?.actor || '시스템';
}

// 메서드 혼합 파일용 인라인 검증. 통과 시 payload(또는 빈 객체), 실패 시 응답 보내고 null.
// 핸들러는 반환값으로 분기: const auth = requireAuth(req, res, { roles: ['sales'] }); if (!auth) return;
export function requireAuth(req, res, { roles = ['sales', 'admin'] } = {}) {
  if (!authEnabled()) {
    // opt-in: 환경변수 미설정 시 통과 (기존 동작 유지)
    return { role: null, actor: null, _bypass: true };
  }
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  const token = m ? m[1] : null;
  const payload = verifyToken(token);
  if (!payload) {
    res.status(401).json({ error: { message: '인증이 필요합니다.', status: 401 } });
    return null;
  }
  if (roles.length && !roles.includes(payload.role)) {
    res.status(403).json({ error: { message: '권한이 없습니다.', status: 403 } });
    return null;
  }
  req.auth = payload;
  return payload;
}
