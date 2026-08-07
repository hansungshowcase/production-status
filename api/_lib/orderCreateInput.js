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

function isNonBlankText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

export function assertImageBackedOrderHasClientName(order) {
  if (order.work_order_image_url && !isNonBlankText(order.client_name)) {
    throw new OrderCreateInputValidationError(
      '작업지시서가 등록된 주문은 거래처를 비워둘 수 없습니다.',
    );
  }
}

export function assertImageBackedOrderHasCanonicalOrderDate(order) {
  if (order.work_order_image_url && !isCanonicalCalendarDate(order.order_date)) {
    throw new OrderCreateInputValidationError(
      '작업지시서가 등록된 주문은 발주일을 실제 날짜(예: 2026-08-04)로 입력해야 합니다.',
    );
  }
}

export function assertImageBackedOrderHasCanonicalDueDate(order) {
  if (order.work_order_image_url && !isCanonicalCalendarDate(order.due_date)) {
    throw new OrderCreateInputValidationError(
      '작업지시서가 등록된 주문은 납기일을 실제 날짜(예: 2026-08-04)로 입력해야 합니다.',
    );
  }
}

// 작업지시서 이미지 등록 건은 담당자(신은철·이준형)를 반드시 지정해야 한다.
export const ALLOWED_SALES_PERSONS = ['신은철', '이준형'];

export function assertImageBackedOrderHasSalesPerson(order) {
  if (order.work_order_image_url && !ALLOWED_SALES_PERSONS.includes(order.sales_person)) {
    throw new OrderCreateInputValidationError(
      '작업지시서가 등록된 주문은 담당자(신은철·이준형)를 지정해야 합니다.',
    );
  }
}

export function assertImageBackedOrderHasProductType(order) {
  if (order.work_order_image_url && !isNonBlankText(order.product_type)) {
    throw new OrderCreateInputValidationError(
      '작업지시서가 등록된 주문은 사양을 비워둘 수 없습니다.',
    );
  }
}

export function assertImageBackedOrderHasPositiveQuantity(order) {
  const quantityText = String(order.quantity ?? '').trim();
  if (
    order.work_order_image_url
    && (quantityText.startsWith('-') || normalizeOptionalPositiveNumber(order.quantity) === null)
  ) {
    throw new OrderCreateInputValidationError(
      '작업지시서가 등록된 주문은 수량을 1 이상의 숫자로 입력해야 합니다.',
    );
  }
}

const IMAGE_ORDER_INVARIANT_FIELDS = [
  'client_name',
  'order_date',
  'due_date',
  'sales_person',
  'product_type',
  'quantity',
  'work_order_image_url',
];

export function mutationTouchesImageDueInvariant(mutation) {
  return IMAGE_ORDER_INVARIANT_FIELDS.some(field => Object.hasOwn(mutation, field));
}

export function mutationChangesImageOrderInvariant(order, mutation) {
  return IMAGE_ORDER_INVARIANT_FIELDS.some((field) => {
    if (!Object.hasOwn(mutation, field)) return false;

    const currentValue = order[field] ?? null;
    const nextValue = mutation[field] ?? null;
    if (field !== 'quantity' || currentValue === null || nextValue === null) {
      return currentValue !== nextValue;
    }

    const currentText = String(currentValue).trim();
    const nextText = String(nextValue).trim();
    if (!currentText || !nextText) return currentValue !== nextValue;

    const currentNumber = Number(currentText);
    const nextNumber = Number(nextText);
    if (!Number.isFinite(currentNumber) || !Number.isFinite(nextNumber)) {
      return currentValue !== nextValue;
    }

    return currentNumber !== nextNumber;
  });
}

export function normalizeOrderCreateInput(input) {
  const body = normalizeOrderMutationInput(input);

  assertImageBackedOrderHasClientName(body);
  assertImageBackedOrderHasCanonicalOrderDate(body);
  assertImageBackedOrderHasCanonicalDueDate(body);
  assertImageBackedOrderHasSalesPerson(body);
  assertImageBackedOrderHasProductType(body);
  assertImageBackedOrderHasPositiveQuantity(body);

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
