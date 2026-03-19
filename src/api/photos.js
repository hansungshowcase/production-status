import request from './client';

export function uploadPhoto(data) {
  return request('/photos', { method: 'POST', body: data });
}
