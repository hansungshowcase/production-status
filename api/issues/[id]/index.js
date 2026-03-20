import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const { id } = req.query;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: { message: '유효한 이슈 ID가 필요합니다.', status: 400 } });
  }
  const db = getDb();

  const { rows } = await db.execute({ sql: 'SELECT * FROM issues WHERE id = ?', args: [id] });
  if (rows.length === 0) {
    return res.status(404).json({ error: { message: '이슈를 찾을 수 없습니다.', status: 404 } });
  }

  return res.json(rows[0]);
});
