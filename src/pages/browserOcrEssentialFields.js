import { extractDueDateFromText } from '../utils/dateUtils.js';
import { extractIndividualQuantity } from '../utils/quantity.js';

const CANONICAL_SALES_PERSON_BY_OCR_NAME = {
  '\uC2E0\uC740\uCCA0': '\uC2E0\uC740\uCCA0',
  '\uC774\uC900\uD615': '\uC774\uC900\uD615',
  '\uAE40\uBCF4\uC218': '\uC774\uC900\uD615',
  '\uC2E0\uC740\uC808': '\uC2E0\uC740\uCCA0',
};

function extractCanonicalSalesPerson(text) {
  const match = String(text || '').match(/(?:\uB2F4\uB2F9\uC790|\uC601\uC5C5\s*\uB2F4\uB2F9)\s*[:\uFF1A]?\s*([\uAC00-\uD7A3]{2,8})/);
  if (!match) return '';
  return CANONICAL_SALES_PERSON_BY_OCR_NAME[match[1]] || '';
}

export function extractBrowserOcrQuantity(text) {
  const match = String(text || '').match(/(?:수량|개수|Quantity|Qty|QTY)\s*[:：]?\s*([^\n]+)/i);
  if (!match) return '';
  const labeledValue = match[1]
    .replace(/\s{2,}.*/, '')
    .replace(/(?:발주일|주문일|납기|납품|연락처|전화|담당|제품|품명|문짝|색상|비고)\s*[:：]?.*$/i, '')
    .trim();
  const quantity = extractIndividualQuantity(labeledValue);
  return quantity === null ? '' : String(quantity);
}

export function extractBrowserOcrEssentialFields(text) {
  const rawText = String(text || '').replace(/\r/g, '\n');
  return {
    sales_person: extractCanonicalSalesPerson(rawText),
    due_date: extractDueDateFromText(rawText) || '',
  };
}
