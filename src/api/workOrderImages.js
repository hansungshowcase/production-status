async function prepareWorkOrderImage(file, maxWidth = 1600) {
  if (!file || file.size < 1024 * 1024 || typeof Image === 'undefined') return file;

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = img.width > maxWidth ? maxWidth / img.width : 1;
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob(
        (blob) => {
          if (!blob) {
            resolve(file);
            return;
          }
          const name = file.name.replace(/\.[^.]+$/, '') || 'work-order';
          resolve(new File([blob], `${name}.jpg`, { type: 'image/jpeg' }));
        },
        'image/jpeg',
        0.85
      );
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });
}

export async function uploadWorkOrderImage(file) {
  if (!file) throw new Error('작업지시서 이미지가 필요합니다.');

  const preparedFile = await prepareWorkOrderImage(file);
  const formData = new FormData();
  formData.append('image', preparedFile);

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

export async function attachWorkOrderImage(orderId, file) {
  if (!orderId) throw new Error('주문 ID가 필요합니다.');
  if (!file) throw new Error('작업지시서 이미지가 필요합니다.');

  const preparedFile = await prepareWorkOrderImage(file);
  const formData = new FormData();
  formData.append('image', preparedFile);

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
