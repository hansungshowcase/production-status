import request from './client';

export function updatePreProduction(orderId, data) {
  return request(`/pre-production/${orderId}`, { method: 'PATCH', body: data });
}
