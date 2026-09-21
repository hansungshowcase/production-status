import { parsePositiveIntegerQuantity } from '../../src/utils/quantity.js';

function normalizeDate(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!/^\d{4}-\d{2}-\d{2}/.test(trimmed)) return null;
  return trimmed.slice(0, 10);
}

function normalizeUnits(value) {
  return parsePositiveIntegerQuantity(value);
}

function getEquipmentReachedDate(row) {
  return normalizeDate(row.equipment_completed_at)
    || normalizeDate(row.later_step_started_at)
    || normalizeDate(row.ship_date);
}

export function todayInSeoul(now = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(now);
  const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

export function calculateDeliveryAdherence(rows, today = todayInSeoul()) {
  const summary = {
    total_production_units: 0,
    measurable_units: 0,
    on_time_units: 0,
    missed_units: 0,
    missing_due_date_units: 0,
    invalid_quantity_orders: 0,
    invalid_quantity_order_ids: [],
    adherence_rate: 0,
  };

  for (const row of rows) {
    const units = normalizeUnits(row.quantity);
    if (units === null) {
      summary.invalid_quantity_orders += 1;
      if (row.id !== undefined && row.id !== null) summary.invalid_quantity_order_ids.push(Number(row.id));
      continue;
    }
    const dueDate = normalizeDate(row.due_date);
    const reachedDate = getEquipmentReachedDate(row);

    summary.total_production_units += units;

    if (!dueDate) {
      summary.missing_due_date_units += units;
      continue;
    }

    summary.measurable_units += units;
    if (dueDate >= today || (reachedDate && reachedDate <= dueDate)) {
      summary.on_time_units += units;
    } else {
      summary.missed_units += units;
    }
  }

  summary.adherence_rate = summary.measurable_units > 0
    ? Number(((summary.on_time_units / summary.measurable_units) * 100).toFixed(1))
    : 0;

  return summary;
}
