import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { requireAuth } from '../_lib/auth.js';
import { rateLimitCheck } from '../_lib/rateLimit.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'DELETE') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  if (!rateLimitCheck(req, res)) return;

  const auth = requireAuth(req, res, { roles: ['admin'] });
  if (!auth) return;

  const { id } = req.query;
  const db = getDb();

  const { rows } = await db.execute({ sql: 'SELECT * FROM workers WHERE id = ?', args: [id] });
  if (rows.length === 0) {
    return res.status(404).json({ error: { message: '작업자를 찾을 수 없습니다.', status: 404 } });
  }

  const worker = rows[0];
  const { rows: refs } = await db.execute({
    sql: `SELECT COUNT(*) AS cnt FROM processes
          WHERE (started_by = ? OR completed_by = ?)
            AND status IN ('in_progress', 'waiting')`,
    args: [worker.name, worker.name],
  });
  if (Number(refs[0]?.cnt) > 0) {
    return res.status(409).json({
      error: {
        message: `'${worker.name}' 작업자가 진행 중인 공정에 배정되어 있어 삭제할 수 없습니다.`,
        status: 409,
      },
    });
  }

  await db.execute({ sql: 'DELETE FROM workers WHERE id = ?', args: [id] });

  return res.json({ success: true });
});
