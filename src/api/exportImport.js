const BASE_URL = '/api';

/**
 * CSV 내보내기 - 파일 다운로드
 * @param {Object} params - { status, salesPerson }
 */
export async function downloadCsv(params = {}) {
  const query = new URLSearchParams();

  if (params.status && params.status !== 'all') {
    query.set('status', params.status);
  }
  if (params.salesPerson && params.salesPerson !== 'all') {
    query.set('salesPerson', params.salesPerson);
  }

  const queryStr = query.toString();
  const url = `${BASE_URL}/export/csv${queryStr ? '?' + queryStr : ''}`;

  let response;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    response = await fetch(url, { signal: controller.signal });
    clearTimeout(timeoutId);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('CSV 다운로드 시간이 초과되었습니다.');
    }
    throw new Error('서버에 연결할 수 없습니다. 네트워크를 확인해주세요.');
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `CSV 다운로드 실패 (${response.status})`);
  }

  const blob = await response.blob();
  const disposition = response.headers.get('Content-Disposition');
  let filename = 'orders.csv';
  if (disposition) {
    const match = disposition.match(/filename="?([^"]+)"?/);
    if (match) filename = match[1];
  }

  const link = document.createElement('a');
  const objectUrl = URL.createObjectURL(blob);
  link.href = objectUrl;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
}

/**
 * CSV 가져오기 - 파일 업로드
 * @param {File} file - CSV 파일
 * @returns {Promise<Object>} - { imported: N, errors: [] }
 */
export async function uploadCsv(file) {
  if (!file) {
    throw new Error('업로드할 파일을 선택해주세요.');
  }

  const formData = new FormData();
  formData.append('file', file);

  let response;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30000);
    response = await fetch(`${BASE_URL}/import/csv`, {
      method: 'POST',
      body: formData,
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error('CSV 업로드 시간이 초과되었습니다.');
    }
    throw new Error('서버에 연결할 수 없습니다. 네트워크를 확인해주세요.');
  }

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `CSV 업로드 실패 (${response.status})`);
  }

  return response.json();
}
