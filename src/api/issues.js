import request from './client';

export function getIssues() {
  return request('/issues');
}

export function reportIssue(data) {
  if (!data || !data.order_id) throw new Error('주문 ID(order_id)가 필요합니다');
  if (!data.issue_type) throw new Error('이슈 유형(issue_type)이 필요합니다');
  if (!data.reported_by) throw new Error('보고자(reported_by)가 필요합니다');
  return request('/issues', { method: 'POST', body: data });
}

export function resolveIssue(id, actor) {
  if (!id) throw new Error('이슈 ID가 필요합니다');
  return request(`/issues/${id}/resolve`, { method: 'PATCH', body: { actor: actor || '시스템' } });
}
