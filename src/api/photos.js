import request from './client';

export function uploadPhoto(data) {
  return request('/photos', { method: 'POST', body: data });
}

export function deletePhoto(id, actor) {
  if (!id) throw new Error('photo ID가 필요합니다');
  return request(`/photos/${id}`, { method: 'DELETE', body: { actor: actor || '시스템' } });
}
