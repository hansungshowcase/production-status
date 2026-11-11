import request from './client';

export function fetchInternalNotifications({
  recipient = '',
  date = '',
  page = 1,
  limit = 10,
  view = '',
} = {}) {
  const params = new URLSearchParams();
  // view=day: 그날 기록 전체(먼저 보낸 것부터) + 등록 직원 목록. 쪽 번호는 쓰지 않는다.
  if (view === 'day') {
    params.set('view', 'day');
    params.set('date', date);
    return request(`/internal-notifications?${params.toString()}`, { cache: 'no-store' });
  }
  params.set('page', String(page));
  params.set('limit', String(limit));
  if (recipient) params.set('recipient', recipient);
  if (date) params.set('date', date);
  return request(`/internal-notifications?${params.toString()}`, { cache: 'no-store' });
}
