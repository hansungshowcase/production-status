import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildShippingDocumentData,
  buildShippingDocumentPrintHtml,
} from '../src/components/sales/shippingDocuments.js';

const order = {
  id: 2042,
  order_date: '2026-06-24',
  due_date: '2026-06-26',
  ship_scheduled_date: '2026-06-25',
  client_name: 'Test client',
  phone: '010-3753-5054',
  delivery_address: 'Test address',
  product_type: 'TC',
  width: 1200,
  depth: 500,
  height: 900,
  quantity: 1,
  balance: 320000,
  freight_payment: '소비자부담',
};

function countItemRows(html) {
  return (html.match(/\n    <tr>\n      <td>/g) || []).length;
}

test('builds shipping instruction data from order fields', () => {
  const data = buildShippingDocumentData(order, 'shipping', { today: '2026-06-24' });

  assert.equal(data.orderDate, '26-06-24');
  assert.equal(data.shipDate, '26-06-25');
  assert.equal(data.customerName, 'Test client');
  assert.equal(data.customerAddress, 'Test address');
  assert.equal(data.customerPhone, '010-3753-5054');
  assert.equal(data.freightText, '소비자부담');
  assert.equal(data.rows[0].date, '06/25');
  assert.equal(data.rows[0].itemName, 'TC');
  assert.equal(data.rows[0].spec, '1200 x 500 x 900');
  assert.equal(data.rows[0].quantity, '1');
  assert.equal(data.balanceText.length > 0, true);
  assert.equal(data.levelingGuide.compact, true);
  assert.equal(data.levelingGuide.steps.length, 0);
});

test('builds delivery statement data with delivery-specific guide', () => {
  const data = buildShippingDocumentData(order, 'delivery', { today: '2026-06-24' });

  assert.equal(data.rows[0].warehouse, '');
  assert.equal(data.levelingGuide.compact, undefined);
  assert.equal(data.levelingGuide.steps.length > 0, true);
  assert.equal(data.levelingGuide.showWarning, true);
});

test('print html contains the document title, supplier box, and table content', () => {
  const data = buildShippingDocumentData(order, 'shipping', { today: '2026-06-24' });
  const html = buildShippingDocumentPrintHtml(data);

  assert.equal(html.includes(data.title), true);
  assert.equal(html.includes(data.company.businessNumber), true);
  assert.equal(html.includes(data.rows[0].itemName), true);
  assert.equal(html.includes(data.balanceText), true);
  assert.equal(html.includes(data.freightText), true);
  assert.equal(html.includes('운임여부'), true);
});

test('supplier box is lowered from the top on both shipping and delivery documents', () => {
  const shipping = buildShippingDocumentPrintHtml(buildShippingDocumentData(order, 'shipping', { today: '2026-06-24' }));
  const delivery = buildShippingDocumentPrintHtml(buildShippingDocumentData(order, 'delivery', { today: '2026-06-24' }));

  for (const html of [shipping, delivery]) {
    assert.equal(html.includes('.supplier-wrap { position: relative; padding-top: 8px; }'), true);
    assert.equal(html.includes('.stamp { position: absolute; right: 12px; top: 26px;'), true);
  }
});

test('delivery print html keeps the leveling guide inside the original A4 document design', () => {
  const data = buildShippingDocumentData(order, 'delivery', { today: '2026-06-24' });
  const html = buildShippingDocumentPrintHtml(data);

  assert.equal(html.includes('@page { size: A4; margin: 10mm; }'), true);
  assert.equal(html.includes('page-break-inside: avoid'), true);
  assert.equal(html.includes('guide-page'), false);
});

test('delivery print html fills the A4 page with larger readable guide text', () => {
  const data = buildShippingDocumentData(order, 'delivery', { today: '2026-06-24' });
  const html = buildShippingDocumentPrintHtml(data);

  assert.equal(html.includes('.doc { width: 190mm; height: 277mm;'), true);
  assert.equal(html.includes('display: flex; flex-direction: column;'), true);
  assert.equal(html.includes('.guide { margin-top: 8px; border: 1px solid #999; padding: 14px 16px; font-size: 16px;'), true);
  assert.equal(html.includes('flex: 1 1 auto;'), true);
  assert.equal(html.includes('.signature-cell { min-width: 42mm; }'), true);
});

test('shipping print html expands the item table to fill A4 vertical space', () => {
  const shipping = buildShippingDocumentPrintHtml(buildShippingDocumentData(order, 'shipping', { today: '2026-06-24' }));
  const delivery = buildShippingDocumentPrintHtml(buildShippingDocumentData(order, 'delivery', { today: '2026-06-24' }));

  assert.equal(shipping.includes('<div class="doc doc--shipping">'), true);
  // 빈 칸 8개 → 4개. 적요가 길면 그 한 줄이 10줄 넘게 늘어나 2페이지가 됐다(2026-08-18).
  assert.equal(countItemRows(shipping), 5);
  assert.equal(shipping.includes('.doc--shipping .items { margin-top: 18px; font-size: 15px; flex: 0 0 auto; }'), true);
  assert.equal(shipping.includes('.doc--shipping .items th, .doc--shipping .items td { height: 36px; font-size: 15px; padding: 4px 6px; }'), true);
  assert.equal(shipping.includes('.doc--shipping .guide--shipping { flex: 1 1 auto; min-height: 40mm; padding: 10px 14px; font-size: 14px;'), true);
  assert.equal(shipping.includes('.doc--shipping .guide--shipping .guide-driver { margin-top: 6px; font-size: 13px; line-height: 1.45; }'), true);

  assert.equal(delivery.includes('<div class="doc doc--shipping">'), false);
  assert.equal(countItemRows(delivery), 7);
  assert.equal(delivery.includes('.items { margin-top: 24px; font-size: 14px; }'), true);
  assert.equal(delivery.includes('.items th, .items td { border: 1px solid #999; height: 32px;'), true);
});

test('shipping print html keeps specification readable by narrowing the note column', () => {
  const shipping = buildShippingDocumentPrintHtml(buildShippingDocumentData(order, 'shipping', { today: '2026-06-24' }));

  assert.equal(shipping.includes('.doc--shipping .items th:nth-child(3), .doc--shipping .items td:nth-child(3) { width: 24%; white-space: nowrap; }'), true);
  // 적요가 좁으면 특이사항 한 줄이 11줄로 접혀 그 행 하나가 페이지를 밀어낸다.
  // 품목명('진열 / 앞문 / 올스텐')은 짧으니 폭을 넘겨받아 적요를 넓힌다.
  assert.equal(shipping.includes('.doc--shipping .items th:nth-child(2), .doc--shipping .items td:nth-child(2) { width: 16%; }'), true);
  assert.equal(shipping.includes('.doc--shipping .items th:nth-child(5), .doc--shipping .items td:nth-child(5) { width: 32%; }'), true);
  assert.equal(shipping.includes('.doc--shipping .items th:nth-child(4), .doc--shipping .items td:nth-child(4), .doc--shipping .items th:nth-child(6), .doc--shipping .items td:nth-child(6) { white-space: nowrap; }'), true);
});

test('shipping print html reserves visible space for driver information', () => {
  const shipping = buildShippingDocumentPrintHtml(buildShippingDocumentData(order, 'shipping', { today: '2026-06-24' }));

  // overflow:hidden 은 마지막 안전판이다. 아래 축소 스크립트가 먼저 한 장에 맞추므로
  // 정상 경로에서는 잘려나가는 내용이 없다(실측: 적요 25줄짜리도 기사 안내 박스까지 온전).
  assert.equal(shipping.includes('.doc { overflow: hidden; }'), true);
  assert.equal(shipping.includes('.fit { display: flex; flex-direction: column; width: 100%; height: 100%; transform-origin: top left; }'), true);
  // 바닥값이지 고정 높이가 아니다. flex:1 이라 평소에는 남는 공간만큼 커지고,
  // 적요가 길어 표가 페이지를 밀어낼 때만 이 값까지 눌린다.
  assert.equal(shipping.includes('.doc--shipping .guide--shipping { flex: 1 1 auto; min-height: 40mm;'), true);
  assert.equal(shipping.includes('.doc--shipping .guide--shipping .guide-title { margin: 0 0 8px; font-size: 16px; }'), true);
  assert.equal(shipping.includes('.doc--shipping .guide--shipping .guide-driver { margin-top: 6px; font-size: 13px; line-height: 1.45; }'), true);
});

test('shipping print html has delivery-manager signature and driver info without installation guide', () => {
  const data = buildShippingDocumentData(order, 'shipping', { today: '2026-06-24' });
  const html = buildShippingDocumentPrintHtml(data);

  assert.equal(html.includes('<table class="sign"><tr><th>'), true);
  assert.equal(html.includes('<td class="signature-cell"></td></tr></table>'), true);
  assert.equal(html.includes('<div class="guide guide--shipping">'), true);
  assert.equal(data.levelingGuide.driverInfo.length > 0, true);
  assert.equal(data.levelingGuide.steps.length, 0);
  assert.equal(html.includes('<div class="guide">'), false);
});

// 적요에 특이사항이 길게 들어가면 그 한 줄이 10줄 넘게 늘어난다. 여기에 빈 칸 8개까지
// 더해지면 A4 한 장을 넘겨 2페이지로 인쇄됐다. (2026-08-18 요청)
test('출하지시서 표는 빈 칸을 4개 줄여 한 장에 맞춘다', () => {
  const html = buildShippingDocumentPrintHtml(buildShippingDocumentData(order, 'shipping', { today: '2026-06-24' }));
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)[1];

  assert.equal((body.match(/<tr>/g) || []).length, 5, '데이터 1줄 + 손으로 적는 빈 칸 4개');
});

test('납품내역서 표는 종전 그대로 둔다', () => {
  const html = buildShippingDocumentPrintHtml(buildShippingDocumentData(order, 'delivery', { today: '2026-06-24' }));
  const body = html.match(/<tbody>([\s\S]*?)<\/tbody>/)[1];

  assert.equal((body.match(/<tr>/g) || []).length, 7);
});

// 칸을 줄인다고 적요를 잘라내면 안 된다. 기사님이 봐야 할 특이사항이다.
test('적요가 길어도 내용을 잘라내지 않는다', () => {
  const longNote = '선반: 1/2 그릴선반 6개 제공 + 봉걸이 2줄 장착, 특이사항: 라지에타 방향 청소하기 쉽도록 부착, 조명 검정색 전기테이프 최대한 안보이도록 마감';
  const html = buildShippingDocumentPrintHtml(
    buildShippingDocumentData({ ...order, notes: longNote }, 'shipping', { today: '2026-06-24' }),
  );

  assert.match(html, /라지에타 방향 청소하기 쉽도록 부착/);
  assert.match(html, /전기테이프 최대한 안보이도록 마감/);
  assert.doesNotMatch(html, /text-overflow:\s*ellipsis/, '적요를 말줄임으로 감추면 안 된다');
});

// 페이지가 늘어나는 것을 막는 장치는 문서 높이 고정이다. 이게 풀리면 다시 2페이지가 된다.
test('문서 높이는 A4 한 장으로 고정되어 있다', () => {
  const html = buildShippingDocumentPrintHtml(buildShippingDocumentData(order, 'shipping', { today: '2026-06-24' }));

  assert.match(html, /@page \{ size: A4; margin: 10mm; \}/);
  assert.match(html, /\.doc \{ width: 190mm; height: 277mm;/);
});

// 칸 수를 줄이고 적요 폭을 넓혀도, 글꼴이나 프린터 여백이 조금만 달라지면 기사 안내문
// 블록이 통째로 2페이지로 밀려났다(page-break-inside: avoid 라 쪼개지지 않는다).
// 그래서 남는 높이를 재서 넘칠 때만 문서 전체를 줄인다. (2026-08-18 실제 인쇄물 확인)
test('넘칠 때 문서를 줄여 한 장에 맞추는 장치가 들어 있다', () => {
  for (const type of ['shipping', 'delivery']) {
    const html = buildShippingDocumentPrintHtml(buildShippingDocumentData(order, type, { today: '2026-06-24' }));

    assert.match(html, /<div class="fit">/, '축소 대상 래퍼가 있어야 한다');
    assert.match(html, /fit\.style\.transform = scale === 1 \? 'none' : 'scale\(' \+ scale \+ '\)'/);
    // 폭을 넓히면 줄바꿈이 줄어 높이가 다시 바뀐다. 한 번만 재면 수렴하지 않는다.
    assert.match(html, /for \(var i = 0; i < 8; i \+= 1\)/);
    // 인쇄 대화상자의 용지·여백 설정이 높이를 바꾸므로 인쇄 직전에 한 번 더 맞춘다.
    assert.match(html, /window\.addEventListener\('beforeprint', apply\)/);
  }
});

test('읽지 못할 만큼 줄이지는 않는다', () => {
  const html = buildShippingDocumentPrintHtml(buildShippingDocumentData(order, 'shipping', { today: '2026-06-24' }));

  assert.match(html, /Math\.max\(0\.6,/, '60% 아래로 줄이면 기사님이 읽지 못한다');
});

// 납품내역서는 고객이 받아 서명하는 서류다. 품명에 '알앤에프냉동덧방' 처럼 거래처·내부
// 분류 표기가 들어가 있어 고객에게 보이면 안 된다. (2026-08-19 요청)
// 고객 문자·조회 페이지에서 품명을 뺀 것과 같은 이유다.
test('납품내역서에는 품명이 인쇄되지 않는다', () => {
  const internal = { ...order, product_type: '알앤에프냉동덧방', door_type: '앞문', color: '올스텐' };
  const data = buildShippingDocumentData(internal, 'delivery', { today: '2026-06-24' });
  const html = buildShippingDocumentPrintHtml(data);

  assert.equal(data.rows[0].itemName, '앞문 / 올스텐');
  assert.doesNotMatch(html, /알앤에프냉동덧방/, '고객 서류에 내부 품명이 남으면 안 된다');
});

// 출하지시서는 기사님과 공장이 보는 내부 서류다. 품명이 있어야 무엇을 싣는지 안다.
test('출하지시서에는 품명이 그대로 인쇄된다', () => {
  const internal = { ...order, product_type: '알앤에프냉동덧방', door_type: '앞문', color: '올스텐' };
  const data = buildShippingDocumentData(internal, 'shipping', { today: '2026-06-24' });
  const html = buildShippingDocumentPrintHtml(data);

  assert.equal(data.rows[0].itemName, '알앤에프냉동덧방 / 앞문 / 올스텐');
  assert.match(html, /알앤에프냉동덧방/);
});

test('품명을 빼도 납품내역서의 규격·수량은 그대로 남는다', () => {
  const internal = { ...order, product_type: '알앤에프냉동덧방' };
  const data = buildShippingDocumentData(internal, 'delivery', { today: '2026-06-24' });

  assert.equal(data.rows[0].spec, '1200 x 500 x 900');
  assert.equal(data.rows[0].quantity, '1');
});

// 문형·색상이 둘 다 비어 있으면 빈 칸이 아니라 '-' 로 둔다. 품명으로 메우면 안 된다.
test('문형과 색상이 없으면 품명으로 메우지 않는다', () => {
  const bare = { ...order, product_type: '알앤에프냉동덧방', door_type: '', color: '' };
  const data = buildShippingDocumentData(bare, 'delivery', { today: '2026-06-24' });

  assert.equal(data.rows[0].itemName, '-');
});
