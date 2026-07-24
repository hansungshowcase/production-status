import { normalizeOrderMemoForStorage } from '../utils/orderText.js';
import { isCanonicalCalendarDate } from '../utils/dateUtils.js';

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

export function normalizeSalesPerson(value) {
  if (value === undefined || value === null) return null;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const compact = trimmed.replace(/\s+/g, '');
  if (compact.includes('김보수')) return '이준형';
  return trimmed;
}

export function validateOrderEntryForm(form, hasWorkOrderImage = false) {
  const errors = {};
  if (!form.client_name || !form.client_name.trim()) {
    errors.client_name = '거래처를 입력해주세요';
  }
  if (!form.product_type || !form.product_type.trim()) {
    errors.product_type = '사양을 선택해주세요';
  }
  if (hasWorkOrderImage && !isCanonicalCalendarDate(form.due_date)) {
    errors.due_date = '작업지시서 등록은 납기일을 입력해주세요';
  }
  if (hasWorkOrderImage && !['신은철', '이준형'].includes(normalizeSalesPerson(form.sales_person))) {
    errors.sales_person = '작업지시서 등록은 담당자를 선택해주세요';
  }
  if (
    hasWorkOrderImage
    && (String(form.quantity ?? '').trim().startsWith('-') || normalizeOptionalPositiveNumber(form.quantity) === null)
  ) {
    errors.quantity = '작업지시서 등록은 수량을 1 이상 입력해주세요';
  }
  return errors;
}

export function buildOrderPayload(form, workOrderImageUrl, fallbackOrderDate) {
  return {
    order_date: form.order_date || fallbackOrderDate,
    due_date: form.due_date || null,
    sales_person: normalizeSalesPerson(form.sales_person),
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
