import request from './client';

export function fetchInternalNotifications({ limit = 100 } = {}) {
  return request(`/internal-notifications?audience=all&limit=${limit}`, { cache: 'no-store' });
}
