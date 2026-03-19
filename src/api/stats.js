import request from './client';

export function getStats() {
  return request('/stats');
}
