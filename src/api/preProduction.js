import request from './client';

export function getPreProduction(orderId) {
  return request(`/pre-production/${orderId}`);
}

export function updatePreProduction(orderId, data) {
  return request(`/pre-production/${orderId}`, { method: 'PATCH', body: data });
}
