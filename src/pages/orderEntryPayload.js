import { normalizeOrderMemoForStorage } from '../utils/orderText.js';

export function normalizeOptionalPositiveNumber(value) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value === 'number') return Number.isFinite(value) && value > 0 ? value : null;

  const compact = String(value).replace(/,/g, '');
  const match = compact.match(/\d+(?:\.\d+)?/);
  if (!match) return null;

  const number = Number(match[0]);
  return Number.isFinite(number) && number > 0 ? number : null;
}

export function normalizeQuantity(value) {
  return normalizeOptionalPositiveNumber(value) ?? 1;
}

export function normalizeOrderNotes(value) {
  return normalizeOrderMemoForStorage(value);
}

export function buildOrderPayload(form, workOrderImageUrl, fallbackOrderDate) {
  return {
    order_date: form.order_date || fallbackOrderDate,
    due_date: form.due_date || null,
    sales_person: form.sales_person || null,
    client_name: form.client_name.trim(),
    phone: form.phone || null,
    product_type: form.product_type.trim(),
    door_type: form.door_type || null,
    width: normalizeOptionalPositiveNumber(form.width),
    depth: normalizeOptionalPositiveNumber(form.depth),
    height: normalizeOptionalPositiveNumber(form.height),
    quantity: normalizeQuantity(form.quantity),
    color: form.color || null,
    sale_amount: normalizeOptionalPositiveNumber(form.sale_amount),
    balance: normalizeOptionalPositiveNumber(form.balance),
    delivery_address: form.delivery_address?.trim() || null,
    freight_payment: form.freight_payment?.trim() || null,
    lead_source: form.lead_source || null,
    notes: normalizeOrderNotes(form.notes),
    work_order_image_url: workOrderImageUrl || null,
  };
}
