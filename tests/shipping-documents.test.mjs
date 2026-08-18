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

  assert.equal(shipping.includes('.doc--shipping .items th:nth-child(3), .doc--shipping .items td:nth-child(3) { width: 26%; white-space: nowrap; }'), true);
  assert.equal(shipping.includes('.doc--shipping .items th:nth-child(5), .doc--shipping .items td:nth-child(5) { width: 24%; }'), true);
  assert.equal(shipping.includes('.doc--shipping .items th:nth-child(4), .doc--shipping .items td:nth-child(4), .doc--shipping .items th:nth-child(6), .doc--shipping .items td:nth-child(6) { white-space: nowrap; }'), true);
});

test('shipping print html reserves visible space for driver information', () => {
  const shipping = buildShippingDocumentPrintHtml(buildShippingDocumentData(order, 'shipping', { today: '2026-06-24' }));

  assert.equal(shipping.includes('overflow: hidden;'), false);
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
