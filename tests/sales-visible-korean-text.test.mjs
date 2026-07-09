import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const summarySource = readFileSync(new URL('../src/components/sales/SalesSummaryCards.jsx', import.meta.url), 'utf8');
const cardSource = readFileSync(new URL('../src/components/sales/SalesOrderCard.jsx', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('../src/pages/SalesMyPage.jsx', import.meta.url), 'utf8');

test('sales summary and filter labels are readable Korean', () => {
  for (const label of ['전체', '생산중', '포장완료', '납기초과', '출고완료']) {
    assert.equal(summarySource.includes(label), true, `summary missing ${label}`);
    assert.equal(pageSource.includes(label), true, `filter missing ${label}`);
  }
});

test('packing photo actions use readable Korean labels', () => {
  for (const label of ['포장사진', '다운로드', '닫기']) {
    assert.equal(cardSource.includes(label), true, `packing photo UI missing ${label}`);
  }
  assert.equal(cardSource.includes('Download'), false);
});
