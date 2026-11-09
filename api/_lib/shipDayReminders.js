import { ALERT_ROUTES, alertFallbackPhone, canonicalAlertRecipientName } from './alertRoutes.js';
import { kstDayFromNow, normalizeDueDateToKstDay } from './overdueReminders.js';
import { buildProductionAlertMessage } from './productionAlertMessage.js';

const SITE_URL = 'https://production-status.vercel.app';

function maskedPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length < 8) return `${digits.slice(0, 2)}****`;
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

function salesTarget() {
  const seen = new Set();
  return Object.entries(ALERT_ROUTES).flatMap(([routeName, phone]) => {
    const name = canonicalAlertRecipientName(routeName);
    if (!name || seen.has(name)) return [];
    seen.add(name);
    return [`${name} (${maskedPhone(phone)})`];
  }).join(', ');
}

export const SHIP_DAY_REMINDER_DEFINITION = Object.freeze({
  kind: 'internal_ship_day',
  title: '오늘 출고 예정',
  action: '오늘 출고 예정입니다. 출고 준비와 고객 일정을 확인해 주세요.',
  overview: Object.freeze({
    name: '오늘 출고 예정 알림',
    trigger: '생산중 · 미출고 · 출고예정일(없으면 납기일)=오늘',
    target: `해당 주문의 영업담당자 (등록 라우팅: ${salesTarget()})`,
    timing: '매일 08:42 KST',
  }),
});

function normalizedPhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function salesRecipient(value, routes) {
  const rawName = String(value || '').trim();
  const canonicalName = canonicalAlertRecipientName(rawName);
  if (!canonicalName) return null;
  const phone = normalizedPhone(routes[rawName] || routes[canonicalName]);
  return phone ? { recipientName: canonicalName, toPhone: phone } : null;
}

export function collectShipDayReminderGroups({
  orders = [],
  nowMs = Date.now(),
  today,
  routes = ALERT_ROUTES,
} = {}) {
  const kstDate = today || kstDayFromNow(nowMs);
  const kind = SHIP_DAY_REMINDER_DEFINITION.kind;
  const fallbackPhone = normalizedPhone(alertFallbackPhone());
  const grouped = new Map();
  const unknownAssignments = [];
  const seen = new Set();
  let eligibleOrders = 0;

  for (const order of orders) {
    if (order?.status !== 'in_production' || order?.ship_date) continue;
    const orderId = Number(order.id);
    if (!Number.isFinite(orderId) || seen.has(orderId)) continue;
    const shipDay = normalizeDueDateToKstDay(order.ship_scheduled_date || order.due_date);
    if (shipDay !== kstDate) continue;
    seen.add(orderId);
    eligibleOrders += 1;
    let recipient = salesRecipient(order.sales_person, routes);
    if (!recipient) {
      unknownAssignments.push({ kind, orderId, role: 'salesperson', value: String(order.sales_person || '').trim() || null });
      if (!fallbackPhone) continue;
      recipient = { recipientName: '담당자', toPhone: fallbackPhone };
    }
    if (!grouped.has(recipient.toPhone)) {
      grouped.set(recipient.toPhone, { kind, recipientName: recipient.recipientName, toPhone: recipient.toPhone, kstDate, orders: [] });
    }
    grouped.get(recipient.toPhone).orders.push({
      orderId,
      clientName: String(order.client_name || '').trim() || '거래처명 확인 필요',
      // 문자 '납기' 칸에는 실제 납기일(없으면 출고예정일) — 출고예정일은 detail 에 따로 표기
      dueDay: normalizeDueDateToKstDay(order.due_date) || shipDay,
      shipDay,
      daysLeft: 0,
      overdueDays: 0,
    });
  }

  const groups = [...grouped.values()]
    .map(group => ({ ...group, orders: group.orders.sort((a, b) => a.orderId - b.orderId) }))
    .sort((a, b) => a.recipientName.localeCompare(b.recipientName));
  return {
    kstDate,
    today: kstDate,
    scannedOrders: orders.length,
    eligibleOrders,
    groups,
    unknownAssignments,
  };
}

export function buildShipDayReminderMessage(group) {
  const orders = Array.isArray(group?.orders) ? group.orders : [];
  return buildProductionAlertMessage({
    subject: `[생산현황 ${SHIP_DAY_REMINDER_DEFINITION.title}]`,
    recipientName: group?.recipientName,
    date: group?.kstDate,
    items: orders.map(order => ({
      clientName: order.clientName,
      dueDay: order.dueDay || order.shipDay,
      daysLeft: order.daysLeft,
      detail: `오늘(${order.shipDay || order.dueDay}) 출고 예정 · 주문번호 ${order.orderId}`,
      action: SHIP_DAY_REMINDER_DEFINITION.action,
    })),
    url: SITE_URL,
  });
}
