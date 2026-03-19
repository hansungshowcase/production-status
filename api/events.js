import { getDb } from './_lib/db.js';
import { cors } from './_lib/cors.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }

  const since = req.query.since || new Date(Date.now() - 30000).toISOString();
  const db = getDb();

  const { rows } = await db.execute({
    sql: `SELECT * FROM activity_feed WHERE created_at > ? ORDER BY created_at DESC LIMIT 50`,
    args: [since],
  });

  return res.json({ events: rows, timestamp: new Date().toISOString() });
});
