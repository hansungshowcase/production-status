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

export function cors(handler) {
  return async (req, res) => {
    const allowed = getAllowedOrigins();
    const origin = req.headers.origin || '';
    // 동일 origin 호출(origin 헤더 없음)은 허용, 외부 도메인은 화이트리스트만
    // Vercel preview 도메인(*.vercel.app)은 자동 허용
    const isVercelPreview = /^https:\/\/.+\.vercel\.app$/.test(origin);
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
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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
      const message = status === 500 ? '서버 내부 오류가 발생했습니다.' : (err.message || '요청 처리 중 오류가 발생했습니다.');
      if (!res.headersSent) {
        return res.status(status).json({ error: { message, status } });
      }
    }
  };
}
