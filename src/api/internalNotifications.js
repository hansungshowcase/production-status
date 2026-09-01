import request from './client';

export function fetchInternalNotifications({
  recipient = '',
  date = '',
  page = 1,
  limit = 10,
} = {}) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  params.set('limit', String(limit));
  if (recipient) params.set('recipient', recipient);
  if (date) params.set('date', date);
  return request(`/internal-notifications?${params.toString()}`, { cache: 'no-store' });
}
