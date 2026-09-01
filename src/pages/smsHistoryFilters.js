export const NOTIFICATION_RECIPIENT_FILTERS = [
  '이시아 부장',
  '최우석 이사',
  '이정섭 부장',
  '김보수 팀장',
  '박상규 공장장',
  '정영호 팀장',
  '신은철',
  '이준형',
  '강종효',
  '카우사르',
  '나타왓',
  '마카라',
  '백승정',
  '까지',
];

const KST_DATE_PARTS = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

const KST_DATE_HEADING = new Intl.DateTimeFormat('ko-KR', {
  timeZone: 'Asia/Seoul',
  year: 'numeric',
  month: 'long',
  day: 'numeric',
  weekday: 'short',
});

export function getKstDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';

  const parts = Object.fromEntries(
    KST_DATE_PARTS.formatToParts(date)
      .filter(part => part.type !== 'literal')
      .map(part => [part.type, part.value]),
  );
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function dateHeading(dateKey) {
  if (dateKey === 'unknown') return '날짜 정보 없음';
  const date = new Date(`${dateKey}T00:00:00+09:00`);
  return KST_DATE_HEADING.format(date);
}

export function groupNotificationsByKstDate(items = []) {
  const groups = new Map();
  const sortedItems = [...items].sort((left, right) => {
    const leftTime = new Date(left?.sent_at).getTime();
    const rightTime = new Date(right?.sent_at).getTime();
    const safeLeft = Number.isNaN(leftTime) ? Number.NEGATIVE_INFINITY : leftTime;
    const safeRight = Number.isNaN(rightTime) ? Number.NEGATIVE_INFINITY : rightTime;
    return safeRight - safeLeft;
  });
  for (const item of sortedItems) {
    const date = getKstDateKey(item?.sent_at);
    if (!groups.has(date)) {
      groups.set(date, { date, label: dateHeading(date), items: [] });
    }
    groups.get(date).items.push(item);
  }
  return [...groups.values()];
}

export function notificationPageNumbers(currentPage, totalPages, maxVisible = 5) {
  const total = Math.max(0, Math.trunc(Number(totalPages) || 0));
  if (total === 0) return [];

  const current = Math.min(total, Math.max(1, Math.trunc(Number(currentPage) || 1)));
  const visible = Math.min(total, Math.max(1, Math.trunc(Number(maxVisible) || 5)));
  let start = Math.max(1, current - Math.floor(visible / 2));
  let end = start + visible - 1;

  if (end > total) {
    end = total;
    start = end - visible + 1;
  }

  return Array.from({ length: visible }, (_, index) => start + index);
}
