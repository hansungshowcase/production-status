import { ALERT_ROUTES, canonicalAlertRecipientName } from './alertRoutes.js';
import {
  INTERNAL_ALERT_CONTACTS,
  assemblyWorkerPhone,
  canonicalAssemblyWorkerName,
} from './internalProductionAlerts.js';
import { buildProductionAlertMessage } from './productionAlertMessage.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SITE_URL = 'https://production-status.vercel.app';

function maskedPhone(value) {
  const digits = String(value || '').replace(/\D/g, '');
  if (!digits) return '';
  if (digits.length < 8) return `${digits.slice(0, 2)}****`;
  return `${digits.slice(0, 3)}****${digits.slice(-4)}`;
}

function namedTarget(name, phone) {
  return `${name} (${maskedPhone(phone)})`;
}

function salesTarget() {
  const seen = new Set();
  return Object.entries(ALERT_ROUTES).flatMap(([routeName, phone]) => {
    const name = canonicalAlertRecipientName(routeName);
    if (!name || seen.has(name)) return [];
    seen.add(name);
    return [namedTarget(name, phone)];
  }).join(', ');
}

const SALES_TARGET = salesTarget();
const PROCESS_TARGET = [
  INTERNAL_ALERT_CONTACTS.packing,
  INTERNAL_ALERT_CONTACTS.welding,
  INTERNAL_ALERT_CONTACTS.assembly,
].map(contact => namedTarget(contact.name, contact.phone)).join(', ');

export const OVERDUE_REMINDER_DEFINITIONS = Object.freeze({
  UNSHIPPED: Object.freeze({
    kind: 'internal_overdue_unshipped',
    title: '납기 지연 출고 미완료',
    action: '출고 여부 확인 후 출고완료 처리해 주세요.',
    overview: Object.freeze({
      name: '납기 지연 출고 미완료 알림',
      trigger: '생산중 · 납기일 기준 10일 이상 경과 · 미출고',
      target: `해당 주문의 영업담당자 (등록 라우팅: ${SALES_TARGET})`,
      timing: '매일 08:40 KST',
    }),
  }),
  EQUIPMENT: Object.freeze({
    kind: 'internal_overdue_equipment',
    title: '납기 지연 설비작업 미완료',
    action: '설비작업 확인 후 완료 처리해 주세요.',
    overview: Object.freeze({
      name: '납기 지연 설비작업 미완료 알림',
      trigger: '생산중 · 납기일 경과 · 설비작업 미완료',
      target: `해당 주문의 영업담당자 (등록 라우팅: ${SALES_TARGET}) · 해당 주문 실제 조립 착수자 · 고정 수신: ${PROCESS_TARGET}`,
      timing: '매일 08:40 KST',
    }),
  }),
  PACKING: Object.freeze({
    kind: 'internal_overdue_packing',
    title: '포장 완료 요청',
    action: '포장 완료 처리해 주세요.',
    overview: Object.freeze({
      name: '포장 완료 요청 알림',
      trigger: '생산중 · 납기 3일 전부터 모든 납기 경과일 · 포장 미완료',
      target: namedTarget(INTERNAL_ALERT_CONTACTS.packing.name, INTERNAL_ALERT_CONTACTS.packing.phone),
      timing: '매일 08:40 KST',
    }),
  }),
});

export const OVERDUE_REMINDER_KINDS = Object.freeze(Object.fromEntries(
  Object.entries(OVERDUE_REMINDER_DEFINITIONS).map(([key, definition]) => [key, definition.kind]),
));

const MESSAGE_COPY = Object.freeze(Object.fromEntries(
  Object.values(OVERDUE_REMINDER_DEFINITIONS).map(({ kind, title, action }) => [
    kind,
    Object.freeze({ title, action }),
  ]),
));

function isValidCalendarDate(year, month, day) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year
    && date.getUTCMonth() === month - 1
    && date.getUTCDate() === day;
}

function calendarParts(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  return isValidCalendarDate(year, month, day) ? { year, month, day } : null;
}

export function normalizeDueDateToKstDay(value) {
  if (value instanceof Date) {
    if (!Number.isFinite(value.getTime())) return null;
    return new Date(value.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10);
  }

  const raw = String(value ?? '').trim();
  if (!raw) return null;
  if (calendarParts(raw)) return raw;

  const timestamp = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!timestamp || !calendarParts(timestamp[1])) return null;
  const hour = Number(timestamp[2]);
  const minute = Number(timestamp[3]);
  const second = Number(timestamp[4] || 0);
  if (hour > 23 || minute > 59 || second > 59) return null;
  if (timestamp[6] !== 'Z') {
    const offsetHour = Number(timestamp[6].slice(1, 3));
    const offsetMinute = Number(timestamp[6].slice(4, 6));
    if (offsetHour > 14 || offsetMinute > 59 || (offsetHour === 14 && offsetMinute !== 0)) return null;
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed + KST_OFFSET_MS).toISOString().slice(0, 10);
}

export function kstDayFromNow(nowMs = Date.now()) {
  return new Date(nowMs + KST_OFFSET_MS).toISOString().slice(0, 10);
}

function dayNumber(day) {
  const parts = calendarParts(day);
  return parts ? Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS : null;
}

function normalizedPhone(value) {
  return String(value || '').replace(/\D/g, '');
}

function isShipped(order) {
  const status = String(order?.status || '').trim();
  return status === 'shipped' || status === '출고완료' || Boolean(order?.ship_date);
}

function salesRecipient(value, routes) {
  const rawName = String(value || '').trim();
  const canonicalName = canonicalAlertRecipientName(rawName);
  if (!canonicalName) return null;
  const phone = normalizedPhone(routes[rawName] || routes[canonicalName]);
  return phone ? { recipientName: canonicalName, toPhone: phone } : null;
}

function contactByExactName(name, contacts) {
  const exactName = String(name || '').trim();
  const contact = Object.values(contacts).find(candidate => candidate?.name === exactName);
  const phone = normalizedPhone(contact?.phone);
  return phone ? { recipientName: contact.name, toPhone: phone } : null;
}

function assemblyRecipient(value, contacts) {
  const worker = canonicalAssemblyWorkerName(value);
  if (worker) {
    const phone = normalizedPhone(assemblyWorkerPhone(worker));
    if (phone) return { recipientName: worker, toPhone: phone };
  }
  return contactByExactName(value, contacts);
}

function completed(processes, stepName) {
  return processes.some(process => process.step_name === stepName && process.status === 'completed');
}

function initialCategoryCounts() {
  return Object.fromEntries(Object.values(OVERDUE_REMINDER_KINDS).map(kind => [kind, {
    eligibleOrders: 0,
    routedOrders: 0,
    recipientAssignments: 0,
    unknownAssignments: 0,
  }]));
}

export function collectOverdueReminderGroups({
  orders = [],
  processes = [],
  today,
  nowMs = Date.now(),
  routes = ALERT_ROUTES,
  internalContacts = INTERNAL_ALERT_CONTACTS,
} = {}) {
  const kstDate = today || kstDayFromNow(nowMs);
  if (!calendarParts(kstDate)) throw new TypeError('today must be a valid YYYY-MM-DD calendar date');
  const todayNumber = dayNumber(kstDate);
  const processesByOrder = new Map();
  for (const process of processes) {
    const orderId = Number(process?.order_id);
    if (!Number.isFinite(orderId)) continue;
    if (!processesByOrder.has(orderId)) processesByOrder.set(orderId, []);
    processesByOrder.get(orderId).push(process);
  }

  const categoryCounts = initialCategoryCounts();
  const unknownAssignments = [];
  const grouped = new Map();
  const routedOrders = new Map(Object.values(OVERDUE_REMINDER_KINDS).map(kind => [kind, new Set()]));
  let missingOrInvalidDue = 0;

  const addUnknown = (kind, orderId, role, value) => {
    categoryCounts[kind].unknownAssignments += 1;
    unknownAssignments.push({ kind, orderId, role, value: String(value || '').trim() || null });
  };

  const addRecipient = (kind, recipient, orderInfo) => {
    if (!recipient?.toPhone) return;
    const dedupeKey = `${kind}:${recipient.toPhone}:${orderInfo.orderId}`;
    if (addRecipient.seen.has(dedupeKey)) return;
    addRecipient.seen.add(dedupeKey);
    const groupKey = `${kind}:${recipient.toPhone}`;
    if (!grouped.has(groupKey)) {
      grouped.set(groupKey, {
        kind,
        recipientName: recipient.recipientName,
        toPhone: recipient.toPhone,
        kstDate,
        orders: [],
      });
    }
    grouped.get(groupKey).orders.push(orderInfo);
    categoryCounts[kind].recipientAssignments += 1;
    routedOrders.get(kind).add(orderInfo.orderId);
  };
  addRecipient.seen = new Set();

  for (const order of orders) {
    if (order?.status !== 'in_production' || isShipped(order)) continue;
    const orderId = Number(order.id);
    if (!Number.isFinite(orderId)) continue;
    const dueDay = normalizeDueDateToKstDay(order.due_date);
    if (!dueDay) {
      missingOrInvalidDue += 1;
      continue;
    }
    const overdueDays = todayNumber - dayNumber(dueDay);
    const orderInfo = {
      orderId,
      clientName: String(order.client_name || '').trim() || `주문 ${orderId}`,
      dueDay,
      daysLeft: -overdueDays,
      overdueDays,
    };
    const orderProcesses = processesByOrder.get(orderId) || [];
    const sales = salesRecipient(order.sales_person, routes);

    if (overdueDays >= 10) {
      const kind = OVERDUE_REMINDER_KINDS.UNSHIPPED;
      categoryCounts[kind].eligibleOrders += 1;
      if (sales) addRecipient(kind, sales, orderInfo);
      else addUnknown(kind, orderId, 'salesperson', order.sales_person);
    }

    if (overdueDays >= 1 && !completed(orderProcesses, '설비작업')) {
      const kind = OVERDUE_REMINDER_KINDS.EQUIPMENT;
      categoryCounts[kind].eligibleOrders += 1;
      if (sales) addRecipient(kind, sales, orderInfo);
      else addUnknown(kind, orderId, 'salesperson', order.sales_person);
      const assemblyRows = orderProcesses.filter(process => process.step_name === '조립작업');
      const actualAssembly = [];
      for (const process of assemblyRows) {
        const recipient = assemblyRecipient(process.started_by, internalContacts);
        if (recipient) actualAssembly.push(recipient);
      }
      if (actualAssembly.length === 0) addUnknown(kind, orderId, 'assembly', null);
      for (const recipient of actualAssembly) addRecipient(kind, recipient, orderInfo);
      const fixedRecipients = [internalContacts.packing, internalContacts.welding, internalContacts.assembly]
        .map(contact => contactByExactName(contact?.name, internalContacts))
        .filter(Boolean);
      for (const recipient of fixedRecipients) addRecipient(kind, recipient, orderInfo);
    }

    if (overdueDays >= -3 && !completed(orderProcesses, '포장')) {
      const kind = OVERDUE_REMINDER_KINDS.PACKING;
      categoryCounts[kind].eligibleOrders += 1;
      addRecipient(kind, contactByExactName(internalContacts.packing?.name, internalContacts), orderInfo);
    }
  }

  for (const kind of Object.values(OVERDUE_REMINDER_KINDS)) {
    categoryCounts[kind].routedOrders = routedOrders.get(kind).size;
  }
  const groups = [...grouped.values()]
    .map(group => ({ ...group, orders: group.orders.sort((a, b) => b.overdueDays - a.overdueDays || a.orderId - b.orderId) }))
    .sort((a, b) => a.kind.localeCompare(b.kind) || a.recipientName.localeCompare(b.recipientName));

  return {
    kstDate,
    today: kstDate,
    scannedOrders: orders.length,
    missingOrInvalidDue,
    categoryCounts,
    groups,
    unknownAssignments,
  };
}

function reminderAction(kind, daysLeft) {
  if (kind === OVERDUE_REMINDER_KINDS.PACKING) {
    return daysLeft >= 0
      ? '포장이 완료되지 않았으니 납기에 맞춰 포장을 서둘러 주시기 바랍니다.'
      : '빠른 출고를 위해 포장을 서둘러 주시기 바랍니다.';
  }
  if (kind === OVERDUE_REMINDER_KINDS.EQUIPMENT) {
    return '설비작업을 확인하시고 완료 처리해 주시기 바랍니다.';
  }
  return '실제 출고 여부를 확인하시고, 출고된 주문은 출고완료 처리해 주시기 바랍니다.';
}

function packingBucketSummary(orders) {
  const before = orders.filter(order => order.daysLeft > 0).length;
  const today = orders.filter(order => order.daysLeft === 0).length;
  const overdue = orders.filter(order => order.daysLeft < 0).length;
  return `납기 전 ${before}건 · 오늘 납기 ${today}건 · 납기 경과 ${overdue}건`;
}

export function buildOverdueReminderMessage(group) {
  const copy = MESSAGE_COPY[group?.kind];
  if (!copy) throw new TypeError('unknown overdue reminder kind');
  const orders = Array.isArray(group.orders) ? group.orders : [];
  const subject = `[생산현황 ${copy.title}]`;
  return buildProductionAlertMessage({
    subject,
    recipientName: group.recipientName,
    date: group.kstDate,
    summary: group.kind === OVERDUE_REMINDER_KINDS.PACKING ? packingBucketSummary(orders) : '',
    items: orders.map(order => ({
      ...order,
      daysLeft: Number.isInteger(order.daysLeft) ? order.daysLeft : -order.overdueDays,
      action: reminderAction(group.kind, Number.isInteger(order.daysLeft) ? order.daysLeft : -order.overdueDays),
    })),
    url: SITE_URL,
  });
}
