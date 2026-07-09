// 허용 origin — 환경 변수로 추가 가능 (`ALLOWED_ORIGINS=https://a.com,https://b.com`)
const DEFAULT_ALLOWED = [
  'https://production-status.vercel.app',
  'http://localhost:5173',
  'http://localhost:3000',
];

function getAllowedOrigins() {
  const env = process.env.ALLOWED_ORIGINS;
  const fromEnv = env ? env.split(',').map(s => s.trim()).filter(Boolean) : [];
  return [...new Set([...DEFAULT_ALLOWED, ...fromEnv])];
}

// API별 CDN edge cache 정책 — Vercel edge cache + stale-while-revalidate
// 같은 GET 요청 반복 시 CDN에서 즉시 응답 (≈0ms), 백그라운드 갱신 후 다음 요청부터 최신
const CACHE_POLICIES = {
  // 목록류 — 짧은 fresh + 긴 stale window (UX 응답성 최고)
  '/api/orders': 'no-store',
  '/api/stats': 'no-store',
  '/api/delivery-adherence': 'public, s-maxage=43200, stale-while-revalidate=3600',
  '/api/feed': 'public, s-maxage=30, stale-while-revalidate=120',
  '/api/processes/by-step': 'no-store',
  '/api/workers': 'public, s-maxage=30, stale-while-revalidate=300',
  '/api/health': 'public, s-maxage=60',
  '/api/export/csv': 'public, s-maxage=10, stale-while-revalidate=60',
  // 폴링 (real-time) — 캐시 금지
  '/api/events': 'no-store',
  // 상세는 디폴트(짧게)
};

function pickCachePolicy(url) {
  if (!url) return null;
  // pathname만 사용 (?query 제외)
  const path = url.split('?')[0];
  // 정확 매칭 우선
  if (CACHE_POLICIES[path]) return CACHE_POLICIES[path];
  // prefix 매칭 (by-step/[stepName] 등)
  for (const key of Object.keys(CACHE_POLICIES)) {
    if (path.startsWith(key + '/')) return CACHE_POLICIES[key];
  }
  // 상세(/api/orders/123) 같은 동적 경로 — 더 짧게
  if (path.startsWith('/api/orders/')) return 'no-store';
  if (path.startsWith('/api/pre-production/')) return 'public, s-maxage=2, stale-while-revalidate=10';
  if (path.startsWith('/api/issues')) return 'public, s-maxage=3, stale-while-revalidate=15';
  if (path.startsWith('/api/photos')) return 'no-store';
  return null;
}

export function cors(handler) {
  return async (req, res) => {
    const allowed = getAllowedOrigins();
    const origin = req.headers.origin || '';
    // 동일 origin 호출(origin 헤더 없음)은 허용, 외부 도메인은 화이트리스트만
    // 본 프로젝트의 Vercel preview만 허용 — `production-status-...vercel.app` 패턴
    // (와일드카드 *.vercel.app은 공격자가 evil.vercel.app 배포해 우회 가능)
    const isVercelPreview = /^https:\/\/production-status(-[\w-]+)?\.vercel\.app$/.test(origin);
    if (allowed.includes(origin) || isVercelPreview) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Vary', 'Origin');
    } else if (origin === '') {
      // same-origin 또는 서버-서버 호출 — origin 헤더 없음
      // 별도 헤더 안 보냄 (브라우저는 same-origin이라 OK)
    } else {
      // 외부 도메인 — CORS 차단
      res.setHeader('Access-Control-Allow-Origin', allowed[0]);
      res.setHeader('Vary', 'Origin');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // GET 응답에 CDN edge cache 헤더 자동 추가 (성능 10배: 동일 요청 반복 시 ≈0ms)
    if (req.method === 'GET') {
      const path = (req.url || '').split('?')[0];
      const policy = pickCachePolicy(req.url);
      if (policy) {
        if (path === '/api/delivery-adherence') {
          res.setHeader('Cache-Control', 'no-store');
          res.setHeader('Clear-Site-Data', '"cache"');
        } else {
          res.setHeader('Cache-Control', policy);
        }
        res.setHeader('CDN-Cache-Control', policy);
        res.setHeader('Vercel-CDN-Cache-Control', policy);
      }
    } else {
      // 변경 메서드 — 캐시 절대 금지 (변경 후 GET이 stale 응답하는 사고 방지)
      res.setHeader('Cache-Control', 'no-store');
    }

    if (req.method === 'OPTIONS') {
      return res.status(200).end();
    }

    // Ensure req.body is always an object (defend against null/undefined body)
    if (!req.body || typeof req.body !== 'object' || Array.isArray(req.body)) {
      req.body = {};
    }

    try {
      return await handler(req, res);
    } catch (err) {
      console.error(`[API Error] ${req.method} ${req.url}:`, err);
      const status = err.status || 500;
      const message = err.publicMessage || (status === 500 ? '서버 내부 오류가 발생했습니다.' : (err.message || '요청 처리 중 오류가 발생했습니다.'));
      if (!res.headersSent) {
        // 에러는 캐시 안 함
        res.setHeader('Cache-Control', 'no-store');
        return res.status(status).json({ error: { message, status } });
      }
    }
  };
}
