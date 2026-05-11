// In-memory rate limiter — Vercel serverless 인스턴스마다 독립이지만
// 일반적 부하에선 동일 인스턴스가 재사용되므로 brute-force/spam 1차 방어로 충분.
// key = `${ip}|${route}` 기준, 윈도우 안에 들어온 요청 timestamp 배열 보관.
const buckets = new Map();

function getClientIp(req) {
  const fwd = req.headers['x-forwarded-for'];
  if (typeof fwd === 'string' && fwd.length > 0) {
    const first = fwd.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket?.remoteAddress || 'unknown';
}

// Map 크기 1만 초과 시 오래된 키 정리 (메모리 누수 방지)
function evictIfNeeded(now, windowMs) {
  if (buckets.size <= 10000) return;
  for (const [k, arr] of buckets) {
    // 가장 최근 timestamp가 윈도우 밖이면 제거 (전부 만료된 키)
    const last = arr.length > 0 ? arr[arr.length - 1] : 0;
    if (now - last > windowMs) buckets.delete(k);
    if (buckets.size <= 8000) break;
  }
}

export function rateLimitCheck(req, res, { windowMs = 60000, max = 30 } = {}) {
  const ip = getClientIp(req);
  const route = (req.url || '').split('?')[0] || 'unknown';
  const key = `${ip}|${route}`;
  const now = Date.now();
  const windowStart = now - windowMs;

  let arr = buckets.get(key);
  if (!arr) {
    arr = [];
    buckets.set(key, arr);
  }
  // 윈도우 밖 timestamp 제거
  while (arr.length > 0 && arr[0] < windowStart) arr.shift();

  if (arr.length >= max) {
    res.status(429).json({ error: { message: '요청이 너무 많습니다. 잠시 후 다시 시도하세요.', status: 429 } });
    return false;
  }

  arr.push(now);
  evictIfNeeded(now, windowMs);
  return true;
}
