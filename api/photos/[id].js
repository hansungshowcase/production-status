import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { requireAuth, resolveActor } from '../_lib/auth.js';
import { del } from '@vercel/blob';
import { parsePositiveInt4Id } from '../_lib/positiveInt4Id.js';

export default cors(async function handler(req, res) {
  if (req.method === 'GET') {
    return handleGet(req, res);
  } else if (req.method === 'DELETE') {
    return handleDelete(req, res);
  } else {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
});

export async function handleGet(req, res, dependencies = {}) {
  const id = parsePositiveInt4Id(req.query.id);
  if (id === null) {
    return res.status(400).json({ error: { message: '유효한 사진 ID가 필요합니다.', status: 400 } });
  }
  const db = dependencies.db || getDb();

  const { rows } = await db.execute({ sql: 'SELECT * FROM photos WHERE id = ?', args: [id] });
  if (rows.length === 0) {
    return res.status(404).json({ error: { message: '사진을 찾을 수 없습니다.', status: 404 } });
  }

  const photo = rows[0];
  if (req.query.download === '1') {
    if (!photo.file_path) {
      return res.status(404).json({ error: { message: '다운로드할 사진 파일이 없습니다.', status: 404 } });
    }

    const upstream = await fetch(photo.file_path);
    if (!upstream.ok) {
      return res.status(502).json({ error: { message: '사진 파일을 불러오지 못했습니다.', status: 502 } });
    }

    const contentType = upstream.headers.get('content-type') || 'application/octet-stream';
    const extFromType = contentType.includes('png')
      ? 'png'
      : contentType.includes('webp')
        ? 'webp'
        : contentType.includes('gif')
          ? 'gif'
          : 'jpg';
    const filename = `packing-photo-${photo.id}.${extFromType}`;
    const bytes = Buffer.from(await upstream.arrayBuffer());

    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', String(bytes.length));
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.status(200).send(bytes);
  }

  return res.json(photo);
}

export async function handleDelete(req, res, dependencies = {}) {
  const checkAuth = dependencies.requireAuth || requireAuth;
  const auth = checkAuth(req, res, { roles: ['sales', 'admin'] });
  if (!auth) return;

  const id = parsePositiveInt4Id(req.query.id);
  if (id === null) {
    return res.status(400).json({ error: { message: '유효한 사진 ID가 필요합니다.', status: 400 } });
  }
  const db = dependencies.db || getDb();
  const deleteBlob = dependencies.deleteBlob || del;
  const [photoResult] = await db.atomicBatch([{
    sql: `WITH selected_photo AS (
            SELECT * FROM photos WHERE id = ? FOR UPDATE
          ),
          selected_order AS (
            SELECT o.client_name
              FROM orders o
              JOIN selected_photo sp ON sp.order_id = o.id
          ),
          deleted_photo AS (
            DELETE FROM photos p
             USING selected_photo sp
             WHERE p.id = sp.id
            RETURNING p.*
          ),
          photo_activity AS (
            INSERT INTO activity_feed (order_id, action_type, description, actor)
            SELECT dp.order_id,
                   '사진삭제',
                   BTRIM(COALESCE(so.client_name, '') || ' - 사진이 삭제되었습니다.'),
                   ?
              FROM deleted_photo dp
              LEFT JOIN selected_order so ON TRUE
            RETURNING id
          )
          SELECT dp.*, so.client_name
            FROM deleted_photo dp
            LEFT JOIN selected_order so ON TRUE`,
    args: [id, resolveActor(req)],
  }]);
  const photo = photoResult.rows[0];
  if (!photo) {
    return res.status(404).json({ error: { message: '사진을 찾을 수 없습니다.', status: 404 } });
  }

  // DB 삭제와 활동 기록이 함께 커밋된 뒤 Blob 을 정리한다.
  if (photo.file_path) {
    try {
      await deleteBlob(photo.file_path);
    } catch (err) {
      console.warn('[photos DELETE] blob 삭제 실패, DB 삭제는 완료:', err?.message || err);
    }
  }

  return res.json({ success: true, message: '사진이 삭제되었습니다.' });
}
