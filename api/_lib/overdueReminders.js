import { ALERT_ROUTES, canonicalAlertRecipientName } from './alertRoutes.js';
import {
  INTERNAL_ALERT_CONTACTS,
  assemblyWorkerPhone,
  canonicalAssemblyWorkerName,
} from './internalProductionAlerts.js';

export const OVERDUE_REMINDER_KINDS = Object.freeze({
  UNSHIPPED: 'internal_overdue_unshipped',
  EQUIPMENT: 'internal_overdue_equipment',
  PACKING: 'internal_overdue_packing',
});

const DAY_MS = 24 * 60 * 60 * 1000;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const SITE_URL = 'https://production-status.vercel.app';

const MESSAGE_COPY = Object.freeze({
  [OVERDUE_REMINDER_KINDS.UNSHIPPED]: {
    title: '납기 지연 출고 미완료',
    action: '출고 여부 확인 후 출고완료 처리해 주세요.',
  },
  [OVERDUE_REMINDER_KINDS.EQUIPMENT]: {
    title: '납기 지연 설비작업 미완료',
    action: '설비작업 확인 후 완료 처리해 주세요.',
  },
  [OVERDUE_REMINDER_KINDS.PACKING]: {
    title: '납기 지연 포장 미완료',
    action: '포장 작업 확인 후 완료 처리해 주세요.',
  },
});

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
    if (overdueDays < 1) continue;
    const orderInfo = {
      orderId,
      clientName: String(order.client_name || '').trim() || `주문 ${orderId}`,
      dueDay,
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

    const fixedRecipients = [internalContacts.packing, internalContacts.welding, internalContacts.assembly]
      .map(contact => contactByExactName(contact?.name, internalContacts))
      .filter(Boolean);
    const assemblyRows = orderProcesses.filter(process => process.step_name === '조립작업');
    const actualAssembly = [];
    for (const process of assemblyRows) {
      const recipient = assemblyRecipient(process.started_by, internalContacts);
      if (recipient) actualAssembly.push(recipient);
    }

    for (const [kind, stepName] of [
      [OVERDUE_REMINDER_KINDS.EQUIPMENT, '설비작업'],
      [OVERDUE_REMINDER_KINDS.PACKING, '포장'],
    ]) {
      if (completed(orderProcesses, stepName)) continue;
      categoryCounts[kind].eligibleOrders += 1;
      if (sales) addRecipient(kind, sales, orderInfo);
      else addUnknown(kind, orderId, 'salesperson', order.sales_person);
      if (actualAssembly.length === 0) addUnknown(kind, orderId, 'assembly', null);
      for (const recipient of actualAssembly) addRecipient(kind, recipient, orderInfo);
      for (const recipient of fixedRecipients) addRecipient(kind, recipient, orderInfo);
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

function truncateUtf8(value, maxBytes) {
  let result = '';
  for (const character of String(value || '')) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break;
    result += character;
  }
  return result;
}

function orderLine(order) {
  const client = truncateUtf8(order.clientName, 72);
  return `- 주문 #${order.orderId} | ${client} | 납기 ${order.dueDay} | ${order.overdueDays}일 지연`;
}

export function buildOverdueReminderMessage(group) {
  const copy = MESSAGE_COPY[group?.kind];
  if (!copy) throw new TypeError('unknown overdue reminder kind');
  const orders = Array.isArray(group.orders) ? group.orders : [];
  const totalCount = orders.length;
  const subject = `[생산현황 ${copy.title}]`;
  const prefix = [
    subject,
    `수신: ${group.recipientName}`,
    `기준일: ${group.kstDate}`,
    `대상: ${totalCount}건`,
    '',
  ];
  const suffix = ['', `요청: ${copy.action}`, SITE_URL];
  let listed = orders.slice(0, 10).map(orderLine);
  let text;
  while (true) {
    const omittedCount = totalCount - listed.length;
    const omitted = omittedCount > 0 ? [`외 ${omittedCount}건`] : [];
    text = [...prefix, ...listed, ...omitted, ...suffix].join('\n');
    if (Buffer.byteLength(text, 'utf8') <= 2000 || listed.length === 0) break;
    listed = listed.slice(0, -1);
  }
  return {
    subject,
    text,
    totalCount,
    listedCount: listed.length,
    omittedCount: totalCount - listed.length,
  };
}
