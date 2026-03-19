import request from './client';

export function reportIssue(data) {
  return request('/issues', { method: 'POST', body: data });
}
