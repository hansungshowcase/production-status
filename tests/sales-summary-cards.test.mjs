import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const componentSource = readFileSync(new URL('../src/components/sales/SalesSummaryCards.jsx', import.meta.url), 'utf8');
const cssSource = readFileSync(new URL('../src/components/sales/SalesSummaryCards.css', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('../src/pages/SalesMyPage.jsx', import.meta.url), 'utf8');

test('sales summary cards include packing completed as a first-class card', () => {
  assert.equal(componentSource.includes('packingCompleted'), true);
  assert.equal(componentSource.includes("key: 'packing_completed'"), true);
  assert.equal(componentSource.includes('포장완료'), true);
  assert.equal(pageSource.includes('packingCompleted={packingCompletedCount}'), true);
});

test('sales summary counts use larger readable typography', () => {
  assert.match(cssSource, /\.sales-summary-cards\s*\{[\s\S]*repeat\(5,\s*minmax\(140px,\s*1fr\)\)/);
  assert.match(cssSource, /\.sales-summary-card__value\s*\{[\s\S]*font-size:\s*34px;/);
  assert.match(cssSource, /\.sales-summary-card__label\s*\{[\s\S]*font-size:\s*15px;/);
});
