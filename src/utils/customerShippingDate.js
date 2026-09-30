const CUSTOMER_SHIPPING_OFFSET_DAYS = 3;

function canonicalDate(value) {
  if (!value) return null;
  const date = String(value).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return null;

  const parsed = new Date(`${date}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return null;
  return date;
}

export function addCalendarDays(value, days) {
  const date = canonicalDate(value);
  if (!date) return null;

  const parsed = new Date(`${date}T00:00:00.000Z`);
  parsed.setUTCDate(parsed.getUTCDate() + days);
  return parsed.toISOString().slice(0, 10);
}

export function customerExpectedShipDate(order) {
  const scheduled = canonicalDate(order?.ship_scheduled_date);
  if (scheduled) return scheduled;
  return addCalendarDays(order?.due_date, CUSTOMER_SHIPPING_OFFSET_DAYS);
}

export function customerDeliveryStatus(order, today) {
  if (order?.status === 'shipped') return 'shipped';

  const scheduled = canonicalDate(order?.ship_scheduled_date);
  const currentDate = canonicalDate(today);
  if (scheduled && currentDate && scheduled >= currentDate) return 'rescheduled';
  if (scheduled) return 'adjusting';

  const expected = customerExpectedShipDate(order);
  if (expected && currentDate && expected < currentDate) return 'adjusting';
  return 'on_track';
}
