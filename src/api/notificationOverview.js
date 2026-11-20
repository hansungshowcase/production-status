import request from './client';

const CACHE_TTL_MS = 15000;
let cachedAt = 0;
let cachedValue = null;
let inFlight = null;

export function fetchNotificationOverview({ fresh = false } = {}) {
  if (!fresh && cachedValue && Date.now() - cachedAt < CACHE_TTL_MS) {
    return Promise.resolve(cachedValue);
  }
  if (!fresh && inFlight) return inFlight;
  const reqPromise = request('/notification-overview', { cache: 'no-store' })
    .then((data) => {
      cachedValue = data;
      cachedAt = Date.now();
      return data;
    })
    .finally(() => {
      inFlight = null;
    });
  inFlight = reqPromise;
  return reqPromise;
}
