import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const salesPage = readFileSync(new URL('../src/pages/SalesMyPage.jsx', import.meta.url), 'utf8');
test('sales order status page does not render the overdue popup surface', () => {
  assert.equal(salesPage.includes('sales-my-page__overdue-overlay'), false);
  assert.equal(salesPage.includes('sales-my-page__overdue-popup'), false);
});
