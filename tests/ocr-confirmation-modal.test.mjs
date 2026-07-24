import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import { getOcrConfirmationValidation } from '../src/pages/ocrConfirmationValidation.js';

const pageSource = readFileSync(
  new URL('../src/pages/OrderEntryPage.jsx', import.meta.url),
  'utf8',
);
const styles = readFileSync(
  new URL('../src/pages/OrderEntryPage.css', import.meta.url),
  'utf8',
);

test('OCR confirmation exposes an immediate counted core-value guard and keeps confirmation disabled until valid', () => {
  const validation = getOcrConfirmationValidation({
    client_name: '',
    order_date: '2026-07-14',
    due_date: '2026-02-30',
    sales_person: '홍길동',
    product_type: '특수 규격',
    quantity: 0,
  });

  assert.deepEqual(validation.invalidCoreFields.map(({ key }) => key), [
    'client_name',
    'due_date',
    'sales_person',
    'quantity',
  ]);
  assert.equal(validation.isValid, false);
  assert.match(pageSource, /핵심 필수값 \$\{ocrValidation\.invalidCoreFields\.length\}개가 누락되었거나 올바르지 않습니다/);
  assert.match(pageSource, /disabled=\{!ocrValidation\.isValid\}/);
  assert.match(pageSource, /ocr-confirm__field--error/);
  assert.match(pageSource, /aria-invalid=\{Boolean\(fieldError\)\}/);
});

test('OCR confirmation warns about blank optional fields without treating them as blockers', () => {
  const validation = getOcrConfirmationValidation({
    client_name: '한성 거래처',
    order_date: '2026-07-14',
    due_date: '2026-07-22',
    sales_person: '이준형',
    product_type: '특수 규격',
    quantity: 2,
  });

  assert.equal(validation.isValid, true);
  assert.equal(validation.invalidCoreFields.length, 0);
  assert.equal(validation.blankOptionalFields.length, 9);
  assert.match(pageSource, /ocrValidation\.blankOptionalFields\.length > 0/);
  assert.match(pageSource, /선택 항목 \{ocrValidation\.blankOptionalFields\.length\}개가 비어 있습니다/);
  assert.match(pageSource, /ocr-confirm__notice--warning/);
  assert.match(pageSource, /핵심 필수값/);
});

test('OCR confirmation styles invalid fields and disabled confirmation without changing editable input rules', () => {
  assert.match(styles, /\.ocr-confirm__field--error/);
  assert.match(styles, /\.ocr-confirm__input--error/);
  assert.match(styles, /\.ocr-confirm__btn--confirm:disabled/);
  assert.match(pageSource, /onChange=\{\(e\) => handleOcrEdit\(key/);
  assert.doesNotMatch(pageSource, /readOnly=\{Boolean\(fieldError\)\}/);
});
