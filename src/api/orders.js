import request from './client';

export function getOrders(params = {}) {
  const query = new URLSearchParams(params).toString();
  const endpoint = query ? `/orders?${query}` : '/orders';
  return request(endpoint);
}

export function getOrder(id) {
  if (!id) throw new Error('주문 ID가 필요합니다');
  return request(`/orders/${id}`);
}

export function createOrder(data) {
  if (!data || !data.client_name) throw new Error('거래처명(client_name)은 필수입니다');
  return request('/orders', { method: 'POST', body: data });
}

export function updateOrder(id, data) {
  if (!id) throw new Error('주문 ID가 필요합니다');
  return request(`/orders/${id}`, { method: 'PATCH', body: data });
}

export function deleteOrder(id, actor) {
  if (!id) throw new Error('주문 ID가 필요합니다');
  if (!actor) throw new Error('삭제 담당자(actor)가 필요합니다');
  return request(`/orders/${id}`, { method: 'DELETE', body: { actor } });
}

export function shipOrder(id, actor) {
  if (!id) throw new Error('주문 ID가 필요합니다');
  return request(`/orders/${id}/ship`, { method: 'PATCH', body: { actor: actor || '시스템' } });
}
