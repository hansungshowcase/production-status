import request from './client';

export function fetchSolapiMessages({
  date = '',
  audience = 'all',
  status = 'all',
  type = 'all',
  view = 'messages',
  page = 1,
} = {}) {
  const params = new URLSearchParams();
  if (date) params.set('date', date);
  params.set('audience', audience);
  params.set('status', status);
  params.set('type', type);
  params.set('view', view);
  params.set('page', String(page));
  return request(`/solapi-messages?${params.toString()}`, { cache: 'no-store' });
}
