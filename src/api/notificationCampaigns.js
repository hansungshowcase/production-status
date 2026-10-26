import request from './client';

export function fetchNotificationCampaigns(audience) {
  const params = new URLSearchParams({ audience });
  return request(`/notification-campaigns?${params.toString()}`, { cache: 'no-store' });
}

export function createNotificationCampaign(payload) {
  return request('/notification-campaigns', { method: 'POST', body: payload });
}

export function updateNotificationCampaign(id, payload) {
  const params = new URLSearchParams({ id });
  return request(`/notification-campaigns?${params.toString()}`, { method: 'PUT', body: payload });
}
