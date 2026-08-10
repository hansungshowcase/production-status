import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { formatMoney, balanceState } from '../src/utils/money.js';

test('금액은 천단위 구분과 원 단위로 표시한다', () => {
  assert.equal(formatMoney(1200000), '1,200,000원');
  assert.equal(formatMoney('1,200,000'), '1,200,000원');
  assert.equal(formatMoney('1200000'), '1,200,000원');
});

test('금액 칸이 비어 있으면 아무것도 표시하지 않는다', () => {
  for (const v of [null, undefined, '', '   ', '-']) {
    assert.equal(formatMoney(v), '');
  }
});

test('사람이 적어둔 문구는 숫자로 바꾸지 않고 그대로 살린다', () => {
  assert.equal(formatMoney('현금 완납'), '현금 완납');
});

test('잔금이 남아 있으면 due 로 판정한다', () => {
  assert.deepEqual(balanceState(500000), { kind: 'due', text: '500,000원' });
  assert.deepEqual(balanceState('500,000'), { kind: 'due', text: '500,000원' });
  assert.equal(balanceState('계좌이체 예정').kind, 'due');
});

test('0원이거나 완납이면 없음으로 판정한다', () => {
  assert.deepEqual(balanceState(0), { kind: 'none', text: '없음' });
  assert.deepEqual(balanceState('0'), { kind: 'none', text: '없음' });
  assert.equal(balanceState('완납').kind, 'none');
  assert.equal(balanceState('결제 완료').kind, 'none');
  assert.equal(balanceState('없음').kind, 'none');
});

test('적힌 값이 없으면 unknown 으로 구분한다', () => {
  // '0원'과 '아직 안 적음'은 다른 상태다. 화면에서 '기록 없음'으로 보여준다.
  for (const v of [null, undefined, '', '   ']) {
    assert.equal(balanceState(v).kind, 'unknown');
  }
});

test('주문 상세 화면이 판매금액·잔금·운임여부를 보여준다', async () => {
  const page = await readFile(new URL('../src/pages/OrderDetailPage.jsx', import.meta.url), 'utf8');

  assert.match(page, /label="판매금액" value=\{formatMoney\(order\.sale_amount\)\}/);
  assert.match(page, /balanceState\(order\.balance\)/);
  assert.match(page, /잔금<\/span>/);
  assert.match(page, /기록 없음/, '값이 없을 때와 0원을 구분해 보여줘야 한다');
  assert.match(page, /label="운임여부" value=\{order\.freight_payment\}/);
});

test('주문 조회 API 가 금액 항목을 실제로 내려준다', async () => {
  const source = await readFile(new URL('../api/orders/index.js', import.meta.url), 'utf8');
  assert.match(source, /o\.ship_date, o\.sale_amount, o\.lead_source, o\.balance/);
});

// 작업지시서 종이에는 '잔금여부 ₩ 2,000,000' 이 적혀 있는데 OCR 이 그 칸을 읽지 않아
// 320건 중 6건만 잔금이 들어와 있었다(2026-08-10 확인). 읽기부터 저장까지 전 경로를 고정한다.
test('작업지시서 OCR 이 잔금 칸을 읽는다', async () => {
  const source = await readFile(new URL('../api/ocr/work-order.js', import.meta.url), 'utf8');

  assert.match(source, /balance: \{ type: \['number', 'string', 'null'\] \}/, '스키마에 balance 가 있어야 한다');
  assert.match(source, /'balance',/, '필수 항목 목록에 balance 가 있어야 한다');
  assert.match(source, /"balance": "잔금여부/, '프롬프트가 잔금 칸을 지목해야 한다');
});

test('OCR 결과 파싱이 잔금을 알려진 필드로 취급한다', async () => {
  const { WORK_ORDER_FIELDS } = await import('../api/_lib/ocrParse.js');
  assert.ok(WORK_ORDER_FIELDS.includes('balance'), 'JSON 이 깨져도 잔금을 개별 추출할 수 있어야 한다');
});

test('OCR 값이 등록 폼의 잔금 칸까지 이어진다', async () => {
  const page = await readFile(new URL('../src/pages/OrderEntryPage.jsx', import.meta.url), 'utf8');

  assert.match(page, /balance: extractLabeledValue\(normalized, \['잔금여부'/, '브라우저 OCR 폴백도 잔금을 읽어야 한다');
  assert.match(page, /balance: d\.balance \|\| prev\.balance/, 'OCR 결과를 폼에 채워야 한다');
});

test('등록 시 잔금이 서버로 전송된다', async () => {
  const payload = await readFile(new URL('../src/pages/orderEntryPayload.js', import.meta.url), 'utf8');
  assert.match(payload, /balance: normalizeOptionalPositiveNumber\(form\.balance\)/);
});
