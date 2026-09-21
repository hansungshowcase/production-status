import assert from 'node:assert/strict';
import test from 'node:test';

import { extractQuantityFromOcrValue } from '../api/ocr/work-order.js';
import { extractBrowserOcrQuantity } from '../src/pages/browserOcrEssentialFields.js';

test('OCR quantity parser prefers an individual Korean quantity over a grouped total', () => {
  // Given: an OCR value that contains both an item annotation and the stated total.
  const ocrValue = '1대(급) 총 2대';

  // When: the OCR quantity is normalized.
  const quantity = extractQuantityFromOcrValue(ocrValue);

  // Then: the individual line quantity wins over the grouped total.
  assert.equal(quantity, 1);
});

test('OCR quantity parser preserves a single quantity when no total is stated', () => {
  // Given: an OCR value without an explicit total quantity.
  const ocrValue = '1대(급)';

  // When: the OCR quantity is normalized.
  const quantity = extractQuantityFromOcrValue(ocrValue);

  // Then: the existing first-number behavior is retained without inferring a total.
  assert.equal(quantity, 1);
});

test('browser fallback parses only the labeled individual quantity', () => {
  assert.equal(extractBrowserOcrQuantity('규격 1340×760×2000\n수량: 1대(급) 총 6대'), '1');
  assert.equal(extractBrowserOcrQuantity('수량: 2대(급) 총 6대'), '2');
  assert.equal(extractBrowserOcrQuantity('수량: 총 6대'), '');
  assert.equal(extractBrowserOcrQuantity('규격: 1340×760×2000'), '');
});
