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

  const response = await fetch(url);

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
  link.href = URL.createObjectURL(blob);
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(link.href);
}

/**
 * CSV 가져오기 - 파일 업로드
 * @param {File} file - CSV 파일
 * @returns {Promise<Object>} - { imported: N, errors: [] }
 */
export async function uploadCsv(file) {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`${BASE_URL}/import/csv`, {
    method: 'POST',
    body: formData,
  });

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(err?.error?.message || `CSV 업로드 실패 (${response.status})`);
  }

  return response.json();
}
