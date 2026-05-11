import request from './client';

export function getWorkers(department) {
  const query = department ? `?department=${encodeURIComponent(department)}` : '';
  return request(`/workers${query}`);
}

export function getDepartments() {
  return request('/workers/departments');
}

export function createWorker(data) {
  if (!data || !data.name) throw new Error('작업자 이름은 필수입니다');
  if (!data.department) throw new Error('부서는 필수입니다');
  return request('/workers', { method: 'POST', body: data });
}

export function deleteWorker(id) {
  if (!id) throw new Error('작업자 ID가 필요합니다');
  return request(`/workers/${id}`, { method: 'DELETE' });
}
