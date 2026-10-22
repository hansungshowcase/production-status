const MAX_INT4 = 2147483647;

export function parsePositiveInt4Id(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 1 && value <= MAX_INT4 ? value : null;
  }

  if (typeof value !== 'string') return null;

  const normalized = value.trim();
  if (!/^\d+$/.test(normalized)) return null;

  const parsed = Number(normalized);
  return parsed >= 1 && parsed <= MAX_INT4 ? parsed : null;
}
