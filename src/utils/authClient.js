// 인증 클라이언트 헬퍼.
// 환경변수 미설정(opt-in 비활성) 시 토큰 없이도 동작. 활성 시 비번 로그인 후 Bearer 토큰 자동 첨부.
import { safeGet, safeSet, safeRemove } from './safeStorage';

const TOKEN_KEY = 'auth_token';
const ROLE_KEY = 'auth_role';
const ACTOR_KEY = 'auth_actor';
const EXP_KEY = 'auth_exp';

let cachedEnabled = null; // null = 미조회, true/false = 결과
let statusPromise = null;

export function getToken() {
  const t = safeGet(TOKEN_KEY);
  const exp = Number(safeGet(EXP_KEY) || 0);
  if (!t) return null;
  if (exp && exp < Math.floor(Date.now() / 1000)) {
    clearToken();
    return null;
  }
  return t;
}

export function getRole() { return safeGet(ROLE_KEY); }
export function getActor() { return safeGet(ACTOR_KEY); }

export function setToken({ token, role, actor, exp }) {
  if (!token) return;
  safeSet(TOKEN_KEY, token);
  if (role) safeSet(ROLE_KEY, role);
  if (actor) safeSet(ACTOR_KEY, actor);
  if (exp) safeSet(EXP_KEY, String(exp));
}

export function clearToken() {
  safeRemove(TOKEN_KEY);
  safeRemove(ROLE_KEY);
  safeRemove(ACTOR_KEY);
  safeRemove(EXP_KEY);
}

// 서버에 인증 활성 여부 + 현재 토큰 유효성 조회 (1회 캐시)
export async function fetchAuthStatus() {
  if (statusPromise) return statusPromise;
  statusPromise = (async () => {
    try {
      const t = getToken();
      const res = await fetch('/api/auth/status', {
        headers: t ? { Authorization: `Bearer ${t}` } : {},
      });
      if (!res.ok) return { enabled: false, authenticated: false };
      const data = await res.json();
      cachedEnabled = !!data.enabled;
      return data;
    } catch {
      return { enabled: false, authenticated: false };
    }
  })();
  return statusPromise;
}

export function isAuthEnabled() {
  return cachedEnabled === true;
}

// 로그인. role: 'sales' | 'admin'. body: { password, actor? }
export async function login(role, { password, actor }) {
  const endpoint = role === 'admin' ? '/api/auth/admin' : '/api/auth/sales';
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password, actor }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || '로그인 실패');
    err.status = res.status;
    throw err;
  }
  if (data.enabled === false) {
    // 서버에 인증 미설정 — 토큰 발급 안 함. 클라이언트는 그대로 진입 가능.
    cachedEnabled = false;
    return { enabled: false };
  }
  if (data.token) {
    // payload에서 exp 추출 (base64url 디코드)
    let exp = null;
    try {
      const body = data.token.split('.')[0];
      const pad = body.length % 4 === 2 ? '==' : body.length % 4 === 3 ? '=' : '';
      const json = JSON.parse(atob(body.replace(/-/g, '+').replace(/_/g, '/') + pad));
      exp = json.exp;
    } catch { /* ignore */ }
    setToken({ token: data.token, role: data.role, actor: data.actor, exp });
    cachedEnabled = true;
  }
  return data;
}

export function logout() {
  clearToken();
}
