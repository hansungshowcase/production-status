import { cors } from '../_lib/cors.js';
import { getDb } from '../_lib/db.js';

function latestDate(left, right) {
  if (!right) return left;
  const value = new Date(right).toISOString();
  return !left || value > left ? value : left;
}

export async function handleSyncStatus(req, res, { db, env = process.env } = {}) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  const database = db || getDb();
  const { rows } = await database.execute({
    sql: `SELECT 'append' AS queue, status, COUNT(*)::int AS count,
                 MAX(last_attempt_at) AS last_attempt_at, MAX(synced_at) AS last_synced_at,
                 COUNT(*) FILTER (WHERE last_error ILIKE '%not_found%' OR last_error ILIKE '%not found%')::int AS not_found,
                 COUNT(*) FILTER (WHERE last_error ILIKE '%timeout%' OR last_error ILIKE '%timed out%' OR last_error ILIKE '%aborted%')::int AS timeout
            FROM sheet_sync_jobs GROUP BY status
          UNION ALL
          SELECT 'shipping' AS queue, status, COUNT(*)::int AS count,
                 MAX(last_attempt_at) AS last_attempt_at, MAX(synced_at) AS last_synced_at,
                 COUNT(*) FILTER (WHERE last_error ILIKE '%not_found%' OR last_error ILIKE '%not found%')::int AS not_found,
                 COUNT(*) FILTER (WHERE last_error ILIKE '%timeout%' OR last_error ILIKE '%timed out%' OR last_error ILIKE '%aborted%')::int AS timeout
            FROM sheet_shipping_sync_jobs GROUP BY status`,
    args: [],
  });
  const emptyQueue = () => ({ pending: 0, failed: 0, sending: 0, synced: 0, other: 0, lastAttempt: null, lastSync: null, errors: { not_found: 0, timeout: 0 } });
  const queues = { append: emptyQueue(), shipping: emptyQueue() };
  for (const row of rows) {
    const queue = queues[row.queue];
    if (!queue) continue;
    const status = ['pending', 'failed', 'sending', 'synced'].includes(row.status) ? row.status : 'other';
    queue[status] += Number(row.count);
    queue.errors.not_found += Number(row.not_found || 0);
    queue.errors.timeout += Number(row.timeout || 0);
    queue.lastAttempt = latestDate(queue.lastAttempt, row.last_attempt_at);
    queue.lastSync = latestDate(queue.lastSync, row.last_synced_at);
  }
  const lastSync = latestDate(queues.append.lastSync, queues.shipping.lastSync);
  return res.json({
    enabled: Boolean(env.CRON_SECRET),
    lastSync,
    recentSyncs: Object.entries(queues).filter(([, queue]) => queue.lastSync).map(([type, queue]) => ({ type, status: 'synced', at: queue.lastSync })),
    ...queues,
    message: `등록 대기 ${queues.append.pending}건·실패 ${queues.append.failed}건, 출고 대기 ${queues.shipping.pending}건·실패 ${queues.shipping.failed}건`,
  });
}

export default cors((req, res) => handleSyncStatus(req, res));
