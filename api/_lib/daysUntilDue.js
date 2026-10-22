const KST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

function kstCalendarEpoch(value) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) return NaN;
  const kst = new Date(timestamp + KST_OFFSET_MS);
  return Date.UTC(kst.getUTCFullYear(), kst.getUTCMonth(), kst.getUTCDate());
}

export function daysUntilDue(dueDate) {
  if (!dueDate) return null;
  const due = kstCalendarEpoch(dueDate);
  const today = kstCalendarEpoch(Date.now());
  return Math.ceil((due - today) / DAY_MS);
}
