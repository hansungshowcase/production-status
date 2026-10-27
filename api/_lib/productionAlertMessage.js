const MAX_MESSAGE_BYTES = 2000;
const MAX_LISTED_ORDERS = 10;
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

function truncateUtf8(value, maxBytes) {
  let result = '';
  for (const character of String(value ?? '')) {
    if (Buffer.byteLength(result + character, 'utf8') > maxBytes) break;
    result += character;
  }
  return result;
}

export function formatProductionDueSentence(daysLeft) {
  if (!Number.isInteger(daysLeft)) return '납기일 확인이 필요합니다.';
  if (daysLeft > 0) return `납기까지 ${daysLeft}일 남았습니다.`;
  if (daysLeft === 0) return '오늘이 납기일입니다.';
  return `납기가 ${Math.abs(daysLeft)}일 지났습니다.`;
}

function validCalendarDay(value) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function normalizeProductionDueDay(value) {
  if (value instanceof Date) {
    return Number.isFinite(value.getTime())
      ? new Date(value.getTime() + KST_OFFSET_MS).toISOString().slice(0, 10)
      : null;
  }
  const raw = String(value ?? '').trim();
  if (validCalendarDay(raw)) return raw;
  const timestamp = /^(\d{4}-\d{2}-\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,9}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(raw);
  if (!timestamp || !validCalendarDay(timestamp[1])) return null;
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
  return Number.isFinite(parsed) ? new Date(parsed + KST_OFFSET_MS).toISOString().slice(0, 10) : null;
}

export function formatProductionDueDay(value) {
  return normalizeProductionDueDay(value) || '확인 필요';
}

function calendarDayNumber(day) {
  if (!validCalendarDay(day)) return null;
  const [year, month, date] = day.split('-').map(Number);
  return Date.UTC(year, month - 1, date) / (24 * 60 * 60 * 1000);
}

function copyDaysLeft(dueDay, referenceDate, providedDaysLeft) {
  const normalizedDueDay = normalizeProductionDueDay(dueDay);
  if (!normalizedDueDay) return null;
  const dueNumber = calendarDayNumber(normalizedDueDay);
  const referenceNumber = calendarDayNumber(String(referenceDate || ''));
  if (dueNumber !== null && referenceNumber !== null) return dueNumber - referenceNumber;
  return Number.isInteger(providedDaysLeft) ? providedDaysLeft : null;
}

function orderLines(item, referenceDate) {
  const clientName = truncateUtf8(String(item?.clientName || '').trim() || '거래처명 확인 필요', 72);
  const normalizedDueDay = normalizeProductionDueDay(item?.dueDay);
  const dueDay = normalizedDueDay || '확인 필요';
  const daysLeft = copyDaysLeft(item?.dueDay, item?.referenceDate || referenceDate, item?.daysLeft);
  const context = [
    formatProductionDueSentence(daysLeft),
    truncateUtf8(item?.detail, 180),
  ].filter(Boolean).join(' ');
  return `- ${clientName} | 납기 ${dueDay}\n  ${context}`;
}

export function buildProductionAlertMessage({
  subject,
  recipientName,
  date,
  items = [],
  summary = '',
  footerLines = [],
  url = '',
} = {}) {
  const safeSubject = truncateUtf8(subject || '[한성쇼케이스 생산 알림]', 120);
  const safeRecipient = truncateUtf8(recipientName || '담당자', 60);
  const totalCount = Array.isArray(items) ? items.length : 0;
  const prefix = [
    safeSubject,
    `${safeRecipient}님,`,
    ...(date ? [`기준일: ${truncateUtf8(date, 32)}`] : []),
    `대상: ${totalCount}건`,
    ...(summary ? [truncateUtf8(summary, 300)] : []),
    '',
  ];
  const suffix = [
    '',
    ...new Set([
      ...items.map(item => item?.action),
      ...footerLines,
    ].map(line => truncateUtf8(String(line ?? '').trim(), 300)).filter(Boolean)),
    ...(url ? [truncateUtf8(url, 200)] : []),
  ];
  let listed = items.slice(0, MAX_LISTED_ORDERS).map(item => orderLines(item, date));
  let text = '';
  while (true) {
    const omittedCount = totalCount - listed.length;
    const omitted = omittedCount > 0 ? [`외 ${omittedCount}건`] : [];
    text = [...prefix, ...(listed.length ? [listed.join('\n\n')] : []), ...omitted, ...suffix].join('\n');
    if (Buffer.byteLength(text, 'utf8') <= MAX_MESSAGE_BYTES || listed.length === 0) break;
    listed = listed.slice(0, -1);
  }
  return {
    subject: safeSubject,
    text,
    totalCount,
    listedCount: listed.length,
    omittedCount: totalCount - listed.length,
  };
}
