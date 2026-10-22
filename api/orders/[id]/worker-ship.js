import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { requireWorkerAction } from '../../_lib/auth.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { completeOrderShipping } from '../../_lib/directShipping.js';
import { parsePositiveInt4Id } from '../../_lib/positiveInt4Id.js';

export async function handleWorkerShip(req, res, dependencies = {}) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  const checkRateLimit = dependencies.rateLimitCheck || rateLimitCheck;
  if (!checkRateLimit(req, res)) return;

  const checkWorker = dependencies.requireWorkerAction || requireWorkerAction;
  const worker = checkWorker(req, res);
  if (!worker) return;

  const id = parsePositiveInt4Id(req.query.id);
  if (id === null) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }

  const completeShipping = dependencies.completeOrderShipping || completeOrderShipping;
  const result = await completeShipping({ db: dependencies.db || getDb(), orderId: id, actor: worker.actor });
  return res.status(result.status).json(result.body);
}

export default cors(handleWorkerShip);
