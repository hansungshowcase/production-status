// 시연용 임시 엔드포인트 — GET /api/cron/demo-notify?orderId=123&to=01012345678
// 실제 주문의 '접수 안내' 메시지(진짜 고객 문구)를 지정 번호로 1건 발송하고 조회링크를 반환.
// 주문의 notify_state 는 건드리지 않음(직접 발송) → 실제 고객 알림 흐름 오염 없음.
// CRON_SECRET Bearer 인증. 시연 확인 후 제거 가능.
import crypto from 'crypto';
import { cors } from '../_lib/cors.js';
import { getDb } from '../_lib/db.js';
import { buildMessage, sendAdminLms } from '../_lib/notify.js';
import { ensureTrackToken } from '../_lib/trackToken.js';

function timingSafeEq(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ba.length !== bb.length) return false;
  try { return crypto.timingSafeEqual(ba, bb); } catch { return false; }
}

export default cors(async function handler(req, res) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !timingSafeEq(req.headers.authorization || '', `Bearer ${secret}`)) {
    return res.status(401).json({ error: { message: 'Unauthorized', status: 401 } });
  }
  const orderId = Number(req.query.orderId);
  const to = String(req.query.to || '').replace(/\D/g, '');
  if (!orderId || !/^\d{9,12}$/.test(to)) {
    return res.status(400).json({ error: { message: 'orderId 와 to(수신번호)가 필요합니다.', status: 400 } });
  }

  const db = getDb();
  const { rows } = await db.execute({ sql: 'SELECT * FROM orders WHERE id = ?', args: [orderId] });
  const order = rows[0];
  if (!order) return res.status(404).json({ error: { message: '주문을 찾을 수 없습니다.', status: 404 } });

  const token = await ensureTrackToken(db, order);
  const base = (process.env.BASE_URL || 'https://production-status.vercel.app').replace(/\/+$/, '');
  const trackUrl = `${base}/track/${token}`;

  const msg = buildMessage(order, 'ordered', trackUrl);
  const result = await sendAdminLms(db, { to, subject: msg.subject, text: msg.text, tag: 'demo' });

  return res.json({
    ok: true,
    sentTo: to.slice(0, 3) + '****' + to.slice(-4),
    trackUrl,
    messagePreview: msg.text,
    result,
  });
});
