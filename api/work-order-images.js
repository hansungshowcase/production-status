import { cors } from './_lib/cors.js';
import { parseMultipart, getFilePart } from './_lib/parseBody.js';
import { storeImageFile } from './_lib/storeImage.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default cors(async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > 10 * 1024 * 1024) {
    return res.status(413).json({ error: { message: '파일 크기는 10MB 이하여야 합니다.', status: 413 } });
  }

  let parts;
  try {
    parts = await parseMultipart(req);
  } catch (err) {
    const status = err.status || 400;
    return res.status(status).json({ error: { message: status === 413 ? '파일 크기는 10MB 이하여야 합니다.' : 'multipart/form-data 형식으로 전송해주세요.', status } });
  }

  const filePart = getFilePart(parts, 'image');
  if (!filePart) {
    return res.status(400).json({ error: { message: '작업지시서 이미지를 업로드해주세요.', status: 400 } });
  }

  const allowed = /\.(jpg|jpeg|png|gif|webp|heic|heif)$/i;
  if (!allowed.test(filePart.filename || '')) {
    return res.status(400).json({ error: { message: '이미지 파일만 업로드 가능합니다. (jpg, png, gif, webp, heic)', status: 400 } });
  }

  if (filePart.data.length > 10 * 1024 * 1024) {
    return res.status(400).json({ error: { message: '파일 크기는 10MB 이하여야 합니다.', status: 400 } });
  }

  const extMatch = (filePart.filename || '').match(/\.[^.]+$/);
  const ext = extMatch ? extMatch[0].toLowerCase() : '.jpg';
  const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
  let storedImage;
  try {
    storedImage = await storeImageFile(filePart, `work-order-${uniqueSuffix}${ext}`);
  } catch (err) {
    console.warn('[work-order-images] image upload failed:', err?.message || err);
    const status = err.status || 502;
    return res.status(status).json({ error: { message: err.message || '파일 저장에 실패했습니다. 잠시 후 다시 시도해주세요.', status } });
  }

  return res.status(201).json({ url: storedImage.url });
});
