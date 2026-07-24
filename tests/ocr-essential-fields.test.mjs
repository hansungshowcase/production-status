import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  extractQuantityFromOcrValue,
  hasCompleteOcrEssentials,
  normalizeOcrDueDate,
  normalizeOcrSalesPerson,
} from '../api/ocr/work-order.js';

test('normalizes known OCR sales-person aliases to canonical owners', () => {
  // Given: names and common OCR variants that appear on work orders.
  const variants = [
    ['신은철', '신은철'],
    ['신은절', '신은철'],
    ['김보수 팀장', '이준형'],
    [' 이준형 ', '이준형'],
  ];

  // When / Then: only canonical order owners are returned.
  for (const [ocrValue, expected] of variants) {
    assert.equal(normalizeOcrSalesPerson(ocrValue), expected);
  }
  assert.equal(normalizeOcrSalesPerson('홍길동'), '');
});

test('normalizes labeled Korean due-date OCR text to a real ISO date', () => {
  // Given: yearless and dotted Korean due-date labels from work orders.
  const currentYear = new Date().getFullYear();

  // When / Then: the label is removed and a canonical date is returned.
  assert.equal(normalizeOcrDueDate('납기일자 07월 22일'), `${currentYear}-07-22`);
  assert.equal(normalizeOcrDueDate('납기 2026. 7. 2 오후 출고'), '2026-07-02');
  assert.equal(normalizeOcrDueDate('납기일 7월 32일'), '');
});

test('prefers stated total quantity over an item annotation', () => {
  // Given: an OCR value with an item count and an explicit total.
  const ocrValue = '1대(급) 총 2대';

  // When: quantity is normalized.
  const quantity = extractQuantityFromOcrValue(ocrValue);

  // Then: the explicit total is preserved.
  assert.equal(quantity, 2);
});

test('marks OCR data usable only when every essential field is canonical', () => {
  // Given: complete and incomplete OCR outputs.
  const complete = {
    client_name: 'OK정육점2',
    order_date: '2026-07-20',
    sales_person: '이준형',
    due_date: '2026-07-22',
    product_type: '정육',
    quantity: 2,
  };

  // When / Then: the caller can distinguish data safe to prefill from manual-review data.
  assert.equal(hasCompleteOcrEssentials(complete), true);
  assert.equal(hasCompleteOcrEssentials({ ...complete, due_date: '' }), false);
  assert.equal(hasCompleteOcrEssentials({ ...complete, sales_person: '김보수' }), false);
  assert.equal(hasCompleteOcrEssentials({ ...complete, quantity: 0 }), false);
  assert.equal(hasCompleteOcrEssentials({ ...complete, client_name: '' }), false);
  assert.equal(hasCompleteOcrEssentials({ ...complete, order_date: '2026-02-29' }), false);
  assert.equal(hasCompleteOcrEssentials({ ...complete, product_type: '  ' }), false);
});

test('retries the configured secondary OCR provider when OpenAI returns incomplete essentials', async () => {
  const source = await readFile(new URL('../api/ocr/work-order.js', import.meta.url), 'utf8');

  assert.match(
    source,
    /if \(!hasCompleteOcrEssentials\(parsed\) && geminiKey\)/,
    'an HTTP-success OpenAI response with incomplete essentials must continue to Gemini',
  );
  assert.match(
    source,
    /success: hasCompleteOcrEssentials\(parsed\),[\s\S]*provider: hasCompleteOcrEssentials\(parsed\) \? 'gemini' : 'manual'/,
    'an incomplete Gemini result must trigger browser OCR instead of being reported as success',
  );
});
