import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { requireWorkerAction } from '../../_lib/auth.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { completeOrderShipping } from '../../_lib/directShipping.js';
import { parsePositiveInt4Id } from '../../_lib/positiveInt4Id.js';
import { canWorkerAccessDepartment } from '../../../shared/workerAccess.js';

export async function handleWorkerShip(req, res, dependencies = {}) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  const checkRateLimit = dependencies.rateLimitCheck || rateLimitCheck;
  if (!checkRateLimit(req, res)) return;

  const checkWorker = dependencies.requireWorkerAction || requireWorkerAction;
  const worker = await checkWorker(req, res);
  if (!worker) return;

  const id = parsePositiveInt4Id(req.query.id);
  if (id === null) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }

  const db = dependencies.db || getDb();
  const { rows: orderRows } = await db.execute({
    sql: 'SELECT id FROM orders WHERE id = ?',
    args: [id],
  });
  if (orderRows.length === 0) {
    return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });
  }
  if (!canWorkerAccessDepartment(worker.actor, '출고')) {
    return res.status(403).json({
      error: { message: '담당 공정에 대한 권한이 없습니다.', status: 403 },
    });
  }

  const completeShipping = dependencies.completeOrderShipping || completeOrderShipping;
  const result = await completeShipping({ db, orderId: id, actor: worker.actor });
  return res.status(result.status).json(result.body);
}

export default cors(handleWorkerShip);
