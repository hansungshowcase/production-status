import request from './client';

export function fetchInternalNotifications({
  recipient = '',
  date = '',
  limit = 100,
} = {}) {
  const params = new URLSearchParams();
  params.set('limit', String(limit));
  if (recipient) params.set('recipient', recipient);
  if (date) params.set('date', date);
  return request(`/internal-notifications?${params.toString()}`, { cache: 'no-store' });
}
