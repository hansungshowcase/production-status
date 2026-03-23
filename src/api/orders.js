import request from './client';

export function getOrders(params = {}) {
  const query = new URLSearchParams(params).toString();
  const endpoint = query ? `/orders?${query}` : '/orders';
  return request(endpoint);
}

export function getOrder(id) {
  return request(`/orders/${id}`);
}

export function createOrder(data) {
  return request('/orders', { method: 'POST', body: data });
}

export function updateOrder(id, data) {
  return request(`/orders/${id}`, { method: 'PUT', body: data });
}

export function deleteOrder(id, actor) {
  return request(`/orders/${id}`, { method: 'DELETE', body: { actor: actor || '시스템' } });
}

export function shipOrder(id) {
  return request(`/orders/${id}/ship`, { method: 'PATCH' });
}
