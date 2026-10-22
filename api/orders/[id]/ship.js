import { getDb } from '../../_lib/db.js';
import { cors } from '../../_lib/cors.js';
import { requireAuth, resolveActor } from '../../_lib/auth.js';
import { rateLimitCheck } from '../../_lib/rateLimit.js';
import { canShipFromSales } from '../../_lib/shippingPermission.js';
import { completeOrderShipping } from '../../_lib/directShipping.js';
import { parsePositiveInt4Id } from '../../_lib/positiveInt4Id.js';

export async function handleShip(req, res, dependencies = {}) {
  if (req.method !== 'PATCH') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  const checkRateLimit = dependencies.rateLimitCheck || rateLimitCheck;
  if (!checkRateLimit(req, res)) return;

  const checkAuth = dependencies.requireAuth || requireAuth;
  const auth = await checkAuth(req, res, { roles: ['sales'] });
  if (!auth) return;

  const id = parsePositiveInt4Id(req.query.id);
  if (id === null) {
    return res.status(400).json({ error: { message: '유효한 주문 ID가 필요합니다.', status: 400 } });
  }

  const actor = (dependencies.resolveActor || resolveActor)(req);
  const canShip = dependencies.canShipFromSales || canShipFromSales;
  if (!canShip(actor)) {
    return res.status(403).json({ error: { message: '발주현황에서 출고 처리할 권한이 없습니다.', status: 403 } });
  }

  const completeShipping = dependencies.completeOrderShipping || completeOrderShipping;
  const result = await completeShipping({ db: dependencies.db || getDb(), orderId: id, actor });
  return res.status(result.status).json(result.body);
}

export default cors(handleShip);
