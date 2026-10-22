import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { del } from '@vercel/blob';
import { parseMultipart, getFilePart, getFieldValue } from '../_lib/parseBody.js';
import { rateLimitCheck } from '../_lib/rateLimit.js';
import { storeImageFile } from '../_lib/storeImage.js';
import { requireAuth } from '../_lib/auth.js';
import { parsePositiveInt4Id } from '../_lib/positiveInt4Id.js';
import { validateImageFile } from '../_lib/imageFileValidation.js';
import { canWorkerAccessDepartment } from '../../shared/workerAccess.js';

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

export async function handleGet(req, res, dependencies = {}) {
  const hasOrderId = Object.prototype.hasOwnProperty.call(req.query, 'order_id');
  const orderId = hasOrderId ? parsePositiveInt4Id(req.query.order_id) : null;
  if (hasOrderId && orderId === null) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }
  const db = dependencies.db || getDb();

  if (orderId !== null) {
    const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
    if (orderResult.rows.length === 0) {
      return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
    }
    const { rows } = await db.execute({
      sql: 'SELECT * FROM photos WHERE order_id = ? ORDER BY uploaded_at DESC',
      args: [orderId],
    });
    return res.json(rows);
  }

  const { rows } = await db.execute({ sql: 'SELECT * FROM photos ORDER BY uploaded_at DESC', args: [] });
  return res.json(rows);
}

export async function handlePost(req, res, dependencies = {}) {
  const injectedAuthorize = dependencies.authorizePhotoUpload;
  let auth = null;
  if (!injectedAuthorize) {
    const checkAuth = dependencies.requireAuth || requireAuth;
    auth = await checkAuth(req, res, { roles: ['sales', 'admin', 'worker'] });
    if (!auth) return;
  }

  const contentLength = Number(req.headers['content-length'] || 0);
  if (contentLength > 10 * 1024 * 1024) {
    return res.status(413).json({ error: { message: '파일 크기는 10MB 이하여야 합니다.', status: 413 } });
  }

  let parts;
  try {
    const parseRequest = dependencies.parseMultipart || parseMultipart;
    parts = await parseRequest(req);
  } catch (err) {
    const status = err.status || 400;
    return res.status(status).json({ error: { message: status === 413 ? '파일 크기는 10MB 이하여야 합니다.' : 'multipart/form-data 형식으로 전송해주세요.', status } });
  }

  const filePart = getFilePart(parts, 'photo');
  const order_id = getFieldValue(parts, 'order_id');
  const process_id = getFieldValue(parts, 'process_id');
  const uploaded_by = getFieldValue(parts, 'uploaded_by');
  if (auth?._bypass) auth = { ...auth, role: process_id ? 'worker' : null, actor: uploaded_by || '시스템' };

  if (injectedAuthorize) {
    const authorized = await injectedAuthorize(req, res, { process_id, uploaded_by });
    if (!authorized) return;
    auth = typeof authorized === 'object' ? authorized : { actor: uploaded_by || '시스템' };
  } else if (auth.role === 'worker') {
    if (!process_id) {
      return res.status(403).json({ error: { message: '현장 작업자는 공정 사진만 업로드할 수 있습니다.', status: 403 } });
    }
    if (uploaded_by && uploaded_by !== auth.actor) {
      return res.status(403).json({ error: { message: '다른 작업자의 이름으로 사진을 업로드할 수 없습니다.', status: 403 } });
    }
  }

  const orderId = parsePositiveInt4Id(order_id);
  if (orderId === null) {
    return res.status(400).json({ error: { message: '주문 번호는 필수 항목입니다.', status: 400 } });
  }

  const hasProcessId = process_id !== null && process_id !== undefined;
  const processId = hasProcessId ? parsePositiveInt4Id(process_id) : null;
  if (hasProcessId && processId === null) {
    return res.status(400).json({ error: { message: '유효한 공정 ID가 필요합니다.', status: 400 } });
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

  try {
    validateImageFile(filePart, { allowedFormats: ['jpeg', 'png', 'gif', 'webp'] });
  } catch (err) {
    const status = err.status || 400;
    return res.status(status).json({ error: { message: err.message, status } });
  }

  const db = dependencies.db || getDb();

  const orderResult = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
  if (orderResult.rows.length === 0) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }
  const order = orderResult.rows[0];

  if (processId !== null) {
    const processResult = await db.execute({
      sql: 'SELECT id, step_name FROM processes WHERE id = ? AND order_id = ?',
      args: [processId, orderId],
    });
    if (processResult.rows.length === 0) {
      return res.status(400).json({ error: { message: '해당 주문에 속하지 않은 공정입니다.', status: 400 } });
    }
    if (auth.role === 'worker'
      && !canWorkerAccessDepartment(auth.actor, processResult.rows[0].step_name)) {
      return res.status(403).json({
        error: { message: '담당 공정에 대한 권한이 없습니다.', status: 403 },
      });
    }
  }

  const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
  const extMatch = (filePart.filename || '').match(/\.[^.]+$/);
  const ext = extMatch ? extMatch[0].toLowerCase() : '.jpg';
  const blobFilename = `photo-${uniqueSuffix}${ext}`;
  let storedImage;
  try {
    const storeImage = dependencies.storeImageFile || storeImageFile;
    storedImage = await storeImage(filePart, blobFilename);
  } catch (err) {
    console.warn('[photos] image upload failed:', err?.message || err);
    const status = err.status || 502;
    return res.status(status).json({ error: { message: err.message || '파일 저장에 실패했습니다. 잠시 후 다시 시도해주세요.', status } });
  }

  let result;
  try {
    result = await db.execute({
      sql: `INSERT INTO photos (order_id, process_id, file_path, uploaded_by)
            VALUES (?, ?, ?, ?) RETURNING id`,
      args: [orderId, processId, storedImage.url, auth.actor],
    });
  } catch (err) {
    if (storedImage.rollbackUrl) {
      try { await del(storedImage.rollbackUrl); } catch (deleteErr) { console.warn('[photos] blob rollback failed:', deleteErr?.message || deleteErr); }
    }
    throw err;
  }

  await db.execute({
    sql: `INSERT INTO activity_feed (order_id, action_type, description, actor)
          VALUES (?, ?, ?, ?)`,
    args: [
      orderId,
      '사진등록',
      `${order.client_name} - 사진이 업로드되었습니다.`,
      auth.actor,
    ],
  }).catch((err) => console.warn('[photos] activity log failed:', err?.message || err));

  const photoResult = await db.execute({
    sql: 'SELECT * FROM photos WHERE id = ?',
    args: [Number(result.rows[0].id)],
  });

  return res.status(201).json(photoResult.rows[0]);
}
