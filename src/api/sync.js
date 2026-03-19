import request from './client';

export function getSyncStatus() {
  return request('/sync/status');
}

export function triggerSync() {
  return request('/sync/trigger', { method: 'POST' });
}
