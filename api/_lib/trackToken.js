import crypto from 'crypto';
import { ensureNotifySchema } from './notifySchema.js';

// 고객 조회 링크(/track/:token)용 토큰 생성기. 순수 CPU 연산이라 실패하지 않는다.
// 주문 INSERT 시점에 값으로 바로 넣기 위해 별도로 노출한다.
export function generateTrackToken() {
  return crypto.randomBytes(18).toString('base64url');
}

// 주문의 track_token 을 보장한다. 있으면 그대로 반환, 없으면 생성·저장 후 반환.
// 인자는 orderId(숫자) 또는 order 객체(둘 다 허용).
export async function ensureTrackToken(db, orderOrId) {
  await ensureNotifySchema(db);

  let orderId;
  let known = null;
  if (orderOrId && typeof orderOrId === 'object') {
    orderId = Number(orderOrId.id);
    known = orderOrId.track_token || null;
  } else {
    orderId = Number(orderOrId);
  }
  if (!orderId || Number.isNaN(orderId)) return null;
  if (known) return known;

  const { rows } = await db.execute({
    sql: 'SELECT track_token FROM orders WHERE id = ?',
    args: [orderId],
  });
  if (rows.length === 0) return null;
  if (rows[0].track_token) return rows[0].track_token;

  // 조건부 UPDATE 로 동시 생성 경쟁 방어 (Neon HTTP — 트랜잭션 없이 원자성 확보)
  for (let i = 0; i < 3; i++) {
    const token = generateTrackToken();
    try {
      const { rows: updated } = await db.execute({
        sql: 'UPDATE orders SET track_token = ? WHERE id = ? AND track_token IS NULL RETURNING track_token',
        args: [token, orderId],
      });
      if (updated.length > 0) return updated[0].track_token;
      // 다른 요청이 먼저 생성함 → 그 값을 읽어 반환
      const { rows: again } = await db.execute({
        sql: 'SELECT track_token FROM orders WHERE id = ?',
        args: [orderId],
      });
      return again[0]?.track_token || null;
    } catch (err) {
      // UNIQUE 충돌(천문학적 확률) → 새 토큰으로 재시도
      if (!/duplicate|unique/i.test(String(err?.message || ''))) throw err;
    }
  }
  throw new Error('track_token 생성에 실패했습니다.');
}
