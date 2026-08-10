// 고객용 공개 조회 — GET /api/track/{track_token}
// 인증 없음(토큰이 곧 자격증명). 마스킹된 필드만 반환.
// 내부정보(sale_amount, balance, phone, 작업자명, 리스크 등급) 절대 미포함.
// 예외: manager_name(=sales_person 이름)은 문의 라우팅용으로 의도적 노출 — 고객 본인의 담당 영업자라 무방 (대표 승인).
import { getDb } from '../_lib/db.js';
import { cors } from '../_lib/cors.js';
import { rateLimitCheck } from '../_lib/rateLimit.js';
import { ensureNotifySchema } from '../_lib/notifySchema.js';
import { kstToday } from '../_lib/risk.js';

function maskName(name) {
  const s = String(name || '').trim();
  if (!s) return '고객';
  return s[0] + '*'.repeat(Math.max(s.length - 1, 1));
}

export default cors(async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'GET') {
    return res.status(405).json({ error: { message: 'Method not allowed' } });
  }
  // 토큰 열거 방어: rate limit 키를 토큰별이 아닌 경로 고정으로 (IP당 분당 30회)
  const limitReq = { headers: req.headers, socket: req.socket, url: '/api/track' };
  if (!rateLimitCheck(limitReq, res, { windowMs: 60000, max: 30 })) return;

  const notFound = () => res.status(404).json({ error: { message: '주문을 찾을 수 없습니다', status: 404 } });

  const token = String(req.query.token || '');
  // base64url 18바이트 = 24자. 형식 밖 토큰은 조회 없이 404 (존재 여부 비노출 통일)
  if (!/^[A-Za-z0-9_-]{10,64}$/.test(token)) return notFound();

  const db = getDb();
  await ensureNotifySchema(db);

  const { rows: orderRows } = await db.execute({
    sql: 'SELECT * FROM orders WHERE track_token = ?',
    args: [token],
  });
  if (orderRows.length === 0) return notFound();
  const order = orderRows[0];

  // 취소된 주문은 진행상황 페이지가 무의미 + '정상 진행 중' 오표시 위험 → 존재 비노출과 동일하게 404
  if (order.status === 'cancelled') return notFound();

  const { rows: processes } = await db.execute({
    sql: 'SELECT step_name, status FROM processes WHERE order_id = ? ORDER BY id',
    args: [order.id],
  });

  const completed = processes.filter(p => p.status === 'completed').length;
  const inProgress = processes.find(p => p.status === 'in_progress');
  const nextWaiting = processes.find(p => p.status === 'waiting');
  const current_step = order.status === 'shipped'
    ? '출고'
    : (inProgress?.step_name || nextWaiting?.step_name || null);

  // 고객 노출 delivery_status 파생 (리스크 등급·확률은 절대 비노출)
  const today = kstToday();
  const schedDate = order.ship_scheduled_date ? String(order.ship_scheduled_date).slice(0, 10) : null;
  let delivery_status;
  if (order.status === 'shipped') delivery_status = 'shipped';
  // 예정일이 이미 지났으면 '새 출고예정일' 로 지난 날짜를 보여주지 않고 '조정 중' 으로 폴백 (05 문서 5.2)
  else if (schedDate && schedDate >= today) delivery_status = 'rescheduled';
  else if (schedDate || (order.due_date && String(order.due_date).slice(0, 10) < today)) delivery_status = 'adjusting';
  else delivery_status = 'on_track';

  // 포장 완료 시에만 포장 사진 노출
  let packing_photo_url = null;
  const packingDone = processes.some(p => p.step_name === '포장' && p.status === 'completed');
  if (packingDone) {
    const { rows: photoRows } = await db.execute({
      sql: `SELECT ph.file_path
              FROM photos ph
              JOIN processes pp ON pp.id = ph.process_id
             WHERE ph.order_id = ? AND pp.step_name = '포장'
             ORDER BY ph.uploaded_at DESC
             LIMIT 1`,
      args: [order.id],
    });
    packing_photo_url = photoRows[0]?.file_path || null;
  }

  // 주문 표시번호 — 고객이 이미 알림 문자로 받는 값(notify.js orderNo 와 동일 포맷).
  // 담당 영업자명은 문의 라우팅용(고객→채널 채팅에 담당자가 자동 표기되게) — 고객 본인의 담당자라 노출 무방.
  const orderYear = String(order.order_date || '').slice(0, 4) || String(new Date().getFullYear());
  const order_no = `HS-${orderYear}-${String(order.id).padStart(4, '0')}`;

  return res.json({
    order_no,
    manager_name: order.sales_person || null,
    client_name: maskName(order.client_name),
    // product_type(품명)은 내려주지 않는다. 내부 분류·거래처 표기가 들어가 있는 경우가 있어
    // 고객에게 노출하기 부적절하다(2026-08-10). 화면에서 빼는 것만으로는 응답에 그대로 남아
    // 조회 링크로 값이 보이므로 응답 자체에서 제외한다.
    door_type: order.door_type || null,
    size: { width: order.width, depth: order.depth, height: order.height },
    quantity: order.quantity,
    color: order.color || null,
    status: order.status,
    delivery_status,
    // 지난/폐기된 날짜 노출 방지 (05 문서 5.2): 조정 중·새 예정일 안내 중에는 기존 납기를 숨긴다
    due_date: (delivery_status === 'adjusting' || delivery_status === 'rescheduled') ? null : (order.due_date || null),
    ship_scheduled_date: delivery_status === 'adjusting' ? null : (order.ship_scheduled_date || null),
    ship_date: order.ship_date || null,
    progress: { completed, total: processes.length },
    current_step,
    steps: processes.map(p => ({ name: p.step_name, status: p.status })), // 작업자명 제외
    packing_photo_url,
  });
});
