/**
 * 날짜 유틸리티 - 납기일 관련 계산 및 포맷팅
 * 다양한 시트 날짜 형식 지원: "2024. 7. 15", "2026-03-25", "3월25일", "3월25알" 등
 */

/**
 * 다양한 형식의 날짜 문자열을 Date 객체로 파싱
 */
export function isCanonicalCalendarDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  if (value.startsWith('0000-')) return false;

  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
}

export function parseDate(dateStr) {
  if (!dateStr) return null;
  if (dateStr instanceof Date) return isNaN(dateStr.getTime()) ? null : dateStr;

  const str = String(dateStr).trim();
  if (!str) return null;

  // ISO format: "2026-03-25" or "2026-03-25T..."
  if (/^\d{4}-\d{1,2}-\d{1,2}/.test(str)) {
    const d = new Date(str);
    if (!isNaN(d.getTime())) return d;
  }

  // Korean dot format: "2024. 7. 15" or "2024.7.15"
  const dotMatch = str.match(/(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})/);
  if (dotMatch) {
    return new Date(Number(dotMatch[1]), Number(dotMatch[2]) - 1, Number(dotMatch[3]));
  }

  // Korean month-day format: "3월25일", "3월25알", "납기일 7월3일도착"
  const monthDayMatch = str.match(/(\d{1,2})\s*월\s*(\d{1,2})\s*[일알]?/);
  if (monthDayMatch) {
    const now = new Date();
    const month = Number(monthDayMatch[1]) - 1;
    const day = Number(monthDayMatch[2]);
    // Assume current year; if the date is more than 6 months in the past, assume next year
    let year = now.getFullYear();
    const candidate = new Date(year, month, day);
    if (candidate.getTime() < now.getTime() - 180 * 24 * 60 * 60 * 1000) {
      year++;
    }
    return new Date(year, month, day);
  }

  // Slash format: "2024/7/15" or "7/15"
  const slashMatch = str.match(/^(\d{1,4})[/](\d{1,2})[/](\d{1,2})$/);
  if (slashMatch) {
    const first = Number(slashMatch[1]);
    if (first > 31) {
      // year/month/day
      return new Date(first, Number(slashMatch[2]) - 1, Number(slashMatch[3]));
    }
  }
  const shortSlash = str.match(/^(\d{1,2})[/](\d{1,2})$/);
  if (shortSlash) {
    const now = new Date();
    return new Date(now.getFullYear(), Number(shortSlash[1]) - 1, Number(shortSlash[2]));
  }

  // Fallback: try native Date parsing
  const fallback = new Date(str);
  if (!isNaN(fallback.getTime())) return fallback;

  return null;
}

function formatIsoDate(date) {
  return [
    date.getFullYear(),
    String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0'),
  ].join('-');
}

export function extractDueDateFromText(text) {
  const str = String(text || '');
  if (!str.trim()) return null;

  const dueLabel = '(?:납기(?:일자|일)?|납품(?:일자|일)?|출고(?:일자|일)?)';
  const isoMatch = str.match(new RegExp(`${dueLabel}\\s*[:_\\-\\s]*((?:20)?\\d{2}\\s*[-./]\\s*\\d{1,2}\\s*[-./]\\s*\\d{1,2})`));
  if (isoMatch) {
    const [rawYear, rawMonth, rawDay] = isoMatch[1].replace(/\s/g, '').split(/[-./]/);
    const year = rawYear.length === 2 ? `20${rawYear}` : rawYear;
    const candidate = `${year}-${rawMonth.padStart(2, '0')}-${rawDay.padStart(2, '0')}`;
    return isCanonicalCalendarDate(candidate) ? candidate : null;
  }

  const monthDayMatch = str.match(new RegExp(`${dueLabel}\\s*[:_\\-\\s]*(\\d{1,2}\\s*월\\s*\\d{1,2}\\s*[일알]?)`));
  if (monthDayMatch) {
    const date = parseDate(monthDayMatch[1]);
    const parts = monthDayMatch[1].match(/(\d{1,2})\s*월\s*(\d{1,2})/);
    if (!date || !parts) return null;
    if (date.getMonth() + 1 !== Number(parts[1]) || date.getDate() !== Number(parts[2])) return null;
    return formatIsoDate(date);
  }

  return null;
}

export function extractDueDateFromOrder(order) {
  if (!order) return null;
  if (order.due_date) return order.due_date;

  return extractDueDateFromText([
    order.notes,
    order.remarks,
    order.etc_notes,
  ].filter(Boolean).join('\n'));
}

/**
 * 납기일까지 남은 일수 계산
 * 양수: 남은 일수, 음수: 초과 일수
 */
export function getDaysUntilDue(dueDate) {
  const due = parseDate(dueDate);
  if (!due) return null;

  const now = new Date();
  // Compare dates only (ignore time)
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const dueDay = new Date(due.getFullYear(), due.getMonth(), due.getDate());

  return Math.ceil((dueDay - today) / (1000 * 60 * 60 * 24));
}

/**
 * 납기 상태를 라벨/색상으로 반환
 * @param {string|Date} dueDate - 납기일
 * @param {string} status - 주문 상태 ('shipped', 'in_production', etc.)
 * @returns {{ label: string, color: string, isUrgent: boolean, isOverdue: boolean, days: number|null }}
 */
export function formatDueStatus(dueDate, status) {
  const days = getDaysUntilDue(dueDate);

  // 출고 완료된 건은 납기 알림 불필요
  if (status === 'shipped' || status === '출고완료') {
    return { label: null, color: null, isUrgent: false, isOverdue: false, days };
  }

  if (days === null) {
    return { label: null, color: null, isUrgent: false, isOverdue: false, days: null };
  }

  if (days < 0) {
    return {
      label: `납기초과 D+${Math.abs(days)}`,
      color: 'red',
      isUrgent: true,
      isOverdue: true,
      days,
    };
  }

  if (days <= 3) {
    return {
      label: `납기임박 D-${days}`,
      color: 'orange',
      isUrgent: true,
      isOverdue: false,
      days,
    };
  }

  return {
    label: null,
    color: null,
    isUrgent: false,
    isOverdue: false,
    days,
  };
}
