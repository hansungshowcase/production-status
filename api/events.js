import { getDb } from './_lib/db.js';
import { cors } from './_lib/cors.js';

function parseSince(raw) {
  // 1) 빈값/null → 30초 전 default
  if (!raw) return new Date(Date.now() - 30000).toISOString();
  // 2) epoch ms 숫자 (예: 1731234567890)
  if (/^\d{10,}$/.test(String(raw))) {
    const d = new Date(Number(raw));
    if (!isNaN(d.getTime())) return d.toISOString();
  }
  // 3) ISO 8601 검증
  const d = new Date(String(raw));
  if (!isNaN(d.getTime())) return d.toISOString();
  // 4) 잘못된 형식 — default로 폴백 (Postgres 500 방지)
  return new Date(Date.now() - 30000).toISOString();
}

export default cors(async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const since = parseSince(req.query.since);
  const db = getDb();

  const { rows } = await db.execute({
    sql: `SELECT * FROM activity_feed WHERE created_at > ? ORDER BY created_at DESC LIMIT 50`,
    args: [since],
  });

  return res.json({ events: rows, timestamp: new Date().toISOString() });
});
