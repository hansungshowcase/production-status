import { normalizeOrderMemoForStorage } from '../../src/utils/orderText.js';

function normalizeOptionalPositiveNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;

  const compact = String(value).replace(/,/g, '');
  const match = compact.match(/\d+(?:\.\d+)?/);
  if (!match) return null;

  const number = Number(match[0]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

function normalizeQuantity(value) {
  return normalizeOptionalPositiveNumber(value) ?? 1;
}

function normalizeOptionalText(value) {
  if (value === undefined || value === null) return value;
  const trimmed = String(value).trim();
  return trimmed || null;
}

export function normalizeOrderCreateInput(input) {
  const body = normalizeOrderMutationInput(input);

  body.width = normalizeOptionalPositiveNumber(body.width);
  body.depth = normalizeOptionalPositiveNumber(body.depth);
  body.height = normalizeOptionalPositiveNumber(body.height);
  body.quantity = normalizeQuantity(body.quantity);
  body.sale_amount = normalizeOptionalPositiveNumber(body.sale_amount);
  body.balance = normalizeOptionalPositiveNumber(body.balance);
  body.delivery_address = normalizeOptionalText(body.delivery_address);
  body.freight_payment = normalizeOptionalText(body.freight_payment);

  return body;
}

export function normalizeOrderMutationInput(input) {
  const body = { ...(input || {}) };

  if (body.delivery_address !== undefined) {
    body.delivery_address = normalizeOptionalText(body.delivery_address);
  }

  if (body.freight_payment !== undefined) {
    body.freight_payment = normalizeOptionalText(body.freight_payment);
  }

  if (body.notes !== undefined) {
    body.notes = normalizeOrderMemoForStorage(body.notes);
  }

  return body;
}
