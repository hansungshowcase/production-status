import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { requireWorkerAction } from '../../_lib/auth.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { completeOrderShipping } from '../../_lib/directShipping.js';

export default cors(async function handler(req, res) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  if (!rateLimitCheck(req, res)) return;

  const worker = requireWorkerAction(req, res);
  if (!worker) return;

  const { id } = req.query;
  if (!id || isNaN(Number(id))) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }

  const result = await completeOrderShipping({ db: getDb(), orderId: id, actor: worker.actor });
  return res.status(result.status).json(result.body);
});
