// 인증 클라이언트 헬퍼.
// 환경변수 미설정(opt-in 비활성) 시 토큰 없이도 동작. 활성 시 비번 로그인 후 Bearer 토큰 자동 첨부.
import { safeGet, safeSet, safeRemove } from './safeStorage.js';

const TOKEN_KEY = 'auth_token';
const ROLE_KEY = 'auth_role';
const ACTOR_KEY = 'auth_actor';
const EXP_KEY = 'auth_exp';

let cachedEnabled = null; // null = 미조회, true/false = 결과
let statusPromise = null;

export function invalidateAuthStatus() {
  statusPromise = null;
  cachedEnabled = null;
}

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
  invalidateAuthStatus();
}

export function authHeaders({ write = false } = {}) {
  const token = getToken();
  return {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(write ? { 'X-Requested-With': 'production-status' } : {}),
  };
}

// 서버에 인증 활성 여부 + 현재 토큰 유효성 조회 (1회 캐시)
export async function fetchAuthStatus() {
  if (statusPromise) return statusPromise;
  statusPromise = (async () => {
    const res = await fetch('/api/auth/status', {
      credentials: 'same-origin',
      headers: authHeaders(),
    });
    if (!res.ok) {
      throw new Error(`인증 상태를 확인할 수 없습니다. (${res.status})`);
    }
    let data;
    try {
      data = await res.json();
    } catch {
      throw new Error('인증 상태 응답을 확인할 수 없습니다.');
    }
    if (!data || typeof data.enabled !== 'boolean') {
      throw new Error('인증 상태 응답을 확인할 수 없습니다.');
    }
    if (!data.authenticated) clearToken();
    cachedEnabled = data.enabled;
    return data;
  })().catch((err) => {
    statusPromise = null;
    throw err;
  });
  return statusPromise;
}

export function isAuthEnabled() {
  return cachedEnabled === true;
}

// 로그인. role: 'sales' | 'admin'. body: { password, actor? }
export async function login(role, { password, actor }) {
  const endpoint = role === 'admin' ? '/api/auth/admin' : role === 'worker' ? '/api/auth/worker' : '/api/auth/sales';
  const res = await fetch(endpoint, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'production-status' },
    body: JSON.stringify({ password, actor }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(data?.error?.message || '로그인 실패');
    err.status = res.status;
    throw err;
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
    statusPromise = null;
  }
  return data;
}

export async function logout() {
  try {
    await fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'same-origin',
      headers: authHeaders({ write: true }),
    });
  } finally {
    clearToken();
  }
}
