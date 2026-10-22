const INTEGER_TEXT = String.raw`(?:\d+|\d{1,3}(?:,\d{3})+)`;
const DECIMAL_TEXT = String.raw`${INTEGER_TEXT}(?:\.\d+)?`;
const DIMENSION_PATTERN = new RegExp(`^(${INTEGER_TEXT})\\s*(?:mm)?$`, 'i');
const MONEY_PATTERN = new RegExp(`^(?:₩\\s*)?(${DECIMAL_TEXT})\\s*(?:원)?$`, 'u');
const MISSING_PATTERN = /^(?:-|(?:[\p{L}\s]+)?미기재)$/u;

export class OrderNumericInputError extends Error {
  constructor(value) {
    super(`Invalid optional order number: ${String(value)}`);
    this.name = 'OrderNumericInputError';
  }
}

function normalizeOptionalNumber(value, pattern, { allowZero }) {
  if (value === undefined || value === null) return null;

  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value < 0) throw new OrderNumericInputError(value);
    if (value === 0 && !allowZero) return null;
    return value;
  }

  const text = String(value).trim();
  if (!text || MISSING_PATTERN.test(text)) return null;

  const match = text.match(pattern);
  if (!match) throw new OrderNumericInputError(value);

  const number = Number(match[1].replace(/,/g, ''));
  if (!Number.isFinite(number) || number < 0) throw new OrderNumericInputError(value);
  if (number === 0 && !allowZero) return null;
  return number;
}

export function normalizeOptionalDimension(value) {
  const number = normalizeOptionalNumber(value, DIMENSION_PATTERN, { allowZero: false });
  if (number !== null && !Number.isInteger(number)) throw new OrderNumericInputError(value);
  return number;
}

export function normalizeOptionalMoney(value, { allowZero = false } = {}) {
  return normalizeOptionalNumber(value, MONEY_PATTERN, { allowZero });
}
