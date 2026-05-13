import { put } from '@vercel/blob';

const FALLBACK_MAX_BYTES = 1536 * 1024;

function guessMimeType(filePart) {
  if (filePart.contentType && filePart.contentType.startsWith('image/')) {
    return filePart.contentType.split(';')[0];
  }
  const ext = (filePart.filename || '').split('.').pop()?.toLowerCase();
  const extMap = {
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    png: 'image/png',
    gif: 'image/gif',
    webp: 'image/webp',
    heic: 'image/heic',
    heif: 'image/heif',
  };
  return extMap[ext] || 'image/jpeg';
}

export async function storeImageFile(filePart, filename) {
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(filename, filePart.data, { access: 'public' });
    return { url: blob.url, rollbackUrl: blob.url };
  }

  if (filePart.data.length > FALLBACK_MAX_BYTES) {
    const err = new Error('파일 저장소 설정이 없어 1.5MB 이하의 작업지시서만 임시 저장할 수 있습니다.');
    err.status = 413;
    throw err;
  }

  const mimeType = guessMimeType(filePart);
  return {
    url: `data:${mimeType};base64,${filePart.data.toString('base64')}`,
    rollbackUrl: null,
  };
}
