// 문자 관리 콘솔 API. 공용 client(request)는 401 이면 로그인 토큰을 지우므로 여기서는 fetch 를 직접 쓴다.
// 등록·삭제에 비밀번호는 없다(2026-11-11 사장님 결정). POST 는 다시 보내지 않는다.

const RESOURCES = new Set(['overview', 'templates', 'usage', 'categories', 'scope', 'sent', 'send', 'text_templates', 'text_template']);
const TIMEOUT_MS = 20000;

async function call(url, init) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    let response;
    try {
      response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', ...init, signal: controller.signal });
    } catch (err) {
      const error = new Error(err?.name === 'AbortError' ? '요청 시간이 초과되었습니다.' : '서버에 연결할 수 없습니다. 네트워크를 확인해주세요.');
      error.status = 0;
      throw error;
    }
    const raw = await response.text();
    let data = null;
    try { data = raw ? JSON.parse(raw) : null; } catch { data = null; }
    if (!response.ok) {
      const error = new Error(data?.error?.message || `요청 실패 (${response.status})`);
      error.status = response.status;
      error.data = data;
      throw error;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// GET /api/sms-console?resource=… → JSON. 실패하면 Error(message) + err.status
export function fetchSmsConsole(resource, params = {}) {
  if (!RESOURCES.has(resource)) return Promise.reject(Object.assign(new Error('알 수 없는 조회입니다.'), { status: 400 }));
  const query = new URLSearchParams({ resource });
  for (const [key, value] of Object.entries(params || {})) {
    if (value === undefined || value === null || value === '') continue;
    query.set(key, String(value));
  }
  return call(`/api/sms-console?${query.toString()}`, { method: 'GET' });
}

// POST /api/sms-console {action, ...body} → JSON. 실패하면 Error(message) + err.status
export function postSmsConsole(action, body = {}) {
  return call('/api/sms-console', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...(body || {}), action }),
  });
}
