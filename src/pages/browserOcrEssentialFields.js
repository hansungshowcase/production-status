import { extractDueDateFromText } from '../utils/dateUtils.js';

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

export function extractBrowserOcrEssentialFields(text) {
  const rawText = String(text || '').replace(/\r/g, '\n');
  return {
    sales_person: extractCanonicalSalesPerson(rawText),
    due_date: extractDueDateFromText(rawText) || '',
  };
}
