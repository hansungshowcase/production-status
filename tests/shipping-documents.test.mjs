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
  assert.equal(countItemRows(shipping), 9);
  assert.equal(shipping.includes('.doc--shipping .items { margin-top: 18px; font-size: 15px; flex: 0 0 auto; }'), true);
  assert.equal(shipping.includes('.doc--shipping .items th, .doc--shipping .items td { height: 36px; font-size: 15px; padding: 4px 6px; }'), true);
  assert.equal(shipping.includes('.doc--shipping .guide--shipping { flex: 1 1 auto; min-height: 64mm; padding: 10px 14px; font-size: 14px;'), true);
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
  assert.equal(shipping.includes('.doc--shipping .guide--shipping { flex: 1 1 auto; min-height: 64mm;'), true);
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
