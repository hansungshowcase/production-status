import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { del, put } from '@vercel/blob';
import { parseMultipart, getFilePart, getFieldValue } from '../_lib/parseBody.js';
import { rateLimitCheck } from '../_lib/rateLimit.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default cors(async function handler(req, res) {
  if (req.method === 'GET') {
    return handleGet(req, res);
  } else if (req.method === 'POST') {
    if (!rateLimitCheck(req, res)) return;
    return handlePost(req, res);
  } else {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
});

async function handleGet(req, res) {
  const db = getDb();
  const { order_id } = req.query;

  if (order_id) {
    const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [order_id] });
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
    }
    const { rows } = await db.execute({
      sql: 'SELECT * FROM photos WHERE order_id = ? ORDER BY uploaded_at DESC',
      args: [order_id],
    });
    return res.json(rows);
  }

  const { rows } = await db.execute({ sql: 'SELECT * FROM photos ORDER BY uploaded_at DESC', args: [] });
  return res.json(rows);
}

async function handlePost(req, res) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return res.status(500).json({ error: { message: '파일 저장소 설정이 누락되었습니다.', status: 500 } });
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

  const filePart = getFilePart(parts, 'photo');
  const order_id = getFieldValue(parts, 'order_id');
  const process_id = getFieldValue(parts, 'process_id');
  const uploaded_by = getFieldValue(parts, 'uploaded_by');

  if (!order_id) {
    return res.status(400).json({ error: { message: 'order_id는 필수 항목입니다.', status: 400 } });
  }

  if (!filePart) {
    return res.status(400).json({ error: { message: '사진 파일은 필수입니다.', status: 400 } });
  }

  // Validate file type
  const allowed = /\.(jpg|jpeg|png|gif|webp)$/i;
  if (!allowed.test(filePart.filename)) {
    return res.status(400).json({ error: { message: '이미지 파일만 업로드 가능합니다. (jpg, png, gif, webp)', status: 400 } });
  }

  // Check file size (10MB)
  if (filePart.data.length > 10 * 1024 * 1024) {
    return res.status(400).json({ error: { message: '파일 크기는 10MB 이하여야 합니다.', status: 400 } });
  }

  const db = getDb();

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [order_id] });
  if (orderResult.rows.length === 0) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }
  const order = orderResult.rows[0];

  if (process_id) {
    const processResult = await db.execute({
      sql: 'SELECT id FROM processes WHERE id = ? AND order_id = ?',
      args: [process_id, order_id],
    });
    if (processResult.rows.length === 0) {
      return res.status(400).json({ error: { message: 'process_id가 해당 주문에 속하지 않습니다.', status: 400 } });
    }
  }

  // Upload to Vercel Blob
  const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
  const extMatch = (filePart.filename || '').match(/\.[^.]+$/);
  const ext = extMatch ? extMatch[0].toLowerCase() : '.jpg';
  const blobFilename = `photo-${uniqueSuffix}${ext}`;
  let blob;
  try {
    blob = await put(blobFilename, filePart.data, { access: 'public' });
  } catch (err) {
    console.warn('[photos] blob upload failed:', err?.message || err);
    return res.status(502).json({ error: { message: '파일 저장에 실패했습니다. 잠시 후 다시 시도해주세요.', status: 502 } });
  }

  let result;
  try {
    result = await db.execute({
      sql: `INSERT INTO photos (order_id, process_id, file_path, uploaded_by)
            VALUES (?, ?, ?, ?) RETURNING id`,
      args: [order_id, process_id || null, blob.url, uploaded_by || null],
    });
  } catch (err) {
    try { await del(blob.url); } catch (deleteErr) { console.warn('[photos] blob rollback failed:', deleteErr?.message || deleteErr); }
    throw err;
  }

  await db.execute({
    sql: `INSERT INTO activity_feed (order_id, action_type, description, actor)
          VALUES (?, ?, ?, ?)`,
    args: [
      order_id,
      '사진등록',
      `${order.client_name} - 사진이 업로드되었습니다.`,
      uploaded_by || '시스템',
    ],
  }).catch((err) => console.warn('[photos] activity log failed:', err?.message || err));

  const photoResult = await db.execute({
    sql: 'SELECT * FROM photos WHERE id = ?',
    args: [Number(result.rows[0].id)],
  });

  return res.status(201).json(photoResult.rows[0]);
}
