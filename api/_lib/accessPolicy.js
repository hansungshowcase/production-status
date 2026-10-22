import { requireAuth } from './auth.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);
const AUTH_PATHS = new Set(['/api/auth/status', '/api/auth/sales', '/api/auth/admin', '/api/auth/worker', '/api/auth/logout']);

function pathname(req) { return String(req.url || '').split(/[?#]/, 1)[0].replace(/\/$/, '') || '/'; }

function exactSameOrigin(req) {
  const origin = String(req.headers?.origin || '');
  const host = String(req.headers?.['x-forwarded-host'] || req.headers?.host || '').split(',')[0].trim();
  const forwardedProtocol = String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim();
  if (!origin || !host) return false;
  try {
    const parsed = new URL(origin);
    return parsed.host === host && (!forwardedProtocol || parsed.protocol === `${forwardedProtocol}:`);
  } catch {
    return false;
  }
}

function reject(res, status, message) {
  for (const name of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) res.setHeader(name, 'no-store');
  res.status(status).json({ error: { message, status } });
  return false;
}

export function enforceSameOriginWrite(req, res) {
  if (SAFE_METHODS.has(req.method) || req.authSource === 'bearer' || exactSameOrigin(req)) return true;
  const verifiedWithoutOrigin = !req.headers?.origin
    && req.headers?.['sec-fetch-site'] === 'same-origin'
    && req.headers?.['x-requested-with'] === 'production-status';
  return verifiedWithoutOrigin || reject(res, 403, '요청 출처를 확인할 수 없습니다.');
}

function routeRoles(path, method) {
  if (path === '/api/admin/mojibake-scan' || path === '/api/import/csv' || path === '/api/export/csv' || path === '/api/sync/trigger') return ['admin'];
  if (path === '/api/admin/risk') return ['sales', 'admin'];
  if (/^\/api\/orders\/[^/]+$/.test(path) && ['PATCH', 'PUT', 'DELETE'].includes(method)) return ['sales'];
  if (/^\/api\/orders\/[^/]+\/(ship|track-link)$/.test(path)) return ['sales'];
  if (/^\/api\/photos\/[^/]+$/.test(path) && method === 'DELETE') return ['sales', 'admin'];
  if (/^\/api\/workers\/[^/]+$/.test(path) && method !== 'GET') return ['admin'];
  if (path === '/api/workers' && method !== 'GET') return ['admin'];
  return ['sales', 'admin', 'worker'];
}

export async function enforceAccessPolicy(req, res) {
  const path = pathname(req);
  if (req.method === 'OPTIONS') return true;
  if (path === '/api/cron/test-send' || path === '/api/cron/demo-notify') return reject(res, 404, '찾을 수 없습니다.');
  if (path.startsWith('/api/cron/')) return true;
  if ((path === '/api/health' && ['GET', 'HEAD'].includes(req.method)) || (path.startsWith('/api/track/') && req.method === 'GET')) return true;
  if (AUTH_PATHS.has(path)) {
    for (const name of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) res.setHeader(name, 'no-store');
    return SAFE_METHODS.has(req.method) || enforceSameOriginWrite(req, res);
  }
  const auth = await requireAuth(req, res, { roles: routeRoles(path, req.method) });
  if (!auth) return false;
  for (const name of ['Cache-Control', 'CDN-Cache-Control', 'Vercel-CDN-Cache-Control']) res.setHeader(name, 'no-store');
  return enforceSameOriginWrite(req, res);
}
