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

// 고객 조회링크 발급/조회 — 토큰은 공개 목록 응답에 싣지 않고 이 엔드포인트로만 받는다 (인증 활성 시 sales 전용)
export function getTrackLink(id) {
  if (!id) throw new Error('주문 ID가 필요합니다');
  return request(`/orders/${id}/track-link`, { method: 'POST' });
}

export function deleteOrder(id, actor, options = {}) {
  if (!id) throw new Error('주문 ID가 필요합니다');
  if (!actor) throw new Error('삭제 담당자(actor)가 필요합니다');
  return request(`/orders/${id}`, { method: 'DELETE', body: { actor, ...options } });
}

export function shipOrder(id, actor) {
  if (!id) throw new Error('주문 ID가 필요합니다');
  return request(`/orders/${id}/ship`, { method: 'PATCH', body: { actor: actor || '시스템' } });
}

export function shipOrderFromWorker(id, actor) {
  if (!id) throw new Error('주문 ID가 필요합니다');
  const worker = String(actor || '').trim();
  if (!worker) throw new Error('작업자 정보가 필요합니다');
  return request(`/orders/${id}/worker-ship`, { method: 'PATCH', body: { actor: worker } });
}
