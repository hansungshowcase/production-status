import { authEnabled, verifyToken } from './auth.js';

// GET 응답 마스킹용 소프트 인증 판별.
// requireAuth와 달리 실패해도 401을 보내지 않는다 — 작업자/태블릿 무로그인 화면이
// 같은 GET을 계속 사용해야 하므로, 요청 자체는 통과시키고 민감 필드만 가린다.
// 인증 비활성(SALES_PASSWORD/ADMIN_PASSWORD 미설정) 시 기존 동작 유지를 위해 전권 취급.
export function canReadSensitiveFields(req, roles = ['sales', 'admin']) {
  if (!authEnabled()) return true;
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  const payload = m ? verifyToken(m[1]) : null;
  return !!payload && roles.includes(payload.role);
}

// 무인증 GET 응답에서 제거할 고객 민감 필드 (전화번호·매출액·잔금)
export const SENSITIVE_ORDER_FIELDS = ['phone', 'sale_amount', 'balance'];

export function stripSensitiveOrderFields(order) {
  if (!order) return order;
  const copy = { ...order };
  for (const field of SENSITIVE_ORDER_FIELDS) delete copy[field];
  return copy;
}
