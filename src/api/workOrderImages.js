export function uploadWorkOrderImage(file) {
  if (!file) throw new Error('작업지시서 이미지가 필요합니다.');

  const formData = new FormData();
  formData.append('image', file);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  return fetch('/api/work-order-images', {
    method: 'POST',
    body: formData,
    signal: controller.signal,
  }).then(async (response) => {
    clearTimeout(timeout);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData?.error?.message || `작업지시서 업로드 실패 (${response.status})`);
    }
    return response.json();
  }).catch((err) => {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('작업지시서 업로드 시간이 초과되었습니다.');
    }
    throw err;
  });
}

export function attachWorkOrderImage(orderId, file) {
  if (!orderId) throw new Error('주문 ID가 필요합니다.');
  if (!file) throw new Error('작업지시서 이미지가 필요합니다.');

  const formData = new FormData();
  formData.append('image', file);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60000);

  return fetch(`/api/orders/${orderId}/work-order-image`, {
    method: 'POST',
    body: formData,
    signal: controller.signal,
  }).then(async (response) => {
    clearTimeout(timeout);
    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData?.error?.message || `작업지시서 첨부 실패 (${response.status})`);
    }
    return response.json();
  }).catch((err) => {
    clearTimeout(timeout);
    if (err.name === 'AbortError') {
      throw new Error('작업지시서 첨부 시간이 초과되었습니다.');
    }
    throw err;
  });
}
