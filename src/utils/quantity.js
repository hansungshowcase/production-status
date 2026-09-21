export const MAX_QUANTITY = 2147483647;

export function parsePositiveIntegerQuantity(value) {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value > 0 && value <= MAX_QUANTITY ? value : null;
  }

  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!/^\d+$/.test(text)) return null;

  const quantity = Number(text);
  return Number.isInteger(quantity) && quantity > 0 && quantity <= MAX_QUANTITY ? quantity : null;
}

export function extractIndividualQuantity(value) {
  const exact = parsePositiveIntegerQuantity(value);
  if (exact !== null) return exact;
  if (typeof value !== 'string') return null;

  const beforeGroupTotal = value.split(/총/i, 1)[0].trim();
  if (!beforeGroupTotal) return null;

  const quantities = [...beforeGroupTotal.matchAll(/(?:^|[^\d])(\d+)\s*(?:대|개|EA)(?=$|[\s()[\]{},.:/\-])/gi)]
    .map((match) => parsePositiveIntegerQuantity(match[1]))
    .filter((quantity) => quantity !== null);
  const uniqueQuantities = [...new Set(quantities)];
  return uniqueQuantities.length === 1 ? uniqueQuantities[0] : null;
}
