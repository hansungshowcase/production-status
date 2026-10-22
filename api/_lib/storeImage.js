import { put } from '@vercel/blob';
import { validateImageFile } from './imageFileValidation.js';

const FALLBACK_MAX_BYTES = 1536 * 1024;

export async function storeImageFile(filePart, filename) {
  if (!process.env.BLOB_READ_WRITE_TOKEN && filePart.data.length > FALLBACK_MAX_BYTES) {
    const err = new Error('파일 저장소 설정이 없어 1.5MB 이하의 작업지시서만 임시 저장할 수 있습니다.');
    err.status = 413;
    throw err;
  }

  const { mimeType } = validateImageFile(filePart);
  if (process.env.BLOB_READ_WRITE_TOKEN) {
    const blob = await put(filename, filePart.data, { access: 'public' });
    return { url: blob.url, rollbackUrl: blob.url };
  }

  return {
    url: `data:${mimeType};base64,${filePart.data.toString('base64')}`,
    rollbackUrl: null,
  };
}
