import { put } from '@vercel/blob';
import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { parseMultipart, getFilePart } from '../../_lib/parseBody.js';
import { ensureOrderImageColumn } from '../../_lib/ensureSchema.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';

export const config = {
  api: {
    bodyParser: false,
  },
};

export default cors(async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  if (!rateLimitCheck(req, res)) return;

  const { id } = req.query;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }

  let parts;
  try {
    parts = await parseMultipart(req);
  } catch (err) {
    return res.status(400).json({ error: { message: 'multipart/form-data 형식으로 전송해주세요.', status: 400 } });
  }

  const filePart = getFilePart(parts, 'image');
  if (!filePart) {
    return res.status(400).json({ error: { message: '작업지시서 이미지를 첨부해주세요.', status: 400 } });
  }

  const allowed = /\.(jpg|jpeg|png|gif|webp)$/i;
  if (!allowed.test(filePart.filename || '')) {
    return res.status(400).json({ error: { message: '이미지 파일만 업로드 가능합니다. (jpg, png, gif, webp)', status: 400 } });
  }

  if (filePart.data.length > 10 * 1024 * 1024) {
    return res.status(400).json({ error: { message: '파일 크기는 10MB 이하여야 합니다.', status: 400 } });
  }

  const db = getDb();
  await ensureOrderImageColumn(db);

  const orderResult = await db.execute({ sql: 'SELECT id, client_name FROM orders WHERE id = ?', args: [id] });
  const order = orderResult.rows[0];
  if (!order) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }

  const ext = filePart.filename.substring(filePart.filename.lastIndexOf('.')) || '.jpg';
  const uniqueSuffix = `${id}-${Date.now()}-${Math.round(Math.random() * 1E9)}`;
  const blob = await put(`work-order-${uniqueSuffix}${ext}`, filePart.data, { access: 'public' });

  await db.execute({
    sql: 'UPDATE orders SET work_order_image_url = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?',
    args: [blob.url, id],
  });

  await db.execute({
    sql: `INSERT INTO activity_feed (order_id, action_type, description, actor) VALUES (?, ?, ?, ?)`,
    args: [id, '작업지시서첨부', `${order.client_name || ''} 작업지시서 이미지가 첨부되었습니다.`, '현장작업자'],
  });

  return res.status(201).json({ url: blob.url });
});
