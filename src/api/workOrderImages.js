import { clearToken, getToken } from '../utils/authClient';

const FALLBACK_TARGET_BYTES = 1450 * 1024;

function authHeaders() {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

async function canvasToFile(canvas, name, quality) {
  return new Promise((resolve) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          resolve(null);
          return;
        }
        resolve(new File([blob], `${name}.jpg`, { type: 'image/jpeg' }));
      },
      'image/jpeg',
      quality
    );
  });
}

export async function prepareWorkOrderImage(file, maxWidth = 2000) {
  if (!file || typeof Image === 'undefined') return file;
  if (file.size <= FALLBACK_TARGET_BYTES && /^image\/jpe?g$/i.test(file.type || '')) return file;

  return new Promise((resolve) => {
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = async () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxWidth / img.width);
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(img.width * scale));
      canvas.height = Math.max(1, Math.round(img.height * scale));
      const ctx = canvas.getContext('2d');
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      const name = file.name.replace(/\.[^.]+$/, '') || 'work-order';
      const attempts = [
        { width: canvas.width, quality: 0.9 },
        { width: 1800, quality: 0.84 },
        { width: 1600, quality: 0.78 },
        { width: 1400, quality: 0.72 },
        { width: 1200, quality: 0.68 },
      ];
      let lastCompressed = null;

      for (const attempt of attempts) {
        if (attempt.width < canvas.width) {
          const ratio = attempt.width / canvas.width;
          const nextCanvas = document.createElement('canvas');
          nextCanvas.width = Math.max(1, Math.round(canvas.width * ratio));
          nextCanvas.height = Math.max(1, Math.round(canvas.height * ratio));
          nextCanvas.getContext('2d').drawImage(canvas, 0, 0, nextCanvas.width, nextCanvas.height);
          const compressed = await canvasToFile(nextCanvas, name, attempt.quality);
          if (compressed) lastCompressed = compressed;
          if (compressed && compressed.size <= FALLBACK_TARGET_BYTES) {
            resolve(compressed);
            return;
          }
          if (attempt === attempts[attempts.length - 1] && compressed) {
            resolve(compressed);
            return;
          }
          continue;
        }

        const compressed = await canvasToFile(canvas, name, attempt.quality);
        if (compressed) lastCompressed = compressed;
        if (compressed && compressed.size <= FALLBACK_TARGET_BYTES) {
          resolve(compressed);
          return;
        }
      }

      resolve(lastCompressed || file);
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
    headers: authHeaders(),
    body: formData,
    signal: controller.signal,
  }).then(async (response) => {
    clearTimeout(timeout);
    if (!response.ok) {
      if (response.status === 401) clearToken();
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
    headers: authHeaders(),
    body: formData,
    signal: controller.signal,
  }).then(async (response) => {
    clearTimeout(timeout);
    if (!response.ok) {
      if (response.status === 401) clearToken();
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

export async function getWorkOrderImage(orderId) {
  if (!orderId) throw new Error('二쇰Ц ID媛 ?꾩슂?⑸땲??');

  const response = await fetch(`/api/orders/${orderId}/work-order-image`, { headers: authHeaders() });
  if (!response.ok) {
    if (response.status === 401) clearToken();
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData?.error?.message || '?묒뾽吏?쒖꽌瑜?遺덈윭?????놁뒿?덈떎.');
  }
  return response.json();
}
