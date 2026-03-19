import request from './client';

export function getWorkers(department) {
  const query = department ? `?department=${encodeURIComponent(department)}` : '';
  return request(`/workers${query}`);
}

export function getDepartments() {
  return request('/workers/departments');
}
