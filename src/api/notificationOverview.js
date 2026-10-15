import request from './client';

export function fetchNotificationOverview() {
  return request('/notification-overview', { cache: 'no-store' });
}
