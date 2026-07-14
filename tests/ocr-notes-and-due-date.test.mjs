import assert from 'node:assert/strict';
import test from 'node:test';

import { buildOrderPayload } from '../src/pages/orderEntryPayload.js';
import { getVisibleOrderMemo, normalizeOrderMemoForStorage } from '../src/utils/orderText.js';
import { extractDueDateFromOrder, extractDueDateFromText, parseDate } from '../src/utils/dateUtils.js';
import { normalizeOrderCreateInput } from '../api/_lib/orderCreateInput.js';

test('order payload does not save fallback OCR raw text as work memo', () => {
  const payload = buildOrderPayload({
    order_date: '2026-06-24',
    due_date: '',
    sales_person: '\uC2E0\uC740\uCCA0',
    client_name: '  \uBD80\uC790\uC8FC\uBC29/\uBD80\uC790\uD640\uB529\uC2A4  ',
    phone: '',
    product_type: '\uC9C4\uC5F4',
    door_type: '',
    width: '',
    depth: '',
    height: '',
    quantity: '',
    color: '',
    sale_amount: '',
    lead_source: '',
    notes: 'OCR \uC6D0\uBB38:\n<\uC791\uC5C5\uC9C0\uC2DC\uC11C>\n\uB0A9\uAE30\uC77C 7\uC6D43\uC77C\uB3C4\uCC29',
  }, 'https://example.com/work-order.jpg', '2026-06-24');

  assert.equal(payload.notes, null);
});

test('order payload saves extracted work memo from OCR text', () => {
  const payload = buildOrderPayload({
    order_date: '2026-06-24',
    due_date: '',
    sales_person: '\uC2E0\uC740\uCCA0',
    client_name: '  \uBD80\uC790\uC8FC\uBC29/\uBD80\uC790\uD640\uB529\uC2A4  ',
    phone: '',
    product_type: '\uC9C4\uC5F4',
    door_type: '',
    width: '',
    depth: '',
    height: '',
    quantity: '',
    color: '',
    sale_amount: '',
    lead_source: '',
    notes: 'OCR \uC6D0\uBB38:\n<\uC791\uC5C5\uC9C0\uC2DC\uC11C>\n\uBC1C\uC8FC\uC77C 2026-06-19\n\uC120\uBC18\uBC30\uC5F4 \uC720\uB9AC\uC120\uBC18 3\uB2E8\n\uBB38\uC9DD \uC55E\uBB38',
  }, 'https://example.com/work-order.jpg', '2026-06-24');

  assert.equal(payload.notes, '\uC120\uBC18\uBC30\uC5F4 \uC720\uB9AC\uC120\uBC18 3\uB2E8\n\uBB38\uC9DD \uC55E\uBB38');
});

test('due date can be extracted from OCR raw text when due_date was not saved', () => {
  const due = extractDueDateFromOrder({
    due_date: null,
    notes: 'OCR \uC6D0\uBB38:\n\uBC18\uC8FC\uC800 \uBD80\uC790\uC8FC\uBC29 \uBC1C\uC8FC\uC77C 2026-06-19\n\uB0A9\uAE30\uC77C 7\uC6D43\uC77C\uB3C4\uCC29 _ \uC794\uAE08 o',
  });

  assert.equal(due, '2026-07-03');
  assert.equal(parseDate(due).toISOString().slice(0, 10), '2026-07-03');
});

test('due date can be extracted from natural OCR due-date labels', () => {
  assert.equal(
    extractDueDateFromOrder({
      due_date: null,
      order_date: '2026-06-24',
      notes: 'OCR \uC6D0\uBB38:\n\uBE44\uACE0 \uB0A9\uAE30\uC77C\uC790 7\uC6D41\uC77C \uC800\uB141\nLED \uBC31\uC0C9',
    }),
    '2026-07-01'
  );

  assert.equal(
    extractDueDateFromOrder({
      due_date: null,
      order_date: '2026-06-24',
      notes: '\uB0A9\uAE30 2026. 7. 2 \uC624\uD6C4 \uCD9C\uACE0',
    }),
    '2026-07-02'
  );
});

test('impossible OCR due dates are rejected instead of rolling into another month', () => {
  assert.equal(extractDueDateFromText('납기일: 2026-02-29'), null);
  assert.equal(extractDueDateFromText('납기일: 2026-04-31'), null);
  assert.equal(extractDueDateFromText('납기일: 2028-02-29'), '2028-02-29');
});

test('OCR raw text is not rendered as a visible work memo', () => {
  assert.equal(getVisibleOrderMemo('OCR \uC6D0\uBB38:\n<\uC791\uC5C5\uC9C0\uC2DC\uC11C>\n\uB0A9\uAE30\uC77C 7\uC6D43\uC77C'), '');
  assert.equal(getVisibleOrderMemo('OCR \uC6D0\uBB38:\n&lt;\uC791\uC5C5\uC9C0\uC2DC\uC11C&gt;\n\uBC1C\uC8FC\uC77C 2026-06-19\n\uC678\uAD00\uC0C9\uC0C1 \uD654\uC774\uD2B8'), '');
  assert.equal(getVisibleOrderMemo('cam aa TTT\n\uBC1C\uC8FC\uC77C 2026-06-23\n\uADDC\uACA9 1200*650*1500\n\uB0A9\uAE30\uC77C 7\uC6D415\uC77C'), '');
  assert.equal(getVisibleOrderMemo('LED \uC8FC\uBC31\uC0C9, \uC720\uB9AC\uC120\uBC18 3\uB2E8'), 'LED \uC8FC\uBC31\uC0C9, \uC720\uB9AC\uC120\uBC18 3\uB2E8');
});

test('work memo is extracted from useful work order instruction lines only', () => {
  assert.equal(
    getVisibleOrderMemo('&lt;\uC791\uC5C5\uC9C0\uC2DC\uC11C&gt;\n\uBC1C\uC8FC\uC77C 2026-06-19\n\uC5F0\uB77D\uCC98 010-0000-0000\n\uC120\uBC18\uBC30\uC5F4 \uC720\uB9AC\uC120\uBC18 3\uB2E84\uCE78\n\uBB38\uC9DD \uC55E\uBB38 \uBBF8\uB2EB\uC774'),
    '\uC120\uBC18\uBC30\uC5F4 \uC720\uB9AC\uC120\uBC18 3\uB2E84\uCE78\n\uBB38\uC9DD \uC55E\uBB38 \uBBF8\uB2EB\uC774'
  );
  assert.equal(
    getVisibleOrderMemo('OCR \uC6D0\uBB38:\n\uBE44\uACE0: LED \uC8FC\uBC31\uC0C9\n\uB0A9\uAE30\uC77C 7\uC6D43\uC77C\n\uC794\uAE08 o'),
    'LED \uC8FC\uBC31\uC0C9\n\uC794\uAE08 o'
  );
});

test('OCR noise and boilerplate lines are not shown as work memo', () => {
  assert.equal(
    getVisibleOrderMemo('OCR \uC6D0\uBB38:\n\uC120\uBC18\uBC30\uC5F4 \uC720\uB9AC\uC120\uBC18 3\uB2E8\nkk \uB77C\uC9C0\uC5D0\uD0C0 \uBC29\uD5A5 \uCCAD\uC18C\uD558\uAE30 \uC27D\uB3C4\uB85D \uBD80\uCC29\nAx \uCFE8\uB7EC \uBC30\uAD00 \uC6A9\uC811 \uAF3C\uAF3C\uD558\uAC8C\n\uC791\uC5C5\uC9C0\uC2DC\uC11C \uC5C6\uC774 \uC791\uC5C5\uAE08\uC9C0\n\uB0A9\uAE30\uB294 \uBC1C\uC8FC\uC77C\uB85C\uBD80\uD130 \uCD5C\uB300 7\uC77C'),
    '\uC120\uBC18\uBC30\uC5F4 \uC720\uB9AC\uC120\uBC18 3\uB2E8'
  );
});

test('work memo cleanup removes OCR latin tails and standard piping text', () => {
  assert.equal(
    getVisibleOrderMemo('OCR \uC6D0\uBB38:\n\uBB38\uC9DD _ \uC55E\uBB38 \uBBF8\uB2EB\uC774 I pe a\n\uB77C\uC9C0\uC5D0\uD0C0 \uBC29\uD5A5 \uCCAD\uC18C\uD558\uAE30 HEE \uBD80\uCC29\uD560\uAC83\n\uC870\uBA85 \uAC80\uC815\uC0C9 \uC804\uAE30\uD14C\uC774\uD504 \uB9C8\uAC10 x'),
    '\uBB38\uC9DD \uC55E\uBB38 \uBBF8\uB2EB\uC774\n\uC870\uBA85 \uAC80\uC815\uC0C9 \uC804\uAE30\uD14C\uC774\uD504 \uB9C8\uAC10'
  );
});

test('work memo storage removes standard work-order boilerplate from normal notes', () => {
  const noisy = '외관색상, 선반배열, LED색상, 물받이 능 쇼케이스 사이즈에 맞게 제작, 물통 제작 후 대표님께 보고 필요함, ★★★ 라지에타 방향 청소하기 쉽도록 부착할것 ★★★, 납기는 발주일로부터 최대 일 (긴급 발주건은 최소 4일) 절대적으로 지킬 것, 작업지시서 없이 작업금지 절대엄금';

  assert.equal(
    normalizeOrderMemoForStorage(noisy),
    '물받이 능 쇼케이스 사이즈에 맞게 제작, 물통 제작 후 대표님께 보고 필요함, 라지에타 방향 청소하기 쉽도록 부착할것'
  );
});

test('server order create input sanitizes OCR boilerplate before DB insert', () => {
  const normalized = normalizeOrderCreateInput({
    client_name: '솔트앤멜로우 AS',
    product_type: '쇼케이스',
    notes: 'LED 조명, 납기는 발주일로부터 최대 일 (긴급 발주건은 최소 4일) 절대적으로 지킬것. 작업지시서 없이 작업금지. 절대엄금.',
  });

  assert.equal(normalized.notes, 'LED 조명');
});
