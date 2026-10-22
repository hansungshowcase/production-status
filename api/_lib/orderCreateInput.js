import { normalizeOrderMemoForStorage } from '../../src/utils/orderText.js';
import { isCanonicalCalendarDate } from '../../src/utils/dateUtils.js';
import {
  OrderNumericInputError,
  normalizeOptionalDimension,
  normalizeOptionalMoney,
} from '../../src/utils/orderNumericInput.js';
import { parsePositiveIntegerQuantity } from '../../src/utils/quantity.js';

function numericErrorMessage(label, example, allowZero = false) {
  return `${label}은 ${allowZero ? '0 이상의' : '0보다 큰'} 숫자만 입력해야 합니다 (예: ${example}).`;
}

function normalizeDimensionField(value, label) {
  try {
    return normalizeOptionalDimension(value);
  } catch (error) {
    if (error instanceof OrderNumericInputError) {
      throw new OrderCreateInputValidationError(numericErrorMessage(label, '1,200mm'));
    }
    throw error;
  }
}

function normalizeMoneyField(value, label, { allowZero = false } = {}) {
  try {
    return normalizeOptionalMoney(value, { allowZero });
  } catch (error) {
    if (error instanceof OrderNumericInputError) {
      throw new OrderCreateInputValidationError(
        numericErrorMessage(label, '320,000원', allowZero),
      );
    }
    throw error;
  }
}

function normalizeQuantity(value) {
  const quantity = parsePositiveIntegerQuantity(value);
  if (quantity === null) {
    throw new OrderCreateInputValidationError('수량은 1 이상의 정수로 입력해야 합니다(최대 2147483647).');
  }
  return quantity;
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

// 작업지시서 이미지 등록 건은 담당자(신은철·이준형·황보민수)를 반드시 지정해야 한다.
export const ALLOWED_SALES_PERSONS = ['신은철', '이준형', '황보민수'];

export function assertImageBackedOrderHasSalesPerson(order) {
  if (order.work_order_image_url && !ALLOWED_SALES_PERSONS.includes(order.sales_person)) {
    throw new OrderCreateInputValidationError(
      '작업지시서가 등록된 주문은 담당자(신은철·이준형·황보민수)를 지정해야 합니다.',
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
  if (order.work_order_image_url && parsePositiveIntegerQuantity(order.quantity) === null) {
    throw new OrderCreateInputValidationError(
      '작업지시서가 등록된 주문은 수량을 1 이상의 정수로 입력해야 합니다(최대 2147483647).',
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
  const body = normalizeOrderMutationInput(input, { normalizeQuantityField: false });

  assertImageBackedOrderHasClientName(body);
  assertImageBackedOrderHasCanonicalOrderDate(body);
  assertImageBackedOrderHasCanonicalDueDate(body);
  assertImageBackedOrderHasSalesPerson(body);
  assertImageBackedOrderHasProductType(body);
  assertImageBackedOrderHasPositiveQuantity(body);

  body.width = body.width ?? null;
  body.depth = body.depth ?? null;
  body.height = body.height ?? null;
  body.quantity = normalizeQuantity(body.quantity);
  body.sale_amount = body.sale_amount ?? null;
  body.balance = body.balance ?? null;
  body.delivery_address = normalizeOptionalText(body.delivery_address);
  body.freight_payment = normalizeOptionalText(body.freight_payment);

  return body;
}

export function normalizeOrderMutationInput(input, { normalizeQuantityField = true } = {}) {
  const body = { ...(input || {}) };

  for (const [field, label] of [['width', '가로'], ['depth', '세로'], ['height', '높이']]) {
    if (Object.hasOwn(body, field)) {
      body[field] = normalizeDimensionField(body[field], label);
    }
  }

  if (Object.hasOwn(body, 'sale_amount')) {
    body.sale_amount = normalizeMoneyField(body.sale_amount, '판매금액');
  }

  if (Object.hasOwn(body, 'balance')) {
    body.balance = normalizeMoneyField(body.balance, '잔금', { allowZero: true });
  }

  if (normalizeQuantityField && Object.hasOwn(body, 'quantity')) {
    body.quantity = normalizeQuantity(body.quantity);
  }

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
