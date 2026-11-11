import request from './client';

const FILTER_KEYS = [
  'status', 'type', 'to4', 'from', 'message_id', 'group_id', 'template_id',
  'group_status', 'min_total', 'min_sent',
];

// 읽기 전용 GET. 값이 비었거나 'all' 이면 붙이지 않는다.
export function fetchSolapiMessages({
  date = '',
  audience = 'all',
  view = 'groups',
  page = 1,
  page_size: pageSize = 50,
  ...filters
} = {}) {
  const params = new URLSearchParams();
  if (date) params.set('date', date);
  params.set('view', view);
  if (audience && audience !== 'all') params.set('audience', audience);
  params.set('page', String(page));
  params.set('page_size', String(pageSize));
  for (const key of FILTER_KEYS) {
    const value = filters[key];
    if (value === undefined || value === null) continue;
    const text = String(value).trim();
    if (!text || text === 'all') continue;
    params.set(key, text);
  }
  return request(`/solapi-messages?${params.toString()}`, { cache: 'no-store' });
}
