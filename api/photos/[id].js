import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { requireAuth, resolveActor } from '../_lib/auth.js';
import { del } from '@vercel/blob';

export default cors(async function handler(req, res) {
  if (req.method === 'GET') {
    return handleGet(req, res);
  } else if (req.method === 'DELETE') {
    return handleDelete(req, res);
  } else {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
});

async function handleGet(req, res) {
  const { id } = req.query;
  const db = getDb();

  const { rows } = await db.execute({ sql: 'SELECT * FROM photos WHERE id = ?', args: [id] });
  if (rows.length === 0) {
    return res.status(404).json({ error: { message: '사진을 찾을 수 없습니다.', status: 404 } });
  }

  return res.json(rows[0]);
}

async function handleDelete(req, res) {
  const auth = requireAuth(req, res, { roles: ['sales', 'admin'] });
  if (!auth) return;

  const { id } = req.query;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: { message: '유효한 사진 ID가 필요합니다.', status: 400 } });
  }
  const db = getDb();

  const photoResult = await db.execute({ sql: 'SELECT * FROM photos WHERE id = ?', args: [id] });
  const photo = photoResult.rows[0];
  if (!photo) {
    return res.status(404).json({ error: { message: '사진을 찾을 수 없습니다.', status: 404 } });
  }

  // Blob 삭제 시도 (실패해도 DB 정리는 계속 — orphan blob 보다 dangling row 가 더 위험)
  if (photo.file_path) {
    try {
      await del(photo.file_path);
    } catch (err) {
      console.warn('[photos DELETE] blob 삭제 실패, DB 정리는 진행:', err?.message || err);
    }
  }

  await db.execute({ sql: 'DELETE FROM photos WHERE id = ?', args: [id] });

  // order_id가 있을 때만 활동 로그 (CASCADE로 곧 사라질 수도 있지만 일관성 유지)
  const orderResult = photo.order_id
    ? await db.execute({ sql: 'SELECT client_name FROM orders WHERE id = ?', args: [photo.order_id] })
    : { rows: [] };
  const clientName = orderResult.rows[0]?.client_name || '';

  await db.execute({
    sql: `INSERT INTO activity_feed (order_id, action_type, description, actor)
          VALUES (?, ?, ?, ?)`,
    args: [
      photo.order_id || null,
      '사진삭제',
      `${clientName} - 사진이 삭제되었습니다.`.trim(),
      resolveActor(req),
    ],
  });

  return res.json({ success: true, message: '사진이 삭제되었습니다.' });
}
