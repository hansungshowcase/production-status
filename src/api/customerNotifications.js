import request from './client';

export function fetchCustomerNotifications({
  date = '',
  kind = '',
  page = 1,
} = {}) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  if (date) params.set('date', date);
  if (kind) params.set('kind', kind);
  return request(`/customer-notifications?${params.toString()}`, { cache: 'no-store' });
}

export function fetchCustomerReviews({
  campaign = '',
  page = 1,
} = {}) {
  const params = new URLSearchParams();
  params.set('page', String(page));
  if (campaign) params.set('campaign', campaign);
  return request(`/customer-reviews?${params.toString()}`, { cache: 'no-store' });
}
