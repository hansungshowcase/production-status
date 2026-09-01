export const TEAM_MEMBER_FILTERS = [
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
  for (const item of items) {
    const date = getKstDateKey(item?.sent_at);
    if (!groups.has(date)) {
      groups.set(date, { date, label: dateHeading(date), items: [] });
    }
    groups.get(date).items.push(item);
  }
  return [...groups.values()];
}
