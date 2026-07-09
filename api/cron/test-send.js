// 발송 테스트용 임시 엔드포인트 — GET /api/cron/test-send?to=01012345678
// CRON_SECRET Bearer 인증. 지정 번호로 실제 문자(LMS) 1건 발송(솔라피 키 없으면 dry_run).
// 조용시간 무시(sendAdminLms 경로). 검증 후 제거해도 무방.
import crypto from 'crypto';
import { cors } from '../_lib/cors.js';
import { getDb } from '../_lib/db.js';
import { sendAdminLms } from '../_lib/notify.js';

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
  const to = String(req.query.to || '').replace(/\D/g, '');
  if (!/^\d{9,12}$/.test(to)) {
    return res.status(400).json({ error: { message: '유효한 수신번호(to)가 필요합니다.', status: 400 } });
  }
  const db = getDb();
  const result = await sendAdminLms(db, {
    to,
    subject: '[한성쇼케이스] 발송 테스트',
    text: '[한성쇼케이스] 알림 발송 테스트입니다.\n이 문자가 보이면 문자 발송 연동이 정상 작동하는 것입니다.',
    tag: 'test',
  });
  return res.json({ ok: true, to: to.slice(0, 3) + '****' + to.slice(-4), result });
});
