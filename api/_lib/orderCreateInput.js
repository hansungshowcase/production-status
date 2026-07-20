import { normalizeOrderMemoForStorage } from '../../src/utils/orderText.js';
import { isCanonicalCalendarDate } from '../../src/utils/dateUtils.js';

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

function normalizeSalesPerson(value) {
  if (value === undefined || value === null) return value;
  const trimmed = String(value).trim();
  if (!trimmed) return null;
  const compact = trimmed.replace(/\s+/g, '');
  if (compact.includes('김보수')) return '이준형';
  return trimmed;
}

export class OrderCreateInputValidationError extends Error {
  constructor(message) {
    super(message);
    this.name = 'OrderCreateInputValidationError';
  }
}

export function assertImageBackedOrderHasCanonicalDueDate(order) {
  if (order.work_order_image_url && !isCanonicalCalendarDate(order.due_date)) {
    throw new OrderCreateInputValidationError(
      'work_order_image_url이 있는 주문은 due_date를 실제 YYYY-MM-DD 날짜로 입력해야 합니다.',
    );
  }
}

// 작업지시서 이미지 등록 건은 담당자(신은철·이준형)를 반드시 지정해야 한다.
export const ALLOWED_SALES_PERSONS = ['신은철', '이준형'];

export function assertImageBackedOrderHasSalesPerson(order) {
  if (order.work_order_image_url && !ALLOWED_SALES_PERSONS.includes(order.sales_person)) {
    throw new OrderCreateInputValidationError(
      'work_order_image_url이 있는 주문은 담당자(신은철·이준형)를 지정해야 합니다.',
    );
  }
}

export function mutationTouchesImageDueInvariant(mutation) {
  return Object.hasOwn(mutation, 'due_date') || Object.hasOwn(mutation, 'work_order_image_url');
}

export function normalizeOrderCreateInput(input) {
  const body = normalizeOrderMutationInput(input);

  assertImageBackedOrderHasCanonicalDueDate(body);
  assertImageBackedOrderHasSalesPerson(body);

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

  if (body.sales_person !== undefined) {
    body.sales_person = normalizeSalesPerson(body.sales_person);
  }

  if (body.notes !== undefined) {
    body.notes = normalizeOrderMemoForStorage(body.notes);
  }

  return body;
}
