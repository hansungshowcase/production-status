import request from './client';

export function getIssues() {
  return request('/issues');
}

export function reportIssue(data) {
  return request('/issues', { method: 'POST', body: data });
}

export function resolveIssue(id, actor) {
  return request(`/issues/${id}/resolve`, { method: 'PATCH', body: { actor } });
}
