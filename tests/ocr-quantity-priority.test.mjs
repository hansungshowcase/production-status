import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import { extractQuantityFromOcrValue } from '../api/ocr/work-order.js';

test('OCR quantity parser prefers an explicit Korean total quantity', () => {
  // Given: an OCR value that contains both an item annotation and the stated total.
  const ocrValue = '1대(급) 총 2대';

  // When: the OCR quantity is normalized.
  const quantity = extractQuantityFromOcrValue(ocrValue);

  // Then: the explicitly stated total wins over the first number.
  assert.equal(quantity, 2);
});

test('OCR quantity parser preserves a single quantity when no total is stated', () => {
  // Given: an OCR value without an explicit total quantity.
  const ocrValue = '1대(급)';

  // When: the OCR quantity is normalized.
  const quantity = extractQuantityFromOcrValue(ocrValue);

  // Then: the existing first-number behavior is retained without inferring a total.
  assert.equal(quantity, 1);
});

test('browser fallback checks an explicit total before a labeled quantity', async () => {
  // Given: the browser fallback source.
  const browserSource = await readFile(
    new URL('../src/pages/OrderEntryPage.jsx', import.meta.url),
    'utf8',
  );

  // When: the fallback quantity parser is inspected.
  const browserTotalPattern = browserSource.indexOf('총\\s*(\\d+)\\s*대');

  // Then: the explicit total is considered before a labeled first number.
  assert.ok(browserTotalPattern >= 0);
  assert.ok(browserTotalPattern < browserSource.indexOf('const labeled =', browserTotalPattern));
});
